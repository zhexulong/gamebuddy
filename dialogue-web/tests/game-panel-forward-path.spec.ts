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

test("an unconfirmed cabin confirmation offers a step of its own that sends no second confirmation", async ({ page }) => {
  let cabinConfirmRequests = 0;
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
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  // "Check the game again" is the panel's own read of the Game slice: the mount's arrival read is the
  // `/state` above, and none of the reads counted here belong to it.
  const gameRead = await stubGameRead(page, root.game);
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Confirm cabin" }).click();
  await expect(panel).toContainText(/awaiting verification|sent and its answer never came back/i);

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
  await expect(handoff).toContainText(/way forward is the sentence above/iu);

  const readsBefore = gameRead.reads();
  await check.click();
  await expect.poll(() => gameRead.reads()).toBeGreaterThan(readsBefore);
  expect(cabinConfirmRequests, "the step that leaves an unconfirmed confirmation must not confirm again").toBe(1);
  await expect(handoff.getByRole("button", { name: "Confirm cabin" })).toHaveCount(0);
  // The answer had not changed, and the panel still says so rather than showing a screen that
  // looks as though the press did nothing.
  await expect(handoff).toContainText(/awaiting verification|sent and its answer never came back/i);
});

test("with no installation registered the enable control is withheld and its reason is stated", async ({ page }) => {
  let activationRequests = 0;
  await page.setViewportSize({ width: 400, height: 800 });
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

  // Step 1's OTHER staging press has the same premise as activation, and it is withheld for the same
  // reason: the coordinator refuses setup until an attempt is staged
  // (`stardew_player_host_launch_not_staged`, `stardew-production-lifecycle-coordinator.internal.ts`),
  // and nothing is staged without the registration this step is asking for. Offering it was a press
  // whose only answer was "enable companion play" - the control held back four lines above it.
  await expect(panel.getByTestId("game-guide-step-one-alternate")).toHaveCount(0);
  await expect(stepOne.getByTestId("game-setup")).toHaveCount(0);

  // Withheld, not a dead end: the control that can act in this state is the installation panel's own,
  // and it is inside the first viewport at 400x800 (this panel leads the guide here, because choosing
  // the folder is the only step that can succeed - `GameSurface`'s `gettingGoing`).
  const chooseFolder = page.getByRole("button", { name: "Choose game folder" });
  await expect(chooseFolder).toBeVisible();
  const box = await chooseFolder.boundingBox();
  expect(
    box !== null && box.y >= -1 && box.y + box.height <= 800 && box.x >= -1 && box.x + box.width <= 400,
    `the only control that can act is outside the first viewport: ${JSON.stringify(box)}`,
  ).toBe(true);
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
