/**
 * A saved conversation's title reads on two lines, and its row grows to hold them.
 *
 * THE DEFECT (audit item 1). A row's title was drawn as a one-line block: the card kept the
 * whole width of its measure and the name took one line of it, so at 1440x900 the name of a
 * conversation ended hundreds of pixels before the card did while the rest of the card stayed
 * empty, and at 400x800 a name that is a sentence survived as its first few characters and an
 * ellipsis. The row's own secondary line (`.chat-item-meta`) already spends two lines on the
 * message preview, so the name - the one fact the row exists to state - was the shortest line
 * in the card.
 *
 * WHAT IS ASSERTED, per cell of `LAYOUT_PAIR`:
 *
 *   1. the title's clamp is a DECLARED two lines, read back from the engine rather than from
 *      the stylesheet, so a rule that stops applying is a failure and not a silent one-line row;
 *   2. two lines are drawn, and both of them are inside the row: the title's own box is two
 *      line boxes tall, its second line ends above the row's meta line, and the card is tall
 *      enough to hold them. A clamp over a fixed height would show the ellipsis with the second
 *      line cut in half, which is worse than one line and passes a clamp-only assertion.
 */
import { type Page, expect, test } from "./frontend-coverage";
import { jsonOk, root, token } from "./composed-reference-game-fixtures";
import { LAYOUT_PAIR } from "./viewport-policy";

/**
 * A name a player really writes: one sentence, no long word to hide behind `overflow-wrap`.
 *
 * The reading is about how many LINES the row gives the name, so the fixture must not be a
 * single 60-character token: that would wrap by character and read as two lines at any width.
 */
const LONG_TITLE = "The evening I finally found the last of the parsnip seeds";

const chatHandle = `${"B".repeat(42)}A`;

const entry = {
  handle: chatHandle,
  title: LONG_TITLE,
  status: "active",
  managementRevision: 1,
  isSelected: true,
  updatedAtMs: 1_760_000_000_000,
  preview: "The parsnips took. All of them, by the look of it.",
};

async function stub(page: Page): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  await page.route("**/api/tavern/v1/chats?*", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, chats: [entry] })),
  );
}

/**
 * The row's title, measured where the player reads it.
 *
 * `lines` is the box's height over its line height rather than a count of DOM nodes: the title is
 * one text node either way, and what the defect changed is how many line boxes the card gave it.
 */
async function readTitleRow(page: Page) {
  return await page.evaluate(() => {
    const title = document.querySelector<HTMLElement>('[data-testid="chat-select"]');
    if (title === null) return null;
    const style = getComputedStyle(title);
    const rect = title.getBoundingClientRect();
    // The line boxes the browser actually laid the name out in. `getComputedStyle().lineHeight`
    // is `normal` for this row, so a height divided by a line height would be an assumption
    // about the font; a Range over the text node reports one rect per line box it drew.
    const range = document.createRange();
    range.selectNodeContents(title);
    const lineBoxes = [...range.getClientRects()].filter((box) => box.width > 0 && box.height > 0);
    const card = title.closest<HTMLElement>('[data-testid="chat-item"]');
    const meta = card?.querySelector<HTMLElement>('[data-testid="chat-item-meta"]') ?? null;
    return {
      clamp: style.getPropertyValue("-webkit-line-clamp").trim(),
      display: style.display,
      titleHeight: Math.round(rect.height),
      titleWidth: Math.round(rect.width),
      titleBottom: Math.round(rect.bottom),
      lines: lineBoxes.length,
      lastLineWidth: Math.round(lineBoxes.at(-1)?.width ?? 0),
      cardHeight: Math.round(card?.getBoundingClientRect().height ?? 0),
      cardWidth: Math.round(card?.getBoundingClientRect().width ?? 0),
      metaTop: meta === null ? null : Math.round(meta.getBoundingClientRect().top),
    };
  });
}

for (const cell of LAYOUT_PAIR) {
  test(`a saved conversation's name reads on two lines of its row (${cell.name})`, async ({ page }) => {
    await page.setViewportSize(cell);
    await stub(page);
    await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=chats`);
    const chats = page.getByTestId("chats-surface");
    await expect(chats).toBeVisible();
    await expect(chats.getByTestId("chat-item")).toHaveCount(1);

    const reading = await readTitleRow(page);
    expect(reading, "the row's own select control is the title").not.toBeNull();
    if (reading === null) return;
    console.log(`[title-row ${cell.name}] ${JSON.stringify(reading)}`);

    expect(reading.clamp, "the title's clamp is a declared two lines").toBe("2");
    expect(reading.lines, "the card draws two lines of the name, not one").toBe(2);
    // Both lines are inside the row: the second line's baseline box ends above the meta line, so
    // the height the clamp asks for is height the card actually gives it.
    expect(reading.metaTop, "the row's meta line follows the title").not.toBeNull();
    expect(
      reading.titleBottom,
      `the two-line title ends above the row's meta line (title bottom ${reading.titleBottom}, meta top ${reading.metaTop})`,
    ).toBeLessThanOrEqual(reading.metaTop ?? 0);
    expect(
      reading.cardHeight,
      `the card is tall enough for its two-line title (card ${reading.cardHeight}, title ${reading.titleHeight})`,
    ).toBeGreaterThan(reading.titleHeight);
  });
}
