import { type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Legacy observation hook retained for trace consumers. It deliberately does
 * not project ordinary Pi output to a player surface; only explicit
 * presentation tools may do that.
 */
export function attachCompanionExpression(
  session: Pick<AgentSession, "subscribe">,
  _sinks: unknown,
): () => void {
  return session.subscribe((_event: AgentSessionEvent) => undefined);
}

/** Extract only completed assistant text blocks; thinking and tool calls stay private. */
export function finalAssistantText(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content) || message.stopReason === "error" || message.stopReason === "aborted") continue;
    const text = message.content
      .filter(isTextBlock)
      .map((block) => block.text)
      .join("")
      .trim();
    return text.length === 0 ? null : text;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}
