import { Brain, RotateCcw, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Messages } from "../../i18n";
import type { SemanticMemoryItem } from "../../types";

export function MemoryDrawer({
  isOpen,
  onClose,
  labels,
  memories,
  onRefreshMemory,
}: {
  isOpen: boolean;
  onClose: () => void;
  labels: Messages;
  memories: SemanticMemoryItem[];
  onRefreshMemory: () => void;
}) {
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!isOpen) return;
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
      <aside
        ref={drawerRef}
        className="context-panel"
        role="dialog"
        aria-modal="true"
        aria-label={labels.semanticMemory}
      >
        <div className="drawer-header">
          <div className="drawer-title-group">
            <Brain size={20} aria-hidden="true" />
            <h2>{labels.semanticMemory}</h2>
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
          <button type="button" className="small-button" onClick={onRefreshMemory}>
            <RotateCcw size={14} aria-hidden="true" />
            {labels.refreshMemory}
          </button>
        </div>

        <div className="drawer-content">
          <div className="memory-list" role="list">
            {memories.length === 0 ? (
              <p className="empty-subtle">{labels.noMemories}</p>
            ) : (
              memories.map((mem) => (
                <div key={mem.id} className="memory-item-card" role="listitem">
                  <div className="memory-header">
                    <span className={`status-tag ${mem.status}`}>
                      {mem.status === "permanent" ? "Permanent" : "Active"}
                    </span>
                    <span className="memory-time">{new Date(mem.recordedAtMs).toLocaleDateString()}</span>
                  </div>
                  <p className="memory-fact">{mem.fact}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
