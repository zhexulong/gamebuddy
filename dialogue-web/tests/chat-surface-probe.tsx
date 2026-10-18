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
  pending: Readonly<{ kind: "swipe" | "regenerate" | "opening" | "rewind" | "edit" | "delete"; handle: string }> | null;
  /** The one message whose rewind is armed, exactly as the shell projects it to Timeline. */
  rewindArmedHandle: string | null;
  /** The one message whose delete is armed, exactly as the shell projects it to Timeline. */
  deleteArmedHandle: string | null;
}>;

let model: Model = {
  transcript: [],
  preview: null,
  voice: null,
  pending: null,
  rewindArmedHandle: null,
  deleteArmedHandle: null,
};
let rerender: (() => void) | null = null;

/** Every rewind control a journey pressed, so a test can see what the surface sent. */
const rewindCalls: { kind: "arm" | "confirm" | "cancel"; handle: string; order: number }[] = [];

/** Every delete control a journey pressed, in the same shape as the rewind's. */
const deleteCalls: { kind: "arm" | "confirm" | "cancel"; handle: string; order: number }[] = [];

/** Every edit a journey saved, so a test can see the pair and the words the surface sent. */
const editCalls: { handle: string; order: number; text: string }[] = [];

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
        /*
         * The rewind drives the shell's own two-step shape: the arm is local presentation state
         * here, exactly as the shell keeps it, and the confirm is what a journey observes on the
         * way to the Host.
         */
        onRewind={(handle, order) => {
          rewindCalls.push({ kind: "arm", handle, order });
          model = { ...model, rewindArmedHandle: handle };
          rerender?.();
        }}
        onRewindConfirm={(handle, order) => {
          rewindCalls.push({ kind: "confirm", handle, order });
          model = { ...model, rewindArmedHandle: null };
          rerender?.();
        }}
        onRewindCancel={() => {
          rewindCalls.push({ kind: "cancel", handle: "", order: -1 });
          model = { ...model, rewindArmedHandle: null };
          rerender?.();
        }}
        rewindArmedHandle={model.rewindArmedHandle}
        onEdit={(handle, order, text) => {
          editCalls.push({ handle, order, text });
        }}
        /*
         * The delete drives the same two-step shape the shell keeps: the arm is local presentation
         * state here, and the confirm is what a journey observes on the way to the Host.
         */
        onDelete={(handle, order) => {
          deleteCalls.push({ kind: "arm", handle, order });
          model = { ...model, deleteArmedHandle: handle };
          rerender?.();
        }}
        onDeleteConfirm={(handle, order) => {
          deleteCalls.push({ kind: "confirm", handle, order });
          model = { ...model, deleteArmedHandle: null };
          rerender?.();
        }}
        onDeleteCancel={() => {
          deleteCalls.push({ kind: "cancel", handle: "", order: -1 });
          model = { ...model, deleteArmedHandle: null };
          rerender?.();
        }}
        deleteArmedHandle={model.deleteArmedHandle}
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
        canStop={false}
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
  setPending(pending: { kind: "swipe" | "regenerate" | "opening" | "rewind" | "edit" | "delete"; handle: string } | null): void {
    model = { ...model, pending };
    rerender?.();
  },
  /** Every arm, confirm and cancel this probe's delete control has sent. */
  deleteCalls(): readonly { kind: "arm" | "confirm" | "cancel"; handle: string; order: number }[] {
    return [...deleteCalls];
  },
  resetDeleteCalls(): void {
    deleteCalls.length = 0;
  },
  /**
   * The delete control as the player meets it: what it is called, the target it actually paints, and
   * the strip it sits in. The size is read from the layout rather than from a class name, because a
   * control under the touch minimum is the defect the journey exists for.
   */
  deleteControl(handle: string): {
    ariaLabel: string | null;
    title: string | null;
    label: string | null;
    width: number;
    height: number;
    stripHeight: number;
  } | null {
    const li = document.querySelector(`li[data-handle="${handle}"]`);
    const button = li?.querySelector('[data-testid="message-delete"]') as HTMLButtonElement | null;
    if (button === null || button === undefined) return null;
    const rect = button.getBoundingClientRect();
    const strip = li?.querySelector(".message-actions");
    return {
      ariaLabel: button.getAttribute("aria-label"),
      title: button.getAttribute("title"),
      label: button.textContent,
      width: rect.width,
      height: rect.height,
      stripHeight: strip === null || strip === undefined ? 0 : strip.getBoundingClientRect().height,
    };
  },
  /**
   * The armed delete confirmation on `handle`'s row: its prompt, its two answers, and how many of the
   * row's ordinary controls are still rendered beside it (the confirmation replaces them, not sits
   * among them).
   */
  deleteConfirm(handle: string): {
    prompt: string | null;
    yes: string | null;
    no: string | null;
    ordinaryControls: number;
  } | null {
    const li = document.querySelector(`li[data-handle="${handle}"]`);
    const confirm = li?.querySelector('[data-testid="message-delete-confirm"]');
    if (confirm === null || confirm === undefined) return null;
    return {
      prompt: confirm.querySelector(".message-confirm-prompt")?.textContent ?? null,
      yes: confirm.querySelector('[data-testid="message-delete-confirm-yes"]')?.textContent ?? null,
      no: confirm.querySelector('[data-testid="message-delete-confirm-no"]')?.textContent ?? null,
      ordinaryControls:
        li?.querySelectorAll(
          '.swipe-controls, .regenerate-btn, [data-testid="message-rewind"], [data-testid="message-edit"], [data-testid="message-delete"]',
        ).length ?? 0,
    };
  },
  /** Every edit this probe's save button sent. */
  editCalls(): readonly { handle: string; order: number; text: string }[] {
    return [...editCalls];
  },
  resetEditCalls(): void {
    editCalls.length = 0;
  },
  /**
   * The edit control as the player meets it: what it is called, the target it actually paints, and
   * the strip it sits in. The strip is the same row the reply uses, so its height is what says the
   * row did not wrap: one control of `--touch-target-min` measures one row, and a strip that wrapped
   * would be at least two.
   */
  editControl(handle: string): {
    ariaLabel: string | null;
    title: string | null;
    label: string | null;
    width: number;
    height: number;
    stripHeight: number;
  } | null {
    const li = document.querySelector(`li[data-handle="${handle}"]`);
    const button = li?.querySelector('[data-testid="message-edit"]') as HTMLButtonElement | null;
    if (button === null || button === undefined) return null;
    const rect = button.getBoundingClientRect();
    const strip = li?.querySelector(".message-actions");
    return {
      ariaLabel: button.getAttribute("aria-label"),
      title: button.getAttribute("title"),
      label: button.textContent,
      width: rect.width,
      height: rect.height,
      stripHeight: strip === null || strip === undefined ? 0 : strip.getBoundingClientRect().height,
    };
  },
  /**
   * The open editor on `handle`: the words in the field, and its two answers. `null` when the row is
   * not being edited, which is what says the field is not offered as a second resident control.
   */
  editForm(handle: string): { value: string | null; save: string | null; cancel: string | null } | null {
    const li = document.querySelector(`li[data-handle="${handle}"]`);
    const form = li?.querySelector('[data-testid="message-edit-form"]');
    if (form === null || form === undefined) return null;
    const field = form.querySelector('[data-testid="message-edit-field"]') as HTMLTextAreaElement | null;
    return {
      value: field === null ? null : field.value,
      save: form.querySelector('[data-testid="message-edit-save"]')?.textContent ?? null,
      cancel: form.querySelector('[data-testid="message-edit-cancel"]')?.textContent ?? null,
    };
  },
  /**
   * The authoritative reread's own effect on one row, for a journey about an edit that landed: the
   * transcript row is replaced with the words the Host now holds, keeping its handle and position.
   */
  applyEditedText(handle: string, text: string): void {
    const existing = model.transcript.find((message) => message.handle === handle);
    if (existing === undefined) return;
    const edited: BrowserMessageV1 = Object.freeze({ ...existing, text });
    model = {
      ...model,
      transcript: model.transcript.map((message) => (message.handle === handle ? edited : message)),
    };
    rerender?.();
  },
  /** Every arm, confirm and cancel this probe's rewind control has sent. */
  rewindCalls(): readonly { kind: "arm" | "confirm" | "cancel"; handle: string; order: number }[] {
    return [...rewindCalls];
  },
  resetRewindCalls(): void {
    rewindCalls.length = 0;
  },
  /**
   * The rewind control as the player meets it: what it is called, and the target it actually
   * paints. A control whose measured box is under the touch minimum is the defect the journey
   * exists for, so the size is read from the layout rather than from a class name.
   */
  rewindControl(handle: string): {
    ariaLabel: string | null;
    title: string | null;
    label: string | null;
    width: number;
    height: number;
  } | null {
    const li = document.querySelector(`li[data-handle="${handle}"]`);
    const button = li?.querySelector('[data-testid="message-rewind"]') as HTMLButtonElement | null;
    if (button === null || button === undefined) return null;
    const rect = button.getBoundingClientRect();
    return {
      ariaLabel: button.getAttribute("aria-label"),
      title: button.getAttribute("title"),
      label: button.textContent,
      width: rect.width,
      height: rect.height,
    };
  },
  /**
   * The armed confirmation on `handle`'s row: its prompt, its two answers, and how many of the
   * row's ordinary controls are still rendered beside it (the confirmation is meant to replace
   * them, not sit among them).
   */
  rewindConfirm(handle: string): {
    prompt: string | null;
    yes: string | null;
    no: string | null;
    ordinaryControls: number;
  } | null {
    const li = document.querySelector(`li[data-handle="${handle}"]`);
    const confirm = li?.querySelector('[data-testid="message-rewind-confirm"]');
    if (confirm === null || confirm === undefined) return null;
    return {
      prompt: confirm.querySelector(".message-confirm-prompt")?.textContent ?? null,
      yes: confirm.querySelector('[data-testid="message-rewind-confirm-yes"]')?.textContent ?? null,
      no: confirm.querySelector('[data-testid="message-rewind-confirm-no"]')?.textContent ?? null,
      ordinaryControls:
        (li?.querySelectorAll('.swipe-controls, .regenerate-btn, [data-testid="message-rewind"]').length ?? 0),
    };
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
  /** A transcript entry whose opening the Host still leaves open for choice. */
  withOpening(handle: string, text: string): void {
    const existing = model.transcript.find((m) => m.handle === handle);
    const opened: BrowserMessageV1 = Object.freeze({
      handle,
      role: existing?.role ?? "companion",
      text,
      locale: existing?.locale ?? "und",
      order: existing?.order ?? 0,
      revision: existing?.revision ?? 1,
      openingVariant: Object.freeze({ variantId: "V".repeat(42) + "A", index: 0, count: 2, label: "Default", locked: false }),
    });
    const idx = model.transcript.findIndex((m) => m.handle === handle);
    const transcript =
      idx === -1
        ? [...model.transcript, opened]
        : model.transcript.map((m, i) => (i === idx ? opened : m));
    model = { ...model, transcript };
    rerender?.();
  },
  /**
   * True when the bubble for `handle` carries the busy pending projection, and whether each of
   * its own controls is disabled. `switcherDisabled` and `swipeDisabled` read the same
   * `.swipe-btn` pair: the opening switcher and the variant switcher are one control shape, so a
   * row's pair is whichever of the two the Host published for it.
   */
  pendingAttrs(handle: string): {
    ariaBusy: string | null;
    dataPending: string | null;
    swipeDisabled: boolean;
    switcherDisabled: boolean;
    regenerateDisabled: boolean;
    rewindDisabled: boolean;
  } | null {
    const li = document.querySelector(`li[data-handle="${handle}"]`);
    if (li === null) return null;
    const buttons = [...li.querySelectorAll(".swipe-btn")] as HTMLButtonElement[];
    const switcherDisabled = buttons.length > 0 && buttons.every((button) => button.disabled);
    return {
      ariaBusy: li.getAttribute("aria-busy"),
      dataPending: li.getAttribute("data-pending"),
      swipeDisabled: switcherDisabled,
      switcherDisabled,
      regenerateDisabled: (li.querySelector(".regenerate-btn") as HTMLButtonElement | null)?.disabled ?? false,
      rewindDisabled:
        (li.querySelector('[data-testid="message-rewind"]') as HTMLButtonElement | null)?.disabled ?? false,
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
   * The computed reading treatment of a narration beat, next to the value each of
   * the two tokens it could be confused with actually has. A class name in the
   * markup proves nothing: this proves the style applied, that it is the
   * narration tone, and - in the spec - that it is not the disabled grey a form
   * field's own text is drawn in.
   */
  narrationStyle(
    handle: string,
  ): { color: string; expectedColor: string; disabledColor: string; fontStyle: string } | null {
    const em = document.querySelector(`li[data-handle="${handle}"] em.message-action`);
    if (em === null) return null;
    const read = (token: string): string => {
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    const style = getComputedStyle(em);
    return {
      color: style.color,
      expectedColor: read("--text-secondary"),
      disabledColor: read("--text-disabled"),
      fontStyle: style.fontStyle,
    };
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
   * The live caret's box against the bubble's own box, and against the last
   * block element inside the bubble. Where the caret sits in the markup proves
   * nothing about where it is painted, so this reads the rects and lets the spec
   * assert both containment *and* that the caret trails the last text block's own
   * line box instead of sitting on a flex row of its own below it.
   */
  caretGeometry(handle: string): {
    caret: { top: number; right: number; bottom: number; left: number; width: number; height: number };
    bubble: { top: number; right: number; bottom: number; left: number; width: number; height: number };
    lastBlock: { top: number; right: number; bottom: number; left: number; width: number; height: number } | null;
  } | null {
    const row = document.querySelector(`li[data-handle="${handle}"]`);
    const bubble = row?.querySelector(".message-bubble") ?? null;
    const caret = row?.querySelector(".message-caret") ?? null;
    if (bubble === null || caret === null) return null;
    const box = (element: Element) => {
      const { top, right, bottom, left, width, height } = element.getBoundingClientRect();
      return { top, right, bottom, left, width, height };
    };
    // The block that ends the reply: the bubble's last child that is not the
    // caret itself. When the caret trails the last character it lives *inside*
    // that block; the defect leaves it as a sibling flex item after it.
    const blocks = [...bubble.children].filter((child) => child !== caret);
    const lastBlock = blocks[blocks.length - 1] ?? null;
    return {
      caret: box(caret),
      bubble: box(bubble),
      lastBlock: lastBlock === null ? null : box(lastBlock),
    };
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
  /**
   * The transcript scroller's own geometry, so a spec can measure where the
   * reader actually is rather than trust a class name or an attribute.
   */
  timelineScroll(): { scrollTop: number; scrollHeight: number; clientHeight: number } | null {
    const element = document.querySelector("section.timeline");
    if (!(element instanceof HTMLElement)) return null;
    return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
  },
  /** Move the scroller the way a reader would, and let the scroll listener see it. */
  setTimelineScrollTop(top: number): void {
    const element = document.querySelector("section.timeline");
    if (!(element instanceof HTMLElement)) return;
    element.scrollTop = top;
    element.dispatchEvent(new Event("scroll"));
  },
};

(window as unknown as { chatProbe: typeof chatProbe }).chatProbe = chatProbe;

createRoot(document.getElementById("probe-root")!).render(<Probe />);
