import { memo, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle, Pencil, RefreshCw, Trash2, Undo2 } from "lucide-react";
import type { BrowserMessageV1 } from "../reference-pipeline-api";
import { browserMessageLanguageTag } from "../reference-pipeline-api";
import { CompanionAvatar } from "./CompanionAvatar";
import { MarkdownMessage } from "./MarkdownMessage";
import { openingVariantWords } from "./opening-variant-labels";

/**
 * The live-streaming caret, inserted into the companion bubble's last block. The
 * bubble is Markdown rendered through `dangerouslySetInnerHTML`, so the caret is
 * placed into that sanitised HTML rather than passed as a React child; and it is
 * placed on every render, not only while streaming, so the preview's and the
 * committed message's bytes stay identical. Only `[data-streaming]` styles it, so
 * an idle bubble carries an inert, zero-size span.
 */
const CARET_MARKUP = '<span class="message-caret" aria-hidden="true"></span>';

/*
 * The opening switcher's words are the shared greeting-variant vocabulary
 * (`opening-variant-labels.ts`): the name the Host published for the opening the
 * player is looking at, plus the position that says how many there are.
 */

/**
 * The swipe switcher's own words. The Host publishes the position as the plain `1/3`
 * (`formatSwipeLabel`, `host/src/tavern/message-tree.ts:94-101`, used by both the swipe route and
 * the state projection). The pair of arrows around it belongs to this control, which draws real
 * ones - so a label that still arrives in the older `◀ 1/3 ▶` spelling (a browser journey's own
 * fixture) has only that decoration read back out, and the position itself is shown exactly as
 * the Host published it.
 */
function swipePosition(label: string): string {
  return label.replace(/^[\s◀]+/u, "").replace(/[\s▶]+$/u, "");
}

