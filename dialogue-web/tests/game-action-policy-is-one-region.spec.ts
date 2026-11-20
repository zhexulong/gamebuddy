/**
 * The companion's action policy is ONE region, and it says how much of itself is switched off.
 *
 * What this pins, and why each half needs a journey rather than a stylesheet review: the setting was
 * twenty-one undifferentiated rows between two single-field settings. Nothing above the list said
 * how much of it was withheld, and nothing said where the run of rows began: measured on a published
 * surface before this, the rows were 964 px tall at 1440x900, 1280x800 and 400x800 alike (taller
 * than every window the product is used in), and the only separation from the setting above was a
 * heading's own margin.
 *
 * So the assertions are the three things the owner's report asked for:
 *   1. the region is a named area of its own - `role="region"`, a heading, and a plate whose
 *      background and border are drawn rather than inherited from nothing;
 *   2. the count line is true in all three shapes of the list (everything allowed, something
 *      withheld, nothing published), and it is derived from the draft on screen;
 *   3. the rows are still exactly the families the Host published - one checkbox each, one write
 *      per box, reachable by keyboard, named per row for a screen reader.
 *
 * The layout half is measured where the two layouts are (`LAYOUT_PAIR`): at 1440x900 the list is
 * two columns and the whole region fits one window, and at 400x800 the heading and the count line
 * are both above the fold of the region rather than buried under the list.
 */
import { expect, test } from "./frontend-coverage";
import type { Locator, Page } from "./frontend-coverage";
import { messages } from "../src/i18n";
import { draft, jsonOk, root, token } from "./composed-reference-game-fixtures";
import { LAYOUT_PAIR } from "./viewport-policy";

/**
 * Six of the Mod's families, in the Mod's own order (`stardew-action-families.ts`).
 *
 * Six rather than the whole twenty-one: what this journey asserts is a property of the list - one
 * row per published family, and a count line that adds up - so the numbers come from this record
 * rather than from a second copy of the catalogue. The measured height of the real twenty-one-row
 * list is a fact about the stylesheet and is recorded where the change is described.
 */
const FAMILIES = [
  "farming_crops",
  "resource_gathering",
  "animals_pets",
  "machines_processing",
  "crafting_cooking",
  "buildings_farm_management",
] as const;

const settingsRecord = (denied: readonly string[], families: readonly string[] = FAMILIES) => ({
  apiVersion: 1,
  revision: 7,
  families: families.map((familyId) => ({ familyId, denied: denied.includes(familyId) })),
  advanceDayMinimumOnlineFarmers: 1,
  windowMode: "visible",
  deniedActions: [],
  appliesToRunningGame: {
    actionPolicy: "within_seconds",
    advanceDayMinimumOnlineFarmers: "next_world_load",
    windowMode: "within_seconds",
    deniedActions: "within_seconds",
  },
});

/** The request the surface made, captured so a journey can assert it wrote the family it pressed. */
type Writes = { families: readonly string[] }[];

async function mount(page: Page, denied: readonly string[], families: readonly string[] = FAMILIES): Promise<Writes> {
  const writes: Writes = [];
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/composed-reference-game/v1/game", (route) => route.fulfill(jsonOk(root.game)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/settings", (route) => {
    if (route.request().method() !== "POST") return route.fulfill(jsonOk(settingsRecord(denied, families)));
    const body = route.request().postDataJSON() as { deniedActionFamilies: readonly string[] };
    writes.push({ families: body.deniedActionFamilies });
    // The Host answers with the record it now holds, which is what the surface adopts.
    return route.fulfill(jsonOk(settingsRecord(body.deniedActionFamilies, families)));
  });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
  return writes;
}

const policy = (page: Page): Locator => page.locator("section.game-player-settings-policy");
const countLine = (page: Page): Locator => page.getByTestId("game-action-policy-summary");

/**
 * The count line's own sentence, assembled from the catalogue rather than copied from it.
 *
 * The words are the copy lane's, so a journey that spelled the English out would go red the day
 * somebody reworded it - for a reason that is not the rule it checks. The template and the counts
 * are what this journey owns, and it reads the template from the authority that declares it.
 */
const summaryOf = (allowed: number, total: number, withheld: number): string =>
  messages("en")
    .gameSettingsActionPolicySummary.replace("{{allowed}}", String(allowed))
    .replace("{{total}}", String(total))
    .replace("{{withheld}}", String(withheld));

const boxOf = async (locator: Locator) => await locator.boundingBox();

