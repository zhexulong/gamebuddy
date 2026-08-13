import assert from "node:assert/strict";
import test from "node:test";

import { type WorldFact } from "./event-pump.js";
import { CompanionHostService } from "./host-service.js";
import { CompanionLoop } from "./companion-loop.js";

function eventHarness() {
  let factListener: ((fact: WorldFact) => void) | undefined;
  let lifecycleListener: ((event: { state: "disconnected"; reasonCode: string }) => void) | undefined;
  return {
    events: {
      onFact(next: (fact: WorldFact) => void) { factListener = next; return () => { factListener = undefined; }; },
      onLifecycle(next: (event: { state: "disconnected"; reasonCode: string }) => void) { lifecycleListener = next; return () => { lifecycleListener = undefined; }; },
    },
    emit(fact: WorldFact) { factListener?.(fact); },
    disconnect(reasonCode = "adapter_closed") { lifecycleListener?.({ state: "disconnected", reasonCode }); },
  };
}

function fakeLoop() {
  const facts: unknown[] = []; const inputs: unknown[] = []; let flushes = 0;
  return {
    loop: { pump: { pendingCount: 0, enqueueFact(fact: unknown) { facts.push(fact); }, enqueuePlayerInput(input: unknown) { inputs.push(input); } }, async flush() { flushes++; } },
    facts, inputs, get flushes() { return flushes; },
  };
}

const snapshot = (revision: number): WorldFact => ({ source: "arcade_adapter", kind: "snapshot", eventId: `snapshot_${revision}`, occurredAtMs: Date.now(), correlationId: `snapshot_${revision}`, revision, payload: { revision, zone: "alpha" } });

test("Host service forwards adapter-labelled facts as ordinary coalesced Agent turns", async () => {
  const adapter = eventHarness(); const harness = fakeLoop();
  const service = new CompanionHostService(harness.loop as never, adapter.events);
  adapter.emit(snapshot(7));
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(harness.facts.length, 1); assert.equal(harness.flushes, 1);
  service.close();
  adapter.emit(snapshot(8));
  assert.equal(harness.facts.length, 1);
});

test("Host service schedules a second turn for a fact received during an in-flight turn", async () => {
  const adapter = eventHarness();
  let releaseFirst: (() => void) | undefined;
  let flushes = 0; let pending = 0;
  const facts: unknown[] = [];
  const loop = {
    pump: { get pendingCount() { return pending; }, enqueueFact(fact: unknown) { facts.push(fact); pending++; }, enqueuePlayerInput() {} },
    async flush() { flushes++; pending--; if (flushes === 1) await new Promise<void>((resolvePromise) => { releaseFirst = resolvePromise; }); },
  };
  const service = new CompanionHostService(loop as never, adapter.events);
  adapter.emit(snapshot(7));
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  adapter.emit(snapshot(8));
  releaseFirst?.();
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  assert.equal(facts.length, 2); assert.equal(flushes, 2);
  service.close();
});

test("Host service backs off failed adapter delivery instead of recursively retrying", async () => {
  const adapter = eventHarness(); let flushes = 0; let pending = 0;
  const loop = { pump: { get pendingCount() { return pending; }, enqueueFact() { pending++; }, enqueuePlayerInput() {} }, async flush() { flushes++; throw new Error("provider_down"); } };
  const service = new CompanionHostService(loop as never, adapter.events);
  adapter.emit(snapshot(7));
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  assert.equal(flushes, 1); service.close();
});

test("Host service fail-closes every event-pump overflow class before any further admission", () => {
  for (const overflow of ["event_pump_terminal_overflow", "event_pump_event_overflow"]) {
    const adapter = eventHarness();
    const calls: string[] = [];
    const loop = {
      pump: {
        pendingCount: 0,
        enqueueFact() {
          throw new Error(overflow);
        },
        enqueuePlayerInput() {},
        clear() {
          calls.push("clear");
        },
      },
      async flush() {},
    };
    const service = new CompanionHostService(loop as never, adapter.events, (reasonCode) => calls.push(`revoke:${reasonCode}`));
    adapter.emit({
      source: "arcade_adapter",
      kind: "semantic_event",
      correlationId: overflow,
      revision: 1,
      payload: { kind: "overflow_test" },
    });
    assert.deepEqual(calls, ["revoke:event_overflow", "clear"], overflow);
    adapter.emit(snapshot(2));
    assert.deepEqual(calls, ["revoke:event_overflow", "clear"], `${overflow} remains sealed`);
    service.close();
  }
});

