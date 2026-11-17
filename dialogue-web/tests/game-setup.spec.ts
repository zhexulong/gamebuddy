/**
 * Game setup from the panel: the create command, and every way its reread can come back.
 *
 * Cancelled, uncertain and terminal are three different readings of the same request, and a
 * player retry after any of them must be a fresh key rather than a replay of one whose
 * outcome nobody knows. The launch generation the Host owns is projected here too, and a Chat
 * draft that moves under the reread must not be mistaken for the setup's own state.
 */
import { expect, test } from "./frontend-coverage";
import {
  token,
  csrfToken,
  draft,
  game,
  root,
  openGameDrawer,
  openStagingAlternate,
  installedRoot,
  jsonOk,
  stubGameRead,
  stagedGame,
  cabinChoiceHandle,
  expiresAtMs,
} from "./composed-reference-game-fixtures";

test("cancelled Game setup rereads unknown and a later player retry uses a fresh key", async ({ page }) => {
  const keys: string[] = [];
  let stateReads = 0;
  /**
   * Whether the reads still find the folder registered.
   *
   * The journey begins in the only shape in which the setup press is offered at all - a ready
   * installation registration, which the panel reads as `prerequisites: "met"` - and the cancelled
   * attempt's own reread is what finds it withdrawn. That is the reading the fresh-key rule is about
   * (`prerequisites: "unknown"` after the attempt), and it is also what withdraws the offer: the step
   * this state has is the installation panel's. Registering the folder again is what brings the press
   * back, and the retry below is that press.
   */
  let registered = true;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(installedRoot)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/prerequisites/setup", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string };
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    keys.push(command.idempotencyKey);
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    return route.fulfill(jsonOk(registered ? installedRoot : root));
  });
  // The panel's own re-read is the Game slice's route, and counting it here is what keeps the
  // journey's "the command caused a reread" assertion true whichever route carries it.
  await stubGameRead(page, () => {
    stateReads += 1;
    return (registered ? installedRoot : root).game;
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await openStagingAlternate(panel);
  const setup = panel.getByRole("button", { name: "Set up Stardew Valley" });
  // The attempt the Host cancelled answered without a registration, and the reread is what finds it
  // out.
  registered = false;
  await setup.click();
  await expect.poll(() => keys.length).toBe(1);
  // `stateReads` is a count of a request the surface makes on its own schedule, so a poll that
  // asks "is it exactly 1" can sample between the arrival of that read and the arrival of the next
  // one. Under the full suite's load this test read 2 here and passed in isolation - the assertion was
  // racing the surface, not measuring it. What the journey is actually about is that the cancelled
  // setup causes a reread and the later retry causes another, so the reading is taken as a floor and
  // the second half below still proves the retry added one more.
  await expect.poll(() => stateReads).toBeGreaterThanOrEqual(1);
  const readsAfterFirstAttempt = stateReads;
  // The reread withdrew the offer with the registration: the step this state offers is the
  // installation panel's, not a second press of a command whose premise is gone.
  await expect(panel.getByTestId("game-guide-step-one-alternate")).toHaveCount(0);
  await expect(panel.getByTestId("game-installation-required")).toBeVisible();
  // The player registers the folder again in that panel and comes back to this one, where the press
  // is offered once more.
  registered = true;
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await openStagingAlternate(panel);
  await panel.getByRole("button", { name: "Set up Stardew Valley" }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
  await expect.poll(() => stateReads).toBeGreaterThanOrEqual(readsAfterFirstAttempt + 1);
  await expect(panel).not.toContainText("C:\\Games\\Stardew Valley");
});


test("terminal Game setup failure permits only an authoritative fresh-key player retry", async ({ page }) => {
  const keys: string[] = [];
  let stateReads = 0;
  // The control-bearing journey mounts the projection the press needs (`installedRoot`): setup is
  // offered while a ready installation registration exists, and the projection never moves here, so
  // the reading below is about the command's own terminal answer and the retry's key.
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(installedRoot)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/prerequisites/setup", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string };
    keys.push(command.idempotencyKey);
    if (keys.length === 1) {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "game_unavailable" }) });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill(jsonOk(installedRoot));
  });
  await stubGameRead(page, () => {
    stateReads += 1;
    return installedRoot.game;
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await openStagingAlternate(panel);
  const setup = panel.getByRole("button", { name: "Set up Stardew Valley" });
  await setup.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect.poll(() => stateReads).toBe(1);
  await expect(panel).toContainText("Game setup could not be verified");
  await setup.click();
  await expect.poll(() => keys.length).toBe(2);
  // The retry is a fresh-key attempt because the authoritative reading proves this attempt staged
  // nothing (`setupStagedNothing`), which is the fact the rule reads - not whether a game folder is
  // registered. The folder IS registered here: that is the shape the press is offered in.
  expect(keys[1]).not.toBe(keys[0]);
  await expect.poll(() => stateReads).toBe(2);
  await expect(panel).not.toContainText("C:\\Games\\Stardew Valley");
});