for (const viewport of LAYOUT_PAIR) {
  test(`the action policy is one named region at ${viewport.name} (${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mount(page, []);

    const region = policy(page);
    await expect(region, "the region is on the page").toBeVisible();
    await region.scrollIntoViewIfNeeded();

    // Named by its own heading, with no second copy of the heading's words in this journey: the
    // heading's text is read off the page and the role is asked for by that name.
    const headingText = (await region.locator("h4.game-player-settings-group").innerText()).trim();
    expect(headingText.length, "the region's heading carries words").toBeGreaterThan(0);
    await expect(
      page.getByRole("region", { name: headingText }),
      "the region answers to the heading a player reads",
    ).toHaveCount(1);

    // Its own area, asserted as the two properties the plate is made of rather than as a picture:
    // a drawn background, and a hairline edge. A region that inherits the page's own background
    // reads as the tail of the setting above it - which is exactly the report.
    const plate = await region.evaluate((node) => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, border: style.borderTopWidth, padding: style.paddingTop };
    });
    expect(plate.background, "the region paints a surface of its own").not.toBe("rgba(0, 0, 0, 0)");
    expect(plate.border, "the region draws its own edge").toBe("1px");
    expect(Number.parseFloat(plate.padding), "the region holds its rows off its own edge").toBeGreaterThan(0);

    // The heading and the count line are both inside the first window once the region is at its
    // top: a player reading the summary must not have to scroll past rows to find it.
    const viewportHeight = viewport.height;
    for (const [what, locator] of [
      ["heading", region.locator("h4.game-player-settings-group")],
      ["count line", countLine(page)],
    ] as const) {
      const box = await boxOf(locator);
      expect(box, `${what} is on the page`).not.toBeNull();
      expect(box!.y, `${what} sits at or below the top of the window`).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height, `${what} is above the fold at ${viewport.name}`).toBeLessThanOrEqual(viewportHeight);
    }

    // One row per published family, each carrying its own accessible name and its own box.
    const rows = region.locator("ul.game-player-settings-families > li");
    await expect(rows).toHaveCount(FAMILIES.length);
    await expect(region.getByRole("checkbox")).toHaveCount(FAMILIES.length);
    for (let index = 0; index < FAMILIES.length; index += 1) {
      await expect(rows.nth(index).locator("input[type=checkbox]"), "one box per row").toHaveCount(1);
      await expect(rows.nth(index).locator("input[type=checkbox]")).toBeChecked();
    }
    const rowNames = await rows.evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: node.querySelector(".game-player-settings-family-name")?.textContent ?? null,
        aria: node.querySelector("input")?.getAttribute("aria-label") ?? null,
      })),
    );
    expect(
      rowNames.filter((row) => row.text === null || row.text !== row.aria),
      "every box is named by its own row's words, so a screen reader reads the family and not a role",
    ).toEqual([]);

    // The whole truth, in one line, for the shape where nothing is withheld.
    await expect(countLine(page)).toHaveText(summaryOf(FAMILIES.length, FAMILIES.length, 0));
    await expect(region).toHaveAttribute("data-policy-summary", "all_allowed");

    // Two columns where the plate is wide enough for two readable labels - that is what keeps a
    // twenty-one-row list inside one window instead of running past it.
    const columns = await region.locator("ul.game-player-settings-families").evaluate((node) => {
      return getComputedStyle(node).gridTemplateColumns.split(" ").filter((track) => track.trim().length > 0).length;
    });
    console.log(`MEASURE action-policy ${viewport.name}: plate=${JSON.stringify(plate)} columns=${columns}`);
    expect(columns, `the rows use the width the plate has at ${viewport.name}`).toBe(viewport.width >= 800 ? 2 : 1);
  });
}

test("a box writes exactly the family it belongs to, and the count line follows the draft", async ({ page }) => {
  const writes = await mount(page, []);
  const region = policy(page);
  const boxes = region.getByRole("checkbox");
  await expect(countLine(page)).toHaveText(summaryOf(FAMILIES.length, FAMILIES.length, 0));

  // Pressed the way a keyboard player presses it: the box is in the a11y tree, the row is the paint.
  const withheld = boxes.nth(FAMILIES.indexOf("animals_pets"));
  await withheld.focus();
  await expect(withheld).toBeFocused();
  await page.keyboard.press(" ");
  await expect(withheld, "the box the player unticked stays unticked").not.toBeChecked();

  await expect(region, "the region's own line follows the draft").toHaveAttribute("data-policy-summary", "some_withheld");
  await expect(countLine(page)).toHaveText(summaryOf(FAMILIES.length - 1, FAMILIES.length, 1));

  // The row is the tap target too: a press anywhere on it reaches the same box.
  await region.locator("label.game-player-settings-family").nth(FAMILIES.indexOf("crafting_cooking")).click();
  await expect(countLine(page)).toHaveText(summaryOf(FAMILIES.length - 2, FAMILIES.length, 2));

  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(countLine(page)).toBeVisible();
  expect(writes, "one write, carrying exactly the two families the player withheld").toEqual([
    { families: ["animals_pets", "crafting_cooking"] },
  ]);
  await expect(page.locator("[data-settings-notice]")).toHaveAttribute("data-settings-notice", "saved");
  await expect(countLine(page), "the record the Host answered back is what the line states").toHaveText(
    summaryOf(FAMILIES.length - 2, FAMILIES.length, 2),
  );
});

test("a game that publishes no family says so instead of showing an empty list", async ({ page }) => {
  await mount(page, [], []);
  const region = policy(page);
  await expect(region).toHaveAttribute("data-policy-summary", "none_published");
  await expect(countLine(page)).toHaveText(messages("en").gameSettingsActionPolicyNonePublished);
  await expect(region.locator("ul.game-player-settings-families"), "no rows at all, not an empty list").toHaveCount(0);
});
