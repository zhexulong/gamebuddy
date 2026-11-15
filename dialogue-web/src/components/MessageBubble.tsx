import {
  ChevronLeft,
  ChevronRight,
  CircleMinus,
  Copy,
  GitBranch,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Scissors,
  Trash2,
} from "lucide-react";
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { BrowserMessageV1 } from "../reference-pipeline-api";
import { browserMessageLanguageTag } from "../reference-pipeline-api";
import { useArmedConfirmation } from "./armed-confirmation";
import { fieldSizingSupported } from "./field-sizing";
import { isImeProcessingKey } from "./ime-composition";
import { CompanionAvatar } from "./CompanionAvatar";
import { MarkdownMessage } from "./MarkdownMessage";
import { openingVariantWords } from "./opening-variant-labels";
import { useRecordDraft } from "./surface-drafts";

/**
 * The live-streaming caret, inserted into the companion bubble's last block. The
 * bubble is Markdown rendered through `dangerouslySetInnerHTML`, so the caret is
 * placed into that sanitised HTML rather than passed as a React child; and it is
 * placed on every render, not only while streaming, so the preview's and the
 * committed message's bytes stay identical. Only `[data-streaming]` styles it, so
 * an idle bubble carries an inert, zero-size span.
 */
const CARET_MARKUP = '<span class="message-caret" aria-hidden="true"></span>';

/**
 * The editor field's ceiling, in the CSS pixel the height is set in. A rewritten message is prose, so the
 * field grows with it instead of showing two rows of a 300-character reply; past this height the field
 * scrolls internally rather than pushing the conversation it belongs to off the screen.
 */
const EDIT_FIELD_MAX_HEIGHT = 300;

/**
 * How long the copy confirmation stays up, in milliseconds. Long enough to be read after the
 * player's eye has come back from the click, short enough that it never becomes a state of the
 * row: every press restarts the window and the line then removes itself.
 */
const COPY_NOTICE_MS = 1600;

/**
 * How far a pointer may travel between press and release and still be a PRESS rather than a drag.
 *
 * A player who drags across a message is selecting its words - to copy them, to quote them - and a
 * drag that ended on the same paragraph is still a drag. Four CSS pixels is the platform's own
 * slop, and it is measured from the pointerdown rather than from the selection alone because a
 * browser collapses the selection when the release lands inside it.
 */
const EDIT_DRAG_SLOP_PX = 4;

/**
 * The settle window a body press waits out before it opens the editor, in milliseconds.
 *
 * A double click is how a reader selects one WORD, and its first click arrives as an ordinary
 * press: without this window that press would already have replaced the words with a field (and
 * moved focus into it) before the second click could select anything. Waiting one click's worth of
 * time lets `dblclick` cancel the open, so selecting a word stays selecting a word. The cost is
 * this delay on the honest single press, and it is the smaller of the two - a field that opens a
 * fifth of a second late is still an edit, while a field that eats a word selection is a defect.
 */
const EDIT_PRESS_SETTLE_MS = 220;

/**
 * The descendants of a message that are their own control.
 *
 * A reply may carry a link, and a link's press belongs to the link: it navigates, and turning that
 * press into an edit would be the message swallowing a control it contains. The list is the
 * platform's own interactive set, so a construct the reply grammar grows later is covered by its
 * element rather than by a per-construct exception here.
 */
const MESSAGE_EDIT_INTERACTIVE = "a, button, input, textarea, select, summary, [role='button'], [role='link']";

/**
 * Puts one message's words on the player's clipboard, and says whether it worked.
 *
 * The clipboard API needs a secure context: a browser that served this page over plain http, or one
 * that withholds the API, has no `navigator.clipboard` at all. A control that then did nothing would
 * look identical to one that copied, so the fallback is the legacy selection path - a temporary
 * off-screen field holding the same text, selected and copied through `document.execCommand` - and
 * only if BOTH fail does the row say so out loud (`labels.copyNoticeFailed`). Silence is never an
 * outcome here.
 */
async function writeToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // A refused permission is not a verdict: the selection path below may still work.
    }
  }
  return copyThroughSelection(text);
}

