import assert from "node:assert/strict";
import test from "node:test";
import { CompanionEventPump } from "./event-pump.js";

test("event pump steers player input and attaches the latest snapshot", async () => {
  const pump = new CompanionEventPump();
  const delivered: Array<{ text: string; disposition: string }> = [];
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: "s1",
    revision: 1,
    payload: { location: "Farm" },
  });
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: "s2",
    revision: 2,
    payload: { location: "Town" },
  });
  pump.enqueuePlayerInput({
    source: "voice_final",
    inputId: "voice_1",
    text: "去镇上",
    locale: "zh-CN",
    timestampMs: 1,
  });
  await pump.flush({
    async deliver(text, disposition) {
      delivered.push({ text, disposition });
    },
  });
  assert.equal(delivered[0]?.disposition, "steer");
  const batch = JSON.parse(delivered[0]?.text ?? "{}") as {
    disposition: string;
    triggerEventIds: string[];
    playerInputs: Array<{ text: string }>;
    worldFacts: Array<{ revision: number }>;
  };
  assert.equal(batch.disposition, "steer");
  assert.deepEqual(batch.triggerEventIds, ["voice_1"]);
  assert.deepEqual(
    batch.playerInputs.map((input) => input.text),
    ["去镇上"],
  );
  assert.deepEqual(
    batch.worldFacts.map((fact) => fact.revision),
    [2],
  );
  assert.equal(pump.pendingCount, 0);
});

test("event pump serializes a bounded context projection without replacing authoritative fact payload", async () => {
  const pump = new CompanionEventPump();
  const authoritativePayload = { revision: 7, activeExecution: { requestId: "request_secret" } };
  const contextProjection = Object.freeze({
    schema: "gamebuddy-game-snapshot-projection/v1",
    available: true,
    snapshotRevision: 7,
    text: "bounded",
  });
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: "snapshot",
    revision: 7,
    payload: authoritativePayload,
    contextProjection,
  });
  pump.enqueuePlayerInput({ source: "player_text", inputId: "input", text: "继续", locale: "zh-CN", timestampMs: 1 });

  const delivered: string[] = [];
  await pump.flush({
    async deliver(text) {
      delivered.push(text);
    },
  });

  const batch = JSON.parse(delivered[0] ?? "{}") as {
    worldFacts: Array<{ payload: Record<string, unknown> }>;
    events: Array<{ payload: Record<string, unknown> }>;
  };
  assert.deepEqual(batch.worldFacts[0]?.payload, contextProjection);
  assert.deepEqual(batch.events.find((event) => event.payload.schema !== undefined)?.payload, contextProjection);
  assert.equal(JSON.stringify(batch).includes("request_secret"), false);
  assert.equal("contextProjection" in (batch.worldFacts[0] ?? {}), false);
});

test("event pump holds snapshot and meaningful progress until an ordinary trigger arrives", async () => {
  const pump = new CompanionEventPump();
  const delivered: Array<{ text: string; disposition: string }> = [];
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: "snapshot",
    revision: 4,
    payload: { location: "Farm" },
  });
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: "execution",
    revision: 4,
    payload: { state: "running" },
  });
  await pump.flush({
    async deliver(text, disposition) {
      delivered.push({ text, disposition });
    },
  });
  assert.equal(delivered.length, 0);

  pump.enqueueFact({
    source: "stardew_mod",
    kind: "semantic_event",
    eventId: "event_1",
    correlationId: "event",
    revision: 5,
    payload: { kind: "location_changed" },
  });
  await pump.flush({
    async deliver(text, disposition) {
      delivered.push({ text, disposition });
    },
  });
  assert.equal(delivered[0]?.disposition, "follow_up");
  const batch = JSON.parse(delivered[0]?.text ?? "{}") as {
    triggerEventIds: string[];
    worldFacts: Array<{ kind: string; payload: { state?: string }; revision: number }>;
  };
  assert.deepEqual(batch.triggerEventIds, ["event_1"]);
  assert.deepEqual(
    batch.worldFacts.map((fact) => [fact.kind, fact.payload.state ?? "", fact.revision]),
    [
      ["snapshot", "", 4],
      ["execution_receipt", "running", 4],
      ["semantic_event", "", 5],
    ],
  );
});

