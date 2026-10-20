import { expect, test, type Page } from "@playwright/test";

/**
 * Editing the player's own message, mounted, with its own measurements.
 *
 * The edit is the one message mutation that is not destructive, so what the surface has to get right
 * is different from the rewind's in three places, and each one is an assertion here:
 *
 * 1. `is one control in the player's own strip, and names what saving does` - the player's row carries
 *    exactly one button, in the same strip the companion's reply uses rather than a second row of
 *    buttons, and its accessible name says what the press does to the conversation: the model reads
 *    the new words from the next turn on. An edit that only changed the bubble would be a lie, and
 *    the name is where the player is told that. Measured from the layout at both widths, not from a
 *    class name: the box is at least the 44 px touch minimum (`--touch-target-min`) and the strip is
 *    still ONE row (`two controls in one strip that wrapped at 400 px` is the defect this measures).
 * 2. `is offered on every row of the exchange, the opening included` - the greeting is edited in place,
 *    for this session alone (the owner's ruling, 2026-10-20, superseding "the greeting is a retained
 *    anchor"), so row zero carries the same control and the same editor; the player's own rows and her
 *    replies each carry exactly one. The premise changed twice under owner rulings - her reply used to
 *    be excluded, and before that the opening - and the force is kept: exactly one edit control per row
 *    of the transcript, never a second resident control beside it.
 * 3. `opens the field the words came from, and sends the pair only on save` - the editor holds the
 *    current text, the two answers are Save and Cancel, nothing is sent by opening or by cancelling,
 *    and the save sends the handle, the text AND the order the page rendered the row at, because the
 *    transcript is what a position means and the Host refuses a row that moved.
 * 4. `stays open until the transcript holds what was sent` - the words the player rewrote are theirs
 *    until the Host says otherwise: on a refusal the field keeps them, and it closes only when the row
 *    the reread returned carries exactly what was saved.
 * 5. `the bubble gives way to the editor in place` - the owner's ruling (audit 2026-10-19): the row used
 *    to keep rendering the bubble AND open the field under it, so the same words stood on screen twice
 *    and the row grew to the bubble plus a two-row editor. The bubble is not rendered while the editor
 *    is open, the editor's field starts at the top of the box the bubble had, and Cancel or Escape
 *    brings the bubble back at that same box. The copies that are really painted are counted, so
 *    "once" is a number rather than a claim.
 * 6. `the field grows with the words in it, and Ctrl+Enter saves` - `rows={2}` pinned the field at 62 px
 *    for any length, so a 300-character reply was read through a keyhole. The field is now as tall as
 *    its own text between the two-row floor and a 300 px ceiling, past which it scrolls internally
 *    rather than growing the row without limit; a bare Enter still inserts the newline it always did,
 *    Escape still cancels (the row's own document listener, above), and Ctrl+Enter is the save. The
 *    row's closed geometry - the bubble's box and the strip's 44 px row - is measured on both sides of
 *    the editor, because a field that grew the row would be the same defect from the other end.
 */

const CONVERSATION = [
  { role: "companion" as const, text: "An opening greet." },
  { role: "player" as const, text: "Where are we?" },
  { role: "companion" as const, text: "On the pier." },
  { role: "player" as const, text: "And now?" },
  { role: "companion" as const, text: "Still on the pier." },
];

type EditProbe = {
  editControl(handle: string): {
    ariaLabel: string | null;
    title: string | null;
    label: string | null;
    width: number;
    height: number;
    stripHeight: number;
  } | null;
  editForm(handle: string): { value: string | null; save: string | null; cancel: string | null } | null;
  editInPlace(
    handle: string,
    text: string,
  ): {
    row: { top: number; bottom: number; height: number };
    bubble: { top: number; bottom: number; height: number } | null;
    field: { top: number; bottom: number; height: number } | null;
    textNodes: number;
    carriers: readonly string[];
    copies: number;
  } | null;
  editCalls(): readonly { handle: string; order: number; text: string }[];
  resetEditCalls(): void;
  applyEditedText(handle: string, text: string): void;
  setPending(pending: { kind: "swipe" | "regenerate" | "opening" | "rewind" | "edit"; handle: string } | null): void;
};

declare global {
  interface Window {
    chatProbe: EditProbe & {
      setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void;
    };
  }
}

