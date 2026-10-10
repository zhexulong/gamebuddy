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
}: {
  transcript: readonly BrowserMessageV1[];
  preview?: Readonly<{ turnHandle: string; text: string }> | null;
  companionName: string;
  chatTitle: string | null;
  labels: {
    chatTranscript: string;
    emptyChat: string;
    untitledChat: string;
    you: string;
  };
  onSwipe?: (messageHandle: string, direction: "prev" | "next") => void;
  onRegenerate?: (messageHandle: string) => void;
}) {
  const displayTitle = chatTitle ?? labels.untitledChat;
  const sectionRef = useRef<HTMLElement>(null);
  const onSwipeRef = useRef(onSwipe);
  const onRegenerateRef = useRef(onRegenerate);

  // The handler props are re-created by the shell on every render - including
  // every streaming delta - so they are re-read through refs and the callbacks
  // handed to the bubbles keep one identity for their whole life. With a
  // per-delta identity, `memo` could never bail out and every settled message
  // would re-render (and re-parse its Markdown) on every token.
  useLayoutEffect(() => {
    onSwipeRef.current = onSwipe;
    onRegenerateRef.current = onRegenerate;
  });

  const handleSwipe = useCallback((messageHandle: string, direction: "prev" | "next") => {
    onSwipeRef.current?.(messageHandle, direction);
  }, []);
  const handleRegenerate = useCallback((messageHandle: string) => {
    onRegenerateRef.current?.(messageHandle);
  }, []);
  // A caller that passed no handler keeps no control: the bubble gates its
  // swipe/regenerate affordances on the handler being present.
  const swipeHandler = onSwipe === undefined ? undefined : handleSwipe;
  const regenerateHandler = onRegenerate === undefined ? undefined : handleRegenerate;

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
        <div className="empty-state">
          <p>{labels.emptyChat}</p>
        </div>
      ) : (
        <ol className="message-list">
          {transcript.map((message) => (
            <MessageBubble
              key={message.handle}
              message={message}
              companionName={companionName}
              playerLabel={labels.you}
              onSwipe={swipeHandler}
              onRegenerate={regenerateHandler}
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
            />
          )}
        </ol>
      )}
    </section>
  );
}
