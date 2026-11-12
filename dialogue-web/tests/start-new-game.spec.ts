/**
 * Start new game: one create command, and the surface that must not appear without it.
 *
 * The form submits the exact create command and converges on the Host's own reopened
 * projection; a refused Create never projects a session and keeps a fresh idempotency key per
 * attempt; and Retry, Cancel and Start new game stay hidden unless the failed-resume surface
 * is what the player is looking at.
 */
import { expect, test } from "./frontend-coverage";
import { token, csrfToken, draft, game, root, openGameDrawer } from "./composed-reference-game-fixtures";

test("Start new game form submits the exact create command and converges on the authoritative ready-actions-paused projection", async ({ page }) => {
  const failedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "failed",
    },
  };
  const createdGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 2 },
      connectionStatus: "connected_idle",
      actionAuthority: "paused",
      selectedWorld: "farm-2",
      selectedSave: "save-2",
    },
  };
  const sessionId = "S".repeat(32);
  const createKeys: string[] = [];
  let stateRequests = 0;
  let tavernMutationRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: failedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/resume", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "unavailable" }) });
  });
  await page.route("**/api/composed-reference-game/v1/game/create", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string; integrationId: string; continuityIdentityId: string | null };
    createKeys.push(command.idempotencyKey);
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(command).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      integrationId: "stardew",
      continuityIdentityId: "continuity-identity-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "attached", gameSessionId: sessionId }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    // Before the create is admitted the authoritative rereads keep returning
    // the failed surface; once the session is resumable the projection shows
    // the new ready-actions-paused attachment generation.
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: createKeys.length === 0 ? failedGame : createdGame }) });
  });
  await page.route("**/api/tavern/v1/bootstrap", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/messages**", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/turns/*/cancel", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Resume game" }).click();
  await expect(panel.getByRole("button", { name: "Start new game" })).toBeVisible();
  await panel.getByRole("button", { name: "Start new game" }).click();
  await expect(panel.getByText("Start a new game session")).toBeVisible();
  await expect(panel.locator("form")).toContainText("stardew");
  await expect(panel).not.toContainText(sessionId);
  const continuity = panel.getByLabel("Continuity binding");
  await continuity.fill("continuity-identity-1");
  const submit = panel.getByRole("button", { name: "Create", exact: true });
  await submit.dblclick();
  await expect.poll(() => createKeys.length).toBe(1);
  // The bounded authoritative rereads converge on the new ready-actions-paused
  // attachment: the paused projection is the sole runtime success, no
  // accepted/attached transport text and no session handle is projected.
  await expect.poll(() => stateRequests).toBeGreaterThanOrEqual(2);
  await expect(panel.getByText("Start a new game session")).toHaveCount(0);
  await expect(panel.getByText("Game actions are paused.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Resume actions", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Start new game" })).toHaveCount(0);
  await expect(panel).not.toContainText("accepted");
  await expect(panel).not.toContainText("attached");
  await expect(panel).not.toContainText(sessionId);
  await expect(panel).not.toContainText("continuity-identity-1");
  await page.waitForTimeout(50);
  expect(createKeys).toHaveLength(1);
  expect(tavernMutationRequests).toBe(0);
});


test("Start new game fails closed on Create, never projects a session, and keeps a fresh per-attempt idempotency key", async ({ page }) => {
  const failedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "failed",
    },
  };
  const sessionId = "S".repeat(32);
  const keys: string[] = [];
  let createRequests = 0;
  let stateRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: failedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/resume", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "unavailable" }) });
  });
  await page.route("**/api/composed-reference-game/v1/game/create", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string };
    keys.push(command.idempotencyKey);
    createRequests += 1;
    if (createRequests === 1) {
      // Fail closed with the null-handle unavailable outcome: no resumable
      // half-record was left behind, so a next attempt is a new attempt.
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "unavailable", gameSessionId: null }) });
      return;
    }
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "game_unavailable" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: failedGame }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Resume game" }).click();
  await expect(panel).toContainText("could not be resumed right now");
  await panel.getByRole("button", { name: "Start new game" }).click();
  const submit = panel.getByRole("button", { name: "Create", exact: true });
  await submit.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect(panel).toContainText("could not be created right now");
  // The form stays open and the failure surface survives: no session handle,
  // no ready projection, no synthetic success.
  await expect(panel.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Start new game" })).toBeVisible();
  await expect(panel).not.toContainText("Game actions are paused.");
  await expect(panel).not.toContainText(sessionId);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
  await expect(panel).toContainText("could not be created");
  await expect(panel).not.toContainText(sessionId);
  await page.waitForTimeout(50);
  expect(createRequests).toBe(2);
});


test("Retry, Cancel, and Start new game stay hidden outside the failed-resume surface", async ({ page }) => {
  const scenarios = [
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "connected_idle" }, connectionText: "Connected" },
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "failed" }, connectionText: "Connection failed" },
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "disconnected" }, connectionText: "Disconnected" },
    { overrides: { attachment: { status: "none", generation: 0 }, connectionStatus: "none" }, connectionText: "No game connection" },
  ];
  let currentGame = game;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: currentGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    currentGame = { ...game, game: { ...game.game, ...scenario.overrides } };
     await page.goto(`/?scenario=${scenarioIndex}#profile=composed-reference-game&boot=${token}`);
     await openGameDrawer(page);
     const panel = page.getByRole("region", { name: "Game state" });
    await expect(panel).toContainText(`Connection${scenario.connectionText}`);
    await expect(panel.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Start new game" })).toHaveCount(0);
    await expect(panel.locator("form")).toHaveCount(0);
  }
});

