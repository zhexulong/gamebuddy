import { expect, test, type Page } from "@playwright/test";

/**
 * The single-message delete, mounted, with its own measurements.
 *
 * A delete leaves a GAP: exactly one message leaves the conversation - from the transcript the player
 * reads and from the model's own memory of it - and every other message stays where it was. That is
 * what separates it from the rewind, which shortens the conversation from a point onward, and it is
 * why the presentation contract here is its own thing:
 *
 * 1. `names what it will remove, and its target is the touch minimum` - the control sits in the strip
 *    the message already carries, and its accessible name says exactly what it does, so the player can
 *    tell before pressing. Measured from the layout: at least the 44 px touch minimum the rest of the
 *    strip uses (`--touch-target-min`).
 * 2. `is offered on a real message and never on the opening` - the greeting is message zero (the Host
 *    refuses it, because the conversation's own recorded opening would outlive the row it names).
 * 3. `arms, replaces the row's own controls, and sends the point it was shown at` - the first press
 *    only arms; the confirmation states what goes and the row's own controls step aside while it is
 *    up; the confirm sends the handle AND the order the page rendered it at (the Host refuses a stale
 *    pair); the cancel closes the arm and sends nothing.
 * 4. `renders the hole the Host re-reads` - after a delete the surface shows whatever the
 *    authoritative reread says, and a surface that hid the row locally or kept rendering it would be
 *    the defect.
 */

const CONVERSATION = [
  { role: "companion" as const, text: "An opening greet." },
  { role: "player" as const, text: "Where are we?" },
  { role: "companion" as const, text: "On the pier." },
  { role: "player" as const, text: "And now?" },
  { role: "companion" as const, text: "Still on the pier." },
];

type DeleteProbe = {
  deleteControl(handle: string): {
    ariaLabel: string | null;
    title: string | null;
    label: string | null;
    width: number;
    height: number;
    stripHeight: number;
  } | null;
  deleteConfirm(handle: string): {
    prompt: string | null;
    yes: string | null;
    no: string | null;
    ordinaryControls: number;
  } | null;
  deleteCalls(): readonly { kind: "arm" | "confirm" | "cancel"; handle: string; order: number }[];
  resetDeleteCalls(): void;
};

declare global {
  interface Window {
    chatProbe: DeleteProbe & {
      setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void;
    };
  }
}

async function openConversation(page: Page, conversation = CONVERSATION): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  await page.evaluate((entries) => window.chatProbe.setConversation(entries), conversation);
}

test("the delete control says what it removes, and its target is the touch minimum", async ({ page }) => {
  await openConversation(page);

  // The mid-conversation reply (h2) is a legal point, and so is the player's own line before it: a
  // delete removes ONE message, so both sides of the conversation carry the control.
  for (const handle of ["h1", "h2"]) {
    const control = await page.evaluate((target) => window.chatProbe.deleteControl(target), handle);
    expect(control).not.toBeNull();
    expect(control?.label?.trim()).toBe("Delete");
    expect(control?.ariaLabel).toBe("Delete this message: the model stops reading it from the next turn on");
    expect(control?.title).toBe(control?.ariaLabel);
    expect(control?.width).toBeGreaterThanOrEqual(44);
    expect(control?.height).toBeGreaterThanOrEqual(44);
    // One control in one row of the strip: a strip that wrapped would be at least two rows tall.
    expect(control?.stripHeight).toBeLessThan(88);
  }

  // The greeting is message zero: the conversation's own recorded opening cannot leave the transcript
  // it opened, so the affordance is absent rather than offered and refused.
  expect(await page.evaluate(() => window.chatProbe.deleteControl("h0"))).toBeNull();

  // Every row of the conversation is still rendered: nothing was removed by looking at the control.
  await expect(page.locator("ol.message-list > li")).toHaveCount(CONVERSATION.length);
});

test("the delete arms, states what goes, replaces the row's controls, and sends the point it showed", async ({
  page,
}) => {
  await openConversation(page);
  await page.evaluate(() => window.chatProbe.resetDeleteCalls());

  // The first press only arms: nothing has been sent to the Host yet.
  await page.click('[data-handle="h2"] [data-testid="message-delete"]');
  expect(await page.evaluate(() => window.chatProbe.deleteCalls())).toEqual([
    { kind: "arm", handle: "h2", order: 2 },
  ]);
  const armed = await page.evaluate(() => window.chatProbe.deleteConfirm("h2"));
  expect(armed).not.toBeNull();
  expect(armed?.prompt).toContain("Delete this message?");
  expect(armed?.prompt).toContain("cannot be undone");
  expect(armed?.yes).toBe("Delete");
  // The negative is the product's one way out (the owner's confirmation ruling, 2026-10-20): the
  // affirmative above names the act, and this answer only leaves the row as it was.
  expect(armed?.no).toBe("Cancel");
  // The confirmation replaces the row's own controls rather than sitting among them.
  expect(armed?.ordinaryControls).toBe(0);
  await expect(page.locator("ol.message-list > li")).toHaveCount(CONVERSATION.length);

  // Cancel closes the arm and sends nothing.
  await page.click('[data-testid="message-delete-confirm-no"]');
  expect(await page.evaluate(() => window.chatProbe.deleteConfirm("h2"))).toBeNull();
  expect(await page.evaluate(() => window.chatProbe.deleteControl("h2"))).not.toBeNull();
  expect(await page.evaluate(() => window.chatProbe.deleteCalls())).toEqual([
    { kind: "arm", handle: "h2", order: 2 },
    { kind: "cancel", handle: "", order: -1 },
  ]);

  // Delete sends the handle AND the order the page rendered it at, and the authoritative reread - not
  // a local rewrite - owns what the conversation then shows.
  await page.click('[data-handle="h2"] [data-testid="message-delete"]');
  await page.click('[data-testid="message-delete-confirm-yes"]');
  expect(await page.evaluate(() => window.chatProbe.deleteCalls())).toEqual([
    { kind: "arm", handle: "h2", order: 2 },
    { kind: "cancel", handle: "", order: -1 },
    { kind: "arm", handle: "h2", order: 2 },
    { kind: "confirm", handle: "h2", order: 2 },
  ]);
  // The row is still there until the Host's reread lands, and the arm is closed: a row that vanished
  // locally would be the surface guessing at the hole instead of reading it.
  expect(await page.evaluate(() => window.chatProbe.deleteConfirm("h2"))).toBeNull();
  await expect(page.locator("ol.message-list > li")).toHaveCount(CONVERSATION.length);

  // The hole the Host re-reads: the row the player named is gone and every other row is where it was.
  await page.evaluate(() =>
    window.chatProbe.setConversation([
      { role: "companion", text: "An opening greet." },
      { role: "player", text: "Where are we?" },
      { role: "player", text: "And now?" },
      { role: "companion", text: "Still on the pier." },
    ]),
  );
  await expect(page.locator("ol.message-list > li")).toHaveCount(CONVERSATION.length - 1);
  await expect(page.locator("ol.message-list")).not.toContainText("On the pier.");
  await expect(page.locator("ol.message-list")).toContainText("Where are we?");
  await expect(page.locator("ol.message-list")).toContainText("And now?");
  await expect(page.locator("ol.message-list")).toContainText("Still on the pier.");
});
