import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useMemo } from "react";

/**
 * Markdown presentation for companion prose.
 *
 * The companion's reply is a character writing to the player, so its shape
 * carries meaning: paragraphs are beats, `*asterisks*` are stage directions,
 * fenced text is not speech. Rendering the raw string threw all of that away,
 * which is what a chat log does and what a companion does not.
 *
 * Security: the model's text is untrusted. `marked` passes raw HTML through by
 * default, so every parse is sanitised by DOMPurify against a deny-by-default
 * allowlist (`ALLOWED_TAGS` only, `ALLOWED_ATTR` empty): no scripts, no event
 * handlers, no `style`, no embedded elements, and no attribute the model wrote
 * can survive. The one attribute this module adds - the action-beat class on
 * `<em>` - is set by a DOMPurify hook, i.e. after the allowlist has already
 * dropped everything the model authored, so a fabricated `class=` can never
 * become the narration treatment.
 *
 * Player and companion messages both take this path: a `*beat*` is the same
 * format on both sides, and reading a person's words through the companion's
 * renderer is what keeps the identical beat from rendering two ways.
 *
 * A reply can also open with a prosody tag - `（轻声）`, `(softly)` - which the voice
 * layer performs rather than speaks (`dehydrateCompanionSpeech`, host/src). Printed as
 * ordinary text it reads as though she had SAID the direction, so a leading tag is set
 * ahead of the speech as the product's dim badge plate instead. It is moved, never
 * dropped: the tag's own words are the badge's text, and the speech beside it is
 * unchanged. A tag inside the sentence stays exactly where she put it - `她(轻轻点头)道`
 * is part of what she said - so only the opening run is read.
 */

/** The class a `*beat*` (any `<em>`) gets so narration can read as narration. */
export const ACTION_BEAT_CLASS = "message-action";

/**
 * The class a leading prosody tag's badge wears.
 *
 * It is the product's existing dim badge plate (`.memory-item-badge`: the raised card
 * tone, `--text-secondary` ink, the glass hairline, `--radius-sm`) rather than a new
 * recipe for one chip. Borrowing the class is the deliberate choice here: the tone ramp
 * and the sheet belong to the surfaces lane, and a second badge style drawn beside the
 * product's own would be two chip shapes in one product.
 */
export const MOOD_TAG_CLASS = "memory-item-badge";

/**
 * A tag is a round or full-width parenthesised group with no paren of its own, at the
 * very start of the reply - the same shape the voice layer counts as an inline tag
 * (`INLINE_TAG_RE`, host/src/companion-speech-dehydration.ts).
 */
const LEADING_MOOD_TAG = /^[（(]([^（）()]*)[）)]/u;

/** The blocks that hold her prose: a badge set ahead of the speech goes at their start. */
const MOOD_TAG_BLOCKS = new Set(["P", "BLOCKQUOTE", "LI"]);

/**
 * The reply split into the prosody tags it opens with and the words she says.
 *
 * `speech` is returned untouched when the reply opens with no tag, so an ordinary
 * message parses byte-for-byte as it did. A run of tags is read in one pass - `（轻声）（微笑）`
 * is two tags ahead of the speech, not one tag and one parenthetical she said - and an
 * empty `()` is not a tag at all.
 */
export function splitLeadingMoodTags(text: string): Readonly<{ tags: readonly string[]; speech: string }> {
  const tags: string[] = [];
  let rest = text.trimStart();
  for (;;) {
    const match = LEADING_MOOD_TAG.exec(rest);
    if (match === null) break;
    const tag = (match[1] ?? "").trim();
    if (tag === "") break;
    tags.push(tag);
    rest = rest.slice(match[0].length).trimStart();
  }
  if (tags.length === 0) return { tags: [], speech: text };
  return Object.freeze({ tags: Object.freeze(tags), speech: rest });
}

/**
 * Sets the badges ahead of the sanitised Markdown's speech.
 *
 * The badges are built as DOM nodes AFTER sanitisation, which is the same boundary the
 * streaming caret uses: a tag the model wrote reaches the page through `textContent`, so
 * it is text and never markup, and the allowlist this module keeps stays deny-by-default
 * - nothing is added to `ALLOWED_TAGS` or `ALLOWED_ATTR` on account of a badge.
 *
 * They go INSIDE the first prose block rather than above it: the bubble is a column flex
 * container whose items stretch, so a sibling would paint the plate as a full-width bar,
 * while inside the paragraph the plate hugs its own two words and stands ahead of the
 * first one. A reply that opens with a code fence or a rule has no prose block to start,
 * so the badge takes the bubble's first row instead.
 */
function withMoodTags(html: string, tags: readonly string[]): string {
  if (tags.length === 0) return html;
  const host = document.createElement("div");
  host.innerHTML = html;
  const first = host.firstElementChild;
  const holder = first !== null && MOOD_TAG_BLOCKS.has(first.tagName) ? first : host;
  const fragment = document.createDocumentFragment();
  for (const tag of tags) {
    const badge = document.createElement("span");
    badge.className = MOOD_TAG_CLASS;
    badge.setAttribute("data-mood-tag", "");
    badge.textContent = tag;
    // A space after the plate, so the read-back text is `轻声 种子…` and not one word.
    fragment.append(badge, " ");
  }
  holder.insertBefore(fragment, holder.firstChild);
  return host.innerHTML;
}

