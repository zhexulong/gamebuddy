import type { VoiceAudioEpochAdmission, VoiceSpeechPort } from "./voice.js";

export type PresentationProfile = Readonly<{
  locale: string;
  text: boolean;
  speech: Readonly<{ voiceProfile: string }> | null;
}>;

export type ChatCompanionTextExpression = Readonly<{
  surface: "chat";
  expressionId: string;
  sessionId: string;
  text: string;
  locale: string;
}>;

export type GameCompanionTextExpression = Readonly<{
  surface: "game";
  expressionId: string;
  sessionId: string;
  /** Game/native text is always bound to a source-owned event. */
  sourceEventId: string;
  text: string;
  locale: string;
}>;

export type CompanionTextExpression = ChatCompanionTextExpression | GameCompanionTextExpression;

/** Opaque, immutable binding to the Host companion-interruption admission epoch. */
export type HostPresentationBinding = object;

export type PresentationCommitAdmission = Readonly<{
  hostBinding: HostPresentationBinding;
  assertHostCurrent(binding: HostPresentationBinding): void;
}>;

export type ChatPresentationAdmissionCapture = Readonly<{
  surface: "chat";
  sourceEventId?: never;
  admission: PresentationCommitAdmission;
}>;

export type GamePresentationAdmissionCapture = Readonly<{
  surface: "game";
  sourceEventId: string;
  admission: PresentationCommitAdmission;
}>;

/**
 * Host-owned per-invocation authority. It derives the originating event and
 * opaque interruption binding at tool execution time, never at construction or
 * from model/browser input. The discriminant prevents a Chat capture from
 * entering a Game presentation port.
 */
export interface HostPresentationAdmissionProvider {
  capture(): ChatPresentationAdmissionCapture | GamePresentationAdmissionCapture;
}

export interface CompanionTextPort {
  /** Must reassert admission immediately before its actual surface commit. */
  present(expression: CompanionTextExpression, admission: PresentationCommitAdmission): Promise<void> | void;
}

export type PresentationRuntime = Readonly<{
  profile: PresentationProfile;
  surface: "chat" | "game";
  sessionId: string;
  /** Absent Host-owned per-invocation authority disables presentation tools. */
  admissionProvider?: HostPresentationAdmissionProvider;
  textPort?: CompanionTextPort;
  speechPort?: VoiceSpeechPort;
  voiceAudioAdmission?: VoiceAudioEpochAdmission;
}>;
