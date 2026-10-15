import { expect, test, type Page } from "@playwright/test";

/**
 * The message-level chat mutation the surface still offers, and the one it does not.
 *
 * Regenerate and swipe are withdrawn. The design freezes their UI and API until the prepared
 * response transaction and the branch binding exist
 * (`design/archive/legacy-sources/24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md:341`), and every
 * click of them appended a new tail turn and re-sent the player's own line
 * (`host/src/tavern/chat-pipeline-service.ts`), so each one contaminated a live review. The
 * capability is built behind a hidden door, and these journeys pin the door: a message the Host
 * still labels with its variant position offers no switcher at all, and no row offers a
 * Regenerate control.
 *
 * The failure each assertion catches:
 *
 * 1. `a message the Host labels with a variant position renders no variant switcher` - the
 *    position is a projection fact the Host still publishes, so a surface that renders it as a
 *    control is the withdrawn affordance coming back through the state field rather than through
 *    a route.
 * 2. `the transcript never offers a regenerate control, on any row` - keeps the placement rule's
 *    own journeys (the opening, a settled turn, a middle reply) and asserts the control is absent
 *    from all of them, so the row that used to carry it is covered rather than left unasserted.
 * 3. `the opening switcher reports its own mutation in flight and clears it when it settles` and
 *    4. `a pending mutation on one message never disables another message's switcher` - the
 *    `data-pending`/`aria-busy` projection the shell still drives for the new-chat opening choice
 *    (`chat.opening`): the row that is mutating says so and disables its own switcher, and no
 *    other row's switcher is collateral damage.
 * 5. `renders the busy state, not just the busy attribute` - the row carrying `data-pending` is
 *    the shell's *label*; if no rule consumes it the player sees a dead click and no feedback at
 *    all. This asserts the computed animation the attribute is supposed to produce, so the two
 *    cannot drift apart.
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
  setPending(pending: { kind: "opening"; handle: string } | null): void;
  withSwipes(handle: string, text: string): void;
  withOpening(handle: string, text: string): void;
  pendingAttrs(handle: string): { ariaBusy: string | null; dataPending: string | null; switcherDisabled: boolean } | null;
  pendingAnimation(
    handle: string,
  ): { animationName: string; animationDuration: string; transitionDuration: string } | null;
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

test("a message the Host labels with a variant position renders no variant switcher", async ({ page }) => {
  await openProbe(page);
  await page.evaluate((entries) => window.chatProbe.setConversation(entries), CONVERSATION);
  await page.evaluate(() => window.chatProbe.withSwipes("h1", "A varianted reply."));

  await expect(page.locator(".message-list > li"), "the transcript is still the two rows it was").toHaveCount(2);
  await expect(page.locator(".message-list > li[data-handle='h1']")).toContainText("A varianted reply.");

  expect(await page.locator(".swipe-controls").count(), "no variant switcher is offered").toBe(0);
  expect(await page.locator(".swipe-btn").count(), "and its arrows with it").toBe(0);
  expect(await page.locator(".swipe-indicator").count(), "and the position it printed").toBe(0);
  expect(await page.locator(".regenerate-btn").count(), "no regenerate control exists").toBe(0);
  expect(await page.getByRole("button", { name: "Regenerate" }).count(), "nor under its own name").toBe(0);
  expect(await page.getByRole("button", { name: "Previous variant" }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Next variant" }).count()).toBe(0);
});

/**
 * The placement rule the withdrawn control used to have: an opening (or any earlier row) carrying
 * a control whose click appends a *new* tail turn attached to the bottom of a conversation that
 * never asked for it. Every shape that used to offer it is asserted to offer nothing.
 */
test("the transcript never offers a regenerate control, on any row", async ({ page }) => {
  await openProbe(page);
  const offered = async (): Promise<string[]> =>
    await page.evaluate(() =>
      [...document.querySelectorAll("li[data-handle]")]
        .filter((row) => row.querySelector(".regenerate-btn") !== null)
        .map((row) => row.getAttribute("data-handle") ?? ""),
    );

  // A chat that opened on its greeting: the opening is the whole transcript.
  await page.evaluate(() => window.chatProbe.setConversation([
    { role: "companion", text: "The morning light comes over the ridge." },
  ]));
  await expect(page.locator(".message-list > li")).toHaveCount(1);
  expect(await offered()).toEqual([]);

  // A settled turn: the row that used to carry it.
  await page.evaluate((entries) => window.chatProbe.setConversation(entries), CONVERSATION);
  await expect(page.locator(".message-list > li")).toHaveCount(2);
  expect(await offered()).toEqual([]);

  // A turn in flight: the transcript ends on the player's own line.
  await page.evaluate(() => window.chatProbe.setConversation([
    { role: "player", text: "Where are we?" },
    { role: "companion", text: "A varianted reply." },
    { role: "player", text: "And then?" },
  ]));
  await expect(page.locator(".message-list > li")).toHaveCount(3);
  expect(await offered()).toEqual([]);

  // A middle reply, however many turns follow.
  await page.evaluate(() => window.chatProbe.setConversation([
    { role: "player", text: "Where are we?" },
    { role: "companion", text: "A first reply." },
    { role: "player", text: "And then?" },
    { role: "companion", text: "A second reply." },
  ]));
  await expect(page.locator(".message-list > li")).toHaveCount(4);
  expect(await offered()).toEqual([]);
});

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
 * The failure: the shell's `data-pending` projection is a label, and a label
 * with no rendering is exactly the "did my click do anything" surface the
 * reviewer reported. The attribute alone cannot catch that - this pairs it with
 * the computed animation the attribute is supposed to produce, so removing the
 * style while keeping the attribute fails.
 */
test("renders the busy state, not just the busy attribute", async ({ page }) => {
  await openProbe(page);
  await page.evaluate(() => window.chatProbe.setConversation([
    { role: "companion", text: "The lantern over the porch is still lit." },
  ]));
  await page.evaluate(() => window.chatProbe.withOpening("h0", "The lantern over the porch is still lit."));

  // Idle: the bubble carries no pending animation.
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
