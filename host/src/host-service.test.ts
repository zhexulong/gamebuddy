import assert from "node:assert/strict";
import test from "node:test";

import { CompanionHostService } from "./host-service.js";
import { type LocalStardewBridgeFact } from "./local-stardew-bridge.js";

function bridgeHarness() {
  let listener: ((fact: LocalStardewBridgeFact) => void) | undefined;
  return {
    bridge: { onFact(next: (fact: LocalStardewBridgeFact) => void) { listener = next; return () => { listener = undefined; }; } },
    emit(fact: LocalStardewBridgeFact) { listener?.(fact); },
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
