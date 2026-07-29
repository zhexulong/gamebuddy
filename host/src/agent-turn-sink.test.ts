import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTurnSink } from "./agent-turn-sink.js";

test("Agent turn sink forwards an unmodified labelled fact batch as one ordinary Pi turn", async () => {
  const received: string[] = [];
  const sink = createAgentTurnSink({ async sendUserMessage(text: string | unknown[]) { received.push(text as string); } } as never);
  const batch = JSON.stringify({ kind: "gamebuddy_fact_batch", playerInputs: [{ source: "player_text", text: "继续" }], worldFacts: [{ source: "stardew_mod", kind: "execution_receipt", payload: { state: "failed" } }] });
  await sink.deliver(batch);
  assert.deepEqual(received, [batch]);
  await assert.rejects(() => sink.deliver("{}"), /invalid_agent_fact_batch/);
});
