import { expect, test, type Page } from "./frontend-coverage";

/**
 * The edit is the message, the fork is a button, and the strip still ends at five.
 *
 * The owner's ruling of 2026-11-16 has two halves, and each has its own reading here:
 *
 *  - EDIT LEFT THE STRIP. Pressing a message's words is what asks to rewrite them - on the player's own
 *    line, on her reply and on the opening, which is the only way to fix a greeting's words. So no strip
 *    on any row carries an edit control, and the body is the affordance instead.
 *  - FORK TOOK THE SLOT. It used to be the second answer behind the same control as Rewind, which made
 *    the safe answer cost the dangerous one's ceremony; it is its own button now, Rewind is its own arming
 *    control again, and the strip's five actions are Copy, Regenerate (where the Host offers it), Rewind,
 *    Fork and Delete.
 *
 * The three things a click-to-edit affordance breaks are the reason this file exists rather than a
 * one-line change, and each one is read on the real mounted surface:
 *
 *  1. SELECTION. Dragging across the words selects them, and a message that answered a drag with an editor
 *     would make copying a sentence impossible. Only a plain press on collapsed text opens it.
 *  2. KEYBOARD. A pointer-only affordance is an accessibility regression. The body is a tab stop that says
 *     what pressing it does, and it is NOT given a widget role: it is prose, and `role="button"` on a
 *     paragraph would announce a control that does not exist while getting in the way of reading it.
 *  3. INTERACTIVE CHILDREN. A press on a link or another control inside the message belongs to that
 *     control. (The reply grammar carries no link today, so the harness plants one: the guard is about the
 *     press, not about which construct happened to be renderable on the day it was written.)
 */

const CONVERSATION = [
  { role: "companion" as const, text: "An opening greet." },
  { role: "player" as const, text: "Where are we?" },
  { role: "companion" as const, text: "On the pier." },
  { role: "player" as const, text: "And now?" },
  { role: "companion" as const, text: "Still on the pier." },
];

type LaneProbe = {
  setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void;
  withSwipes(handle: string, text: string): void;
  editAffordance(handle: string): {
    tag: string;
    isButton: boolean;
    tabStop: boolean;
    keyShortcuts: string | null;
    describedByText: string | null;
    inStrip: boolean;
    bubbleWidth: number;
  } | null;
};

declare global {
  interface Window {
    chatProbe: LaneProbe;
    probeChildPressed?: number;
  }
}

async function openConversation(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  await page.evaluate((entries) => window.chatProbe.setConversation(entries), CONVERSATION);
}

/** The test handles of one row's strip children, in the order the strip draws them. */
async function stripActions(page: Page, handle: string): Promise<string[]> {
  return await page.evaluate((rowHandle) => {
    const strip = document.querySelector(`li[data-handle="${rowHandle}"] .message-actions`);
    if (strip === null) return [];
    return [...strip.children].map((child) => child.getAttribute("data-testid") ?? child.className);
  }, handle);
}

test("edit is not a strip action on any row: the message itself is the affordance", async ({ page }) => {
  await openConversation(page);
  await page.evaluate(() => window.chatProbe.withSwipes("h2", "On the pier."));

  // No row carries an edit control, on either side of the exchange or on the opening.
  expect(
    await page.locator("li .message-actions [data-testid='message-edit']").count(),
    "no strip holds an edit control",
  ).toBe(0);
  for (const handle of ["h0", "h1", "h2", "h3", "h4"]) {
    await expect(page.locator(`li[data-handle="${handle}"] [data-testid="message-edit"]`)).toHaveCount(1);
  }
  // And the score is the thing that replaced it: the message, on all three kinds of row - including the
  // opening, which has no other way to have its words corrected.
  for (const handle of ["h0", "h2", "h4"]) {
    const affordance = await page.evaluate((rowHandle) => window.chatProbe.editAffordance(rowHandle), handle);
    expect(affordance, `${handle} (her row) is editable by pressing it`).not.toBeNull();
    expect(affordance?.isButton, `${handle} is prose, not a button`).toBe(false);
    expect(affordance?.inStrip, `${handle}'s affordance is not in the strip`).toBe(false);
  }
  const player = await page.evaluate(() => window.chatProbe.editAffordance("h1"));
  expect(player?.isButton, "and the player's own line is the same affordance").toBe(false);
  expect(player?.inStrip, "outside the strip there too").toBe(false);
});

