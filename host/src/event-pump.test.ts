import assert from "node:assert/strict";
import test from "node:test";
import { CompanionEventPump } from "./event-pump.js";

test("event pump coalesces Mod facts and forwards final player input without inventing intent", async () => {
  const pump = new CompanionEventPump(); const delivered: string[] = [];
  pump.enqueueFact({ source: "stardew_mod", kind: "snapshot", correlationId: "s1", revision: 1, payload: { location: "Farm" } });
  pump.enqueueFact({ source: "stardew_mod", kind: "snapshot", correlationId: "s2", revision: 2, payload: { location: "Town" } });
  pump.enqueuePlayerInput({ source: "voice_final", inputId: "voice_1", text: "去镇上", locale: "zh-CN", timestampMs: 1 });
  await pump.flush({ async deliver(text) { delivered.push(text); } });
  const batch = JSON.parse(delivered[0]!) as { playerInputs: Array<{ text: string }>; worldFacts: Array<{ revision: number }> };
  assert.deepEqual(batch.playerInputs.map((input) => input.text), ["去镇上"]);
  assert.deepEqual(batch.worldFacts.map((fact) => fact.revision), [2]);
  assert.equal(pump.pendingCount, 0);
});

test("event pump rejects Host-local data that attempts to impersonate Mod authority", () => {
  const pump = new CompanionEventPump();
  assert.throws(() => pump.enqueueFact({ source: "host_local_transport", kind: "snapshot", correlationId: "fake", revision: 0, payload: { state: "disconnected", reasonCode: "x" } } as never), /invalid_local_transport_fact/);
  assert.throws(() => pump.enqueueFact({ source: "host_local_transport", kind: "execution_receipt", correlationId: "fake", revision: 0, payload: { state: "disconnected", reasonCode: "x" } } as never), /invalid_local_transport_fact/);
});

test("event pump preserves distinct receipts and restores a failed delivery", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact({ source: "stardew_mod", kind: "execution_receipt", correlationId: "execution_a", revision: 1, payload: { state: "failed" } });
  pump.enqueueFact({ source: "stardew_mod", kind: "execution_receipt", correlationId: "execution_b", revision: 2, payload: { state: "succeeded" } });
  pump.enqueuePlayerInput({ source: "player_text", inputId: "text_1", text: "继续", locale: "zh-CN", timestampMs: 2 });
  await assert.rejects(() => pump.flush({ async deliver() { throw new Error("sink_down"); } }), /sink_down/);
  assert.equal(pump.pendingCount, 3);
  const delivered: string[] = [];
  await pump.flush({ async deliver(text) { delivered.push(text); } });
  const batch = JSON.parse(delivered[0]!) as { playerInputs: Array<{ text: string }>; worldFacts: Array<{ correlationId: string }> };
  assert.deepEqual(batch.playerInputs.map((item) => item.text), ["继续"]);
  assert.deepEqual(batch.worldFacts.map((item) => item.correlationId), ["execution_a", "execution_b"]);
});
