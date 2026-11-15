import { expect, test, type Page } from "./frontend-coverage";

/**
 * One row's actions are split around the bubble, and the words are prose again.
 *
 * The owner's decision of 2026-11-16 ("pressing the message is the edit") was reversed because of what
 * it cost the place a reader came to: the body carried `cursor: pointer` and a plain click swapped the
 * formatted reply for a field, so selecting a sentence, copying a paragraph or simply reading one all
 * passed through an editor. The replacement keeps the ruling's good half - an edit is one press, not a
 * trip to a settings panel - and moves it to an explicit control, which is also the pattern the owner
 * pointed at: Google AI Studio's user-prompt rows carry their edit affordance at the row's TOP-RIGHT,
 * while the model rows carry copy/regenerate/pager BENEATH the message.
 *
 * So a row is read as three bands, and every reading in this file is about one of them:
 *
 *  1. ABOVE THE WORDS the edit icon: one `<button>`, named by `editHint`, a real 44 px target, hidden
 *     with `opacity` (never `display: none`, which cannot be focus-revealed) and revealed on hover AND
 *     on `:focus-visible`. It must not cover a word: `overlapsProse` compares it against the bubble's
 *     CONTENT box, because a target that only reaches into the bubble's padding still selects fine.
 *  2. THE WORDS themselves: prose. No role, no tab stop, no press. A drag still selects, a double click
 *     still selects a word, and a single click opens nothing at all.
 *  3. BENEATH THE WORDS the strip, cut down to what a reader reaches for constantly - copy, the variant
 *     pager, Regenerate - plus ONE overflow trigger. The three controls that change the conversation
 *     (rewind, fork, delete) live inside it, so a short reply does not grow a two-row button block.
 *
 * The strip's arithmetic is the reason for the split and is measured here rather than asserted in the
 * abstract: at 520x900 five worded-or-iconed actions plus the pager did not fit the column, so her paged
 * reply paid 98 px of controls for a 46 px bubble. Three actions plus the overflow fit on one line with
 * the pager at that width, and at 400x800 the pager keeps the line of its own the narrow rule gives it.
 *
 * Nothing about the confirmations moved: the rewind still arms, the delete still arms, and the fork is
 * still one press whose name carries the memory clause. What moved is where they are PRESSED from.
 */

const SIX = [
  { role: "companion" as const, text: "An opening greet." },
  { role: "player" as const, text: "Where are we?" },
  { role: "companion" as const, text: "On the pier." },
  { role: "player" as const, text: "And now?" },
  { role: "companion" as const, text: "Still on the pier." },
  { role: "player" as const, text: "Then where?" },
];

/** The sentence the edit icon is named by: it says what the press does, not what the words are. */
const EDIT_HINT = "Edit this message's words.";

/** The overflow's own name. It is a disclosure, not a menu of the keyboard-trapping kind. */
const MORE_ACTIONS = "More actions for this message";

type Box = Readonly<{ width: number; height: number; left: number; right: number; top: number; bottom: number }>;

type RowReading = Readonly<{
  row: Box;
  bubble: Box | null;
  strip: Box | null;
  blockHeight: number;
  stripChildren: readonly string[];
  prose: Readonly<{ cursor: string; role: string | null; tabStop: boolean }>;
  edit: Readonly<{
    name: string | null;
    width: number;
    height: number;
    opacity: number;
    box: Box;
    overlapsProse: boolean;
  }> | null;
  more: Readonly<{ name: string | null; expanded: string | null; width: number; height: number }> | null;
}>;

type Focus = Readonly<{
  tag: string;
  testId: string | null;
  control: string;
  handle: string | null;
  revealer: boolean;
  prose: boolean;
}>;

declare global {
  interface Window {
    /** How many presses the harness's planted inline button received. */
    probeChildPressed?: number;
    chatProbe: {
      setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void;
      setTurnInFlight(value: boolean): void;
      withSwipes(handle: string, text: string): void;
      rowActions(handle: string): RowReading | null;
      moreMenu(handle: string): {
        open: boolean;
        items: readonly { testId: string | null; name: string | null; width: number; height: number }[];
      } | null;
      focusedControl(): Focus;
      forkCalls(): readonly string[];
    };
  }
}

/**
 * The transcript every reading below is taken on, and the one row they are taken from.
 *
 * `h2` is her paged reply, which is the strip's worst case: a row with a variant set, rows after it (so
 * a rewind and a fork point exist), a delete point, and - because the probe hands the Host's settled
 * turn - Regenerate. `h1` is the player's own line, the other side of the same split.
 */
async function openConversation(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  await page.evaluate((rows) => window.chatProbe.setConversation(rows), SIX);
  // The Host's turn is settled: that is what offers Regenerate on a reply that is not the last row.
  await page.evaluate(() => window.chatProbe.setTurnInFlight(false));
  await page.evaluate(() => window.chatProbe.withSwipes("h2", "On the pier."));
}

