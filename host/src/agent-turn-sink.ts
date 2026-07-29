import { type AgentSession } from "@earendil-works/pi-coding-agent";
import { type CompanionTurnSink } from "./event-pump.js";

/**
 * A deliberately thin ordinary-turn adapter. It passes source-labelled batches
 * unchanged to Pi; it is not a planner and does not synthesize world facts.
 */
export function createAgentTurnSink(session: Pick<AgentSession, "sendUserMessage">): CompanionTurnSink {
  return Object.freeze({
    async deliver(text: string): Promise<void> {
      const batch: unknown = JSON.parse(text);
      if (typeof batch !== "object" || batch === null || (batch as { kind?: unknown }).kind !== "gamebuddy_fact_batch") throw new Error("invalid_agent_fact_batch");
      await session.sendUserMessage(text);
    },
  });
}
