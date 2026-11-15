/** The border box of one element, in the four numbers a layout assertion needs. */
function boxOf(element: Element): { width: number; height: number; left: number; right: number; top: number; bottom: number } {
  const { width, height, left, right, top, bottom } = element.getBoundingClientRect();
  return { width, height, left, right, top, bottom };
}

/** Where an element's words actually start and end: its border box shrunk by its own padding. */
function paddingInset(element: Element): { top: number; right: number; bottom: number; left: number } {
  const style = getComputedStyle(element);
  return {
    top: Number.parseFloat(style.paddingTop),
    right: Number.parseFloat(style.paddingRight),
    bottom: Number.parseFloat(style.paddingBottom),
    left: Number.parseFloat(style.paddingLeft),
  };
}

/**
 * One child of a control strip, named by the handle it carries or by the class that identifies it.
 *
 * `action-btn` / `act-btn` are the strip's own shared shapes and name nothing, so the first class that
 * is not one of them is what the child IS - `regenerate-btn`, `swipe-controls`. A child with a test
 * handle is named by that, which is how the entries a journey counts stay findable after they move.
 */
function stripChildName(child: Element): string {
  const testId = child.getAttribute("data-testid");
  if (testId !== null) return testId;
  const classes = [...child.classList].filter((token) => token !== "action-btn" && token !== "act-btn");
  return classes[0] ?? child.tagName.toLowerCase();
}

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
import type { ChatUIState } from "../src/components/chat-ui-state";
import { Timeline } from "../src/components/Timeline";
import { SurfaceDrafts } from "../src/components/surface-drafts";
import { messages } from "../src/i18n";

const LABELS = messages("en");

const reads = new Map<string, number>();

/** Every text the announcement region has held since a journey started watching it. */
let announcementStates: string[] = [];
let announcementObserver: MutationObserver | null = null;

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
  actArmedHandle: string | null;
  /** The one message whose delete is armed, exactly as the shell projects it to Timeline. */
  deleteArmedHandle: string | null;
  /** The one message whose variant discard is armed, exactly as the shell projects it. */
  swipeRemoveArmed: Readonly<{ handle: string; targetIndex: number }> | null;
  /**
   * The Host's turn fact `BrowserTurnV1.truncated`, exactly as the composed shell projects it to
   * ChatSurface: true while the generation that wrote the visible reply stopped at the model's
   * length ceiling. The probe never decides it from the text - a journey sets it.
   */
  replyTruncated: boolean;
  /**
   * The shell's `isGenerating` (a turn admitted and not yet terminal), as ChatSurface hands it to the
   * timeline. Defaults to true, because a transcript that ends on the player's own line IS a turn in
   * flight in the ordinary case - a journey that wants the settled failure says so.
   */
  turnInFlight: boolean;
  /**
   * The composer band's own state, exactly as the shell derives it: the probe never decides a phase
   * from the flags above, a journey hands it one value (`setChatUIState`).
   */
  composerState: ChatUIState;
}>;

let model: Model = {
  transcript: [],
  preview: null,
  voice: null,
  pending: null,
  actArmedHandle: null,
  deleteArmedHandle: null,
  swipeRemoveArmed: null,
  replyTruncated: false,
  turnInFlight: true,
  composerState: { phase: "idle", send: { gate: "open" }, armed: null, pendingLine: null },
};
let rerender: (() => void) | null = null;

/** Every rewind control a journey pressed, so a test can see what the surface sent. */
const rewindCalls: { kind: "arm" | "confirm" | "cancel"; handle: string; order: number }[] = [];

/** Every fork a journey pressed: one press, so the handle it named is the whole reading. */
const forkCalls: string[] = [];

/** Every delete control a journey pressed, in the same shape as the rewind's. */
const deleteCalls: { kind: "arm" | "confirm" | "cancel"; handle: string; order: number }[] = [];

