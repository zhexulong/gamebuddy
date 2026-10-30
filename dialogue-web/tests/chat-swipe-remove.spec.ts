import { expect, test, type Page } from "@playwright/test";

/**
 * Discarding ONE variant of a reply, mounted, with its own measurements.
 *
 * `chat.swipe.remove` was implemented end to end - the route, the service, the store mutation and its
 * tests - and no surface ever rendered a control for it, so the player could not reach it at all. This
 * journey is the reachability proof, and it holds the four things the control has to be:
 *
 * 1. `is offered beside the arrows that page the same set, and only where a discard is possible` - the
 *    Host refuses a reply left with no words by name (`chat_swipe_last_variant`), so a row carrying one
 *    variant offers NOTHING. A button that could only ever be refused is the dead-control defect, and
 *    the absence is asserted on the page rather than inferred from the fixture.
 * 2. `arms, states what goes, and sends the variant the player was looking at` - a generation costs
 *    tokens, so the first press only arms; the confirmation replaces the row's own controls, the confirm
 *    sends the reply's handle AND the index the page rendered the variant at, and the cancel closes the
 *    arm and sends nothing.
 * 3. `re-reads the position the Host owns` - the discarded variant may be the active one, so removing it
 *    moves the position. The surface must show what the authoritative reread holds rather than compute a
 *    new index locally; the journey drives the reread's own answer and asserts the row follows it.
 * 4. `the control leaves once the reply falls back to one variant` - after a discard that leaves a single
 *    variant there is nothing more to remove, and a control that stayed would offer a press the Host
 *    would refuse.
 *
 * A refusal reaching the player is the fifth property and it is NOT measured here: the sentence for a
 * named code is `composed-problem-view.ts`'s, and the shell's own wiring of it into the surface notice is
 * what `composed-reference-game-browser.spec.ts` drives. What this file can prove is that the arm sends
 * the press that a refusal would answer, which it does.
 */

const CONVERSATION = [
  { role: "companion" as const, text: "An opening greet." },
  { role: "player" as const, text: "Where are we?" },
  { role: "companion" as const, text: "On the pier." },
];

type SwipeRemoveProbe = {
  swipeRemoveControl(handle: string): {
    ariaLabel: string | null;
    title: string | null;
    label: string | null;
    width: number;
    height: number;
    stripHeight: number;
    inPager: boolean;
    stripIndex: number;
  } | null;
  swipeRemoveConfirm(handle: string): {
    prompt: string | null;
    yes: string | null;
    no: string | null;
    ordinaryControls: number;
  } | null;
  swipeRemoveCalls(): readonly { kind: "arm" | "confirm" | "cancel"; handle: string; targetIndex: number }[];
  resetSwipeRemoveCalls(): void;
  swipeSet(handle: string, currentIndex: number, totalSwipes: number, text: string): void;
  swipeRemoveSentences(locale: "en" | "zh-CN"): {
    control: string;
    name: string;
    prompt: string;
    yes: string;
    no: string;
    nextVariant: string;
  };
  setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void;
  transcriptRows(): readonly { handle: string; index: number; text: string | null; bubbles: number }[];
};

declare global {
  interface Window {
    chatProbe: SwipeRemoveProbe;
  }
}

async function openConversation(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  await page.evaluate((entries) => window.chatProbe.setConversation(entries), CONVERSATION);
}

/** The touch minimum every control in this strip uses. */
const TOUCH_MINIMUM = 44;