async function openConversation(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  await page.evaluate((entries) => window.chatProbe.setConversation(entries), CONVERSATION);
}

/** The touch minimum the rest of the strip uses, plus the sub-pixel the measured box may round to. */
const TOUCH_MINIMUM = 44;
const ONE_ROW = TOUCH_MINIMUM + 1;

/** The editor's ceiling, the number `MessageEditor` clamps the field's height to. */
const EDIT_FIELD_MAX_HEIGHT = 300;

test("the edit control is one control in the player's strip, names what saving does, and is the touch minimum", async ({
  page,
}) => {
  await openConversation(page);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 400, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    const control = await page.evaluate(() => window.chatProbe.editControl("h1"));
    const where = `${viewport.width}x${viewport.height}`;
    expect(control, where).not.toBeNull();
    expect(control?.label?.trim(), where).toBe("Edit");
    expect(control?.ariaLabel, where).toContain("Edit this message");
    // The name states the consequence: the model reads the new words from the next turn on.
    expect(control?.ariaLabel, where).toContain("the model reads your new words from the next turn on");
    expect(control?.title, where).toBe(control?.ariaLabel);
    // Measured from the layout: the whole target, not a class name.
    expect(control?.width, where).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
    expect(control?.height, where).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
    // The strip is the same row the reply uses, and one control of the touch minimum is one row: a
    // strip that wrapped to two would be at least 44 + 6 + 44 tall.
    expect(control?.stripHeight, where).toBeLessThanOrEqual(ONE_ROW);
  }
});

test("the edit is offered on every row of the exchange, the opening included", async ({ page }) => {
  await openConversation(page);

  // The greeting is edited where it is read: the same in-place editor, for this session alone.
  expect(await page.evaluate(() => window.chatProbe.editControl("h0"))).not.toBeNull();
  expect(await page.evaluate(() => window.chatProbe.editControl("h2"))).not.toBeNull();
  expect(await page.evaluate(() => window.chatProbe.editControl("h4"))).not.toBeNull();
  // The player's own rows each carry exactly one.
  expect(await page.evaluate(() => window.chatProbe.editControl("h1"))).not.toBeNull();
  expect(await page.evaluate(() => window.chatProbe.editControl("h3"))).not.toBeNull();
  // And exactly one apiece: a second resident edit control is the defect.
  for (const handle of ["h0", "h1", "h2", "h3", "h4"])
    await expect(page.locator(`[data-handle="${handle}"] [data-testid="message-edit"]`)).toHaveCount(1);

  // Opened, the field replaces that one control rather than sitting beside it.
  await page.click('[data-handle="h1"] [data-testid="message-edit"]');
  expect(await page.evaluate(() => window.chatProbe.editControl("h1"))).toBeNull();
  const buttons = await page.locator('[data-handle="h1"] .message-actions button').allTextContents();
  expect(buttons.map((label) => label.trim())).toEqual(["Save", "Cancel"]);
});

test("opening the editor gives the words the player wrote, and nothing is sent until save", async ({ page }) => {
  await openConversation(page);
  await page.evaluate(() => window.chatProbe.resetEditCalls());

  await page.click('[data-handle="h1"] [data-testid="message-edit"]');
  const opened = await page.evaluate(() => window.chatProbe.editForm("h1"));
  expect(opened).not.toBeNull();
  expect(opened?.value).toBe("Where are we?");
  expect(opened?.save?.trim()).toBe("Save");
  expect(opened?.cancel?.trim()).toBe("Cancel");
  // Opening is not a command: the Host hears nothing until Save.
  expect(await page.evaluate(() => window.chatProbe.editCalls())).toEqual([]);

  // Cancelling closes the field and sends nothing either.
  await page.click('[data-testid="message-edit-cancel"]');
  expect(await page.evaluate(() => window.chatProbe.editForm("h1"))).toBeNull();
  expect(await page.evaluate(() => window.chatProbe.editControl("h1"))).not.toBeNull();
  expect(await page.evaluate(() => window.chatProbe.editCalls())).toEqual([]);
});

