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
  onOpeningVariant,
  pending = null,
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
    swipeNavigation: string;
    swipePrevious: string;
    swipeNext: string;
    /** The catalogue's words for the Host's own greeting-variant labels. */
    openingVariantDefault: string;
    openingVariantAlternate: string;
  };
  /** The new-chat opening choice for the first message; offered only when the Host publishes one. */
  onOpeningVariant?: (messageHandle: string, direction: "prev" | "next") => void;
  /**
   * The chat mutation in flight and the message it belongs to, if any. Only that
   * message's own control goes busy.
   */
  pending?: Readonly<{ kind: "opening"; handle: string }> | null;
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
   * IS the conversation's name, not a placeholder to suppress. The band is shown
   * once the conversation has either a title or content, so a player who switched
   * conversations can see which one is open. It stays absent on the zero-message
   * first screen, where the surface heading and the invitation already name the
   * screen and a second title would only stack (gate 7 pins that).
   */
  const conversationName =
    chatTitle !== null || transcript.length > 0 || preview !== null ? (chatTitle ?? labels.untitledChat) : null;
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
  const onOpeningVariantRef = useRef(onOpeningVariant);

  // The handler props are re-created by the shell on every render - including
  // every streaming delta - so they are re-read through refs and the callbacks
  // handed to the bubbles keep one identity for their whole life. With a
  // per-delta identity, `memo` could never bail out and every settled message
  // would re-render (and re-parse its Markdown) on every token.
  useLayoutEffect(() => {
    onOpeningVariantRef.current = onOpeningVariant;
  });

  const handleOpeningVariant = useCallback((messageHandle: string, direction: "prev" | "next") => {
    onOpeningVariantRef.current?.(messageHandle, direction);
  }, []);
  const openingVariantHandler = onOpeningVariant === undefined ? undefined : handleOpeningVariant;

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
  // The effect re-runs when the visible content changes (message count or the
  // streaming preview text) and on mount; a reader who scrolled up keeps their
  // position, because `atBottomRef` is then false.
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (section === null || !atBottomRef.current) return;
    section.scrollTop = section.scrollHeight;
  }, [transcript.length, preview?.text]);

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
      {transcript.length === 0 && preview === null ? (
        // A conversation that has not started yet is the first thing a player
        // sees. The dry "no messages" line it used to carry reads as a surface
        // that failed to load; one warm invitation in the secondary grey says the
        // same fact as an invitation instead, and the app bar above already
        // carries the companion's monogram and name. It is the transcript's own
        // zero state, so the first message replaces it.
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
    </section>
  );
}
