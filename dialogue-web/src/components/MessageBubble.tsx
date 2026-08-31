import type { BrowserMessageV1 } from "../reference-pipeline-api";

export function MessageBubble({
  message,
  companionName,
  playerLabel,
}: {
  message: BrowserMessageV1;
  companionName: string;
  playerLabel: string;
}) {
  const isPlayer = message.role === "player";
  const authorName = isPlayer ? playerLabel : companionName;
  const initial = authorName.slice(0, 1).toUpperCase();

  return (
    <li className={`message ${isPlayer ? "player" : "companion"}`} data-handle={message.handle}>
      {!isPlayer && (
        <div className="avatar avatar-small" aria-hidden="true">
          {initial}
        </div>
      )}
      <div className="message-body">
        <span className="message-author">{authorName}</span>
        <div className="message-bubble">{message.text}</div>
      </div>
      {isPlayer && (
        <div className="avatar avatar-small" aria-hidden="true">
          {initial}
        </div>
      )}
    </li>
  );
}
