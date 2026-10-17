import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
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
  chatTitle,
  labels,
  preview = null,
  onSwipe,
  onRegenerate,
  onOpeningVariant,
  pending = null,
  pendingPlayerMessage = null,
}: {
  transcript: readonly BrowserMessageV1[];
  preview?: Readonly<{ turnHandle: string; text: string }> | null;
  companionName: string;
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
    regenerateVariant: string;
    /** The catalogue's words for the Host's own greeting-variant labels. */
    openingVariantDefault: string;
    openingVariantAlternate: string;
  };
  onSwipe?: (messageHandle: string, direction: "prev" | "next") => void;
  onRegenerate?: (messageHandle: string) => void;
  /** The new-chat opening choice for the first message; offered only when the Host publishes one. */
  onOpeningVariant?: (messageHandle: string, direction: "prev" | "next") => void;
  /**
   * The chat mutation in flight and the message it belongs to, if any. Only that
   * message's own controls go busy, so a swipe on one variant never disables the
   * regenerate affordance of another.
   */
  pending?: Readonly<{ kind: "swipe" | "regenerate" | "opening"; handle: string }> | null;
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
  const onRegenerateRef = useRef(onRegenerate);
  const onOpeningVariantRef = useRef(onOpeningVariant);

  // The handler props are re-created by the shell on every render - including
  // every streaming delta - so they are re-read through refs and the callbacks
  // handed to the bubbles keep one identity for their whole life. With a
  // per-delta identity, `memo` could never bail out and every settled message
  // would re-render (and re-parse its Markdown) on every token.
  useLayoutEffect(() => {
    onSwipeRef.current = onSwipe;
    onRegenerateRef.current = onRegenerate;
    onOpeningVariantRef.current = onOpeningVariant;
  });

  const handleSwipe = useCallback((messageHandle: string, direction: "prev" | "next") => {
    onSwipeRef.current?.(messageHandle, direction);
  }, []);
  const handleRegenerate = useCallback((messageHandle: string) => {
    onRegenerateRef.current?.(messageHandle);
  }, []);
  const handleOpeningVariant = useCallback((messageHandle: string, direction: "prev" | "next") => {
    onOpeningVariantRef.current?.(messageHandle, direction);
  }, []);
  // A caller that passed no handler keeps no control: the bubble gates its
  // swipe/regenerate affordances on the handler being present.
  const swipeHandler = onSwipe === undefined ? undefined : handleSwipe;
  const regenerateHandler = onRegenerate === undefined ? undefined : handleRegenerate;
  const openingVariantHandler = onOpeningVariant === undefined ? undefined : handleOpeningVariant;
  /**
   * Regeneration re-asks the last thing the player said, so exactly one row can
   * offer it: the transcript's own last message, when that message is a companion
   * reply. The opening is message zero - the only companion message a transcript
   * can begin with - and it has no player turn to repeat, so it never carries the
   * control. The rule is the Host's own precondition (`regenerate` in
   * `chat-pipeline-service.ts` refuses every other target), stated here so the
   * surface never offers an affordance the Host would have to reject.
   */
  const regenerateHandle =
    regenerateHandler !== undefined && transcript.length > 1 && transcript[transcript.length - 1]?.role === "companion"
      ? transcript[transcript.length - 1]!.handle
      : null;

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
              playerLabel={labels.you}
              labels={labels}
              pending={pending !== null && pending.handle === message.handle ? pending.kind : null}
              onSwipe={swipeHandler}
              onRegenerate={message.handle === regenerateHandle ? regenerateHandler : undefined}
              onOpeningVariant={openingVariantHandler}
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
            playerLabel={labels.you}
            labels={labels}
            waitingNote={labels.chatSending}
          />
        </div>
      )}
    </section>
  );
}