test("uncertain Game setup reread preserves the exact key for manual replay", async ({ page }) => {
  const keys: string[] = [];
  let stateReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(installedRoot)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/prerequisites/setup", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string };
    keys.push(command.idempotencyKey);
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "state_unavailable" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill(jsonOk(installedRoot));
  });
  await stubGameRead(page, () => {
    stateReads += 1;
    return installedRoot.game;
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await openStagingAlternate(panel);
  const setup = panel.getByRole("button", { name: "Set up Stardew Valley" });
  await setup.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect.poll(() => stateReads).toBe(1);
  await setup.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  await expect.poll(() => stateReads).toBe(2);
  await expect(panel).toContainText("Game setup could not be verified");
  await expect(panel).not.toContainText("C:\\Games\\Stardew Valley");
});


test("Game setup projects Host-owned launch generation and launch rereads actual lifecycle state", async ({ page }) => {
  let setupRequests = 0;
  let launchRequests = 0;
  let stateReads = 0;
  const stagedGame = {
    ...game,
    game: {
      ...game.game,
      prerequisites: { status: "met", detectedGame: "Stardew Valley" },
      instance: { status: "none", gameTitle: null, generation: 1 },
    },
  };
  const launchingGame = {
    ...stagedGame,
    game: {
      ...stagedGame.game,
      instance: { status: "launching", gameTitle: "Stardew Valley", generation: 0 },
    },
  };
  // The press is offered only while the registration exists, so the mount is the installed shape; the
  // transition this journey measures is the one the setup command's own reread publishes
  // (installed -> staged -> launching), and it is the same transition it measured before.
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(installedRoot)));
  // The mount read finds no cabin - the farm is not loaded - and the post-launch wait's first ask
  // finds hers. That is what ends the wait, so this journey spends no budget: the launch's own
  // reread is the last state read before it, and the wait's attempt is the one after.
  let cabinReads = 0;
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) => {
    cabinReads += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        cabinReads === 1
          ? { apiVersion: 1, choices: [] }
          : {
              apiVersion: 1,
              choices: [
                { displayLabel: "Cabin 1", availability: "available", choiceHandle: cabinChoiceHandle, expiresAtMs },
              ],
            },
      ),
    });
  });
  await page.route("**/api/composed-reference-game/v1/game/prerequisites/setup", async (route) => {
    setupRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    });
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/composed-reference-game/v1/game/launch", async (route) => {
    launchRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      expectedInstanceGeneration: 1,
    });
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    const projection = setupRequests === 0 ? installedRoot.game : launchRequests === 0 ? stagedGame : launchingGame;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: projection }) });
  });
  // The panel's own re-read is the Game slice's route: the same projection this journey moves
  // through, counted as the reread the command caused.
  await stubGameRead(page, () => {
    stateReads += 1;
    return setupRequests === 0 ? installedRoot.game : launchRequests === 0 ? stagedGame : launchingGame;
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await openStagingAlternate(panel);
  await panel.getByRole("button", { name: "Set up Stardew Valley" }).click();
  await expect.poll(() => setupRequests).toBe(1);
  await expect.poll(() => stateReads).toBe(2);
  const launch = panel.getByRole("button", { name: "Start the game" });
  await expect(launch).toBeVisible();
  await expect(panel).not.toContainText("generation: 1");
  await expect(panel).not.toContainText("C:\\Games\\Stardew Valley");
  await launch.dblclick();
  await expect.poll(() => launchRequests).toBe(1);
  // Four reads: the mount's own, the setup's authoritative reread (the two the assertions above
  // count), the launch's authoritative reread, and the one the post-launch cabin wait takes before it
  // finds her cabin and stops.
  await expect.poll(() => stateReads).toBe(4);
  await expect.poll(() => cabinReads).toBe(2);
  await expect(panel).toContainText("InstanceStardew Valley");
  await expect(launch).toHaveCount(0);
  // The conversation is a peer surface, so proving it stayed independent of the
  // Game surface means returning to it and finding it untouched.
  await page.goBack();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByText("A durable delegated draft.")).toBeVisible();
});


