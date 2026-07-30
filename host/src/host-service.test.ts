import assert from "node:assert/strict";
import test from "node:test";

import { CompanionHostService } from "./host-service.js";
import { type LocalStardewBridgeFact } from "./local-stardew-bridge.js";

function bridgeHarness() {
  let listener: ((fact: LocalStardewBridgeFact) => void) | undefined;
  let connectionListener: ((fact: { state: "disconnected"; reasonCode: string }) => void) | undefined;
  return {
    bridge: {
      onFact(next: (fact: LocalStardewBridgeFact) => void) { listener = next; return () => { listener = undefined; }; },
      onConnectionFact(next: (fact: { state: "disconnected"; reasonCode: string }) => void) { connectionListener = next; return () => { connectionListener = undefined; }; },
    },
    emit(fact: LocalStardewBridgeFact) { listener?.(fact); },
    disconnect(reasonCode = "pipe_closed") { connectionListener?.({ state: "disconnected", reasonCode }); },
  };
}

function fakeLoop() {
  const facts: unknown[] = []; const inputs: unknown[] = []; let flushes = 0;
  return {
    loop: { pump: { pendingCount: 0, enqueueFact(fact: unknown) { facts.push(fact); }, enqueuePlayerInput(input: unknown) { inputs.push(input); } }, async flush() { flushes++; } },
    facts, inputs, get flushes() { return flushes; },
  };
}

const scope = { integrationId: "stardew", saveId: "save_01", worldId: "world_01", playerId: "farmhand_01", companionId: "companion_01" } as const;

test("Host service forwards only Mod facts as ordinary coalesced Agent turns", async () => {
  const bridge = bridgeHarness(); const harness = fakeLoop();
  const service = new CompanionHostService(harness.loop as never, bridge.bridge as never);
  bridge.emit({ protocolVersion: 1, messageId: "snapshot_01", correlationId: "snapshot_01", timestampMs: Date.now(), scope, type: "snapshot", payload: { revision: 7, location: "Farm", tile: { x: 4, y: 8 }, stamina: 250, health: 100, actionable: true, capabilities: ["move_to_tile"], activeExecution: null } });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(harness.facts.length, 1); assert.equal(harness.flushes, 1);
  service.close();
  bridge.emit({ protocolVersion: 1, messageId: "snapshot_02", correlationId: "snapshot_02", timestampMs: Date.now(), scope, type: "snapshot", payload: { revision: 8, location: "Farm", tile: { x: 5, y: 8 }, stamina: 250, health: 100, actionable: true, capabilities: [], activeExecution: null } });
  assert.equal(harness.facts.length, 1);
});

test("Host service schedules a second turn for a fact received during an in-flight turn", async () => {
  const bridge = bridgeHarness();
  let releaseFirst: (() => void) | undefined;
  let flushes = 0; let pending = 0;
  const facts: unknown[] = [];
  const loop = {
    pump: { get pendingCount() { return pending; }, enqueueFact(fact: unknown) { facts.push(fact); pending++; }, enqueuePlayerInput() {} },
    async flush() { flushes++; pending--; if (flushes === 1) await new Promise<void>((resolvePromise) => { releaseFirst = resolvePromise; }); },
  };
  const service = new CompanionHostService(loop as never, bridge.bridge as never);
  bridge.emit({ protocolVersion: 1, messageId: "snapshot_01", correlationId: "snapshot_01", timestampMs: Date.now(), scope, type: "snapshot", payload: { revision: 7, location: "Farm", tile: { x: 4, y: 8 }, stamina: 250, health: 100, actionable: true, capabilities: ["move_to_tile"], activeExecution: null } });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  bridge.emit({ protocolVersion: 1, messageId: "snapshot_02", correlationId: "snapshot_02", timestampMs: Date.now(), scope, type: "snapshot", payload: { revision: 8, location: "Farm", tile: { x: 5, y: 8 }, stamina: 250, health: 100, actionable: true, capabilities: ["move_to_tile"], activeExecution: null } });
  releaseFirst?.();
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  assert.equal(facts.length, 2);
  assert.equal(flushes, 2);
  service.close();
});

test("Host service backs off failed bridge delivery instead of recursively retrying", async () => {
  const bridge = bridgeHarness();
  let flushes = 0; let pending = 0;
  const loop = {
    pump: { get pendingCount() { return pending; }, enqueueFact() { pending++; }, enqueuePlayerInput() {} },
    async flush() { flushes++; throw new Error("provider_down"); },
  };
  const service = new CompanionHostService(loop as never, bridge.bridge as never);
  bridge.emit({ protocolVersion: 1, messageId: "snapshot_retry_01", correlationId: "snapshot_retry_01", timestampMs: Date.now(), scope, type: "snapshot", payload: { revision: 7, location: "Farm", tile: { x: 4, y: 8 }, stamina: 250, health: 100, actionable: true, capabilities: ["move_to_tile"], activeExecution: null } });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  assert.equal(flushes, 1);
  service.close();
});

test("Host service reports a local pipe disconnect without inventing a Mod world event", async () => {
  const bridge = bridgeHarness(); const harness = fakeLoop();
  const service = new CompanionHostService(harness.loop as never, bridge.bridge as never);
  bridge.disconnect();
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.deepEqual(harness.facts, [{ source: "host_local_transport", kind: "lifecycle", correlationId: "transport_disconnected", revision: 0, payload: { state: "disconnected", reasonCode: "pipe_closed" } }]);
  service.close();
});

test("Host service admits only final voice text and shows text before speech", async () => {
  const bridge = bridgeHarness(); const harness = fakeLoop();
  const service = new CompanionHostService(harness.loop as never, bridge.bridge as never);
  await service.acceptFinalVoice({ sessionId: "session_01", inputId: "input_01", text: "看看农场", locale: "zh-CN", providerId: "fake", modelRevision: "v1", timestampMs: 1, actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" } });
  assert.deepEqual(harness.inputs, [{ source: "voice_final", inputId: "input_01", text: "看看农场", locale: "zh-CN", timestampMs: 1 }]);
  const timeline: string[] = [];
  await service.express({ show() { timeline.push("text"); } }, { enqueue() { timeline.push("speech"); } }, { sessionId: "session_01", sourceEventId: "event_01", text: "我在。", locale: "zh-CN", voiceProfile: "default", epoch: 0, expiresAtMs: Date.now() + 10_000 });
  assert.deepEqual(timeline, ["text", "speech"]);
  service.close();
});

test("Host service receives only final transcripts from an attached Voice Gateway source", async () => {
  const bridge = bridgeHarness(); const harness = fakeLoop();
  let listener: ((input: { sessionId: string; inputId: string; text: string; locale: string; providerId: string; modelRevision: string; timestampMs: number; actualFormat: { sampleRate: number; channels: number; encoding: "pcm_s16le" } }) => void) | undefined;
  const service = new CompanionHostService(harness.loop as never, bridge.bridge as never);
  service.attachFinalVoiceSource({ onFinalTranscript(next) { listener = next; return () => { listener = undefined; }; } });
  listener?.({ sessionId: "session_01", inputId: "input_gateway_01", text: "走到门口", locale: "zh-CN", providerId: "fake-asr", modelRevision: "v1", timestampMs: 2, actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" } });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.deepEqual(harness.inputs, [{ source: "voice_final", inputId: "input_gateway_01", text: "走到门口", locale: "zh-CN", timestampMs: 2 }]);
  service.close();
  assert.equal(listener, undefined);
});
