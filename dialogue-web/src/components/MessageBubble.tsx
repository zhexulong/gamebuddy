import { memo } from "react";
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
}: {
  message: BrowserMessageV1;
  companionName: string;
  playerLabel: string;
  onSwipe?: (messageHandle: string, direction: "prev" | "next") => void;
  onRegenerate?: (messageHandle: string) => void;
}) {
  const isPlayer = message.role === "player";
  const authorName = isPlayer ? playerLabel : companionName;
  const initial = authorName.slice(0, 1).toUpperCase();
  const swipeInfo = message.swipeInfo;

  return (
    <li className={`message ${isPlayer ? "player" : "companion"}`} data-handle={message.handle}>
      {!isPlayer && (
        <div className="avatar avatar-small" aria-hidden="true">
          {initial}
        </div>
      )}
      <div className="message-body">
        <div className="message-header">
          <span className="message-author">{authorName}</span>
          {!isPlayer && swipeInfo && swipeInfo.totalSwipes > 1 && (
            <div className="swipe-controls" aria-label="Swipe navigation">
              <button
                type="button"
                className="swipe-btn"
                disabled={!swipeInfo.hasPrevious}
                onClick={() => onSwipe?.(message.handle, "prev")}
                aria-label="Previous swipe"
                title="Previous variant"
              >
                ◀
              </button>
              <span className="swipe-indicator">{swipeInfo.label}</span>
              <button
                type="button"
                className="swipe-btn"
                disabled={!swipeInfo.hasNext}
                onClick={() => onSwipe?.(message.handle, "next")}
                aria-label="Next swipe"
                title="Next variant"
              >
                ▶
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
              onClick={() => onRegenerate(message.handle)}
              title="重新生成 (Regenerate variant)"
              aria-label="Regenerate variant"
            >
              🔄 重新生成
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
