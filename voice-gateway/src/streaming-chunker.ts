/**
 * Phase 2 Slice 2a — StreamingSentenceChunker
 *
 * Low-latency sentence chunking for the streaming speech pipeline. It is a
 * pure, synchronous in-memory accumulator: wall-clock time is injected by the
 * caller so every behavior is deterministic in tests. It never touches Chat or
 * Game state and owns no providers or queues.
 *
 * Emission policy (mirrors the frozen Slice 2 contract):
 *  - A complete sentence boundary (Intl.Segmenter, granularity "sentence")
 *    emits the sentence immediately — first-chunk latency is bounded by
 *    sentence arrival, not by the accumulation window.
 *  - If no boundary completes within ACCUMULATOR_MS, the buffered text emits
 *    as a partial sentence so playback is never starved (anti-swallow/deadlock
 *    guard): a pending tail is never discarded by waiting for a terminator.
 *  - A single unterminated sentence longer than MAX_CHUNK_LENGTH is hard-cut
 *    so one long clause cannot block the stream.
 *  - Markdown fenced code blocks and symbol-only noise are skipped: they are
 *    not speakable expressions.
 */
export const ACCUMULATOR_MS = 100;
export const MAX_CHUNK_LENGTH = 200;

export type SentenceChunk = Readonly<{ text: string; complete: boolean }>;

const FENCE_OPEN_RE = /^\s*(?:```|~~~)\s*$/;
const SYMBOL_NOISE_RE = /^[\s`~*_\-=+|<>#\[\](){}.:;"'…—•·]*$/;

export class StreamingSentenceChunker {
  #buffer = "";
  #segmenter: Intl.Segmenter;
  #firstPushMs: number | undefined;
  #fenceActive = false;

  public constructor(locale = "zh-CN") {
    this.#segmenter = new Intl.Segmenter(locale, { granularity: "sentence" });
  }

  public get bufferedLength(): number {
    return this.#buffer.length;
  }

  public reset(): void {
    this.#buffer = "";
    this.#firstPushMs = undefined;
    this.#fenceActive = false;
  }

  /**
   * Accumulate a text delta and return any speakable chunks that complete.
   * `nowMs` is the caller's clock; an empty return only means nothing is
   * speakable yet, never that text was discarded.
   */
  public push(text: string, nowMs: number): readonly SentenceChunk[] {
    if (text.length === 0) return [];
    this.#buffer += text;
    // Markdown fenced code is not speakable: strip fenced regions before any
    // segmentation so a fence boundary can never form a sentence edge.
    this.#buffer = this.#stripFenced(this.#buffer);
    if (this.#firstPushMs === undefined) this.#firstPushMs = nowMs;
    const chunks: SentenceChunk[] = [];

    // Drain every completed sentence first so punctuation never waits on the
    // accumulation window.
    let boundary = this.#firstBoundary(this.#buffer);
    while (boundary !== null) {
      const sentence = this.#buffer.slice(0, boundary);
      const candidate = sentence.trim();
      this.#buffer = this.#buffer.slice(boundary);
      if (isSpeakable(candidate)) chunks.push(Object.freeze({ text: candidate, complete: true }));
      boundary = this.#firstBoundary(this.#buffer);
      this.#firstPushMs = nowMs;
    }

    // Anti-swallow guard: an unterminated tail must not starve playback. Cut
    // repeatedly until the remaining buffer fits again.
    while (this.#buffer.length > MAX_CHUNK_LENGTH) {
      const hardCut = this.#buffer.slice(0, MAX_CHUNK_LENGTH);
      const candidate = hardCut.trim();
      this.#buffer = this.#buffer.slice(MAX_CHUNK_LENGTH);
      if (isSpeakable(candidate)) chunks.push(Object.freeze({ text: candidate, complete: false }));
      this.#firstPushMs = nowMs;
    }
    if (
      this.#firstPushMs !== undefined &&
      nowMs - this.#firstPushMs >= ACCUMULATOR_MS &&
      this.#buffer.trim().length > 0
    ) {
      const candidate = this.#buffer.trim();
      this.#buffer = "";
      this.#firstPushMs = undefined;
      if (isSpeakable(candidate)) chunks.push(Object.freeze({ text: candidate, complete: false }));
    }
    return chunks;
  }

  /** Emit any remaining buffered text as a final partial chunk. */
  public flush(): readonly SentenceChunk[] {
    const candidate = this.#buffer.trim();
    this.#buffer = "";
    this.#firstPushMs = undefined;
    return isSpeakable(candidate)
      ? [Object.freeze({ text: candidate, complete: false })]
      : [];
  }

  #stripFenced(text: string): string {
    if (!text.includes("`") && !text.includes("~")) return text;
    const kept: string[] = [];
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      const line = newline < 0 ? text.slice(start) : text.slice(start, newline);
      const isFence = FENCE_OPEN_RE.test(line);
      if (isFence && !this.#fenceActive) {
        // Opening fence: drop this line and everything until the closer.
        this.#fenceActive = true;
      } else if (isFence) {
        // Closing fence: drop the line; following text is speakable again.
        this.#fenceActive = false;
      } else if (!this.#fenceActive) {
        kept.push(line);
      }
      if (newline < 0) break;
      start = newline + 1;
    }
    return kept.join("\n");
  }

  #firstBoundary(text: string): number | null {
    for (const segment of this.#segmenter.segment(text)) {
      // A sentence segment is authoritative only when it ends in a terminator;
      // the terminator belongs to the emitted sentence, not the next one.
      const value = segment.segment;
      if (value.length > 0 && /(?:[。．.!?！？；;\n…]|["'”’」』）)]\s*)$/.test(value)) {
        return segment.index + value.length;
      }
    }
    return null;
  }
}

function isSpeakable(candidate: string): boolean {
  if (candidate.length === 0) return false;
  if (SYMBOL_NOISE_RE.test(candidate)) return false;
  return true;
}