test("event pump follows up ordinary facts and preserves an exact failed batch retry", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: "execution_a",
    revision: 1,
    payload: { state: "failed" },
  });
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: "execution_b",
    revision: 2,
    payload: { state: "succeeded" },
  });
  await assert.rejects(
    () =>
      pump.flush({
        async deliver() {
          throw new Error("sink_down");
        },
      }),
    /sink_down/,
  );
  const delivered: Array<{ text: string; disposition: string }> = [];
  await pump.flush({
    async deliver(text, disposition) {
      delivered.push({ text, disposition });
    },
  });
  assert.equal(delivered[0]?.disposition, "follow_up");
  const batch = JSON.parse(delivered[0]?.text ?? "{}") as { worldFacts: Array<{ correlationId: string }> };
  assert.deepEqual(
    batch.worldFacts.map((item) => item.correlationId),
    ["execution_a", "execution_b"],
  );
});

test("event pump retries the exact serialized batch without replaying a newer or mutated payload", async () => {
  const pump = new CompanionEventPump();
  const payload = { nested: { value: "original" } };
  pump.enqueueFact({ source: "stardew_mod", kind: "snapshot", correlationId: "s", revision: 1, payload });
  pump.enqueuePlayerInput({ source: "player_text", inputId: "input", text: "继续", locale: "zh-CN", timestampMs: 1 });
  let firstFrame = "";
  await assert.rejects(
    () =>
      pump.flush({
        async deliver(text) {
          firstFrame = text;
          payload.nested.value = "mutated";
          throw new Error("down");
        },
      }),
    /down/,
  );
  pump.enqueueFact({ source: "stardew_mod", kind: "snapshot", correlationId: "s", revision: 2, payload: {} });
  const delivered: string[] = [];
  await pump.flush({
    async deliver(text) {
      delivered.push(text);
    },
  });
  assert.equal(delivered[0], firstFrame);
  // A later held snapshot must wait for a new trigger; it must not be replayed
  // into the frozen retry batch nor manufacture a Pi turn by itself.
  pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "next_input",
    text: "接着做",
    locale: "zh-CN",
    timestampMs: 2,
  });
  await pump.flush({
    async deliver(text) {
      delivered.push(text);
    },
  });
  const batches = delivered.map(
    (text) => JSON.parse(text) as { worldFacts: { revision: number; payload: { nested?: { value: string } } }[] },
  );
  assert.deepEqual(
    batches.map((batch) => batch.worldFacts.map((fact) => fact.revision)),
    [[1], [2]],
  );
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
  await pump.flush({
    async deliver() {
      deliveries++;
    },
  });
  assert.equal(deliveries, 1);

  // A post-clear admission is a distinct generation and is the only batch
  // eligible for delivery after the revoked in-flight frame.
  pump.enqueuePlayerInput({ source: "player_text", inputId: "fresh", text: "新消息", locale: "zh-CN", timestampMs: 2 });
  await pump.flush({
    async deliver() {
      deliveries++;
    },
  });
  assert.equal(deliveries, 2);
});

test("event pump clear revokes an in-flight rejected fact delivery and preserves only the new generation", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "stale_event",
    correlationId: "stale_delivery",
    revision: 1,
    observedTick: 10,
    payload: { value: "stale" },
  });

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
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "fresh_event",
    correlationId: "fresh_delivery",
    revision: 2,
    observedTick: 11,
    payload: { value: "fresh" },
  });
  rejectDelivery?.(new Error("sink_down"));
  await assert.rejects(() => inFlight, /sink_down/);

  const delivered: string[] = [];
  await pump.flush({
    async deliver(text) {
      deliveries++;
      delivered.push(text);
    },
  });

  assert.equal(deliveries, 2);
  const batch = JSON.parse(delivered[0] ?? "{}") as {
    worldFacts: Array<{ eventId: string; payload: { value: string } }>;
  };
  assert.deepEqual(
    batch.worldFacts.map((fact) => [fact.eventId, fact.payload.value]),
    [["fresh_event", "fresh"]],
  );
  assert.equal(pump.pendingCount, 0);
});

test("event pump holds every nonterminal progress receipt state", async () => {
  for (const state of ["accepted", "running", "meaningful_progress"]) {
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

test("event pump follows up a blocked terminal receipt without waiting for an unrelated trigger", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: "blocked_execution",
    revision: 1,
    payload: { state: "blocked", reasonCode: "precondition_failed" },
  });
  const delivered: Array<{ text: string; disposition: string }> = [];
  await pump.flush({
    async deliver(text, disposition) {
      delivered.push({ text, disposition });
    },
  });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.disposition, "follow_up");
  const batch = JSON.parse(delivered[0]?.text ?? "{}") as { worldFacts: Array<{ payload: { state?: string } }> };
  assert.deepEqual(
    batch.worldFacts.map((fact) => fact.payload.state),
    ["blocked"],
  );
});