/** Every regeneration the timeline asked for, so a journey sees the target it names. */
const regenerateCalls: string[] = [];

  /** Every edit a journey saved, so a test can see the pair and the words the surface sent. */
  const editCalls: { handle: string; order: number; text: string }[] = [];

  /**
   * Every press of the variant discard, in the shape the shell drives: the index the page rendered the
   * variant at travels with the reply, and a refusal - the Host refusing the last variant by name - is the
   * shell's to turn into a sentence, so the probe records the call and holds no outcome.
   */
  const swipeRemoveCalls: { kind: "arm" | "confirm" | "cancel"; handle: string; targetIndex: number }[] = [];

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
        onRegenerate={(handle) => {
          regenerateCalls.push(handle);
        }}
        /*
         * The rewind drives the shell's own two-step shape: the arm is local presentation state
         * here, exactly as the shell keeps it, and the confirm is what a journey observes on the
         * way to the Host.
         */
        onActFromHere={(handle, order) => {
          rewindCalls.push({ kind: "arm", handle, order });
          model = { ...model, actArmedHandle: handle };
          rerender?.();
        }}
        onActRewind={(handle, order) => {
          rewindCalls.push({ kind: "confirm", handle, order });
          model = { ...model, actArmedHandle: null };
          rerender?.();
        }}
        onActCancel={() => {
          rewindCalls.push({ kind: "cancel", handle: "", order: -1 });
          model = { ...model, actArmedHandle: null };
          rerender?.();
        }}
        /*
         * The branch is one press (it takes nothing away), so the probe records it and holds no arm - the
         * same shape the shell drives. Without it there is no fork entry at all, which is how a caller that
         * serves no `chat.fork` reads: the control is simply absent.
         */
        onActFork={(handle) => {
          forkCalls.push(handle);
        }}
        actArmedHandle={model.actArmedHandle}
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
        /*
         * The variant discard drives the shell's own two-step shape, on the same three callbacks: the arm is
         * presentation state, the confirm is the command, and the cancel closes it.
         */
        onSwipeRemove={(handle, targetIndex) => {
          swipeRemoveCalls.push({ kind: "arm", handle, targetIndex });
          model = { ...model, swipeRemoveArmed: { handle, targetIndex } };
          rerender?.();
        }}
        onSwipeRemoveConfirm={(handle, targetIndex) => {
          swipeRemoveCalls.push({ kind: "confirm", handle, targetIndex });
          model = { ...model, swipeRemoveArmed: null };
          rerender?.();
        }}
        onSwipeRemoveCancel={() => {
          swipeRemoveCalls.push({ kind: "cancel", handle: "", targetIndex: -1 });
          model = { ...model, swipeRemoveArmed: null };
          rerender?.();
        }}
        swipeRemoveArmedHandle={model.swipeRemoveArmed === null ? null : model.swipeRemoveArmed.handle}
        pending={model.pending}
        replyTruncated={model.replyTruncated}
        turnInFlight={model.turnInFlight}
      />
      <Composer
        value={drafted}
        onChange={setDrafted}
        onSend={() => {
          sends.push(drafted);
          setDrafted("");
        }}
        onStop={() => undefined}
        uiState={model.composerState}
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
  /**
   * The Host's turn fact, set exactly as the shell would: the surface never
   * derives a length ceiling from the text, so a journey can only turn the fact
   * on or off and then look at what the row renders.
   */
  setReplyTruncated(value: boolean): void {
    model = { ...model, replyTruncated: value };
    rerender?.();
  },
  /**
   * The shell's own `isGenerating`, set exactly as ChatSurface hands it over: a transcript ending on
   * the player's line is a turn in flight until a journey says the turn settled without a reply.
   */
  setTurnInFlight(value: boolean): void {
    model = { ...model, turnInFlight: value };
    rerender?.();
  },
  /**
   * The composer band's one state, exactly as the shell derives it (`deriveChatUIState`). A journey
   * passes the value the shell would pass, so the controls are read from the same authority the
   * product uses instead of from a flag the test invented.
   */
  setChatUIState(state: ChatUIState): void {
    model = { ...model, composerState: state };
    rerender?.();
  },
  /** Every regeneration this probe asked the shell for, in order. */
  regenerateCalls(): readonly string[] {
    return [...regenerateCalls];
  },
  resetRegenerateCalls(): void {
    regenerateCalls.length = 0;
  },
  /**
   * The reply row's own boxes, as painted: the bubble, the control strip under it, the Regenerate
   * button inside that strip, and - when the reply carries it - the length-ceiling line with its
   * words. A journey reads this twice, with the fact on and off, because the line belongs under the
   * reply and the controls above it must not move by one pixel when it appears.
   */
  truncatedReplyRow(handle: string): {
    note: { text: string | null; box: ReturnType<typeof boxOf> } | null;
    bubble: ReturnType<typeof boxOf>;
    strip: ReturnType<typeof boxOf>;
    regenerate: ReturnType<typeof boxOf> | null;
  } | null {
    const li = document.querySelector(`li[data-handle="${handle}"]`);
    const bubble = li?.querySelector(".message-bubble");
    const strip = li?.querySelector(".message-actions");
    if (li === null || bubble === null || bubble === undefined || strip === null || strip === undefined) return null;
    const note = li.querySelector('[data-testid="message-truncated"]');
    const regenerate = li.querySelector(".regenerate-btn");
    return {
      note: note === null ? null : { text: note.textContent, box: boxOf(note) },
      bubble: boxOf(bubble),
      strip: boxOf(strip),
      regenerate: regenerate === null ? null : boxOf(regenerate),
    };
  },
  /** The sentence in each catalogue, so a journey can pin both languages' words. */
  truncatedSentence(locale: "en" | "zh-CN"): string {
    return messages(locale).chatReplyCutOff;
  },
  setVoice(state: VoiceSurfaceStateV1 | null): void {
    model = { ...model, voice: state };
    rerender?.();
  },
  setPending(
    pending: {
      kind: "swipe" | "swipeRemove" | "regenerate" | "opening" | "rewind" | "edit" | "delete";
      handle: string;
    } | null,
  ): void {
    model = { ...model, pending };
    rerender?.();
  },
  /** Every arm, confirm and cancel this probe's variant discard has sent. */
  swipeRemoveCalls(): readonly { kind: "arm" | "confirm" | "cancel"; handle: string; targetIndex: number }[] {
    return [...swipeRemoveCalls];
  },
  resetSwipeRemoveCalls(): void {
    swipeRemoveCalls.length = 0;
  },
  /**
   * The variant discard as the player meets it: null when the row offers none, otherwise what it is named,
   * the target it paints, the strip it sits in, and where it sits - `inPager` is the assertion that it is
   * NOT a member of the paging pill, and `stripIndex` is its position among the strip's own children.
   */
  swipeRemoveControl(handle: string): {
    ariaLabel: string | null;
    title: string | null;
    label: string | null;
    width: number;
    height: number;
    stripHeight: number;
    inPager: boolean;
    stripIndex: number;
  } | null {
    const li = document.querySelector(`li[data-handle="${handle}"]`);
    const button = li?.querySelector('[data-testid="message-swipe-remove"]') as HTMLButtonElement | null;
    if (button === null || button === undefined) return null;
    const rect = button.getBoundingClientRect();
    const strip = li?.querySelector(".message-actions");
    return {
      ariaLabel: button.getAttribute("aria-label"),
      title: button.getAttribute("title"),
      label: (button.querySelector(".action-word")?.textContent ?? "").trim(),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      stripHeight: strip === null || strip === undefined ? 0 : Math.round(strip.getBoundingClientRect().height),
      inPager: button.closest(".swipe-controls") !== null,
      stripIndex: strip === null ? -1 : [...strip.children].indexOf(button),
    };
  },
  /**
   * The armed variant-discard confirmation on `handle`'s row: its prompt, its two answers, and how many of
   * the row's ordinary controls are still rendered beside it (the confirmation replaces them, not sits
   * among them).
   */
  swipeRemoveConfirm(handle: string): {
    prompt: string | null;
    yes: string | null;
    no: string | null;
    ordinaryControls: number;
  } | null {
    const li = document.querySelector(`li[data-handle="${handle}"]`);
    const confirm = li?.querySelector('[data-testid="message-swipe-remove-confirm"]');
    if (confirm === null || confirm === undefined) return null;
    return {
      prompt: confirm.querySelector(".message-confirm-prompt")?.textContent ?? null,
      yes: confirm.querySelector('[data-testid="message-swipe-remove-confirm-yes"]')?.textContent ?? null,
      no: confirm.querySelector('[data-testid="message-swipe-remove-confirm-no"]')?.textContent ?? null,
      ordinaryControls:
        li?.querySelectorAll(
          '.swipe-controls, .regenerate-btn, [data-testid="message-rewind"], [data-testid="message-fork"], [data-testid="message-delete"]',
        ).length ?? 0,
    };
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
  async deleteControl(handle: string): Promise<{
    ariaLabel: string | null;
    title: string | null;
    label: string | null;
    width: number;
    height: number;
    stripHeight: number;
  } | null> {
    await this.openOverflow(handle);
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
          '.swipe-controls, .regenerate-btn, [data-testid="message-rewind"], [data-testid="message-fork"], [data-testid="message-delete"]',
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
   * The edit affordance as the player meets it - two halves, and neither of them lies (owner ruling,
   * 2026-11-16; the shape was reversed the same day by the accessibility gate).
   *
   * The PLATE is the row's one edit control: a real button, in the tab order, named by the sentence that
   * says what it does, declaring its shortcut, and perceivable while it holds the focus. It is
   * hover-and-focus revealed, so `opacity` is read before and after a focus: a control in the tab order
   * that paints nothing while focused is the trap this shape exists to avoid. The PROSE is read for the
   * opposite reason - it must carry no role, no tab stop and no keyboard claim, and it no longer carries
   * a press, because the plate is what asks for the editor now.
   *
   * `null` means this row is not one the player may rewrite (a streaming preview, the optimistic echo, a
   * row with a mutation or a confirmation in flight): the plate is only rendered while the row really can
   * be rewritten, so its absence IS that fact.
   */
  editAffordance(handle: string): {
    tag: string;
    isButton: boolean;
    tabStop: boolean;
    keyShortcuts: string | null;
    name: string | null;
    opacity: number;
    width: number;
    height: number;
    inStrip: boolean;
    bubbleWidth: number;
    prose: { role: string | null; tabStop: boolean; keyShortcuts: string | null };
  } | null {
    const li = document.querySelector(`li[data-handle="${handle}"]`);
    const plate = li?.querySelector(".message-edit-hint") as HTMLElement | null;
    if (plate === null || plate === undefined) return null;
    const box = plate.getBoundingClientRect();
    const bubble = li?.querySelector<HTMLElement>(".message-bubble") ?? null;
    return {
      tag: plate.tagName.toLowerCase(),
      isButton: plate.tagName === "BUTTON",
      tabStop: plate.tabIndex >= 0,
      keyShortcuts: plate.getAttribute("aria-keyshortcuts"),
      name: plate.getAttribute("aria-label"),
      opacity: Number.parseFloat(getComputedStyle(plate).opacity),
      width: Math.round(box.width),
      height: Math.round(box.height),
      inStrip: li?.querySelector(".message-actions")?.contains(plate) ?? false,
      bubbleWidth: bubble === null ? 0 : Math.round(bubble.getBoundingClientRect().width),
      prose: {
        role: bubble?.getAttribute("role") ?? null,
        tabStop: bubble !== null && bubble.tabIndex >= 0,
        keyShortcuts: bubble?.getAttribute("aria-keyshortcuts") ?? null,
      },
    };
  },
  /**
   * The keyboard's edit stops across the whole transcript, in the order the rows draw them.
   *
   * What a tab walk has to answer is not only "is there one" but "is there exactly one per editable row,
   * and is the prose beside it a stop of its own": a second stop per message is a wall of buttons in a
   * reading column, and a prose stop is the shape the accessibility gate removed.
   */
  editStops(): readonly { handle: string | null; name: string | null; tag: string; proseStop: boolean }[] {
    return [...document.querySelectorAll(".message-edit-hint")].map((plate) => {
      const bubble = plate.closest("[data-handle]")?.querySelector<HTMLElement>(".message-bubble") ?? null;
      return {
        handle: plate.closest("[data-handle]")?.getAttribute("data-handle") ?? null,
        name: plate.getAttribute("aria-label"),
        tag: plate.tagName.toLowerCase(),
        proseStop: bubble !== null && bubble.tabIndex >= 0,
      };
    });
  },
  /**
   * One row's actions as the row splits them: a band above the bubble and a strip beneath it.
   *
   * The two halves are separate facts. The edit control stands ABOVE the words, in the row's own
   * top-right corner; the high-frequency actions stand UNDER them; and the three that change the
   * conversation are behind one overflow trigger in that strip. `blockHeight` is the box the bubble and
   * the strip make together - what a reply pays for its controls - and `overlapsProse` is the assertion
   * that keeps the 44 px edit target from eating the words above which it sits: it compares the plate's
   * box against the bubble's CONTENT box, because a target that only reaches into the bubble's padding
   * still selects every word.
   */
  rowActions(handle: string): {
    row: ReturnType<typeof boxOf>;
    bubble: ReturnType<typeof boxOf> | null;
    strip: ReturnType<typeof boxOf> | null;
    blockHeight: number;
    stripChildren: readonly string[];
    prose: { cursor: string; role: string | null; tabStop: boolean };
    edit: {
      name: string | null;
      width: number;
      height: number;
      opacity: number;
      box: ReturnType<typeof boxOf>;
      overlapsProse: boolean;
    } | null;
    more: { name: string | null; expanded: string | null; width: number; height: number } | null;
  } | null {
    const li = document.querySelector<HTMLElement>(`li[data-handle="${handle}"]`);
    if (li === null) return null;
    const bubble = li.querySelector<HTMLElement>(".message-bubble");
    const strip = li.querySelector<HTMLElement>(".message-actions");
    const plate = li.querySelector<HTMLElement>(".message-edit-hint");
    const trigger = li.querySelector<HTMLElement>('[data-testid="message-more"]');
    const plateBox = plate === null ? null : boxOf(plate);
    // The bubble's content box: where its words actually begin and end.
    const content =
      bubble === null
        ? null
        : (() => {
            const box = boxOf(bubble);
            const padding = paddingInset(bubble);
            return { top: box.top + padding.top, right: box.right - padding.right };
          })();
    return {
      row: boxOf(li),
      bubble: bubble === null ? null : boxOf(bubble),
      strip: strip === null ? null : boxOf(strip),
      blockHeight:
        bubble === null || strip === null
          ? 0
          : Math.round(strip.getBoundingClientRect().bottom - bubble.getBoundingClientRect().top),
      stripChildren: [...(strip?.children ?? [])].map((child) => stripChildName(child)),
      prose: {
        cursor: bubble === null ? "" : getComputedStyle(bubble).cursor,
        role: bubble?.getAttribute("role") ?? null,
        tabStop: bubble !== null && bubble.tabIndex >= 0,
      },
      edit:
        plate === null || plateBox === null
          ? null
          : {
              name: plate.getAttribute("aria-label"),
              width: Math.round(plateBox.width),
              height: Math.round(plateBox.height),
              opacity: Number.parseFloat(getComputedStyle(plate).opacity),
              box: plateBox,
              overlapsProse: content !== null && plateBox.bottom > content.top && plateBox.left < content.right,
            },
      more:
        trigger === null
          ? null
          : {
              name: trigger.getAttribute("aria-label"),
              expanded: trigger.getAttribute("aria-expanded"),
              width: Math.round(trigger.getBoundingClientRect().width),
              height: Math.round(trigger.getBoundingClientRect().height),
            },
    };
  },
  /**
   * The overflow as the player meets it: whether it is open, and the controls it holds - by their test
   * handles (the names the three destructive entries carry on the row), their accessible names, and the
   * targets they paint. `null` is a row whose strip has no overflow at all, which is a row with nothing
   * to put in it.
   */
  moreMenu(handle: string): {
    open: boolean;
    items: readonly { testId: string | null; name: string | null; width: number; height: number }[];
  } | null {
    const li = document.querySelector<HTMLElement>(`li[data-handle="${handle}"]`);
    const trigger = li?.querySelector<HTMLElement>('[data-testid="message-more"]');
    if (li === null || trigger === null || trigger === undefined) return null;
    const items = [...li.querySelectorAll<HTMLElement>('[data-testid="message-more-menu"] [data-testid]')];
    return {
      open: trigger.getAttribute("aria-expanded") === "true",
      items: items.map((item) => {
        const box = item.getBoundingClientRect();
        return {
          testId: item.getAttribute("data-testid"),
          name: item.getAttribute("aria-label"),
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      }),
    };
  },
  /**
   * The copy control as the player meets it: what it is called, the target it actually paints, where
   * it sits in the strip, and every box a placement claim depends on (the strip's own row count, and
   * the four controls that were already there with their sizes).
   *
   * The strip is the same row the reply uses, so `stripRows` is what says the fifth control did not
   * push the other four onto a second row - measured from each child's vertical centre, because a
   * control whose glyph is shorter than its neighbour's still shares its row.
   */
  copyControl(handle: string): {
    ariaLabel: string | null;
    title: string | null;
    label: string | null;
    width: number;
    height: number;
    stripHeight: number;
    stripRows: number;
    stripWidth: number;
    stripIndex: number;
    siblings: readonly { name: string; width: number; height: number }[];
  } | null {
    const li = document.querySelector(`li[data-handle="${handle}"]`);
    const button = li?.querySelector('[data-testid="message-copy"]') as HTMLButtonElement | null;
    if (button === null || button === undefined) return null;
    const rect = button.getBoundingClientRect();
    const strip = li?.querySelector(".message-actions") as HTMLElement | null;
    const children = [...(strip?.children ?? [])];
    const centres = children.map((child) => {
      const box = child.getBoundingClientRect();
      return Math.round(box.top + box.height / 2);
    });
    return {
      ariaLabel: button.getAttribute("aria-label"),
      title: button.getAttribute("title"),
      label: button.textContent,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      stripHeight: strip === null ? 0 : Math.round(strip.getBoundingClientRect().height),
      stripRows: new Set(centres).size,
      stripWidth: strip === null ? 0 : Math.round(strip.getBoundingClientRect().width),
      stripIndex: children.indexOf(button),
      siblings: children
        .filter((child) => child !== button)
        .map((child) => {
          const box = child.getBoundingClientRect();
          return {
            name: (child.getAttribute("class") ?? child.tagName).toString(),
            width: Math.round(box.width),
            height: Math.round(box.height),
          };
        }),
    };
  },
  /**
   * The receipt the copy press left behind, if any: its words, which banner tone it took, and the
   * box it painted. `null` is the settled state, which is the point - the confirmation is a moment,
   * not a state the row keeps.
   */
  copyNotice(handle: string): { text: string; tone: string; role: string | null; width: number; height: number } | null {
    const li = document.querySelector(`li[data-handle="${handle}"]`);
    const notice = li?.querySelector('[data-testid="message-copy-notice"]');
    if (notice === null || notice === undefined) return null;
    const rect = notice.getBoundingClientRect();
    return {
      text: (notice.textContent ?? "").trim(),
      tone: notice.getAttribute("data-copy-notice") ?? "",
      role: notice.getAttribute("role"),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  },
  /** The words of the two copy sentences, so a journey can pin both catalogues. */
  copySentences(locale: "en" | "zh-CN"): { notice: string; failed: string; control: string } {
    const catalogue = messages(locale);
    return { notice: catalogue.copyNotice, failed: catalogue.copyNoticeFailed, control: catalogue.copyMessage };
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
  /** Every fork this probe's branch entry has sent: one press, so the handle is the whole reading. */
  forkCalls(): readonly string[] {
    return [...forkCalls];
  },
  resetForkCalls(): void {
    forkCalls.length = 0;
  },
  /** Every arm, confirm and cancel this probe's rewind control has sent. */
  rewindCalls(): readonly { kind: "arm" | "confirm" | "cancel"; handle: string; order: number }[] {
    return [...rewindCalls];
  },
  resetRewindCalls(): void {
    rewindCalls.length = 0;
  },
  /**
   * Opens one row's overflow: the disclosure the rewind, the fork and the delete live behind.
   *
   * `role`-less on purpose - it is a disclosure, not a menu - so what a journey does to reach those three
   * is what a player does: one press. The press is dispatched here rather than clicked through Playwright
   * because some readers below need it inline; a DOM `click` on a React handler is flushed synchronously, so
   * the panel is in the document when this returns.
   */
  async openOverflow(handle: string): Promise<void> {
    const li = document.querySelector<HTMLElement>(`li[data-handle="${handle}"]`);
    if (li === null || li.querySelector('[data-testid="message-more-menu"]') !== null) return;
    li.querySelector<HTMLElement>('[data-testid="message-more"]')?.click();
    // React commits the disclosure on its own schedule - a dispatched (untrusted) click is not one of the
    // discrete events it flushes synchronously - so the panel is not in the document when `click()` returns.
    // One animation frame is the whole wait, and it is awaited by `page.evaluate`.
    await new Promise((resolve) => requestAnimationFrame(resolve));
  },
  /**
   * The rewind control as the player meets it: what it is called, and the target it actually
   * paints. A control whose measured box is under the touch minimum is the defect the journey
   * exists for, so the size is read from the layout rather than from a class name.
   *
   * It OPENS the row's overflow first, because that is where the entry lives now: reading it with the
   * panel shut would answer `null` for every row and turn "this row offers no rewind" into a claim about
   * the panel instead of about the transcript.
   */
  async rewindControl(handle: string): Promise<{
    ariaLabel: string | null;
    title: string | null;
    label: string | null;
    width: number;
    height: number;
  } | null> {
    await this.openOverflow(handle);
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
        (li?.querySelectorAll('.swipe-controls, .regenerate-btn, [data-testid="message-rewind"], [data-testid="message-fork"]')
          .length ?? 0),
    };
  },
  /**
   * A reply position carrying an explicit variant set, as the Host publishes one: the active index, how
   * many attempts the position holds, and the words of the one on screen. `swipeTo` moves within whatever
   * set a row already has; this is how a journey creates one.
   */
  swipeSet(handle: string, currentIndex: number, totalSwipes: number, text: string): void {
    const existing = model.transcript.find((m) => m.handle === handle);
    const published: BrowserMessageV1 = Object.freeze({
      handle,
      role: existing?.role ?? "companion",
      text,
      locale: existing?.locale ?? "und",
      order: existing?.order ?? 0,
      revision: existing?.revision ?? 1,
      swipeInfo: Object.freeze({
        currentIndex,
        totalSwipes,
        label: `${currentIndex + 1}/${totalSwipes}`,
        hasPrevious: currentIndex > 0,
        hasNext: currentIndex < totalSwipes - 1,
      }),
    });
    const idx = model.transcript.findIndex((m) => m.handle === handle);
    const transcript =
      idx === -1 ? [...model.transcript, published] : model.transcript.map((m, i) => (i === idx ? published : m));
    model = { ...model, transcript };
    rerender?.();
  },
  /** The variant-discard control's words in each catalogue, so a journey can pin both languages. */
  swipeRemoveSentences(locale: "en" | "zh-CN"): {
    name: string;
    prompt: string;
    yes: string;
    no: string;
    nextVariant: string;
  } {
    const catalogue = messages(locale);
    return {
      name: catalogue.swipeRemoveName,
      prompt: catalogue.swipeRemoveConfirmPrompt,
      yes: catalogue.swipeRemoveConfirmYes,
      no: catalogue.deleteConfirmNo,
      nextVariant: catalogue.swipeNext,
    };
  },
  /**
   * A variant switch, as the authoritative reread reports it: the row keeps its handle, its position and
   * the swipe set the Host published, and only the active index and that variant's own words move. The
   * Host is what selects the words - the surface never rewrites a variant locally.
   */
  swipeTo(handle: string, currentIndex: number, text: string): void {
    const existing = model.transcript.find((m) => m.handle === handle);
    const total = existing?.swipeInfo?.totalSwipes ?? 3;
    const switched: BrowserMessageV1 = Object.freeze({
      handle,
      role: existing?.role ?? "companion",
      text,
      locale: existing?.locale ?? "und",
      order: existing?.order ?? 0,
      revision: existing?.revision ?? 1,
      swipeInfo: Object.freeze({
        currentIndex,
        totalSwipes: total,
        label: `${currentIndex + 1}/${total}`,
        hasPrevious: currentIndex > 0,
        hasNext: currentIndex < total - 1,
      }),
    });
    const idx = model.transcript.findIndex((m) => m.handle === handle);
    const transcript =
      idx === -1 ? [...model.transcript, switched] : model.transcript.map((m, i) => (i === idx ? switched : m));
    model = { ...model, transcript };
    rerender?.();
  },
  /**
   * The open editor's field against the box the row's bubble had. The field's own box is the
   * subject: a slot narrower than the words being rewritten is the defect this measures. The
   * bubble is `null` while the editor is open, because the editor takes its place rather than
   * sitting under it (the in-place ruling) - so a caller printing this prints "none", not a 0x0.
   */
  editFieldBox(handle: string): {
    field: { width: number; height: number; left: number; right: number };
    bubble: { width: number; height: number; left: number; right: number } | null;
    strip: { width: number; height: number };
  } | null {
    const li = document.querySelector(`li[data-handle="${handle}"]`);
    const field = li?.querySelector('[data-testid="message-edit-field"]');
    if (field === null || field === undefined) return null;
    const bubble = li?.querySelector(".message-bubble");
    const strip = li?.querySelector(".message-actions");
    return {
      field: boxOf(field),
      bubble: bubble === null || bubble === undefined ? null : boxOf(bubble),
      strip: strip === null || strip === undefined ? { width: 0, height: 0 } : boxOf(strip),
    };
  },
  /**
   * The row as it is being rewritten: the boxes the in-place edit is measured against, and how
   * many copies of the row's words are ON SCREEN.
   *
   * A text node counts only while it is really painted (a node inside a `display: none` or
   * otherwise clipped subtree has no client rect), and the editor's field counts as the one other
   * place the words can be read - a field's value is not a text node, which is why the two are
   * counted separately and added. A text node INSIDE a form control is that field's own value, so
   * it is not counted twice: the field half of the sum is what carries it. One copy is the shape:
   * the bubble gives way to the editor, and two is the defect this measures - the same words
   * printed above the field that holds them.
   */
  editInPlace(
    handle: string,
    text: string,
  ): {
    row: { top: number; bottom: number; height: number };
    bubble: { top: number; bottom: number; height: number } | null;
    field: { top: number; bottom: number; height: number } | null;
    textNodes: number;
    carriers: readonly string[];
    copies: number;
  } | null {
    const row = document.querySelector<HTMLElement>(`li[data-handle="${handle}"]`);
    if (row === null) return null;
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) };
    };
    const bubble = row.querySelector<HTMLElement>(".message-bubble");
    const field = row.querySelector<HTMLTextAreaElement>('[data-testid="message-edit-field"]');
    let textNodes = 0;
    const carriers: string[] = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!(node.textContent ?? "").includes(text)) continue;
      const parent = node.parentElement;
      if (parent === null || parent.getClientRects().length === 0) continue;
      if (parent.closest("textarea, input, select") !== null) continue;
      textNodes += 1;
      carriers.push(`${parent.tagName.toLowerCase()}.${parent.className}`);
    }
    const inField = field !== null && field.value.includes(text);
    return {
      row: box(row),
      bubble: bubble === null ? null : box(bubble),
      field: field === null ? null : box(field),
      textNodes,
      carriers,
      copies: textNodes + (inField ? 1 : 0),
    };
  },
  /** The number of transcript rows the list actually holds (the optimistic row is not one). */
  transcriptRowCount(): number {
    return document.querySelectorAll("ol.message-list > li[data-handle]").length;
  },
  /**
   * The transcript as the page renders it: each row's handle and position, the words in its bubble, and
   * how many bubbles that row draws (one is the shape; a second is the copy an in-place edit must not
   * leave behind).
   */
  transcriptRows(): readonly { handle: string; index: number; text: string | null; bubbles: number }[] {
    return [...document.querySelectorAll("ol.message-list > li[data-handle]")].map((row, index) => ({
      handle: row.getAttribute("data-handle") ?? "",
      index,
      text: row.querySelector(".message-bubble")?.textContent ?? null,
      bubbles: row.querySelectorAll(".message-bubble").length,
    }));
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
   * The words a bubble actually shows, whitespace-collapsed.
   *
   * `bubbleHtml` answers "what markup did the renderer build"; this answers "what can the
   * player read", which is the question a claim about the reply's words surviving the
   * renderer has to be asked in. The two are not the same question: a tag the renderer
   * consumes leaves markup that still contains its words, and a badge that REPLACES a
   * parenthetical keeps them while dropping the syntax around them.
   */
  bubbleText(handle: string): string | null {
    const bubble = document.querySelector(`li[data-handle="${handle}"] .message-bubble`);
    return bubble === null ? null : (bubble.textContent ?? "").replace(/\s+/gu, " ").trim();
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
  /**
   * Where the keyboard actually is.
   *
   * `document.activeElement` is the reading that matters: a caret dropped on `<body>` is the defect
   * itself, not a missing attribute on a control that claims to be focused, so the probe reports the
   * element the browser gave the focus to and not a flag the surface set.
   */
  focusedControl(): {
    tag: string;
    testId: string | null;
    /** The control the focus is on, by test handle or identifying class - the order a walk reads. */
    control: string;
    handle: string | null;
    revealer: boolean;
    /** True when the focus landed on a message's own prose, which is not a control at all. */
    prose: boolean;
  } {
    const active = document.activeElement ?? document.body;
    return {
      tag: active.tagName.toLowerCase(),
      testId: active.getAttribute("data-testid"),
      control: stripChildName(active),
      handle: active.closest("[data-handle]")?.getAttribute("data-handle") ?? null,
      revealer: active.hasAttribute("data-draft-revealer"),
      prose: active.classList.contains("message-bubble"),
    };
  },
  /**
   * The conversation's one spoken channel, as the tree presents it: its text, the role it is a live
   * region by, the box it occupies, and the announcement sentences in each catalogue.
   */
  announcement(): { text: string; role: string | null; width: number; height: number } | null {
    const region = document.querySelector('[data-testid="chat-announcement"]');
    if (region === null) return null;
    const box = region.getBoundingClientRect();
    return {
      text: (region.textContent ?? "").trim(),
      role: region.getAttribute("role"),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  },
  /**
   * Start counting what the conversation SAYS. Every change of the live region's text is one entry,
   * seeded with the text the region starts on; consecutive identical readings collapse into one,
   * because React may touch the node twice for a single state and a reader hears the state, not the
   * touch.
   */
  watchAnnouncement(): void {
    announcementObserver?.disconnect();
    const region = document.querySelector('[data-testid="chat-announcement"]');
    announcementStates = region === null ? [] : [region.textContent ?? ""];
    if (region === null) return;
    announcementObserver = new MutationObserver(() => {
      const text = region.textContent ?? "";
      if (announcementStates[announcementStates.length - 1] !== text) announcementStates.push(text);
    });
    announcementObserver.observe(region, { childList: true, characterData: true, subtree: true });
  },
  /**
   * What the region said since `watchAnnouncement`, minus the state it started on - the announcements
   * themselves. A channel that spoke on every delta reads back as one entry per delta here.
   */
  announcements(): readonly string[] {
    return [...announcementStates.slice(1)];
  },
  /**
   * Every live region inside one row's own subtree. The streaming preview must carry none: a region
   * over text that changes twenty times a second is the flood, whatever else the row gets right.
   */
  liveRegionsIn(handle: string): number {
    const row = document.querySelector(`li[data-handle="${handle}"]`);
    if (row === null) return 0;
    return row.querySelectorAll('[aria-live], [role="status"], [role="alert"], [role="log"]').length;
  },
  /** The streaming row's own busy state, as the tree states it. */
  streamingRow(handle: string): { streaming: boolean; ariaBusy: string | null } | null {
    const row = document.querySelector(`li[data-handle="${handle}"]`);
    if (row === null) return null;
    return { streaming: row.getAttribute("data-streaming") === "true", ariaBusy: row.getAttribute("aria-busy") };
  },
  /** The announcement sentence in each catalogue, so a journey can pin both languages. */
  announcementSentences(locale: "en" | "zh-CN"): string {
    return messages(locale).chatReplyReady;
  },
  /**
   * One row carrying the Host's own rewrite fact, exactly as a state read publishes it
   * (`BrowserMessageV1.answeredEarlierWording`): a message above it was rewritten in place after this
   * one was written. The probe never derives it - a journey hands it the fact and reads the row.
   */
  withAnsweredEarlierWording(handle: string): void {
    const existing = model.transcript.find((m) => m.handle === handle);
    if (existing === undefined) return;
    const marked: BrowserMessageV1 = Object.freeze({ ...existing, answeredEarlierWording: true as const });
    model = {
      ...model,
      transcript: model.transcript.map((m) => (m.handle === handle ? marked : m)),
    };
    rerender?.();
  },
  /**
   * The mark as the player meets it on one row: the sentence, the box it paints, and the row's own
   * bubble and strip - so "the line is there" and "the line moved nothing" are two readings of the same
   * row rather than a claim about a class name.
   */
  answeredEarlierNote(handle: string): {
    text: string | null;
    box: ReturnType<typeof boxOf>;
    tone: string;
    role: string | null;
    bubble: ReturnType<typeof boxOf> | null;
    strip: ReturnType<typeof boxOf> | null;
  } | null {
    const li = document.querySelector(`li[data-handle="${handle}"]`);
    if (li === null) return null;
    const note = li.querySelector('[data-testid="message-answered-earlier"]');
    const bubble = li.querySelector(".message-bubble");
    const strip = li.querySelector(".message-actions");
    return {
      text: note === null ? null : (note.textContent ?? "").trim(),
      box: note === null ? boxOf(li) : boxOf(note),
      tone: note === null ? "" : getComputedStyle(note).color,
      role: note === null ? null : note.getAttribute("role"),
      bubble: bubble === null ? null : boxOf(bubble),
      strip: strip === null ? null : boxOf(strip),
    };
  },
  /** The mark's sentence in each catalogue, so a journey can pin both languages. */
  answeredEarlierSentences(locale: "en" | "zh-CN"): { mark: string; editorConsequence: string } {
    const catalogue = messages(locale);
    return { mark: catalogue.answeredEarlierWording, editorConsequence: catalogue.editLaterKept };
  },
};

(window as unknown as { chatProbe: typeof chatProbe }).chatProbe = chatProbe;

createRoot(document.getElementById("probe-root")!).render(
  /*
   * The shell's own draft store, mounted here for the same reason the product mounts it: the row's
   * inline editor keeps the player's words in it, so a probe without the provider would be a page the
   * product never renders - and every row would throw rather than lose the text.
   */
  <SurfaceDrafts>
    <Probe />
  </SurfaceDrafts>,
);
