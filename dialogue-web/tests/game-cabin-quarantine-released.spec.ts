/**
 * The press that frees a quarantined cabin attempt: the panel offers the cabins again.
 *
 * The state this reading starts in is the one a failed confirmation leaves: the signed cabin request was
 * admitted and the attach that follows it refused, so the Host holds the attempt and the panel says so. The
 * one thing that may release it is a proof that the publication did not take effect, and the press that asks
 * for that proof is the panel's own ("Check whether she moved in").
 *
 * So this journess reads the panel's own controls on both sides of the press: before it, the probe and the
 * tray step (no cabin may be confirmed); after a Host that answered `not_bound` and released, the cabin
 * choice again. The Host's four assertions are not this file's subject - they are
 * `host/src/games/stardew/lifecycle/stardew-cabin-quarantine-release.private.test.ts` - and this reading
 * stubs the answer they licensed.
 */
import { expect, test, type Locator } from "./frontend-coverage";
import {
  cabinChoiceHandle,
  draft,
  expiresAtMs,
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

/** The offer the Host serves, in both reads: before the quarantine and after the release. */
const cabinOffer = {
  apiVersion: 1,
  choices: [{ displayLabel: "Cabin 1", availability: "available", choiceHandle: cabinChoiceHandle, expiresAtMs }],
};

/** The answer a releasing Host gives: the save does not hold her, so the held attempt was freed. */
const releasedAnswer = {
  apiVersion: 1,
  occupancy: {
    answer: "not_bound",
    reason: null,
    cabinId: null,
    boundBy: null,
    publishedAtUnixMs: 1_900_000_000_000,
    observedAtUnixMs: 1_900_000_000_100,
  },
  release: "released",
};

/** The refusal the confirmation answers with: the manifest was admitted and the attach that follows refused. */
const uncertainRefusal = {
  status: 409,
  contentType: "application/json",
  body: JSON.stringify({ code: "stardew_manifest_handoff_uncertain", cause: "stardew_cabin_publication_uncertain" }),
};

test("the probe's press releases a quarantined attempt and the cabin choice comes back", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk(cabinOffer)),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins/confirm", (route) =>
    route.fulfill(uncertainRefusal),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins/occupancy", (route) =>
    route.fulfill(jsonOk(releasedAnswer)),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await stubGameRead(page, root.game);
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const handoff = panel.locator(".stardew-cabin-handoff");

  // The confirmation goes out and its answer never comes back: the Host holds the attempt, and the panel
  // offers the probe plus the tray step - never a second confirmation.
  await handoff.getByRole("button", { name: "Confirm cabin" }).click();
  const probe = handoff.getByRole("button", { name: "Check whether she moved in" });
  await expect(probe).toBeVisible();
  const before = await controlInventory(handoff);
  console.log(`[cabin-quarantine] before=${JSON.stringify(before)}`);
  expect(
    before.map((control) => control.name),
    `a quarantined handoff offered a second confirmation: ${JSON.stringify(before)}`,
  ).not.toContain("Confirm cabin");

  // The press asks the game: the save does not hold her, so the Host freed the attempt and the cabin choice
  // is offered again - which is the whole point of the release existing.
  await probe.click();
  await expect(handoff.getByTestId("cabin-choice-list")).toContainText("Cabin 1");
  await expect(handoff.getByRole("button", { name: "Confirm cabin" })).toBeVisible();
  const after = await controlInventory(handoff);
  console.log(`[cabin-quarantine] after=${JSON.stringify(after)}`);
  expect(
    after.map((control) => control.name),
    `the release did not offer the cabin choice again: ${JSON.stringify(after)}`,
  ).toContain("Confirm cabin");
  await expect(handoff.getByRole("button", { name: "Check whether she moved in" })).toHaveCount(0);
});