test("Host service preserves an ordinary event overflow revoke error after clearing exactly once", () => {
  const adapter = eventHarness();
  const calls: string[] = [];
  const loop = {
    pump: {
      pendingCount: 0,
      enqueueFact() {
        throw new Error("event_pump_event_overflow");
      },
      enqueuePlayerInput() {},
      clear() {
        calls.push("clear");
      },
    },
    async flush() {},
  };
  const service = new CompanionHostService(loop as never, adapter.events, () => {
    calls.push("revoke:event_overflow");
    throw new Error("disconnect_failed");
  });
  assert.throws(() => adapter.emit({
    source: "arcade_adapter", kind: "semantic_event", correlationId: "ordinary_event", revision: 1, payload: { kind: "warped" },
  }), /disconnect_failed/);
  assert.deepEqual(calls, ["revoke:event_overflow", "clear"]);
  adapter.emit(snapshot(2));
  assert.deepEqual(calls, ["revoke:event_overflow", "clear"]);
  service.close();
});

test("Host service overflow during an in-flight rejected delivery cannot retry or resurrect the pump", async () => {
  const adapter = eventHarness();
  let pending = 0;
  let admitted = 0;
  let flushes = 0;
  let beginDelivery: (() => void) | undefined;
  let rejectDelivery: ((reason?: unknown) => void) | undefined;
  let deliveryFinished: (() => void) | undefined;
  const deliveryStarted = new Promise<void>((resolve) => { beginDelivery = resolve; });
  const deliverySettled = new Promise<void>((resolve) => { deliveryFinished = resolve; });
  const loop = {
    pump: {
      get pendingCount() { return pending; },
      enqueueFact(fact: WorldFact) {
        admitted++;
        if (fact.correlationId === "overflow") throw new Error("event_pump_event_overflow");
        pending++;
      },
      enqueuePlayerInput() {},
      clear() { pending = 0; },
    },
    async flush() {
      flushes++;
      beginDelivery?.();
      try {
        await new Promise<void>((_resolve, reject) => { rejectDelivery = reject; });
      } finally {
        deliveryFinished?.();
      }
    },
  };
  const service = new CompanionHostService(loop as never, adapter.events);
  adapter.emit({ source: "arcade_adapter", kind: "semantic_event", correlationId: "in_flight", revision: 1, payload: { kind: "warped" } });
  await deliveryStarted;
  adapter.emit({ source: "arcade_adapter", kind: "semantic_event", correlationId: "overflow", revision: 1, payload: { kind: "warped" } });
  adapter.emit(snapshot(2));
  rejectDelivery?.(new Error("provider_down"));
  await deliverySettled;
  await Promise.resolve();
  assert.equal(flushes, 1);
  assert.equal(pending, 0);
  assert.equal(admitted, 2);
  adapter.emit(snapshot(3));
  assert.equal(admitted, 2);
  assert.equal(flushes, 1);
  service.close();
});

test("Host service overflow cancels a scheduled delivery and seals subsequent adapter facts", async () => {
  const adapter = eventHarness();
  const delivered: string[] = [];
  const loop = new CompanionLoop({ async sendUserMessage(text: string) { delivered.push(text); } } as never);
  const service = new CompanionHostService(loop, adapter.events);
  for (let index = 0; index < 128; index++) {
    adapter.emit({ source: "arcade_adapter", kind: "semantic_event", correlationId: `event_${index}`, revision: 1, payload: {} });
  }
  adapter.emit({ source: "arcade_adapter", kind: "semantic_event", correlationId: "overflow", revision: 1, payload: {} });
  adapter.emit({ source: "arcade_adapter", kind: "semantic_event", correlationId: "after_overflow", revision: 1, payload: {} });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.deepEqual(delivered, []);
  assert.equal(loop.pump.pendingCount, 0);
  service.close();
});

test("Host service rejects player text after overflow or close without delivering it", async () => {
  const overflowAdapter = eventHarness();
  const overflowHarness = fakeLoop();
  const overflowLoop = {
    pump: {
      ...overflowHarness.loop.pump,
      enqueueFact() { throw new Error("event_pump_event_overflow"); },
      clear() {},
    },
    flush: overflowHarness.loop.flush,
  };
  const overflowService = new CompanionHostService(overflowLoop as never, overflowAdapter.events);
  overflowAdapter.emit(snapshot(1));
  await overflowService.acceptPlayerText("after overflow", "en-US", 1);
  assert.deepEqual(overflowHarness.inputs, []);
  assert.equal(overflowHarness.flushes, 0);
  overflowService.close();

  const closedAdapter = eventHarness();
  const closedHarness = fakeLoop();
  const closedService = new CompanionHostService(closedHarness.loop as never, closedAdapter.events);
  closedService.close();
  await closedService.acceptPlayerText("after close", "en-US", 2);
  assert.deepEqual(closedHarness.inputs, []);
  assert.equal(closedHarness.flushes, 0);
});

