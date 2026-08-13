import assert from "node:assert/strict";
import test from "node:test";
import { CompanionEventPump } from "./event-pump.js";

test("event pump steers player input and attaches the latest snapshot", async () => {
  const pump = new CompanionEventPump();
  const delivered: Array<{ text: string; disposition: string }> = [];
  pump.enqueueFact({ source: "stardew_mod", kind: "snapshot", correlationId: "s1", revision: 1, payload: { location: "Farm" } });
  pump.enqueueFact({ source: "stardew_mod", kind: "snapshot", correlationId: "s2", revision: 2, payload: { location: "Town" } });
  pump.enqueuePlayerInput({ source: "voice_final", inputId: "voice_1", text: "去镇上", locale: "zh-CN", timestampMs: 1 });
  await pump.flush({ async deliver(text, disposition) { delivered.push({ text, disposition }); } });
  assert.equal(delivered[0]?.disposition, "steer");
  const batch = JSON.parse(delivered[0]?.text ?? "{}") as { disposition: string; triggerEventIds: string[]; playerInputs: Array<{ text: string }>; worldFacts: Array<{ revision: number }> };
  assert.equal(batch.disposition, "steer");
  assert.deepEqual(batch.triggerEventIds, ["voice_1"]);
  assert.deepEqual(batch.playerInputs.map((input) => input.text), ["去镇上"]);
  assert.deepEqual(batch.worldFacts.map((fact) => fact.revision), [2]);
  assert.equal(pump.pendingCount, 0);
});

test("event pump holds snapshot and meaningful progress until an ordinary trigger arrives", async () => {
  const pump = new CompanionEventPump();
  const delivered: Array<{ text: string; disposition: string }> = [];
  pump.enqueueFact({ source: "stardew_mod", kind: "snapshot", correlationId: "snapshot", revision: 4, payload: { location: "Farm" } });
  pump.enqueueFact({ source: "stardew_mod", kind: "execution_receipt", correlationId: "execution", revision: 4, payload: { state: "running" } });
  await pump.flush({ async deliver(text, disposition) { delivered.push({ text, disposition }); } });
  assert.equal(delivered.length, 0);

  pump.enqueueFact({ source: "stardew_mod", kind: "semantic_event", eventId: "event_1", correlationId: "event", revision: 5, payload: { kind: "location_changed" } });
  await pump.flush({ async deliver(text, disposition) { delivered.push({ text, disposition }); } });
  assert.equal(delivered[0]?.disposition, "follow_up");
  const batch = JSON.parse(delivered[0]?.text ?? "{}") as { triggerEventIds: string[]; worldFacts: Array<{ kind: string; payload: { state?: string }; revision: number }> };
  assert.deepEqual(batch.triggerEventIds, ["event_1"]);
  assert.deepEqual(
    batch.worldFacts.map((fact) => [fact.kind, fact.payload.state ?? "", fact.revision]),
    [["snapshot", "", 4], ["execution_receipt", "running", 4], ["semantic_event", "", 5]],
  );
});

test("event pump follows up ordinary facts and preserves an exact failed batch retry", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact({ source: "stardew_mod", kind: "execution_receipt", correlationId: "execution_a", revision: 1, payload: { state: "failed" } });
  pump.enqueueFact({ source: "stardew_mod", kind: "execution_receipt", correlationId: "execution_b", revision: 2, payload: { state: "succeeded" } });
  await assert.rejects(() => pump.flush({ async deliver() { throw new Error("sink_down"); } }), /sink_down/);
  const delivered: Array<{ text: string; disposition: string }> = [];
  await pump.flush({ async deliver(text, disposition) { delivered.push({ text, disposition }); } });
  assert.equal(delivered[0]?.disposition, "follow_up");
  const batch = JSON.parse(delivered[0]?.text ?? "{}") as { worldFacts: Array<{ correlationId: string }> };
  assert.deepEqual(batch.worldFacts.map((item) => item.correlationId), ["execution_a", "execution_b"]);
});

