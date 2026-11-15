import { expect, test, type Page } from "./frontend-coverage";

/**
 * The row's edit icon is a real control, the focus never lands on prose, and it comes back to the icon.
 *
 * The owner's decision of 2026-11-16 made an edit explicit: one `<button>` per editable row, at the row's
 * top-right, above the bubble. It replaced the same day's "pressing the words IS the edit", which cost the
 * place a reader came to - a plain press on a formatted reply swapped it for a field, so selecting a
 * sentence, copying a paragraph or reading one all passed through an editor.
 *
 *  1. THE PLATE IS A REAL CONTROL. One `<button>` per editable message, named by `editHint` - so the
 *     reader hears what the press will do instead of meeting a paragraph that has to describe itself -
 *     in the tab order, declaring F2, a 44 px target, and PERCEIVABLE while it holds the focus. It is
 *     revealed on hover and on `:focus-visible`; a control that is in the tab order and paints nothing
 *     while focused would be the trap this shape trades against, so both halves are read here.
 *  2. THE BODY IS PROSE. It carries no role, no tab stop and no keyboard claim - and no press either: what
 *     the pointer does over a message is select, so the edit is the icon. It must stay that way: the day a
 *     role lands on it, every reply in the transcript is announced as a button named after six lines of
 *     dialogue, and the day a press lands on it, the words stop being freely selectable.
 *  3. ONE STOP PER MESSAGE. Six messages, six edit stops, each named, no duplicates, and no prose stop
 *     anywhere - walked with real Tab presses, because "there is exactly one" is a claim about the tab
 *     ORDER and not about a count in the markup.
 *  4. THE FOCUS COMES BACK TO THE PLATE. Cancel and Escape are pressed FROM the field, which the same
 *     state change unmounts, so this is the half that is easy to forget - and returning it to the body
 *     instead would drop it on `<body>`, because the body is not a tab stop.
 *
 * Read from `document.activeElement`, never from a flag: what matters is where the browser put the caret.
 * Both sides of the exchange are read, because a keyboard path that works on one side only is the defect
 * this measures.
 */

const CONVERSATION = [
  { role: "companion" as const, text: "An opening greet." },
  { role: "player" as const, text: "Where are we?" },
  { role: "companion" as const, text: "On the pier." },
];

/** Six rows for the tab walk: every row of the exchange is editable, so every row carries one stop. */
const SIX = [
  { role: "companion" as const, text: "An opening greet." },
  { role: "player" as const, text: "Where are we?" },
  { role: "companion" as const, text: "On the pier." },
  { role: "player" as const, text: "And now?" },
  { role: "companion" as const, text: "Still on the pier." },
  { role: "player" as const, text: "Then where?" },
];

/** The sentence the plate is named by, in the interface's own words. */
const EDIT_HINT = "Edit this message's words.";

type EditorFocusProbe = {
  setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void;
  focusedControl(): {
    tag: string;
    testId: string | null;
    control: string;
    handle: string | null;
    revealer: boolean;
    prose: boolean;
  };
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
  } | null;
  editStops(): readonly { handle: string | null; name: string | null; tag: string; proseStop: boolean }[];
};

declare global {
  interface Window {
    chatProbe: EditorFocusProbe;
  }
}

async function openConversation(
  page: Page,
  entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[] = CONVERSATION,
): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  await page.evaluate((rows) => window.chatProbe.setConversation(rows), entries);
}

