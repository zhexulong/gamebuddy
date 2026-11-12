/**
 * The Game panel's getting-going flow: every state it can be in offers the player a step, and no
 * control is offered before the fact its command needs holds.
 *
 * Two invariants of `AGENTS.md`, measured in the browser where the player meets them:
 *
 *   * Zero forward path. The cabin handoff's `uncertain` outcome - a confirmation whose
 *     publication is unknown - used to render one warning sentence and nothing else, so the only
 *     way out of it was reloading the page, which drops the Host connection and this surface's own
 *     attachment. The fix cannot be "offer the cabin read again" either: the Host keeps the
 *     confirmed choice consumed and answers any later confirmation with
 *     `stardew_cabin_confirmation_conflict`, so a re-read would re-arm a button that can only be
 *     refused. What the panel owes there is a real step that sends no second confirmation.
 *
 *   * Premature activation. With no Stardew installation registered, "Enable companion play" was
 *     still pressable, and pressing it earned
 *     `409 {"code":"state_unavailable","cause":"stardew_bootstrap_registration_unavailable"}` - a
 *     refusal the surface could have prevented. The press now comes from the same fact the
 *     coordinator gates on: the ready installation registration the Host publishes as
 *     `prerequisites: "met"` (`game-browser-state-provider.ts` reads the one
 *     `readInstallationView` registration the activation path also reads). The control stays on
 *     screen as the step it is, withheld until that fact holds, and the sentence under it names
 *     the missing fact and the panel - the installation panel above this one in exactly this
 *     state - that supplies it.
 *
 * Both readings are printed as control inventories (`button, [role=button], a[href]`) rather than
 * as booleans, so a failure says what the player could actually press.
 */
import { expect, test, type Locator } from "./frontend-coverage";
import {
  cabinChoiceHandle,
  draft,
  expiresAtMs,
  installedRoot,
  jsonOk,
  openGameDrawer,
  root,
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

test("an unconfirmed cabin confirmation offers a step of its own that sends no second confirmation", async ({ page }) => {
  let cabinConfirmRequests = 0;
  let stateReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill(jsonOk(root)),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        choices: [{ displayLabel: "North cabin", availability: "available", choiceHandle: cabinChoiceHandle, expiresAtMs }],
      }),
    ),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins/confirm", (route) => {
    cabinConfirmRequests += 1;
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "stardew_manifest_handoff_uncertain" }),
    });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill(jsonOk(root));
  });
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Confirm cabin" }).click();
  await expect(panel).toContainText(/still awaiting verification/i);

  const handoff = panel.locator(".stardew-cabin-handoff");
  const inventory = await controlInventory(handoff);
  console.log(`[cabin-uncertain] controls=${JSON.stringify(inventory)}`);

  // The state is not terminal and nothing is in flight: a player who reads it must have a step.
  expect(
    inventory.length,
    `the unconfirmed handoff offers the player nothing to press, so reloading the page is the only exit: ${JSON.stringify(inventory)}`,
  ).toBeGreaterThan(0);
  // The step is the panel's own read of the game, and it says what it can and cannot change - the
  // confirmation is never sent again by it (the Host refuses any later one with
  // `stardew_cabin_confirmation_conflict`).
  const check = handoff.getByRole("button", { name: "Check the game again" });
  await expect(check).toBeVisible();
  await expect(handoff).toContainText(/never sent a second time/iu);
  await expect(handoff).toContainText(/keeps waiting for recovery/iu);

  const readsBefore = stateReads;
  await check.click();
  await expect.poll(() => stateReads).toBeGreaterThan(readsBefore);
  expect(cabinConfirmRequests, "the step that leaves an unconfirmed confirmation must not confirm again").toBe(1);
  await expect(handoff.getByRole("button", { name: "Confirm cabin" })).toHaveCount(0);
  // The answer had not changed, and the panel still says so rather than showing a screen that
  // looks as though the press did nothing.
  await expect(handoff).toContainText(/still awaiting verification/i);
});

test("with no installation registered the enable control is withheld and its reason is stated", async ({ page }) => {
  let activationRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/lifecycle/activate", (route) => {
    activationRequests += 1;
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "state_unavailable", cause: "stardew_bootstrap_registration_unavailable" }),
    });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const stepOne = panel.locator('[data-guide-step="1"]');
  await expect(stepOne).toBeVisible();
  const inventory = await controlInventory(stepOne);
  console.log(`[no-installation] step1=${JSON.stringify(inventory)}`);

  // The activation command reserves and stages the owned Player Host *against the ready
  // installation registration*, so with none published the press is withheld rather than
  // earning `stardew_bootstrap_registration_unavailable` as a fault.
  expect(
    inventory.filter((control) => control.testId === "game-activate"),
    `the enable control is pressable with no installation registered: ${JSON.stringify(inventory)}`,
  ).toEqual([{ name: "Enable companion play", testId: "game-activate", disabled: true }]);
  // A withheld control really does not send: the press is dispatched at the element and the
  // activation route is never reached.
  await stepOne.getByTestId("game-activate").evaluate((node) => node.click());
  await page.waitForTimeout(200);
  expect(activationRequests, "a withheld control must not send the command it cannot complete").toBe(0);

  // …and the reason, with the control that supplies it, is stated where the control is.
  const reason = panel.getByTestId("game-installation-required");
  await expect(reason).toBeVisible();
  await expect(reason).toContainText(/Choose your game folder in Game installation on this page/u);
});

test("with the installation registered the same step offers the enable control, so the reason was not the whole answer", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(installedRoot)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(installedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const stepOne = panel.locator('[data-guide-step="1"]');
  await expect(stepOne).toHaveAttribute("data-guide-action", "activate");
  const inventory = await controlInventory(stepOne);
  console.log(`[installation-registered] step1=${JSON.stringify(inventory)}`);
  expect(
    inventory.find((control) => control.testId === "game-activate"),
    `the enable control is not pressable once the installation is registered: ${JSON.stringify(inventory)}`,
  ).toEqual({ name: "Enable companion play", testId: "game-activate", disabled: false });
  await expect(panel.getByTestId("game-installation-required")).toHaveCount(0);
});