test("the discard is offered beside the pager, and a single-variant reply offers none at all", async ({ page }) => {
  await openConversation(page);

  // The reply starts as one attempt: there is nothing to discard, and the Host refuses exactly that, so
  // the row carries no control rather than a button whose only answer is a refusal.
  await expect(page.locator('[data-handle="h2"] [data-testid="message-swipe-remove"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.chatProbe.swipeRemoveControl("h2"))).toBeNull();
  // The opening is a companion row too, and it also has one variant: same absence.
  expect(await page.evaluate(() => window.chatProbe.swipeRemoveControl("h0"))).toBeNull();

  // A second attempt at the reply position: the Host now publishes a two-variant set, and the control
  // appears as the LAST child of the stepper that pages it - one group, because "next attempt", "previous
  // attempt" and "throw this attempt away" are three answers to the same question, and because that group
  // already owns a line of its own at narrow widths where a sixth action in the actions row did not.
  await page.evaluate(() => window.chatProbe.swipeSet("h2", 1, 2, "Still on the pier, later."));
  const control = await page.evaluate(() => window.chatProbe.swipeRemoveControl("h2"));
  expect(control, "a two-variant reply offers the discard").not.toBeNull();
  expect(control?.inPager, "it is a member of the stepper that pages the same set").toBe(true);
  // The two paging arrows are still exactly two: the discard is one more control in the group, not a
  // third arrow, and the journeys that enumerate the arrows by name keep their population.
  await expect(page.locator('[data-handle="h2"] .swipe-controls .swipe-btn')).toHaveCount(2);
  await expect(page.locator('[data-handle="h2"] .swipe-controls button')).toHaveCount(3);

  // Its name is the loss, not a direction. Like the two arrows it sits between, the glyph is the whole
  // visible control.
  expect(control?.ariaLabel).toBe("Discard this variant: it is removed from this reply for good");
  expect(control?.title).toBe(control?.ariaLabel);
  expect(control?.label, "the glyph is the whole visible control, as on the arrows beside it").toBe("");
  // Measured from the layout: the target the rest of the strip uses.
  expect(control?.width).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
  expect(control?.height).toBeGreaterThanOrEqual(TOUCH_MINIMUM);

  // A player row never carries one: variants are a companion reply's own set.
  expect(await page.evaluate(() => window.chatProbe.swipeRemoveControl("h1"))).toBeNull();
});

test("arming replaces the row's controls, states the loss, and sends the variant on screen", async ({ page }) => {
  await openConversation(page);
  await page.evaluate(() => window.chatProbe.swipeSet("h2", 1, 2, "Still on the pier, later."));
  await page.evaluate(() => window.chatProbe.resetSwipeRemoveCalls());

  // The first press only arms: nothing has been sent to the Host yet, and the variant is still there.
  await page.click('[data-handle="h2"] [data-testid="message-swipe-remove"]');
  expect(await page.evaluate(() => window.chatProbe.swipeRemoveCalls())).toEqual([
    { kind: "arm", handle: "h2", targetIndex: 1 },
  ]);
  const armed = await page.evaluate(() => window.chatProbe.swipeRemoveConfirm("h2"));
  expect(armed).not.toBeNull();
  // The prompt states the loss and that it cannot be undone.
  expect(armed?.prompt).toContain("Discard this variant?");
  expect(armed?.prompt).toContain("cannot be undone");
  expect(armed?.yes).toBe("Discard");
  // The negative answer is the product's one way out of a destructive press.
  expect(armed?.no).toBe("Cancel");
  // The confirmation replaces the row's own controls rather than sitting among them.
  expect(armed?.ordinaryControls).toBe(0);

  // Cancel closes the arm, sends nothing, and the reply is untouched.
  await page.click('[data-testid="message-swipe-remove-confirm-no"]');
  expect(await page.evaluate(() => window.chatProbe.swipeRemoveConfirm("h2"))).toBeNull();
  expect(await page.evaluate(() => window.chatProbe.swipeRemoveControl("h2"))).not.toBeNull();
  expect(await page.evaluate(() => window.chatProbe.swipeRemoveCalls())).toEqual([
    { kind: "arm", handle: "h2", targetIndex: 1 },
    { kind: "cancel", handle: "", targetIndex: -1 },
  ]);
  expect(await page.locator("ol.message-list > li").count()).toBe(CONVERSATION.length);

  // Confirm sends the handle AND the index the page rendered the variant at - the position the player
  // was looking at, which is what the Host CASes the discard on.
  await page.click('[data-handle="h2"] [data-testid="message-swipe-remove"]');
  await page.click('[data-testid="message-swipe-remove-confirm-yes"]');
  expect(await page.evaluate(() => window.chatProbe.swipeRemoveCalls())).toEqual([
    { kind: "arm", handle: "h2", targetIndex: 1 },
    { kind: "cancel", handle: "", targetIndex: -1 },
    { kind: "arm", handle: "h2", targetIndex: 1 },
    { kind: "confirm", handle: "h2", targetIndex: 1 },
  ]);
  // Nothing moved locally: the arm is closed and the row still shows the reply until the Host's reread
  // lands. A surface that dropped the variant itself would be guessing at what the Host now holds.
  expect(await page.evaluate(() => window.chatProbe.swipeRemoveConfirm("h2"))).toBeNull();
  expect(await page.locator("ol.message-list > li").count()).toBe(CONVERSATION.length);
});

test("after a discard the row shows the position the Host re-read, not a locally computed one", async ({ page }) => {
  await openConversation(page);
  await page.evaluate(() => window.chatProbe.swipeSet("h2", 1, 2, "Still on the pier, later."));
  await page.evaluate(() => window.chatProbe.resetSwipeRemoveCalls());

  // The discard that leaves one variant: the reread reports the row with the other attempt's words, a
  // single variant, and no previous/next to page to. `currentIndex` is the Host's answer.
  await page.click('[data-handle="h2"] [data-testid="message-swipe-remove"]');
  await page.click('[data-testid="message-swipe-remove-confirm-yes"]');
  await page.evaluate(() => window.chatProbe.swipeSet("h2", 0, 1, "On the pier."));

  // The bubble reads the row the Host now holds...
  await expect(page.locator('[data-handle="h2"] .message-bubble')).toContainText("On the pier.");
  await expect(page.locator('[data-handle="h2"] .message-bubble')).not.toContainText("later");
  // ...and with one variant left there is nothing to page and nothing more to discard: the group and the
  // control are both gone, which is the reread's own fact rather than a local guess.
  await expect(page.locator('[data-handle="h2"] .swipe-controls')).toHaveCount(0);
  await expect(page.locator('[data-handle="h2"] [data-testid="message-swipe-remove"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.chatProbe.swipeRemoveControl("h2"))).toBeNull();

  // The reread is what decides the position even when it lands on a different variant than arithmetic
  // would: a two-variant set whose Host says the FIRST is active. The indicator is the Host's number, and
  // the discard targets that number - the surface never carries an index of its own.
  await page.evaluate(() => window.chatProbe.swipeSet("h2", 0, 2, "On the pier."));
  await expect(page.locator('[data-handle="h2"] .swipe-indicator')).toHaveText("1/2");
  await page.evaluate(() => window.chatProbe.resetSwipeRemoveCalls());
  await page.click('[data-handle="h2"] [data-testid="message-swipe-remove"]');
  expect(
    await page.evaluate(() => window.chatProbe.swipeRemoveCalls()),
    "the discard names the variant the Host says is active",
  ).toEqual([{ kind: "arm", handle: "h2", targetIndex: 0 }]);
});

test("the discard names the loss rather than a direction, in both catalogues", async ({ page }) => {
  await openConversation(page);
  await page.evaluate(() => window.chatProbe.swipeSet("h2", 1, 2, "Still on the pier, later."));

  // The mounted probe serves the English catalogue, so the name the control wears is asserted here...
  const english = await page.evaluate(() => window.chatProbe.swipeRemoveControl("h2"));
  expect(english?.ariaLabel).toBe("Discard this variant: it is removed from this reply for good");

  // ...and both catalogues are pinned by the same shape the surface's other words use: one sentence
  // stating the loss in each language, distinct from the paging arrows beside it.
  for (const locale of ["en", "zh-CN"] as const) {
    const words = await page.evaluate((value) => window.chatProbe.swipeRemoveSentences(value), locale);
    const englishWording = locale === "en";
    expect(words.name, `${locale} names the loss`).toContain(
      englishWording ? "Discard this variant" : "丢弃这个版本",
    );
    expect(words.name, `${locale} is not the paging arrow's word`).not.toBe(words.nextVariant);
    expect(words.prompt, `${locale} states that it cannot be undone`).toContain(
      englishWording ? "cannot be undone" : "无法撤销",
    );
    expect(words.yes, `${locale} affirms what the press does`).toBe(englishWording ? "Discard" : "丢弃");
    expect(words.no, `${locale} keeps the product's one way out`).toBe(
      englishWording ? "Cancel" : "取消",
    );
  }
});

