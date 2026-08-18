import { BookOpen, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Messages } from "../../i18n";
import type { WorldInfoEntry } from "../../types";

export function WorldInfoDrawer({
  isOpen,
  onClose,
  labels,
  entries,
  onAddEntry,
  onToggleEntry,
}: {
  isOpen: boolean;
  onClose: () => void;
  labels: Messages;
  entries: WorldInfoEntry[];
  onAddEntry: (key: string, title: string, content: string) => void;
  onToggleEntry: (id: string, enabled: boolean) => void;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");

  useEffect(() => {
    if (!isOpen) {
      setIsAdding(false);
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <>
      <div className="backdrop-overlay" onClick={onClose} aria-hidden="true" />
      <aside ref={drawerRef} className="context-panel" role="dialog" aria-modal="true" aria-label={labels.worldInfo}>
        <div className="drawer-header">
          <div className="drawer-title-group">
            <BookOpen size={20} aria-hidden="true" />
            <h2>{labels.worldInfo}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            title={labels.close}
            aria-label={labels.close}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="drawer-actions-bar">
          <button type="button" className="primary-button" onClick={() => setIsAdding(!isAdding)}>
            <Plus size={16} aria-hidden="true" />
            {labels.addEntry}
          </button>
        </div>

        <div className="drawer-content">
          {isAdding && (
            <div className="form-stack add-entry-form">
              <label className="form-field">
                <span className="form-label">{labels.entryKey}</span>
                <input
                  type="text"
                  className="form-input"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="e.g. Pelican Town / 星露谷"
                />
              </label>
              <label className="form-field">
                <span className="form-label">{labels.entryTitle}</span>
                <input
                  type="text"
                  className="form-input"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Entry Title"
                />
              </label>
              <label className="form-field">
                <span className="form-label">{labels.entryContent}</span>
                <textarea
                  className="form-textarea"
                  rows={4}
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="World lore background description..."
                />
              </label>
              <div className="button-group">
                <button
                  type="button"
                  className="small-button primary"
                  disabled={!newKey.trim() || !newContent.trim()}
                  onClick={() => {
                    onAddEntry(newKey.trim(), newTitle.trim() || newKey.trim(), newContent.trim());
                    setNewKey("");
                    setNewTitle("");
                    setNewContent("");
                    setIsAdding(false);
                  }}
                >
                  {labels.save}
                </button>
                <button type="button" className="small-button" onClick={() => setIsAdding(false)}>
                  {labels.close}
                </button>
              </div>
            </div>
          )}

          <div className="world-info-list" role="list">
            {entries.length === 0 ? (
              <p className="empty-subtle">{labels.noWorldInfo}</p>
            ) : (
              entries.map((entry) => (
                <div key={entry.id} className="world-info-card" role="listitem">
                  <div className="entry-header">
                    <span className="entry-key-tag">#{entry.key}</span>
                    <label className="switch-label">
                      <input
                        type="checkbox"
                        checked={entry.enabled}
                        onChange={(e) => onToggleEntry(entry.id, e.target.checked)}
                      />
                      <span className="switch-text">{labels.attachToChat}</span>
                    </label>
                  </div>
                  <h4 className="entry-title">{entry.title}</h4>
                  <p className="entry-content">{entry.content}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
