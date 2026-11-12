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
  stagedGame,
} from "./composed-reference-game-fixtures";

test("cancelled Game setup rereads unknown and a later player retry uses a fresh key", async ({ page }) => {
  const keys: string[] = [];
  let stateReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
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
    stateReads += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) });
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
  // `stateReads` is a count of a request the surface makes on its own schedule, so a poll that
  // asks "is it exactly 1" can sample between the arrival of that read and the arrival of the next
  // one. Under the full suite's load this test read 2 here and passed in isolation - the assertion was
  // racing the surface, not measuring it. What the journey is actually about is that the cancelled
  // setup causes a reread and the later retry causes another, so the reading is taken as a floor and
  // the second half below still proves the retry added one more.
  await expect.poll(() => stateReads).toBeGreaterThanOrEqual(1);
  const readsAfterFirstAttempt = stateReads;
  await setup.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
  await expect.poll(() => stateReads).toBeGreaterThanOrEqual(readsAfterFirstAttempt + 1);
  await expect(panel).not.toContainText("C:\\Games\\Stardew Valley");
});


test("terminal Game setup failure permits only an authoritative fresh-key player retry", async ({ page }) => {
  const keys: string[] = [];
  let stateReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
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
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) });
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
  expect(keys[1]).not.toBe(keys[0]);
  await expect.poll(() => stateReads).toBe(2);
  await expect(panel).not.toContainText("C:\\Games\\Stardew Valley");
});


test("uncertain Game setup reread preserves the exact key for manual replay", async ({ page }) => {
  const keys: string[] = [];
  let stateReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
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
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) });
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
      prerequisites: { status: "met", detectedGame: "Stardew Valley", missingItems: [] },
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
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
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
    const projection = setupRequests === 0 ? root.game : launchRequests === 0 ? stagedGame : launchingGame;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: projection }) });
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
  const launch = panel.getByRole("button", { name: "Play with companion" });
  await expect(launch).toBeVisible();
  await expect(panel).not.toContainText("generation: 1");
  await expect(panel).not.toContainText("C:\\Games\\Stardew Valley");
  await launch.dblclick();
  await expect.poll(() => launchRequests).toBe(1);
  await expect.poll(() => stateReads).toBe(3);
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
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/prerequisites/setup", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string };
    keys.push(command.idempotencyKey);
    await route.fulfill({ status: 204, body: "" });
  });
  // The Game projection never moves: only the composed root's Game half is
  // served, exactly as it was, so any Game failure here can only come from Chat.
  // The mount reads `bootstrap`, so the first `/state` here is already the Game
  // reread - and it reports the Chat draft the player moved to while the command
  // was in flight (revision 5).
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    const moved = {
      ...root,
      chat: { ...root.chat, chat: { ...root.chat.chat, draft: { revision: 5, present: true, text: "The player kept typing." } } },
    };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(moved) });
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
  expect(keys[1]).not.toBe(keys[0]);
  expect(draftReads).toBe(0);
});

