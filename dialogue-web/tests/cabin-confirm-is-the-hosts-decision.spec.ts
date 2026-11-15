/**
 * Which party decides that a cabin offer has gone stale: the game, not the page.
 *
 * Measured in a live run (2026-11-17, the real game). The chain reached `cabin built @21s`, the
 * panel's own wait read `Cabin 1` at @22s, and the player pressed "Confirm cabin" three times. The
 * Host logged the `game/stardew/cabins` read each press released and **zero**
 * `game/stardew/cabins/confirm` requests: the client never asked, because it had decided by itself
 * that the choice had expired (`choice.expiresAtMs <= Date.now()`).
 *
 * That decision is the Host's. It is the Host that holds the choice handle, the session, the
 * revision and the deadline, and it answers `stardew_cabin_choice_stale` when the offer is really
 * over (`stardew-production-lifecycle-coordinator.internal.ts`, `handle.expiresAtMs <= Date.now()`).
 * A client that pre-empts it makes every offer unusable the moment the page's clock passes the
 * advertised window - and the window is short by design: the advertisement is republished every
 * second with a 3 s expiry (`HostFarmhandProvisioner.cs`), so a read hands the page a window of
 * about two seconds, which no human reaches by looking, reading and clicking.
 *
 * So these journeys count requests rather than sentences. The first one is the red reading: a
 * choice whose advertised window is already in the past must still reach the game, and the game's
 * own refusal must come back as a named answer with the list read again rather than as silence.
 */
import { expect, test } from "./frontend-coverage";
import { cabinChoiceHandle, draft, jsonOk, openGameDrawer, root, token } from "./composed-reference-game-fixtures";

/** An offer the page's own clock has already passed - the live shape, where the window is ~2 s. */
const lapsedChoice = (nowMs: number) => ({
  apiVersion: 1,
  choices: [
    {
      displayLabel: "Cabin 1",
      availability: "available",
      choiceHandle: cabinChoiceHandle,
      expiresAtMs: nowMs - 5_000,
    },
  ],
});

/** A live offer: what the Host answers once it has minted a fresh window. */
const liveChoice = (nowMs: number) => ({
  apiVersion: 1,
  choices: [
    {
      displayLabel: "Cabin 1",
      availability: "available",
      choiceHandle: cabinChoiceHandle,
      expiresAtMs: nowMs + 60_000,
    },
  ],
});

test("a lapsed offer still reaches the game, and the game's refusal is a named answer", async ({ page }) => {
  let cabinReads = 0;
  let cabinConfirmRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  // The mount's read hands the page an offer that is already over by its own clock; every later read
  // hands it a live one, exactly as a re-read against a republished advertisement does.
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) => {
    cabinReads += 1;
    return route.fulfill(jsonOk(cabinReads === 1 ? lapsedChoice(Date.now()) : liveChoice(Date.now())));
  });
  // The Host is the one that decides. First confirmation: its own stale refusal. Second: admitted.
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins/confirm", (route) => {
    cabinConfirmRequests += 1;
    if (cabinConfirmRequests === 1) {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ code: "stardew_cabin_choice_stale" }),
      });
    }
    return route.fulfill(jsonOk({ apiVersion: 1, status: "manifest_admitted" }));
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const handoff = panel.locator(".stardew-cabin-handoff");
  await expect(handoff.getByTestId("cabin-choice-list")).toContainText("Cabin 1");

  await handoff.getByRole("button", { name: "Confirm cabin" }).click();
  // The reading of the live defect: this stays at 0 while the page holds the decision, and the only
  // request the press releases is another read.
  await expect
    .poll(() => cabinConfirmRequests, {
      message: "a lapsed offer must still reach the game, which is the party that owns the deadline",
    })
    .toBe(1);

  // The refusal is a named problem, not silence: the game said stale, so nothing was confirmed, and
  // the list the player acts on has been read again.
  const stale = handoff.getByTestId("cabin-choice-stale");
  await expect(stale, "the game's stale refusal is stated where the choice is").toBeVisible();
  const staleText = (await stale.innerText()).replace(/\s+/gu, " ").trim();
  console.log(`[cabin-confirm-stale] ${cabinConfirmRequests} confirm request(s), ${cabinReads} read(s): ${staleText}`);
  expect(staleText, "it says the choice went stale").toMatch(/gone stale|expired/iu);
  expect(staleText, "and that re-reading is the step it took").toMatch(/read again|reading again/iu);
  await expect.poll(() => cabinReads, "the stale answer reads the cabins again").toBe(2);

  // And the retry is the list in front of the player: a second press on the fresh offer is admitted.
  await handoff.getByRole("button", { name: "Confirm cabin" }).click();
  await expect.poll(() => cabinConfirmRequests).toBe(2);
  await expect(panel).toContainText("Cabin request admitted");
});

test("a live offer confirms on the first press", async ({ page }) => {
  let cabinConfirmRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk(liveChoice(Date.now()))),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins/confirm", (route) => {
    cabinConfirmRequests += 1;
    return route.fulfill(jsonOk({ apiVersion: 1, status: "manifest_admitted" }));
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Confirm cabin" }).click();
  await expect.poll(() => cabinConfirmRequests).toBe(1);
  await expect(panel).toContainText("Cabin request admitted");
});
