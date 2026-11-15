import { type Page, expect, test } from "./frontend-coverage";
import { stubShell, token } from "./draft-surfaces";
import { DESKTOP, SMALL_LAPTOP } from "./viewport-policy";

/**
 * The profile-backup block keeps the Settings surface's management measure.
 *
 * THE DEFECT. `--management-form-measure` is 640 px and every field group on the Settings surface
 * takes it and centres itself. `[data-profile-backup-section]` never got the declaration: it was
 * appended to the surface after that pass, so at 1440x900 it spanned the whole 1408 px region while
 * the five groups above it were 640 px wide on a left edge of 400. One surface, two columns, and a
 * section title with its own control at opposite ends of the window.
 *
 * WHAT IS MEASURED, and why the pair rather than the width: a block can be 640 px wide and still be
 * on a different column, so the assertion is the block's own LEFT and RIGHT edges against the group
 * it shares a column with. That is the invariant "one surface, one column", and what the two cells
 * below prove is the two shapes of it:
 *
 *  - at `SMALL_LAPTOP` (1280x720) the region holds ONE measure, so the surface is one column and the
 *    backup block shares the language group's edges exactly. This is the original assertion, moved to
 *    the cell where the surface really is one column: at 1440x900 the surface lays its blocks out in
 *    two tracks of the measure (`style.css`, `[data-settings-tracks]`), so the two blocks are on
 *    DIFFERENT columns there, by design and measurably (`tests/settings-two-tracks.spec.ts`).
 *  - at `DESKTOP` (1440x900) each of the two is on its own column and neither is wider than the
 *    measure, which is what "the backup block did not span the region" means where the region is
 *    twice the measure wide. The measure is read from the token's own value, never restated here.
 *
 * red-proof: inject  drop `[data-profile-backup-section]` from the measure group in `style.css` ->
 *   `the backup block starts at 16 and the column at 315` at 1280x720.
 */

type Edges = Readonly<{ left: number; right: number; width: number }>;

/** The region and the blocks this file compares, with the surface at its top. */
async function readEdges(page: Page): Promise<{
  region: Edges;
  backup: Edges;
  language: Edges;
  measure: number;
}> {
  return await page.evaluate(() => {
    const edges = (selector: string): Edges => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) throw new Error(`the Settings surface renders no ${selector} block`);
      const rect = element.getBoundingClientRect();
      return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
    };
    return {
      region: edges('[data-testid="settings-surface"] .surface-content'),
      backup: edges("[data-profile-backup-section]"),
      language: edges("[data-language-settings]"),
      measure: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--management-form-measure")),
    };
  });
}

async function openSettings(page: Page): Promise<void> {
  await stubShell(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const entry = page.getByRole("button", { name: "Settings", exact: true });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.getByTestId("settings-surface")).toBeVisible();
  await expect(page.locator("[data-profile-backup-section]")).toBeVisible();
}

test("the profile-backup block shares the one column where the region holds one measure", async ({ page }) => {
  await page.setViewportSize({ width: SMALL_LAPTOP.width, height: SMALL_LAPTOP.height });
  await openSettings(page);
  const reading = await readEdges(page);
  console.log(`[profile-backup-measure] ${SMALL_LAPTOP.name} ${JSON.stringify(reading)}`);

  expect(reading.measure, "--management-form-measure is a pixel value the sheet declares").toBeGreaterThan(0);
  // The premise: this cell is one the surface really is one column in. A test that asserted the pair at a
  // two-track cell would be asserting the opposite of the layout.
  expect(
    reading.region.width,
    `${SMALL_LAPTOP.name}: the region is ${reading.region.width}px, wider than two ${reading.measure}px measures - ` +
      "this cell no longer proves the pair",
  ).toBeLessThan(reading.measure * 2);
  expect(
    reading.backup.left,
    `the backup block starts at ${reading.backup.left} and the column it sits on at ${reading.language.left}`,
  ).toBe(reading.language.left);
  expect(
    reading.backup.right,
    `the backup block ends at ${reading.backup.right} and the column it sits on at ${reading.language.right}`,
  ).toBe(reading.language.right);
  expect(
    reading.backup.width,
    `the backup block is ${reading.backup.width}px wide inside a ${reading.measure}px measure`,
  ).toBeLessThanOrEqual(reading.measure);
});

test("at 1440x900 the backup block is one measure wide on one of the surface's two columns", async ({ page }) => {
  await page.setViewportSize({ width: DESKTOP.width, height: DESKTOP.height });
  await openSettings(page);
  const reading = await readEdges(page);
  console.log(`[profile-backup-measure] ${DESKTOP.name} ${JSON.stringify(reading)}`);

  // The cell is the one the defect was measured in: a region twice the measure wide, where a block that
  // lost the measure reads 1398 px instead of 640.
  expect(
    reading.region.width,
    `${DESKTOP.name}: the region is ${reading.region.width}px and the measure ${reading.measure}px - this cell no ` +
      "longer has the room the defect needed",
  ).toBeGreaterThan(reading.measure * 2);
  for (const [name, block] of [
    ["the backup block", reading.backup],
    ["the language group", reading.language],
  ] as const) {
    expect(
      block.width,
      `${DESKTOP.name}: ${name} is ${block.width}px wide (${block.left}..${block.right}) in a ` +
        `${reading.region.width}px region whose measure is ${reading.measure}px`,
    ).toBeLessThanOrEqual(reading.measure);
  }
  // Each is on a column of its own: the surface's two tracks are side by side, so the two blocks differ by
  // exactly one track plus the gap, and neither straddles the other.
  expect(
    reading.backup.left >= reading.language.right || reading.language.left >= reading.backup.right,
    `the backup block at ${reading.backup.left}..${reading.backup.right} and the language group at ` +
      `${reading.language.left}..${reading.language.right} are on the same column - the surface lays its blocks out ` +
      "in two tracks, so the two belong on different ones",
  ).toBe(true);
});
