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
 *    identified, so nothing is removed. Open question: a truncated stream would
 *    leak the reasoning text rather than the tag pair.
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
  return input
    .replace(REASONING_BLOCK, "")
    .replace(REASONING_FULL_WIDTH_PARENS, "")
    .replace(REASONING_FULL_WIDTH_BRACKETS, "")
    .replace(EMPHASIS_MARKERS, "$1")
    .replace(HORIZONTAL_RULE, "")
    .trim();
}

/** `<thinking>...</thinking>` / `<thought>...</thought>`, multi-line. */
const REASONING_BLOCK = /<(?:thinking|thought)>[\s\S]*?<\/(?:thinking|thought)>/gi;

/** `（思考：...）` / `（内心：...）` / `（脑内：...）`. */
const REASONING_FULL_WIDTH_PARENS = /（(?:思考|内心|脑内)[\s\S]*?）/g;

/** `【思考：...】` / `【内心：...】` / `【脑内：...】`. */
const REASONING_FULL_WIDTH_BRACKETS = /【(?:思考|内心|脑内)[\s\S]*?】/g;

/**
 * Markdown emphasis markers. The content stays; the lookarounds keep
 * `***bold italic***` out of this rule, because unwrapping the inner pair would
 * leave `*x*` - a beat the model never wrote.
 */
const EMPHASIS_MARKERS = /(?<!\*)\*\*([^*\n]+)\*\*(?!\*)/g;

/** A markdown horizontal rule on a line of its own. */
const HORIZONTAL_RULE = /^[ \t]*---[ \t]*$/gm;
