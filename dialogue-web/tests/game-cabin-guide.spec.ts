/**
 * Choosing the farm's cabin, and the three ways that read can come back.
 *
 * A cabin list read before the game started is a state with a next step rather than a fault; a
 * farm with no cabin offers the refresh in place; and the live no-cabin refusal offers the same
 * refresh. Reloading is never required, because it drops the Host connection and the session
 * attachment the setup was part of.
 */
import { expect, test } from "./frontend-coverage";
import { token, draft, game, root, openGameDrawer } from "./composed-reference-game-fixtures";

/**
 * A farm with no cabin at all is a dead end unless the panel can ask again.
 *
 * Measured before this change: the empty answer rendered only a sentence that ended
 * "then reload this page to choose it", and no control at all - the refresh button
 * was mounted for `unavailable | missing` only, and an empty candidate list is
 * neither. Reloading is the one thing that cannot be required here: it drops the
 * Host connection and the Game surface's own session attachment, so the instruction
 * destroyed the setup it was part of.
 *
 * The failure these catch:
 *  - the only way out of "no cabin" is a page reload, which loses the session;
 *  - the control exists but pressing it returns the identical screen, so the player
 *    cannot tell a fresh answer from the one they already read.
 */
const RELOAD_INSTRUCTION = /reload|刷新本页|重新加载/iu;


/**
 * The first-run handoff, measured against design/research/game-first-run-review-2026-10-21.md: three
 * places where the panel only said what to do after the player had already done it wrong, or said
 * nothing at all. Each assertion fails against the copy those screens shipped.
 *
 * The first of the three - step 1's two equal-weight controls, whose one accepted order reached the
 * player only as a refusal - is `tests/game-start-guide-single-step.spec.ts`'s subject now: the step
 * leads with the single action the phase names and puts the other behind a disclosure.
 */
test("a cabin list read before the game started says what happened, and why reloading fixes it", async ({ page }) => {
  // The shape a launch leaves behind: a Player Host instance exists, so the handoff no longer reads as
  // "there is no session yet" - the read that failed ran when the page opened.
  const launched = {
    ...root,
    game: {
      ...game,
      game: {
        ...game.game,
        instance: { status: "running", gameTitle: "Stardew Valley", generation: 1 },
        connectionStatus: "active",
        actionAuthority: "active",
        capabilitySummary: { available: true, count: 1 },
      },
    },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(launched) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(launched) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "stardew_cabin_handoff_unavailable" }),
    }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/?after-launch=1#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const handoff = page.locator(".stardew-cabin-handoff");
  await expect(handoff).toContainText("Cabins are read while the game you launched is starting up");
  // What happened (the read ran while the game was starting), then the next step: load the farm and read again, using the control the
  // panel offers rather than a page reload.
  await expect(handoff).toContainText("Load your farm, then read them again");
  await expect(handoff.locator("button", { hasText: "Read cabins again" })).toBeVisible();
  await expect(handoff, "no internal vocabulary reaches the player").not.toContainText("Host");
  // A state with a next step, not a fault: a warning tone here taught the player that a correct first
  // run had broken.
  expect(await handoff.locator("[data-tone]").first().getAttribute("data-tone")).toBe("info");
});


test("a farm with no cabin offers the refresh in place and never asks for a reload", async ({ page }) => {
  let cabinReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  // The frozen cabin DTO admits an empty list, and the Host answers the live no-cabin
  // world with the typed refusal the second test pins. Both reach the panel as one fact.
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) => {
    cabinReads += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, choices: [] }),
    });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/?empty-cabins=1#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const handoff = page.locator(".stardew-cabin-handoff");

  // The sentence states the free automatic path first, and only then the
  // fallback: the cabin is placed on the loaded farm at no cost, and this state
  // is the report that the placement did not happen.
  await expect(handoff, "the player is told the cabin is normally placed for free").toContainText(
    "Her cabin is normally placed on your farm for you at no cost when you load it",
  );
  await expect(handoff, "and that this state is that placement having failed").toContainText(
    "Seeing this means that did not happen",
  );
  await expect(handoff, "the fallback keeps Robin and where").toContainText(
    "You can also have Robin build one on your farm as a fallback",
  );
  await expect(handoff).not.toContainText("No cabins are currently available.");

  // (a) the control is present, in the state with no cabin.
  const refresh = handoff.getByRole("button", { name: "Read cabins again" });
  await expect(refresh, "no cabin is a state the player can ask again from").toBeVisible();

  // (b) no rendered string tells the player to reload the page - not the handoff, not the
  // step that holds it, not the panel around it.
  expect(await handoff.innerText(), "the handoff asks for no reload").not.toMatch(RELOAD_INSTRUCTION);
  expect(
    await page.locator('[data-guide-step="3"]').innerText(),
    "neither does the step the handoff sits in",
  ).not.toMatch(RELOAD_INSTRUCTION);
  expect(
    await page.getByTestId("game-state-panel").innerText(),
    "and the panel's own rendered text never asks for one",
  ).not.toMatch(RELOAD_INSTRUCTION);

  // The refresh is a live read on this session, not a reload: one more request to the
  // cabin route, no navigation away from the mounted surface.
  await refresh.click();
  await expect(handoff, "a settled re-read that is still empty says which read this is")
    .toContainText("Just read again: this is still the answer.");
  expect(cabinReads, "the control re-read the cabins on the live connection").toBe(2);
  await expect(page.getByTestId("game-surface"), "the surface is still the one that was mounted").toBeVisible();

  // It is an answer, not a poll: no read happens without the player asking again.
  await page.waitForTimeout(400);
  expect(cabinReads, "nothing re-read the cabins behind the player's back").toBe(2);
});


test("the live no-cabin refusal offers the same refresh instead of a reload", async ({ page }) => {
  // What the Host really answers for a loaded world that advertises no usable cabin:
  // `readCabinChoices` refuses the empty list with `stardew_player_host_cabin_unavailable`
  // (host/src/stardew-production-lifecycle-coordinator.internal.ts:1826), and the read
  // route maps it to `stardew_player_host_cabin_missing`
  // (host/src/composed-reference-game-browser.ts:641-646).
  let cabinReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) => {
    cabinReads += 1;
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "stardew_player_host_cabin_missing", cause: "stardew_player_host_cabin_unavailable" }),
    });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/?no-cabin-refusal=1#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const handoff = page.locator(".stardew-cabin-handoff");
  await expect(handoff).toContainText("You can also have Robin build one on your farm as a fallback");
  const refresh = handoff.getByRole("button", { name: "Read cabins again" });
  await expect(refresh, "the refusal a player can fix still offers the ask-again control").toBeVisible();
  expect(await handoff.innerText(), "the live refusal asks for no reload either").not.toMatch(RELOAD_INSTRUCTION);

  await refresh.click();
  await expect(handoff).toContainText("Just read again: this is still the answer.");
  expect(cabinReads).toBe(2);
});