test("the bubble gives way to the editor in place, and Escape restores it at the same box", async ({ page }) => {
  await openConversation(page);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 400, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    const where = `${viewport.width}x${viewport.height}`;

    // Both sides of the exchange share the one editor, so both are measured: the player's own row
    // and her reply.
    for (const target of [
      { handle: "h1", text: "Where are we?" },
      { handle: "h2", text: "On the pier." },
    ]) {
      const copies = () =>
        page.evaluate((ask) => window.chatProbe.editInPlace(ask.handle, ask.text), target);

      const closed = await copies();
      expect(closed, where).not.toBeNull();
      // Closed: the words are on screen once, in the bubble.
      expect(closed?.copies, where).toBe(1);
      expect(closed?.field, where).toBeNull();

      await page.click(`[data-handle="${target.handle}"] [data-testid="message-edit"]`);
      const open = await copies();
      console.log(
        `MEASURE in-place ${where} ${target.handle}: row ${closed?.row.height} -> ${open?.row.height} | ` +
          `bubble ${JSON.stringify(closed?.bubble)} -> ${JSON.stringify(open?.bubble)} | ` +
          `field ${JSON.stringify(open?.field)} | copies ${open?.copies} (text nodes ${open?.textNodes}, carriers ${JSON.stringify(open?.carriers)})`,
      );
      // The bubble is GONE rather than repeated, so the words stand on screen once - in the field,
      // which is the one place they can be read while the row is being rewritten.
      expect(open?.bubble, where).toBeNull();
      expect(open?.textNodes, where).toBe(0);
      expect(open?.copies, where).toBe(1);
      expect(open?.field?.height, where).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
      // The editor takes the bubble's own place in the flow: the field starts at the top of the box
      // the bubble had, instead of stacking under it and growing the row by both heights.
      expect(open?.field?.top, where).toBe(closed?.bubble?.top);

      // Escape is the other way out, and it is lossless: the bubble comes back at the box it had.
      await page.keyboard.press("Escape");
      const restored = await copies();
      expect(restored?.field, where).toBeNull();
      expect(restored?.copies, where).toBe(1);
      expect(restored?.bubble, where).toEqual(closed?.bubble);
      expect(restored?.row.height, where).toBe(closed?.row.height);
    }
  }
});

test("the save sends the words and the position the page rendered, and closes on the transcript that holds them", async ({
  page,
}) => {
  await openConversation(page);
  await page.evaluate(() => window.chatProbe.resetEditCalls());

  await page.click('[data-handle="h3"] [data-testid="message-edit"]');
  await page.fill('[data-testid="message-edit-field"]', "And then?");
  await page.click('[data-testid="message-edit-save"]');

  // The pair the Host checks: the handle, the words, and the order this page rendered the row at.
  expect(await page.evaluate(() => window.chatProbe.editCalls())).toEqual([
    { handle: "h3", order: 3, text: "And then?" },
  ]);
  // The save is in flight, so the surface says so and the words stay in the field.
  await page.evaluate(() => window.chatProbe.setPending({ kind: "edit", handle: "h3" }));
  expect(await page.evaluate(() => window.chatProbe.editForm("h3"))).not.toBeNull();

  // A refusal is the other outcome, and it costs the player nothing: the field is still open with the
  // words they typed.
  await page.evaluate(() => window.chatProbe.setPending(null));
  const refused = await page.evaluate(() => window.chatProbe.editForm("h3"));
  expect(refused?.value).toBe("And then?");

  // The authoritative reread is what closes it: the row now carries exactly what was saved. The
  // field's own absence is asserted through a retrying locator, because the close is the row's own
  // effect after the reread renders - not a synchronous rewrite of the DOM.
  await page.evaluate(() => window.chatProbe.applyEditedText("h3", "And then?"));
  await expect(page.locator('[data-handle="h3"] [data-testid="message-edit-form"]')).toHaveCount(0);
  await expect(page.locator('[data-handle="h3"] .message-bubble')).toContainText("And then?");
  // And the one control is back in its place.
  await expect(page.locator('[data-handle="h3"] [data-testid="message-edit"]')).toHaveCount(1);
});

