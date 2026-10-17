import { memo } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle, RefreshCw } from "lucide-react";
import type { BrowserMessageV1 } from "../reference-pipeline-api";
import { browserMessageLanguageTag } from "../reference-pipeline-api";
import { CompanionAvatar } from "./CompanionAvatar";
import { MarkdownMessage } from "./MarkdownMessage";

/**
 * The live-streaming caret, inserted into the companion bubble's last block. The
 * bubble is Markdown rendered through `dangerouslySetInnerHTML`, so the caret is
 * placed into that sanitised HTML rather than passed as a React child; and it is
 * placed on every render, not only while streaming, so the preview's and the
 * committed message's bytes stay identical. Only `[data-streaming]` styles it, so
 * an idle bubble carries an inert, zero-size span.
 */
const CARET_MARKUP = '<span class="message-caret" aria-hidden="true"></span>';

/**
 * The switcher's own words. The Host publishes the committed variant's position in
 * the greeting set and, whenever the set carried one, the variant's own label -
 * the greeting set's entry name, `Default` or `Alternate N` (the card's own 1-based
 * order, `new-companion-service.ts` `buildGreetingVariants`). That label is the
 * Host's structural spelling, not a player word, so it is translated through the
 * catalogue and a label outside that closed vocabulary is shown as published rather
 * than invented. Both are shown: the label names the opening the player is looking
 * at, the position says how many there are. A set the Host published no label for
 * leaves the position alone.
 */
function openingVariantWords(
  variant: Readonly<{ label: string | null; index: number; count: number }>,
  labels: Readonly<{ openingVariantDefault: string; openingVariantAlternate: string }>,
): string {
  const position = `${variant.index + 1}/${variant.count}`;
  return variant.label === null ? position : `${openingVariantLabel(variant.label, labels)} ${position}`;
}

/**
 * The Host's greeting-variant vocabulary (`Default` / `Alternate N`) in player
 * words. The card's own order in the alternate's label is preserved, because that
 * order is what the player sees in the authored opening, not the set position the
 * indicator prints beside it.
 */
function openingVariantLabel(
  label: string,
  labels: Readonly<{ openingVariantDefault: string; openingVariantAlternate: string }>,
): string {
  if (label === "Default") return labels.openingVariantDefault;
  const alternate = /^Alternate (\d+)$/u.exec(label);
  return alternate === null ? label : labels.openingVariantAlternate.replace("{{index}}", alternate[1]!);
}

/**
 * The swipe switcher's own words. The Host publishes the position as the plain `1/3`
 * (`formatSwipeLabel`, `host/src/tavern/message-tree.ts:94-101`, used by both the swipe route and
 * the state projection). The pair of arrows around it belongs to this control, which draws real
 * ones - so a label that still arrives in the older `◀ 1/3 ▶` spelling (a browser journey's own
 * fixture) has only that decoration read back out, and the position itself is shown exactly as
 * the Host published it.
 */
function swipePosition(label: string): string {
  return label.replace(/^[\s◀]+/u, "").replace(/[\s▶]+$/u, "");
}