test("fork is its own button, rewind arms its own confirmation, and the strip ends at five actions", async ({
  page,
}) => {
  await openConversation(page);
  await page.evaluate(() => window.chatProbe.withSwipes("h2", "On the pier."));

  // Her paged reply is where the strip holds the most: the pager, the four entries, and the delete.
  const herStrip = await stripActions(page, "h2");
  console.log(`[strip h2] ${JSON.stringify(herStrip)}`);
  expect(herStrip, "her paged reply's strip, in the order it draws it").toEqual([
    "message-copy",
    "swipe-controls",
    "message-rewind",
    "message-fork",
    "message-delete",
  ]);
  // The five ACTIONS (the pager is state, not an action) are named here rather than counted blindly.
  const actions = (await stripActions(page, "h1")).filter((name) => !name.includes("swipe-controls"));
  expect(actions, "the player's own row carries the same four actions it did, with Fork in Edit's slot").toEqual([
    "message-copy",
    "message-rewind",
    "message-fork",
    "message-delete",
  ]);
  // Both entries are real buttons in the strip - pressable, named, and 44 px.
  for (const testId of ["message-rewind", "message-fork"]) {
    const box = await page.locator(`li[data-handle="h2"] [data-testid="${testId}"]`).boundingBox();
    expect(box, `${testId} is on the row`).not.toBeNull();
    expect(box!.height, `${testId} clears the 44 px floor`).toBeGreaterThanOrEqual(44);
    expect(box!.width, `${testId} is a target, not a squeezed glyph`).toBeGreaterThanOrEqual(44);
  }
});

test("dragging across the words selects them and opens nothing; a plain press opens the editor", async ({
  page,
}) => {
  await openConversation(page);
  const bubble = page.locator('li[data-handle="h2"] .message-bubble');
  const box = (await bubble.boundingBox())!;
  console.log(`[drag box] ${JSON.stringify(box)}`);
  const field = page.locator('li[data-handle="h2"] [data-testid="message-edit-field"]');

  // READING 1: drag-select. The press travels across the words, which is how a player copies a sentence.
  await page.mouse.move(box.x + 18, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  const dragged = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  console.log(`[drag-select] selection ${JSON.stringify(dragged)}`);
  await expect(field, "a drag opens no editor, however far it travelled").toHaveCount(0);

  // READING 2: double-click selects one word. Its FIRST click is an ordinary press, which is why the open
  // waits out one settle window - a field that ate a word selection would be the defect this measures.
  await bubble.dblclick({ position: { x: 30, y: box.height / 2 } });
  const doubled = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  console.log(`[double-click] selection ${JSON.stringify(doubled)}`);
  expect(doubled.length, "the double click really selected the word").toBeGreaterThan(0);
  await expect(field, "and it opens no editor either").toHaveCount(0);

  // READING 3: a plain press. No drag, nothing selected - the one press that means "rewrite these words".
  await bubble.click();
  await expect(field).toHaveCount(1);
  await expect(field).toHaveValue("On the pier.");
  await expect(field).toBeFocused();
});

test("the body is reachable and openable from the keyboard, and says how", async ({ page }) => {
  await openConversation(page);

  const affordance = await page.evaluate(() => window.chatProbe.editAffordance("h1"));
  expect(affordance?.tag, "the affordance is a plain element, not a button").toBe("div");
  expect(affordance?.tabStop, "and it is a real tab stop").toBe(true);
  expect(affordance?.keyShortcuts, "declaring the shortcut a screen reader can announce").toBe("F2");
  expect(affordance?.describedByText, "with a sentence that says the words can be rewritten").toContain(
    "to edit its words",
  );

  const body = page.locator('li[data-handle="h1"] [data-testid="message-edit"]');
  await body.focus();
  await page.keyboard.press("Enter");
  const field = page.locator('li[data-handle="h1"] [data-testid="message-edit-field"]');
  await expect(field, "Enter opens the editor").toHaveCount(1);
  await expect(field, "and the focus lands in it").toBeFocused();
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);

  // F2 is the other half of the same declaration.
  await body.focus();
  await page.keyboard.press("F2");
  await expect(page.locator('li[data-handle="h1"] [data-testid="message-edit-field"]')).toHaveCount(1);
});

test("a press on a control inside the message does its own thing and opens no editor", async ({ page }) => {
  await openConversation(page);

  // The reply grammar carries no link today; the harness plants one for the press to land on, and counts
  // the presses it receives. A link's press belongs to the link.
  await page.evaluate(() => {
    window.probeChildPressed = 0;
    const child = document.createElement("button");
    child.type = "button";
    child.className = "probe-inline-child";
    child.textContent = "inline";
    child.addEventListener("click", () => {
      window.probeChildPressed = (window.probeChildPressed ?? 0) + 1;
    });
    document.querySelector('li[data-handle="h1"] .message-bubble')?.append(child);
  });

  await page.getByRole("button", { name: "inline", exact: true }).click();
  expect(await page.evaluate(() => window.probeChildPressed), "the child got its own press").toBe(1);
  await expect(page.locator('[data-testid="message-edit-field"]'), "and no editor opened").toHaveCount(0);
});