test("the field grows with the words in it, caps, scrolls inside, and Ctrl+Enter saves while Enter does not", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openConversation(page);
  await page.evaluate(() => window.chatProbe.resetEditCalls());

  const field = page.locator('[data-testid="message-edit-field"]');
  const fieldBox = () =>
    field.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return {
        height: Math.round(box.height),
        top: Math.round(box.top),
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        overflowY: getComputedStyle(node).overflowY,
      };
    });
  /** The row's own closed geometry: the bubble's box and the strip under it. */
  const rowGeometry = (handle: string) =>
    page.evaluate((target) => {
      const row = document.querySelector<HTMLElement>(`[data-handle="${target}"]`)!;
      const bubble = row.querySelector<HTMLElement>(".message-bubble");
      const strip = row.querySelector<HTMLElement>(".message-actions");
      const box = (node: Element | null) => {
        if (node === null) return null;
        const rect = node.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top) };
      };
      return { bubble: box(bubble), strip: box(strip) };
    }, handle);

  const closed = await rowGeometry("h1");
  // Her reply is the row the capture read: a 422 x 46 bubble and one 44 px strip. The editor lives on
  // the player's row here, so this one is only measured - a field that changed the strip's or the
  // bubble's box would be the same defect from the other end.
  const reply = await rowGeometry("h2");
  await page.click('[data-handle="h1"] [data-testid="message-edit"]');

  // A short reply opens at the two-row floor, which is the height the fixed field had: the bubble and
  // the strip around it keep the geometry they had.
  const short = await fieldBox();
  const longText = "她说了很多话。".repeat(17);
  await field.fill(longText);
  const long = await fieldBox();
  const cappedText = "她说了很多话。".repeat(300);
  await field.fill(cappedText);
  const capped = await fieldBox();
  console.log(
    `MEASURE edit-field 1440x900: short ${short.height} | long(${longText.length}) ${long.height} | capped ${capped.height} ` +
      `(scrollHeight ${capped.scrollHeight}, clientHeight ${capped.clientHeight}, overflow-y ${capped.overflowY}) | ` +
      `player row ${JSON.stringify(closed)} | her reply ${JSON.stringify(reply)}`,
  );

  // The keyhole is what this test is about: 300 characters must not read the same as two words.
  expect(long.height, "300 characters grow the field past its floor").toBeGreaterThan(short.height);
  expect(short.height, "and a short reply still opens the two-row field it always did").toBeGreaterThanOrEqual(
    TOUCH_MINIMUM,
  );
  expect(short.height, "exactly the two-row box, not a taller one").toBeLessThanOrEqual(ONE_ROW + 20);
  // The ceiling is a height, not a scrollbar-less field: at it the field stops growing and scrolls inside.
  expect(capped.height, "the field stops at its 300 px ceiling").toBe(EDIT_FIELD_MAX_HEIGHT);
  expect(capped.height, "which is taller than the 300-character reply asked for").toBeGreaterThan(long.height);
  expect(capped.scrollHeight, "and the rest of the text is reachable by scrolling the field itself").toBeGreaterThan(
    capped.clientHeight,
  );
  expect(capped.overflowY, "so the field's own scrollbar is the one that moves").toBe("auto");
  expect(long.overflowY, "while a reply under the ceiling has no internal scrollbar").toBe("hidden");

  // A bare Enter is the field's own key: it inserts the newline and sends nothing.
  await field.fill("Where are we?");
  await page.keyboard.press("Enter");
  expect(await field.inputValue(), "Enter inserted the newline the player typed").toBe("Where are we?\n");
  expect(await page.evaluate(() => window.chatProbe.editCalls()), "and nothing was sent").toEqual([]);

  // Ctrl+Enter is the save, and it sends the same pair the Save button sends.
  await page.keyboard.press("Control+Enter");
  expect(await page.evaluate(() => window.chatProbe.editCalls())).toEqual([
    { handle: "h1", order: 1, text: "Where are we?\n" },
  ]);

  // And the row is exactly where it was: Escape brings the bubble back in the box it had, and the
  // strip still one 44 px row.
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="message-edit-form"]')).toHaveCount(0);
  const reopened = await rowGeometry("h1");
  expect(reopened.bubble, "the bubble comes back in its own box").toEqual(closed.bubble);
  expect(reopened.strip, "and the strip is one row, unchanged").toEqual(closed.strip);
  expect(reopened.strip?.height, "the measured 44 px strip the capture read").toBe(TOUCH_MINIMUM);
  expect(await rowGeometry("h2"), "and her reply's own row never moved").toEqual(reply);
});
