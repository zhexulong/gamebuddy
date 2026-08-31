import { useEffect, useRef } from "react";
import type { BrowserMessageV1 } from "../reference-pipeline-api";
import { MessageBubble } from "./MessageBubble";

export function Timeline({
  transcript,
  companionName,
  chatTitle,
  labels,
  preview = null,
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
}) {
  const displayTitle = chatTitle ?? labels.untitledChat;
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (sectionRef.current) {
      sectionRef.current.scrollTop = sectionRef.current.scrollHeight;
    }
  }, []);

  return (
    <section ref={sectionRef} className="timeline" aria-label={labels.chatTranscript}>
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
