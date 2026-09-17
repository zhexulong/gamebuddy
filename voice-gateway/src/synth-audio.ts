/**
 * Deterministic synthesized PCM16 for unattended audio tests and live-gate
 * rehearsal. These generators never touch a microphone or speakers: they stand
 * in for a human voice (input fixture) or a TTS provider (output fixture) so
 * the pipeline can be validated without a person speaking.
 *
 * Formats: 16 kHz mono signed 16-bit little-endian PCM16 unless overridden.
 */
export const DEFAULT_SAMPLE_RATE = 16_000;

export type SynthOptions = Readonly<{
  sampleRate?: number;
  amplitude?: number; // peak int16, default 8000
}>;

/** Constant DC offset. Useful for asserting identity/round-trip, not acoustics. */
export function synthDcPcm16(seconds: number, options: SynthOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const amplitude = options.amplitude ?? 8_000;
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const pcm = new Uint8Array(samples * 2);
  const view = new Int16Array(pcm.buffer);
  view.fill(amplitude);
  return pcm;
}

/** Sine wave. 220Hz by default; a paused/held tone is a good "speaker voice" stand-in. */
export function synthSinePcm16(seconds: number, options: SynthOptions & { frequencyHz?: number } = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const amplitude = options.amplitude ?? 8_000;
  const frequencyHz = options.frequencyHz ?? 220;
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const pcm = new Uint8Array(samples * 2);
  const view = new Int16Array(pcm.buffer);
  for (let index = 0; index < samples; index += 1) {
    view[index] = Math.round(amplitude * Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate));
  }
  return pcm;
}

/** Absolute silence. */
export function synthSilencePcm16(seconds: number, options: SynthOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  return new Uint8Array(samples * 2);
}

/** Speech-like burst: several short syllables with silence gaps between them. */
export function synthSpeechLikePcm16(seconds: number, options: SynthOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const amplitude = options.amplitude ?? 8_000;
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const pcm = new Uint8Array(samples * 2);
  const view = new Int16Array(pcm.buffer);
  const syllableMs = 120;
  const gapMs = 60;
  const syllableSamples = Math.round((sampleRate * syllableMs) / 1_000);
  const gapSamples = Math.round((sampleRate * gapMs) / 1_000);
  let cursor = 0;
  let syllable = 0;
  while (cursor < samples) {
    const length = Math.min(syllableSamples, samples - cursor);
    const frequencyHz = 180 + (syllable % 3) * 40;
    for (let index = 0; index < length; index += 1) {
      const envelope = 0.5 - 0.5 * Math.cos((Math.PI * index) / length);
      view[cursor + index] = Math.round(amplitude * envelope * Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate));
    }
    cursor += length;
    if (cursor >= samples) break;
    const gapLength = Math.min(gapSamples, samples - cursor);
    cursor += gapLength;
    syllable += 1;
  }
  return pcm;
}