test("event pump classifies terminal receipt overflow separately from all nonterminal overflow classes", () => {
  const terminalPump = new CompanionEventPump();
  for (let index = 0; index < 128; index++) {
    terminalPump.enqueueFact({
      source: "stardew_mod",
      kind: "execution_receipt",
      correlationId: `progress_${index}`,
      revision: 1,
      payload: { state: "meaningful_progress" },
    });
  }
  // A TERMINAL receipt arriving at a window full of NON-terminal receipts evicts the oldest of those instead of
  // closing the bridge, and counts it: the terminal is the authority for its execution, the progress it replaces is not.
  terminalPump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: "terminal_overflow",
    revision: 1,
    payload: { state: "failed" },
  });
  assert.equal(terminalPump.droppedFacts, 1);
  assert.equal(terminalPump.pendingCount, 128);

  // Facts a later fact SUPERSEDES are the ones that may be dropped: a non-terminal receipt (its terminal is still to
  // come) and a lifecycle notice. Measured 2026-10-19 (`g97cross`): 870 facts in one run, 470 of them receipts,
  // arriving while a turn was in flight - and closing the whole bridge over them ended that run short of its night.
  for (const [kind, payload] of [
    ["execution_receipt", { state: "meaningful_progress" }],
    ["lifecycle", { state: "adapter_notice" }],
  ] as const) {
    const pump = new CompanionEventPump();
    for (let index = 0; index < 128; index++) {
      pump.enqueueFact({ source: "stardew_mod", kind, correlationId: `${kind}_${index}`, revision: 1, payload });
    }
    pump.enqueueFact({ source: "stardew_mod", kind, correlationId: `${kind}_overflow`, revision: 1, payload });
    assert.equal(pump.droppedFacts, 1, kind);
    assert.equal(pump.pendingCount, 128, kind);
  }

  // A semantic event that is NOT progress still fails closed: `warped` says something no later fact repeats, so a
  // window full of them holds nothing that may be evicted and the bridge refuses rather than losing one.
  const eventPump = new CompanionEventPump();
  for (let index = 0; index < 128; index++) {
    eventPump.enqueueFact({
      source: "stardew_mod",
      kind: "semantic_event",
      correlationId: `semantic_${index}`,
      revision: 1,
      payload: { kind: "warped" },
    });
  }
  assert.throws(
    () =>
      eventPump.enqueueFact({
        source: "stardew_mod",
        kind: "semantic_event",
        correlationId: "semantic_overflow",
        revision: 1,
        payload: { kind: "warped" },
      }),
    /event_pump_event_overflow/,
  );

  // A TERMINAL receipt arriving at a full window still never closes the bridge over a NON-terminal entry: it evicts the
  // oldest of those instead, and counts that. Terminals are the authority for their execution, so losing one would leave
  // a request that never settles - the shape fail-closed exists for.
  const mixedPump = new CompanionEventPump();
  mixedPump.enqueueFact({
    source: "stardew_mod",
    kind: "semantic_event",
    correlationId: "progress-filler",
    revision: 1,
    payload: { kind: "warped" },
  });
  for (let index = 0; index < 127; index++) {
    mixedPump.enqueueFact({
      source: "stardew_mod",
      kind: "execution_receipt",
      correlationId: `terminal_${index}`,
      revision: 1,
      payload: { state: "failed" },
    });
  }
  mixedPump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: "terminal_after_full",
    revision: 1,
    payload: { state: "failed" },
  });
  assert.equal(mixedPump.droppedFacts, 1);
  assert.equal(mixedPump.pendingCount, 128);
});

