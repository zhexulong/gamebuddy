import { expect, test, type Page } from "@playwright/test";

/**
 * The message-level chat mutations' busy presentation, mounted.
 *
 * This is the presentation contract the shell's single-flight guard projects:
 * while a chat mutation (`chatMutation` in `ComposedReferenceGameApp`) is in
 * flight for one message, that message's own variant swipe, opening choice and
 * regenerate controls are disabled and the row is marked busy; when the mutation
 * settles the row returns to idle. The probe drives `Timeline`'s `pending` prop
 * exactly as the shell drives it, so these assertions pin the same selectors the
 * shell's `data-pending`/`aria-busy` outputs feed.
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
 * 4. `renders the busy state, not just the busy attribute` - the row carrying
 *    `data-pending` and a disabled button is the shell's *label*; if no rule
 *    consumes it the player sees a dead click and no feedback at all. This
 *    asserts the computed animation the attribute is supposed to produce, so
 *    the two cannot drift apart.
 * 5. `offers regeneration on the transcript's last companion row, and nowhere
 *    else` - the control re-asks the last thing the player said. On a middle
 *    reply it appended an unrelated pair at the tail, and on the opening it
 *    appended the literal "\u8bf7\u7ee7\u7eed". It is therefore offered on one row
 *    only, and a transcript that offers it anywhere else is the defect.
 * 6. `the opening switcher reports its own mutation in flight` and 7. `a pending
 *    mutation on one message never disables another message's switcher` - the
 *    same `data-pending`/`aria-busy` projection for the new-chat opening choice
 *    (`chat.opening`): the row that is mutating says so and disables its own
 *    switcher, and no other row's switcher is collateral damage.
 * 8. `renders the opening switcher's busy state` - the same animation contract
 *    on the opening choice's own row.
 *
 * Every journey here builds a real conversation through `setConversation`: the
 * all-companion shortcut of `setTranscript` is a renderer fixture, and a
 * companion message at index zero is exactly the opening.
 */

// The busy treatment is motion, and the assertion below is about that motion, so
// the emulated preference is pinned rather than inherited from the host.
test.use({ reducedMotion: "no-preference" });
const CONVERSATION = [
  { role: "player" as const, text: "Where are we?" },
  { role: "companion" as const, text: "A varianted reply." },
];
type ChatProbe = {
  setTranscript(texts: readonly string[]): void;
  setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void;
  setPreview(text: string | null): void;
  setVoice(state: { state: "unavailable" | "ready" | "speaking" } | null): void;
  setPending(pending: { kind: "swipe" | "regenerate" | "opening"; handle: string } | null): void;
  withSwipes(handle: string, text: string): void;
  withOpening(handle: string, text: string): void;
  pendingAttrs(
    handle: string,
  ):
    | {
        ariaBusy: string | null;
        dataPending: string | null;
        swipeDisabled: boolean;
        switcherDisabled: boolean;
        regenerateDisabled: boolean;
      }
    | null;
  voiceState(): string | null;
  voiceLabel(): string | null;
  bubbleHtml(handle: string): string | null;
  pendingAnimation(
    handle: string,
  ): { animationName: string; animationDuration: string; transitionDuration: string } | null;
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
  await page.evaluate((entries) => window.chatProbe.setConversation(entries), CONVERSATION);
  await page.evaluate(() => window.chatProbe.withSwipes("h1", "A varianted reply."));

  // Idle: the swipe controls exist (the message carries variants) and are
  // enabled, and the row is not busy.
  let attrs = await page.evaluate(() => window.chatProbe.pendingAttrs("h1"));
  expect(attrs).not.toBeNull();
  expect(attrs?.ariaBusy).toBeNull();
  expect(attrs?.dataPending).toBeNull();
  expect(attrs?.swipeDisabled).toBe(false);
  expect(attrs?.regenerateDisabled).toBe(false);

  // A swipe in flight: the row says so, and its own controls are disabled.
  await page.evaluate(() => window.chatProbe.setPending({ kind: "swipe", handle: "h1" }));
  attrs = await page.evaluate(() => window.chatProbe.pendingAttrs("h1"));
  expect(attrs?.ariaBusy).toBe("true");
  expect(attrs?.dataPending).toBe("swipe");
  expect(attrs?.swipeDisabled).toBe(true);
  expect(attrs?.regenerateDisabled).toBe(true);

  // A regenerate in flight is the same projection with its own kind.
  await page.evaluate(() => window.chatProbe.setPending({ kind: "regenerate", handle: "h1" }));
  attrs = await page.evaluate(() => window.chatProbe.pendingAttrs("h1"));
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
  await page.evaluate((entries) => window.chatProbe.setConversation(entries), CONVERSATION);
  await page.evaluate(() => window.chatProbe.withSwipes("h1", "A varianted reply."));

  await page.evaluate(() => window.chatProbe.setPending({ kind: "swipe", handle: "h1" }));
  await expect(page.locator("li[data-handle='h1']")).toHaveAttribute("data-pending", "swipe");

  // The mutation resolves (the shell's reread + finally):
  await page.evaluate(() => window.chatProbe.setPending(null));
  const attrs = await page.evaluate(() => window.chatProbe.pendingAttrs("h1"));
  expect(attrs?.ariaBusy).toBeNull();
  expect(attrs?.dataPending).toBeNull();
  expect(attrs?.swipeDisabled).toBe(false);
  expect(attrs?.regenerateDisabled).toBe(false);
});
/**
 * The failure: the shell's `data-pending` projection is a label, and a label
 * with no rendering is exactly the "did my click do anything" surface the
 * reviewer reported. The attribute alone cannot catch that - this pairs it with
 * the computed animation the attribute is supposed to produce, so removing the
 * style while keeping the attribute fails.
 */
