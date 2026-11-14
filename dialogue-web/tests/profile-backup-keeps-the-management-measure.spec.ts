import { expect, test } from "./frontend-coverage";
import { stubShell, token } from "./draft-surfaces";
import { DESKTOP } from "./viewport-policy";

/**
 * The profile-backup block keeps the Settings surface's one column.
 *
 * THE DEFECT. `--management-form-measure` is 640 px and every field group on the Settings surface
 * takes it and centres itself. `[data-profile-backup-section]` never got the declaration: it was
 * appended to the surface after that pass, so at 1440x900 it spanned the whole 1408 px region while
 * the five groups above it were 640 px wide on a left edge of 400. One surface, two columns, and a
 * section title with its own control at opposite ends of the window.
 *
 * WHAT IS MEASURED, and why the pair rather than the width: a block can be 640 px wide and still be
 * on a different column, so the assertion is the block's own LEFT and RIGHT edges against the group
 * that already keeps the measure. That is the invariant "one surface, one column", and it is true of
 * whatever width the surface is handed. The width is asserted too, against the token's own value, so
 * a future narrow measure does not silently pass by making both blocks equally wrong.
 *
 * One cell, `DESKTOP`: this is the wide column the defect is, and at 400x800 the region is already
 * narrower than the measure, so both readings there are the region's own edges and the pair agrees
 * for a reason that has nothing to do with this change.
 *
 * red-proof: inject  drop `[data-profile-backup-section]` from the measure group in `style.css` ->
 *   `the backup block starts at 16 and the group above it at 400`.
 */
test("the profile-backup block shares the Settings column's edges at 1440x900", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await stubShell(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const entry = page.getByRole("button", { name: "Settings", exact: true });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.getByTestId("settings-surface")).toBeVisible();

  const reading = await page.evaluate(() => {
    const edges = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
      };
    };
    return {
      region: edges('[data-testid="settings-surface"] .surface-content'),
      backup: edges("[data-profile-backup-section]"),
      group: edges("[data-language-settings]"),
    };
  });
  console.log(`[profile-backup-measure] ${JSON.stringify(reading)}`);

  expect(reading.backup, "the backup block is on the Settings surface").not.toBeNull();
  expect(reading.group, "the language group is the Settings block that keeps the measure").not.toBeNull();
  expect(
    reading.backup!.left,
    `the backup block starts at ${reading.backup!.left} and the group above it at ${reading.group!.left}`,
  ).toBe(reading.group!.left);
  expect(
    reading.backup!.right,
    `the backup block ends at ${reading.backup!.right} and the group above it at ${reading.group!.right}`,
  ).toBe(reading.group!.right);
  // The measure itself, read from the token's own value rather than a second copy of 640.
  const measure = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--management-form-measure")),
  );
  expect(measure, "--management-form-measure is a pixel value the sheet declares").toBeGreaterThan(0);
  expect(
    reading.backup!.width,
    `the backup block is ${reading.backup!.width}px wide inside a ${measure}px measure`,
  ).toBeLessThanOrEqual(measure);
  // And the defect's own number, so the run says what the block used to span: the region is much
  // wider than the column, which is what made a full-width block an invisible defect on a narrow
  // window and a 1408 px strip on a wide one.
  expect(reading.region!.width, "the region really is wider than the measure at this cell").toBeGreaterThan(
    measure * 2,
  );
});
