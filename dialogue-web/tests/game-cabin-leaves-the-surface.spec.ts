/**
 * The cabin block once she is in the save: the list leaves the surface, and one step is left.
 *
 * The defect this file is the reading for, measured on a real run (2026-11-24) and ruled on by the product owner: the
 * cabin handoff stayed on the surface after the companion was bound inside the save. Right after the confirm it said
 * "Cabin request received. Waiting for the game world to be ready." over a world that was already ready, and on a page
 * opened afterwards - a reload, or a second window - it drew the whole list again, with a "Confirm cabin" button the
 * Host can only refuse for the life of the attempt. A control whose action is finished is not a disabled control: it is
 * a control that is gone, and what stands in its place states where she is and the one step that is left.
 *
 * So the two mounts below are the same block before and after the Host's attachment publishes: the offer, then the
 * statement. Both are read from the panel a player sees, in inventory form, so a failure says what was on screen.
 */
import { expect, test, type Locator } from "./frontend-coverage";
import {
  cabinChoiceHandle,
  draft,
  expiresAtMs,
  game,
  jsonOk,
  openGameDrawer,
  root,
  stubGameRead,
  token,
} from "./composed-reference-game-fixtures";

/** Every control inside one element, as the inventory a failure can be read from. */
async function controlInventory(within: Locator) {
  return await within.evaluate((node) =>
    [...node.querySelectorAll('button, [role="button"], a[href]')].map((control) => ({
      name: (control.getAttribute("aria-label") ?? control.textContent ?? "").replace(/\s+/gu, " ").trim(),
      testId: control.getAttribute("data-testid"),
      disabled: control.matches(":disabled"),
    })),
  );
}

/**
 * A running game this browser holds the companion in: the Host's own attachment, published.
 *
 * `cabinLabel` is the cabin the Host bound her to, and it deliberately does not match the offer this page can read
 * ("Cabin 1" below): the word a reload shows must be the Host's own for the cabin it bound, not one this surface can
 * derive from the list on screen. `Cabin 4` is the fourth cabin in that world, the second one she may use.
 */
const boundGame = {
  ...game,
  game: {
    ...game.game,
    prerequisites: { status: "met", detectedGame: "Stardew Valley" },
    instance: { status: "running", gameTitle: "Stardew Valley", generation: 1 },
    attachment: { status: "attached", generation: 2, cabinLabel: "Cabin 4" },
    connectionStatus: "connected_idle",
    actionAuthority: "active",
  },
};
const boundRoot = { ...root, game: boundGame };

/** The offer the Host serves in both mounts, so the difference between them is the binding and nothing else. */
const cabinOffer = {
  apiVersion: 1,
  choices: [{ displayLabel: "Cabin 1", availability: "available", choiceHandle: cabinChoiceHandle, expiresAtMs }],
};

/**
 * The same farm, and the same page, on a Host that publishes no cabin with its attachment - one from before the fact.
 *
 * The honest answer there is "her cabin": the panel must not fall back to the offer list's own numbering, which would
 * name whichever cabin the list happens to hold rather than the one she is in.
 */
const boundGameWithoutCabinWord = {
  ...boundGame,
  game: {
    ...boundGame.game,
    attachment: { status: "attached", generation: 1 },
  },
};
const boundRootWithoutCabinWord = { ...root, game: boundGameWithoutCabinWord };

test("a save the companion is already in offers no cabin to confirm, and says where she is", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(boundRoot)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk(cabinOffer)),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(boundRoot)));
  await stubGameRead(page, boundGame);
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  // The read is answered - the Host does serve the cabins of a farm she is already in - so a panel that drew the list
  // would be drawing a confirm whose action is finished. That is exactly what this reading is for.
  const movedIn = panel.getByTestId("cabin-moved-in");
  await expect(movedIn).toBeVisible();
  await expect(movedIn).toContainText(/already in this save/iu);
  // THE CABIN IS NAMED, by the Host's own word for the binding. It is not "Cabin 1", which is the only cabin this page
  // can read for itself: a name taken from that list would point at a different cabin as soon as another bound one.
  await expect(movedIn).toContainText(/in Cabin 4/u);
  await expect(movedIn).toContainText(/Switch to Stardew Valley and look for her in the farmhouse/u);

  const inventory = await controlInventory(movedIn);
  console.log(`[cabin-moved-in] text=${JSON.stringify(await movedIn.innerText())} controls=${JSON.stringify(inventory)}`);
  expect(inventory, `the finished handoff still offers a control: ${JSON.stringify(inventory)}`).toEqual([]);
  await expect(panel.getByTestId("cabin-choice-list")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Confirm cabin" })).toHaveCount(0);
});

test("before she is in, the same block still offers the cabin the Host advertises", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk(cabinOffer)),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await stubGameRead(page, root.game);
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const handoff = panel.locator(".stardew-cabin-handoff");
  await expect(handoff.getByTestId("cabin-choice-list")).toContainText("Cabin 1");
  await expect(handoff.getByRole("button", { name: "Confirm cabin" })).toBeVisible();
  await expect(panel.getByTestId("cabin-moved-in")).toHaveCount(0);
});

/**
 * The same farm on a Host that publishes no cabin with its attachment, which is a Host from before the fact.
 *
 * Nothing is known about which cabin she is in, and the panel says so: "her cabin". The one thing it must not do is
 * reuse the offer list's numbering - "Cabin 1" is the only cabin this page can read, and the whole reason the word is
 * published by the Host is that the list cannot answer which cabin the binding chose.
 */
test("a Host that publishes no cabin leaves the sentence at \"her cabin\", never the offer's number", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill(jsonOk(boundRootWithoutCabinWord)),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk(cabinOffer)),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill(jsonOk(boundRootWithoutCabinWord)),
  );
  await stubGameRead(page, boundGameWithoutCabinWord);
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const movedIn = panel.getByTestId("cabin-moved-in");
  await expect(movedIn).toBeVisible();
  const text = await movedIn.innerText();
  console.log(`[cabin-moved-in-unnamed] text=${JSON.stringify(text)}`);
  expect(text, `the noun a Host published no cabin for was named anyway: ${JSON.stringify(text)}`).toContain(
    "in her cabin",
  );
  expect(text, `the offer list's number stood in for a cabin the Host never named: ${JSON.stringify(text)}`).not.toContain(
    "Cabin 1",
  );
});