test("renders the busy state, not just the busy attribute", async ({ page }) => {
  await openProbe(page);
  await page.evaluate((entries) => window.chatProbe.setConversation(entries), CONVERSATION);
  await page.evaluate(() => window.chatProbe.withSwipes("h1", "A varianted reply."));

  // Idle: the bubble carries no pending animation.
  const idle = await page.evaluate(() => window.chatProbe.pendingAnimation("h1"));
  expect(idle?.animationName).toBe("none");

  await page.evaluate(() => window.chatProbe.setPending({ kind: "regenerate", handle: "h1" }));
  await expect(page.locator("li[data-handle='h1']")).toHaveAttribute("data-pending", "regenerate");

  const busy = await page.evaluate(() => window.chatProbe.pendingAnimation("h1"));
  expect(busy?.animationName).toContain("message-pending-breathe");
  expect(busy?.animationDuration).not.toBe("0s");
  expect(busy?.transitionDuration).not.toBe("0s");
  // The control that was clicked swaps its glyph for a spinner, so the busy
  // state is read on the control itself and not only on the bubble.
  await expect(page.locator("li[data-handle='h1'] .regenerate-btn .message-spinner")).toHaveCount(1);

  // Settling removes the animation again.
  await page.evaluate(() => window.chatProbe.setPending(null));
  const settled = await page.evaluate(() => window.chatProbe.pendingAnimation("h1"));
  expect(settled?.animationName).toBe("none");
});

/**
 * The regenerate affordance's own placement.
 *
 * The failure each direction catches: an opening (or any earlier row) carrying a
 * control whose click appends a *new* tail turn - on the opening the literal
 * "\u8bf7\u7ee7\u7eed", on a middle reply a pair answering an old prompt, attached to
 * the bottom of a conversation that never asked for it.
 */
test("offers regeneration on the transcript's last companion row, and nowhere else", async ({ page }) => {
  await openProbe(page);
  const offered = async (): Promise<string[]> =>
    await page.evaluate(() =>
      [...document.querySelectorAll("li[data-handle]")]
        .filter((row) => row.querySelector(".regenerate-btn") !== null)
        .map((row) => row.getAttribute("data-handle") ?? ""),
    );

  // A chat that opened on its greeting: the opening is the whole transcript, and
  // there is no player turn for the control to repeat.
  await page.evaluate(() => window.chatProbe.setConversation([
    { role: "companion", text: "The morning light comes over the ridge." },
  ]));
  expect(await offered()).toEqual([]);

  // A settled turn: exactly the companion row at the tail carries it.
  await page.evaluate((entries) => window.chatProbe.setConversation(entries), CONVERSATION);
  expect(await offered()).toEqual(["h1"]);

  // A turn in flight: the transcript ends on the player's own line, and nothing
  // is offered - the previous reply's control would be a second, refused command.
  await page.evaluate(() => window.chatProbe.setConversation([
    { role: "player", text: "Where are we?" },
    { role: "companion", text: "A varianted reply." },
    { role: "player", text: "And then?" },
  ]));
  expect(await offered()).toEqual([]);

  // A middle reply never carries it, however many turns follow.
  await page.evaluate(() => window.chatProbe.setConversation([
    { role: "player", text: "Where are we?" },
    { role: "companion", text: "A first reply." },
    { role: "player", text: "And then?" },
    { role: "companion", text: "A second reply." },
  ]));
  expect(await offered()).toEqual(["h3"]);
});

