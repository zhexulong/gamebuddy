import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTurnSink } from "./agent-turn-sink.js";

test("Agent turn sink forwards a classified labelled fact batch with explicit Pi delivery", async () => {
  const received: Array<{ text: string; deliverAs?: string }> = [];
  const sink = createAgentTurnSink({ async sendUserMessage(text: string | unknown[], options?: { deliverAs?: string }) { received.push({ text: text as string, deliverAs: options?.deliverAs }); } } as never);
  const steerBatch = JSON.stringify({ kind: "gamebuddy_fact_batch", disposition: "steer", playerInputs: [{ source: "player_text", text: "继续" }], worldFacts: [] });
  const followUpBatch = JSON.stringify({ kind: "gamebuddy_fact_batch", disposition: "follow_up", playerInputs: [], worldFacts: [] });
  await sink.deliver(steerBatch, "steer");
  await sink.deliver(followUpBatch, "follow_up");
  assert.deepEqual(received, [{ text: steerBatch, deliverAs: "steer" }, { text: followUpBatch, deliverAs: "followUp" }]);
  for (const invalid of [
    ["{}", "follow_up"],
    [JSON.stringify({ kind: "gamebuddy_fact_batch" }), "follow_up"],
    [JSON.stringify({ kind: "gamebuddy_fact_batch", disposition: "hold" }), "follow_up"],
    [steerBatch, "follow_up"],
  ] as const) {
    await assert.rejects(() => sink.deliver(invalid[0], invalid[1]), /invalid_agent_fact_batch/);
  }
  assert.equal(received.length, 2);
});
