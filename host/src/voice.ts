import { randomUUID } from "node:crypto";

/** Product boundary between the Companion Host and the independent Voice Gateway. */
export type FinalVoiceInput = Readonly<{ sessionId: string; inputId: string; text: string; locale: string; providerId: string; modelRevision: string; timestampMs: number; actualFormat: Readonly<{ sampleRate: number; channels: number; encoding: "pcm_s16le" }> }>;
export type VoiceExpression = Readonly<{ expressionId: string; sessionId: string; sourceEventId: string; text: string; locale: string; voiceProfile: string; epoch: number; expiresAtMs: number }>;
export interface PlayerTextInputSink { receive(input: FinalVoiceInput): Promise<void> | void; }
export interface VisibleTextSink { show(expression: VoiceExpression): Promise<void> | void; }
export interface VoiceSpeechPort { enqueue(expression: VoiceExpression): Promise<void> | void; }

/**
 * Partials are intentionally absent: only a caller holding a verified final ASR
 * event may invoke this. It preserves provider metadata and never sees PCM.
 */
export async function deliverFinalVoiceInput(sink: PlayerTextInputSink, input: FinalVoiceInput): Promise<void> { await sink.receive(Object.freeze({ ...input })); }

/** Text is committed to a visible path before speech is attempted; failures never retract text. */
export async function expressTextFirst(visible: VisibleTextSink, speech: VoiceSpeechPort | undefined, input: Omit<VoiceExpression, "expressionId">): Promise<VoiceExpression> {
  const expression = Object.freeze({ ...input, expressionId: randomUUID() });
  await visible.show(expression);
  try { await speech?.enqueue(expression); } catch { /* text remains the fallback */ }
  return expression;
}
