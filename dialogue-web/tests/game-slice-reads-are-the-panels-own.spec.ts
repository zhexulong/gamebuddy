/**
 * The Game panel's reads are the game's own: the game slice, never the whole conversation.
 *
 * `GameSurface.rereadGame` runs after every Game command and once a second through both bounded waits
 * (the cabin/attachment handoff, the reopen/resume convergence). It used to read the aggregate root, so a
 * launch made the panel pull the entire Chat snapshot once a second: measured on a 200-message
 * conversation, 35 135 B per poll of which 34 303 B was the Chat half and 683 B the game's - and, on the
 * Host, one durable transcript re-projection (`facade.read()` -> `threads.resumeThread`) per poll for a
 * transcript this surface renders no field of.
 *
 * Two readings, one journey, because the saving has two halves and a fallback would keep paying the cost:
 *
 *   1. the panel's Game reads arrive on `GET …/game` (they are the wait's own polls), and
 *   2. NOT ONE of them arrives on `GET …/state`, which is what a client silently falling back to the
 *      aggregate route would do while still looking healthy.
 */
import { expect, test } from "./frontend-coverage";
import { draft, jsonOk, openGameDrawer, root, stagedGame, token } from "./composed-reference-game-fixtures";

/** The projection an admitted launch publishes: the Player Host slot is `launching`. */
const launchingGame = {
  ...stagedGame,
  game: {
    ...stagedGame.game,
    instance: { status: "launching" as const, gameTitle: "Stardew Valley", generation: 1 },
  },
};

const noCabinYet = { apiVersion: 1, choices: [] };

test("a launch's own polls are the game slice's reads, and carry no conversation", async ({ page }) => {
  let stateReads = 0;
  let gameReads = 0;
  let cabinReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill(jsonOk({ ...root, game: stagedGame })),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill(jsonOk({ ...root, game: stagedGame }));
  });
  await page.route("**/api/composed-reference-game/v1/game", (route) => {
    gameReads += 1;
    return route.fulfill(jsonOk(launchingGame));
  });
  await page.route("**/api/composed-reference-game/v1/game/launch", (route) => route.fulfill({ status: 204, body: "" }));
  // The farm never loads, so the handoff keeps asking for as long as this journey watches it.
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) => {
    cabinReads += 1;
    return route.fulfill(jsonOk(noCabinYet));
  });
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await expect.poll(() => cabinReads, "the surface reads the cabins once when it is ready").toBe(1);

  // The baseline is taken after a quiet second, so the shell's own mount and arrival reads are already
  // behind it and nothing but the launch can move either number.
  await page.waitForTimeout(1_000);
  const stateBeforeLaunch = stateReads;
  const gameBeforeLaunch = gameReads;

  await panel.getByRole("button", { name: "Start the game" }).click();
  // Three of the wait's one-second hops, with the cabin never arriving.
  await page.waitForTimeout(3_500);

  const gamePolls = gameReads - gameBeforeLaunch;
  const statePolls = stateReads - stateBeforeLaunch;
  console.log(`[game-slice-reads] game reads: ${gamePolls}, state reads during the same wait: ${statePolls}`);
  expect(gamePolls, "the wait's polls are the game slice's own reads").toBeGreaterThan(1);
  expect(
    statePolls,
    "and not one of those polls carries the conversation - no fallback to the aggregate route",
  ).toBe(0);
});
