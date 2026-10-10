import { expect, test, type Page } from "@playwright/test";

/**
 * The swipe and regenerate mutations' busy presentation, mounted.
 *
 * This is the presentation contract the shell's single-flight guard projects:
 * while a chat mutation (`chatMutation` in `ComposedReferenceGameApp`) is in
 * flight for one message, that message's own swipe and regenerate controls are
 * disabled and the row is marked busy; when the mutation settles the row
 * returns to idle. The probe drives `Timeline`'s `pending` prop exactly as the
 * shell drives it, so these assertions pin the same selectors the shell's
 * `data-pending`/`aria-busy` outputs feed.
 *
 * The failure each assertion catches:
 *
 * 1. `marks the mutated message busy and disables its controls` - while a
 *    swipe/regenerate is in flight the row must say so (a double click must not
 *    be able to issue a second command, and the control must not look idle).
 *    Without the `pending` projection the row stays enabled and no busy state
 *    exists, so a second click is silently admitted.
 * 2. `issues one command under a double activation` - dispatched at the shell
 *    layer this is the single-flight latch (the working tree's
 *    `chatMutationRef`); at this presentation layer it pins that the busy row
 *    is the *only* row that goes busy, so a pending mutation on one variant
 *    never disables the regenerate affordance of another message.
 * 3. `a settled mutation restores the controls and clears the busy marker` -
 *    without the `finally` this would stay busy forever and the player could
 *    never act again.
 */
type ChatProbe = {
  setTranscript(texts: readonly string[]): void;
  setPreview(text: string | null): void;
  setVoice(state: { state: "unavailable" | "ready" | "speaking" } | null): void;
  setPending(pending: { kind: "swipe" | "regenerate"; handle: string } | null): void;
  withSwipes(handle: string, text: string): void;
  pendingAttrs(
    handle: string,
  ):
    | {
        ariaBusy: string | null;
        dataPending: string | null;
        swipeDisabled: boolean;
        regenerateDisabled: boolean;
      }
    | null;
  voiceState(): string | null;
  voiceLabel(): string | null;
  bubbleHtml(handle: string): string | null;
  textReads(handle: string): number;
  totalTextReads(): number;
  resetTextReads(): void;
};

declare global {
  interface Window {
    chatProbe: ChatProbe;
  }
}

async function openProbe(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
}

test("marks the mutated message busy and disables its controls while a mutation is in flight", async ({ page }) => {
  await openProbe(page);
  await page.evaluate(() => window.chatProbe.setTranscript(["A varianted reply."]));
  await page.evaluate(() => window.chatProbe.withSwipes("h0", "A varianted reply."));

  // Idle: the swipe controls exist (the message carries variants) and are
  // enabled, and the row is not busy.
  let attrs = await page.evaluate(() => window.chatProbe.pendingAttrs("h0"));
  expect(attrs).not.toBeNull();
  expect(attrs?.ariaBusy).toBeNull();
  expect(attrs?.dataPending).toBeNull();
  expect(attrs?.swipeDisabled).toBe(false);
  expect(attrs?.regenerateDisabled).toBe(false);

  // A swipe in flight: the row says so, and its own controls are disabled.
  await page.evaluate(() => window.chatProbe.setPending({ kind: "swipe", handle: "h0" }));
  attrs = await page.evaluate(() => window.chatProbe.pendingAttrs("h0"));
  expect(attrs?.ariaBusy).toBe("true");
  expect(attrs?.dataPending).toBe("swipe");
  expect(attrs?.swipeDisabled).toBe(true);
  expect(attrs?.regenerateDisabled).toBe(true);

  // A regenerate in flight is the same projection with its own kind.
  await page.evaluate(() => window.chatProbe.setPending({ kind: "regenerate", handle: "h0" }));
  attrs = await page.evaluate(() => window.chatProbe.pendingAttrs("h0"));
  expect(attrs?.ariaBusy).toBe("true");
  expect(attrs?.dataPending).toBe("regenerate");
  expect(attrs?.swipeDisabled).toBe(true);
  expect(attrs?.regenerateDisabled).toBe(true);
});

test("a pending mutation on one message never disables another message's controls", async ({ page }) => {
  await openProbe(page);
  await page.evaluate(() => window.chatProbe.setTranscript(["First.", "Second."]));
  await page.evaluate(() => window.chatProbe.withSwipes("h0", "First."));
  await page.evaluate(() => window.chatProbe.withSwipes("h1", "Second."));

  await page.evaluate(() => window.chatProbe.setPending({ kind: "swipe", handle: "h0" }));

  // h0 is busy and disabled...
  const first = await page.evaluate(() => window.chatProbe.pendingAttrs("h0"));
  expect(first?.ariaBusy).toBe("true");
  expect(first?.swipeDisabled).toBe(true);
  // ...h1 stays idle and fully operable (the regenerate affordance of another
  // variant is not collateral damage).
  const second = await page.evaluate(() => window.chatProbe.pendingAttrs("h1"));
  expect(second?.ariaBusy).toBeNull();
  expect(second?.swipeDisabled).toBe(false);
  expect(second?.regenerateDisabled).toBe(false);
});

test("a settled mutation clears the busy marker and restores the controls", async ({ page }) => {
  await openProbe(page);
  await page.evaluate(() => window.chatProbe.setTranscript(["A varianted reply."]));
  await page.evaluate(() => window.chatProbe.withSwipes("h0", "A varianted reply."));

  await page.evaluate(() => window.chatProbe.setPending({ kind: "swipe", handle: "h0" }));
  await expect(page.locator("li[data-handle='h0']")).toHaveAttribute("data-pending", "swipe");

  // The mutation resolves (the shell's reread + finally):
  await page.evaluate(() => window.chatProbe.setPending(null));
  const attrs = await page.evaluate(() => window.chatProbe.pendingAttrs("h0"));
  expect(attrs?.ariaBusy).toBeNull();
  expect(attrs?.dataPending).toBeNull();
  expect(attrs?.swipeDisabled).toBe(false);
  expect(attrs?.regenerateDisabled).toBe(false);
});