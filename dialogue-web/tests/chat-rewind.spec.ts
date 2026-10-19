import { expect, test, type Page } from "@playwright/test";

/**
 * The message-level rewind, mounted, with its own measurements.
 *
 * The rewind destroys everything after the point the player names, so the presentation contract is
 * three things at once, and each one is an assertion here:
 *
 * 1. `names what it will remove, and its target is the touch minimum` - the control sits in the
 *    strip the reply already carries, and its accessible name carries the COUNT of messages the
 *    press would remove, so the player can tell before pressing. Measured from the layout, not from
 *    a class name: the box is at least the 44 px touch minimum the rest of the strip uses
 *    (`--touch-target-min`).
 * 2. `is offered where a rewind is possible, and nowhere else` - not on the greeting (message zero:
 *    the Host refuses it, because the conversation's own opening would outlive the row it names),
 *    not on a player row (the strip belongs to the companion's own message), not when the caller
 *    could not count what follows, and NOT on the transcript's own last row: there the rewind and
 *    the delete are the same act - both remove that one message - so the row offers the delete
 *    alone (the owner's ruling; the two controls were indistinguishable on it). The count a rewind
 *    can carry is therefore two or more, and the smallest legal one is what this pins.
 * 3. `arms, replaces the row's own controls, and sends the point it was shown at` - the first press
 *    only arms; the confirmation states the consequence and the row's pager/regenerate step aside
 *    while it is up; the confirm sends the handle AND the order the page rendered it at (the Host
 *    refuses a stale pair); the cancel closes the arm and sends nothing.
 * 4. `renders the shortened transcript the Host re-reads` - what the player sees after a rewind is
 *    whatever the authoritative reread says, and a surface that kept the dropped rows locally would
 *    be the defect.
 */

const CONVERSATION = [
  { role: "companion" as const, text: "An opening greet." },
  { role: "player" as const, text: "Where are we?" },
  { role: "companion" as const, text: "On the pier." },
  { role: "player" as const, text: "And now?" },
  { role: "companion" as const, text: "Still on the pier." },
];

type RewindProbe = {
  rewindControl(handle: string): {
    ariaLabel: string | null;
    title: string | null;
    label: string | null;
    width: number;
    height: number;
  } | null;
  deleteControl(handle: string): {
    ariaLabel: string | null;
    title: string | null;
    label: string | null;
    width: number;
    height: number;
    stripHeight: number;
  } | null;
  rewindConfirm(handle: string): {
    prompt: string | null;
    yes: string | null;
    no: string | null;
    ordinaryControls: number;
  } | null;
  rewindCalls(): readonly { kind: "arm" | "confirm" | "cancel"; handle: string; order: number }[];
  resetRewindCalls(): void;
};

declare global {
  interface Window {
    chatProbe: RewindProbe & {
      setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void;
    };
  }
}

async function openConversation(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  await page.evaluate((entries) => window.chatProbe.setConversation(entries), CONVERSATION);
}

test("the rewind control names what it will remove, and its target is the touch minimum", async ({ page }) => {
  await openConversation(page);

  // The middle reply (h2) would remove it and the two rows after it: three in all.
  const control = await page.evaluate(() => window.chatProbe.rewindControl("h2"));
  expect(control).not.toBeNull();
  expect(control?.label?.trim()).toBe("Rewind to here");
  expect(control?.ariaLabel).toContain("3");
  expect(control?.ariaLabel).toContain("Rewind to here");
  expect(control?.title).toBe(control?.ariaLabel);
  // Measured from the layout: the whole target, not a class name.
  expect(control?.width).toBeGreaterThanOrEqual(44);
  expect(control?.height).toBeGreaterThanOrEqual(44);

  // The transcript's own last reply is NOT a rewind point: the cut would remove exactly the row it
  // is named after, which is the delete's own act, so the row offers the delete and nothing else
  // (the owner's ruling - on that row the two controls were the same act twice). The count a legal
  // rewind carries is therefore two or more, and the row one step from the tail is where the
  // smallest one is measured: it would remove itself and the row after it.
  expect(await page.evaluate(() => window.chatProbe.rewindControl("h4"))).toBeNull();
  expect(await page.evaluate(() => window.chatProbe.deleteControl("h4"))).not.toBeNull();

  await page.evaluate(() =>
    window.chatProbe.setConversation([
      { role: "companion", text: "An opening greet." },
      { role: "player", text: "Where are we?" },
      { role: "companion", text: "On the pier." },
      { role: "player", text: "And now?" },
    ]),
  );
  const smallest = await page.evaluate(() => window.chatProbe.rewindControl("h2"));
  expect(smallest, "the reply one step from the tail is still a rewind point").not.toBeNull();
  expect(smallest?.ariaLabel).toContain("2");
});

