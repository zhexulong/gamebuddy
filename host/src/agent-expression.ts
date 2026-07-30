import { randomUUID } from "node:crypto";

import { type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { type VisibleTextSink, type VoiceSpeechPort, expressTextFirst } from "./voice.js";

export type CompanionExpressionSinks = Readonly<{
  visible: VisibleTextSink;
  speech?: VoiceSpeechPort;
  sessionId: string;
  locale?: string;
  voiceProfile?: string;
  /** Short voice jobs must not survive a stale output turn. */
  speechTtlMs?: number;
}>;

/**
 * Projects completed Pi assistant text to a presentation-only boundary. It
 * never turns model prose into a game fact, receipt, permission, or action.
 * Text is committed before optional speech by expressTextFirst.
 */
export function attachCompanionExpression(
  session: Pick<AgentSession, "subscribe">,
  sinks: CompanionExpressionSinks,
): () => void {
  const locale = sinks.locale ?? "zh-CN";
  const voiceProfile = sinks.voiceProfile ?? "companion.default";
  const speechTtlMs = sinks.speechTtlMs ?? 20_000;
  let epoch = 0;

  return session.subscribe((event: AgentSessionEvent) => {
    if (event.type !== "agent_end" || event.willRetry) return;
    const text = finalAssistantText(event.messages);
    if (text === null) return;
    const nowMs = Date.now();
    void expressTextFirst(sinks.visible, sinks.speech, {
      sessionId: sinks.sessionId,
      sourceEventId: randomUUID(),
      text,
      locale,
      voiceProfile,
      epoch: epoch++,
      expiresAtMs: nowMs + speechTtlMs,
    }).catch(() => undefined);
  });
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
