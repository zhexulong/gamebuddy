import type { BrowserMessageV1 } from "../reference-pipeline-api";

export function MessageBubble({
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
        <div className="message-bubble">{message.text}</div>
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
}

