import { type AsrProvider, type SpeechJob, type TtsProvider } from "./gateway.js";

export type TtsAsrLoopResult = Readonly<{
  pcm16Bytes: number;
  transcript: string;
  ttsProviderId: string;
  ttsModelRevision: string;
  asrProviderId: string;
  asrModelRevision: string;
}>;

/**
 * Explicit diagnostic loop for a configured TTS provider and a configured ASR
 * provider. It proves PCM16 adapter compatibility only; it does not represent
 * microphone, VAD, echo, noise, or output-device validation.
 */
export async function runTtsAsrLoop(
  tts: TtsProvider,
  asr: AsrProvider,
  job: SpeechJob,
  signal: AbortSignal,
): Promise<TtsAsrLoopResult> {
  if (signal.aborted) throw new Error("tts_asr_loop_cancelled");

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of tts.synthesize(job, signal)) {
    if (signal.aborted) throw new Error("tts_asr_loop_cancelled");
    if (chunk.byteLength === 0 || chunk.byteLength % 2 !== 0) throw new Error("tts_asr_invalid_pcm16");
    total += chunk.byteLength;
    if (total > 1_920_000) throw new Error("tts_asr_audio_limit_exceeded");
    chunks.push(chunk.slice());
  }
  if (total === 0) throw new Error("tts_asr_no_audio");

  const pcm16 = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    pcm16.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const transcript = await asr.transcribe(pcm16, job.locale, signal);
  if (signal.aborted) throw new Error("tts_asr_loop_cancelled");
  if (transcript.trim().length === 0) throw new Error("tts_asr_empty_transcript");

  return Object.freeze({
    pcm16Bytes: total,
    transcript,
    ttsProviderId: tts.providerId,
    ttsModelRevision: tts.modelRevision,
    asrProviderId: asr.providerId,
    asrModelRevision: asr.modelRevision,
  });
}