test("the plate is the keyboard's way in, and the body it sits on stays prose", async ({ page }) => {
  await openConversation(page);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 400, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    const where = `${viewport.width}x${viewport.height}`;
    const affordance = await page.evaluate(() => window.chatProbe.editAffordance("h1"));
    expect(affordance, `${where}: the player's own row is one the player may rewrite`).not.toBeNull();

    // ONE. The plate is a control, and it says what it does. Its name is the edit sentence and not the
    // message's own words - the whole reason the body could not be the control.
    expect(affordance!.isButton, `${where}: the keyboard's way in is a real button`).toBe(true);
    expect(affordance!.inStrip, `${where}: and it is not another strip target`).toBe(false);
    expect(affordance!.tabStop, `${where}: it is in the tab order`).toBe(true);
    expect(affordance!.name, `${where}: named by the sentence that says what pressing it does`).toBe(EDIT_HINT);
    expect(affordance!.keyShortcuts, `${where}: declaring the shortcut a screen reader can announce`).toBe("F2");
    expect(affordance!.width, `${where}: a 44 px hit area`).toBeGreaterThanOrEqual(44);
    expect(affordance!.height, `${where}: in both directions`).toBeGreaterThanOrEqual(44);
    // It is revealed by focus and not only by hover: unfocused it is transparent, and the box above is
    // what Playwright and the pointer can still find, so its absence from the screen is a paint fact
    // rather than a hover-only trap.
    expect(affordance!.opacity, `${where}: nothing is painted until it is hovered or focused`).toBe(0);

    // TWO. The prose under it is prose: no role, no tab stop, no keyboard claim, and no second press
    // path for the keyboard. A `role="button"` here is the noise this shape removed.
    expect(affordance!.prose.role, `${where}: the reply is not announced as a control`).toBeNull();
    expect(affordance!.prose.tabStop, `${where}: and the body is not a stop of its own`).toBe(false);
    expect(affordance!.prose.keyShortcuts, `${where}: nor does it claim a shortcut`).toBeNull();
    expect(affordance!.bubbleWidth, `${where}: the body is still the message's own box`).toBeGreaterThan(0);
  }

  // Focusing the plate reveals it, and Enter opens the field: the focus is what makes it perceivable.
  const plate = page.locator('li[data-handle="h1"] .message-edit-hint');
  await plate.focus();
  expect(await page.evaluate(() => window.chatProbe.editAffordance("h1")?.opacity), "focus paints it").toBe(1);
  await page.keyboard.press("Enter");

  const field = page.locator('li[data-handle="h1"] [data-testid="message-edit-field"]');
  await expect(field).toBeFocused();
  expect(await page.evaluate(() => window.chatProbe.focusedControl())).toEqual({
    tag: "textarea",
    testId: "message-edit-field",
    control: "message-edit-field",
    handle: "h1",
    revealer: false,
    prose: false,
  });

  // FOUR. Escape closes the field from INSIDE it, and the focus goes back to the plate - the one stop in
  // the row that opens an editor. The body would drop it on `<body>`.
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(plate).toBeFocused();
  expect(await page.evaluate(() => window.chatProbe.focusedControl())).toEqual({
    tag: "button",
    testId: "message-edit",
    control: "message-edit",
    handle: "h1",
    revealer: true,
    prose: false,
  });
  // Escape wrote nothing: the row's own words are back.
  await expect(page.locator('li[data-handle="h1"] .message-bubble')).toContainText("Where are we?");
});

test("F2 opens it too, Cancel is pressed with the keyboard, and both land the focus on the plate", async ({
  page,
}) => {
  await openConversation(page);

  // Her reply's row: the same two halves, the other side of the exchange.
  const plate = page.locator('li[data-handle="h2"] .message-edit-hint');
  await plate.focus();
  await page.keyboard.press("F2");
  const field = page.locator('li[data-handle="h2"] [data-testid="message-edit-field"]');
  await expect(field).toBeFocused();

  // The field is typed in first: the editor's own auto-focus must survive the state change the player's
  // typing causes, or the caret is taken away by the first keystroke.
  await page.keyboard.type(" at dusk");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("On the pier. at dusk");

  // The answer is activated the way a keyboard user activates it: focus it, press Enter.
  const cancel = page.locator('li[data-handle="h2"] [data-testid="message-edit-cancel"]');
  await cancel.focus();
  await page.keyboard.press("Enter");

  await expect(field).toHaveCount(0);
  await expect(plate).toBeFocused();
  expect(await page.evaluate(() => window.chatProbe.focusedControl())).toEqual({
    tag: "button",
    testId: "message-edit",
    control: "message-edit",
    handle: "h2",
    revealer: true,
    prose: false,
  });
  // Cancelling discards the rewrite: the row's words are its own again.
  await expect(page.locator('li[data-handle="h2"] .message-bubble')).toContainText("On the pier.");
});

test("a six-message transcript has one edit stop per message, and no stop in the prose", async ({ page }) => {
  await openConversation(page, SIX);

  // THREE. The declaration first: one plate per row, in the order the rows draw it, none of them on a
  // prose stop.
  const stops = await page.evaluate(() => window.chatProbe.editStops());
  expect(stops.map((stop) => stop.handle), "one edit stop per message, in row order").toEqual([
    "h0",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
  ]);
  expect(stops.map((stop) => stop.tag), "and each of them is a real button").toEqual([
    "button",
    "button",
    "button",
    "button",
    "button",
    "button",
  ]);
  expect(stops.every((stop) => stop.name === EDIT_HINT), "each names the edit sentence and nothing else").toBe(true);
  expect(stops.some((stop) => stop.proseStop), "and no row's prose is a stop of its own").toBe(false);

  // And the ORDER as the keyboard really meets it: Tab from the top of the surface, with every stop it
  // lands on recorded. Six messages can carry a lot of strip controls, hence the generous ceiling - the
  // walk stops as soon as all six plates have been reached.
  await page.evaluate(() => document.body.focus());
  const walked: { handle: string | null; revealer: boolean; prose: boolean }[] = [];
  for (let step = 0; step < 160; step += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => window.chatProbe.focusedControl());
    walked.push({ handle: focused.handle, revealer: focused.revealer, prose: focused.prose });
    if (walked.filter((stop) => stop.revealer).length === 6) break;
  }
  const editStopsWalked = walked.filter((stop) => stop.revealer).map((stop) => stop.handle);
  expect(editStopsWalked, "the walk meets each message's plate exactly once").toEqual([
    "h0",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
  ]);
  expect(walked.some((stop) => stop.prose), "and it never lands on a message body").toBe(false);
});
