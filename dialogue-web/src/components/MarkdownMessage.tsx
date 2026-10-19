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
 */

/** The class a `*beat*` (any `<em>`) gets so narration can read as narration. */
export const ACTION_BEAT_CLASS = "message-action";

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
  // surface never re-parses (or re-sanitises) a settled message.
  const html = useMemo(() => withTrailingHtml(renderCompanionMarkdown(text), trailingHtml), [text, trailingHtml]);
  return <div className={className} data-testid={testId} lang={lang} dangerouslySetInnerHTML={{ __html: html }} />;
}
