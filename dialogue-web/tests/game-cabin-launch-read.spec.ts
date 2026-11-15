/**
 * After a launch is admitted, the panel asks the game for the cabin by itself.
 *
 * The cabin handoff was read once, from the effect keyed on `ready`, and the launch handler
 * re-read only the composed root. The Host's only forward path out of
 * `awaiting_player_host_attestation` is that handoff - `confirmCabinChoice` is the sole caller of
 * the AI client's launch and attachment - so a launch left the surface in `launching` until the
 * player happened to press "Read cabins again".
 *
 * Measured in a live run (2026-11-15, the real game): the driver pressed that control and the Host
 * answered `Cabin 1` in **45 ms**. The fact was one request away the whole time; the panel simply
 * never asked again.
 *
 * These journeys stub the game state so the first read answers "no cabin yet" (the game has not
 * loaded a farm) and every later one answers `Cabin 1`, which is exactly the shape the live run
 * produced - and they count the requests, because the defect is the missing request rather than a
 * missing sentence.
 */
import { expect, test } from "./frontend-coverage";
import {
  cabinChoiceHandle,
  draft,
  expiresAtMs,
  game,
  jsonOk,
  openGameDrawer,
  root,
  stagedGame,
  token,
} from "./composed-reference-game-fixtures";

/** The projection an admitted launch publishes: the Player Host slot is `launching`. */
const launchingGame = {
  ...stagedGame,
  game: {
    ...stagedGame.game,
    instance: { status: "launching" as const, gameTitle: "Stardew Valley", generation: 1 },
  },
};

const cabinArrived = {
  apiVersion: 1,
  choices: [{ displayLabel: "Cabin 1", availability: "available", choiceHandle: cabinChoiceHandle, expiresAtMs }],
};

const noCabinYet = { apiVersion: 1, choices: [] };

test("a launch makes the panel read the cabin again until it arrives, and then stop", async ({ page }) => {
  let launchRequests = 0;
  let cabinReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill(jsonOk({ ...root, game: stagedGame })),
  );
  await page.route("**/api/composed-reference-game/v1/game/launch", (route) => {
    launchRequests += 1;
    return route.fulfill({ status: 204, body: "" });
  });
  // The mount read finds no cabin; the game answers `Cabin 1` from the second read on, which is the
  // live shape: the cabin is there as soon as someone asks for it.
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) => {
    cabinReads += 1;
    return route.fulfill(jsonOk(cabinReads === 1 ? noCabinYet : cabinArrived));
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill(jsonOk({ ...root, game: launchRequests === 0 ? stagedGame : launchingGame })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const handoff = panel.locator(".stardew-cabin-handoff");
  await expect.poll(() => cabinReads).toBe(1);
  await expect(handoff, "the mount read found no cabin").toContainText("Robin build one on your farm");

  await panel.getByRole("button", { name: "Play with companion" }).click();
  await expect.poll(() => launchRequests).toBe(1);

  // The count is the reading: the launch's own reread publishes `launching`, the cabin is one
  // request away, and nothing asks for it. Measured today this stays at 1 for as long as the
  // panel is left alone - which is why the only way forward was the player's refresh control.
  await page.waitForTimeout(1_500);
  console.log(`[cabin-launch-read] cabin requests after the launch: ${cabinReads}`);
  expect(cabinReads, "the launch makes the panel ask the launched game for the cabin").toBeGreaterThan(1);
  await expect(
    panel.getByTestId("cabin-choice-list"),
    "and the panel offers the cabin it was told about, with no press from the player",
  ).toContainText("Cabin 1");

  // An answer is a stop condition, not a cadence: once the cabin is in hand nothing reads again.
  const answeredWith = cabinReads;
  await page.waitForTimeout(1_500);
  expect(cabinReads, "the read stops at the cabin it was waiting for").toBe(answeredWith);
});

/**
 * The two `launching` shapes, in each language.
 *
 * `launching` is one word for two different screens: the cabin is in hand and the player's next act
 * is the choice, or the cabin has not come back yet and this surface is the one asking for it. The
 * panel says which, and it says it in the language the player reads - including how much of the
 * budget is left, so a panel that keeps asking does not look like one that did nothing.
 */
