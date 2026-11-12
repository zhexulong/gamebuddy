/**
 * The Stop and Disconnect controls, and what a second read of the attachment does to them.
 *
 * Stop is generation-bound and single-flight, it is independent from the Chat surface's own
 * stop, and a stale generation rereads instead of mutating. A failed disconnect reread leaves
 * the player a fresh-key retry; an attached drawer's disconnect is one command even when the
 * control is pressed twice.
 */
import { expect, test } from "./frontend-coverage";
import { token, csrfToken, draft, game, root, openGameDrawer } from "./composed-reference-game-fixtures";

test("Game STOP is generation-bound, single-flight, rereads stopped, and remains independent from Chat Stop", async ({ page }) => {
  let stopRequests = 0;
  let stateRequests = 0;
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "connected_idle",
    },
  };
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
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      expectedAttachmentGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    const projection = stopRequests === 0 ? attachedGame : stoppedGame;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: projection }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const gameStop = panel.getByRole("button", { name: "Stop game" });
  await expect(gameStop).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await gameStop.dblclick();
  await expect.poll(() => stopRequests).toBe(1);
  await expect.poll(() => stateRequests).toBe(2);
  await expect(panel).toContainText("ConnectionStopped");
  await expect(gameStop).toHaveCount(0);
  // The conversation is a peer surface, so proving it stayed independent of the
  // Game surface means returning to it and finding it untouched.
  await page.goBack();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByText("A durable delegated draft.")).toBeVisible();
});


test("stale-generation Game STOP rereads a newer attachment without mutating it", async ({ page }) => {
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "connected_idle",
    },
  };
  const newerGame = {
    ...attachedGame,
    game: { ...attachedGame.game, attachment: { status: "attached", generation: 2 } },
  };
  let stopRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stop", async (route) => {
    stopRequests += 1;
    expect(route.request().postDataJSON()).toMatchObject({ expectedAttachmentGeneration: 1 });
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "game_attachment_conflict" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    const projection = stopRequests === 0 ? attachedGame : newerGame;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: projection }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Stop game" }).click();
  await expect.poll(() => stopRequests).toBe(1);
  await expect(panel.getByRole("button", { name: "Stop game" })).toBeVisible();
  await expect(panel).not.toContainText("The game stop result is uncertain");
  await page.waitForTimeout(50);
  expect(stopRequests).toBe(1);
});


test("uncertain Game STOP preserves its generation key and renders authoritative failed state without retry", async ({ page }) => {
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 2 },
      connectionStatus: "connected_idle",
    },
  };
  const failedGame = {
    ...attachedGame,
    game: { ...attachedGame.game, connectionStatus: "failed" },
  };
  const keys: string[] = [];
  let stateRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stop", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string; expectedAttachmentGeneration: number };
    keys.push(command.idempotencyKey);
    expect(command.expectedAttachmentGeneration).toBe(2);
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "state_unavailable" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    const projection = keys.length === 0 ? attachedGame : failedGame;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: projection }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Stop game" }).click();
  await expect.poll(() => keys.length).toBe(1);
  await expect.poll(() => stateRequests).toBe(2);
  await expect(panel).toContainText("ConnectionConnection failed");
  await expect(panel.getByRole("button", { name: "Stop game" })).toHaveCount(0);
  await expect(panel).toContainText("The game stop result is uncertain");
  await page.waitForTimeout(50);
  expect(keys).toHaveLength(1);
});


test("failed Game disconnect reread permits a fresh-key user retry", async ({ page }) => {
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "connected_idle",
    },
  };
  const failedGame = {
    ...attachedGame,
    game: { ...attachedGame.game, connectionStatus: "failed" },
  };
  const keys: string[] = [];
  let stateReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/disconnect", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string };
    keys.push(command.idempotencyKey);
    if (keys.length === 1) {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "state_unavailable" }) });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    const projection = keys.length === 0 ? { ...root, game: attachedGame } : keys.length === 1 ? { ...root, game: failedGame } : root;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(projection),
    });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const disconnect = panel.getByRole("button", { name: "Disconnect game" });
  await disconnect.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect(panel).toContainText("ConnectionConnection failed");
  await disconnect.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
  await expect.poll(() => stateReads).toBe(3);
  await expect(disconnect).toHaveCount(0);
});


test("attached Game drawer disconnect is distinct, double-activation is one command, and rereads none", async ({ page }) => {
  let disconnectRequests = 0;
  let stateRequests = 0;
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "connected_idle",
    },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/disconnect", async (route) => {
    disconnectRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      expectedAttachmentGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    const projection = disconnectRequests === 0 ? { ...root, game: attachedGame } : root;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(projection) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const disconnect = panel.getByRole("button", { name: "Disconnect game" });
  await expect(disconnect).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await disconnect.dblclick();
  await expect.poll(() => disconnectRequests).toBe(1);
  await expect.poll(() => stateRequests).toBe(2);
  await expect(panel).toContainText("ConnectionNo game connection");
  await expect(disconnect).toHaveCount(0);
});

