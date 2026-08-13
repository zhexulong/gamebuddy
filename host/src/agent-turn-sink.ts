import { type AgentSession } from "@earendil-works/pi-coding-agent";
import { type CompanionTurnSink, type DeliveryDisposition } from "./event-pump.js";

/**
 * A deliberately thin ordinary-turn adapter. It passes source-labelled batches
 * unchanged to Pi; it is not a planner and does not synthesize world facts.
 */
export function createAgentTurnSink(session: Pick<AgentSession, "sendUserMessage">): CompanionTurnSink {
  return Object.freeze({
    async deliver(text: string, disposition: Exclude<DeliveryDisposition, "hold">): Promise<void> {
      const batch: unknown = JSON.parse(text);
      if (
        typeof batch !== "object" ||
        batch === null ||
        (batch as { kind?: unknown }).kind !== "gamebuddy_fact_batch" ||
        !isDeliveryDisposition((batch as { disposition?: unknown }).disposition) ||
        (batch as { disposition: DeliveryDisposition }).disposition !== disposition
      )
        throw new Error("invalid_agent_fact_batch");
      await session.sendUserMessage(text, { deliverAs: disposition === "steer" ? "steer" : "followUp" });
    },
  });
}

function isDeliveryDisposition(value: unknown): value is Exclude<DeliveryDisposition, "hold"> {
  return value === "steer" || value === "follow_up";
}
