import { Archive, Download, MessageSquare, MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import { useState, type RefObject } from "react";
import type { Messages } from "../../i18n";
import type { ChatSummary } from "../../types";
import { ContextDrawer } from "../ContextDrawer";

/**
 * The Chats panel (design/26 §4.2, §4.3): the current chat, Chat History, and
 * New Chat. It renders only the commands the mounted profile publishes - a
 * profile with no selection route shows no `Open`, one with no lifecycle routes
 * shows no retention buttons - so a player never sees a control the Host cannot
 * serve (design/26 §4.3, §1).
 *
 * The drawer mechanics are the shared `ContextDrawer` (focus trap, Escape,
 * backdrop, focus restore); this component owns only the chat list.
 */
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
  onTransitionChat,
  onRestoreChat,
  restoreFocusTo,
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
  /**
   * Chat lifecycle retention (archive/trash) for the exact mounted chat; the
   * service only ever transitions the mounted chat. Absent when the mounted
   * profile does not publish the retention routes.
   */
  onTransitionChat?: (handle: string, operation: "archive" | "trash") => void;
  /** Published only when the profile mounts the restore route (design/28 §2.1). */
  onRestoreChat?: (handle: string) => void;
  /** The AppBar entry that opened this drawer; focus returns here on close. */
  restoreFocusTo?: RefObject<HTMLElement | null>;
}) {
  const [editingHandle, setEditingHandle] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  if (!isOpen) return null;

  const close = (): void => {
    setEditingHandle(null);
    onClose();
  };

  return (
    <ContextDrawer
      title={labels.chats}
      closeLabel={labels.close}
      onClose={close}
      testId="chats-drawer"
      icon={MessageSquare}
      {...(restoreFocusTo === undefined ? {} : { restoreFocusTo })}
      actions={
        onNewChat === undefined ? null : (
          <button type="button" className="primary-button" onClick={onNewChat}>
            <MessageSquarePlus size={16} aria-hidden="true" />
            {labels.newChat}
          </button>
        )
      }
    >
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
                  <>
                    <input
                      type="text"
                      className="form-input"
                      aria-label={labels.renameChat}
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
                  </>
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
                      {onTransitionChat !== undefined && isSelected && (
                        <>
                          <button
                            type="button"
                            className="icon-button-small"
                            title={labels.chatRetentionArchive}
                            aria-label={labels.chatRetentionArchive}
                            onClick={() => onTransitionChat(chat.chatHandle, "archive")}
                          >
                            <Archive size={14} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="icon-button-small"
                            title={labels.chatRetentionTrash}
                            aria-label={labels.chatRetentionTrash}
                            onClick={() => onTransitionChat(chat.chatHandle, "trash")}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        </>
                      )}
                      {onRestoreChat !== undefined && !isSelected && (
                        <button
                          type="button"
                          className="icon-button-small"
                          title={labels.chatRetentionRestore}
                          aria-label={labels.chatRetentionRestore}
                          onClick={() => onRestoreChat(chat.chatHandle)}
                        >
                          <Archive size={14} aria-hidden="true" />
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
    </ContextDrawer>
  );
}
