/**
 * Companion speech chunking: turns one final, already-dehydrated assistant
 * reply into deterministic, semantically complete short chunks matching
 * Stardew's short dialogue rhythm.
 *
 * Pure and bounded: a single forward scan, no LLM, no randomness, and no regex
 * — nothing here can run longer than O(n) over the input.
 *
 * Contract:
 * - Split at sentence boundaries `。!?` (half/full width) and at newlines.
 * - A chunk never exceeds `maxChunkSentences` sentence units (default 2).
 * - A boundary ends a unit only while quote/bracket balance is closed, so a
 *   quoted or parenthesised sentence (e.g. "好的。") is never split mid-speech;
 *   a closing quote/bracket immediately after a separator stays with it.
 * - Text is never split mid-sentence to satisfy the budget: a long sentence
 *   with no usable boundary is emitted whole as its own chunk.
 * - Newlines are hard breaks: each line closes its own chunk wave.
 * - Empty and whitespace-only input yields `[]`.
 */

const DEFAULT_MAX_CHUNK_SENTENCES = 2;

/** Sentence boundaries: full-width full stop plus half/full-width `!` and `?`. */
const SENTENCE_SEPARATORS: ReadonlySet<string> = new Set(["\u3002", "!", "\uff01", "?", "\uff1f"]);

/** Whitespace runs are collapsed to one single space. */
const WHITESPACE: ReadonlySet<string> = new Set([
  " ",
  "\t",
  "\n",
  "\r",
  "\f",
  "\v",
  "\u00a0",
  "\u3000",
  "\u2028",
  "\u2029",
  "\ufeff",
]);

/** Curly double quotes state their side: left opens, right closes. */
const DOUBLE_CURLY_OPEN: ReadonlySet<string> = new Set(["\u201c"]);
const DOUBLE_CURLY_CLOSE: ReadonlySet<string> = new Set(["\u201d"]);
/** Straight and full-width double quotes are direction-ambiguous: they toggle. */
const DOUBLE_TOGGLE: ReadonlySet<string> = new Set(['"', "\uff02"]);

const SINGLE_CURLY_OPEN: ReadonlySet<string> = new Set(["\u2018"]);
const SINGLE_CURLY_CLOSE: ReadonlySet<string> = new Set(["\u2019"]);
const SINGLE_TOGGLE: ReadonlySet<string> = new Set(["'", "\uff07"]);

/** Bracket families: `()（）、「」、『』` — an opening without its close blocks splits. */
const BRACKET_OPEN: ReadonlySet<string> = new Set(["(", "\uff08", "\u300c", "\u300e"]);
const BRACKET_CLOSE: ReadonlySet<string> = new Set([")", "\uff09", "\u300d", "\u300f"]);

/**
 * Chunks `text` at sentence boundaries so every returned chunk is semantically
 * complete and carries at most `maxChunkSentences` sentences (default 2).
 * Usually one call to a speech sink receives exactly one chunk.
 */
