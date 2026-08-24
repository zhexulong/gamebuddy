import { Download, MessageSquare, MessageSquarePlus, Pencil, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Messages } from "../../i18n";
import type { ChatSummary } from "../../types";

export function ChatsDrawer({
  isOpen,
  onClose,
  labels,
  chats,
  currentChatHandle,
  onSelectChat,
  onNewChat,
  onExportChat,
  onRenameChat,
}: {
  isOpen: boolean;
  onClose: () => void;
  labels: Messages;
  chats: ChatSummary[];
  currentChatHandle: string;
  /** Absent in mounted profiles that mount no selection/switch operation. */
  onSelectChat?: (handle: string) => void;
  /** Absent in mounted profiles that mount no New Chat operation. */
  onNewChat?: () => void;
  /** Absent in mounted profiles that mount no export operation. */
  onExportChat?: (handle: string) => void;
  onRenameChat?: (handle: string, newTitle: string) => void;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const [editingHandle, setEditingHandle] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  useEffect(() => {
    if (!isOpen) {
      setEditingHandle(null);
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
      <aside ref={drawerRef} className="context-panel" role="dialog" aria-modal="true" aria-label={labels.chats}>
        <div className="drawer-header">
          <div className="drawer-title-group">
            <MessageSquare size={20} aria-hidden="true" />
            <h2>{labels.chats}</h2>
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
          {onNewChat !== undefined && (
            <button type="button" className="primary-button" onClick={onNewChat}>
              <MessageSquarePlus size={16} aria-hidden="true" />
              {labels.newChat}
            </button>
          )}
        </div>

        <div className="drawer-content">
          <div className="chat-list" role="list">
            {chats.length === 0 ? (
              <p className="empty-subtle">{labels.noChats}</p>
            ) : (
              chats.map((chat) => {
                const isSelected = chat.chatHandle === currentChatHandle;
                return (
                  <div
                    key={chat.chatHandle}
                    role="listitem"
                    className={`chat-item-card ${isSelected ? "selected" : ""}`}
                  >
                    {editingHandle === chat.chatHandle && onRenameChat !== undefined ? (
                      <div className="chat-rename-form">
                        <input
                          type="text"
                          className="form-input"
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          autoFocus
                        />
                        <div className="button-group">
                          <button
                            type="button"
                            className="small-button primary"
                            onClick={() => {
                              if (editingTitle.trim()) {
                                onRenameChat(chat.chatHandle, editingTitle.trim());
                              }
                              setEditingHandle(null);
                            }}
                          >
                            {labels.save}
                          </button>
                          <button type="button" className="small-button" onClick={() => setEditingHandle(null)}>
                            {labels.close}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="chat-item-main">
                        {onSelectChat !== undefined ? (
                          <button
                            type="button"
                            className="chat-select-btn"
                            onClick={() => onSelectChat(chat.chatHandle)}
                          >
                            <div className="chat-item-title">{chat.title}</div>
                            {chat.messageCount !== undefined && (
                              <div className="chat-item-meta">{chat.messageCount} messages</div>
                            )}
                          </button>
                        ) : (
                          <div className="chat-item-title">{chat.title}</div>
                        )}
                        <div className="chat-item-actions">
                          {onRenameChat !== undefined && (
                            <button
                              type="button"
                              className="icon-button-small"
                              title={labels.renameChat}
                              onClick={() => {
                                setEditingHandle(chat.chatHandle);
                                setEditingTitle(chat.title);
                              }}
                            >
                              <Pencil size={14} aria-hidden="true" />
                            </button>
                          )}
                          {onExportChat !== undefined && (
                            <button
                              type="button"
                              className="icon-button-small"
                              title={labels.exportChat}
                              onClick={() => onExportChat(chat.chatHandle)}
                            >
                              <Download size={14} aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
