import { type Page, expect, test } from "./frontend-coverage";
import { draft, jsonOk, root, token } from "./composed-reference-game-fixtures";
import { messages } from "../src/i18n";
import { LAYOUT_PAIR } from "./viewport-policy";

/**
 * The preset assembly is reached through Settings, not through the bar.
 *
 * THE DEFECT. `预设装配` sat in the primary bar between 记忆 and the status word - a first-level
 * control, offered to every player on every surface, that opened a developer's reading of how a
 * preset assembles one request: the macros this product cannot evaluate, the entry switches, the
 * depth injection. A player who pressed it learned the AST depth of a SillyTavern preset. Nothing
 * about that screen is a place a player goes on purpose, and a bar with one row per place a player
 * goes on purpose is the bar's whole contract (`AppBar`).
 *
 * WHAT IS ASSERTED, per cell of `LAYOUT_PAIR`:
 *
 *   1. the bar offers NO entry named 预设装配, whether the trailing peers are folded behind `More`
 *      or standing in the row - so the change is a removal from the bar and not a fold;
 *   2. the Settings surface carries the ONE path that remains: a `details` disclosure, collapsed by
 *      default, holding the read-only hint and one button;
 *   3. that button opens the readout - the region appears, the URL names it, and the surface takes
 *      focus - and Escape returns to the conversation. A disclosure whose control does nothing is
 *      a path that exists and does not lead anywhere.
 *
 * The path is NAMED so a reader can walk it: 设置 (Settings) → 预设装配 disclosure → 查看预设装配.
 *
 * red-proof: inject  put `{ id: PRESETS_PANEL, label: "presetsPanel", icon: ScrollText, management: true }`
 *   back into `SURFACE_ENTRIES` -> `the bar offers an entry named "Preset assembly", which is the
 *   developer readout this change moved behind Settings`.
 */
const catalogue = messages("en");

async function stub(page: Page): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  // The readout's own read. `presets: []` is a real answer - no preset imported - and it is enough
  // for the region to mount: this file is about the path, not about what the path shows.
  await page.route("**/api/tavern/v1/presets", (route) => route.fulfill(jsonOk({ apiVersion: 1, presets: [] })));
}

/** The bar's own entry for a surface, which exists only while the bar has not folded it away. */
function barEntry(page: Page, label: string) {
  return page.locator(".app-bar-actions").getByRole("button", { name: label, exact: true });
}

/**
 * Walk to the Settings surface the way a player does: press its entry, or open the `More`
 * disclosure first on a bar narrow enough to have folded it.
 */
async function openSettings(page: Page): Promise<void> {
  if ((await barEntry(page, catalogue.settingsPanel).count()) === 0)
    await page.getByRole("button", { name: catalogue.appBarMore, exact: true }).click();
  await barEntry(page, catalogue.settingsPanel).click();
  await expect(page.getByTestId("settings-surface")).toBeVisible();
}

for (const cell of LAYOUT_PAIR) {
  test(`the preset readout is one disclosure inside Settings, and the bar does not offer it (${cell.name})`, async ({
    page,
  }) => {
    await page.setViewportSize(cell);
    await stub(page);
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect(page.locator(".app-bar")).toBeVisible();

    // 1. Not in the bar - and not merely folded into `More`, so the reading is taken with the
    //    trailing peers both closed and open.
    await expect(
      barEntry(page, catalogue.presetsPanel),
      `the bar offers an entry named "${catalogue.presetsPanel}", which is the developer readout this change moved behind Settings`,
    ).toHaveCount(0);
    const more = page.getByRole("button", { name: catalogue.appBarMore, exact: true });
    if ((await more.count()) > 0) {
      await more.click();
      await expect(more, "the disclosure really opened").toHaveAttribute("aria-expanded", "true");
      await expect(
        barEntry(page, catalogue.presetsPanel),
        `the folded panel offers an entry named "${catalogue.presetsPanel}"`,
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
    }

    // 2. The one path that remains.
    await openSettings(page);
    const disclosure = page.locator("[data-settings-presets-disclosure]");
    await expect(disclosure, "Settings carries the preset readout's disclosure").toHaveCount(1);
    await expect(disclosure.locator("summary")).toHaveText(catalogue.presetsPanel);
    expect(
      await disclosure.evaluate((element) => (element as HTMLDetailsElement).open),
      "the disclosure is collapsed until the player opens it - a read-out that is always expanded is the bar entry by another route",
    ).toBe(false);
    await disclosure.locator("summary").click();
    await expect(disclosure.locator("summary")).toHaveAttribute("open", /.*/u);
    await expect(disclosure.getByText(catalogue.presetReadOnlyHint)).toBeVisible();

    // 3. The control leads somewhere: the region appears, the URL names it, and it takes focus.
    const open = disclosure.getByRole("button", { name: catalogue.presetsOpen, exact: true });
    await expect(open, "the disclosure's only control is the way in").toBeEnabled();
    await open.click();
    const surface = page.getByTestId("presets-surface");
    await expect(surface, "the control opened nothing").toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#profile=composed-reference-game&panel=presets$`, "u"));
    await expect(surface.getByRole("heading", { name: catalogue.presetsPanel, exact: true })).toBeFocused();

    // And back out: the surface is a peer, so Escape returns to the conversation rather than
    // trapping the player on a readout they opened by accident.
    await page.keyboard.press("Escape");
    await expect(surface).toHaveCount(0);
    await expect(page.getByTestId("chat-surface")).toBeVisible();
  });
}
