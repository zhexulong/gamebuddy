/**
 * A mounted probe for the chat surface presentation primitives.
 *
 * It mounts the real `Timeline` -> `MessageBubble` -> markdown renderer over a
 * real DOM, with the transcript driven from the test through `window.chatProbe`.
 * The committed messages carry an instrumented `text` accessor, so a test can
 * observe exactly when a settled message is *read* - i.e. when its bubble
 * actually rendered - without instrumenting the product components.
 *
 * This file is a test fixture, not product code: it is served by the Vite dev
 * server for the Playwright spec and is never imported by the shell.
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BrowserMessageV1 } from "../src/reference-pipeline-api";
import { Composer, type VoiceSurfaceStateV1 } from "../src/components/Composer";
import { Timeline } from "../src/components/Timeline";
import { messages } from "../src/i18n";

const LABELS = messages("en");

const reads = new Map<string, number>();

/**
 * A committed companion message whose `text` is a getter. `React.memo` on the
 * bubble compares the `message` prop by reference and bails without reading it,
 * so a read only happens when the bubble's body genuinely ran.
 */
function tracked(handle: string, text: string, order: number): BrowserMessageV1 {
  const base = { handle, role: "companion" as const, locale: "und" as const, order, revision: 1 };
  Object.defineProperty(base, "text", {
    enumerable: true,
    get() {
      reads.set(handle, (reads.get(handle) ?? 0) + 1);
      return text;
    },
  });
  return Object.freeze(base) as BrowserMessageV1;
}

type Model = Readonly<{
  transcript: readonly BrowserMessageV1[];
  preview: Readonly<{ turnHandle: string; text: string }> | null;
  voice: VoiceSurfaceStateV1 | null;
}>;

let model: Model = { transcript: [], preview: null, voice: null };
let rerender: (() => void) | null = null;

function Probe() {
  const [, bump] = useState(0);
  useEffect(() => {
    rerender = () => bump((count) => count + 1);
    return () => {
      rerender = null;
    };
  }, []);
  return (
    <>
      <Timeline
        transcript={model.transcript}
        preview={model.preview}
        companionName="Mira"
        chatTitle="Probe"
        labels={LABELS}
      />
      <Composer
        value=""
        onChange={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
        isGenerating={false}
        labels={LABELS}
        voice={model.voice}
      />
    </>
  );
}

const chatProbe = {
  setTranscript(texts: readonly string[]): void {
    model = { ...model, transcript: texts.map((text, index) => tracked(`h${index}`, text, index)) };
    rerender?.();
  },
  setPreview(text: string | null): void {
    model = { ...model, preview: text === null ? null : { turnHandle: "T", text } };
    rerender?.();
  },
  setVoice(state: VoiceSurfaceStateV1 | null): void {
    model = { ...model, voice: state };
    rerender?.();
  },
  voiceState(): string | null {
    return document.querySelector("[data-voice-state]")?.getAttribute("data-voice-state") ?? null;
  },
  voiceLabel(): string | null {
    return document.querySelector(".voice-status-label")?.textContent ?? null;
  },
  bubbleHtml(handle: string): string | null {
    return (
      document.querySelector(`li[data-handle="${handle}"] .message-bubble`)?.innerHTML ?? null
    );
  },
  textReads(handle: string): number {
    return reads.get(handle) ?? 0;
  },
  totalTextReads(): number {
    let total = 0;
    for (const count of reads.values()) total += count;
    return total;
  },
  resetTextReads(): void {
    reads.clear();
  },
};

(window as unknown as { chatProbe: typeof chatProbe }).chatProbe = chatProbe;

createRoot(document.getElementById("probe-root")!).render(<Probe />);