export function chunkCompanionSpeech(text: string, maxChunkSentences?: number): readonly string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const limit =
    typeof maxChunkSentences === "number" && maxChunkSentences >= 1 && Number.isFinite(maxChunkSentences)
      ? Math.floor(maxChunkSentences)
      : DEFAULT_MAX_CHUNK_SENTENCES;

  let pending = "";
  let pendingEndsInSpace = false;
  const units: string[] = [];
  // gaps[k] is true when the original text had whitespace between units[k] and
  // units[k + 1]; the spacing is preserved inside the joined chunk.
  const gaps: boolean[] = [];
  const chunks: string[] = [];
  let doubleBalance = 0;
  let singleBalance = 0;
  let bracketBalance = 0;

  const balanced = (): boolean => doubleBalance === 0 && singleBalance === 0 && bracketBalance === 0;

  const trimmedPending = (): string => (pendingEndsInSpace && pending.length > 0 ? pending.slice(0, -1) : pending);

  const pushUnit = (unit: string): void => {
    if (unit.length === 0) return;
    units.push(unit);
  };

  const flushChunk = (): void => {
    if (units.length === 0) return;
    let joined = units[0] ?? "";
    for (let k = 0; k < units.length - 1; k += 1) {
      const next = units[k + 1];
      if (next === undefined) break;
      joined += (gaps[k] === true ? " " : "") + next;
    }
    chunks.push(joined);
    units.length = 0;
    gaps.length = 0;
  };

  const appendChar = (ch: string): void => {
    if (WHITESPACE.has(ch)) {
      if (pending.length > 0) {
        if (!pendingEndsInSpace) {
          pending += " ";
          pendingEndsInSpace = true;
        }
      } else if (units.length > 0 && gaps[units.length - 1] !== true) {
        // Whitespace between two completed units survives as one gap so the
        // original separator spacing is preserved inside a chunk.
        gaps[units.length - 1] = true;
      }
      return;
    }
    pending += ch;
    pendingEndsInSpace = false;
  };

  const applyBalance = (ch: string): void => {
    if (DOUBLE_CURLY_OPEN.has(ch)) doubleBalance += 1;
    else if (DOUBLE_CURLY_CLOSE.has(ch)) doubleBalance = doubleBalance > 0 ? doubleBalance - 1 : 0;
    else if (DOUBLE_TOGGLE.has(ch)) doubleBalance = doubleBalance === 0 ? 1 : 0;
    else if (SINGLE_CURLY_OPEN.has(ch)) singleBalance += 1;
    else if (SINGLE_CURLY_CLOSE.has(ch)) singleBalance = singleBalance > 0 ? singleBalance - 1 : 0;
    else if (SINGLE_TOGGLE.has(ch)) singleBalance = singleBalance === 0 ? 1 : 0;
    else if (BRACKET_OPEN.has(ch)) bracketBalance += 1;
    else if (BRACKET_CLOSE.has(ch)) bracketBalance = bracketBalance > 0 ? bracketBalance - 1 : 0;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === undefined) break;

    // Newlines are boundaries — or spoken content inside an open construct.
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      i += 1;
      if (balanced()) {
        const unit = trimmedPending();
        if (unit.length > 0) pushUnit(unit);
        pending = "";
        pendingEndsInSpace = false;
        // A newline is a hard break: it always closes the current chunk wave.
        flushChunk();
      } else if (!pendingEndsInSpace) {
        // Collapse the newline to a single space inside the quote/bracket.
        pending += " ";
        pendingEndsInSpace = true;
      }
      continue;
    }

    if (SENTENCE_SEPARATORS.has(ch)) {
      if (balanced()) {
        // The separator completes one sentence unit at a closed boundary.
        pushUnit(trimmedPending() + ch);
        pending = "";
        pendingEndsInSpace = false;
        i += 1;
        if (units.length >= limit) flushChunk();
        continue;
      }
      // The separator sits inside an open quote/bracket. Only closing quote or
      // bracket characters immediately after it can complete the unit — that
      // keeps "好的。" whole while still blocking a split under an open quote.
      let afterDouble = doubleBalance;
      let afterSingle = singleBalance;
      let afterBracket = bracketBalance;
      let closes = "";
      let j = i + 1;
      while (j < text.length) {
        const next = text[j];
        if (next === undefined) break;
        if (DOUBLE_CURLY_CLOSE.has(next) && afterDouble > 0) {
          afterDouble -= 1;
          closes += next;
          j += 1;
        } else if (DOUBLE_TOGGLE.has(next) && afterDouble === 1) {
          afterDouble = 0;
          closes += next;
          j += 1;
        } else if (SINGLE_CURLY_CLOSE.has(next) && afterSingle > 0) {
          afterSingle -= 1;
          closes += next;
          j += 1;
        } else if (SINGLE_TOGGLE.has(next) && afterSingle === 1) {
          afterSingle = 0;
          closes += next;
          j += 1;
        } else if (BRACKET_CLOSE.has(next) && afterBracket > 0) {
          afterBracket -= 1;
          closes += next;
          j += 1;
        } else {
          break;
        }
      }
      if (afterDouble === 0 && afterSingle === 0 && afterBracket === 0 && closes.length > 0) {
        // The separator plus its inline closing quote/bracket ends the unit.
        pushUnit(trimmedPending() + ch + closes);
        doubleBalance = 0;
        singleBalance = 0;
        bracketBalance = 0;
        pending = "";
        pendingEndsInSpace = false;
        i = j;
        if (units.length >= limit) flushChunk();
        continue;
      }
      // Keep the separator (and any closers it swallowed) inside the open
      // construct; the simulated balances above now match the buffered text.
      pending += ch + closes;
      pendingEndsInSpace = false;
      doubleBalance = afterDouble;
      singleBalance = afterSingle;
      bracketBalance = afterBracket;
      i = j;
      continue;
    }

    applyBalance(ch);
    appendChar(ch);
    i += 1;
  }

  const tail = trimmedPending();
  if (tail.length > 0) pushUnit(tail);
  flushChunk();
  return chunks;
}