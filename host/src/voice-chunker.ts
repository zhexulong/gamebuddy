/**
 * Lightweight streaming sentence chunker for TTS voice synthesis.
 *
 * It splits continuous LLM streaming text tokens into discrete sentence chunks
 * based on pause punctuation (，。！？\n；, etc.) or a fallback length threshold (35 chars),
 * atomically grouping consecutive punctuations (……, ..., ！！！, etc.) without emitting
 * empty or orphan punctuation chunks.
 */

export const DEFAULT_MAX_CHUNK_LENGTH = 35;
export const DEFAULT_MIN_FIRST_CHUNK_LENGTH = 5;

export const DEFAULT_PAUSE_PUNCTUATIONS = Object.freeze(
  new Set([
    "，", "。", "！", "？", "；", "：", "、", "…", "—", "～",
    ",", ".", "!", "?", ";", ":", "~",
    "\n", "\r",
  ]),
);

export const DEFAULT_TRAILING_PUNCTUATIONS = Object.freeze(
  new Set([
    "”", "’", "\"", "'", "）", ")", "】", "]", "》", ">", "」", "』",
    "…", "—", "～", ".", "!", "?", "！", "？", ",", "，", "；", ";", "~", ":", "：",
  ]),
);

export type SentenceChunkerOptions = Readonly<{
  /** Maximum character length before forcing a chunk cut. Default: 35 */
  maxChunkLength?: number;
  /** Minimum character length for the first chunk before breaking on minor punctuation. Default: 5 */
  minFirstChunkLength?: number;
  /** Set of pause punctuation characters that trigger a sentence break */
  pausePunctuations?: ReadonlySet<string>;
  /** Set of characters that can trail after a pause punctuation and attach to the chunk */
  trailingPunctuations?: ReadonlySet<string>;
}>;

export interface SentenceChunker {
  /** Feed incoming token or text delta */
  push(delta: string): void;
  /** Flush remaining buffer text */
  flush(): void;
  /** Reset chunker state and clear buffer without emitting */
  reset(): void;
  /** Inspect current buffered text */
  readonly buffered: string;
}

export function createSentenceChunker(
  onChunk: (chunk: string) => void,
  options: SentenceChunkerOptions = {},
): SentenceChunker {
  const maxChunkLength = options.maxChunkLength ?? DEFAULT_MAX_CHUNK_LENGTH;
  const minFirstChunkLength = options.minFirstChunkLength ?? DEFAULT_MIN_FIRST_CHUNK_LENGTH;
  const pausePuncts = options.pausePunctuations ?? DEFAULT_PAUSE_PUNCTUATIONS;
  const trailingPuncts = options.trailingPunctuations ?? DEFAULT_TRAILING_PUNCTUATIONS;

  let buffer = "";
  let isFirstChunk = true;

  const emit = (chunk: string): void => {
    if (chunk.length === 0) return;
    isFirstChunk = false;
    onChunk(chunk);
  };

  const isPausePunct = (char: string): boolean => pausePuncts.has(char);
  const isTrailingPunct = (char: string): boolean => trailingPuncts.has(char) || pausePuncts.has(char);

  const findSplitIndex = (): number | null => {
    if (buffer.length === 0) return null;

    // Scan for punctuation-triggered sentence break
    let i = 0;
    while (i < buffer.length) {
      const char = buffer[i]!;
      if (isPausePunct(char)) {
        // Found a pause punctuation at index i.
        // Consume all consecutive pause and trailing punctuations.
        let punctEnd = i + 1;
        while (punctEnd < buffer.length && isTrailingPunct(buffer[punctEnd]!)) {
          punctEnd++;
        }

        // If for the first chunk we require a minimum length before minor punctuation (like comma):
        // Major punctuations (. ! ? \n) break regardless; commas break if minFirstChunkLength is met.
        const isMajorPunct = char === "。" || char === "！" || char === "？" || char === "\n" || char === "." || char === "!" || char === "?";
        if (isFirstChunk && !isMajorPunct && punctEnd < minFirstChunkLength && punctEnd < buffer.length) {
          // Continue scanning to see if another punctuation arrives later, unless buffer gets too long
          i = punctEnd;
          continue;
        }

        // If there are characters after the punctuation sequence in the buffer,
        // we can safely split right after the punctuation sequence!
        if (punctEnd < buffer.length) {
          return punctEnd;
        }

        // If buffer ends with a newline, we can split immediately without waiting
        if (char === "\n" || (i > 0 && buffer[i - 1] === "\n")) {
          return punctEnd;
        }

        // The buffer currently ends right at the trailing punctuation.
        // We wait for the next push to see if more punctuation attaches,
        // unless buffer exceeds maxChunkLength.
        break;
      }
      i++;
    }

    // Fallback: Buffer length threshold reached (maxChunkLength)
    if (buffer.length >= maxChunkLength) {
      // Find the best split point within [1, maxChunkLength]:
      // 1. Look for any punctuation within maxChunkLength
      for (let j = Math.min(buffer.length - 1, maxChunkLength); j >= 1; j--) {
        if (isPausePunct(buffer[j - 1]!)) {
          // Include trailing attached punctuations up to maxChunkLength
          let end = j;
          while (end < buffer.length && isTrailingPunct(buffer[end]!) && end < maxChunkLength + 5) {
            end++;
          }
          return end;
        }
      }

      // 2. Look for whitespace within maxChunkLength
      for (let j = Math.min(buffer.length, maxChunkLength); j >= 1; j--) {
        if (/\s/.test(buffer[j - 1]!)) {
          return j;
        }
      }

      // 3. Forced split at maxChunkLength, adjusting for surrogate pairs
      let cut = maxChunkLength;
      if (cut < buffer.length) {
        const code = buffer.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) {
          cut++;
        }
      }
      return cut;
    }

    return null;
  };

  const processBuffer = (): void => {
    while (buffer.length > 0) {
      const splitIndex = findSplitIndex();
      if (splitIndex === null || splitIndex <= 0) break;
      const chunk = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex);
      emit(chunk);
    }
  };

  return Object.freeze({
    push(delta: string): void {
      if (typeof delta !== "string" || delta.length === 0) return;
      buffer += delta;
      processBuffer();
    },

    flush(): void {
      if (buffer.length > 0) {
        const remaining = buffer;
        buffer = "";
        emit(remaining);
      }
    },

    reset(): void {
      buffer = "";
      isFirstChunk = true;
    },

    get buffered(): string {
      return buffer;
    },
  });
}
