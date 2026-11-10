import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CompanionTurnSink, PendingBatch } from "./event-pump.js";

/**
 * A deliberately thin ordinary-turn adapter. It passes the composed batch text
 * unchanged to Pi; it is not a planner and does not synthesize world facts.
 *
 * The text is the whole message: `composeFactBrief`'s four prose blocks. What this sink used to do - parse a JSON
 * envelope to prove it was a fact batch - is now a property of the type it is handed, so the only translation left is
 * the disposition, which Pi spells differently ("followUp").
 */
export function createAgentTurnSink(session: Pick<AgentSession, "sendUserMessage">): CompanionTurnSink {
  return Object.freeze({
    async deliver(batch: PendingBatch): Promise<void> {
      await session.sendUserMessage(batch.text, { deliverAs: batch.disposition === "steer" ? "steer" : "followUp" });
    },
  });
}
