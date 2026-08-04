import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type VoiceExpression, type VoiceSpeechPort } from "./voice.js";

export type PresentationProfile = Readonly<{
  locale: string;
  text: boolean;
  speech: Readonly<{
    voiceProfile: string;
    perUtteranceDirection: boolean;
  }> | null;
}>;

export type CompanionTextExpression = Readonly<{
  expressionId: string;
  sessionId: string;
  sourceEventId: string;
  text: string;
  locale: string;
}>;

export interface CompanionTextPort {
  present(expression: CompanionTextExpression): Promise<void> | void;
}

export type PresentationRuntime = Readonly<{
  profile: PresentationProfile;
  /** The verified player-facing surface; it changes tool guidance, not authority. */
  surface?: "chat" | "game";
  sessionId: string;
  textPort?: CompanionTextPort;
  speechPort?: VoiceSpeechPort;
}>;

const MAX_PLAYER_LINE_LENGTH = 4_000;
const MAX_DIRECTION_LENGTH = 1_000;
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
      description: speechProfile.perUtteranceDirection
        ? "Speak a natural player-facing line. Optional direction is a short provider-neutral performance instruction, not provider syntax. Do not include internal Agent or tool language."
        : "Speak a natural player-facing line. Do not include provider directions or internal Agent language.",
      parameters: speechProfile.perUtteranceDirection
        ? Type.Object({ line: Type.String({ minLength: 1, maxLength: MAX_PLAYER_LINE_LENGTH }), direction: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_DIRECTION_LENGTH })) })
        : Type.Object({ line: Type.String({ minLength: 1, maxLength: MAX_PLAYER_LINE_LENGTH }) }),
      execute: async (toolCallId, params) => {
        const line = validatePlayerLine(params.line);
        const rawDirection = speechProfile.perUtteranceDirection && "direction" in params && typeof params.direction === "string" ? params.direction : undefined;
        const direction = rawDirection === undefined ? undefined : validateDirection(rawDirection);
        const expression: VoiceExpression = Object.freeze({
          expressionId: randomUUID(), sessionId: runtime.sessionId, sourceEventId: toolCallId, text: line,
          locale: runtime.profile.locale, voiceProfile: speechProfile.voiceProfile, epoch: 0, expiresAtMs: Date.now() + 20_000,
          ...(direction === undefined ? {} : { direction }),
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

function validateDirection(value: string): string {
  const direction = value.trim();
  if (direction.length === 0 || direction.length > MAX_DIRECTION_LENGTH || MECHANISM_LANGUAGE.test(direction)) throw new Error("invalid_speech_direction");
  return direction;
}

function presentationResult(expressionId: string, surface: "text" | "speech") {
  return { content: [{ type: "text" as const, text: JSON.stringify({ accepted: true, expressionId, surface }) }], details: { accepted: true, expressionId, surface } };
}
