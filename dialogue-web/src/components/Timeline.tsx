import { useEffect, useRef } from "react";
import type { P3Message } from "../p3-browser-api";
import { MessageBubble } from "./MessageBubble";

export function Timeline({
  transcript,
  companionName,
  chatTitle,
  labels,
}: {
  transcript: readonly P3Message[];
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
  }, [transcript]);

  return (
    <section ref={sectionRef} className="timeline" aria-label={labels.chatTranscript}>
      <div className="timeline-heading">
        <h1>{displayTitle}</h1>
      </div>
      {transcript.length === 0 ? (
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
        </ol>
      )}
    </section>
  );
}
