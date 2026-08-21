import { SendHorizontal, Square } from "lucide-react";
import { type ChangeEvent, type KeyboardEvent, useEffect, useRef } from "react";
import type { Messages } from "../i18n";

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  isGenerating,
  disabled,
  labels,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  isGenerating: boolean;
  disabled?: boolean;
  labels: Messages;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const nextHeight = Math.min(Math.max(el.scrollHeight, 48), 176);
    el.style.height = `${nextHeight}px`;
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isGenerating && value.trim() && !disabled) {
        onSend();
      }
    }
  };

  return (
    <section className="composer-section" aria-label={labels.typeMessagePlaceholder}>
      <div className="composer-container">
        <textarea
          ref={textareaRef}
          className="composer-textarea"
          value={value}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={labels.typeMessagePlaceholder}
          rows={1}
          disabled={disabled || isGenerating}
          aria-label={labels.typeMessagePlaceholder}
        />
        <div className="composer-actions">
          {isGenerating ? (
            <button
              type="button"
              className="composer-button stop-button"
              onClick={onStop}
              title={labels.stop}
              aria-label={labels.stop}
            >
              <Square size={18} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="composer-button send-button"
              onClick={onSend}
              disabled={disabled || !value.trim()}
              title={labels.send}
              aria-label={labels.send}
            >
              <SendHorizontal size={18} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