test("the words are prose: a press on them opens nothing, and a drag still selects them", async ({ page }) => {
  await openConversation(page);
  const bubble = page.locator('li[data-handle="h2"] .message-bubble');
  const box = (await bubble.boundingBox())!;
  const field = page.locator('li[data-handle="h2"] [data-testid="message-edit-field"]');

  // The reading that must not move. Dragging across a message selects its words - that is how a player
  // copies a sentence, quotes a paragraph, or reads one with the mouse held down.
  await page.mouse.move(box.x + 18, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  const dragged = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  console.log(`[drag-select] selection ${JSON.stringify(dragged)}`);
  expect(dragged.length, "the drag really selected the words").toBeGreaterThan(0);
  await expect(field, "a drag opens no editor, however far it travelled").toHaveCount(0);

  // And the reading this shape exists for: a plain press is a press on the words. The selection the
  // drag above left is cleared first, because a press made while text is selected is a press about the
  // SELECTION - the old shape refused that one too, and this reading is about the honest single press.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await bubble.click();
  // Long enough for the settle window the old shape waited out before it opened a field, so "nothing
  // opened" is a fact about the press and not about a timer that had not fired yet.
  await page.waitForTimeout(400);
  console.log(`[prose press] an editor opened on a plain press of the words: ${await field.count()}`);
  await expect(
    field,
    "a press on the words edits nothing: the words are what is read, selected and copied",
  ).toHaveCount(0);

  // The body is prose in the tree as well as in the press: no role to announce it as a control, no tab
  // stop to walk through, and the text cursor a reader expects over words.
  const row = await page.evaluate(() => window.chatProbe.rowActions("h2"));
  expect(row!.prose.role, "the reply is not announced as a control").toBeNull();
  expect(row!.prose.tabStop, "and it is not a stop of its own").toBe(false);
  expect(row!.prose.cursor, "the pointer over prose is the text cursor").toBe("text");

  // A control INSIDE the message keeps its own press: the reply grammar carries no link today, so the
  // harness plants one. A message that swallowed its children's presses was the second thing a
  // click-to-edit body cost, and it is read here so it cannot come back with the next construct.
  await page.evaluate(() => {
    window.probeChildPressed = 0;
    const child = document.createElement("button");
    child.type = "button";
    child.textContent = "inline";
    child.addEventListener("click", () => {
      window.probeChildPressed = (window.probeChildPressed ?? 0) + 1;
    });
    document.querySelector('li[data-handle="h2"] .message-bubble')?.append(child);
  });
  await page.getByRole("button", { name: "inline", exact: true }).click();
  expect(await page.evaluate(() => window.probeChildPressed), "the child got its own press").toBe(1);
  await expect(field, "and no editor opened beside it").toHaveCount(0);
});

test("the edit control is the row's own icon: top right, above the words, 44 px, and clear of them", async ({
  page,
}) => {
  await openConversation(page);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 400, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    const where = `${viewport.width}x${viewport.height}`;
    const row = await page.evaluate(() => window.chatProbe.rowActions("h2"));
    console.log(`[edit ${where}] ${JSON.stringify(row?.edit)}`);

    expect(row!.edit, `${where}: the row carries an edit control`).not.toBeNull();
    expect(row!.edit!.name, `${where}: named by the sentence that says what pressing it does`).toBe(EDIT_HINT);
    expect(row!.edit!.width, `${where}: a 44 px hit area`).toBeGreaterThanOrEqual(44);
    expect(row!.edit!.height, `${where}: in both directions`).toBeGreaterThanOrEqual(44);
    expect(row!.edit!.opacity, `${where}: nothing is painted until it is hovered or focused`).toBe(0);
    // The row's top-right corner, and above the words rather than on them.
    expect(row!.edit!.box.top, `${where}: it hangs above the bubble`).toBeLessThan(row!.bubble!.top);
    expect(
      Math.abs(row!.edit!.box.right - row!.row.right),
      `${where}: flush with the row's own right edge`,
    ).toBeLessThanOrEqual(2);
    // The one assertion that keeps a 44 px target from eating the prose it sits above.
    expect(row!.edit!.overlapsProse, `${where}: and it reaches no word of the message`).toBe(false);
  }

  // Hover paints it, and so does focus: a control in the tab order that only a pointer can reveal is the
  // trap this shape would otherwise trade for the one it removes.
  const plate = page.locator('li[data-handle="h2"] .message-edit-hint');
  await page.locator('li[data-handle="h2"]').hover();
  expect(
    await page.evaluate(() => window.chatProbe.rowActions("h2")?.edit?.opacity),
    "hover paints it",
  ).toBe(1);
  await page.mouse.move(0, 0);
  expect(
    await page.evaluate(() => window.chatProbe.rowActions("h2")?.edit?.opacity),
    "and moving away unpaints it: the words are what is on screen",
  ).toBe(0);

  await plate.focus();
  expect(await page.evaluate(() => window.chatProbe.rowActions("h2")?.edit?.opacity), "focus paints it").toBe(1);
  await page.keyboard.press("Enter");
  const field = page.locator('li[data-handle="h2"] [data-testid="message-edit-field"]');
  await expect(field, "Enter opens the editor").toBeFocused();
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(plate, "and the focus comes back to the icon, not to the words").toBeFocused();

  // The opening is editable through the same control - it is the only way to fix a greeting's words.
  const opening = await page.evaluate(() => window.chatProbe.rowActions("h0"));
  expect(opening!.edit, "the opening carries the same icon").not.toBeNull();
  expect(opening!.edit!.name).toBe(EDIT_HINT);
});

