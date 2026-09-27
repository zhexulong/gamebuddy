/**
 * Incremental companion-speech accumulator: turns a character stream into
 * complete sentences, so a presenter can commit each finished sentence the
 * moment its final boundary arrives instead of waiting for the whole turn.
 *
 * Boundary rules mirror `chunkCompanionSpeech` (companion-speech-chunker):
 * sentence units close on `。` `!` `？` `?` (full/half width) or a newline,
 * but only while quote/brace family counts are balanced, so `"好的。"` stays
 * one unit and `他说:"好的,我去。"继续。"` is not cut mid-quote. A unit is
 * never forced open for budget reasons. Additionally, boundaries inside an
 * open model-scaffolding block (`<thinking>`/`<thought>` without its closer)
 * or inside an asterisk stage-beat are skipped, so mid-block or mid-beat bytes
 * are never emitted as if they were speakable dialogue.
 */
export class IncrementalSpeechAccumulator {
  #buffer = "";
  readonly #maxBytes: number;

  constructor(maxBytes = 16_384) {
    this.#maxBytes = maxBytes;
  }

  /**
   * Appends a stream chunk and returns every sentence completed by it, in
   * order. Incomplete trailing text stays buffered until a later chunk or
   * `flush()`.
   */
  push(chunk: string): string[] {
    if (chunk.length === 0) return [];
    this.#buffer += chunk;
    return this.#emitComplete();
  }

  /** Returns all remaining buffered text (may be incomplete) and clears it. */
  flush(): string {
    const remaining = this.#buffer;
    this.#buffer = "";
    return remaining;
  }

  get bufferedLength(): number {
    return this.#buffer.length;
  }

  #emitComplete(): string[] {
    const completed: string[] = [];
    // Scan left to right for a valid sentence end; move the cursor past each
    // completed unit so lookahead is bounded and O(n) overall. findSentenceEnd
    // itself tracks scaffold depth, so a boundary inside an open block is never
    // treated as a sentence end.
    const length = this.#buffer.length;
    let emitted = 0;
    while (emitted < length) {
      const end = findSentenceEnd(this.#buffer, emitted);
      if (end < 0) break;
      const unit = this.#buffer.slice(emitted, end + 1);
      emitted = end + 1;
      if (Buffer.byteLength(unit, "utf8") > this.#maxBytes) {
        // A pathological over-limit unit is still a unit; emit it whole rather
        // than re-cutting (the presenter's channel still enforces its own cap,
        // but we never silently drop speakable dialogue).
        completed.push(unit);
        continue;
      }
      completed.push(unit);
    }
    if (emitted > 0) this.#buffer = this.#buffer.slice(emitted);
    return completed;
  }
}

const THINK_OPEN = "<thinking>";
const THINK_CLOSE = "</thinking>";
const THOUGHT_OPEN = "<thought>";
const THOUGHT_CLOSE = "</thought>";

/**
 * Finds the next sentence end in `text` scanning from `start`. Skips any
 * boundary inside an open scaffold block (`<thinking>`/`<thought>` without its
 * closer) or inside an asterisk stage-beat (odd single-star count), and skips
 * boundaries inside unbalanced quote/brace families, so mid-block or mid-beat
 * bytes are never emitted as speakable sentences.
 */
function findSentenceEnd(text: string, start: number): number {
  let quote = 0; // +1 inside a quote, 0 outside (nested quotes not modeled)
  let pairs = new Array<number>(QUOTE_PAIRS.length).fill(0);
  let thinkingDepth = 0;
  let thoughtDepth = 0;
  let starOpen = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (text.startsWith(THINK_OPEN, index)) {
      thinkingDepth += 1;
      index += THINK_OPEN.length - 1;
      continue;
    }
    if (text.startsWith(THINK_CLOSE, index)) {
      if (thinkingDepth > 0) thinkingDepth -= 1;
      index += THINK_CLOSE.length - 1;
      continue;
    }
    if (text.startsWith(THOUGHT_OPEN, index)) {
      thoughtDepth += 1;
      index += THOUGHT_OPEN.length - 1;
      continue;
    }
    if (text.startsWith(THOUGHT_CLOSE, index)) {
      if (thoughtDepth > 0) thoughtDepth -= 1;
      index += THOUGHT_CLOSE.length - 1;
      continue;
    }
    if (char === "*") {
      // A doubled asterisk is markdown emphasis (stays); a single is a stage
      // beat opener/closer (stripped by dehydration). Only single stars gate.
      if (text[index + 1] !== "*") starOpen = !starOpen;
      else index += 1;
      continue;
    }
    if (LEFT_QUOTES.has(char) && RIGHT_QUOTES.has(char)) {
      // Ambiguous straight quote: close if already inside a quote, else open.
      // (Only one nesting level is modeled; nesting is not supported.)
      quote = quote > 0 ? 0 : 1;
      continue;
    }
    if (LEFT_QUOTES.has(char)) quote += 1;
    else if (RIGHT_QUOTES.has(char) && quote > 0) quote -= 1;
    for (let family = 0; family < QUOTE_PAIRS.length; family += 1) {
      const [open, close] = QUOTE_PAIRS[family]!;
      if (char === open) pairs[family]! += 1;
      else if (char === close && pairs[family]! > 0) pairs[family]! -= 1;
    }
    if (
      isSentenceBoundary(char) &&
      quote === 0 &&
      thinkingDepth === 0 &&
      thoughtDepth === 0 &&
      !starOpen &&
      pairs.every((count) => count === 0)
    )
      return index;
  }
  return -1;
}

const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["(", ")"],
  ["（", "）"],
  ["「", "」"],
  ["『", "』"],
]);

const LEFT_QUOTES = new Set(["“", "‘", '"', "'"]);
const RIGHT_QUOTES = new Set(["”", "’", '"', "'"]);

function isSentenceBoundary(char: string): boolean {
  return char === "。" || char === "!" || char === "？" || char === "?" || char === "\n" || char === "\r";
}