test("Host service seals lifecycle overflow before an external callback can reenter", async () => {
  const adapter = eventHarness();
  const calls: string[] = [];
  const facts: unknown[] = [];
  const inputs: unknown[] = [];
  const loop = {
    pump: {
      pendingCount: 0,
      enqueueFact(fact: WorldFact) {
        calls.push(`fact:${fact.kind}`);
        if (fact.kind === "lifecycle") throw new Error("event_pump_terminal_overflow");
        facts.push(fact);
      },
      enqueuePlayerInput(input: unknown) { inputs.push(input); },
      clear() { calls.push("clear"); },
    },
    async flush() { calls.push("flush"); },
  };
  let service: CompanionHostService;
  service = new CompanionHostService(loop as never, adapter.events, () => {
    calls.push("callback");
    adapter.emit(snapshot(2));
    void service.acceptPlayerText("reentrant", "en-US", 3);
  });
  adapter.disconnect("transport_lost");
  await Promise.resolve();
  assert.deepEqual(calls, ["fact:lifecycle", "callback", "clear"]);
  assert.deepEqual(facts, []);
  assert.deepEqual(inputs, []);
  service.close();
});

test("Host service invokes the normal lifecycle callback once and flushes its lifecycle fact", async () => {
  const adapter = eventHarness();
  const harness = fakeLoop();
  const callbacks: string[] = [];
  const service = new CompanionHostService(harness.loop as never, adapter.events, (reasonCode) => callbacks.push(reasonCode));
  adapter.disconnect("adapter_closed");
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.deepEqual(callbacks, ["adapter_closed"]);
  assert.equal(harness.facts.length, 1);
  assert.equal(harness.flushes, 1);
  service.close();
});

test("Host service rejects an adapter attempt to impersonate local transport", () => {
  const adapter = eventHarness(); const harness = fakeLoop();
  const service = new CompanionHostService(harness.loop as never, adapter.events);
  assert.throws(() => adapter.emit({ ...snapshot(1), source: "host_local_transport" }), /adapter_transport_source_reserved/);
  service.close();
});

test("Host service reports adapter disconnect without inventing a game-world event", async () => {
  const adapter = eventHarness(); const harness = fakeLoop();
  const service = new CompanionHostService(harness.loop as never, adapter.events);
  adapter.disconnect();
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.deepEqual(harness.facts, [{ source: "host_local_transport", kind: "lifecycle", correlationId: "transport_disconnected", revision: 0, payload: { state: "disconnected", reasonCode: "adapter_closed" } }]);
  service.close();
});

test("Host service admits only final voice text and does not project ordinary output", async () => {
  const adapter = eventHarness(); const harness = fakeLoop();
  const service = new CompanionHostService(harness.loop as never, adapter.events);
  await service.acceptFinalVoice({ sessionId: "session_01", inputId: "input_01", text: "看看农场", locale: "zh-CN", providerId: "fake", modelRevision: "v1", timestampMs: 1, actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" } });
  assert.deepEqual(harness.inputs, [{ source: "voice_final", inputId: "input_01", text: "看看农场", locale: "zh-CN", timestampMs: 1 }]); service.close();
});

test("Host service receives only final transcripts from an attached Voice Gateway source", async () => {
  const adapter = eventHarness(); const harness = fakeLoop();
  let listener: ((input: { sessionId: string; inputId: string; text: string; locale: string; providerId: string; modelRevision: string; timestampMs: number; actualFormat: { sampleRate: number; channels: number; encoding: "pcm_s16le" } }) => void) | undefined;
  const service = new CompanionHostService(harness.loop as never, adapter.events);
  const detach = service.attachFinalVoiceSource({ onFinalTranscript(next) { listener = next; return () => { listener = undefined; }; } });
  listener?.({ sessionId: "session_01", inputId: "input_gateway_01", text: "走到门口", locale: "zh-CN", providerId: "fake-asr", modelRevision: "v1", timestampMs: 2, actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" } });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.deepEqual(harness.inputs, [{ source: "voice_final", inputId: "input_gateway_01", text: "走到门口", locale: "zh-CN", timestampMs: 2 }]);
  await detach();
  service.close(); assert.equal(listener, undefined);
});
