/**
 * Linear-interpolation PCM16 resampler.
 *
 * The wire/render contract is fixed at 16 kHz mono (REQUIRED_PCM_FORMAT), but
 * MiMo TTS emits 24 kHz PCM16LE mono natively. Resampling at the provider
 * boundary keeps every downstream consumer on the frozen format while the
 * provider stays free to stream its native rate. Pure and deterministic.
 */
export const PCM_TARGET_SAMPLE_RATE = 16_000;

/** Downsample 24 kHz -> 16 kHz (ratio 2/3) with linear interpolation. */
export function resamplePcm16To16k(pcm16: Uint8Array, fromSampleRate: number): Uint8Array {
  if (pcm16.byteLength === 0 || pcm16.byteLength % 2 !== 0) throw new Error("invalid_pcm16_audio");
  if (!Number.isSafeInteger(fromSampleRate) || fromSampleRate < 8_000) throw new Error("invalid_source_sample_rate");
  if (fromSampleRate === PCM_TARGET_SAMPLE_RATE) return Uint8Array.from(pcm16);
  const input = new Int16Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength / 2);
  const inputSeconds = input.length / fromSampleRate;
  const outputLength = Math.max(1, Math.round(inputSeconds * PCM_TARGET_SAMPLE_RATE));
  const output = new Uint8Array(outputLength * 2);
  const out = new Int16Array(output.buffer);
  const ratio = fromSampleRate / PCM_TARGET_SAMPLE_RATE;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    const sample = input[left]! * (1 - fraction) + input[right]! * fraction;
    out[index] = clamp16(Math.round(sample));
  }
  return output;
}

function clamp16(value: number): number {
  if (value < -32768) return -32768;
  if (value > 32767) return 32767;
  return value;
}