/**
 * Memoised so a streaming delta - which re-renders the conversation with a new
 * preview - cannot re-render a settled message and re-parse its Markdown. The
 * transcript's message objects are immutable and keep their identity across a
 * preview-only update, so the default shallow comparison is enough; `Timeline`
 * keeps the handler identities stable for the same reason.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  companionName,
  companionHandle,
  playerLabel,
  onSwipe,
  onRegenerate,
  onOpeningVariant,
  onRewind,
  onRewindConfirm,
  onRewindCancel,
  rewindArmed = false,
  onEdit,
  onDelete,
  onDeleteConfirm,
  onDeleteCancel,
  deleteArmed = false,
  removedCount = 0,
  pending = null,
  streaming = false,
  waitingNote = null,
  as = "li",
  labels,
}: {
  message: BrowserMessageV1;
  companionName: string;
  /** The mounted companion's own roster handle: how her picture is addressed. */
  companionHandle: string | null;
  playerLabel: string;
  onSwipe?: (messageHandle: string, direction: "prev" | "next") => void;
  onRegenerate?: (messageHandle: string) => void;
  /**
   * The new-chat opening choice: it is offered only where the Host published an unlocked
   * `openingVariant`, and it calls the Host's own route rather than holding the choice here.
   */
  onOpeningVariant?: (messageHandle: string, direction: "prev" | "next") => void;
  /**
   * The rewind control's first half: it removes this message and everything after it, so the click
   * only ARMS the action and the confirm below the prompt is what sends it. The accessor is handed
   * the order the page rendered this message at, because the Host refuses a message that is no
   * longer there - the transcript is what a position means.
   */
  onRewind?: (messageHandle: string, expectedOrder: number) => void;
  onRewindConfirm?: (messageHandle: string, expectedOrder: number) => void;
  onRewindCancel?: () => void;
  /** True for the one message whose rewind is armed: its strip becomes that confirmation. */
  rewindArmed?: boolean;
  /**
   * The edit control's save. The player's own message carries the text they rewrote AND the order the
   * page rendered it at, because the Host refuses a row that has moved. The editor itself is this
   * row's own presentation state - it opens on the field the words came from - and the callback hands
   * the new text up when they save; the authoritative reread, not a local guess, owns what the
   * transcript then shows.
   */
  onEdit?: (messageHandle: string, expectedOrder: number, text: string) => void;
  /**
   * The delete control's first half: it removes this ONE message, out of the middle of the
   * conversation, so the click only ARMS the action and the confirm is what sends it - the same shape
   * the rewind control and a Chats row's own trash use. The accessor is handed the order the page
   * rendered this message at, because the Host refuses a message that is no longer there.
   */
  onDelete?: (messageHandle: string, expectedOrder: number) => void;
  onDeleteConfirm?: (messageHandle: string, expectedOrder: number) => void;
  onDeleteCancel?: () => void;
  /** True for the one message whose delete is armed: its strip becomes that confirmation. */
  deleteArmed?: boolean;
  /**
   * How many messages this point would remove, counted from the transcript this bubble belongs to.
   * It is what the control's accessible name says the press will remove, before it is pressed; zero
   * (a caller that could not count, or a row that is not part of the transcript) offers no control.
   */
  removedCount?: number;
  /**
   * The mutation this exact message is waiting on, if any. While it is set the
   * message's own controls are disabled: the shell already guards against a second
   * command with its single-flight ref, and the control saying so is what keeps a
   * double click from looking like it did nothing.
   */
  pending?: "swipe" | "regenerate" | "opening" | "rewind" | "edit" | "delete" | null;
  /**
   * True only for the live streaming preview: the bubble then carries the
   * reading caret. The caret is inserted into the bubble's last block on every
   * render - only `[data-streaming]` styles it - so it trails the reply's last
   * character and the preview's and the committed message's bytes stay identical.
   */
  streaming?: boolean;
  /**
   * The optimistic player row's own word under the bubble ("sending"), while the
   * Host has not answered yet.
   *
   * It exists so that row is this component rather than a second copy of it: the
   * pending line and the authoritative one are the same row with the same avatar,
   * bubble tone and geometry, so the moment the Host's transcript carries the
   * message nothing moves. A separate markup path made that a visible jump - the
   * grey box the player sent became a wine bubble under a monogram a moment later.
   */
  waitingNote?: string | null;
  /**
   * The element the row renders as. The transcript's rows are `<li>` of its own
   * `<ol>`; the optimistic row is the same presentation *outside* that list,
   * because it is not one of the transcript's rows (the send journey asserts the
   * list carries none while it is visible), so its caller renders it as a `<div>`.
   */
  as?: "li" | "div";
  labels: Readonly<{
    swipeNavigation: string;
    swipePrevious: string;
    swipeNext: string;
    regenerateVariant: string;
    openingVariantDefault: string;
    openingVariantAlternate: string;
    rewindHere: string;
    rewindHereName: string;
    rewindConfirmPrompt: string;
    rewindConfirmYes: string;
    rewindConfirmNo: string;
    editMessage: string;
    editMessageName: string;
    editMessageField: string;
    editMessageSave: string;
    editMessageCancel: string;
    deleteMessage: string;
    deleteMessageName: string;
    deleteConfirmPrompt: string;
    deleteConfirmYes: string;
    deleteConfirmNo: string;
  }>;
}) {
  const isPlayer = message.role === "player";
  const authorName = isPlayer ? playerLabel : companionName;
  const swipeInfo = message.swipeInfo;
  const openingVariant = message.openingVariant;
  const busy = pending !== null;
  // The Host published this only while the opening is still unlocked and the greeting set still
  // resolves; when it is sealed the control is absent rather than offered and refused.
  const openingChoice =
    !isPlayer && openingVariant !== undefined && !openingVariant.locked && openingVariant.count > 1
      ? openingVariant
      : undefined;
  // The message's own swipe set, when the Host published more than one variant of
  // it. It is the same shape as the opening choice, and it reads the same way.
  const swipeSet = swipeInfo !== undefined && swipeInfo.totalSwipes > 1 ? swipeInfo : undefined;
  /**
   * The rewind point is the message the conversation is cut back TO, so the greeting is never one
   * (the Host refuses it), a row that is not part of the transcript is never one, and a point with
   * nothing after it is not a rewind at all.
   */
  const rewindPoint =
    onRewind !== undefined && removedCount > 0 && message.order > 0 && !isPlayer ? removedCount : undefined;
  const rewindName = labels.rewindHereName.replace("{{count}}", String(removedCount));
  /**
   * The delete point is the message the player is looking at, and it is never the opening: the row at
   * order zero is the greeting the Chat started on (the Host refuses it, and so does this surface). A
   * delete leaves a gap rather than shortening the conversation, so - unlike the rewind - a row with
   * nothing after it is still a legal point.
   */
  const deletePoint = onDelete !== undefined && message.order > 0 ? message.order : undefined;
  /**
   * The editor is this row's own presentation state: it holds the words the player is rewriting, and
   * it exists only while the row does - a row a rewind dropped takes its open editor with it. The
   * order the page rendered is sent with the save, so a row that moved under the editor is refused by
   * name rather than edited where the player is not looking.
   */
  const [editor, setEditor] = useState<Readonly<{ text: string; sent: string | null }> | null>(null);
  const openEditor = (): void => {
    setEditor(Object.freeze({ text: message.text, sent: null }));
  };
  /**
   * The editor closes on the one fact that says the edit landed: the row the transcript now carries
   * holds exactly the words that were sent, and no mutation is in flight. A refusal therefore leaves
   * the field and the player's words exactly as they typed them - a reply still being written costs
   * them the press, not the rewrite.
   */
  useEffect(() => {
    if (editor === null || editor.sent === null) return;
    if (pending !== null || message.text !== editor.sent) return;
    setEditor(null);
  }, [editor, pending, message.text]);
  // Whether this message's strip has a pager at all: the strip exists for its own
  // controls, so a message with neither keeps no empty row under the bubble.
  const hasControls = openingChoice !== undefined || swipeSet !== undefined || deletePoint !== undefined;
  // The Host's per-message language, painted on the text only: the author line
  // and the swipe/regenerate controls are player-facing UI words and must keep
  // the surface's own language. `und` paints nothing (browserMessageLanguageTag),
  // so the document's language still styles a CJK beat through `:lang(zh)`.
  const languageTag = browserMessageLanguageTag(message.locale);
  const Row = as;

  return (
    <Row
      className={`message ${isPlayer ? "player" : "companion"}${waitingNote === null ? "" : " message-waiting-row"}`}
      data-handle={message.handle}
      {...(busy ? { "aria-busy": "true" as const, "data-pending": pending } : {})}
      {...(waitingNote === null ? {} : { "aria-busy": "true" as const, "data-waiting": "true" as const })}
      {...(streaming ? { "data-streaming": "true" as const } : {})}
    >
      {/* The avatar is the row's first child on both sides, and the player's
          row is mirrored by `flex-direction: row-reverse` (style.css): the
          monogram ends up outside the bubble, hugging the outer boundary. The
          companion's side carries her real picture when the Host has one;
          everything else about the element - size, plate, `aria-hidden` - is the
          monogram it already was. */}
      <CompanionAvatar handle={isPlayer ? null : companionHandle} name={authorName} className="avatar-small" />
      <div className="message-body">
        {/* The author line belongs to the companion only. The player's own
            monogram already sits at the row's edge, so printing the same name
            again above the bubble reads as "[你] 你: 你好" - the line is a
            duplicate of the avatar, not an attribution - and the player's side
            has no header at all, because an empty box would still add the body
            column's gap above the bubble. */}
        {!isPlayer && (
          <div className="message-header">
            <span className="message-author">{authorName}</span>
          </div>
        )}
        {/* Both sides author text, and a `*beat*` is the same format on both:
            the same sanitised Markdown renderer reads a person's words exactly as
            it reads the companion's, so the identical beat cannot render two ways. */}
        <MarkdownMessage
          className="message-bubble"
          text={message.text}
          trailingHtml={CARET_MARKUP}
          lang={languageTag}
        />
        {/* One strip under the bubble for everything a companion message can do
            to itself: choose another opening, swipe the set, ask again. The pager
            used to sit in the author line above the bubble while regenerate sat
            here, so one message's two controls were diagonal - measured at
            1440x900 on a regenerated reply: pager 389..435 above a 439..485
            bubble, regenerate 493..537 under it, their centres 145 px apart - and
            going back to an earlier variant after asking again meant crossing the
            bubble. */}
        {!isPlayer && !deleteArmed && (hasControls || onRegenerate || rewindPoint !== undefined || rewindArmed) && (
          <div className="message-actions">
            {/* An armed rewind is this message's only control: the pager and regenerate step aside
                for the confirmation the same way a Chats row's own strip does. */}
            {rewindArmed && (
              <div className="message-confirm" data-testid="message-rewind-confirm">
                <p className="message-confirm-prompt" role="status">
                  {labels.rewindConfirmPrompt}
                </p>
                <div className="message-confirm-actions">
                  <button
                    type="button"
                    className="action-btn rewind-confirm-yes"
                    data-testid="message-rewind-confirm-yes"
                    disabled={busy}
                    onClick={() => onRewindConfirm?.(message.handle, message.order)}
                    title={labels.rewindConfirmYes}
                    aria-label={labels.rewindConfirmYes}
                  >
                    {labels.rewindConfirmYes}
                  </button>
                  <button
                    type="button"
                    className="action-btn rewind-confirm-no"
                    data-testid="message-rewind-confirm-no"
                    onClick={() => onRewindCancel?.()}
                    title={labels.rewindConfirmNo}
                    aria-label={labels.rewindConfirmNo}
                  >
                    {labels.rewindConfirmNo}
                  </button>
                </div>
              </div>
            )}
            {!rewindArmed && openingChoice && (
              <div className="swipe-controls" aria-label={labels.swipeNavigation}>
                {/* The glyph is the visible control and the number between the two
                    is the state; the words live in the accessible name. Long labels
                    here are what wrapped the strip to two rows at 400 px, and in a
                    narrow chat the dialogue is what the player is reading - this is
                    Tavern's own `\u2039 1/3 \u203a` for the same reason. */}
                <button
                  type="button"
                  className="swipe-btn"
                  disabled={busy || openingChoice.index <= 0}
                  onClick={() => onOpeningVariant?.(message.handle, "prev")}
                  aria-label={labels.swipePrevious}
                  title={labels.swipePrevious}
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                </button>
                <span className="swipe-indicator">{openingVariantWords(openingChoice, labels)}</span>
                <button
                  type="button"
                  className="swipe-btn"
                  disabled={busy || openingChoice.index >= openingChoice.count - 1}
                  onClick={() => onOpeningVariant?.(message.handle, "next")}
                  aria-label={labels.swipeNext}
                  title={labels.swipeNext}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </div>
            )}
            {!rewindArmed && swipeSet && (
              <div className="swipe-controls" aria-label={labels.swipeNavigation}>
                <button
                  type="button"
                  className="swipe-btn"
                  disabled={busy || !swipeSet.hasPrevious}
                  onClick={() => onSwipe?.(message.handle, "prev")}
                  aria-label={labels.swipePrevious}
                  title={labels.swipePrevious}
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                </button>
                <span className="swipe-indicator">{swipePosition(swipeSet.label)}</span>
                <button
                  type="button"
                  className="swipe-btn"
                  disabled={busy || !swipeSet.hasNext}
                  onClick={() => onSwipe?.(message.handle, "next")}
                  aria-label={labels.swipeNext}
                  title={labels.swipeNext}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </div>
            )}
            {!rewindArmed && onRegenerate && (
              <button
                type="button"
                className="action-btn regenerate-btn"
                disabled={busy}
                {...(pending === "regenerate" ? { "data-busy": "true" as const } : {})}
                onClick={() => onRegenerate(message.handle)}
                title={labels.regenerateVariant}
                aria-label={labels.regenerateVariant}
              >
                {pending === "regenerate" ? (
                  <LoaderCircle className="message-spinner" size={14} aria-hidden="true" />
                ) : (
                  <RefreshCw size={14} aria-hidden="true" />
                )}
                {labels.regenerateVariant}
              </button>
            )}
            {!rewindArmed && rewindPoint !== undefined && (
              <button
                type="button"
                className="action-btn rewind-btn"
                data-testid="message-rewind"
                disabled={busy}
                {...(pending === "rewind" ? { "data-busy": "true" as const } : {})}
                onClick={() => onRewind?.(message.handle, message.order)}
                title={rewindName}
                aria-label={rewindName}
              >
                {pending === "rewind" ? (
                  <LoaderCircle className="message-spinner" size={14} aria-hidden="true" />
                ) : (
                  <Undo2 size={14} aria-hidden="true" />
                )}
                {labels.rewindHere}
              </button>
            )}
            {!rewindArmed && deletePoint !== undefined && (
              <button
                type="button"
                className="action-btn delete-btn"
                data-testid="message-delete"
                disabled={busy}
                {...(pending === "delete" ? { "data-busy": "true" as const } : {})}
                onClick={() => onDelete?.(message.handle, message.order)}
                title={labels.deleteMessageName}
                aria-label={labels.deleteMessageName}
              >
                {pending === "delete" ? (
                  <LoaderCircle className="message-spinner" size={14} aria-hidden="true" />
                ) : (
                  <Trash2 size={14} aria-hidden="true" />
                )}
                {labels.deleteMessage}
              </button>
            )}
            {!rewindArmed && waitingNote !== null && (
              <span className="message-waiting" role="status">
                {waitingNote}
              </span>
            )}
          </div>
        )}
        {/* The player's own row carries its own controls in the same strip the companion's reply
            uses rather than a second row of buttons: the words are already on the page, so the
            affordances that change them belong under them. */}
        {isPlayer && !deleteArmed && (onEdit !== undefined || deletePoint !== undefined) && (
          <div className="message-actions">
            {onEdit !== undefined &&
              (editor !== null ? (
                <div className="message-edit" data-testid="message-edit-form">
                  <textarea
                    className="message-edit-field"
                    data-testid="message-edit-field"
                    aria-label={labels.editMessageField}
                    value={editor.text}
                    disabled={busy}
                    rows={2}
                    onChange={(event) => setEditor({ text: event.target.value, sent: editor.sent })}
                  />
                  <div className="message-edit-actions">
                    <button
                      type="button"
                      className="action-btn edit-save-btn"
                      data-testid="message-edit-save"
                      disabled={busy || editor.text.trim().length === 0 || editor.text === message.text}
                      onClick={() => {
                        setEditor({ text: editor.text, sent: editor.text });
                        onEdit(message.handle, message.order, editor.text);
                      }}
                      title={labels.editMessageSave}
                      aria-label={labels.editMessageSave}
                    >
                      {labels.editMessageSave}
                    </button>
                    <button
                      type="button"
                      className="action-btn edit-cancel-btn"
                      data-testid="message-edit-cancel"
                      disabled={busy}
                      onClick={() => setEditor(null)}
                      title={labels.editMessageCancel}
                      aria-label={labels.editMessageCancel}
                    >
                      {labels.editMessageCancel}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="action-btn edit-btn"
                  data-testid="message-edit"
                  disabled={busy}
                  {...(pending === "edit" ? { "data-busy": "true" as const } : {})}
                  onClick={openEditor}
                  title={labels.editMessageName}
                  aria-label={labels.editMessageName}
                >
                  {pending === "edit" ? (
                    <LoaderCircle className="message-spinner" size={14} aria-hidden="true" />
                  ) : (
                    <Pencil size={14} aria-hidden="true" />
                  )}
                  {labels.editMessage}
                </button>
              ))}
            {/* While the editor is open the strip is the editor: a destructive Delete sitting beside
                Save and Cancel is a mis-click waiting to happen, and this row's own armed confirm
                already follows that rule (it replaces the other controls rather than joining them). */}
            {deletePoint !== undefined && editor === null && (
              <button
                type="button"
                className="action-btn delete-btn"
                data-testid="message-delete"
                disabled={busy}
                {...(pending === "delete" ? { "data-busy": "true" as const } : {})}
                onClick={() => onDelete?.(message.handle, message.order)}
                title={labels.deleteMessageName}
                aria-label={labels.deleteMessageName}
              >
                {pending === "delete" ? (
                  <LoaderCircle className="message-spinner" size={14} aria-hidden="true" />
                ) : (
                  <Trash2 size={14} aria-hidden="true" />
                )}
                {labels.deleteMessage}
              </button>
            )}
          </div>
        )}
        {/* An armed delete is this row's only control: like the rewind's arm, the confirmation
            replaces the pager, regenerate, edit and delete rather than joining them, and it states
            exactly what goes - this one message, not the conversation after it. */}
        {deleteArmed && (
          <div className="message-actions">
            <div className="message-confirm" data-testid="message-delete-confirm">
              <p className="message-confirm-prompt" role="status">
                {labels.deleteConfirmPrompt}
              </p>
              <div className="message-confirm-actions">
                <button
                  type="button"
                  className="action-btn delete-confirm-yes"
                  data-testid="message-delete-confirm-yes"
                  disabled={busy}
                  onClick={() => onDeleteConfirm?.(message.handle, message.order)}
                  title={labels.deleteConfirmYes}
                  aria-label={labels.deleteConfirmYes}
                >
                  {labels.deleteConfirmYes}
                </button>
                <button
                  type="button"
                  className="action-btn delete-confirm-no"
                  data-testid="message-delete-confirm-no"
                  onClick={() => onDeleteCancel?.()}
                  title={labels.deleteConfirmNo}
                  aria-label={labels.deleteConfirmNo}
                >
                  {labels.deleteConfirmNo}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Row>
  );
});
