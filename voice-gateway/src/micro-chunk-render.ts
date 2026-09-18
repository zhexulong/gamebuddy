/**
 * Phase 2 Slice 2b — micro-chunk render sink with pop-free fade-out
 *
 * Converts a full utterance PCM16 buffer into 20ms micro-chunks so a
 * CancelSpeech can interrupt within one micro-chunk instead of discarding a
 * whole buffer (the WinMM whole-buffer path this replaces). On stop, the sink
 * applies a raised-cosine fade in FADE_MS (5ms) and pads SILENCE_MS (10ms) of
 * silence before silencing the hardware, eliminating step-function pops.
 *
 * Pure and synchronous: the caller owns the clock and the device. It is
 * voice-local and never touches Chat or Game state.
 *
 * w(n) = 0.5 * (1 + cos(π * n / N)) for 0 <= n < N, where N = FADE_MS worth of
 * samples. w(0)=1 keeps the first faded sample equal to the original (no
 * leading discontinuity) and w(N-1)≈0 reaches silence smoothly.
 */
export const MICRO_CHUNK_MS = 20;
export const FADE_MS = 5;
export const SILENCE_MS = 10;
export const DEFAULT_SAMPLE_RATE = 16_000;

export type PcmSink = (pcm16: Uint8Array) => void | Promise<void>;

function clamp16(value: number): number {
  if (value < -32768) return -32768;
  if (value > 32767) return 32767;
  return Math.round(value);
}

export class MicroChunkRenderSink {
  readonly #sampleRate: number;
  readonly #play: PcmSink;
  readonly #microChunkSamples: number;
  readonly #fadeSamples: number;
  readonly #silenceSamples: number;
  readonly #fadeWindow: readonly number[];
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  #lastSounded: Uint8Array<ArrayBufferLike> | undefined;
  #stopped = false;

  public constructor(play: PcmSink, sampleRate = DEFAULT_SAMPLE_RATE) {
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 48_000)
      throw new Error("invalid_render_sample_rate");
    this.#sampleRate = sampleRate;
    this.#play = play;
    this.#microChunkSamples = Math.round((sampleRate * MICRO_CHUNK_MS) / 1_000);
    this.#fadeSamples = Math.max(4, Math.round((sampleRate * FADE_MS) / 1_000));
    this.#silenceSamples = Math.round((sampleRate * SILENCE_MS) / 1_000);
    this.#fadeWindow = buildRaisedCosineWindow(this.#fadeSamples);
  }

  public get sampleRate(): number {
    return this.#sampleRate;
  }
  public get microChunkSamples(): number {
    return this.#microChunkSamples;
  }
  public get stopped(): boolean {
    return this.#stopped;
  }

  /** Feed a complete PCM16 utterance; emits 20ms micro-chunks in order. */
  public async play(pcm16: Uint8Array): Promise<void> {
    if (pcm16.byteLength % 2 !== 0) throw new Error("invalid_pcm16_chunk");
    if (this.#stopped) return;
    this.#buffer = concat(this.#buffer, pcm16);
    while (this.#buffer.byteLength >= this.#microChunkSamples * 2) {
      const microChunk = this.#buffer.subarray(0, this.#microChunkSamples * 2);
      this.#buffer = this.#buffer.subarray(this.#microChunkSamples * 2);
      this.#lastSounded = microChunk;
      await this.#play(ensureOwn(microChunk));
    }
  }

  /**
   * Immediately fade the remaining buffered audio to silence, pad silence, and
   * release the tail. If the buffer is already drained (all audio was emitted as
   * full micro-chunks), the tail of the last sounded chunk is faded instead so
   * the device never hears a hard step into the silence pad. Subsequent play()
   * calls are ignored until reset().
   */
  public async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const tailSource =
      this.#buffer.byteLength > 0
        ? this.#buffer
        : this.#lastSounded === undefined
          ? new Uint8Array(0)
          : this.#lastSounded;
    await this.#play(applyFade(tailSource, this.#fadeWindow, this.#fadeSamples));
    await this.#play(new Uint8Array(this.#silenceSamples * 2));
    this.#buffer = new Uint8Array(0);
    this.#lastSounded = undefined;
  }

  /** Re-arm after a stop so a later utterance can play again. */
  public reset(): void {
    this.#buffer = new Uint8Array(0);
    this.#lastSounded = undefined;
    this.#stopped = false;
  }
}

function buildRaisedCosineWindow(fadeSamples: number): readonly number[] {
  const window: number[] = [];
  for (let n = 0; n < fadeSamples; n += 1) {
    window.push(0.5 * (1 + Math.cos((Math.PI * n) / fadeSamples)));
  }
  return window;
}

/**
 * Apply the raised-cosine fade to the tail of `pcm16` (up to fadeSamples worth
 * of trailing samples); samples before the fade pass through unchanged. The
 * fade ends at true silence, so the caller's silence pad has no discontinuity.
 */
export function applyFade(pcm16: Uint8Array, fadeWindow: readonly number[], fadeSamples: number): Uint8Array {
  if (fadeWindow.length !== fadeSamples || fadeSamples < 1) throw new Error("invalid_fade_window");
  if (pcm16.byteLength % 2 !== 0) throw new Error("invalid_pcm16_chunk");
  const samples = pcm16.byteLength / 2;
  const input = new Int16Array(pcm16.buffer, pcm16.byteOffset, samples);
  const faded = new Uint8Array(pcm16.byteLength);
  const output = new Int16Array(faded.buffer, 0, samples);
  const applyFrom = Math.max(0, samples - fadeSamples);
  for (let index = 0; index < applyFrom; index += 1) output[index] = input[index]!;
  for (let index = applyFrom; index < samples; index += 1) {
    const weight = fadeWindow[index - applyFrom]!;
    output[index] = clamp16(input[index]! * weight);
  }
  return faded;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBufferLike> {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function ensureOwn(chunk: Uint8Array): Uint8Array {
  return Uint8Array.from(chunk);
}