/**
 * Memoised so a streaming delta - which re-renders the conversation with a new
 * preview - cannot re-render a settled message and re-parse its Markdown. The
 * transcript's message objects are immutable and keep their identity across a
 * preview-only update, so the default shallow comparison is enough; `Timeline`
 * keeps the handler identities stable for the same reason.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  companionName,
  companionHandle,
  playerLabel,
  onSwipe,
  onRegenerate,
  onOpeningVariant,
  pending = null,
  streaming = false,
  waitingNote = null,
  as = "li",
  labels,
}: {
  message: BrowserMessageV1;
  companionName: string;
  /** The mounted companion's own roster handle: how her picture is addressed. */
  companionHandle: string | null;
  playerLabel: string;
  onSwipe?: (messageHandle: string, direction: "prev" | "next") => void;
  onRegenerate?: (messageHandle: string) => void;
  /**
   * The new-chat opening choice: it is offered only where the Host published an unlocked
   * `openingVariant`, and it calls the Host's own route rather than holding the choice here.
   */
  onOpeningVariant?: (messageHandle: string, direction: "prev" | "next") => void;
  /**
   * The mutation this exact message is waiting on, if any. While it is set the
   * message's own controls are disabled: the shell already guards against a second
   * command with its single-flight ref, and the control saying so is what keeps a
   * double click from looking like it did nothing.
   */
  pending?: "swipe" | "regenerate" | "opening" | null;
  /**
   * True only for the live streaming preview: the bubble then carries the
   * reading caret. The caret is inserted into the bubble's last block on every
   * render - only `[data-streaming]` styles it - so it trails the reply's last
   * character and the preview's and the committed message's bytes stay identical.
   */
  streaming?: boolean;
  /**
   * The optimistic player row's own word under the bubble ("sending"), while the
   * Host has not answered yet.
   *
   * It exists so that row is this component rather than a second copy of it: the
   * pending line and the authoritative one are the same row with the same avatar,
   * bubble tone and geometry, so the moment the Host's transcript carries the
   * message nothing moves. A separate markup path made that a visible jump - the
   * grey box the player sent became a wine bubble under a monogram a moment later.
   */
  waitingNote?: string | null;
  /**
   * The element the row renders as. The transcript's rows are `<li>` of its own
   * `<ol>`; the optimistic row is the same presentation *outside* that list,
   * because it is not one of the transcript's rows (the send journey asserts the
   * list carries none while it is visible), so its caller renders it as a `<div>`.
   */
  as?: "li" | "div";
  labels: Readonly<{
    swipeNavigation: string;
    swipePrevious: string;
    swipeNext: string;
    regenerateVariant: string;
    openingVariantDefault: string;
    openingVariantAlternate: string;
  }>;
}) {
  const isPlayer = message.role === "player";
  const authorName = isPlayer ? playerLabel : companionName;
  const swipeInfo = message.swipeInfo;
  const openingVariant = message.openingVariant;
  const busy = pending !== null;
  // The Host published this only while the opening is still unlocked and the greeting set still
  // resolves; when it is sealed the control is absent rather than offered and refused.
  const openingChoice =
    !isPlayer && openingVariant !== undefined && !openingVariant.locked && openingVariant.count > 1
      ? openingVariant
      : undefined;
  // The message's own swipe set, when the Host published more than one variant of
  // it. It is the same shape as the opening choice, and it reads the same way.
  const swipeSet = swipeInfo !== undefined && swipeInfo.totalSwipes > 1 ? swipeInfo : undefined;
  // Whether this message's strip has a pager at all: the strip exists for its own
  // controls, so a message with neither keeps no empty row under the bubble.
  const hasControls = openingChoice !== undefined || swipeSet !== undefined;
  // The Host's per-message language, painted on the text only: the author line
  // and the swipe/regenerate controls are player-facing UI words and must keep
  // the surface's own language. `und` paints nothing (browserMessageLanguageTag),
  // so the document's language still styles a CJK beat through `:lang(zh)`.
  const languageTag = browserMessageLanguageTag(message.locale);
  const Row = as;

  return (
    <Row
      className={`message ${isPlayer ? "player" : "companion"}${waitingNote === null ? "" : " message-waiting-row"}`}
      data-handle={message.handle}
      {...(busy ? { "aria-busy": "true" as const, "data-pending": pending } : {})}
      {...(waitingNote === null ? {} : { "aria-busy": "true" as const, "data-waiting": "true" as const })}
      {...(streaming ? { "data-streaming": "true" as const } : {})}
    >
      {/* The avatar is the row's first child on both sides, and the player's
          row is mirrored by `flex-direction: row-reverse` (style.css): the
          monogram ends up outside the bubble, hugging the outer boundary. The
          companion's side carries her real picture when the Host has one;
          everything else about the element - size, plate, `aria-hidden` - is the
          monogram it already was. */}
      <CompanionAvatar
        handle={isPlayer ? null : companionHandle}
        name={authorName}
        className="avatar-small"
      />
      <div className="message-body">
        {/* The author line belongs to the companion only. The player's own
            monogram already sits at the row's edge, so printing the same name
            again above the bubble reads as "[你] 你: 你好" - the line is a
            duplicate of the avatar, not an attribution - and the player's side
            has no header at all, because an empty box would still add the body
            column's gap above the bubble. */}
        {!isPlayer && (
          <div className="message-header">
            <span className="message-author">{authorName}</span>
          </div>
        )}
        {/* Both sides author text, and a `*beat*` is the same format on both:
            the same sanitised Markdown renderer reads a person's words exactly as
            it reads the companion's, so the identical beat cannot render two ways. */}
        <MarkdownMessage
          className="message-bubble"
          text={message.text}
          trailingHtml={CARET_MARKUP}
          lang={languageTag}
        />
        {/* One strip under the bubble for everything a companion message can do
            to itself: choose another opening, swipe the set, ask again. The pager
            used to sit in the author line above the bubble while regenerate sat
            here, so one message's two controls were diagonal - measured at
            1440x900 on a regenerated reply: pager 389..435 above a 439..485
            bubble, regenerate 493..537 under it, their centres 145 px apart - and
            going back to an earlier variant after asking again meant crossing the
            bubble. */}
        {!isPlayer && (hasControls || onRegenerate) && (
          <div className="message-actions">
            {openingChoice && (
              <div className="swipe-controls" aria-label={labels.swipeNavigation}>
                {/* The glyph is the visible control and the number between the two
                    is the state; the words live in the accessible name. Long labels
                    here are what wrapped the strip to two rows at 400 px, and in a
                    narrow chat the dialogue is what the player is reading - this is
                    Tavern's own `\u2039 1/3 \u203a` for the same reason. */}
                <button
                  type="button"
                  className="swipe-btn"
                  disabled={busy || openingChoice.index <= 0}
                  onClick={() => onOpeningVariant?.(message.handle, "prev")}
                  aria-label={labels.swipePrevious}
                  title={labels.swipePrevious}
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                </button>
                <span className="swipe-indicator">{openingVariantWords(openingChoice, labels)}</span>
                <button
                  type="button"
                  className="swipe-btn"
                  disabled={busy || openingChoice.index >= openingChoice.count - 1}
                  onClick={() => onOpeningVariant?.(message.handle, "next")}
                  aria-label={labels.swipeNext}
                  title={labels.swipeNext}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </div>
            )}
            {swipeSet && (
              <div className="swipe-controls" aria-label={labels.swipeNavigation}>
                <button
                  type="button"
                  className="swipe-btn"
                  disabled={busy || !swipeSet.hasPrevious}
                  onClick={() => onSwipe?.(message.handle, "prev")}
                  aria-label={labels.swipePrevious}
                  title={labels.swipePrevious}
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                </button>
                <span className="swipe-indicator">{swipePosition(swipeSet.label)}</span>
                <button
                  type="button"
                  className="swipe-btn"
                  disabled={busy || !swipeSet.hasNext}
                  onClick={() => onSwipe?.(message.handle, "next")}
                  aria-label={labels.swipeNext}
                  title={labels.swipeNext}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </div>
            )}
            {onRegenerate && (
              <button
                type="button"
                className="action-btn regenerate-btn"
                disabled={busy}
                {...(pending === "regenerate" ? { "data-busy": "true" as const } : {})}
                onClick={() => onRegenerate(message.handle)}
                title={labels.regenerateVariant}
                aria-label={labels.regenerateVariant}
              >
                {pending === "regenerate" ? (
                  <LoaderCircle className="message-spinner" size={14} aria-hidden="true" />
                ) : (
                  <RefreshCw size={14} aria-hidden="true" />
                )}
                {labels.regenerateVariant}
              </button>
            )}
            {waitingNote !== null && (
              <span className="message-waiting" role="status">
                {waitingNote}
              </span>
            )}
          </div>
        )}
      </div>
    </Row>
  );
});
