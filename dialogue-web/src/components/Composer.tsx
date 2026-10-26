import { FileText, LoaderCircle, Mic, MicOff, SendHorizontal, SlidersHorizontal, Square } from "lucide-react";
import { type ChangeEvent, type KeyboardEvent, type Ref, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Messages } from "../i18n";

/** Voice surface narrow state from the additive optional snapshot field. */
export type VoiceSurfaceStateV1 = Readonly<{ state: "unavailable" | "ready" | "speaking" }>;

/**
 * The durable draft's authoring controls, folded into the composer (design/26
 * §4.2 writes the draft on the conversation, and the composer band is where the
 * conversation's writing happens).
 *
 * The draft is not a second editor: when a durable draft exists the composer's
 * own field is prefilled with it, so the player edits the draft *in the input
 * they would otherwise send* - and a resident block in the reading flow (the
 * failure this replaces) is exactly what an instant-messaging surface must not
 * have between the transcript and the input.
 */
export type ComposerDraftActions = Readonly<{
  onSave: () => void;
  onDiscard: () => void;
  /**
   * True while the Host holds a durable draft for this conversation. It is the
   * one fact the row is rendered from: Discard is only meaningful for a draft
   * that exists, and the row itself only has something to do while there is a
   * draft, fresh text, or an outcome to report.
   */
  durable: boolean;
  /** The closed outcome line the last save/discard reported, if any. */
  notice: Readonly<{ kind: "success" | "failure"; text: string }> | null;
}>;

/**
 * The one control that opens this surface's model settings, as a popout
 * (design/104 §3: the model a surface uses belongs on that surface). It sits in
 * the send-form action row - the same place the vendor's own front ends keep
 * their icon-button rail - so the reading column pays no height for it.
 */
export type ComposerSettingsAction = Readonly<{
  label: string;
  expanded: boolean;
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
}>;

/**
 * The compact band's own breakpoint (the width the app bar retires its brand
 * word at). The field is 212 px wide at a 400 px viewport, where the wide
 * catalogue's hint needs three lines and advises a keystroke no phone has; the
 * compact wording is one line and drops the keystroke. Nothing else about the
 * composer changes with the width - only which sentence is written on it.
 */
const COMPACT_COMPOSER_QUERY = "(max-width: 640px)";

