import assert from "node:assert/strict";
import test from "node:test";
import { CompanionLoop } from "./companion-loop.js";

test("CompanionLoop explicitly steers player input and includes the latest snapshot", async () => {
  const received: Array<{ text: string; deliverAs?: string }> = [];
  const loop = new CompanionLoop({ async sendUserMessage(text: string, options?: { deliverAs?: string }) { received.push({ text, deliverAs: options?.deliverAs }); } } as never);
  loop.pump.enqueueFact({ source: "stardew_mod", kind: "snapshot", correlationId: "snapshot_01", revision: 3, payload: { location: "Farm" } });
  loop.pump.enqueuePlayerInput({ source: "player_text", inputId: "input_01", text: "我们去哪里？", locale: "zh-CN", timestampMs: 1 });
  await loop.flush();
  assert.equal(received.length, 1);
  assert.equal(received[0]?.deliverAs, "steer");
  const batch = JSON.parse(received[0]?.text ?? "{}") as { disposition?: string; worldFacts?: unknown[]; playerInputs?: unknown[] };
  assert.equal(batch.disposition, "steer");
  assert.equal(batch.worldFacts?.length, 1);
  assert.equal(batch.playerInputs?.length, 1);
});

test("CompanionLoop steers a busy Pi session without aborting it", async () => {
  const received: Array<{ deliverAs?: string }> = [];
  let aborts = 0;
  const loop = new CompanionLoop({
    async sendUserMessage(_text: string, options?: { deliverAs?: string }) {
      received.push({ deliverAs: options?.deliverAs });
    },
    async abort() {
      aborts++;
    },
  } as never);
  loop.pump.enqueuePlayerInput({ source: "player_text", inputId: "busy_input", text: "改去镇上", locale: "zh-CN", timestampMs: 1 });
  await loop.flush();
  assert.deepEqual(received, [{ deliverAs: "steer" }]);
  assert.equal(aborts, 0);
});

test("CompanionLoop explicitly follows up an ordinary fact-only batch", async () => {
  const received: Array<{ deliverAs?: string }> = [];
  const loop = new CompanionLoop({ async sendUserMessage(_text: string, options?: { deliverAs?: string }) { received.push({ deliverAs: options?.deliverAs }); } } as never);
  loop.pump.enqueueFact({ source: "stardew_mod", kind: "semantic_event", correlationId: "warp", revision: 1, payload: { kind: "warped" } });
  await loop.flush();
  assert.deepEqual(received, [{ deliverAs: "followUp" }]);
});