test("the strip keeps the three frequent actions and the other three move into one overflow", async ({ page }) => {
  await openConversation(page);

  const row = await page.evaluate(() => window.chatProbe.rowActions("h2"));
  console.log(`[strip h2] ${JSON.stringify(row!.stripChildren)}`);
  expect(row!.stripChildren, "the strip under her paged reply, in the order it draws it").toEqual([
    "message-copy",
    "swipe-controls",
    "regenerate-btn",
    "message-more",
  ]);
  expect(row!.more!.name, "the overflow is named for what it holds").toBe(MORE_ACTIONS);
  expect(row!.more!.expanded, "and says out loud that it is shut").toBe("false");
  expect(row!.more!.width, "it is a 44 px target").toBeGreaterThanOrEqual(44);
  expect(row!.more!.height).toBeGreaterThanOrEqual(44);

  // None of the three that change the conversation is standing in the strip any more.
  for (const testId of ["message-rewind", "message-fork", "message-delete"]) {
    await expect(
      page.locator(`li[data-handle="h2"] .message-actions [data-testid="${testId}"]`),
      `${testId} is not a strip control any more`,
    ).toHaveCount(0);
  }

  // Opened, it holds exactly those three, each a named target of its own.
  await page.locator('li[data-handle="h2"] [data-testid="message-more"]').click();
  const menu = await page.evaluate(() => window.chatProbe.moreMenu("h2"));
  console.log(`[overflow h2] ${JSON.stringify(menu)}`);
  expect(menu!.open, "the press opens it").toBe(true);
  expect(
    menu!.items.map((item) => item.testId),
    "and it holds the rewind, the fork and the delete",
  ).toEqual(["message-rewind", "message-fork", "message-delete"]);
  for (const item of menu!.items) {
    expect(item.name ?? "", `${item.testId} keeps an accessible name`).not.toBe("");
    expect(item.width, `${item.testId} is a target`).toBeGreaterThanOrEqual(44);
    expect(item.height, `${item.testId} clears the 44 px floor`).toBeGreaterThanOrEqual(44);
  }

  // The player's own line is the same split with one action fewer: a player row has no pager.
  const player = await page.evaluate(() => window.chatProbe.rowActions("h1"));
  console.log(`[strip h1] ${JSON.stringify(player!.stripChildren)}`);
  expect(player!.stripChildren, "the player's row: copy and the overflow").toEqual(["message-copy", "message-more"]);
});

test("the row's controls cost the reply less room than the five-action strip did", async ({ page }) => {
  await openConversation(page);

  const readAt = async (width: number, height: number): Promise<RowReading> => {
    await page.setViewportSize({ width, height });
    return (await page.evaluate(() => window.chatProbe.rowActions("h2")))!;
  };

  // 400x800: the pager still owns the line beneath the actions here - the narrow rule is unchanged - so the
  // strip's HEIGHT is the same two-row box it was (98 px). What shrank there is the actions line: five 44 px
  // targets became three plus the overflow (236 px -> 140 px), which is what let the pager's own break move
  // in from an 833 px column to 430.
  const phone = await readAt(400, 800);
  // 520x900: the width at which five actions plus the pager stopped fitting, and the strip paid two rows for
  // a one-line reply. Three actions plus the overflow fit beside the pager, so the same reply is one row here.
  const laptop = await readAt(520, 900);
  for (const [where, reading] of [
    ["400x800", phone],
    ["520x900", laptop],
  ] as const) {
    console.log(
      `[block ${where}] ${JSON.stringify({
        block: reading.blockHeight,
        bubble: reading.bubble?.height,
        strip: reading.strip?.height,
        children: reading.stripChildren.length,
      })}`,
    );
  }

  expect(phone.strip!.height, "400x800: the two-row paged strip, unchanged in height").toBeLessThanOrEqual(98);
  expect(
    phone.stripChildren.length,
    "400x800: and its actions line is three targets plus the overflow - the five that stranded it, gone",
  ).toBe(4);
  expect(
    laptop.strip!.height,
    "520x900: copy, pager, Regenerate and the overflow on ONE line",
  ).toBeLessThanOrEqual(48);
  // The block the bubble and its controls make together - what a short reply pays for them. Both ceilings
  // are the AFTER: the phone measurement never moved (152 -> 152, because its strip was already two rows),
  // and the 520 measurement is the whole point of the split (152 -> 100).
  expect(phone.blockHeight, "400x800: the bubble plus the two-row strip").toBeLessThanOrEqual(152);
  expect(laptop.blockHeight, "520x900: the bubble plus one row of controls").toBeLessThanOrEqual(100);
});

