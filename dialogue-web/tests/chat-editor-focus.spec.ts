import { expect, test, type Page } from "./frontend-coverage";

/**
 * The message body is the edit affordance, and the keyboard can use it.
 *
 * The owner's ruling of 2026-11-16 is that a message needs no Edit button: pressing the words is what asks
 * to rewrite them. That makes the body the only way in, so a pointer-only body would be an accessibility
 * regression - and this file is the hand on the keyboard. Two things have to hold, and only one of them is
 * obvious:
 *
 *  1. opening: the body is a real tab stop and Enter (or F2) opens the field, which takes the focus. Without
 *     it a keyboard player has no way to rewrite anything at all.
 *  2. closing: the focus goes back to that same body. Cancel is pressed FROM the field, which the same state
 *     change unmounts, so this is the half that is easy to forget and it drops the player on `<body>`.
 *
 * The body is read as what it is - a `<div>`, not a `<button>`: it is prose, and a widget role on a paragraph
 * would announce a control that does not exist while getting in the way of reading it. What names the
 * interaction instead is the description the body points at (`editHint`), and that is asserted here too.
 *
 * Read from `document.activeElement`, never from a flag: what matters is where the browser put the caret.
 * Both rows are asserted - the player's own message and her reply share one affordance and one editor, and a
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
  editAffordance(handle: string): { tag: string; isButton: boolean; tabStop: boolean; keyShortcuts: string | null; describedByText: string | null } | null;
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

test("Enter on the message body puts the caret in the field, and Escape gives it back to the body", async ({ page }) => {
  await openConversation(page);

  // The body is a tab stop that is not a button, and it says what pressing it does.
  const affordance = await page.evaluate(() => window.chatProbe.editAffordance("h1"));
  expect(affordance, "the player's own row is one the player may rewrite").not.toBeNull();
  expect(affordance!.isButton, "the body is prose, not a button").toBe(false);
  expect(affordance!.tabStop, "and it is a real tab stop, so the keyboard can reach it").toBe(true);
  expect(affordance!.keyShortcuts, "it declares the shortcut a screen reader can announce").toBe("F2");
  expect(affordance!.describedByText, "and it names the sentence that says the words can be rewritten").toContain("edit");

  // The player's own row, opened and cancelled with the keyboard alone.
  const body = page.locator('li[data-handle="h1"] [data-testid="message-edit"]');
  await body.focus();
  await page.keyboard.press("Enter");

  const field = page.locator('li[data-handle="h1"] [data-testid="message-edit-field"]');
  await expect(field).toBeFocused();
  expect(await page.evaluate(() => window.chatProbe.focusedControl())).toEqual({
    tag: "textarea",
    testId: "message-edit-field",
    handle: "h1",
  });

  // Escape closes the field exactly as Cancel does, and it is pressed from INSIDE the field - the case where
  // a lost focus is guaranteed unless the surface moves it back by hand.
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(body).toBeFocused();
  expect(await page.evaluate(() => window.chatProbe.focusedControl())).toEqual({
    tag: "div",
    testId: "message-edit",
    handle: "h1",
  });
  // Escape wrote nothing: the row's own words are back.
  await expect(page.locator('li[data-handle="h1"] .message-bubble')).toContainText("Where are we?");
});

test("F2 opens it too, Cancel is pressed with the keyboard, and both land the focus on the body again", async ({
  page,
}) => {
  await openConversation(page);

  // Her reply's row: the same affordance, the other side of the exchange.
  const body = page.locator('li[data-handle="h2"] [data-testid="message-edit"]');
  await body.focus();
  await page.keyboard.press("F2");
  const field = page.locator('li[data-handle="h2"] [data-testid="message-edit-field"]');
  await expect(field).toBeFocused();

  // The field is typed in first: the editor's own auto-focus must survive the state change the player's
  // typing causes, or the caret is taken away by the first keystroke.
  await page.keyboard.type(" at dusk");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("On the pier. at dusk");

  // The answer is activated the way a keyboard user activates it: focus it, press Enter. (Save is enabled at
  // this point - the words differ from the row's - so it, not Cancel, is what Tab reaches first; the reading
  // here is about Cancel, so the answer is named rather than tabbed to.)
  const cancel = page.locator('li[data-handle="h2"] [data-testid="message-edit-cancel"]');
  await cancel.focus();
  await page.keyboard.press("Enter");

  await expect(field).toHaveCount(0);
  await expect(body).toBeFocused();
  expect(await page.evaluate(() => window.chatProbe.focusedControl())).toEqual({
    tag: "div",
    testId: "message-edit",
    handle: "h2",
  });
  // Cancelling discards the rewrite: the row's words are its own again.
  await expect(page.locator('li[data-handle="h2"] .message-bubble')).toContainText("On the pier.");
});
