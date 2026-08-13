import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type VoiceAudioEpochAdmission,
  type VoiceAudioEpochBinding,
  type VoiceEnqueueAdmission,
  type VoiceExpression,
  type VoiceSpeechPort,
} from "./voice.js";

export type PresentationProfile = Readonly<{
  locale: string;
  text: boolean;
  speech: Readonly<{ voiceProfile: string }> | null;
}>;

export type CompanionTextExpression = Readonly<{
  expressionId: string;
  sessionId: string;
  sourceEventId: string;
  text: string;
  locale: string;
}>;

/** Opaque, immutable binding to the Host companion-interruption admission epoch. */
export type HostPresentationBinding = object;

export type PresentationCommitAdmission = Readonly<{
  hostBinding: HostPresentationBinding;
  assertHostCurrent(binding: HostPresentationBinding): void;
}>;

/**
 * Host-owned per-invocation authority. It derives both the originating event
 * and opaque interruption binding at tool execution time, never at runtime
 * construction or from model/browser input.
 */
export interface HostPresentationAdmissionProvider {
  capture(): Readonly<{ sourceEventId: string; admission: PresentationCommitAdmission }>;
}

export interface CompanionTextPort {
  /** Must reassert admission immediately before its actual surface commit. */
  present(expression: CompanionTextExpression, admission: PresentationCommitAdmission): Promise<void> | void;
}

export type PresentationRuntime = Readonly<{
  profile: PresentationProfile;
  surface?: "chat" | "game";
  sessionId: string;
  /** Absent Host-owned per-invocation authority disables presentation tools. */
  admissionProvider?: HostPresentationAdmissionProvider;
  textPort?: CompanionTextPort;
  speechPort?: VoiceSpeechPort;
  voiceAudioAdmission?: VoiceAudioEpochAdmission;
}>;

const MAX_PLAYER_LINE_LENGTH = 4_000;
const FORBIDDEN_ENVELOPE = /(?:\btool(?:[ _-]?(?:call|result|request))?\b\s*[:={[]|\b(?:receipt|execution)[ _-]?id\b\s*[:=]|\b(?:system|provider)[ _-]?(?:prompt|payload|request|response)\b\s*[:={[]|\b(?:function|tool)[ _-]?arguments\b\s*[:={[])/i;
const FORBIDDEN_NARRATION = /\b(?:i(?:'m| am)|will|going to)\s+(?:call|invoke|use|run)\s+(?:a\s+)?(?:tool|subagent|provider)\b/i;

export function createCompanionPresentationTools(runtime: PresentationRuntime): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (runtime.profile.text && runtime.textPort !== undefined && runtime.admissionProvider !== undefined) {
    tools.push(defineTool({
      name: "companion_text",
      label: runtime.surface === "chat" ? "Chat Message" : "Game Text",
      description: "Deliver a natural player-facing line only.",
      parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: MAX_PLAYER_LINE_LENGTH }) }),
      execute: async (_toolCallId, params) => {
        const text = validatePlayerLine(params.text);
        const captured = runtime.admissionProvider!.capture();
        captured.admission.assertHostCurrent(captured.admission.hostBinding);
        const expression: CompanionTextExpression = Object.freeze({
          expressionId: randomUUID(), sessionId: runtime.sessionId, sourceEventId: captured.sourceEventId, text, locale: runtime.profile.locale,
        });
        await runtime.textPort!.present(expression, captured.admission);
        return presentationResult(expression.expressionId, "text");
      },
    }));
  }
  if (runtime.profile.speech !== null && runtime.speechPort !== undefined && runtime.voiceAudioAdmission !== undefined && runtime.admissionProvider !== undefined) {
    const speechProfile = runtime.profile.speech;
    tools.push(defineTool({
      name: "companion_speak",
      label: "Companion Speech",
      description: "Speak a natural player-facing line only.",
      parameters: Type.Object({ line: Type.String({ minLength: 1, maxLength: MAX_PLAYER_LINE_LENGTH }) }),
      execute: async (_toolCallId, params) => {
        const line = validatePlayerLine(params.line);
        const captured = runtime.admissionProvider!.capture();
        const audioBinding = runtime.voiceAudioAdmission!.capture();
        captured.admission.assertHostCurrent(captured.admission.hostBinding);
        runtime.voiceAudioAdmission!.assertCurrent(audioBinding);
        const expression: VoiceExpression = Object.freeze({
          expressionId: randomUUID(), sessionId: runtime.sessionId, sourceEventId: captured.sourceEventId, text: line,
          locale: runtime.profile.locale, voiceProfile: speechProfile.voiceProfile,
          epoch: runtime.voiceAudioAdmission!.epoch(audioBinding), expiresAtMs: Date.now() + 20_000,
        });
        await runtime.speechPort!.enqueue(
          expression,
          voiceEnqueueAdmission(captured.admission, runtime.voiceAudioAdmission!, audioBinding),
        );
        return presentationResult(expression.expressionId, "speech");
      },
    }));
  }
  return tools;
}

function voiceEnqueueAdmission(
  hostAdmission: PresentationCommitAdmission,
  audioAdmission: VoiceAudioEpochAdmission,
  audioBinding: VoiceAudioEpochBinding,
): VoiceEnqueueAdmission {
  return Object.freeze({
    hostBinding: hostAdmission.hostBinding,
    assertHostCurrent: (binding) => hostAdmission.assertHostCurrent(binding),
    audioBinding,
    assertAudioCurrent: (binding) => audioAdmission.assertCurrent(binding),
  });
}

function validatePlayerLine(value: string): string {
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_PLAYER_LINE_LENGTH || FORBIDDEN_ENVELOPE.test(text) || FORBIDDEN_NARRATION.test(text)) {
    throw new Error("invalid_player_expression");
  }
  return text;
}

function presentationResult(expressionId: string, surface: "text" | "speech") {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ accepted: true, expressionId, surface }) }],
    details: { accepted: true, expressionId, surface },
  };
}