test("a row's keyboard order is the order it draws: edit, copy, pager, Regenerate, overflow", async ({ page }) => {
  await openConversation(page);

  const plate = page.locator('li[data-handle="h2"] .message-edit-hint');
  await plate.focus();
  const walked: string[] = [];
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => window.chatProbe.focusedControl());
    if (focused.handle !== "h2") break;
    walked.push(focused.control);
  }
  console.log(`[tab order h2] ${JSON.stringify(walked)}`);
  expect(walked, "one row's controls, in the order the row draws them").toEqual([
    "message-copy",
    "swipe-btn",
    "swipe-btn",
    "message-swipe-remove",
    "regenerate-btn",
    "message-more",
  ]);

  // The overflow is opened and closed from the keyboard, and Escape puts the focus back on the trigger
  // rather than on `<body>` - the trigger is the only control the player was standing on.
  const trigger = page.locator('li[data-handle="h2"] [data-testid="message-more"]');
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.locator('[data-testid="message-more-menu"]');
  await expect(menu, "Enter opens the overflow").toHaveCount(1);
  await page.keyboard.press("Tab");
  expect(
    (await page.evaluate(() => window.chatProbe.focusedControl())).testId,
    "and Tab reaches the first entry inside it",
  ).toBe("message-rewind");

  await page.keyboard.press("Escape");
  await expect(menu, "Escape closes it").toHaveCount(0);
  expect(await page.evaluate(() => window.chatProbe.focusedControl())).toEqual({
    tag: "button",
    testId: "message-more",
    control: "message-more",
    handle: "h2",
    revealer: false,
    prose: false,
  });
});

test("the three entries behind the overflow still ask before they act", async ({ page }) => {
  await openConversation(page);
  const openOverflow = async (): Promise<void> => {
    // Idempotent: a cancelled arm brings the panel back (that is where the focus returns to), so a second
    // press on the trigger would close it again.
    const menu = page.locator('[data-testid="message-more-menu"]');
    if ((await menu.count()) === 0) {
      await page.locator('li[data-handle="h2"] [data-testid="message-more"]').click();
    }
    await expect(menu).toHaveCount(1);
  };

  // REWIND: the entry arms, the confirmation REPLACES the strip, and Cancel is the way out.
  await openOverflow();
  await page.locator('li[data-handle="h2"] [data-testid="message-rewind"]').click();
  const rewind = page.locator('[data-testid="message-rewind-confirm"]');
  await expect(rewind, "the rewind asks before it cuts").toHaveCount(1);
  await expect(rewind, "and states what it removes").toContainText("deletes everything after it");
  await expect(
    page.locator('li[data-handle="h2"] [data-testid="message-copy"]'),
    "while nothing else stands beside the confirmation",
  ).toHaveCount(0);
  await page.locator('[data-testid="message-rewind-confirm-no"]').click();
  await expect(rewind).toHaveCount(0);
  await expect(page.locator('li[data-handle="h2"] .message-bubble')).toContainText("On the pier.");

  // FORK: one press, and its name carries both facts the player is owed.
  await openOverflow();
  const fork = page.locator('li[data-handle="h2"] [data-testid="message-fork"]');
  await expect(fork, "the fork states the two facts").toHaveAttribute("aria-label", /share her memory/u);
  await fork.click();
  expect(await page.evaluate(() => window.chatProbe.forkCalls()), "and one press is the branch").toEqual(["h2"]);

  // DELETE: its own arm, on its own row.
  await openOverflow();
  await page.locator('li[data-handle="h2"] [data-testid="message-delete"]').click();
  const remove = page.locator('[data-testid="message-delete-confirm"]');
  await expect(remove, "the delete asks before it removes").toHaveCount(1);
  await expect(remove, "and says it cannot be undone").toContainText("cannot be undone");
  await page.locator('[data-testid="message-delete-confirm-no"]').click();
  await expect(remove).toHaveCount(0);
});