test("a launching game says whether the cabin is in hand or still being asked for, in both languages", async ({
  page,
}) => {
  const readings: Record<string, { reading: string; found: string }> = {};
  // One mount per language on the same page: the routes below are registered per language, and the
  // most recently added handler is the one Playwright matches first, so each mount reads its own
  // counters rather than the previous language's.
  for (const locale of ["en", "zh-CN"] as const) {
    let launchRequests = 0;
    let cabinReads = 0;
    await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), locale);
    await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
      route.fulfill(jsonOk({ ...root, game: stagedGame })),
    );
    await page.route("**/api/composed-reference-game/v1/game/launch", (route) => {
      launchRequests += 1;
      return route.fulfill({ status: 204, body: "" });
    });
    // The mount read and the wait's first read find nothing - the farm is not loaded yet - and the
    // second one finds her cabin, which is the two readings this journey is about.
    await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) => {
      cabinReads += 1;
      return route.fulfill(jsonOk(cabinReads <= 2 ? noCabinYet : cabinArrived));
    });
    await page.route("**/api/composed-reference-game/v1/state", (route) =>
      route.fulfill(jsonOk({ ...root, game: launchRequests === 0 ? stagedGame : launchingGame })),
    );
    await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

    await page.goto(`/?locale=${locale}#profile=composed-reference-game&boot=${token}`);
    await page.getByRole("button", { name: locale === "zh-CN" ? "游戏" : "Game", exact: true }).click();
    const panel = page.getByRole("region", { name: locale === "zh-CN" ? "游戏状态" : "Game state" });
    await panel.getByRole("button", { name: locale === "zh-CN" ? "与伙伴一起玩" : "Play with companion" }).click();

    // Nothing found yet, so the panel says who is asking and how far into the budget it is.
    const reading = panel.getByTestId("cabin-launch-reading");
    await expect(reading, "a launching game with no cabin yet says the panel is reading").toBeVisible();
    const readingText = (await reading.innerText()).replace(/\s+/gu, " ").trim();
    const budget = locale === "zh-CN" ? /第 \d+ \/ 30 次/u : /read \d+ of 30\./u;
    expect(readingText, "the reading names the attempt and the whole budget").toMatch(budget);
    // And it is a progress reading, not a failure: the cabin simply is not there yet.
    expect(await reading.getAttribute("data-tone")).toBe("progress");

    // The cabin in hand is the other shape, and it says so before the list the player acts on.
    const found = panel.getByTestId("cabin-launch-found");
    await expect(found, "a launching game with her cabin in hand says that instead").toBeVisible();
    await expect(panel.getByTestId("cabin-choice-list")).toContainText("Cabin 1");
    await expect(reading, "the two readings are never both on screen").toHaveCount(0);
    readings[locale] = { reading: readingText, found: (await found.innerText()).replace(/\s+/gu, " ").trim() };
    expect(
      await page.getByTestId("game-state-panel").innerText(),
      "no internal vocabulary reaches the player",
    ).not.toContain("Host");
  }
  console.log(`[cabin-launch-copy] ${JSON.stringify(readings)}`);
});

/**
 * The budget's end, which is the one ending that is not a fact about the game.
 *
 * The wait must not poll for ever: a launch whose game never loads a farm has to leave the player
 * with a stated step. So the panel stops asking, says the cabins have not come back, names the
 * control that asks once more, and leaves that control on screen - a second chance rather than the
 * only path. `page.clock` runs the thirty reads the budget allows, so this is the real loop rather
 * than a hand-built expired state.
 */
test("a launch the game never answers leaves a stated step, and the refresh control as the second chance", async ({
  page,
}) => {
  await page.clock.install();
  let launchRequests = 0;
  let cabinReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill(jsonOk({ ...root, game: stagedGame })),
  );
  await page.route("**/api/composed-reference-game/v1/game/launch", (route) => {
    launchRequests += 1;
    return route.fulfill({ status: 204, body: "" });
  });
  // The game answers no cabin at all - the farm is never loaded - so the only ending is the budget.
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) => {
    cabinReads += 1;
    return route.fulfill(jsonOk(noCabinYet));
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill(jsonOk({ ...root, game: launchRequests === 0 ? stagedGame : launchingGame })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Play with companion" }).click();
  await expect.poll(() => launchRequests).toBe(1);
  await expect.poll(() => cabinReads, "the launch starts the panel's own asking").toBeGreaterThan(1);

  // One second of the panel's budget per step, with real time between steps for the reads those
  // seconds release to come back: the loop under test is the product's own, driven by its own timer.
  for (let second = 0; second < 35; second += 1) {
    await page.clock.runFor(1_000);
    await page.waitForTimeout(20);
  }
  const expired = panel.getByTestId("cabin-launch-wait-expired");
  await expect(expired, "the budget's end is stated, not silent").toBeVisible();
  console.log(`[cabin-launch-budget] ${cabinReads} cabin request(s): ${await expired.innerText()}`);
  // The budget is a fact with a number, not an open-ended cadence: the panel asked its thirty times
  // and stopped. One of the count is the mount's read; the wait's are the rest.
  expect(cabinReads).toBe(31);
  await page.clock.runFor(10_000);
  expect(cabinReads, "the panel does not keep asking after the budget").toBe(31);

  // The step it leaves: load the farm, then the refresh control - which is still on screen and
  // still a live read on this connection.
  await expect(expired).toContainText("Load your farm");
  const refresh = panel.getByRole("button", { name: "Read cabins again" });
  await expect(refresh, "the refresh is the second chance, not the only path").toBeVisible();
  await refresh.click();
  await expect.poll(() => cabinReads).toBe(32);
  await expect(page.getByTestId("game-surface"), "and it never left the mounted surface").toBeVisible();
});
