import { memo } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle, RefreshCw } from "lucide-react";
import type { BrowserMessageV1 } from "../reference-pipeline-api";
import { MarkdownMessage } from "./MarkdownMessage";

/**
 * The live-streaming caret, as the companion bubble's own trailing child. The
 * bubble is Markdown rendered through `dangerouslySetInnerHTML`, so the caret is
 * appended to that sanitised HTML instead of being passed as a React child; and
 * it is appended on every render, not only while streaming, so the preview's and
 * the committed message's bytes stay identical. Only `[data-streaming]` styles
 * it, so an idle bubble carries an inert, zero-size span.
 */
const CARET_MARKUP = '<span class="message-caret" aria-hidden="true"></span>';

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
  playerLabel,
  onSwipe,
  onRegenerate,
  onOpeningVariant,
  pending = null,
  streaming = false,
  labels,
}: {
  message: BrowserMessageV1;
  companionName: string;
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
   * reading caret. The caret is the bubble's own last child on every render -
   * only `[data-streaming]` styles it - so it never hangs outside the bubble's
   * box and the preview's and the committed message's bytes stay identical.
   */
  streaming?: boolean;
  labels: Readonly<{
    swipeNavigation: string;
    swipePrevious: string;
    swipeNext: string;
    regenerateVariant: string;
  }>;
}) {
  const isPlayer = message.role === "player";
  const authorName = isPlayer ? playerLabel : companionName;
  const initial = (Array.from(authorName)[0] ?? "").toUpperCase();
  const swipeInfo = message.swipeInfo;
  const openingVariant = message.openingVariant;
  const busy = pending !== null;
  // The Host published this only while the opening is still unlocked and the greeting set still
  // resolves; when it is sealed the control is absent rather than offered and refused.
  const openingChoice =
    !isPlayer && openingVariant !== undefined && !openingVariant.locked && openingVariant.count > 1
      ? openingVariant
      : undefined;

  return (
    <li
      className={`message ${isPlayer ? "player" : "companion"}`}
      data-handle={message.handle}
      {...(busy ? { "aria-busy": "true" as const, "data-pending": pending } : {})}
      {...(streaming ? { "data-streaming": "true" as const } : {})}
    >
      {/* The avatar is the row's first child on both sides, and the player's
          row is mirrored by `flex-direction: row-reverse` (style.css): the
          monogram ends up outside the bubble, hugging the outer boundary. */}
      <div className="avatar avatar-small" aria-hidden="true">
        {initial}
      </div>
      <div className="message-body">
        {/* The author line belongs to the companion only. The player's own
            monogram already sits at the row's edge, so printing the same name
            again above the bubble reads as "[你] 你: 你好" - the line is a
            duplicate of the avatar, not an attribution. The header also owns
            only companion controls, so it does not exist on the player's side
            at all; an empty box would still add the body column's gap above
            the bubble. */}
        {!isPlayer && (
          <div className="message-header">
            <span className="message-author">{authorName}</span>
            {openingChoice && (
              <div className="swipe-controls" aria-label={labels.swipeNavigation}>
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
                <span className="swipe-indicator">{`${openingChoice.index + 1}/${openingChoice.count}`}</span>
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
            {swipeInfo && swipeInfo.totalSwipes > 1 && (
              <div className="swipe-controls" aria-label={labels.swipeNavigation}>
                <button
                  type="button"
                  className="swipe-btn"
                  disabled={busy || !swipeInfo.hasPrevious}
                  onClick={() => onSwipe?.(message.handle, "prev")}
                  aria-label={labels.swipePrevious}
                  title={labels.swipePrevious}
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                </button>
                <span className="swipe-indicator">{swipeInfo.label}</span>
                <button
                  type="button"
                  className="swipe-btn"
                  disabled={busy || !swipeInfo.hasNext}
                  onClick={() => onSwipe?.(message.handle, "next")}
                  aria-label={labels.swipeNext}
                  title={labels.swipeNext}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        )}
        {/* Both sides author text, and a `*beat*` is the same format on both:
            the same sanitised Markdown renderer reads a person's words exactly as
            it reads the companion's, so the identical beat cannot render two ways. */}
        <MarkdownMessage className="message-bubble" text={message.text} trailingHtml={CARET_MARKUP} />
        {!isPlayer && onRegenerate && (
          <div className="message-actions">
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
          </div>
        )}
      </div>
    </li>
  );
});