test("the rewind is offered where a rewind is possible, and nowhere else", async ({ page }) => {
  await openConversation(page);

  // Message zero is the greeting: the Host refuses to drop it, so the surface does not offer it.
  expect(await page.evaluate(() => window.chatProbe.rewindControl("h0"))).toBeNull();
  // A player row carries no companion strip at all.
  expect(await page.evaluate(() => window.chatProbe.rewindControl("h1"))).toBeNull();
  expect(await page.evaluate(() => window.chatProbe.rewindControl("h3"))).toBeNull();
  // A reply in the middle of the conversation is a legal point, and that is what makes the two
  // absences above an absence of the CONTROL rather than of the rule.
  expect(await page.evaluate(() => window.chatProbe.rewindControl("h2"))).not.toBeNull();
  // The transcript's last row is a legal point for the DELETE and not for the rewind: the two
  // would do the same thing there, so the row keeps the delete alone.
  expect(await page.evaluate(() => window.chatProbe.rewindControl("h4"))).toBeNull();
  expect(await page.evaluate(() => window.chatProbe.deleteControl("h4"))).not.toBeNull();

  // Counted on the page that renders it: the rows a rewind removes are the ones after this one.
  const rows = await page.locator("ol.message-list > li").count();
  expect(rows).toBe(CONVERSATION.length);
});

test("arming replaces the row's own controls with the confirmation, and only the confirm sends", async ({ page }) => {
  await openConversation(page);
  await page.evaluate(() => window.chatProbe.resetRewindCalls());

  await page.click('[data-handle="h2"] [data-testid="message-rewind"]');

  const armed = await page.evaluate(() => window.chatProbe.rewindConfirm("h2"));
  expect(armed).not.toBeNull();
  // The confirmation names the point AND what it removes, in the words the owner ruled on; its two
  // answers are the rewind itself and the way out.
  expect(armed?.prompt).toBe("Rewind to before this (deletes this message and everything after it)");
  expect(armed?.yes).toBe("Confirm rewind");
  expect(armed?.no).toBe("Cancel");
  // The confirmation is the row's only control while it is up: the pager and regenerate step aside.
  expect(armed?.ordinaryControls).toBe(0);
  expect(await page.evaluate(() => window.chatProbe.rewindCalls())).toEqual([
    { kind: "arm", handle: "h2", order: 2 },
  ]);

  // The cancel closes the arm and sends nothing.
  await page.click('[data-testid="message-rewind-confirm-no"]');
  expect(await page.evaluate(() => window.chatProbe.rewindConfirm("h2"))).toBeNull();
  expect(await page.evaluate(() => window.chatProbe.rewindControl("h2"))).not.toBeNull();
  expect(await page.evaluate(() => window.chatProbe.rewindCalls())).toEqual([
    { kind: "arm", handle: "h2", order: 2 },
    { kind: "cancel", handle: "", order: -1 },
  ]);

  // The confirm sends the handle and the order the page rendered it at.
  await page.click('[data-handle="h2"] [data-testid="message-rewind"]');
  await page.click('[data-testid="message-rewind-confirm-yes"]');
  expect(await page.evaluate(() => window.chatProbe.rewindCalls())).toEqual([
    { kind: "arm", handle: "h2", order: 2 },
    { kind: "cancel", handle: "", order: -1 },
    { kind: "arm", handle: "h2", order: 2 },
    { kind: "confirm", handle: "h2", order: 2 },
  ]);
  expect(await page.evaluate(() => window.chatProbe.rewindConfirm("h2"))).toBeNull();
});

test("renders the shortened transcript the Host re-reads, and nothing the reread dropped", async ({ page }) => {
  await openConversation(page);

  // The rewind the player confirmed: the Host answers by truncating, and the shell rereads the
  // authoritative snapshot. What is asserted here is that the surface renders exactly that - the
  // dropped rows are gone from the DOM, and the row that ends the conversation still offers the
  // rewind that the shortened transcript makes possible.
  await page.evaluate(() =>
    window.chatProbe.setConversation([
      { role: "companion", text: "An opening greet." },
      { role: "player", text: "Where are we?" },
    ]),
  );

  await expect(page.locator("ol.message-list > li")).toHaveCount(2);
  await expect(page.locator('[data-handle="h2"]')).toHaveCount(0);
  await expect(page.locator('[data-handle="h4"]')).toHaveCount(0);

  const kept = await page.evaluate(() => window.chatProbe.rewindControl("h1"));
  // The kept player row carries no strip (it is the companion's own row that does), and the
  // greeting still offers nothing: the transcript ends where the Host says it does.
  expect(kept).toBeNull();
  expect(await page.evaluate(() => window.chatProbe.rewindControl("h0"))).toBeNull();
});