test("event pump retries the exact serialized batch without replaying a newer or mutated payload", async () => {
  const pump = new CompanionEventPump();
  const payload = { nested: { value: "original" } };
  pump.enqueueFact({ source: "stardew_mod", kind: "snapshot", correlationId: "s", revision: 1, payload });
  pump.enqueuePlayerInput({ source: "player_text", inputId: "input", text: "继续", locale: "zh-CN", timestampMs: 1 });
  let firstFrame = "";
  await assert.rejects(
    () => pump.flush({ async deliver(text) { firstFrame = text; payload.nested.value = "mutated"; throw new Error("down"); } }),
    /down/,
  );
  pump.enqueueFact({ source: "stardew_mod", kind: "snapshot", correlationId: "s", revision: 2, payload: {} });
  const delivered: string[] = [];
  await pump.flush({ async deliver(text) { delivered.push(text); } });
  assert.equal(delivered[0], firstFrame);
  // A later held snapshot must wait for a new trigger; it must not be replayed
  // into the frozen retry batch nor manufacture a Pi turn by itself.
  pump.enqueuePlayerInput({ source: "player_text", inputId: "next_input", text: "接着做", locale: "zh-CN", timestampMs: 2 });
  await pump.flush({ async deliver(text) { delivered.push(text); } });
  const batches = delivered.map(
    (text) => JSON.parse(text) as { worldFacts: { revision: number; payload: { nested?: { value: string } } }[] },
  );
  assert.deepEqual(batches.map((batch) => batch.worldFacts.map((fact) => fact.revision)), [[1], [2]]);
  assert.equal(batches[0]?.worldFacts[0]?.payload.nested?.value, "original");
});

test("event pump clear revokes an in-flight rejected delivery without retrying it", async () => {
  const pump = new CompanionEventPump();
  pump.enqueuePlayerInput({ source: "player_text", inputId: "stale", text: "旧消息", locale: "zh-CN", timestampMs: 1 });
  let rejectDelivery: ((reason?: unknown) => void) | undefined;
  let deliveries = 0;
  const inFlight = pump.flush({
    async deliver() {
      deliveries++;
      await new Promise<void>((_resolve, reject) => {
        rejectDelivery = reject;
      });
    },
  });
  await Promise.resolve();
  pump.clear();
  rejectDelivery?.(new Error("sink_down"));
  await assert.rejects(() => inFlight, /sink_down/);
  assert.equal(pump.pendingCount, 0);
  await pump.flush({ async deliver() { deliveries++; } });
  assert.equal(deliveries, 1);

  // A post-clear admission is a distinct generation and is the only batch
  // eligible for delivery after the revoked in-flight frame.
  pump.enqueuePlayerInput({ source: "player_text", inputId: "fresh", text: "新消息", locale: "zh-CN", timestampMs: 2 });
  await pump.flush({ async deliver() { deliveries++; } });
  assert.equal(deliveries, 2);
});

test("event pump holds every progress receipt state", async () => {
  for (const state of ["accepted", "running", "meaningful_progress", "blocked"]) {
    const pump = new CompanionEventPump();
    pump.enqueueFact({
      source: "stardew_mod",
      kind: "execution_receipt",
      correlationId: state,
      revision: 1,
      payload: { state },
    });
    let deliveries = 0;
    await pump.flush({
      async deliver() {
        deliveries++;
      },
    });
    assert.equal(deliveries, 0, state);
  }
});

test("event pump classifies terminal receipt overflow separately from all nonterminal overflow classes", () => {
  const terminalPump = new CompanionEventPump();
  for (let index = 0; index < 128; index++) {
    terminalPump.enqueueFact({
      source: "stardew_mod", kind: "execution_receipt", correlationId: `progress_${index}`, revision: 1,
      payload: { state: "meaningful_progress" },
    });
  }
  assert.throws(
    () => terminalPump.enqueueFact({
      source: "stardew_mod", kind: "execution_receipt", correlationId: "terminal_overflow", revision: 1,
      payload: { state: "failed" },
    }),
    /event_pump_terminal_overflow/,
  );

  for (const [kind, payload] of [
    ["execution_receipt", { state: "meaningful_progress" }],
    ["semantic_event", { kind: "warped" }],
    ["lifecycle", { state: "adapter_notice" }],
  ] as const) {
    const pump = new CompanionEventPump();
    for (let index = 0; index < 128; index++) {
      pump.enqueueFact({ source: "stardew_mod", kind, correlationId: `${kind}_${index}`, revision: 1, payload });
    }
    assert.throws(
      () => pump.enqueueFact({ source: "stardew_mod", kind, correlationId: `${kind}_overflow`, revision: 1, payload }),
      /event_pump_event_overflow/,
      kind,
    );
  }
});

test("event pump rejects Host-local data that attempts to impersonate Mod authority", () => {
  const pump = new CompanionEventPump();
  assert.throws(() => pump.enqueueFact({ source: "host_local_transport", kind: "snapshot", correlationId: "fake", revision: 0, payload: {} } as never), /invalid_local_transport_fact/);
});
