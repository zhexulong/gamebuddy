/** Product boundary between the Companion Host and the independent Voice Gateway. */
export type FinalVoiceInput = Readonly<{
  sessionId: string;
  inputId: string;
  text: string;
  locale: string;
  providerId: string;
  modelRevision: string;
  timestampMs: number;
  actualFormat: Readonly<{ sampleRate: number; channels: number; encoding: "pcm_s16le" }>;
}>;

export type VoiceExpression = Readonly<{
  expressionId: string;
  sessionId: string;
  sourceEventId: string;
  text: string;
  locale: string;
  voiceProfile: string;
  epoch: number;
  expiresAtMs: number;
  direction?: string;
}>;

export interface PlayerTextInputSink {
  receive(input: FinalVoiceInput): Promise<void> | void;
}

export type VoiceSpeechCapabilities = Readonly<{
  providerId: string;
  modelRevision: string;
  perUtteranceDirection: boolean;
  ready: boolean;
}>;

/** Opaque, immutable binding to the Voice Gateway's independently-owned audio epoch. */
export type VoiceAudioEpochBinding = object;

export interface VoiceAudioEpochAdmission {
  capture(): VoiceAudioEpochBinding;
  assertCurrent(binding: VoiceAudioEpochBinding): void;
  epoch(binding: VoiceAudioEpochBinding): number;
}

/**
 * The speech port must call both assertions immediately before its actual
 * gateway enqueue/commit. Host and audio epochs intentionally remain distinct.
 */
export type VoiceEnqueueAdmission = Readonly<{
  hostBinding: object;
  assertHostCurrent(binding: object): void;
  audioBinding: VoiceAudioEpochBinding;
  assertAudioCurrent(binding: VoiceAudioEpochBinding): void;
}>;

export interface VoiceSpeechPort {
  readonly capabilities?: VoiceSpeechCapabilities;
  enqueue(expression: VoiceExpression, admission: VoiceEnqueueAdmission): Promise<void> | void;
}

/**
 * Partials are intentionally absent: only a caller holding a verified final ASR
 * event may invoke this. It preserves provider metadata and never sees PCM.
 */
export async function deliverFinalVoiceInput(sink: PlayerTextInputSink, input: FinalVoiceInput): Promise<void> {
  await sink.receive(Object.freeze({ ...input }));
}
