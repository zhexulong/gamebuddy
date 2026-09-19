/** Product boundary between the Companion Host and the independent Voice Gateway. */
export type FinalVoiceInput = Readonly<{
  sessionId: string;
  /** Gateway-authenticated source event identity; distinct from input correlation. */
  sourceEventId: string;
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

type VoiceSpeechCapabilities = Readonly<{
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
 * Host-owned streaming speech sink for Chat presentations. It receives the
 * same delta stream as the browser preview, scoped to the exact Host-owned
 * turn, and forwards it to the Voice Gateway's v2 `stream_speech_chunk` lane.
 * The publisher never holds a client/token/epoch; the closure owns them, so
 * nothing escapes the Host boundary. The separate begin/final calls delimit
 * one exact speech job (one turn = one job); a host-side cancel must call
 * cancel() so the voice lane stops without touching Game actions.
 */
export interface ChatVoiceSpeechPublisher {
  begin(turnId: string): Promise<void> | void;
  /** Feed one incremental delta (NFC-normalized by the caller, like preview). */
  append(delta: string): Promise<void> | void;
  /** Terminal: flush the final text and settle the job (equivalent to isFinalChunk). */
  finalize(): Promise<void> | void;
  /** Interrupt the exact job; Voice-local only, never a Chat/Game mutation. */
  cancel(): Promise<void> | void;
}

/**
 * Partials are intentionally absent: only a caller holding a verified final ASR
 * event may invoke this. It preserves provider metadata and never sees PCM.
 */
export async function deliverFinalVoiceInput(sink: PlayerTextInputSink, input: FinalVoiceInput): Promise<void> {
  await sink.receive(Object.freeze({ ...input }));
}
