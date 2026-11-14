import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BrowserMessageV1 } from "../reference-pipeline-api";
import { MessageBubble } from "./MessageBubble";

/**
 * How close to the end counts as "the reader is at the tail". A reader parked
 * within this many pixels of the bottom is following along; anyone further up
 * has deliberately scrolled back and owns the viewport.
 */
const TAIL_FOLLOW_THRESHOLD_PX = 24;

function isAtBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= TAIL_FOLLOW_THRESHOLD_PX;
}

export function Timeline({
  transcript,
  companionName,
  companionHandle,
  companionDigest,
  chatTitle,
  labels,
  preview = null,
  onSwipe,
  onSwipeRemove,
  onSwipeRemoveConfirm,
  onSwipeRemoveCancel,
  swipeRemoveArmedHandle = null,
  onRegenerate,
  onOpeningVariant,
  onRewind,
  onRewindConfirm,
  onRewindCancel,
  rewindArmedHandle = null,
  onEdit,
  onDelete,
  onDeleteConfirm,
  onDeleteCancel,
  deleteArmedHandle = null,
  pending = null,
  pendingPlayerMessage = null,
  replyTruncated = false,
  turnInFlight = false,
}: {
  transcript: readonly BrowserMessageV1[];
  preview?: Readonly<{ turnHandle: string; text: string }> | null;
  companionName: string;
  /** The mounted companion's own roster handle: how her picture is addressed. */
  companionHandle: string | null;
  /**
   * The digest of the picture the player last gave her, when the shell knows one: it is her rows'
   * avatar reload key, so an upload shows at once in the conversation rather than only after a
   * reload (`CompanionAvatar.digest`). `pendingPlayerMessage` has no such prop: that row is the
   * player's own, and it draws a monogram.
   */
  companionDigest?: string;
  chatTitle: string | null;
  labels: {
    chatTranscript: string;
    /** The zero-message anchor's one line; `{{name}}` is the companion. */
    emptyChatOpening: string;
    /** The catalog's own word for an unnamed companion, used on the plate. */
    companion: string;
    untitledChat: string;
    you: string;
    /** The send lane's one word while the Host has not answered yet. */
    chatSending: string;
    swipeNavigation: string;
    swipePrevious: string;
    swipeNext: string;
    /** The same two arrows when they cannot move, stating which end of the set they are on, or the turn still being generated. */
    swipePreviousAtFirst: string;
    swipeNextAtLast: string;
    swipePreviousBusy: string;
    swipeNextBusy: string;
    /**
     * The variant-discard control and the confirmation it opens. Like the two arrows it sits between it
     * carries no visible word, so only the name, the prompt and the affirmative exist; the negative answer
     * is the row's shared `deleteConfirmNo`.
     */
    swipeRemoveName: string;
    swipeRemoveConfirmPrompt: string;
    swipeRemoveConfirmYes: string;
    regenerateVariant: string;
    /**
     * The line a reply carries when the generation that wrote it stopped at the model's length
     * ceiling. It names the Regenerate control on the same row, so it is not a separate word for
     * a separate action.
     */
    chatReplyCutOff: string;
    /**
     * The one sentence a screen reader is told about a reply. It names the COMPLETION, because the
     * start of the reply is already spoken for (see the announcement region below).
     */
    chatReplyReady: string;
    /** The catalogue's words for the Host's own greeting-variant labels. */
    openingVariantDefault: string;
    openingVariantAlternate: string;
    /** The rewind control and the confirmation it opens. */
    rewindHere: string;
    rewindHereName: string;
    rewindConfirmPrompt: string;
    rewindConfirmYes: string;
    rewindConfirmNo: string;
    /** The player's own row's edit control and the field it opens. */
    editMessage: string;
    editMessageName: string;
    editMessageField: string;
    editMessageSave: string;
    editMessageCancel: string;
    /** Her reply's own edit control: the same operation on the other side of the exchange. */
    editReplyName: string;
    editReplyField: string;
    /** The delete control and the confirmation it opens. */
    deleteMessage: string;
    deleteMessageName: string;
    deleteConfirmPrompt: string;
    deleteConfirmYes: string;
    deleteConfirmNo: string;
    /**
     * The copy control and the one line it leaves behind. It mutates nothing, so its name says what it
     * does rather than what it costs, and its confirmation is the transient receipt.
     */
    copyMessage: string;
    copyMessageName: string;
    copyNotice: string;
    copyNoticeFailed: string;
  };
  onSwipe?: (messageHandle: string, direction: "prev" | "next") => void;
  /**
   * Discarding one variant of a reply: the arm names the reply and the index the page rendered, the
   * confirm sends it, and the cancel closes the arm. The control is offered only where the Host
   * published more than one variant of the row, because a reply with one has nothing to remove.
   */
  onSwipeRemove?: (messageHandle: string, targetIndex: number) => void;
  onSwipeRemoveConfirm?: (messageHandle: string, targetIndex: number) => void;
  onSwipeRemoveCancel?: () => void;
  /** The one message whose variant discard is armed, if any. */
  swipeRemoveArmedHandle?: string | null;
  onRegenerate?: (messageHandle: string) => void;
  /** The new-chat opening choice for the first message; offered only when the Host publishes one. */
  onOpeningVariant?: (messageHandle: string, direction: "prev" | "next") => void;
  /**
   * The rewind point and its confirmation: the arm names the message and the order the timeline
   * rendered it at, the confirm sends the mutation, and the cancel closes the arm.
   */
  onRewind?: (messageHandle: string, expectedOrder: number) => void;
  onRewindConfirm?: (messageHandle: string, expectedOrder: number) => void;
  onRewindCancel?: () => void;
  /** The one message whose rewind is armed, if any. */
  rewindArmedHandle?: string | null /**
   * The edit control: the player's own message sends the text they rewrote and the order the timeline
   * rendered it at, so the Host can refuse a row that moved under the editor.
   */;
  onEdit?: (messageHandle: string, expectedOrder: number, text: string) => void;
  /**
   * The delete point and its confirmation: the arm names the message and the order the timeline
   * rendered it at, the confirm sends the mutation, and the cancel closes the arm. A delete leaves a
   * gap rather than shortening the conversation, so - unlike the rewind - every row but the opening
   * is a legal point.
   */
  onDelete?: (messageHandle: string, expectedOrder: number) => void;
  onDeleteConfirm?: (messageHandle: string, expectedOrder: number) => void;
  onDeleteCancel?: () => void;
  /** The one message whose delete is armed, if any. */
  deleteArmedHandle?: string | null;
  /**
   * The chat mutation in flight and the message it belongs to, if any. Only that
   * message's own controls go busy, so a swipe on one variant never disables the
   * regenerate affordance of another.
   */
  pending?: Readonly<{
    kind: "swipe" | "swipeRemove" | "regenerate" | "opening" | "rewind" | "edit" | "delete";
    handle: string;
  }> | null;
  /**
   * The optimistic player message: the text just sent, shown until the
   * authoritative one lands.
   *
   * It belongs to the reading flow but it is not one of its rows: the message
   * list holds the authoritative transcript (`MessageBubble`, one `<li>` per
   * durable message), and the optimistic copy must not be a row of it - the
   * optimistic-send journey asserts the list carries none while this is visible,
   * so a duplicate can never be the thing that gets counted. It renders inside
   * the scrolling section rather than beside it, because beside it is outside
   * the scroll container: a long transcript would then scroll under an optimistic
   * line that never moved with it.
   */
  pendingPlayerMessage?: Readonly<{ idempotencyKey: string; text: string }> | null;
  /**
   * True while the Host says the mounted turn's own generation stopped at the model's length
   * ceiling. The sentence it makes belongs to the reply THAT generation wrote, which is the row
   * the turn committed - and the Host already withholds the fact once the player swipes to a
   * different variant of it, so nothing here has to decide which text the fact describes.
   */
  replyTruncated?: boolean;
  /**
   * True while a turn is admitted and not yet terminal - the same fact the app bar's own status
   * reads. The transcript's tail is then the player's line while she is still writing, so the
   * Regenerate control that answers THEIR line must wait for the turn to settle: the Host refuses
   * that target until the ledger is terminal.
   */
  turnInFlight?: boolean;
}) {
  // The anchor names the companion the way the transcript will: the profile's
  // own name, or the catalog's word for an unnamed one, so the invitation's own
  // line is never a half-sentence. There is no plate above it: the app bar
  // already carries the companion's monogram and name on every surface, and a
  // third printing of the same name is not an anchor.
  const anchorName = companionName.trim() || labels.companion;
  /**
   * The conversation's own name, or null when there is nothing to name it with.
   *
   * The Host publishes a `title` only once a conversation has been named, so an
   * unnamed one is the catalogue's own word for it (`untitledChat`) - that word
   * IS the conversation's name, not a placeholder to suppress. In the Chats list
   * that word carries the row's own number (`{{index}}`), because two unnamed
   * rows in one list are otherwise the same row twice; this band names the single
   * conversation that is open, so it drops the row's number instead of printing
   * one that refers to no row here. The band is shown once the conversation has
   * either a title or content, so a player who switched conversations can see
   * which one is open. It stays absent on the zero-message first screen, where the
   * surface heading and the invitation already name the screen and a second title
   * would only stack (gate 7 pins that).
   */
  const conversationName =
    chatTitle !== null || transcript.length > 0 || preview !== null
      ? (chatTitle ?? labels.untitledChat.replace("{{index}}", "").trim())
      : null;
  const sectionRef = useRef<HTMLElement>(null);
  /**
   * Whether the reader is parked at the newest content. A streaming reply
   * re-renders this component on every token, so the follow-the-tail effect
   * below must not drag a reader who has scrolled up back to the bottom. It
   * follows only while they are already at the tail; otherwise it leaves the
   * viewport exactly where they put it. The ref starts `true` so an
   * already-populated transcript still begins scrolled to the end on mount.
   */
  const atBottomRef = useRef(true);
  const onSwipeRef = useRef(onSwipe);
  const onSwipeRemoveRef = useRef(onSwipeRemove);
  const onSwipeRemoveConfirmRef = useRef(onSwipeRemoveConfirm);
  const onSwipeRemoveCancelRef = useRef(onSwipeRemoveCancel);
  const onRegenerateRef = useRef(onRegenerate);
  const onOpeningVariantRef = useRef(onOpeningVariant);
  const onRewindRef = useRef(onRewind);
  const onRewindConfirmRef = useRef(onRewindConfirm);
  const onRewindCancelRef = useRef(onRewindCancel);
  const onEditRef = useRef(onEdit);
  const onDeleteRef = useRef(onDelete);
  const onDeleteConfirmRef = useRef(onDeleteConfirm);
  const onDeleteCancelRef = useRef(onDeleteCancel);

  // The handler props are re-created by the shell on every render - including
  // every streaming delta - so they are re-read through refs and the callbacks
  // handed to the bubbles keep one identity for their whole life. With a
  // per-delta identity, `memo` could never bail out and every settled message
  // would re-render (and re-parse its Markdown) on every token.
  useLayoutEffect(() => {
    onSwipeRef.current = onSwipe;
    onSwipeRemoveRef.current = onSwipeRemove;
    onSwipeRemoveConfirmRef.current = onSwipeRemoveConfirm;
    onSwipeRemoveCancelRef.current = onSwipeRemoveCancel;
    onRegenerateRef.current = onRegenerate;
    onOpeningVariantRef.current = onOpeningVariant;
    onRewindRef.current = onRewind;
    onRewindConfirmRef.current = onRewindConfirm;
    onRewindCancelRef.current = onRewindCancel;
    onEditRef.current = onEdit;
    onDeleteRef.current = onDelete;
    onDeleteConfirmRef.current = onDeleteConfirm;
    onDeleteCancelRef.current = onDeleteCancel;
  });

  const handleSwipe = useCallback((messageHandle: string, direction: "prev" | "next") => {
    onSwipeRef.current?.(messageHandle, direction);
  }, []);
  const handleSwipeRemove = useCallback((messageHandle: string, targetIndex: number) => {
    onSwipeRemoveRef.current?.(messageHandle, targetIndex);
  }, []);
  const handleSwipeRemoveConfirm = useCallback((messageHandle: string, targetIndex: number) => {
    onSwipeRemoveConfirmRef.current?.(messageHandle, targetIndex);
  }, []);
  const handleSwipeRemoveCancel = useCallback(() => {
    onSwipeRemoveCancelRef.current?.();
  }, []);
  const handleRegenerate = useCallback((messageHandle: string) => {
    onRegenerateRef.current?.(messageHandle);
  }, []);
  const handleOpeningVariant = useCallback((messageHandle: string, direction: "prev" | "next") => {
    onOpeningVariantRef.current?.(messageHandle, direction);
  }, []);
  const handleRewind = useCallback((messageHandle: string, expectedOrder: number) => {
    onRewindRef.current?.(messageHandle, expectedOrder);
  }, []);
  const handleRewindConfirm = useCallback((messageHandle: string, expectedOrder: number) => {
    onRewindConfirmRef.current?.(messageHandle, expectedOrder);
  }, []);
  const handleRewindCancel = useCallback(() => {
    onRewindCancelRef.current?.();
  }, []);
  const handleEdit = useCallback((messageHandle: string, expectedOrder: number, text: string) => {
    onEditRef.current?.(messageHandle, expectedOrder, text);
  }, []);
  const handleDelete = useCallback((messageHandle: string, expectedOrder: number) => {
    onDeleteRef.current?.(messageHandle, expectedOrder);
  }, []);
  const handleDeleteConfirm = useCallback((messageHandle: string, expectedOrder: number) => {
    onDeleteConfirmRef.current?.(messageHandle, expectedOrder);
  }, []);
  const handleDeleteCancel = useCallback(() => {
    onDeleteCancelRef.current?.();
  }, []);
  // A caller that passed no handler keeps no control: the bubble gates its
  // swipe/regenerate affordances on the handler being present.
  const swipeHandler = onSwipe === undefined ? undefined : handleSwipe;
  const swipeRemoveHandler = onSwipeRemove === undefined ? undefined : handleSwipeRemove;
  const swipeRemoveConfirmHandler = onSwipeRemoveConfirm === undefined ? undefined : handleSwipeRemoveConfirm;
  const regenerateHandler = onRegenerate === undefined ? undefined : handleRegenerate;
  const openingVariantHandler = onOpeningVariant === undefined ? undefined : handleOpeningVariant;
  const rewindHandler = onRewind === undefined ? undefined : handleRewind;
  const rewindConfirmHandler = onRewindConfirm === undefined ? undefined : handleRewindConfirm;
  const editHandler = onEdit === undefined ? undefined : handleEdit;
  const deleteHandler = onDelete === undefined ? undefined : handleDelete;
  const deleteConfirmHandler = onDeleteConfirm === undefined ? undefined : handleDeleteConfirm;
  /**
   * Regeneration re-asks the last thing the player said, so exactly one row can offer it: the
   * transcript's own last message. Two shapes of that row are legal, and the Host refuses every
   * other one (`regenerate` in `chat-pipeline-service.ts`):
   *
   *  - her reply, with a player row before it. The turn re-asks that player turn at her reply's own
   *    position, so the reply the player reads changes in place.
   *  - the player's own line, when nothing answered it. A turn that fails or is stopped commits no
   *    reply, and acceptance wrote their row before the provider ran, so their line is the tail - by
   *    construction, not by accident. Regenerating it re-asks that line and the reply appends behind
   *    it. It is offered only while no turn is in flight: a live turn may still answer the line, and
   *    the Host refuses the target until the ledger is terminal.
   *
   * The opening is message zero - the only companion message a transcript can begin with - and it
   * has no player turn to repeat, so it never carries the control. "A player row exists" is the
   * Host's precondition for the first shape and counting rows is not: a transcript whose player line
   * was deleted still ends on her reply with more than one row, and the Host refuses it for want of a
   * player turn.
   */
  const tailMessage = transcript[transcript.length - 1];
  const tailOffersRegenerate =
    tailMessage === undefined
      ? false
      : tailMessage.role === "companion"
        ? transcript.some((message) => message.role === "player")
        : !turnInFlight;
  const regenerateHandle =
    regenerateHandler !== undefined && tailMessage !== undefined && tailOffersRegenerate ? tailMessage.handle : null;
  /**
   * The row the mounted turn's generation wrote. A turn commits exactly one reply, and that reply
   * is the transcript's last message when it is a companion's - the tail row `regenerateHandle`
   * reads one line above - which is why the sentence and the Regenerate button it names stand on
   * the same row rather than on two.
   */
  const truncatedHandle =
    replyTruncated && transcript.length > 1 && transcript[transcript.length - 1]?.role === "companion"
      ? transcript[transcript.length - 1]!.handle
      : null;
  /**
   * The conversation's one spoken fact, and the policy behind it.
   *
   * A reply that takes twenty seconds to write is total silence for a screen-reader player, and the
   * obvious repair is worse than the silence: a live region holding the streaming text re-reads the
   * same paragraph on every token, twenty to fifty times a second. So the preview is not a live
   * region at all - it is `aria-busy` while it streams (`MessageBubble.streaming`), which says the
   * row is being updated without reading it aloud - and this region says only the one thing a busy
   * row cannot say: that the reply landed.
   *
   * The reply's START needs no sentence here: the app bar's own `role="status"` speaks the
   * generating word from the turn's admission and holds it until the turn is terminal
   * (`appBarStatus`), and a second sentence a few hundred milliseconds later about the same moment
   * is how a reader learns to ignore both.
   *
   * The region is emptied when the next reply starts, because an announcement is a CHANGE: two
   * replies in a row both land on the same sentence, and the second one has to be able to say it.
   */
  const streaming = preview !== null;
  const [announcement, setAnnouncement] = useState("");
  /** A stream this surface watched is still running. */
  const watchedStreamRef = useRef(false);
  /** The row that stream was answering, read when it started: the transcript may have moved since. */
  const streamAnchorRef = useRef<string | null>(null);
  /** A commit still owed when its stream stopped and the reply had not arrived yet. */
  const owedReplyRef = useRef<Readonly<{ anchor: string | null }> | null>(null);
  /**
   * The commit does not land with the last delta. The wire clears the preview on `message.committed`
   * and the transcript arrives on the read that follows (ComposedReferenceGameApp), so the stream
   * stops one render before the reply exists - and the reply that is not here yet is owed, then said
   * the moment a companion row closes the transcript. If the player leaves the conversation first,
   * the row the stream was answering is gone with it and nothing is said: another chat's reply is
   * not this turn's.
   */
  useEffect(() => {
    const tail = transcript[transcript.length - 1];
    const anchorIsMounted = (anchor: string | null): boolean =>
      anchor === null || transcript.some((message) => message.handle === anchor);
    if (streaming) {
      watchedStreamRef.current = true;
      owedReplyRef.current = null;
      streamAnchorRef.current = tail?.handle ?? null;
      setAnnouncement("");
      return;
    }
    if (watchedStreamRef.current) {
      watchedStreamRef.current = false;
      const anchor = streamAnchorRef.current;
      streamAnchorRef.current = null;
      if (!anchorIsMounted(anchor)) return;
      if (tail !== undefined && tail.role === "companion") {
        setAnnouncement(labels.chatReplyReady);
        return;
      }
      owedReplyRef.current = Object.freeze({ anchor });
      return;
    }
    const owed = owedReplyRef.current;
    if (owed === null || tail === undefined || tail.role !== "companion") return;
    if (!anchorIsMounted(owed.anchor)) return;
    owedReplyRef.current = null;
    setAnnouncement(labels.chatReplyReady);
  }, [streaming, transcript, labels.chatReplyReady]);

  // Track the reader's own position: every scroll (a wheel, a drag, a keyboard
  // page-down or our own programmatic follow) updates whether they are at the
  // tail. `passive` because the listener never prevents the native scroll.
  useEffect(() => {
    const section = sectionRef.current;
    if (section === null) return;
    const onScroll = (): void => {
      atBottomRef.current = isAtBottom(section);
    };
    section.addEventListener("scroll", onScroll, { passive: true });
    return () => section.removeEventListener("scroll", onScroll);
  }, []);

  // Keep the newest content in view, but only while the reader is already
  // following it. A layout effect runs synchronously after the DOM mutation and
  // before paint, so the decision uses the reader's last real scroll and cannot
  // race an asynchronous scroll event triggered by the content change itself.
  // The effect re-runs when the visible content changes (message count, the
  // streaming preview text, or the optimistic player message appearing or
  // clearing) and on mount; a reader who scrolled up keeps their position,
  // because `atBottomRef` is then false.
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (section === null || !atBottomRef.current) return;
    section.scrollTop = section.scrollHeight;
  }, [transcript.length, preview?.text, pendingPlayerMessage?.text]);

  return (
    // The transcript scrolls, and a scrollable region that cannot take focus is
    // unreachable for a keyboard-only player (axe: scrollable-region-focusable,
    // serious). tabIndex makes the region itself the scroll target; the label is
    // already the region's accessible name, so focus announces where it landed.
    <section ref={sectionRef} className="timeline" aria-label={labels.chatTranscript} tabIndex={0}>
      {/* The conversation's one spoken fact - see the state above for what it says and why the
          streaming row says nothing. `role="status"` is the product's own polite region (`AppBar`,
          the composer, the row's own receipts), so the reader is told once and nothing interrupts;
          `visually-hidden` because the same fact is already on screen for everyone else. */}
      <p className="visually-hidden" role="status" data-testid="chat-announcement">
        {announcement}
      </p>
      {/* The title band names the conversation the player is reading: the Host's
          own title when it published one, otherwise the catalogue's word for an
          untitled conversation. It is the one place the surface says which
          conversation is open after a switch. */}
      {conversationName !== null && (
        <div className="timeline-heading">
          <h1>{conversationName}</h1>
        </div>
      )}
      {transcript.length === 0 && preview === null && pendingPlayerMessage === null ? (
        // A conversation that has not started yet is the first thing a player
        // sees. The dry "no messages" line it used to carry reads as a surface
        // that failed to load; one warm invitation in the secondary grey says the
        // same fact as an invitation instead, and the app bar above already
        // carries the companion's monogram and name. It is the transcript's own
        // zero state, so the first message replaces it.
        //
        // The optimistic player message is that first message already: the
        // moment the player sends, it is appended below this block, and leaving
        // the invitation up as well showed the player a zero state and their own
        // in-flight line at the same time. The invitation belongs to the empty
        // conversation, so it yields to the message that ends the emptiness.
        <div className="empty-state empty-state-anchor" data-empty-anchor="">
          <p className="empty-state-opening">{labels.emptyChatOpening.replace("{{name}}", anchorName)}</p>
        </div>
      ) : (
        <ol className="message-list">
          {transcript.map((message) => (
            <MessageBubble
              key={message.handle}
              message={message}
              companionName={companionName}
              companionHandle={companionHandle}
              companionDigest={companionDigest}
              playerLabel={labels.you}
              labels={labels}
              pending={pending !== null && pending.handle === message.handle ? pending.kind : null}
              onSwipe={swipeHandler}
              onSwipeRemove={swipeRemoveHandler}
              onSwipeRemoveConfirm={swipeRemoveConfirmHandler}
              onSwipeRemoveCancel={onSwipeRemoveCancel === undefined ? undefined : handleSwipeRemoveCancel}
              swipeRemoveArmed={swipeRemoveArmedHandle === message.handle}
              onRegenerate={message.handle === regenerateHandle ? regenerateHandler : undefined}
              onOpeningVariant={openingVariantHandler}
              onRewind={rewindHandler}
              onRewindConfirm={rewindConfirmHandler}
              onRewindCancel={onRewindCancel === undefined ? undefined : handleRewindCancel}
              rewindArmed={rewindArmedHandle === message.handle}
              onEdit={editHandler}
              onDelete={deleteHandler}
              onDeleteConfirm={deleteConfirmHandler}
              onDeleteCancel={onDeleteCancel === undefined ? undefined : handleDeleteCancel}
              deleteArmed={deleteArmedHandle === message.handle}
              truncatedNote={message.handle === truncatedHandle ? labels.chatReplyCutOff : null}
              removedCount={transcript.length - message.order}
            />
          ))}
          {preview !== null && (
            <MessageBubble
              message={Object.freeze({
                // The preview exists only for the active event-stream turn;
                // suffixing preserves a React key disjoint from durable rows.
                handle: `${preview.turnHandle}_preview`,
                role: "companion" as const,
                text: preview.text,
                locale: "und" as const,
                order: transcript.length,
                revision: 0,
              })}
              companionName={companionName}
              companionHandle={companionHandle}
              companionDigest={companionDigest}
              playerLabel={labels.you}
              labels={labels}
              streaming
            />
          )}
        </ol>
      )}
      {/* The optimistic player message, appended to the reading flow the moment the
          player sends and cleared the moment the Host's own transcript carries the
          same line. `data-pending` is that marker for the shell.

          It is the *same row* as the authoritative one - the same component, the
          same avatar, bubble and measure - rendered outside the transcript's own
          list rather than as one of its rows: the send journey asserts the list
          carries none while this is visible, so a duplicate can never be the thing
          that gets counted. Rendering it separately is what made sending jump: a
          grey box the player wrote in became a wine bubble under a monogram. */}
      {pendingPlayerMessage !== null && (
        <div className="message-pending" data-pending="true" data-testid="optimistic-player-message">
          <MessageBubble
            as="div"
            message={Object.freeze({
              // The key is the send's own idempotency key, not a durable handle:
              // this row is a local echo and never names a Host record.
              handle: `pending_${pendingPlayerMessage.idempotencyKey}`,
              role: "player" as const,
              text: pendingPlayerMessage.text,
              locale: "und" as const,
              order: transcript.length,
              revision: 0,
            })}
            companionName={companionName}
            companionHandle={companionHandle}
            playerLabel={labels.you}
            labels={labels}
            waitingNote={labels.chatSending}
          />
        </div>
      )}
    </section>
  );
}
