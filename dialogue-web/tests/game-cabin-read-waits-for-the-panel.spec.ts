/**
 * The cabin handoff is read when the panel is first SHOWN, never while the conversation is on screen.
 *
 * `<GameSurface />` is mounted for the whole ready lifetime, deliberately: the attempts it holds - a resume
 * the player is watching, a launch waiting for its cabin - have to survive a surface switch
 * (`game-arrival-reread.spec.ts`, "an in-flight Game resume survives a surface switch"). But the read that
 * effect starts is not state of the panel's: it is a cross-process discovery, the Host asking the running
 * game which cabin it can hand the companion. Gated on `ready` alone, it was spent on a panel nobody had
 * opened: measured on a fresh mount left sitting on the Chat tab, one `game/stardew/cabins` request before
 * the Game surface was ever selected.
 *
 * Two halves, one journey: the read waits for the panel, and it is still the ONE read - a player who opens
 * the panel twice does not cost two scans of the game, and "Read cabins again" stays the control that asks
 * for a second one.
 */
import { expect, test } from "./frontend-coverage";
import { draft, jsonOk, root, stubGameRead, token } from "./composed-reference-game-fixtures";

test("the cabin handoff is read on the panel's first arrival, not before it", async ({ page }) => {
  let cabinReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await stubGameRead(page, () => root.game);
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: ["no-candidates"] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) => {
    cabinReads += 1;
    return route.fulfill(jsonOk({ apiVersion: 1, choices: [] }));
  });
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  // The shell is ready and the surface exists; the player is reading their conversation.
  await page.waitForTimeout(750);
  expect(cabinReads, "a cabin discovery may not be spent for a panel nobody opened").toBe(0);

  // The first arrival pays it - the panel is never a stale handoff when it appears.
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
  await expect.poll(() => cabinReads).toBe(1);

  // And arriving again does not scan the game again: one read per surface lifetime, not one per switch.
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
  await page.waitForTimeout(750);
  expect(cabinReads, "a second arrival is not a second cabin discovery").toBe(1);
});
