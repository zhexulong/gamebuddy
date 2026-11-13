/**
 * The ONE declaration of what a companion reply may look like.
 *
 * Two artefacts have to agree about a reply's shape: the prompt that asks for one, and the
 * renderer that draws one. Until this file existed they agreed by memory, and they did not
 * agree. Measured on the shipped card: its own text forbade every parenthesis and every
 * action description, `identity-profile.ts` asked her to write a gesture as `*…*`, and the
 * renderer painted `<em>` as the action beat plus a leading `（…）` as a prosody badge - on
 * the player's rows as well as hers. Three spellings of one fact, and the card's own
 * `mes_example` demonstrated the very construct its own text banned.
 *
 * Why the declaration lives HERE and not in the card. The card owns her FORM - how often
 * she reaches for a beat, how long a turn is, which of these constructs her voice prefers -
 * and that is the card's to keep (`identity-profile.ts` states the split: FLOOR is the
 * prompt's, FORM is the card's, CHANNEL is the surface's). What a reply may be made of is
 * CHANNEL: which constructs exist at all, and what each one means once it is written. A
 * card cannot own that. It is one companion's authored data, the ST card format has no
 * surface-scoped field, and a third-party card arrives with its own voice while the
 * surface still draws the same constructs. The renderer is also the only artefact able to
 * enforce the grammar, which is why the declaration sits beside it.
 *
 * The prompt side is held the other way round, and there is no way around it: the Host is a
 * different package with its own compile root, so neither side can import this module. What
 * keeps them together is that the card says nothing about the channel at all - the ban this
 * file's constructs used to be forbidden by is gone, so "what the prompt forbids" is empty
 * for every construct here - while the one prompt that ASKS for a construct is the Chat
 * surface's own block (`host/src/identity-profile.ts`, `CHAT_SURFACE_DIVERGENCE`), pinned to
 * name both painted constructs by `host/src/identity-profile.test.ts`. And the shipped card
 * cannot silently start demonstrating something the surface drops: the card's own
 * `mes_example`/`first_mes` lines are a gate below, read from the file.
 *
 * What each construct declares, and what the gate derives from it:
 *  - `syntax` and `sample` - what a reply writes, and one reply that writes it, so the gate
 *    can put the sample through the real bubble and see the declared treatment.
 *  - `tags` - the sanitised tags that carry it. `REPLY_ALLOWED_TAGS` is their union, and it
 *    is what the renderer's allowlist IS, so a tag cannot be painted without being declared
 *    here.
 *  - `paint` - the treatment the bubble owes it.
 *  - `speaker` - whose text it may appear in. A prosody tag is the voice layer's channel,
 *    and the voice layer performs the COMPANION's speech only; a player's parenthetical is
 *    the player's own stage direction and stays text. Painting the player's words as a
 *    direction for her tone is what turned `（站在田埂上看着远山没动静）` into a badge.
 */

/** How the bubble draws a construct. */
type ReplyPaint = "speech" | "action-beat" | "prosody-badge" | "shape";

/** Whose text a construct may appear in. */
export type ReplySpeaker = "both" | "companion" | "player";

export type ReplyConstruct = Readonly<{
  id: string;
  /** What a reply writes to produce it. */
  syntax: string;
  /** One reply that writes it, for the gate to render. */
  sample: string;
  /** The sanitised tags that carry it. */
  tags: readonly string[];
  paint: ReplyPaint;
  speaker: ReplySpeaker;
}>;

/**
 * The constructs, in the order their tags reach the sanitizer.
 *
 * Deliberately absent: a table, a heading, a link and an image. GFM parses all four, and a
 * reply that wrote one used to degrade into its concatenated cell text with no mark that
 * anything had been dropped. They are not constructs of a spoken reply, so they are not
 * declared, so they are not painted.
 */
export const COMPANION_REPLY_GRAMMAR: readonly ReplyConstruct[] = Object.freeze([
  Object.freeze({
    id: "speech",
    syntax: "plain words",
    sample: "The seeds are sprouting.",
    tags: Object.freeze(["p", "br"]),
    paint: "speech",
    speaker: "both",
  }),
  Object.freeze({
    id: "action-beat",
    syntax: "*…*",
    sample: "She laughed. *nods*",
    tags: Object.freeze(["em"]),
    paint: "action-beat",
    speaker: "both",
  }),
  Object.freeze({
    id: "prosody-tag",
    syntax: "(…) opening the reply",
    sample: "(softly) The seeds are sprouting.",
    tags: Object.freeze(["p"]),
    paint: "prosody-badge",
    speaker: "companion",
  }),
  Object.freeze({
    id: "emphasis",
    syntax: "**…**",
    sample: "**weight**",
    tags: Object.freeze(["strong"]),
    paint: "shape",
    speaker: "both",
  }),
  Object.freeze({
    id: "strikethrough",
    syntax: "~~…~~",
    sample: "~~crossed out~~",
    tags: Object.freeze(["del"]),
    paint: "shape",
    speaker: "both",
  }),
  Object.freeze({
    id: "inline-code",
    syntax: "`…`",
    sample: "`code`",
    tags: Object.freeze(["code"]),
    paint: "shape",
    speaker: "both",
  }),
  Object.freeze({
    id: "fenced-code",
    syntax: "```…```",
    sample: "```\ncode\n```",
    tags: Object.freeze(["pre"]),
    paint: "shape",
    speaker: "both",
  }),
  Object.freeze({
    id: "quote",
    syntax: "> …",
    sample: "> a quoted line",
    tags: Object.freeze(["blockquote"]),
    paint: "shape",
    speaker: "both",
  }),
  Object.freeze({
    id: "list",
    syntax: "- …",
    sample: "- one\n- two",
    tags: Object.freeze(["ul", "li"]),
    paint: "shape",
    speaker: "both",
  }),
  Object.freeze({
    id: "ordered-list",
    syntax: "1. …",
    sample: "1. one\n2. two",
    tags: Object.freeze(["ol", "li"]),
    paint: "shape",
    speaker: "both",
  }),
  Object.freeze({
    id: "rule",
    syntax: "---",
    sample: "---",
    tags: Object.freeze(["hr"]),
    paint: "shape",
    speaker: "both",
  }),
]);

/** One construct by id, or a loud failure: a missing member is not a silent skip. */
export function replyConstruct(id: string): ReplyConstruct {
  const found = COMPANION_REPLY_GRAMMAR.find((construct) => construct.id === id);
  if (found === undefined) throw new Error(`reply_grammar_construct_missing:${id}`);
  return found;
}

/** Every tag the reply may be made of: the sanitizer's whole allowlist, derived. */
export const REPLY_ALLOWED_TAGS: readonly string[] = Object.freeze([
  ...new Set(COMPANION_REPLY_GRAMMAR.flatMap((construct) => [...construct.tags])),
]);