const markdown = new Marked({ gfm: true, breaks: true });

const SANITIZE_CONFIG = {
  ALLOWED_TAGS: ["p", "br", "em", "strong", "del", "code", "pre", "blockquote", "ul", "ol", "li", "hr"],
  ALLOWED_ATTR: [] as string[],
  // DOMPurify keeps `data-*`/`aria-*` even with an empty allowlist; a deny-by-default
  // surface must turn both off so model output carries no attributes at all.
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName === "EM") node.setAttribute("class", ACTION_BEAT_CLASS);
});

/**
 * Both sides author beats, and CJK input arrives in a full-width form. A
 * full-width `＊…＊` is the same beat as the ASCII `*…*`, so the asterisks are
 * normalised before the parse: without it the identical beat renders as a stage
 * direction on one side and as bare text on the other.
 *
 * Rewriting CJK *punctuation* was never part of that. `（…）` is not an emphasis
 * delimiter - Markdown does not read a parenthetical as `<em>`, and the beat this
 * product authors is `*动作*` - so replacing the full-width parens with ASCII
 * only changed how the sentence reads: `她(轻轻点头)道`, where a CJK reader
 * expects `她（轻轻点头）道`. That rewrite is gone; the asterisk half stays.
 */
function normalizeBeatDelimiters(text: string): string {
  return text.replace(/＊/gu, "*");
}

/** Parses untrusted message Markdown to inert, sanitised HTML. */
export function renderCompanionMarkdown(text: string): string {
  const html = markdown.parse(normalizeBeatDelimiters(text), { async: false });
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

/** A block that only holds other blocks: the caret descends through it to the
 * text-bearing block that ends the reply. */
const BLOCK_CONTAINERS = new Set(["UL", "OL", "LI", "BLOCKQUOTE"]);

/**
 * Inserts the trusted trailing fragment inside the last block of the sanitised
 * Markdown, so an inline caret trails the reply's last character. Appending it
 * as a sibling instead - the failure this replaces - made it a flex row of its
 * own below the paragraph (the bubble is a column flex container), which reads as
 * a cursor on a blank line rather than at the end of the text.
 *
 * The fragment is a static, trusted constant: it is inserted after sanitisation,
 * never through it, and never by rewriting raw Markdown. A reply that ends in a
 * horizontal rule has no text block to descend into, so it keeps the old
 * below-the-rule placement rather than nesting a caret inside a void element.
 */
function withTrailingHtml(html: string, trailingHtml: string): string {
  if (trailingHtml === "") return html;
  const host = document.createElement("div");
  host.innerHTML = html;
  const blocks = [...host.children];
  const last = blocks[blocks.length - 1];
  if (last === undefined || last.tagName === "HR") return `${html}${trailingHtml}`;
  let target = last;
  for (;;) {
    const next = target.lastElementChild;
    if (next === null || !BLOCK_CONTAINERS.has(target.tagName)) break;
    target = next;
  }
  target.insertAdjacentHTML("beforeend", trailingHtml);
  return host.innerHTML;
}

export function MarkdownMessage({
  text,
  className,
  testId,
  trailingHtml = "",
  lang,
}: {
  text: string;
  className?: string;
  /**
   * The wrapper's own test handle, for a surface whose rendered Markdown IS the
   * element a journey measures (the openings chooser reads the option's line off
   * this block). The parse and the wrapper stay together, so a caller that needs
   * the handle cannot move the Markdown into a second element of its own.
   */
  testId?: string;
  /**
   * The message's own language, when the Host projected one: it lands on the
   * rendered text so assistive tech and `:lang()` styling read the text's
   * language instead of the surface's. Omitted when the Host carried none.
   */
  lang?: string | undefined;
  /**
   * A static, trusted fragment inserted inside the sanitised Markdown's last
   * block - the streaming caret, and nothing else. It is not model output, and
   * placing it there rather than rendering it as a React child is what makes it
   * trail the reply's last character (`children` and `dangerouslySetInnerHTML`
   * cannot coexist, and a sibling would be its own flex row).
   */
  trailingHtml?: string;
}) {
  // The parse is memoised per text so a streaming preview delta elsewhere in the
  // surface never re-parses (or re-sanitises) a settled message. The prosody tag is read
  // in the same pass: one text in, one rendered bubble out.
  const html = useMemo(() => {
    const { tags, speech } = splitLeadingMoodTags(text);
    return withMoodTags(withTrailingHtml(renderCompanionMarkdown(speech), trailingHtml), tags);
  }, [text, trailingHtml]);
  return <div className={className} data-testid={testId} lang={lang} dangerouslySetInnerHTML={{ __html: html }} />;
}
