import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { BrowserMessageV1 } from "../reference-pipeline-api";
import { MessageBubble } from "./MessageBubble";

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
    regenerateVariant: string;
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
}) {
  const displayTitle = chatTitle ?? labels.untitledChat;
  // The anchor names the companion the way the transcript will: the profile's
  // own name, or the catalog's word for an unnamed one, so the plate and the
  // line under it are never blank and never a half-sentence.
  const anchorName = companionName.trim() || labels.companion;
  const sectionRef = useRef<HTMLElement>(null);
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

  // Keep the newest message in view: the effect re-runs when the visible
  // content changes (message count or the streaming preview text) and also on
  // mount, so an already-populated transcript still starts scrolled to the end.
  useEffect(() => {
    if (sectionRef.current) {
      sectionRef.current.scrollTop = sectionRef.current.scrollHeight;
    }
  }, [transcript.length, preview?.text]);

  return (
    // The transcript scrolls, and a scrollable region that cannot take focus is
    // unreachable for a keyboard-only player (axe: scrollable-region-focusable,
    // serious). tabIndex makes the region itself the scroll target; the label is
    // already the region's accessible name, so focus announces where it landed.
    <section
      ref={sectionRef}
      className="timeline"
      aria-label={labels.chatTranscript}
      tabIndex={0}
    >
      <div className="timeline-heading">
        <h1>{displayTitle}</h1>
      </div>
      {transcript.length === 0 && preview === null ? (
        // A conversation that has not started yet is the first thing a player
        // sees. The dry "no messages" line it used to carry reads as a surface
        // that failed to load; the companion's name plate and one warm line in
        // the secondary grey say the same fact as an invitation instead. It is
        // the transcript's own zero state, so the first message replaces it.
        <div className="empty-state empty-state-anchor" data-empty-anchor="">
          <span className="empty-state-nameplate">{anchorName}</span>
          <p className="empty-state-opening">
            {labels.emptyChatOpening.replace("{{name}}", anchorName)}
          </p>
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
              onRegenerate={regenerateHandler}
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
