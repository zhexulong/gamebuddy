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
 * What the composer actually handed to the surface's send path. A keyboard
 * journey has to observe the *send*, not the field's contents: a composer that
 * leaves the text in the field on Enter looks identical in the DOM.
 */
const sends: string[] = [];

/**
 * A committed companion message whose `text` is a getter. `React.memo` on the
 * bubble compares the `message` prop by reference and bails without reading it,
 * so a read only happens when the bubble's body genuinely ran.
 */
function tracked(
  handle: string,
  text: string,
  order: number,
  role: "player" | "companion" = "companion",
): BrowserMessageV1 {
  const base = { handle, role, locale: "und" as const, order, revision: 1 };
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
  /** The chat mutation in flight, exactly as the shell projects it to Timeline. */
  pending: Readonly<{ kind: "swipe" | "regenerate"; handle: string }> | null;
}>;

let model: Model = { transcript: [], preview: null, voice: null, pending: null };
let rerender: (() => void) | null = null;

function Probe() {
  const [, bump] = useState(0);
  const [drafted, setDrafted] = useState("");
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
        onSwipe={() => undefined}
        onRegenerate={() => undefined}
        pending={model.pending}
      />
      <Composer
        value={drafted}
        onChange={setDrafted}
        onSend={() => {
          sends.push(drafted);
          setDrafted("");
        }}
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
  /**
   * A transcript with explicit roles. `setTranscript` is the renderer's own
   * all-companion shortcut; a journey about the regenerate affordance needs a
   * real conversation, because that control is legal on exactly one row - the
   * transcript's last, when the companion spoke it - and never on the opening.
   */
  setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void {
    model = {
      ...model,
      transcript: entries.map((entry, index) => tracked(`h${index}`, entry.text, index, entry.role)),
    };
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
  setPending(pending: { kind: "swipe" | "regenerate"; handle: string } | null): void {
    model = { ...model, pending };
    rerender?.();
  },
  /** A transcript entry with swipe variants, so the swipe controls are offered. */
  withSwipes(handle: string, text: string): void {
    const existing = model.transcript.find((m) => m.handle === handle);
    const swiped: BrowserMessageV1 = Object.freeze({
      handle,
      role: existing?.role ?? "companion",
      text,
      locale: existing?.locale ?? "und",
      order: existing?.order ?? 0,
      revision: existing?.revision ?? 1,
      swipeInfo: Object.freeze({
        currentIndex: 1,
        totalSwipes: 3,
        label: "2/3",
        hasPrevious: true,
        hasNext: true,
      }),
    });
    const idx = model.transcript.findIndex((m) => m.handle === handle);
    const transcript =
      idx === -1
        ? [...model.transcript, swiped]
        : model.transcript.map((m, i) => (i === idx ? swiped : m));
    model = { ...model, transcript };
    rerender?.();
  },
  /** True when the bubble for `handle` carries the busy pending projection. */
  pendingAttrs(handle: string): { ariaBusy: string | null; dataPending: string | null; swipeDisabled: boolean; regenerateDisabled: boolean } | null {
    const li = document.querySelector(`li[data-handle="${handle}"]`);
    if (li === null) return null;
    return {
      ariaBusy: li.getAttribute("aria-busy"),
      dataPending: li.getAttribute("data-pending"),
      swipeDisabled: [...li.querySelectorAll(".swipe-btn")].every((b) => (b as HTMLButtonElement).disabled) && li.querySelectorAll(".swipe-btn").length > 0,
      regenerateDisabled: (li.querySelector(".regenerate-btn") as HTMLButtonElement | null)?.disabled ?? false,
    };
  },
  voiceState(): string | null {
    return document.querySelector("[data-voice-state]")?.getAttribute("data-voice-state") ?? null;
  },
  voiceLabel(): string | null {
    return document.querySelector(".voice-status-label")?.textContent ?? null;
  },
  /**
   * The computed motion of the mic's halo. The element being present proves
   * nothing about what the player sees, so this reads the resolved animation
   * the stylesheet actually applies to it.
   */
  voicePulse(): { animationName: string; animationDuration: string; transform: string } | null {
    const ring = document.querySelector(".voice-pulse-ring");
    if (ring === null) return null;
    const style = getComputedStyle(ring);
    return {
      animationName: style.animationName,
      animationDuration: style.animationDuration,
      transform: style.transform,
    };
  },
  bubbleHtml(handle: string): string | null {
    return (
      document.querySelector(`li[data-handle="${handle}"] .message-bubble`)?.innerHTML ?? null
    );
  },
  /**
   * The computed reading treatment of a narration beat, next to the value the
   * token it must resolve to actually has. A class name in the markup proves
   * nothing: this proves the style applied.
   */
  narrationStyle(handle: string): { color: string; expectedColor: string; fontStyle: string } | null {
    const em = document.querySelector(`li[data-handle="${handle}"] em.message-action`);
    if (em === null) return null;
    const probe = document.createElement("span");
    probe.style.color = "var(--palette-gray-400)";
    document.body.appendChild(probe);
    const expectedColor = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(em);
    return { color: style.color, expectedColor, fontStyle: style.fontStyle };
  },
  /**
   * The computed busy treatment of a bubble. The `data-pending` attribute is
   * the shell's label; this is the rendering the label is supposed to produce,
   * so a pending row that animates nothing is caught.
   */
  pendingAnimation(
    handle: string,
  ): { animationName: string; animationDuration: string; transitionDuration: string } | null {
    const bubble = document.querySelector(`li[data-handle="${handle}"] .message-bubble`);
    if (bubble === null) return null;
    const style = getComputedStyle(bubble);
    return {
      animationName: style.animationName,
      animationDuration: style.animationDuration,
      transitionDuration: style.transitionDuration,
    };
  },
  /**
   * The live caret's box against the bubble's own box. Where the caret sits in
   * the markup proves nothing about where it is painted - a sibling of the bubble
   * can still be laid out inside it - so this reads both rects and lets the spec
   * assert containment.
   */
  caretGeometry(handle: string): {
    caret: { top: number; right: number; bottom: number; left: number; width: number; height: number };
    bubble: { top: number; right: number; bottom: number; left: number; width: number; height: number };
  } | null {
    const row = document.querySelector(`li[data-handle="${handle}"]`);
    const bubble = row?.querySelector(".message-bubble") ?? null;
    const caret = row?.querySelector(".message-caret") ?? null;
    if (bubble === null || caret === null) return null;
    const box = (element: Element) => {
      const { top, right, bottom, left, width, height } = element.getBoundingClientRect();
      return { top, right, bottom, left, width, height };
    };
    return { caret: box(caret), bubble: box(bubble) };
  },
  /** The composer field's live value, so a newline can be told from a send. */
  composerValue(): string | null {
    return document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")?.value ?? null;
  },
  /** Every send the composer performed, in order. */
  sends(): readonly string[] {
    return [...sends];
  },
  resetSends(): void {
    sends.length = 0;
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
