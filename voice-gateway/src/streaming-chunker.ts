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
/** MiMo emotion/direction tags are short, punctuation-free tokens; longer parenthesised spans are action beats. */
export const MAX_TAG_LENGTH = 12;

export type SentenceChunk = Readonly<{ text: string; complete: boolean }>;

const FENCE_OPEN_RE = /^\s*(?:```|~~~)\s*$/;
const SYMBOL_NOISE_RE = /^[\s`~*_\-=+|<>#\[\](){}.:;"'…—•·]*$/;

export class StreamingSentenceChunker {
  #buffer = "";
  #segmenter: Intl.Segmenter;
  #firstPushMs: number | undefined;
  #fenceActive = false;
  #actionBeatActive = false;
  #boldActive = false;

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
    this.#actionBeatActive = false;
    this.#boldActive = false;
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
    // Character-card action beats (*...*) are stage direction, not speech:
    // strip them exactly like fenced regions so a beat boundary can never
    // form a sentence edge either. **emphasis** survives (it is spoken
    // content, not a beat) exactly like extractSpeakableText.
    this.#buffer = this.#stripActionBeats(this.#buffer);
    // Parenthesised spans: short MiMo tags survive, sentence-like action
    // beats are stripped (same rule as extractSpeakableText, streamed).
    this.#buffer = this.#stripParenBeats(this.#buffer);
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

  /**
   * Streaming action-beat stripper, the stream analogue of
   * `extractSpeakableText` in speakable-text.ts. A single `*` toggles a
   * `*...*` stage-direction beat (dropped); a `**` pair toggles emphasis
   * (kept as spoken content, asterisks removed). State persists across
   * `push` calls so a beat/emphasis boundary split by a delta boundary is
   * still handled: the buffered text holds only what survived the previous
   * strip, and the mode flags say whether the next fragment continues inside
   * a beat or emphasis.
   */
  #stripActionBeats(text: string): string {
    if (!text.includes("*")) return text;
    const out: string[] = [];
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "*") {
        const double = text[i + 1] === "*";
        if (double) {
          // **emphasis**: spoken content, drop only the asterisks.
          this.#boldActive = !this.#boldActive;
          i += 2;
          continue;
        }
        if (this.#boldActive) {
          // A single asterisk inside emphasis is emphasis content.
          out.push(ch);
          i += 1;
          continue;
        }
        // Single asterisk toggles the action beat.
        this.#actionBeatActive = !this.#actionBeatActive;
        i += 1;
        continue;
      }
      if (!this.#actionBeatActive) out.push(ch);
      i += 1;
    }
    return out.join("");
  }

  /**
   * Parenthesised-span stripper (matches extractSpeakableText): a short
   * punctuation-free inner text is a MiMo emotion/direction tag and survives
   * for the TTS; a sentence-like inner text is a stage-direction action beat
   * and is dropped. Unclosed spans stay in the buffer (the chunker re-scans
   * the whole buffer every push), so a beat split across deltas is handled
   * without cross-call state.
   */
  #stripParenBeats(text: string): string {
    if (!text.includes("(") && !text.includes("（")) return text;
    const out: string[] = [];
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "(" || ch === "（") {
        const closer = ch === "(" ? ")" : "）";
        const end = text.indexOf(closer, i + 1);
        if (end < 0) {
          // Unclosed: keep the whole span buffered for the next push.
          out.push(text.slice(i));
          break;
        }
        const inner = text.slice(i + 1, end).trim();
        const keep = inner.length > 0 && inner.length <= MAX_TAG_LENGTH && !/[\p{P}\p{S}]/u.test(inner);
        out.push(keep ? text.slice(i, end + 1) : " ");
        i = end + 1;
        continue;
      }
      out.push(ch);
      i += 1;
    }
    return out.join("");
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