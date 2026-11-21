/**
 * What a press on Stop says while it is happening, and what it says once it has happened.
 *
 * Measured 2026-11-21 (frontend run `cabinseat-r27`, world `cabinseat-r27`'s farm, a companion attached and
 * mid-turn): the press reached the Host and the product never said anything about its own stop. The panel's
 * only answer to an admitted stop was a disabled button, and the answer to a settled one was a fact row
 * changing from `connected_idle` to `stopped` - so the control a player pressed to stop the game looked like
 * one that did nothing, while the farm kept running (an ordinary stop ends the companion's authority; the
 * explicit endgame ends the world).
 *
 * The two lines these journeys hold are the difference between a control that reports and one that is silent:
 *
 *   while it is admitted   the stop is stated as in flight, which is the whole window in which the Host has
 *                          not answered yet (it answers only once its STOP - the companion's in-flight step
 *                          included - has settled).
 *   once it has settled    the stop says what it did NOT do, and names the control that does it.
 */
import { expect, test } from "./frontend-coverage";
import { csrfToken, draft, game, openGameDrawer, progressStatus, root, stubGameRead, token } from "./composed-reference-game-fixtures";

const attachedGame = {
  ...game,
  game: {
    ...game.game,
    attachment: { status: "attached", generation: 1 },
    connectionStatus: "connected_idle",
  },
};

test("a Stop the Host has not answered yet says it is stopping, and the command is on the wire", async ({ page }) => {
  let stopRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  // The Host of this journey never answers: a stop is answered only when its STOP has settled, and a
  // companion who is finishing a step owns that window. Leaving the request pending is exactly that shape.
  await page.route("**/api/composed-reference-game/v1/game/stop", (route) => {
    stopRequests += 1;
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await stubGameRead(page, attachedGame);
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Stop game" }).click();
  await expect.poll(() => stopRequests).toBe(1);
  await expect(progressStatus(panel)).toContainText("Stopping her game actions");
  await expect(progressStatus(panel)).toContainText("End game");
});

test("a settled Stop says her actions are stopped and names the control that ends the world", async ({ page }) => {
  let stopRequests = 0;
  const stoppedGame = {
    ...attachedGame,
    game: { ...attachedGame.game, connectionStatus: "stopped" },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stop", async (route) => {
    stopRequests += 1;
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await stubGameRead(page, () => (stopRequests === 0 ? attachedGame : stoppedGame));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Stop game" }).click();
  await expect.poll(() => stopRequests).toBe(1);
  // The world this Host published is still running: that is what an ordinary stop leaves behind, so the
  // panel has to say so rather than leave the player reading a farm that did not go away.
  await expect(panel.getByText("Her game actions are stopped and the world is still running.")).toBeVisible();
  await expect(panel.getByText(/End game is what ends the world/u)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Stop game" })).toHaveCount(0);
});