test("event pump keeps a long run's PROGRESS observations from filling the pending window", () => {
  // Measured 2026-10-17 on a real multi-day run: one agent turn (70 assistant messages, ~350s) made the Mod
  // publish 129 per-tile observations, each with its OWN correlationId, and they filled the 128-entry window -
  // so the pump threw and the bridge closed mid-run. The receipt half of the same traffic is already
  // latest-only, so the semantic half must be too.
  const pump = new CompanionEventPump();
  for (let index = 0; index < 500; index++) {
    pump.enqueueFact({
      source: "stardew_mod",
      kind: "semantic_event",
      correlationId: `route_progress_${index}`,
      executionId: "exec-one",
      revision: index + 1,
      payload: { kind: "route_progress" },
    });
  }
  // Thousands of observations of ONE execution are one slot, so nothing overflowed.
  assert.equal(pump.pendingCount, 1);

  // The actor-level kind has no execution to key on, so it collapses onto its own kind.
  for (let index = 0; index < 200; index++) {
    pump.enqueueFact({
      source: "stardew_mod",
      kind: "semantic_event",
      correlationId: `body_idle_${index}`,
      revision: index + 1,
      payload: { kind: "body_idle" },
    });
  }
  assert.equal(pump.pendingCount, 2);

  // An OUTCOME semantic event is NOT progress: dropping one would hide an execution that already ended, so it
  // keeps its own slot and can still report an overflow honestly. It gets a pump of its own because the two
  // progress slots above are already held in this one, and this block is about the outcome class alone: 128
  // outcomes fill the window exactly, and the 129th is the honest overflow.
  const outcomePump = new CompanionEventPump();
  for (let index = 0; index < 128; index++) {
    outcomePump.enqueueFact({
      source: "stardew_mod",
      kind: "semantic_event",
      correlationId: `settled_${index}`,
      executionId: `exec-${index}`,
      revision: 1,
      payload: { kind: "execution_settled_succeeded" },
    });
  }
  assert.throws(
    () =>
      outcomePump.enqueueFact({
        source: "stardew_mod",
        kind: "semantic_event",
        correlationId: "settled_overflow",
        executionId: "exec-overflow",
        revision: 1,
        payload: { kind: "execution_settled_succeeded" },
      }),
    /event_pump_event_overflow/,
  );
});

test("event pump rejects Host-local data that attempts to impersonate Mod authority", () => {
  const pump = new CompanionEventPump();
  assert.throws(
    () =>
      pump.enqueueFact({
        source: "host_local_transport",
        kind: "snapshot",
        correlationId: "fake",
        revision: 0,
        payload: {},
      } as never),
    /invalid_local_transport_fact/,
  );
});

test("event pump delivers an npc_dialogue_presented world fact to the Agent's context as readable text", async () => {
  const pump = new CompanionEventPump();
  const payload = Object.freeze({
    speaker: "Marnie",
    pages: ["早安，今天也要加油哦。", "你这阵子都没来看我。"],
    isQuestion: false,
    choices: [],
  });
  const fact = {
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: "npc_dialogue_marnie_7",
    sourceEventId: "npc_dialogue_marnie_7",
    correlationId: "npc_dialogue_marnie_7",
    revision: 1,
    observedTick: 4242,
    semanticKind: "npc_dialogue_presented",
    payload,
  };
  pump.enqueueFact(fact);
  // Same dialogue identity (identical Mod eventId) re-emitted on a new transport
  // correlation is still one fact; only the Host's world-fact key decides identity.
  pump.enqueueFact({ ...fact, correlationId: "transport_retry" });

  const delivered: string[] = [];
  await pump.flush({
    async deliver(text) {
      delivered.push(text);
    },
  });

  assert.equal(delivered.length, 1);
  const batch = JSON.parse(delivered[0] ?? "{}") as {
    triggerEventIds: string[];
    worldFacts: Array<{ semanticKind?: string; payload: Record<string, unknown> }>;
    events: Array<{ kind: string; semanticKind?: string; payload: Record<string, unknown> }>;
  };
  assert.deepEqual(batch.triggerEventIds, ["npc_dialogue_marnie_7"]);
  // The Mod's payload IS the model-facing text: the Host keeps the readable
  // speaker/pages/isQuestion/choices verbatim and adds no reinterpretation, so
  // these assertions are on agent-visible content, not on an internal code.
  const worldFact = batch.worldFacts.find((candidate) => candidate.semanticKind === "npc_dialogue_presented");
  assert.deepEqual(worldFact?.payload, payload);
  assert.equal("contextProjection" in (worldFact ?? {}), false);
  const event = batch.events.find((candidate) => candidate.semanticKind === "npc_dialogue_presented");
  assert.equal(event?.kind, "world_fact");
  assert.equal(event?.payload.speaker, "Marnie");
  assert.deepEqual(event?.payload.pages, ["早安，今天也要加油哦。", "你这阵子都没来看我。"]);
});