function useCompactComposer(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== "undefined" && window.matchMedia(COMPACT_COMPOSER_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(COMPACT_COMPOSER_QUERY);
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  isGenerating,
  canStop,
  disabled,
  sendUnavailable = false,
  labels,
  voice,
  draftActions,
  settingsAction,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  /**
   * True while a turn is in flight for this conversation - from the submission
   * being admitted until the authoritative turn reaches a terminal state. It is
   * that fact itself, and not "the Host lets me cancel it": the two differ for the
   * whole queued window, and reading the second as the first is what made a queued
   * turn render a disabled send button with no spinner and no stop.
   */
  isGenerating: boolean;
  /**
   * True only while the Host says this exact turn can be cancelled. It decides
   * whether the busy slot offers Stop; a turn in flight without it still says so.
   */
  canStop: boolean;
  disabled?: boolean;
  /**
   * True when a send would have no model to reach - the surface's `ChatModelRoute` says `none`.
   *
   * It locks the send button and leaves the field writable: the player can compose and keep a draft
   * while they go and bring a connection, and the surface's own standing sentence says so above this
   * row. Locking the field instead would take away the one thing that still works, and letting the
   * send through is what left a no-model turn in the transcript as a dead exchange.
   */
  sendUnavailable?: boolean;
  labels: Messages;
  /** Additive optional voice surface; absent null renders no mic icon. */
  voice?: VoiceSurfaceStateV1 | null;
  /**
   * Present whenever this surface can author a durable draft; the row itself is
   * conditional. `durable` is the fact it is rendered from: a player who has
   * typed nothing into a chat without a durable draft has nothing to save yet,
   * and Discard only exists for a draft that does.
   */
  draftActions?: ComposerDraftActions;
  /** Present when this surface has model settings to open. */
  settingsAction?: ComposerSettingsAction;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const placeholder = useCompactComposer() ? labels.typeMessagePlaceholderCompact : labels.typeMessagePlaceholder;

  // The row exists while there is something for it to do: a durable draft to
  // save or discard, freshly typed text to keep as a first draft, or a *failed*
  // attempt with nothing else left to report it. A success does not need the
  // clause - saving leaves a durable draft behind and discarding takes the row
  // with the draft, which is the contract the row already had.
  const showDraftRow =
    draftActions !== undefined &&
    (draftActions.durable || value.trim().length > 0 || draftActions.notice?.kind === "failure");

  const voiceLabel =
    voice?.state === "speaking"
      ? labels.voiceSpeaking
      : voice?.state === "ready"
        ? labels.voiceReady
        : labels.voiceUnavailable;

  // Height is recomputed before paint on every value change so the textarea
  // grows and shrinks with the drafted text without a visible jump.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const nextHeight = Math.min(Math.max(el.scrollHeight, 48), 176);
    el.style.height = `${nextHeight}px`;
  }, [value]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // An Enter that confirms an IME candidate is not a send: the composed text
    // is still being edited, so the existing Enter/Shift+Enter paths are skipped.
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isGenerating && value.trim() && !disabled && !sendUnavailable) {
        onSend();
      }
    }
  };

  return (
    <section className="composer-section" aria-label={labels.typeMessagePlaceholder}>
      {showDraftRow && draftActions !== undefined && (
        // The row is the draft's own verbs, in the composer band the draft is
        // edited in, and it disappears with the draft instead of occupying the
        // reading flow while there is nothing to save or discard. Save is
        // offered as soon as there is text to keep - including the first draft
        // of a chat that has none, which is the same `draft.save` command under
        // the same revision CAS the Host already serves. Discard is only
        // meaningful for a draft that exists, so it is only rendered then.
        <div className="composer-draft" data-draft-actions>
          <span className="composer-draft-label">
            <FileText size={14} aria-hidden="true" />
            {draftActions.durable ? labels.savedDraft : labels.unsavedDraft}
          </span>
          <button
            type="button"
            className="small-button"
            disabled={value.trim().length === 0}
            onClick={draftActions.onSave}
          >
            {labels.save}
          </button>
          {draftActions.durable && (
            // Only a draft that exists can be discarded; with none, the row
            // offers Save alone rather than a Discard that has nothing to clear.
            <button type="button" className="small-button" onClick={draftActions.onDiscard}>
              {labels.discard}
            </button>
          )}
          {draftActions.notice !== null && (
            <span role="status" className={draftActions.notice.kind === "success" ? "success-banner" : "error-banner"}>
              {draftActions.notice.text}
            </span>
          )}
        </div>
      )}
      <div className="composer-container">
        <textarea
          ref={textareaRef}
          className="composer-textarea"
          value={value}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          // The field's own lock is the Host's answer to "would a submission be
          // accepted now" (`disabled` = `!submitAvailable`, which is false while a
          // turn exists because the Host projects `chat.submit` as busy then). A
          // turn in flight is therefore shown by the action slot below, not by a
          // second, client-side lock here: the poll's own budget ending must leave
          // the field usable the moment the Host would take a message again.
          disabled={disabled}
          aria-label={placeholder}
        />
        <div className="composer-actions">
          {settingsAction !== undefined && (
            <button
              ref={settingsAction.ref}
              type="button"
              className="icon-button composer-settings-button"
              aria-haspopup="dialog"
              aria-expanded={settingsAction.expanded}
              data-testid="chat-model-trigger"
              title={settingsAction.label}
              aria-label={settingsAction.label}
              onClick={settingsAction.onClick}
            >
              <SlidersHorizontal size={18} aria-hidden="true" />
            </button>
          )}
          {voice !== undefined && voice !== null && (
            // Host and client agree on exactly three states (`unavailable`,
            // `ready`, `speaking`); richer facts (consent, device) live on the
            // management voice-preference route, not on the chat snapshot. The
            // state is projected as a readable label, not only as a dot, so a
            // player who does not hover still learns what the surface can do.
            <span className="voice-status" data-voice-state={voice.state} role="status" title={voiceLabel}>
              <span
                className={
                  voice.state === "speaking"
                    ? "voice-status-dot voice-status-speaking"
                    : voice.state === "ready"
                      ? "voice-status-dot voice-status-ready"
                      : "voice-status-dot voice-status-unavailable"
                }
                aria-hidden="true"
              >
                {voice.state === "unavailable" ? (
                  <MicOff size={16} aria-hidden="true" />
                ) : (
                  <Mic size={16} aria-hidden="true" />
                )}
                {/* The only active-audio state this wire carries is `speaking`,
                    so the pulse ring is keyed to exactly that Host reading and
                    to nothing else. There is no recording/capturing state on
                    `tavern_browser_api/v1` to animate, and the browser's own
                    MediaRecorder is not a Host fact. Decorative: the state's
                    readable label above is the carrier (style.css). */}
                {voice.state === "speaking" && <span className="voice-pulse-ring" data-voice-pulse="" />}
              </span>
              <span className="voice-status-label">{voiceLabel}</span>
            </span>
          )}
          {isGenerating ? (
            canStop ? (
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
              // A turn the Host has admitted but does not allow cancelling
              // (`accepted_queued`, `attempt_starting`, a claimed cancel, a
              // presented response) is still a turn in flight. The slot says so
              // rather than falling back to the send icon, which is disabled while
              // a turn is in flight and read as a frozen UI for that whole window.
              <span
                className="composer-button composer-busy"
                role="status"
                aria-label={labels.generating}
                title={labels.generating}
                data-composer-busy
              >
                <LoaderCircle className="message-spinner" size={18} aria-hidden="true" />
              </span>
            )
          ) : (
            <button
              type="button"
              className="composer-button send-button"
              onClick={onSend}
              disabled={disabled || sendUnavailable || !value.trim()}
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
