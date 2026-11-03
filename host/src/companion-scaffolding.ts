/**
 * Model scaffolding: the text a model writes *for itself*.
 *
 * A character reply mixes three kinds of text and only two of them belong to
 * the player:
 *
 *  - performance - `*...*` action beats. The Chat transcript renderer draws them
 *    as `.message-action`, so they stay, byte for byte.
 *  - dialogue and ordinary prose, which stay.
 *  - scaffolding - `<thinking>...</thinking>`, `（思考：...）`/`【内心：...】`,
 *    markdown `**emphasis**` and `---` rules - which is leakage. The player must
 *    not read it, so a durable Chat row must not carry it.
 *
 * This is NOT the dehydrator (`companion-speech-dehydration`). That module
 * projects a reply onto what the in-game bubble and the voice can *perform*, so
 * it drops the beats as well and its behaviour is frozen. The scaffolding rule
 * is the one rule both surfaces share, and this is where it is stated.
 *
 * Treated as scaffolding, and why:
 *
 *  - `<thinking>...</thinking>` / `<thought>...</thought>` (multi-line,
 *    case-insensitive) - a private reasoning block. Whatever sits between those
 *    tags is the model talking to itself; a literal block is never dialogue.
 *  - `（思考：...）`, `（内心：...）`, `（脑内：...）` and the `【...】` forms - the
 *    same private reasoning in the full-width frames the companion prompt uses.
 *  - `**emphasis**` - markdown rendering markers. Only the two markers go; the
 *    emphasised words are prose and stay.
 *  - `---` on a line of its own - a markdown horizontal rule, a section divider
 *    rather than anything said.
 *
 * Deliberately NOT scaffolding (kept verbatim):
 *
 *  - every `*...*` beat - performance, the companion's only expression channel.
 *  - `(...)`, `（...）`, `[...]`, `【...】` in general - ordinary parenthetical
 *    prose, or a MiMo audio tag (`（轻声）`, `[pause]`) the voice performs.
 *  - an unclosed `<thinking>` with no matching close tag: the block cannot be
 *    identified, so nothing is removed. Open question: a truncated reply would
 *    leak the reasoning text rather than the tag pair. The streaming projection
 *    below does not have that hole - it saw the frame open, so it drops what it
 *    never saw closed - but a durable row still keeps it.
 *  - ASCII `(thinking...)` / `[thinking...]` frames: `(thinking aloud)` is
 *    ordinary English, so only the tag-keyed forms above are removed. Open
 *    question: the in-game dehydrator does remove them, which leaves the two
 *    surfaces disagreeing about that one form.
 *  - `***bold italic***`: unwrapping the inner pair would leave `*x*` and invent
 *    an action beat, so the lookarounds below keep the whole run untouched.
 *    Open question: the markers then survive into the Chat row.
 *  - markdown headings (`# ...`) and `***` rules. Open question: neither is
 *    listed as scaffolding today.
 *
 * The transform removes a scaffolding span exactly where it sits: every `*...*`
 * beat comes back byte for byte, and no word of prose is dropped. It is not a
 * re-flow - nothing inside the text is collapsed, joined or re-wrapped. The two
 * bytes it does take beyond the spans themselves are leading and trailing
 * whitespace, because a durable Chat row that begins with the blank lines a
 * removed block left behind is an artifact of the removal, not something the
 * model said. Open question: a scaffolding frame alone on its own line still
 * leaves its blank line at the seam, and nothing here re-flows it away.
 */
export function removeModelScaffolding(input: string): string {
  let text = input;
  for (const frames of REASONING_REMOVALS) text = text.replace(frames, "");
  return text.replace(EMPHASIS_MARKERS, "$1").replace(HORIZONTAL_RULE, "").trim();
}

/**
 * One family of private reasoning frames: the literals that open one, the
 * literals that end it, and whether they ignore case.
 *
 * This declaration is the only spelling of the frames. The whole-text rule and
 * the streaming projection both derive from it, because a form removed from a
 * durable row but not withheld from a live stream is the leak this module exists
 * to close - and two hand-written lists drift silently in exactly that
 * direction.
 */