/**
 * The new-chat opening choice (`chat.opening`) drives the same busy projection through the same
 * `.swipe-btn` pair, so its own row is pinned here rather than left to the placement rule above.
 */
test("the opening switcher reports its own mutation in flight and clears it when it settles", async ({ page }) => {
  await openProbe(page);
  await page.evaluate(() => window.chatProbe.setConversation([
    { role: "companion", text: "The lantern over the porch is still lit." },
  ]));
  await page.evaluate(() => window.chatProbe.withOpening("h0", "The lantern over the porch is still lit."));

  // The opening choice is open, so its own switcher is offered and idle.
  await expect(page.locator(".swipe-controls")).toHaveCount(1);
  await expect(page.locator(".swipe-indicator")).toHaveText("Default 1/2");
  let attrs = await page.evaluate(() => window.chatProbe.pendingAttrs("h0"));
  expect(attrs).not.toBeNull();
  expect(attrs?.ariaBusy).toBeNull();
  expect(attrs?.dataPending).toBeNull();
  expect(attrs?.switcherDisabled).toBe(false);

  // The choice is in flight: the row says so and its own switcher is disabled.
  await page.evaluate(() => window.chatProbe.setPending({ kind: "opening", handle: "h0" }));
  attrs = await page.evaluate(() => window.chatProbe.pendingAttrs("h0"));
  expect(attrs?.ariaBusy).toBe("true");
  expect(attrs?.dataPending).toBe("opening");
  expect(attrs?.switcherDisabled).toBe(true);

  // Settling clears both.
  await page.evaluate(() => window.chatProbe.setPending(null));
  attrs = await page.evaluate(() => window.chatProbe.pendingAttrs("h0"));
  expect(attrs?.ariaBusy).toBeNull();
  expect(attrs?.dataPending).toBeNull();
  expect(attrs?.switcherDisabled).toBe(false);
});

test("a pending mutation on one message never disables another message's switcher", async ({ page }) => {
  await openProbe(page);
  await page.evaluate(() => window.chatProbe.setTranscript(["First.", "Second."]));
  await page.evaluate(() => window.chatProbe.withOpening("h0", "First."));
  await page.evaluate(() => window.chatProbe.withOpening("h1", "Second."));
  await expect(page.locator(".swipe-controls")).toHaveCount(2);

  await page.evaluate(() => window.chatProbe.setPending({ kind: "opening", handle: "h0" }));

  // h0 is busy and disabled...
  const first = await page.evaluate(() => window.chatProbe.pendingAttrs("h0"));
  expect(first?.ariaBusy).toBe("true");
  expect(first?.switcherDisabled).toBe(true);
  // ...h1 stays idle and fully operable.
  const second = await page.evaluate(() => window.chatProbe.pendingAttrs("h1"));
  expect(second?.ariaBusy).toBeNull();
  expect(second?.switcherDisabled).toBe(false);
});

/**
 * The same "label with no rendering" failure, on the opening choice's own row: the attribute
 * alone cannot catch a missing rule, so this pairs it with the computed animation.
 */
test("renders the opening switcher's busy state, not just the busy attribute", async ({ page }) => {
  await openProbe(page);
  await page.evaluate(() => window.chatProbe.setConversation([
    { role: "companion", text: "The lantern over the porch is still lit." },
  ]));
  await page.evaluate(() => window.chatProbe.withOpening("h0", "The lantern over the porch is still lit."));

  const idle = await page.evaluate(() => window.chatProbe.pendingAnimation("h0"));
  expect(idle?.animationName).toBe("none");

  await page.evaluate(() => window.chatProbe.setPending({ kind: "opening", handle: "h0" }));
  await expect(page.locator("li[data-handle='h0']")).toHaveAttribute("data-pending", "opening");

  const busy = await page.evaluate(() => window.chatProbe.pendingAnimation("h0"));
  expect(busy?.animationName).toContain("message-pending-breathe");
  expect(busy?.animationDuration).not.toBe("0s");
  expect(busy?.transitionDuration).not.toBe("0s");

  // Settling removes the animation again.
  await page.evaluate(() => window.chatProbe.setPending(null));
  const settled = await page.evaluate(() => window.chatProbe.pendingAnimation("h0"));
  expect(settled?.animationName).toBe("none");
});
