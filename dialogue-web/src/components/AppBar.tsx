import { BookOpen, Brain, MessageSquare, Settings, User, UserCircle } from "lucide-react";
import type { Messages } from "../i18n";
import type { ActivePanel } from "../types";

export function AppBar({
  companionName,
  activePanel,
  onOpenPanel,
  labels,
  settingsButtonRef,
  isReadOnly = false,
}: {
  companionName: string;
  activePanel: ActivePanel;
  onOpenPanel: (panel: ActivePanel) => void;
  labels: Messages;
  settingsButtonRef?: React.RefObject<HTMLButtonElement | null>;
  isReadOnly?: boolean;
}) {
  const monogram = companionName.trim().slice(0, 1).toUpperCase() || "C";
  const isSettingsOpen = activePanel === "settings";

  return (
    <header className="app-bar" role="banner">
      <div className="brand-group">
        <div className="brand-mark" aria-hidden="true">
          GB
        </div>
        <span className="brand-title">{labels.appName}</span>
      </div>

      <div className="companion-context">
        <div className="companion-avatar" aria-hidden="true">
          {monogram}
        </div>
        <div className="companion-info">
          <span className="companion-name">{companionName}</span>
          {isReadOnly ? (
            <span className="read-only-badge">{labels.readOnlyChat}</span>
          ) : (
            <span className="online-badge">
              <span className="status-dot" aria-hidden="true" />
              {labels.online}
            </span>
          )}
        </div>
      </div>

      <div className="app-bar-actions">
        {!isReadOnly && (
          <>
            <button
              type="button"
              className={`nav-button ${activePanel === "chats" ? "active" : ""}`}
              onClick={() => onOpenPanel(activePanel === "chats" ? "none" : "chats")}
              title={labels.chats}
              aria-label={labels.chats}
            >
              <MessageSquare size={18} aria-hidden="true" />
              <span className="nav-label">{labels.chats}</span>
            </button>

            <button
              type="button"
              className={`nav-button ${activePanel === "characters" ? "active" : ""}`}
              onClick={() => onOpenPanel(activePanel === "characters" ? "none" : "characters")}
              title={labels.characters}
              aria-label={labels.characters}
            >
              <User size={18} aria-hidden="true" />
              <span className="nav-label">{labels.characters}</span>
            </button>

            <button
              type="button"
              className={`nav-button ${activePanel === "persona" ? "active" : ""}`}
              onClick={() => onOpenPanel(activePanel === "persona" ? "none" : "persona")}
              title={labels.persona}
              aria-label={labels.persona}
            >
              <UserCircle size={18} aria-hidden="true" />
              <span className="nav-label">{labels.persona}</span>
            </button>

            <button
              type="button"
              className={`nav-button ${activePanel === "worldInfo" ? "active" : ""}`}
              onClick={() => onOpenPanel(activePanel === "worldInfo" ? "none" : "worldInfo")}
              title={labels.worldInfo}
              aria-label={labels.worldInfo}
            >
              <BookOpen size={18} aria-hidden="true" />
              <span className="nav-label">{labels.worldInfo}</span>
            </button>

            <button
              type="button"
              className={`nav-button ${activePanel === "memory" ? "active" : ""}`}
              onClick={() => onOpenPanel(activePanel === "memory" ? "none" : "memory")}
              title={labels.memory}
              aria-label={labels.memory}
            >
              <Brain size={18} aria-hidden="true" />
              <span className="nav-label">{labels.memory}</span>
            </button>
          </>
        )}

        <button
          ref={settingsButtonRef}
          type="button"
          className={`icon-button ${isSettingsOpen ? "active" : ""}`}
          onClick={() => onOpenPanel(isSettingsOpen ? "none" : "settings")}
          title={labels.settings}
          aria-label={labels.settings}
          aria-expanded={isSettingsOpen}
        >
          <Settings size={20} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