type ReasoningFamily = Readonly<{
  ignoreCase: boolean;
  openings: readonly string[];
  closings: readonly string[];
}>;

/** Every closer of the tag family, so `<thinking>` may be closed by `</thought>`. */
const TAG_CLOSINGS = Object.freeze(["</thinking>", "</thought>"]);

/** The families, in the order the whole-text rule removes them. */
const REASONING_FAMILIES: readonly ReasoningFamily[] = Object.freeze([
  Object.freeze({ ignoreCase: true, openings: Object.freeze(["<thinking>", "<thought>"]), closings: TAG_CLOSINGS }),
  // DeepSeek-R1 and Qwen3's thinking mode frame their reasoning this way. It is a separate
  // family and not an addition to the line above: openings are matched as literals, so sharing
  // one family would let this shorter tag claim a <thinking> opening and then close on the
  // </think prefix of </thinking>, leaving a stray '>' in the reply.
  Object.freeze({ ignoreCase: true, openings: Object.freeze(["<think>"]), closings: Object.freeze(["</think>"]) }),
  Object.freeze({
    ignoreCase: false,
    openings: Object.freeze(["（思考", "（内心", "（脑内"]),
    closings: Object.freeze(["）"]),
  }),
  Object.freeze({
    ignoreCase: false,
    openings: Object.freeze(["【思考", "【内心", "【脑内"]),
    closings: Object.freeze(["】"]),
  }),
]);

const escapeLiteral = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One private reasoning frame: the literal that opens it and the literals that end it. */
export type ReasoningFrame = Readonly<{
  opening: string;
  closings: readonly string[];
  ignoreCase: boolean;
}>;

/** The families flattened, one entry per opening, for a reader that scans a stream. */
export const REASONING_FRAMES: readonly ReasoningFrame[] = Object.freeze(
  REASONING_FAMILIES.flatMap((family) =>
    family.openings.map((opening) =>
      Object.freeze({ opening, closings: family.closings, ignoreCase: family.ignoreCase }),
    ),
  ),
);

/** `<thinking>...</thinking>` (etc.), multi-line, one pattern per family. */
const REASONING_REMOVALS: readonly RegExp[] = Object.freeze(
  REASONING_FAMILIES.map(
    (family) =>
      new RegExp(
        `(?:${family.openings.map(escapeLiteral).join("|")})[\\s\\S]*?(?:${family.closings.map(escapeLiteral).join("|")})`,
        family.ignoreCase ? "gi" : "g",
      ),
  ),
);

/**
 * Markdown emphasis markers. The content stays; the lookarounds keep
 * `***bold italic***` out of this rule, because unwrapping the inner pair would
 * leave `*x*` - a beat the model never wrote.
 */
const EMPHASIS_MARKERS = /(?<!\*)\*\*([^*\n]+)\*\*(?!\*)/g;

/** A markdown horizontal rule on a line of its own. */
const HORIZONTAL_RULE = /^[ \t]*---[ \t]*$/gm;

/** One literal as the streaming reader compares it: case is a per-family fact. */
type FrameLiteral = Readonly<{ literal: string; ignoreCase: boolean }>;

/** The frames as openers with the closings that end them, in the scanner's alphabet. */
const STREAM_FRAMES: readonly Readonly<{ opening: FrameLiteral; closings: readonly FrameLiteral[] }>[] = Object.freeze(
  REASONING_FRAMES.map((frame) =>
    Object.freeze({
      opening: Object.freeze({ literal: frame.opening, ignoreCase: frame.ignoreCase }),
      closings: Object.freeze(
        frame.closings.map((closing) => Object.freeze({ literal: closing, ignoreCase: frame.ignoreCase })),
      ),
    }),
  ),
);

/**
 * The streaming half of the rule: the same reasoning frames, released fragment by
 * fragment.
 *
 * A live preview and a streaming voice job read the model's text while it is
 * still arriving, so they cannot wait for a complete message and cannot run a
 * whole-text rule over a fragment - `removeModelScaffolding` would trim the space
 * between two fragments and would not see a `</thinking>` split across two of
 * them. What a fragment can answer is narrower and decidable: every character is
 * either inside a frame this stream has already seen open, or it is text that no
 * future fragment can move into one. Only the second kind is released.
 *
 * The tail of each fragment that could still grow into a marker is held back, so
 * a frame split across fragments is still recognized. A frame the stream never
 * sees closed is dropped rather than released: the stream saw it open, and the
 * text inside it is the model talking to itself.
 */
