/**
 * A player's unsaved companion settings survive a glance at the conversation.
 *
 * `GamePlayerSettings` is a form with its own draft: the family toggles, the co-op night floor and
 * the window behaviour are local state, and the Host is written only when the player presses Save
 * (a revision compare-and-swap, exactly like every other settings surface). The Game surface
 * returned `null` while another peer was selected, so switching to the conversation unmounted the
 * form - and returning re-read the record and put every control back on the Host's values. A player
 * who ticked two families, looked at the conversation and came back found the boxes they had just
 * changed reset, with nothing said about it.
 *
 * The shell already keeps a surface mounted while it is parked for the conversation's scroll box
 * (`.surface-slot-parked`: out of the flow, `visibility: hidden`, never `display: none`). This
 * journey is the measurement that the same parking keeps a draft: the values the player set are
 * read off the controls after a switch away and back, and the parked surface is out of the
 * accessibility tree so a second hidden form cannot be reached or announced.
 */
import { expect, test, type Page } from "./frontend-coverage";
import { draft, jsonOk, root, stubGameRead, token } from "./composed-reference-game-fixtures";

/** The record the Host answers: two families, the default floor, and a chosen window behaviour. */
const playerSettings = {
  apiVersion: 1,
  revision: 7,
  families: [
    { familyId: "farming_crops", denied: false },
    { familyId: "resource_gathering", denied: false },
  ],
  advanceDayMinimumOnlineFarmers: 1,
  windowMode: "visible",
  deniedActions: [],
  appliesToRunningGame: {
    actionPolicy: "within_seconds",
    advanceDayMinimumOnlineFarmers: "next_world_load",
    windowMode: "within_seconds",
    deniedActions: "within_seconds",
  },
};

async function mount(page: Page): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await stubGameRead(page);
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/settings", (route) =>
    route.fulfill(jsonOk(playerSettings)),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
}

test("the companion settings a player typed are still there after a switch away and back", async ({ page }) => {
  test.setTimeout(90_000);
  await mount(page);

  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();

  const coopFloor = page.getByLabel("Farmers needed before night falls");
  const farming = page.getByLabel("Farming: tilling, watering, planting, harvest");
  // The checkbox face is retired (the themed row is the affordance), so the player's press is the row
  // around it - the same recipe the delivery-pacing toggle uses.
  const farmingRow = page.locator("label.game-player-settings-family", {
    hasText: "Farming: tilling, watering, planting, harvest",
  });
  const windowMode = page.getByLabel("While she plays");
  await expect(coopFloor, "the record the Host holds is on screen").toHaveValue("1");
  await expect(farming).toBeChecked();
  await expect(windowMode).toHaveValue("visible");

  // The player's own edits: two fields of three, none of them saved.
  await coopFloor.selectOption("3");
  await farmingRow.click();
  await windowMode.selectOption("minimized");
  await expect(farming, "the press reached the box").not.toBeChecked();

  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();

  console.log(
    `MEASURE companion-draft: coop=${await coopFloor.inputValue()} ` +
      `farming=${await farming.isChecked()} window=${await windowMode.inputValue()}`,
  );
  await expect(coopFloor, "the night floor the player chose is still chosen").toHaveValue("3");
  await expect(farming, "the family the player withheld is still withheld").not.toBeChecked();
  await expect(windowMode, "the window behaviour the player chose is still chosen").toHaveValue("minimized");
});

test("the parked Game surface is out of the flow, out of the way and out of the accessibility tree", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await mount(page);

  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();

  // Still mounted, so the draft above survives...
  await expect(page.getByTestId("game-surface"), "the Game surface stays mounted").toHaveCount(1);
  // ...and not drawn, not focusable, and not announced.
  await expect(page.getByTestId("game-surface"), "the parked Game surface is not drawn").toBeHidden();
  await expect(
    page.getByRole("region", { name: "Game" }),
    "the parked Game surface is not in the accessibility tree",
  ).toHaveCount(0);
});
