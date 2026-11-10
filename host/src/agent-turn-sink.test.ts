import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTurnSink } from "./agent-turn-sink.js";
import type { PendingBatch } from "./event-pump.js";

/** One delivered batch, as the pump hands it over: prose the model reads, and the frame beside it. */
function batch(disposition: "steer" | "follow_up", text: string): PendingBatch {
  return Object.freeze({
    batchId: "batch_1",
    disposition,
    triggerEventIds: Object.freeze([]),
    inputs: Object.freeze([]),
    facts: Object.freeze([]),
    events: Object.freeze([]),
    text,
  });
}

test("Agent turn sink forwards the composed text with explicit Pi delivery", async () => {
  const received: Array<{ text: string; deliverAs?: string | undefined }> = [];
  const sink = createAgentTurnSink({
    async sendUserMessage(text: string | unknown[], options?: { deliverAs?: string }) {
      received.push({ text: text as string, deliverAs: options?.deliverAs });
    },
  } as never);
  const steerText = "<world-state>\n世界（revision 9，刚刚更新）\n</world-state>";
  const followUpText = "<world-facts>\n- 新的一天：第 3 天\n</world-facts>";
  await sink.deliver(batch("steer", steerText));
  await sink.deliver(batch("follow_up", followUpText));
  assert.deepEqual(received, [
    { text: steerText, deliverAs: "steer" },
    { text: followUpText, deliverAs: "followUp" },
  ]);
});
