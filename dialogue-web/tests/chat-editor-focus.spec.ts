import { expect, test, type Page } from "./frontend-coverage";

/**
 * Cancelling an edit gives the keyboard back to the control that opened it.
 *
 * The editor is not a field that appears beside the row's controls: it REPLACES them (the in-place
 * ruling), so the Edit button is unmounted by the very press that opens the field. Two focus moves
 * have to be made by hand, and only one of them is obvious:
 *
 *  1. opening: the field takes the focus. Without it the caret is on `<body>` - the press unmounted
 *     the button under the finger - and a keyboard player has to travel the whole page back to the
 *     words they meant to rewrite.
 *  2. cancelling: the focus goes back to that same Edit button. Cancel is pressed FROM the field,
 *     which the same state change unmounts, so this is the half that is easy to forget and it drops
 *     the player on `<body>` a second time.
 *
 * Read from `document.activeElement`, never from a flag: what matters is where the browser put the
 * caret. Both rows are asserted - the player's own message and her reply share one editor, and a
 * keyboard path that works on one side of the exchange only is the defect this measures.
 */

const CONVERSATION = [
  { role: "companion" as const, text: "An opening greet." },
  { role: "player" as const, text: "Where are we?" },
  { role: "companion" as const, text: "On the pier." },
];

type EditorFocusProbe = {
  setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void;
  focusedControl(): { tag: string; testId: string | null; handle: string | null };
};

declare global {
  interface Window {
    chatProbe: EditorFocusProbe;
  }
}

async function openConversation(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  await page.evaluate((entries) => window.chatProbe.setConversation(entries), CONVERSATION);
}

test("Enter on Edit puts the caret in the field, and Escape gives it back to Edit", async ({ page }) => {
  await openConversation(page);

  // The player's own row, opened and cancelled with the keyboard alone.
  const edit = page.locator('li[data-handle="h1"] [data-testid="message-edit"]');
  await edit.focus();
  await page.keyboard.press("Enter");

  const field = page.locator('li[data-handle="h1"] [data-testid="message-edit-field"]');
  await expect(field).toBeFocused();
  expect(await page.evaluate(() => window.chatProbe.focusedControl())).toEqual({
    tag: "textarea",
    testId: "message-edit-field",
    handle: "h1",
  });

  // Escape closes the field exactly as Cancel does, and it is pressed from INSIDE the field - the
  // case where a lost focus is guaranteed unless the surface moves it back by hand.
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(edit).toBeFocused();
  expect(await page.evaluate(() => window.chatProbe.focusedControl())).toEqual({
    tag: "button",
    testId: "message-edit",
    handle: "h1",
  });
});

test("Cancel is pressed with the keyboard too, and it lands the focus on Edit again", async ({ page }) => {
  await openConversation(page);

  // Her reply's row: the same editor, the other side of the exchange.
  const edit = page.locator('li[data-handle="h2"] [data-testid="message-edit"]');
  await edit.focus();
  await page.keyboard.press("Enter");
  const field = page.locator('li[data-handle="h2"] [data-testid="message-edit-field"]');
  await expect(field).toBeFocused();

  // The field is typed in first: the editor's own auto-focus must survive the state change the
  // player's typing causes, or the caret is taken away by the first keystroke.
  await page.keyboard.type(" at dusk");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("On the pier. at dusk");

  // The answer is activated the way a keyboard user activates it: focus it, press Enter. (Save is
  // enabled at this point - the words differ from the row's - so it, not Cancel, is what Tab reaches
  // first; the reading here is about Cancel, so the answer is named rather than tabbed to.)
  const cancel = page.locator('li[data-handle="h2"] [data-testid="message-edit-cancel"]');
  await cancel.focus();
  await page.keyboard.press("Enter");

  await expect(field).toHaveCount(0);
  await expect(edit).toBeFocused();
  expect(await page.evaluate(() => window.chatProbe.focusedControl())).toEqual({
    tag: "button",
    testId: "message-edit",
    handle: "h2",
  });
  // Cancelling discards the rewrite: the row's words are its own again.
  await expect(page.locator('li[data-handle="h2"] .message-bubble')).toContainText("On the pier.");
});
