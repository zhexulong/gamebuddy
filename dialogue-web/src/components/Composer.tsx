import { FileText, Mic, MicOff, SendHorizontal, SlidersHorizontal, Square } from "lucide-react";
import { type ChangeEvent, type KeyboardEvent, type Ref, useId, useLayoutEffect, useRef, useState } from "react";
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
 * The card's own openings, offered on a conversation that has not started yet.
 *
 * The chips are not a second composer and they are not reviewer-invented
 * starters: each one is one of the character card's own opening lines, read from
 * the companion's greeting record, and tapping it says exactly that line through
 * this composer's one submit path. The chip's *visible* label is that opening's
 * own short first sentence, so the first screen is a row of invitations and not
 * the card's paragraphs, while what a tap sends stays the opening verbatim. The
 * chips live in the composer band rather than in the reading flow because the
 * conversation column is the transcript and the composer and nothing else, and
 * they leave with the first message.
 */
export type ComposerChips = Readonly<{
  /** The group's own name: the card's word for this material, never a sentence. */
  label: string;
  items: readonly Readonly<{
    id: string;
    /** The card's own opening line: exactly what the chip sends, and the source
     * of the short label it shows (see `chipLabel`). */
    text: string;
    onClick: () => void;
  }>[];
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
 * The chip's visible label: the opening's own first sentence, cut to
 * `CHIP_LABEL_MAX` characters on a word boundary.
 *
 * The chip's rendered content used to be the whole opening, so a card's own
 * paragraph reached the first screen as a single-line slab - measured on a fresh
 * root at 4578 / 3161 / 3315 px, one per variant - which is the wall of prose
 * the owner rejected. The label is derived from the card's text, never authored
 * here, and the text the chip records and sends is the opening verbatim (the
 * `title` and the preview a hover or focus reveals below).
 */
const CHIP_LABEL_MAX = 32;
function chipLabel(text: string): string {
  const normalized = text
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\*+/u, "");
  const firstSentence = /^[^。！？!?]*[。！？!?]/u.exec(normalized)?.[0] ?? normalized;
  if (firstSentence.length <= CHIP_LABEL_MAX) return firstSentence;
  const cut = firstSentence.slice(0, CHIP_LABEL_MAX);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  isGenerating,
  disabled,
  labels,
  voice,
  draftActions,
  settingsAction,
  chips,
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
  /**
   * Present whenever this surface can author a durable draft; the row itself is
   * conditional. `durable` is the fact it is rendered from: a player who has
   * typed nothing into a chat without a durable draft has nothing to save yet,
   * and Discard only exists for a draft that does.
   */
  draftActions?: ComposerDraftActions;
  /** Present when this surface has model settings to open. */
  settingsAction?: ComposerSettingsAction;
  /**
   * The card's own openings, rendered directly above the input. Absent (or
   * empty) when the card carries no opening material: this composer never
   * invents a line the card did not carry.
   */
  chips?: ComposerChips;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chipsLabelId = useId();
  // The opening a player is currently reading: hovering or focusing a chip shows
  // its whole text above the row, so nothing has to be sent to see what would be.
  const [previewChipId, setPreviewChipId] = useState<string | null>(null);
  const previewChip = chips?.items.find((item) => item.id === previewChipId) ?? null;

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
      if (!isGenerating && value.trim() && !disabled) {
        onSend();
      }
    }
  };

  return (
    <section className="composer-section" aria-label={labels.typeMessagePlaceholder}>
      {chips !== undefined && chips.items.length > 0 && (
        <div className="composer-chips">
          <span className="composer-chips-label" id={chipsLabelId}>
            {chips.label}
          </span>
          <div className="composer-chips-row" role="group" aria-labelledby={chipsLabelId}>
            {chips.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="composer-chip"
                // The chip shows its opening's first words. The text it carries
                // is the card's opening, whole, in the tooltip here and in the
                // preview the hover/focus below reveals; nothing local replaces
                // it, and the tap still sends exactly that text.
                title={item.text}
                aria-label={labels.openingChipUse.replace("{{opening}}", chipLabel(item.text))}
                onMouseEnter={() => setPreviewChipId(item.id)}
                onMouseLeave={() => setPreviewChipId(null)}
                onFocus={() => setPreviewChipId(item.id)}
                onBlur={() => setPreviewChipId(null)}
                onClick={item.onClick}
              >
                {chipLabel(item.text)}
              </button>
            ))}
          </div>
          {previewChip !== null && (
            <p className="composer-chip-preview" data-chip-preview={previewChip.id}>{previewChip.text}</p>
          )}
        </div>
      )}
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
            <span
              role="status"
              className={draftActions.notice.kind === "success" ? "success-banner" : "error-banner"}
            >
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
          placeholder={labels.typeMessagePlaceholder}
          rows={1}
          disabled={disabled || isGenerating}
          aria-label={labels.typeMessagePlaceholder}
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
            <span
              className="voice-status"
              data-voice-state={voice.state}
              role="status"
              title={voiceLabel}
            >
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
                {voice.state === "unavailable" ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
                {/* The only active-audio state this wire carries is `speaking`,
                    so the pulse ring is keyed to exactly that Host reading and
                    to nothing else. There is no recording/capturing state on
                    `tavern_browser_api/v1` to animate, and the browser's own
                    MediaRecorder is not a Host fact. Decorative: the state's
                    readable label above is the carrier (style.css). */}
                {voice.state === "speaking" && (
                  <span className="voice-pulse-ring" data-voice-pulse="" />
                )}
              </span>
              <span className="voice-status-label">{voiceLabel}</span>
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
