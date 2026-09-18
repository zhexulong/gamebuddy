import { Mic, MicOff, SendHorizontal, Square } from "lucide-react";
import { type ChangeEvent, type KeyboardEvent, useEffect, useRef } from "react";
import type { Messages } from "../i18n";

/** Voice surface narrow state from the additive optional snapshot field. */
export type VoiceSurfaceStateV1 = Readonly<{ state: "unavailable" | "ready" | "speaking" }>;

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  isGenerating,
  disabled,
  labels,
  voice,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  isGenerating: boolean;
  disabled?: boolean;
  labels: Messages;
  /** Additive optional voice surface; absent null renders no mic icon. */
  voice?: VoiceSurfaceStateV1 | null;
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
          {voice !== undefined && voice !== null && (
            <span
              className={
                voice.state === "speaking"
                  ? "voice-status-dot voice-status-speaking"
                  : voice.state === "ready"
                    ? "voice-status-dot voice-status-ready"
                    : "voice-status-dot voice-status-unavailable"
              }
              title={labels.voiceReady}
              aria-label={
                voice.state === "speaking"
                  ? labels.voiceSpeaking
                  : voice.state === "ready"
                    ? labels.voiceReady
                    : labels.voiceUnavailable
              }
            >
              {voice.state === "unavailable" ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
            </span>
          )}
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