/** The non-secure-context fallback: the same text, selected in a temporary field and copied. */
function copyThroughSelection(text: string): boolean {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.inset = "0 auto auto 0";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

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
 * One arrow of a stepper: the bare `‹`/`›` the owner's ruling keeps - the glyph is the whole visible
 * control and the words live in the accessible name, because at 400 px the words are what wrapped the
 * strip onto a second row.
 *
 * A disabled arrow's name says WHY it cannot move: the pager is on the first or the last variant, or
 * this turn is still being generated. A name that only repeated "previous variant" would leave a screen
 * reader with the same silence the dimmed glyph leaves on the screen.
 */
type SwipeArrowLabels = Readonly<{
  swipePrevious: string;
  swipeNext: string;
  swipePreviousAtFirst: string;
  swipeNextAtLast: string;
  swipePreviousBusy: string;
  swipeNextBusy: string;
}>;

/** Why an arrow cannot move: the turn is still being generated, or the pager is at the end it would go towards. */
function swipeArrowName(
  labels: SwipeArrowLabels,
  direction: "prev" | "next",
  state: Readonly<{ busy: boolean; atEdge: boolean }>,
): string {
  if (state.busy) return direction === "prev" ? labels.swipePreviousBusy : labels.swipeNextBusy;
  if (state.atEdge) return direction === "prev" ? labels.swipePreviousAtFirst : labels.swipeNextAtLast;
  return direction === "prev" ? labels.swipePrevious : labels.swipeNext;
}

function SwipeArrow({
  direction,
  busy,
  atEdge,
  labels,
  onPress,
}: Readonly<{
  direction: "prev" | "next";
  busy: boolean;
  atEdge: boolean;
  labels: SwipeArrowLabels;
  onPress: () => void;
}>) {
  const name = swipeArrowName(labels, direction, { busy, atEdge });
  return (
    <button
      type="button"
      className="swipe-btn"
      disabled={busy || atEdge}
      onClick={onPress}
      aria-label={name}
      title={name}
    >
      {direction === "prev" ? (
        <ChevronLeft size={14} aria-hidden="true" />
      ) : (
        <ChevronRight size={14} aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * One row's edit in progress: the words in the field, and the words its last save sent.
 *
 * `sent` is what tells a landed save from a refused one, so the two belong to one value rather than
 * to two slots that could disagree.
 */
type MessageEdit = Readonly<{ text: string; sent: string | null }>;

/**
 * The editor a row's strip becomes while the player is rewriting that row's words.
 *
 * It is ONE control on both sides of the conversation - the player's own message and her reply - so the
 * field, the two answers and the 44 px floor are one presentation; the only thing the two rows state
 * differently is the label naming whose words the field holds. The strip IS the editor: the row's other
 * controls are what it replaces, because a destructive control rendered beside Save and Cancel is a
 * mis-click waiting to happen.
 */
function MessageEditor({
  text,
  onTextChange,
  onSave,
  onCancel,
  canSave,
  busy,
  fieldLabel,
  saveLabel,
  cancelLabel,
  consequence = null,
}: Readonly<{
  text: string;
  onTextChange: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  /** False while the field is empty or holds exactly the words the row already carries. */
  canSave: boolean;
  busy: boolean;
  fieldLabel: string;
  saveLabel: string;
  cancelLabel: string;
  /**
   * What saving does to the rest of the conversation, when there is a rest.
   *
   * An edit rewrites ONE row on both authorities - the durable transcript and the model's own
   * session - and leaves every later row exactly where it was, so a reply that answered the words
   * being replaced stays on screen, answering words that are no longer there. That is a real
   * consequence and the player is owed it before they save, not after; it is a sentence rather than
   * a confirmation step because saving is the ordinary answer, and `null` (a row with nothing after
   * it) has no tail to describe.
   */
  consequence?: string | null;
}>) {
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * The field takes the focus the moment it opens.
   *
   * The press that opened it was the row's Edit control, and that control is UNMOUNTED by the same
   * press - so without this the caret is left on `<body>` and a keyboard player who meant to rewrite
   * the words has to tab through the whole page to reach them again.
   */
  useEffect(() => {
    const field = fieldRef.current;
    if (field === null) return;
    field.focus();
    // The caret lands at the END of the words. Focusing a field that already holds the reply leaves
    // the caret at offset zero, so the first keystroke of a correction would go in front of it.
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);
  /**
   * The field is as tall as the words in it, between two rows and the ceiling, and the sheet does
   * that now (`.message-edit-field`'s `field-sizing: content` with the two-row floor as its
   * `min-height` and `EDIT_FIELD_MAX_HEIGHT` as its `max-height`): the engine sizes the field, so a
   * keystroke does not read a layout back out of it.
   *
   * `height: auto` first, because `scrollHeight` is the content's own height only while the box is not
   * already stretched to it. That reasoning only applies to the browsers with no `field-sizing`, which
   * are the only ones that run this at all - a fallback that always runs is not a fallback.
   */
  useLayoutEffect(() => {
    if (fieldSizingSupported) return;
    const field = fieldRef.current;
    if (field === null) return;
    field.style.height = "auto";
    const content = field.scrollHeight;
    field.style.height = `${Math.min(content, EDIT_FIELD_MAX_HEIGHT)}px`;
    field.style.overflowY = content > EDIT_FIELD_MAX_HEIGHT ? "auto" : "hidden";
  }, [text]);
  /**
   * Ctrl+Enter saves. A bare Enter is the field's own key - it inserts a newline, because a reply being
   * rewritten is prose and a newline is part of it - and Escape is the row's own cancel, already bound
   * on the document (`Escape` closes the field exactly as Cancel does).
   */
  const onFieldKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (isImeProcessingKey(event.nativeEvent)) return;
    if (event.key !== "Enter" || !event.ctrlKey) return;
    event.preventDefault();
    if (busy || !canSave) return;
    onSave();
  };
  return (
    <div className="message-edit" data-testid="message-edit-form">
      <textarea
        ref={fieldRef}
        className="message-edit-field"
        data-testid="message-edit-field"
        aria-label={fieldLabel}
        value={text}
        disabled={busy}
        rows={2}
        onChange={(event) => onTextChange(event.target.value)}
        onKeyDown={onFieldKeyDown}
      />
      <div className="message-edit-actions">
        <button
          type="button"
          className="action-btn edit-save-btn"
          data-testid="message-edit-save"
          disabled={busy || !canSave}
          onClick={onSave}
          title={saveLabel}
          aria-label={saveLabel}
        >
          {saveLabel}
        </button>
        <button
          type="button"
          className="action-btn edit-cancel-btn"
          data-testid="message-edit-cancel"
          disabled={busy}
          onClick={onCancel}
          title={cancelLabel}
          aria-label={cancelLabel}
        >
          {cancelLabel}
        </button>
      </div>
      {consequence === null ? null : (
        <p className="message-edit-consequence" data-testid="message-edit-consequence">
          {consequence}
        </p>
      )}
    </div>
  );
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
  companionDigest,
  playerLabel,
  onSwipe,
  onSwipeRemove,
  onSwipeRemoveConfirm,
  onSwipeRemoveCancel,
  swipeRemoveArmed = false,
  onRegenerate,
  onOpeningVariant,
  onActFromHere,
  onActRewind,
  onActFork,
  onActCancel,
  actArmed = false,
  onEdit,
  onDelete,
  onDeleteConfirm,
  onDeleteCancel,
  deleteArmed = false,
  removedCount = 0,
  pending = null,
  streaming = false,
  waitingNote = null,
  truncatedNote = null,
  as = "li",
  labels,
}: {
  message: BrowserMessageV1;
  companionName: string;
  /** The mounted companion's own roster handle: how her picture is addressed. */
  companionHandle: string | null;
  /**
   * The digest of the picture the player last gave her, when the shell knows one - the reload key
   * `CompanionAvatar` needs to replace the bytes behind her one URL. It is handed down from the same
   * place the app bar and the roster are handed it, because an upload writes the file her face serves
   * and leaves every read (`companion.list`, the transcript) untouched: nothing about this row can be
   * re-read to learn that a newer picture exists.
   */
  companionDigest?: string;
  playerLabel: string;
  onSwipe?: (messageHandle: string, direction: "prev" | "next") => void;
  /**
   * Discarding ONE variant of this reply - the one the row is showing, named by the index the Host
   * published. Like every other destructive control on the strip, the first press only ARMS it and the
   * confirmation is what sends it: a generation the player spent tokens on does not leave the set on a
   * single click. A reply that would be left with nothing to read is refused by name
   * (`chat_swipe_last_variant`), so the control is absent when the row has one variant and there is no
   * press the Host could answer.
   */
  onSwipeRemove?: (messageHandle: string, targetIndex: number) => void;
  onSwipeRemoveConfirm?: (messageHandle: string, targetIndex: number) => void;
  onSwipeRemoveCancel?: () => void;
  /** True for the one message whose variant removal is armed: its strip becomes that confirmation. */
  swipeRemoveArmed?: boolean;
  onRegenerate?: (messageHandle: string) => void;
  /**
   * The new-chat opening choice: it is offered only where the Host published an unlocked
   * `openingVariant`, and it calls the Host's own route rather than holding the choice here.
   */
  onOpeningVariant?: (messageHandle: string, direction: "prev" | "next") => void;
  /**
   * What comes after this message: two entries, one control each, both under the shell's single-flight latch.
   *
   * A REWIND cuts the conversation back to this row (it is destructive and has no undo, so it arms - the
   * `onActFromHere` press opens the confirmation and `onActRewind` is what the confirmation sends). A FORK
   * keeps every later row and puts the prefix into a second Chat, so it is not destructive at all: the
   * `onActFork` press sends it directly, and its own name is what states the two facts the player is owed
   * (this chat keeps every later message, both chats share her memory). They were ONE control with two
   * answers (2026-11-15). The owner's ruling of 2026-11-16 is that a fork is its own button: it does
   * nothing to this conversation, so folding it behind a control the destructive answer also sits behind
   * made the safe answer cost the dangerous one's ceremony.
   *
   * The accessor is handed the order the page rendered this message at, because the Host refuses a rewind
   * naming a message that is no longer there - the transcript is what a position means. A caller that serves
   * no `chat.fork` (the probe, a profile without the route) simply gets no fork entry.
   */
  onActFromHere?: (messageHandle: string, expectedOrder: number) => void;
  onActRewind?: (messageHandle: string, expectedOrder: number) => void;
  onActFork?: (messageHandle: string) => void;
  onActCancel?: () => void;
  /** True for the one message whose rewind confirmation is open: its strip becomes that confirmation. */
  actArmed?: boolean;
  /**
   * The edit's save. The message's body IS the edit affordance (owner ruling 2026-11-16: pressing the words
   * is what asks to rewrite them, so the strip does not spend a target on it), and this callback is what the
   * editor's Save sends once a row of either role has been rewritten in place. It carries the text the player
   * typed AND the order the page rendered the row at, because the Host refuses a row that has moved. The
   * editor itself is this row's own presentation state, and the authoritative reread - not a local guess -
   * owns what the transcript then shows.
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
  pending?: "swipe" | "swipeRemove" | "regenerate" | "opening" | "rewind" | "edit" | "delete" | "fork" | null;
  /**
   * True only for the live streaming preview: the bubble then carries the
   * reading caret. The caret is inserted into the bubble's last block on every
   * render - only `[data-streaming]` styles it - so it trails the reply's last
   * character and the preview's and the committed message's bytes stay identical.
   *
   * The row is also `aria-busy` for as long as it streams. A reply takes seconds to
   * write and this row's text changes on every token, so a screen reader is told the
   * row is being updated rather than being fed the paragraph again twenty times; the
   * one spoken fact about the turn belongs to the timeline's own region, which says
   * only what a busy row cannot - that the reply landed.
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
   * The line a reply carries when the generation that wrote it stopped at the model's length
   * ceiling: information about the reply the player is reading, never a failure and never a
   * control - it names the Regenerate button this same row already offers. The Host publishes
   * the fact from the model's own stop reason and only while this row still shows that
   * generation's text, so the caller hands it here already decided. Absent for every other row.
   */
  truncatedNote?: string | null;
  /**
   * The element the row renders as. The transcript's rows are `<li>` of its own
   * `<ol>`; the optimistic row is the same presentation *outside* that list,
   * because it is not one of the transcript's rows (the send journey asserts the
   * list carries none while it is visible), so its caller renders it as a `<div>`.
   */
  as?: "li" | "div";
  labels: SwipeArrowLabels &
    Readonly<{
      swipeNavigation: string;
      /**
       * The variant-discard control, and the confirmation it opens. Like the two arrows it sits between it
       * has no visible word - the glyph is the whole visible control and this is the accessible name - so
       * there is no word key; the negative answer is the row's shared `deleteConfirmNo`.
       */
      swipeRemoveName: string;
      swipeRemoveConfirmPrompt: string;
      swipeRemoveConfirmYes: string;
      regenerateVariant: string;
      openingVariantDefault: string;
      openingVariantAlternate: string;
      /** The sentence the opening row carries once the Host has sealed the choice. */
      openingSealed: string;
      rewindHere: string;
      rewindHereName: string;
      rewindConfirmPrompt: string;
      rewindConfirmYes: string;
      rewindConfirmNo: string;
      /**
       * The message body's own edit affordance. With no control to press, the sentence a screen reader reads
       * when the body takes focus is the only thing that says the words can be rewritten - so it is named
       * here rather than left to the pencil the sighted player sees on hover.
       */
      editHint: string;
      editMessageField: string;
      editMessageSave: string;
      editMessageCancel: string;
      /**
       * Her reply's own field label. Only two things differ from the player's: whose words the field holds,
       * and - below - what saving does to the rows that follow. It is the same editor on the other side of
       * the exchange.
       */
      editReplyField: string;
      /**
       * The consequence of an in-place edit, said in the editor while there are rows after it.
       *
       * Saving rewrites ONE row on both authorities and leaves every later row exactly where it was, so the
       * reply that answered the old words stays on screen answering words that are no longer there. The
       * player is owed that before they save.
       */
      editLaterKept: string;
      deleteMessage: string;
      deleteMessageName: string;
      deleteConfirmPrompt: string;
      deleteConfirmYes: string;
      deleteConfirmNo: string;
      /**
       * The branch entry: the prefix becomes a second Chat and this one keeps every later message. Its own
       * name repeats both facts, because it is a one-press control and there is no prompt above it to carry
       * them.
       */
      forkFromHere: string;
      forkFromHereName: string;
      /**
       * The copy control and the one line it leaves behind. It is the only control on the strip that
       * mutates nothing, so its name states that rather than a consequence, and its confirmation is
       * two words that remove themselves.
       */
      copyMessage: string;
      copyMessageName: string;
      copyNotice: string;
      copyNoticeFailed: string;
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
  /**
   * The other half of that fact: the Host sealed the choice, so the pager above is gone - and the row
   * it disappeared from says so instead of going quiet.
   *
   * A card ships several openings, and choosing one happens while a Chat is being created (the picker)
   * or while it is still nothing but its opening (this pager). After the first message the Host refuses
   * the choice by name (`chat_opening_locked`, `commitGreetingOpeningVariant`), because swapping the row
   * the whole exchange was written on would rewrite the record rather than the conversation. That is a
   * deliberate line, not a defect - and the player who wants a different opening is owed the one place
   * it still exists: a NEW Chat, which is a second conversation and leaves this one as it is.
   */
  const openingSealedNote =
    !isPlayer && openingVariant !== undefined && openingVariant.locked && openingVariant.count > 1
      ? labels.openingSealed
      : null;
  // The message's own swipe set, when the Host published more than one variant of
  // it. It is the same shape as the opening choice, and it reads the same way.
  const swipeSet = swipeInfo !== undefined && swipeInfo.totalSwipes > 1 ? swipeInfo : undefined;
  /**
   * The variant this row would discard, named by the index the Host published for the variant on
   * screen. The control exists only where a discard is possible at all: a position with one variant
   * has nothing to remove, and the Host refuses exactly that by name (`chat_swipe_last_variant`), so
   * offering a button that could only ever be refused would be the dead-control defect.
   */
  const swipeRemovePoint = swipeSet === undefined || onSwipeRemove === undefined ? undefined : swipeSet.currentIndex;
  /**
   * One confirmation at a time, so an armed discard steps the row's other controls aside exactly as the
   * armed choice does: a confirmation rendered among the controls it replaces is a mis-click waiting to
   * happen.
   */
  const stripReplaced = actArmed || swipeRemoveArmed;
  /**
   * The point this row is over what follows it: the row the conversation can be cut back TO, and the row it
   * can be branched FROM. The cut KEEPS that row and drops everything after it, which is what makes a PLAYER
   * row a legal point - their own line survives, the reply that answered it does not, and they are ready to be
   * answered again (the owner's ruling, 2026-10-20: rewind the way Pi and SillyTavern do).
   *
   * The greeting is never a point: the Host refuses both acts there (a cut would leave nothing but the
   * conversation's opening, and a branch of nothing but the greeting is not a second view of the exchange).
   * And a row with nothing after it offers neither: the rewind would remove nothing, and a fork of nothing is
   * not a branch - so the consequence, stated honestly, is that the newest message is branched from by
   * choosing the row BEFORE it.
   */
  const actPoint = removedCount > 1 && message.order > 0 ? message.order : undefined;
  /**
   * The count the accessible name states is what the press REMOVES. `removedCount` also counts this
   * row, and this row survives the cut - so it is one less.
   */
  const rewindName = labels.rewindHereName.replace("{{count}}", String(removedCount - 1));
  /**
   * The two entries over what follows, each with its own reason to exist.
   *
   * The rewind needs both halves of its pair (the press that ARMS it, the press that sends it), so it is
   * offered where the caller serves both. The fork needs only its own press, and it is offered wherever the
   * caller serves `chat.fork` at all - the probe and a profile without the route simply have no fork entry.
   */
  const rewindOffered = actPoint !== undefined && onActFromHere !== undefined && onActRewind !== undefined;
  const forkOffered = actPoint !== undefined && onActFork !== undefined;
  /**
   * The delete point is the message the player is looking at, and it is never the opening: the row at
   * order zero is the greeting the Chat started on (the Host refuses it, and so does this surface). A
   * delete leaves a gap rather than shortening the conversation, so - unlike the rewind - a row with
   * nothing after it is still a legal point.
   */
  const deletePoint = onDelete !== undefined && message.order > 0 ? message.order : undefined;
  /**
   * The rows the player may rewrite, the OPENING included: the greeting is edited in place, for this session
   * alone (the owner's ruling, 2026-10-20, superseding the earlier "the greeting is a retained anchor"), and
   * that is the ONLY way to fix its words - the reviewed greeting assets stay untouched. Both sides of the
   * exchange carry it: the Host accepts the player's own line, her replies and that opening, and nothing else.
   */
  const editPoint = onEdit !== undefined ? message.order : undefined;
  /**
   * Whether this body is a press away from the editor.
   *
   * The three rows that are NOT messages of the transcript are excluded by name, because each one would make
   * the press a lie: a streaming preview is still being written (and the Host refuses an edit under a live
   * turn by name, `chat_edit_turn_active`), the optimistic echo is not the Host's message yet, and a row with
   * a mutation or a confirmation in flight is exactly as busy as its strip says it is.
   */
  const editOpens = editPoint !== undefined && !streaming && waitingNote === null && !busy && !stripReplaced;
  /**
   * The editor's words are the SHELL's, not this row's, and the slot is the message's own handle.
   *
   * The row's text is the player's, and the shell renders its surfaces conditionally
   * (`shownSurface === CHAT_PANEL` in `ComposedReferenceGameApp`), so leaving Chat unmounts every row
   * - a `useState` here took the half-typed correction with it, and the row came back with no editor
   * at all, which does not lose the words so much as make them unreachable. Keyed by the handle rather
   * than by a position, so two rows' editors are two drafts and a row that moves cannot inherit
   * another row's words. `null` is the closed editor, held in the store for the same reason the world
   * book's closed editor is (`useRecordDraft`): reopening at the row's own words is the truth, and
   * closing it is what discards them. The order the page rendered is sent with the save, so a row that
   * moved under the editor is refused by name rather than edited where the player is not looking.
   */
  const editorDraft = useRecordDraft<MessageEdit>(`chat.message-edit.${message.handle}`, null);
  const editor = editorDraft.value;
  const openEditor = (): void => {
    editorDraft.type(Object.freeze({ text: message.text, sent: null }));
  };
  /**
   * The body the editor replaced, and the request to give the focus back to it.
   *
   * The body is not in the DOM while the field is open, so the press that closes the field cannot
   * focus it directly: it ASKS (`restoreEditFocusRef`), and the effect below runs after the render
   * that brings the body back. Cancelling is the case that drops focus today - Escape and Cancel
   * both come from a field that the same state change unmounts - and the message itself is where the
   * player was reading, so it is also where the next press starts.
   */
  const editTargetRef = useRef<HTMLDivElement | null>(null);
  const restoreEditFocusRef = useRef(false);
  const closeEditor = (): void => {
    restoreEditFocusRef.current = true;
    editorDraft.clear();
  };
  /**
   * True while this row's strip IS the editor: the bubble has given way to it and the strip takes
   * the bubble's own place in the flow (`.message-actions-editing`).
   */
  const editing = editor !== null;
  useEffect(() => {
    if (editing || !restoreEditFocusRef.current) return;
    restoreEditFocusRef.current = false;
    editTargetRef.current?.focus();
  }, [editing]);
  /**
   * The press that opens the editor, and the four presses that must NOT.
   *
   * The body is the affordance now (owner ruling, 2026-11-16), so every press in a message's prose arrives
   * here - including the ones a reader makes to do something else with those words:
   *
   *  - a DRAG selects text; a press that travelled more than `EDIT_DRAG_SLOP_PX`, or one made while the
   *    document's selection is not collapsed, is a selection and never an edit;
   *  - a DOUBLE CLICK is how a reader selects one word, and its first click arrives as an ordinary press,
   *    so the open waits out `EDIT_PRESS_SETTLE_MS` and `dblclick` cancels it;
   *  - a press on a LINK, or on any other control the reply contains, belongs to that control;
   *  - a press while the row is busy or a confirmation is armed never reaches here at all (`editOpens`).
   *
   * What is left is the honest press: one click on the words, nothing selected, nothing dragged.
   */
  const pressStartRef = useRef<Readonly<{ x: number; y: number }> | null>(null);
  const pendingPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingPress = (): void => {
    if (pendingPressRef.current === null) return;
    clearTimeout(pendingPressRef.current);
    pendingPressRef.current = null;
  };
  useEffect(() => cancelPendingPress, []);
  const onEditPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    pressStartRef.current = Object.freeze({ x: event.clientX, y: event.clientY });
  };
  const onEditDoubleClick = (): void => cancelPendingPress();
  const onEditClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const start = pressStartRef.current;
    pressStartRef.current = null;
    if (start !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) > EDIT_DRAG_SLOP_PX) return;
    const pressed = event.target;
    if (pressed instanceof Element && pressed.closest(MESSAGE_EDIT_INTERACTIVE) !== null) return;
    const selection = document.getSelection();
    if (selection !== null && !selection.isCollapsed) return;
    cancelPendingPress();
    pendingPressRef.current = setTimeout(() => {
      pendingPressRef.current = null;
      openEditor();
    }, EDIT_PRESS_SETTLE_MS);
  };
  /**
   * The keyboard path - what keeps a pointer-only affordance from being an accessibility regression.
   *
   * The body carries no widget role: it is prose, and `role="button"` on a paragraph would make every
   * screen reader announce a control that does not exist while swallowing the reading of the words. What
   * it carries instead is the honest pair - a tab stop, and a DESCRIPTION (`editHint`) that says these
   * words can be rewritten and how - so focus reads as "this message, which you can edit" rather than as
   * a button. Enter is what activates a focused thing and F2 is the platform's own "edit the focused
   * field" key; both are accepted, which is also what `aria-keyshortcuts` declares.
   */
  const onEditKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== "F2") return;
    event.preventDefault();
    cancelPendingPress();
    openEditor();
  };
  const editHintId = editOpens ? `message-edit-hint-${message.handle}` : null;
  /**
   * What saving an in-place edit does to the rows after it, or `null` where there are none.
   *
   * The Host rewrites one row on both authorities (`editMountedChatMessage`) and leaves every later row
   * exactly where it was - it never detaches them, never turns them into variants and never cuts them - so
   * a reply that answered the old words stays on screen. Stating it in the editor is the difference between
   * an in-place rewrite and a rewind in disguise.
   */
  const editConsequence = removedCount > 1 ? labels.editLaterKept : null;
  /**
   * The editor closes on the one fact that says the edit landed: the row the transcript now carries
   * holds exactly the words that were sent, and no mutation is in flight. A refusal therefore leaves
   * the field and the player's words exactly as they typed them - a reply still being written costs
   * them the press, not the rewrite.
   */
  useEffect(() => {
    if (editor === null || editor.sent === null) return;
    if (pending !== null || message.text !== editor.sent) return;
    editorDraft.clear();
  }, [editor, editorDraft, pending, message.text]);
  /**
   * Escape closes the field exactly as Cancel does, and the row OWNS that key while the field is
   * open.
   *
   * The listener is on the document rather than on the editor's own box: the control that opened
   * the field is the control the field REPLACED, so the press leaves focus on nothing in
   * particular, and a key that only worked while the caret happened to be in the field would be a
   * keyboard path that depends on where the pointer last landed. It is inert while the mutation is
   * in flight, which is the state Cancel is disabled in - one rule, two ways of asking for it.
   *
   * `stopPropagation` is the same ownership the drawer and the AppBar's folded disclosure take: the
   * shell's own Escape steps out of another surface, and a half-typed correction must not be what
   * it steps out on top of.
   */
  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (pending !== null) return;
      closeEditor();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [editing, pending]);
  /**
   * The three pairs on this row, each with its own keyboard path: the control that opens
   * one is UNMOUNTED by the press that opens it, so focus has to be moved by hand into the
   * confirmation and back to the control on a cancel (`armed-confirmation.ts`).
   */
  const actPair = useArmedConfirmation(actArmed, () => onActCancel?.());
  const deletePair = useArmedConfirmation(deleteArmed, () => onDeleteCancel?.());
  const swipeRemovePair = useArmedConfirmation(swipeRemoveArmed, () => onSwipeRemoveCancel?.());
  /**
   * The copy's receipt, and the row's only transient state.
   *
   * It is deliberately NOT an arm-and-confirm pair. Copying mutates nothing - not the transcript, not
   * the Host, not the model's next turn - so there is nothing to warn about and nothing to undo; what
   * the player needs is a receipt, and a receipt that stays is a state the row has to grow out of
   * again. So it is one short line that removes itself after `COPY_NOTICE_MS`, and a second press
   * simply restarts the window.
   */
  const [copyNotice, setCopyNotice] = useState<"copied" | "failed" | null>(null);
  useEffect(() => {
    if (copyNotice === null) return;
    const timer = setTimeout(() => setCopyNotice(null), COPY_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [copyNotice]);
  /**
   * The press, and the one thing it puts on the clipboard: this message's own text, exactly as it was
   * authored.
   *
   * `message.text` and not the bubble's `textContent`, because the two are different strings and only
   * one of them is what the message SAYS. The rendered bubble has already been through Markdown - a
   * `*beat*` is italic, a leading prosody tag is a badge plate, block structure is markup - so its
   * `textContent` is a flattened reading of the prose, with whitespace no longer where the author put
   * it. SillyTavern's per-message copy does the same thing this does: it copies the message's own
   * `mes` field, not the DOM node it happens to be drawn in, and not the author prefix or the
   * timestamp beside it. A player who pastes her line somewhere gets her line and nothing else.
   */
  const copyMessage = (): void => {
    void writeToClipboard(message.text).then((copied) => setCopyNotice(copied ? "copied" : "failed"));
  };
  /**
   * Which rows offer the copy control: exactly the ones whose words are the transcript's.
   *
   * The streaming preview and the optimistic player echo are the two rows whose text is not yet
   * authoritative - one is a partial answer the Host is still writing, the other is the player's own
   * line on its way to the Host - so on those two the control would be claiming to hand over words
   * that are about to change or are not yet durable. Every settled message offers it, on both sides
   * of the exchange.
   */
  const copyPoint = !streaming && waitingNote === null;
  /**
   * The copy control, hoisted out of either side's strip so both sides are one presentation.
   *
   * It is the first control in the strip on both rows. That is not decoration: it is the only control
   * here that changes NOTHING - not the transcript, not the Host, not the model's next turn - so the
   * controls that do change things follow it, and the two destructive ones end the row. It also has to
   * sit ahead of the pager rather than between the pager and Regenerate, because those two are one
   * measurement ("regenerate and pick another variant without crossing the bubble",
   * ui-layout-tail.spec.ts item 5) and a control between them would be that defect again.
   */
  const copyControl =
    copyPoint && !stripReplaced ? (
      <button
        type="button"
        className="action-btn copy-btn"
        data-testid="message-copy"
        onClick={copyMessage}
        title={labels.copyMessageName}
        aria-label={labels.copyMessageName}
      >
        <Copy size={14} aria-hidden="true" />
        <span className="action-word">{labels.copyMessage}</span>
      </button>
    ) : null;
  /**
   * The receipt, for the second and a half after the press.
   *
   * It is a child of the control strip rather than a block under it: the strip is the box it is
   * positioned against, so the line is out of flow and hangs on the strip's own upper edge, over the
   * tail of the words that were just copied. A block under the strip was measured - it grew the row
   * from 122 px to 168 px and pushed the four rows below it down by the same 46 px for the length of
   * the receipt - and hanging it under the strip instead was measured and rejected: the transcript's
   * own 14 px gap is smaller than the receipt's 27 px plate, so it covered the next message.
   *
   * `role="status"` is the product's own polite region, so a screen reader is told once, and the line
   * removes itself on a timer - the row never settles into a copied state. Both sides of the exchange
   * carry it: a player copies their own line as often as hers. Exactly one strip renders on a row at
   * a time, so exactly one of these mount sites is ever live.
   */
  const copyReceipt =
    copyNotice === null ? null : (
      <p
        className={copyNotice === "copied" ? "message-copy-notice success-banner" : "message-copy-notice error-banner"}
        data-testid="message-copy-notice"
        data-copy-notice={copyNotice}
        role="status"
      >
        {copyNotice === "copied" ? labels.copyNotice : labels.copyNoticeFailed}
      </p>
    );
  // Whether this message's strip has a pager at all: the strip exists for its own
  // controls, so a message with neither keeps no empty row under the bubble.
  const hasControls = openingChoice !== undefined || swipeSet !== undefined || deletePoint !== undefined || copyPoint;
  const swipeRemoveConfirmation = swipeRemoveArmed ? (
    <div
      className="message-confirm"
      data-testid="message-swipe-remove-confirm"
      onKeyDown={swipeRemovePair.onConfirmKeyDown}
      role="group"
    >
      <p className="message-confirm-prompt" role="status">
        {labels.swipeRemoveConfirmPrompt}
      </p>
      <div className="message-confirm-actions">
        <button
          type="button"
          className="action-btn swipe-remove-confirm-yes"
          data-testid="message-swipe-remove-confirm-yes"
          disabled={busy}
          onClick={() => onSwipeRemoveConfirm?.(message.handle, swipeSet?.currentIndex ?? 0)}
          title={labels.swipeRemoveConfirmYes}
          aria-label={labels.swipeRemoveConfirmYes}
        >
          {labels.swipeRemoveConfirmYes}
        </button>
        <button
          ref={swipeRemovePair.cancelRef}
          type="button"
          className="action-btn swipe-remove-confirm-no"
          data-testid="message-swipe-remove-confirm-no"
          onClick={swipeRemovePair.cancel}
          title={labels.deleteConfirmNo}
          aria-label={labels.deleteConfirmNo}
        >
          {labels.deleteConfirmNo}
        </button>
      </div>
    </div>
  ) : null;
  /**
   * The variant's own discard control, the last child of the variant group that pages the same set: one group,
   * because "show me the next attempt", "show me the previous one" and "throw this attempt away" are three
   * answers to the same question - and because the group already owns a line of its own at narrow widths
   * (style.css's container query), which a sixth control in the actions row did not: measured 520x900, a
   * discard in that row stranded the rewind-edit-delete block on a third line of its own.
   *
   * It wears the group's bare-glyph shape rather than the actions' worded one, so the pill keeps the width its
   * other two controls give it, and its class is its own (`.swipe-remove-btn`) because `.swipe-btn` is the two
   * paging arrows by name - several journeys enumerate exactly those two.
   */
  const swipeRemoveControl =
    swipeRemovePoint === undefined || stripReplaced ? null : (
      <button
        ref={swipeRemovePair.triggerRef}
        type="button"
        className="swipe-remove-btn"
        data-testid="message-swipe-remove"
        disabled={busy}
        {...(pending === "swipeRemove" ? { "data-busy": "true" as const } : {})}
        onClick={() => onSwipeRemove?.(message.handle, swipeRemovePoint)}
        title={labels.swipeRemoveName}
        aria-label={labels.swipeRemoveName}
      >
        {pending === "swipeRemove" ? (
          <LoaderCircle className="message-spinner" size={14} aria-hidden="true" />
        ) : (
          <CircleMinus size={14} aria-hidden="true" />
        )}
      </button>
    );
  /**
   * The rewind's own confirmation, and the one press that opens it.
   *
   * The cut is the only destructive entry a message has over what follows it, so it keeps the shape every
   * destructive control here keeps: the entry states the point and the count, and only the confirmation
   * sends it. It is not a fold any more (owner ruling, 2026-11-16): the fork is its own entry that does
   * nothing to this conversation, so sharing one control with it made the safe answer carry the dangerous
   * one's ceremony. Both sides of the exchange carry the pair: a player rewinds to their own line to be
   * answered again, and to hers to be written to again.
   *
   * The block is the row's only control while it is open, on the rule every other confirmation here
   * follows: a destructive answer rendered beside Save and Cancel is a mis-click waiting to happen.
   */
  const rewindConfirmation = actArmed ? (
    <div
      className="message-confirm"
      data-testid="message-rewind-confirm"
      onKeyDown={actPair.onConfirmKeyDown}
      role="group"
    >
      <p className="message-confirm-prompt" role="status">
        {labels.rewindConfirmPrompt}
      </p>
      <div className="message-confirm-actions">
        <button
          type="button"
          className="action-btn rewind-confirm-yes"
          data-testid="message-rewind-confirm-yes"
          disabled={busy}
          {...(pending === "rewind" ? { "data-busy": "true" as const } : {})}
          onClick={() => onActRewind?.(message.handle, message.order)}
          title={rewindName}
          aria-label={rewindName}
        >
          {pending === "rewind" ? (
            <LoaderCircle className="message-spinner" size={14} aria-hidden="true" />
          ) : (
            <Scissors size={14} aria-hidden="true" />
          )}
          {labels.rewindConfirmYes}
        </button>
        <button
          ref={actPair.cancelRef}
          type="button"
          className="action-btn rewind-confirm-no"
          data-testid="message-rewind-confirm-no"
          onClick={actPair.cancel}
          title={labels.rewindConfirmNo}
          aria-label={labels.rewindConfirmNo}
        >
          {labels.rewindConfirmNo}
        </button>
      </div>
    </div>
  ) : null;
  /**
   * The rewind entry. Its glyph is a CUT rather than a circular arrow: `Undo2` was one stroke away from the
   * `RefreshCw` Regenerate wears beside it, and a player reading `[ ↶ ]` as "answer me again" pressed the one
   * control in this strip that shortens the conversation. Its visible word is the POINT it names and its
   * accessible name carries the count it would remove.
   *
   * Its class is `act-btn` - the strip's existing shape for "the act over what comes after this message" -
   * because the box is the same box: two entries, one vocabulary, each named by its own test handle, glyph
   * and accessible name rather than by a third copy of the same fourteen declarations in the sheet.
   */
  const rewindEntry =
    !actArmed && rewindOffered ? (
      <button
        ref={actPair.triggerRef}
        type="button"
        className="action-btn act-btn rewind-btn"
        data-testid="message-rewind"
        disabled={busy}
        onClick={() => onActFromHere?.(message.handle, message.order)}
        title={rewindName}
        aria-label={rewindName}
      >
        <Scissors size={14} aria-hidden="true" />
        <span className="action-word">{labels.rewindHere}</span>
      </button>
    ) : null;
  /**
   * The branch entry: its own button, and one press.
   *
   * A fork mints a second Chat out of this one's prefix and leaves this conversation holding every later
   * message, so it takes nothing away and needs no arm - the ceremony belongs to the rewind beside it. What
   * the player is owed is the pair of facts the name states (this chat keeps every later message, and both
   * chats are one conversation to her Memory), and that is exactly `forkFromHereName`; the visible word says
   * what it makes, and the branch glyph is not the scissors the destructive neighbour wears.
   */
  const forkEntry =
    forkOffered && !stripReplaced ? (
      <button
        type="button"
        className="action-btn act-btn fork-btn"
        data-testid="message-fork"
        disabled={busy}
        {...(pending === "fork" ? { "data-busy": "true" as const } : {})}
        onClick={() => onActFork?.(message.handle)}
        title={labels.forkFromHereName}
        aria-label={labels.forkFromHereName}
      >
        {pending === "fork" ? (
          <LoaderCircle className="message-spinner" size={14} aria-hidden="true" />
        ) : (
          <GitBranch size={14} aria-hidden="true" />
        )}
        <span className="action-word">{labels.forkFromHere}</span>
      </button>
    ) : null;
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
      {...(streaming ? { "aria-busy": "true" as const, "data-streaming": "true" as const } : {})}
    >
      {/* The avatar is the row's first child on both sides, and the player's
          row is mirrored by `flex-direction: row-reverse` (style.css): the
          monogram ends up outside the bubble, hugging the outer boundary. The
          companion's side carries her real picture when the Host has one;
          everything else about the element - size, plate, `aria-hidden` - is the
          monogram it already was. */}
      <CompanionAvatar
        handle={isPlayer ? null : companionHandle}
        name={authorName}
        className="avatar-small"
        digest={companionDigest}
      />
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
            it reads the companion's, so the identical beat cannot render two ways.

            The speaker travels with the text because the grammar scopes one construct to
            one side: the leading prosody tag is the voice channel, and the voice layer
            performs her speech only, so a player's parenthetical stays text.

            THE BODY IS THE EDIT AFFORDANCE (owner ruling, 2026-11-16). Pressing the words asks to
            rewrite them, on both sides of the exchange and on the opening, so the strip does not
            spend one of its five targets on an Edit button. The press is only the honest one: a
            drag-selection, a double-click word selection, a press made while text is selected and a
            press on a link inside the message all leave the editor closed (`onEditClick`), and the
            body is a real tab stop whose description says so (`onEditKeyDown`).

            While this row is being rewritten the bubble GIVES WAY to the editor: the words then
            stand on screen once, in the field, because the editor takes the bubble's own place in
            the flow. The owner ruled it (audit 2026-10-19): the row kept rendering the bubble and
            opened the field under it, so the same words were printed twice and the row grew to the
            bubble PLUS a two-row editor - half of a 400x800 screen. Cancel or Escape brings the
            bubble back at the box it had. */}
        {!editing && (
          <div
            ref={editTargetRef}
            className="message-edit-target"
            {...(editPoint === undefined || streaming || waitingNote !== null ? {} : { "data-testid": "message-edit" })}
            {...(editOpens
              ? {
                  tabIndex: 0,
                  "aria-keyshortcuts": "F2",
                  "data-draft-revealer": true,
                  ...(editHintId === null ? {} : { "aria-describedby": editHintId }),
                }
              : {})}
            onPointerDown={editOpens ? onEditPointerDown : undefined}
            onClick={editOpens ? onEditClick : undefined}
            onDoubleClick={editOpens ? onEditDoubleClick : undefined}
            onKeyDown={editOpens ? onEditKeyDown : undefined}
          >
            <MarkdownMessage
              className="message-bubble"
              text={message.text}
              trailingHtml={CARET_MARKUP}
              lang={languageTag}
              speaker={isPlayer ? "player" : "companion"}
            />
            {/* The visible half of the affordance, and the invisible half that makes it honest. The
                pencil plate is decoration (`aria-hidden`): it appears on hover AND on `:focus-visible`,
                so the two ways into the editor are told the same thing, and it takes no press of its
                own - the body under it does. The sentence beside it is the description a screen reader
                reads with the body, and it is what stops a focusable paragraph from being a mystery. */}
            {editOpens && (
              <>
                <span className="message-edit-hint" aria-hidden="true">
                  <Pencil size={12} />
                </span>
                {editHintId === null ? null : (
                  <span className="visually-hidden" id={editHintId}>
                    {labels.editHint}
                  </span>
                )}
              </>
            )}
          </div>
        )}
        {/* One strip under the bubble for everything a companion message can do
            to itself: choose another opening, swipe the set, ask again. The pager
            used to sit in the author line above the bubble while regenerate sat
            here, so one message's two controls were diagonal - measured at
            1440x900 on a regenerated reply: pager 389..435 above a 439..485
            bubble, regenerate 493..537 under it, their centres 145 px apart - and
            going back to an earlier variant after asking again meant crossing the
            bubble.

            Each control's visible word is its own `action-word` span so the narrow
            window can retire the word and keep the control: the `aria-label` is what
            names these four, and style.css's narrow strip block is where that is
            argued and measured. */}
        {!(isPlayer || deleteArmed) &&
          (hasControls ||
            onRegenerate !== undefined ||
            rewindOffered ||
            forkOffered ||
            actArmed ||
            swipeRemoveArmed) && (
            <div className={editing ? "message-actions message-actions-editing" : "message-actions"}>
              {/* Her editor replaces the WHOLE strip rather than joining it, on the same rule the
                player's row follows: the pager, the variant switcher, regenerate, the rewind and the
                destructive Delete are exactly the controls an open Save/Cancel pair must not sit
                beside. */}
              {editPoint !== undefined && editor !== null ? (
                <MessageEditor
                  text={editor.text}
                  busy={busy}
                  canSave={editor.text.trim().length > 0 && editor.text !== message.text}
                  fieldLabel={labels.editReplyField}
                  saveLabel={labels.editMessageSave}
                  cancelLabel={labels.editMessageCancel}
                  consequence={editConsequence}
                  onTextChange={(text) => editorDraft.type({ text, sent: editor.sent })}
                  onCancel={closeEditor}
                  onSave={() => {
                    editorDraft.type({ text: editor.text, sent: editor.text });
                    onEdit?.(message.handle, message.order, editor.text);
                  }}
                />
              ) : (
                <>
                  {/* An armed rewind, or an armed variant discard, is this message's only control: the
                pager and regenerate step aside for the confirmation the same way a Chats row's own
                strip does. */}
                  {rewindConfirmation}
                  {swipeRemoveConfirmation}
                  {copyControl}
                  {copyReceipt}
                  {!stripReplaced && openingChoice && (
                    <div className="swipe-controls" aria-label={labels.swipeNavigation}>
                      {/* The glyph is the visible control and the number between the two
                    is the state; the words live in the accessible name. Long labels
                    here are what wrapped the strip to two rows at 400 px, and in a
                    narrow chat the dialogue is what the player is reading - this is
                    Tavern's own `\u2039 1/3 \u203a` for the same reason. */}
                      <SwipeArrow
                        direction="prev"
                        busy={busy}
                        atEdge={openingChoice.index <= 0}
                        labels={labels}
                        onPress={() => onOpeningVariant?.(message.handle, "prev")}
                      />
                      <span className="swipe-indicator">{openingVariantWords(openingChoice, labels)}</span>
                      <SwipeArrow
                        direction="next"
                        busy={busy}
                        atEdge={openingChoice.index >= openingChoice.count - 1}
                        labels={labels}
                        onPress={() => onOpeningVariant?.(message.handle, "next")}
                      />
                    </div>
                  )}
                  {!stripReplaced && swipeSet && (
                    <div className="swipe-controls" aria-label={labels.swipeNavigation}>
                      <SwipeArrow
                        direction="prev"
                        busy={busy}
                        atEdge={!swipeSet.hasPrevious}
                        labels={labels}
                        onPress={() => onSwipe?.(message.handle, "prev")}
                      />
                      <span className="swipe-indicator">{swipePosition(swipeSet.label)}</span>
                      <SwipeArrow
                        direction="next"
                        busy={busy}
                        atEdge={!swipeSet.hasNext}
                        labels={labels}
                        onPress={() => onSwipe?.(message.handle, "next")}
                      />
                      {swipeRemoveControl}
                    </div>
                  )}
                  {!stripReplaced && onRegenerate && (
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
                      <span className="action-word">{labels.regenerateVariant}</span>
                    </button>
                  )}
                  {rewindEntry}
                  {forkEntry}
                  {!stripReplaced && deletePoint !== undefined && (
                    <button
                      ref={deletePair.triggerRef}
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
                      <span className="action-word">{labels.deleteMessage}</span>
                    </button>
                  )}
                  {!actArmed && waitingNote !== null && (
                    <span className="message-waiting" role="status">
                      {waitingNote}
                    </span>
                  )}
                </>
              )}
            </div>
          )}
        {/* The player's own row carries its own controls in the same strip the companion's reply
            uses rather than a second row of buttons: the words are already on the page, so the
            affordances that change them belong under them. The REWIND is one of them: rewinding to
            this line keeps it and drops the reply that answered it, which is the player's own way to
            be answered again (the owner's ruling, 2026-10-20). Its place is where her row puts it -
            first in the strip - and an armed rewind leaves this strip with nothing but itself. */}
        {isPlayer &&
          !deleteArmed &&
          (actPoint !== undefined ||
            actArmed ||
            onRegenerate !== undefined ||
            deletePoint !== undefined ||
            copyPoint) && (
            <div className={editing ? "message-actions message-actions-editing" : "message-actions"}>
              {rewindConfirmation}
              {editor === null && copyControl}
              {copyReceipt}
              {/* While the field is open the strip is the editor: the destructive rewind sits out, exactly as
                the destructive Delete does, because a control that cuts the conversation away beside Save
                and Cancel is a mis-click waiting to happen. */}
              {editor === null && rewindEntry}
              {editor === null && forkEntry}
              {/* Asking her again for THIS line, offered when nothing answered it (a turn that failed
                or was stopped). It sits beside the rewind for the same reason the rewind is here at
                all: both answer the player's own words. The words are the same operation the reply
                row offers, so they are the same word rather than a second name for it. */}
              {!actArmed && editor === null && onRegenerate && (
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
                  <span className="action-word">{labels.regenerateVariant}</span>
                </button>
              )}
              {!actArmed && editPoint !== undefined && editor !== null && (
                <MessageEditor
                  text={editor.text}
                  busy={busy}
                  canSave={editor.text.trim().length > 0 && editor.text !== message.text}
                  fieldLabel={labels.editMessageField}
                  saveLabel={labels.editMessageSave}
                  cancelLabel={labels.editMessageCancel}
                  consequence={editConsequence}
                  onTextChange={(text) => editorDraft.type({ text, sent: editor.sent })}
                  onCancel={closeEditor}
                  onSave={() => {
                    editorDraft.type({ text: editor.text, sent: editor.text });
                    onEdit?.(message.handle, message.order, editor.text);
                  }}
                />
              )}
              {/* While the editor is open the strip is the editor: a destructive Delete sitting beside
                Save and Cancel is a mis-click waiting to happen, and this row's own armed confirm
                already follows that rule (it replaces the other controls rather than joining them). */}
              {!actArmed && deletePoint !== undefined && editor === null && (
                <button
                  ref={deletePair.triggerRef}
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
                  <span className="action-word">{labels.deleteMessage}</span>
                </button>
              )}
            </div>
          )}
        {/* An armed delete is this row's only control: like the rewind's arm, the confirmation
            replaces the pager, regenerate, edit and delete rather than joining them, and it states
            exactly what goes - this one message, not the conversation after it. */}
        {deleteArmed && (
          <div className="message-actions">
            <div
              className="message-confirm"
              data-testid="message-delete-confirm"
              onKeyDown={deletePair.onConfirmKeyDown}
              role="group"
            >
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
                  ref={deletePair.cancelRef}
                  type="button"
                  className="action-btn delete-confirm-no"
                  data-testid="message-delete-confirm-no"
                  onClick={deletePair.cancel}
                  title={labels.deleteConfirmNo}
                  aria-label={labels.deleteConfirmNo}
                >
                  {labels.deleteConfirmNo}
                </button>
              </div>
            </div>
          </div>
        )}
        {/* The reply's own length-ceiling line. It is information rather than a fault - the reply
            is real and on screen, it is just a prefix - so it is neither styled nor placed like
            the failure notice. It sits BELOW the control strip so the strip keeps exactly the
            geometry it already had (the pager, Regenerate, the rewind and Delete in one row under
            the bubble), and it carries no control of its own: the Regenerate it names is the
            button directly above it. */}
        {!isPlayer && truncatedNote !== null && (
          <p className="message-truncated" data-testid="message-truncated">
            {truncatedNote}
          </p>
        )}
        {/* The sealed opening's line, on the row whose switcher the seal took and in the same place
            and shape as the length-ceiling note: information under the strip, with no control of its
            own - the alternative it names is a New Chat, which is another conversation rather than a
            press on this row. */}
        {openingSealedNote !== null && (
          <p className="message-opening-sealed" data-testid="message-opening-sealed">
            {openingSealedNote}
          </p>
        )}
      </div>
    </Row>
  );
});
