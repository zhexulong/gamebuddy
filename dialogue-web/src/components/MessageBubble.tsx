import { memo } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import type { BrowserMessageV1 } from "../reference-pipeline-api";
import { MarkdownMessage } from "./MarkdownMessage";

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
  pending = null,
  labels,
}: {
  message: BrowserMessageV1;
  companionName: string;
  playerLabel: string;
  onSwipe?: (messageHandle: string, direction: "prev" | "next") => void;
  onRegenerate?: (messageHandle: string) => void;
  /**
   * The mutation this exact message is waiting on, if any. While it is set the
   * message's own controls are disabled: the shell already guards against a second
   * command with its single-flight ref, and the control saying so is what keeps a
   * double click from looking like it did nothing.
   */
  pending?: "swipe" | "regenerate" | null;
  labels: Readonly<{
    swipeNavigation: string;
    swipePrevious: string;
    swipeNext: string;
    regenerateVariant: string;
  }>;
}) {
  const isPlayer = message.role === "player";
  const authorName = isPlayer ? playerLabel : companionName;
  const initial = authorName.slice(0, 1).toUpperCase();
  const swipeInfo = message.swipeInfo;
  const busy = pending !== null;

  return (
    <li
      className={`message ${isPlayer ? "player" : "companion"}`}
      data-handle={message.handle}
      {...(busy ? { "aria-busy": "true" as const, "data-pending": pending } : {})}
    >
      {!isPlayer && (
        <div className="avatar avatar-small" aria-hidden="true">
          {initial}
        </div>
      )}
      <div className="message-body">
        <div className="message-header">
          <span className="message-author">{authorName}</span>
          {!isPlayer && swipeInfo && swipeInfo.totalSwipes > 1 && (
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
        {isPlayer ? (
          // The player's own words are literal input, not model output: they stay
          // text, so the companion's narration treatment is never applied to them.
          <div className="message-bubble">{message.text}</div>
        ) : (
          <MarkdownMessage className="message-bubble" text={message.text} />
        )}
        {!isPlayer && onRegenerate && (
          <div className="message-actions">
            <button
              type="button"
              className="action-btn regenerate-btn"
              disabled={busy}
              onClick={() => onRegenerate(message.handle)}
              title={labels.regenerateVariant}
              aria-label={labels.regenerateVariant}
            >
              <RefreshCw size={14} aria-hidden="true" />
              {labels.regenerateVariant}
            </button>
          </div>
        )}
      </div>
      {isPlayer && (
        <div className="avatar avatar-small" aria-hidden="true">
          {initial}
        </div>
      )}
    </li>
  );
});