/**
 * The surfaces are peers (design/architecture/product-surfaces.md): neither owns
 * or interrupts the other. A Game operation's authoritative reread must depend
 * only on the Game projection, so a Chat draft revision that moves underneath it
 * - the player typing in the conversation, another tab, a background poll - can
 * never turn into a Game failure. Here the ONLY thing that moves under the Game
 * reread is Chat's draft: the Game projection is unchanged and the setup command
 * succeeds, so the operation must complete.
 *
 * The premise this journey was written on has moved. It used to take two reads -
 * the composed root for the Game half, `/api/tavern/v1/draft` for the Chat body -
 * and the moved revision could be observed only in the second one, so `draftReads`
 * was the instrument. The body and its revision now arrive in the one `/state`
 * read beside the Game projection (`readChatSnapshotPair`), so the moved revision is
 * served from that read and the counter says 0. The guarantee is unchanged and its
 * expression is stricter: a Game reread spends no draft read at all.
 */
test("Game setup ignores a Chat draft that moves under the composed state it rereads", async ({ page }) => {
  const keys: string[] = [];
  let stateReads = 0;
  let draftReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(installedRoot)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/prerequisites/setup", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string };
    keys.push(command.idempotencyKey);
    await route.fulfill({ status: 204, body: "" });
  });
  // The Game projection never moves: only the composed root's Chat half is served with the draft the
  // player moved to while the command was in flight (revision 5), so any Game failure here can only
  // come from Chat. The mount reads `bootstrap`, so the first `/state` here is already the Game
  // reread - and it still reports the installed Game projection the press needs.
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    const moved = {
      ...installedRoot,
      chat: {
        ...installedRoot.chat,
        chat: { ...installedRoot.chat.chat, draft: { revision: 5, present: true, text: "The player kept typing." } },
      },
    };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(moved) });
  });
  await stubGameRead(page, () => {
    stateReads += 1;
    return installedRoot.game;
  });
  // No route answers the draft here, and none is expected to: the moved revision
  // above is the only one this page can serve, and a request for the body is the
  // second read this contract removed.
  await page.route("**/api/tavern/v1/draft", (route) => {
    draftReads += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await openStagingAlternate(panel);
  const setup = panel.getByRole("button", { name: "Set up Stardew Valley" });
  await setup.click();
  // The command was admitted and its authoritative Game reread converged.
  await expect.poll(() => keys.length).toBe(1);
  await expect.poll(() => stateReads).toBe(1);
  // A Game reread never reads the Chat draft at all - not even the mount once a
  // read - because the body arrives in the `/state` it already took. The moved
  // revision therefore cannot be observed by the Game path, so it cannot fail the
  // Game operation, and a draft request here would be the pair read returning.
  expect(draftReads).toBe(0);
  // The Game operation completed: no reconciliation problem was surfaced, and
  // the unchanged authoritative projection was applied (the control stays
  // offered and a later attempt is a fresh-key attempt, not a stuck replay).
  await expect(panel).not.toContainText("Game setup could not be verified");
  await expect(setup).toBeVisible();
  await setup.click();
  await expect.poll(() => keys.length).toBe(2);
  // The second press reaches the Host again, and it need NOT carry a different key: the coordinator
  // deletes a dismissed registration from its own idempotency cache (`gameSetups.delete` on a
  // cancelled selection in `stardew-production-lifecycle-coordinator.internal.ts`), so a same-key
  // replay re-executes instead of replaying a cached success. This journey's subject is the Chat
  // draft, so what it asserts is the press reaching the Host with no draft read - the key-identity
  // rule has its own journey above, where the attempt staged nothing.
  expect(draftReads).toBe(0);
});

