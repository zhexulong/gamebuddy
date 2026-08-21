import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CompanionSpeechPort, CompanionTextExpression, CompanionTextPort, PresentationProfile, PresentationRuntime } from "./presentation-types.js";
type VoiceExpression = Parameters<CompanionSpeechPort["enqueue"]>[0];
export type { CompanionTextExpression, CompanionTextPort, PresentationProfile, PresentationRuntime } from "./presentation-types.js";

const MAX_PLAYER_LINE_LENGTH = 4_000;
const MECHANISM_LANGUAGE = /(?:subagent|tool(?:\s+call|\s+result)?|receipt|capability|execution[_ ]?id|schema|provider|json|internal|system prompt|game action)/i;

export function createCompanionPresentationTools(runtime: PresentationRuntime): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (runtime.profile.text && runtime.textPort !== undefined) {
    tools.push(defineTool({
      name: "companion_text",
      label: runtime.surface === "chat" ? "Chat Message" : "Game Text",
      description: runtime.surface === "chat"
        ? "Invoke this tool exactly once to deliver every player-visible chat reply. Put only the natural reply in text; never narrate or describe this tool in ordinary assistant output."
        : "Show a short natural line through the verified game's text or speech-bubble surface. Do not include internal Agent or tool language.",
      parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: MAX_PLAYER_LINE_LENGTH }) }),
      execute: async (toolCallId, params) => {
        const text = validatePlayerLine(params.text);
        const expression: CompanionTextExpression = Object.freeze({ expressionId: randomUUID(), sessionId: runtime.sessionId, sourceEventId: toolCallId, text, locale: runtime.profile.locale });
        await runtime.textPort!.present(expression);
        return presentationResult(expression.expressionId, "text");
      },
    }));
  }
  if (runtime.profile.speech !== null && runtime.speechPort !== undefined) {
    const speechProfile = runtime.profile.speech;
    tools.push(defineTool({
      name: "companion_speak",
      label: "Companion Speech",
      description: "Speak a natural player-facing line. Do not include provider directions or internal Agent language.",
      parameters: Type.Object({ line: Type.String({ minLength: 1, maxLength: MAX_PLAYER_LINE_LENGTH }) }),
      execute: async (toolCallId, params) => {
        const line = validatePlayerLine(params.line);
        const expression: VoiceExpression = Object.freeze({
          expressionId: randomUUID(), sessionId: runtime.sessionId, sourceEventId: toolCallId, text: line,
          locale: runtime.profile.locale, voiceProfile: speechProfile.voiceProfile, epoch: 0, expiresAtMs: Date.now() + 20_000,
        });
        await runtime.speechPort!.enqueue(expression);
        return presentationResult(expression.expressionId, "speech");
      },
    }));
  }
  return tools;
}

function validatePlayerLine(value: string): string {
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_PLAYER_LINE_LENGTH || MECHANISM_LANGUAGE.test(text)) throw new Error("invalid_player_expression");
  return text;
}

function presentationResult(expressionId: string, surface: "text" | "speech") {
  return { content: [{ type: "text" as const, text: JSON.stringify({ accepted: true, expressionId, surface }) }], details: { accepted: true, expressionId, surface } };
}
