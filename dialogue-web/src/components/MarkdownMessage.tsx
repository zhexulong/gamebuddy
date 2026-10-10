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
 * Player messages deliberately stay plain text (see `MessageBubble`): the
 * player's own words are not the model's output, and reinterpreting them as
 * Markdown would apply the companion's narration styling to a person.
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

/** Parses untrusted companion Markdown to inert, sanitised HTML. */
export function renderCompanionMarkdown(text: string): string {
  const html = markdown.parse(text, { async: false });
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

export function MarkdownMessage({ text, className }: { text: string; className?: string }) {
  // The parse is memoised per text so a streaming preview delta elsewhere in the
  // surface never re-parses (or re-sanitises) a settled message.
  const html = useMemo(() => renderCompanionMarkdown(text), [text]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
