import { expect, test } from "./frontend-coverage";
import { openCompanionWorldBookEditor, stubCompanionWorldBookSurface } from "./companion-world-book-authoring-surface";

/**
 * Fifteen entries are fifteen lines, not a wall of inputs.
 *
 * The defect: every field of every entry was laid out flat, so a book of fifteen entries drew a
 * 9374 px editor inside a 10882 px scroller at 1440x900 - 105 form controls, none of them folded, and
 * the row the player wanted somewhere in the middle of it.
 *
 * The fix is a fold per entry: the summary line is the entry's title and the words that reach it, and
 * the fields are behind it. Every row starts shut, so the editor is a list a player can scan; the row
 * she opens is the row she is editing. Measured after: the same fifteen entries are a 1379 px editor
 * inside a 2887 px scroller, and all 105 controls are still in the document - folded, not dropped.
 *
 * The stated ceiling below is 1600 px for the editor and 3200 px for the surface's scroller. Both are
 * above the measurement and far below the defect, so a regression that unfolded the rows again fails
 * here by thousands of pixels rather than by a hair.
 */
const ENTRY_EDITOR_CEILING = 1600;
const SURFACE_SCROLLER_CEILING = 3200;

const fifteen = Array.from({ length: 15 }, (_, index) => ({
  title: `词条 ${index}`,
  keys: ["料理", "做饭"],
  constant: false,
  enabled: true,
  content: `第 ${index} 条正文。这一条写得长一点，展开之后它自己要有好几行。`,
}));

const book = { apiVersion: 1, present: true, revision: 7, entries: fifteen };

/** The editor's own height, the scroller's, and how much of it is unfolded. */
async function measureEditor(page: import("@playwright/test").Page) {
  return await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>("[data-companion-world-book-draft]")!;
    const scroller = document.querySelector<HTMLElement>(".surface-content")!;
    const rows = [...editor.querySelectorAll<HTMLElement>("[data-companion-world-book-entry-draft]")];
    return {
      editorHeight: Math.round(editor.getBoundingClientRect().height),
      scrollerScrollHeight: Math.round(scroller.scrollHeight),
      rows: rows.length,
      openRows: rows.filter((row) => row.hasAttribute("open")).length,
      controls: editor.querySelectorAll("input, textarea, select").length,
    };
  });
}

test("fifteen entries fold to one line each, and the row under edit is still whole", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubCompanionWorldBookSurface(page, book);
  const { editor } = await openCompanionWorldBookEditor(page);

  const rows = editor.locator("[data-companion-world-book-entry-draft]");
  await expect(rows).toHaveCount(15);
  const shut = await measureEditor(page);
  console.log(`[world-book-folds shut] ${JSON.stringify(shut)}`);
  expect(shut.rows, "fifteen entries are fifteen folds").toBe(15);
  expect(shut.openRows, "every row she is not editing is shut").toBe(0);
  expect(
    shut.editorHeight,
    `fifteen shut entries are ${shut.editorHeight} px, under the ${ENTRY_EDITOR_CEILING} px ceiling`,
  ).toBeLessThan(ENTRY_EDITOR_CEILING);
  expect(
    shut.scrollerScrollHeight,
    `the surface's scroller is ${shut.scrollerScrollHeight} px, under ${SURFACE_SCROLLER_CEILING}`,
  ).toBeLessThan(SURFACE_SCROLLER_CEILING);
  // Nothing was thrown away to get there: the wall was 15 entries x 7 fields, and all of them are
  // still in the document - the fold hides them, the surface does not stop rendering them.
  expect(shut.controls, "every field of every entry is still in the document").toBe(15 * 7);

  // The summary line is what a player scanning her book is reading for: what the entry is called and
  // the words that reach it, on one row of the product's own 44 px target.
  const third = rows.nth(3);
  const summary = third.locator("summary").first();
  await expect(summary).toContainText("词条 3");
  await expect(summary).toContainText("触发词：料理、做饭");
  const summaryBox = await summary.boundingBox();
  expect(summaryBox, "the summary line has a box").not.toBeNull();
  expect(Math.round(summaryBox!.height), `the summary line is ${summaryBox!.height} px tall`).toBeGreaterThanOrEqual(
    44,
  );

  // The row she opens is the row she is editing, and it is whole: seven fields, each with a width of
  // its own, and the row taller than the line it opened from. The two switches are 20 px boxes inside
  // 44 px rows by design (`ui-hygiene-runtime.spec.ts` measures their target), so the width floor here
  // is the text-bearing controls'.
  await summary.click();
  await expect(third).toHaveAttribute("open", "");
  const opened = await third.evaluate((node) => {
    const fields = [...node.querySelectorAll<HTMLElement>("input, textarea, select")];
    const typed = [...node.querySelectorAll<HTMLElement>("input.form-input, textarea, select")];
    return {
      count: fields.length,
      narrowestTyped: Math.min(...typed.map((field) => Math.round(field.getBoundingClientRect().width))),
      height: Math.round(node.getBoundingClientRect().height),
    };
  });
  console.log(`[world-book-folds opened] ${JSON.stringify(opened)}`);
  expect(opened.count, "the row under edit carries all seven of its fields").toBe(7);
  expect(opened.narrowestTyped, "no field of the open row is collapsed to nothing").toBeGreaterThan(40);
  expect(opened.height, "the open row is taller than the line it opened from").toBeGreaterThan(summaryBox!.height);

  // …and the page is still one line per row she has NOT opened.
  const after = await measureEditor(page);
  console.log(`[world-book-folds after one open] ${JSON.stringify(after)}`);
  expect(after.openRows, "opening one row opens exactly one row").toBe(1);
  expect(after.editorHeight, `one open row and fourteen shut ones are ${after.editorHeight} px`).toBeLessThan(
    ENTRY_EDITOR_CEILING + opened.height,
  );
});

test("opening a second row does not shut the first, and a row the player adds arrives open and named", async ({
  page,
}) => {
  await stubCompanionWorldBookSurface(page, book);
  const { editor } = await openCompanionWorldBookEditor(page);
  const rows = editor.locator("[data-companion-world-book-entry-draft]");

  await rows.nth(0).locator("summary").first().click();
  await rows.nth(1).locator("summary").first().click();
  // Two entries can be edited in one sitting: the fold is a fold, not a pager that takes the first
  // row away when the second opens.
  await expect(rows.nth(0)).toHaveAttribute("open", "");
  await expect(rows.nth(1)).toHaveAttribute("open", "");
  expect((await measureEditor(page)).openRows).toBe(2);

  // The press that adds a row is the press that opens it and puts the keyboard in it: a new row that
  // arrived shut, below fourteen others, is a press that looks like it did nothing.
  await editor.locator("[data-companion-world-book-add]").click();
  const added = rows.nth(15);
  await expect(rows).toHaveCount(16);
  await expect(added).toHaveAttribute("open", "");
  // An entry she has not named yet says so rather than drawing an empty line, and so does one with no
  // trigger words: both are the player's own text, and neither has any yet.
  await expect(added.locator("summary").first()).toContainText("未命名词条");
  await expect(added.locator("summary").first()).toContainText("还没有触发词");
  const focus = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.id ?? "");
  expect(focus, "the new row's title takes the keyboard").toBe("companion-world-book-entry-15-title");
});
