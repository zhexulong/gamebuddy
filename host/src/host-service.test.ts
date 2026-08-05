import assert from "node:assert/strict";
import test from "node:test";

import { type WorldFact } from "./event-pump.js";
import { CompanionHostService } from "./host-service.js";

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
  service.attachFinalVoiceSource({ onFinalTranscript(next) { listener = next; return () => { listener = undefined; }; } });
  listener?.({ sessionId: "session_01", inputId: "input_gateway_01", text: "走到门口", locale: "zh-CN", providerId: "fake-asr", modelRevision: "v1", timestampMs: 2, actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" } });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.deepEqual(harness.inputs, [{ source: "voice_final", inputId: "input_gateway_01", text: "走到门口", locale: "zh-CN", timestampMs: 2 }]);
  service.close(); assert.equal(listener, undefined);
});
