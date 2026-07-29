import assert from "node:assert/strict";
import test from "node:test";
import { CompanionLoop } from "./companion-loop.js";

test("CompanionLoop provides source-labelled Mod facts as an ordinary Pi turn", async () => {
  const received: Array<{ text: string; deliverAs?: string }> = [];
  const loop = new CompanionLoop({ async sendUserMessage(text: string, options?: { deliverAs?: string }) { received.push({ text, deliverAs: options?.deliverAs }); } } as never);
  loop.pump.enqueueFact({ source: "stardew_mod", kind: "snapshot", correlationId: "snapshot_01", revision: 3, payload: { location: "Farm" } });
  loop.pump.enqueuePlayerInput({ source: "player_text", inputId: "input_01", text: "我们去哪里？", locale: "zh-CN", timestampMs: 1 });
  await loop.flush();
  assert.equal(received.length, 1);
  assert.equal(received[0]?.deliverAs, "followUp");
  const batch = JSON.parse(received[0]?.text ?? "{}") as { kind?: string; worldFacts?: unknown[]; playerInputs?: unknown[] };
  assert.equal(batch.kind, "gamebuddy_fact_batch");
  assert.equal(batch.worldFacts?.length, 1);
  assert.equal(batch.playerInputs?.length, 1);
});
