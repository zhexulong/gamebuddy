import { type Page, expect, test } from "./frontend-coverage";
import { stubShell, token } from "./draft-surfaces";
import { DESKTOP, VIEWPORT_SIZES } from "./viewport-policy";

/**
 * The character sheet's columns are a fact about the panel's own width, not about the window's.
 *
 * THE DEFECT. `[data-characters-panel]` lays its cards out with `columns: 420px`, and two forced
 * column breaks pick which card starts a new column: at three columns the third begins at 开场白,
 * at two it begins at 场景. Both thresholds were written as `@media (min-width: 1316px)` and
 * `@media (min-width: 884px) and (max-width: 1315px)` - VIEWPORT facts. A 400 px shell docked
 * beside the game inside a 1440 px window therefore took the WIDE rule while the panel it governs
 * was 368 px wide, so the forced break manufactured columns the panel had no room for.
 *
 * WHAT IS MEASURED, and why it is a pair rather than a width: the same panel width is produced two
 * ways - naturally, by a window of that width, and docked, by holding a 1440 px window and
 * constraining the shell to it - and the two readings must agree on which card sits in which
 * column. That is the invariant a container query states, and it is the reading a media query
 * cannot satisfy: a spec that asserted "at 400 px the third column starts at 开场白" would pass on
 * the defect whenever the window happened to be 400 px wide.
 *
 * THE POPULATION is `VIEWPORT_SIZES`: the same cells the AppBar's own container gate reads, so a
 * width added to the declaration joins this file without an edit.
 *
 * red-proof: inject  put the two rules back as `@media (min-width: 1316px)` / `@media (min-width:
 *   884px) and (max-width: 1315px)` ->
 *   `a 400px panel inside a 1440px window puts 开场白 in a column the panel does not have:
 *   {"viewport":1440,"panel":400,"columns":[...]}`.
 */

/** The frame the docked readings are taken in: the shell takes a width the window does not set. */
const DOCK_FRAME = ".tavern-app-shell { width: var(--dock-width, 100%); }";

async function dock(page: Page, width: number | null): Promise<void> {
  await page.evaluate((value) => {
    if (value === null) document.documentElement.style.removeProperty("--dock-width");
    else document.documentElement.style.setProperty("--dock-width", `${value}px`);
  }, width);
}

type SheetReading = Readonly<{
  /** The window's own width, so a failure can tell the two frames apart. */
  viewport: number;
  /** The panel's border box: the width `columns: 420px` is resolved against. */
  panel: number;
  /** One entry per card, in DOM order: the column it was laid out in, counted from the panel's left. */
  columns: readonly number[];
  /** The cards, in DOM order, so a failure names them instead of listing numbers. */
  cards: readonly string[];
  pageOverflowX: number;
}>;

/**
 * Which column each card landed in, read off the browser's own layout.
 *
 * A card's column is its left edge relative to the panel's content box, divided by the column
 * track the sheet declares plus its gap. Reading the position rather than the `break-before` rule
 * is deliberate: the defect is a card in the wrong column, not a declaration someone mistyped.
 */
async function readSheet(page: Page): Promise<SheetReading> {
  return await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("[data-characters-panel]");
    if (panel === null) throw new Error("character-columns-follow-their-container: the panel is not rendered");
    const style = getComputedStyle(panel);
    const track = Number.parseFloat(style.columnWidth) || 420;
    const gap = Number.parseFloat(style.columnGap) || 12;
    const origin = panel.getBoundingClientRect().left;
    const cards = [...panel.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
    const columns = cards.map((card) =>
      Math.round((card.getBoundingClientRect().left - origin) / (track + gap)),
    );
    return {
      viewport: document.documentElement.clientWidth,
      panel: Math.round(panel.getBoundingClientRect().width),
      columns,
      cards: cards.map((card) => {
        const heading = card.querySelector<HTMLElement>("h3, h2, legend");
        return (heading?.textContent ?? card.getAttribute("data-testid") ?? card.className).trim();
      }),
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

async function openCharacters(page: Page): Promise<void> {
  const entry = page.getByRole("button", { name: "Characters", exact: true });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.getByTestId("characters-surface")).toBeVisible();
}

test("the character panel's columns follow the panel's own width, in a window and in a dock", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await stubShell(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharacters(page);
  await page.addStyleTag({ content: DOCK_FRAME });

  const rows: { name: string; natural: SheetReading; docked: SheetReading }[] = [];
  for (const cell of VIEWPORT_SIZES) {
    await dock(page, null);
    await page.setViewportSize(cell);
    const natural = await readSheet(page);
    await page.setViewportSize(DESKTOP);
    await dock(page, cell.width);
    const docked = await readSheet(page);
    rows.push({ name: cell.name, natural, docked });
    console.log(`[character-columns] ${cell.name} natural=${JSON.stringify(natural)} docked=${JSON.stringify(docked)}`);
  }

  for (const row of rows) {
    const { name, natural, docked } = row;
    // The dock really did reproduce the width under test: a frame that did nothing would make
    // every comparison below a comparison of the window with itself.
    expect(docked.panel, `${name}: the docked frame did not reproduce the panel's own width`).toBe(natural.panel);
    expect(
      docked.columns,
      `${name}: a ${docked.panel}px panel lays its cards out in columns ${JSON.stringify(docked.columns)} ` +
        `(${docked.cards.join(", ")}) inside a ${docked.viewport}px window, and in columns ` +
        `${JSON.stringify(natural.columns)} inside a ${natural.viewport}px one - the breaks are a fact about the ` +
        "box the panel is in, not about the window",
    ).toEqual(natural.columns);
    expect(docked.pageOverflowX, `${name}: the docked panel widens the document`).toBeLessThanOrEqual(0);
  }

  // The population visited both shapes, so "the two agree" is not the trivially true reading of a
  // set where the panel is always one column.
  expect(
    new Set(rows.map((row) => row.natural.columns.join(","))).size,
    `no declared cell changes the column assignment, so this comparison proved nothing: ` +
      JSON.stringify(rows.map((row) => [row.name, row.natural.panel, row.natural.columns])),
  ).toBeGreaterThan(1);
});

test("a 400px panel docked in a 1440px window does not take the wide column rule", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await stubShell(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharacters(page);
  await page.addStyleTag({ content: DOCK_FRAME });

  // The state the owner's report is about: GameBuddy floats beside Stardew Valley in a narrow strip
  // while the window behind it is wide.
  for (const width of [400, 420, 500, 600]) {
    await dock(page, width);
    const reading = await readSheet(page);
    console.log(`[character-columns] strip@${width} ${JSON.stringify(reading)}`);
    // One column: every card starts at the panel's left edge. A break forced by the wide rule puts
    // the persona and opening cards in a second column the panel has no room for.
    expect(
      reading.columns,
      `a ${width}px panel inside a ${reading.viewport}px window laid its cards out in columns ` +
        `${JSON.stringify(reading.columns)} (${reading.cards.join(", ")})`,
    ).toEqual(reading.cards.map(() => 0));
    expect(reading.pageOverflowX, `${width}px: the panel widens the document`).toBeLessThanOrEqual(0);
  }
});
