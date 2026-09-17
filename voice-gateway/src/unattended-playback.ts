/**
 * Collaborative unattended-test playback helpers, modeled after the reference
 * repos' fake-I/O pattern (livekit fake_io.py, pipecat tests/utils.py):
 *
 *  - A `RecordingMixer` collects every play() call into one contiguous PCM
 *    buffer plus a per-call journal, with an injected virtual clock so
 *    ordering/duration assertions are deterministic and no device is opened.
 *  - Waveform assertions (`maxSampleJump`, `silenceRatio`, `raisedCosineTail`)
 *    detect pops, missing fade and truncated tails without a human listener.
 *
 * These live in the app package (not under tests/) because the live-gate
 * rehearsal script needs the same recording/assertion surface; they are
 * deliberately dependency-free and never touch Windows audio.
 */
import { DEFAULT_SAMPLE_RATE } from "./synth-audio.js";

export type RecordedPlay = Readonly<{
  jobId: string;
  epoch: number;
  pcm16: Uint8Array;
  atMs: number;
  seq: number;
}>;

/** In-memory Mixer stand-in (see gateway.ts Mixer). */
export class RecordingMixer {
  #nowMs: number;
  #seq = 0;
  readonly plays: RecordedPlay[] = [];
  stopped = false;
  stoppedAtMs: number | undefined;

  public constructor(nowMs = 0) {
    this.#nowMs = nowMs;
  }

  public setClockMs(nowMs: number): void {
    this.#nowMs = nowMs;
  }
  public async play(jobId: string, epoch: number, pcm16: Uint8Array): Promise<void> {
    this.plays.push(Object.freeze({ jobId, epoch, pcm16: Uint8Array.from(pcm16), atMs: this.#nowMs, seq: this.#seq++ }));
  }
  public stop(): void {
    this.stopped = true;
    this.stoppedAtMs = this.#nowMs;
  }

  /** Concatenated PCM payload of every play() call, in issuance order. */
  public get pcm(): Uint8Array {
    const total = this.plays.reduce((sum, play) => sum + play.pcm16.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const play of this.plays) {
      merged.set(play.pcm16, offset);
      offset += play.pcm16.byteLength;
    }
    return merged;
  }
  public get durationSeconds(): number {
    return this.pcm.byteLength / 2 / DEFAULT_SAMPLE_RATE;
  }
}

/** Mutable Int16Array view over a PCM16 buffer (writes reflect into the buffer). */
export function int16Samples(pcm16: Uint8Array): Int16Array {
  return new Int16Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength / 2);
}

/** Largest absolute jump between consecutive samples (step/pop detector). */
export function maxSampleJump(pcm16: Uint8Array): number {
  const samples = int16Samples(pcm16);
  let max = 0;
  for (let index = 1; index < samples.length; index += 1) {
    max = Math.max(max, Math.abs(samples[index]! - samples[index - 1]!));
  }
  return max;
}

/** Fraction of samples inside the last `windowSeconds` whose |value| <= threshold. */
export function trailingSilenceRatio(
  pcm16: Uint8Array,
  windowSeconds: number,
  threshold = 64,
  sampleRate = DEFAULT_SAMPLE_RATE,
): number {
  const samples = int16Samples(pcm16);
  const windowSamples = Math.min(samples.length, Math.round(windowSeconds * sampleRate));
  if (windowSamples <= 0) return 1;
  let silent = 0;
  for (let index = samples.length - windowSamples; index < samples.length; index += 1) {
    if (Math.abs(samples[index]!) <= threshold) silent += 1;
  }
  return silent / windowSamples;
}

/**
 * True when the final `fadeSeconds` of the buffer follow a raised-cosine
 * window: each faded sample is within `tolerance` of `original * w(n)` and the
 * window end is below `endThreshold`. Pass `source` to know the pre-fade
 * original; otherwise the window is checked against the buffer's own start.
 */
export function hasRaisedCosineTail(
  output: Uint8Array,
  source: Uint8Array,
  fadeSeconds: number,
  tolerance = 32,
  endThreshold = 256,
  sampleRate = DEFAULT_SAMPLE_RATE,
): boolean {
  const out = int16Samples(output);
  const src = int16Samples(source);
  if (out.length !== src.length) return false;
  const fadeSamples = Math.min(out.length, Math.max(1, Math.round(fadeSeconds * sampleRate)));
  const start = out.length - fadeSamples;
  for (let index = start; index < out.length; index += 1) {
    const n = index - start;
    const weight = 0.5 * (1 + Math.cos((Math.PI * n) / fadeSamples));
    const expected = src[index]! * weight;
    if (Math.abs(out[index]! - expected) > tolerance) return false;
    if (index === out.length - 1 && Math.abs(out[index]!) > endThreshold) return false;
  }
  return true;
}