export type ScaffoldingStreamProjection = Readonly<{
  /** Appends one arriving fragment; returns the text no frame can claim. */
  push(fragment: string): string;
  /** Ends a message: releases the held tail, or drops it when a frame never closed. */
  flush(): string;
  /** Ends a message that is never presented, releasing nothing. */
  reset(): void;
}>;

export function createScaffoldingStreamProjection(): ScaffoldingStreamProjection {
  let held = "";
  /** The closings of the frame this stream is inside, or undefined while it is in prose. */
  let closing: readonly FrameLiteral[] | undefined;
  return Object.freeze({
    push(fragment: string): string {
      let text = held + fragment;
      held = "";
      let released = "";
      for (;;) {
        if (closing !== undefined) {
          const end = earliest(text, closing);
          if (end === undefined) {
            held = tail(text, closing);
            return released;
          }
          text = text.slice(end.index + end.literal.literal.length);
          closing = undefined;
          continue;
        }
        const start = earliestOpening(text);
        if (start === undefined) {
          held = tail(
            text,
            STREAM_FRAMES.map((frame) => frame.opening),
          );
          released += text.slice(0, text.length - held.length);
          return released;
        }
        released += text.slice(0, start.index);
        text = text.slice(start.index + start.opening.literal.length);
        closing = start.closings;
      }
    },
    flush(): string {
      const released = closing === undefined ? held : "";
      held = "";
      closing = undefined;
      return released;
    },
    reset(): void {
      held = "";
      closing = undefined;
    },
  });
}

const startsWith = (text: string, at: number, literal: FrameLiteral): boolean => {
  const candidate = text.slice(at, at + literal.literal.length);
  if (candidate.length !== literal.literal.length) return false;
  return literal.ignoreCase ? candidate.toLowerCase() === literal.literal.toLowerCase() : candidate === literal.literal;
};

/** The earliest of these literals in `text`, which is where a frame opens or closes. */
const earliest = (
  text: string,
  literals: readonly FrameLiteral[],
): Readonly<{ index: number; literal: FrameLiteral }> | undefined => {
  let best: Readonly<{ index: number; literal: FrameLiteral }> | undefined;
  for (const literal of literals) {
    for (let at = 0; at + literal.literal.length <= text.length; at += 1) {
      if (!startsWith(text, at, literal)) continue;
      if (best === undefined || at < best.index) best = Object.freeze({ index: at, literal });
      break;
    }
  }
  return best;
};

const earliestOpening = (
  text: string,
): Readonly<{ index: number; opening: FrameLiteral; closings: readonly FrameLiteral[] }> | undefined => {
  let best: Readonly<{ index: number; opening: FrameLiteral; closings: readonly FrameLiteral[] }> | undefined;
  for (const frame of STREAM_FRAMES) {
    const found = earliest(text, [frame.opening]);
    if (found === undefined) continue;
    if (best === undefined || found.index < best.index)
      best = Object.freeze({ index: found.index, opening: frame.opening, closings: frame.closings });
  }
  return best;
};

/**
 * The longest suffix of `text` that is still an unfinished literal. Text that
 * could yet become a marker is not text the player may read, so it waits for the
 * next fragment.
 */
const tail = (text: string, literals: readonly FrameLiteral[]): string => {
  let longest = 0;
  for (const literal of literals) {
    const limit = Math.min(literal.literal.length - 1, text.length);
    for (let length = limit; length > longest; length -= 1) {
      const suffix = text.slice(text.length - length);
      const prefix = literal.literal.slice(0, length);
      if (literal.ignoreCase ? suffix.toLowerCase() === prefix.toLowerCase() : suffix === prefix) {
        longest = length;
        break;
      }
    }
  }
  return text.slice(text.length - longest);
};
