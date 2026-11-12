/**
 * Resume and reopen: the two ways an existing Game session is taken up again.
 *
 * Both are generation-bound and single-flight, both reread the authoritative attachment, and
 * neither may render a completion the Host did not report. Unavailable and failed keep their
 * generation key for an exact player replay; a stale generation rereads a newer attachment
 * without mutating or failing it; and every control that only makes sense inside one
 * projection stays hidden outside it.
 */
import { expect, test } from "./frontend-coverage";
import {
  token,
  csrfToken,
  draft,
  game,
  root,
  progressStatus,
  openGameDrawer,
} from "./composed-reference-game-fixtures";

test("Game Resume is generation-bound and single-flight, rereads authoritative state, and renders no synthetic completion", async ({ page }) => {
  let resumeRequests = 0;
  let stateRequests = 0;
  let tavernMutationRequests = 0;
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "failed",
    },
  };
  const resumedGame = {
    ...attachedGame,
    game: { ...attachedGame.game, connectionStatus: "connected_idle" },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/resume", async (route) => {
    resumeRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      expectedAttachmentGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "attached" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    const projection = resumeRequests === 0 ? attachedGame : resumedGame;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: projection }) });
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
  await page.route("**/api/tavern/v1/message-submission-status", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const resume = panel.getByRole("button", { name: "Resume game" });
  await expect(resume).toBeVisible();
  await resume.dblclick();
  await expect.poll(() => resumeRequests).toBe(1);
  await expect.poll(() => stateRequests).toBe(2);
  await expect(panel).toContainText("ConnectionConnected");
  await expect(resume).toHaveCount(0);
  await expect(panel).not.toContainText("The game could not be resumed");
  await expect(panel).not.toContainText("accepted");
  await expect(panel).not.toContainText("generation: 1");
  // The conversation is a peer surface, so proving it stayed independent of the
  // Game surface means returning to it and finding it untouched.
  await page.goBack();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByText("A durable delegated draft.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("The game projection is read-only.");
  expect(tavernMutationRequests).toBe(0);
});


test("Game Resume stays in flight on an accepted admission while authoritative state stays disconnected", async ({ page }) => {
  let resumeRequests = 0;
  let stateRequests = 0;
  let tavernMutationRequests = 0;
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "disconnected",
    },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/resume", async (route) => {
    resumeRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      expectedAttachmentGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "accepted" }) });
  });
  // The authoritative projection keeps returning the same-generation
  // attached/disconnected state: the accepted admission is never runtime
  // completion, so the bounded convergence rereads keep going.
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) });
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
  await page.route("**/api/tavern/v1/message-submission-status", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const resume = panel.getByRole("button", { name: "Resume game" });
  await expect(resume).toBeVisible();
  await resume.dblclick();
  await expect.poll(() => resumeRequests).toBe(1);
  // The accepted admission keeps the attempt visibly in flight and disabled.
  await expect(progressStatus(panel)).toContainText("Resuming the game connection...");
  await expect(resume).toBeDisabled();
  // At least one authoritative reread confirms the projection is still the
  // same-generation attached/disconnected state rather than converged.
  await expect.poll(() => stateRequests).toBeGreaterThanOrEqual(2);
  await expect(panel).toContainText("ConnectionDisconnected");
  // The Resume stays visibly in progress and disabled across the rereads, with
  // no synthetic success/accepted/completion text projected.
  await expect(progressStatus(panel)).toContainText("Resuming the game connection...");
  await expect(resume).toBeDisabled();
  await expect(panel).not.toContainText("accepted");
  await expect(panel).not.toContainText("could not be resumed");
  await expect(panel).not.toContainText("ConnectionConnected");
  await page.waitForTimeout(100);
  expect(resumeRequests).toBe(1);
  // The transcript is the conversation surface, so reaching it means returning to
  // it: the Game surface is a peer, not an overlay over the transcript.
  await page.goBack();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("The game projection is read-only.");
  expect(tavernMutationRequests).toBe(0);
  // The test returns while the bounded reread budget (60 x 500ms) still has
  // time left; page teardown cancels the outstanding reread timers.
});


test("unavailable Game Resume preserves its generation key for an idempotent exact player replay", async ({ page }) => {
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 2 },
      connectionStatus: "failed",
    },
  };
  const keys: string[] = [];
  let stateRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/resume", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string; expectedAttachmentGeneration: number };
    keys.push(command.idempotencyKey);
    expect(command.expectedAttachmentGeneration).toBe(2);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "unavailable" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const resume = panel.getByRole("button", { name: "Resume game" });
  await resume.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect.poll(() => stateRequests).toBe(1);
  await expect(panel).toContainText("ConnectionConnection failed");
  await expect(panel).toContainText("could not be resumed right now");
  // One command, one control: the failed attempt hands the same generation-bound
  // retry over to the failure rollup, so `Resume game` is not offered a second
  // time beside its own recovery name.
  await expect(resume).toHaveCount(0);
  const retry = panel.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  await expect.poll(() => stateRequests).toBe(2);
  await expect(panel).toContainText("could not be resumed right now");
  await page.waitForTimeout(50);
  expect(keys).toHaveLength(2);
});


test("stale-generation Game Resume rereads a newer attachment without mutating or failing it", async ({ page }) => {
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "failed",
    },
  };
  const newerGame = {
    ...attachedGame,
    game: { ...attachedGame.game, attachment: { status: "attached", generation: 2 } },
  };
  const keys: string[] = [];
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: attachedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/resume", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string; expectedAttachmentGeneration: number };
    keys.push(command.idempotencyKey);
    if (keys.length === 1) {
      expect(command.expectedAttachmentGeneration).toBe(1);
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "game_attachment_conflict" }) });
      return;
    }
    expect(command.expectedAttachmentGeneration).toBe(2);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "attached" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    const projection = keys.length === 0 ? attachedGame : newerGame;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: projection }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const resume = panel.getByRole("button", { name: "Resume game" });
  await resume.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect(panel).not.toContainText("The game could not be resumed");
  const newerResume = panel.getByRole("button", { name: "Resume game" });
  await newerResume.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
  await expect(panel).not.toContainText("The game could not be resumed");
  await page.waitForTimeout(50);
  expect(keys).toHaveLength(2);
});


test("resume-phase syncing projection passes the browser gate, visualizes sync, and never claims connected or resumable", async ({ page }) => {
  const syncingGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "syncing",
    },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: syncingGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  // The syncing resume-phase status passes the browser gate: the authoritative
  // projection renders instead of failing closed.
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(panel).toContainText("ConnectionSyncing");
  await expect(progressStatus(panel)).toContainText("Syncing the game connection...");
  // syncing is neither resumable nor connected, so no Resume/Stop control is
  // offered and the connected vocabulary is never claimed.
  await expect(panel.getByRole("button", { name: "Resume game" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Stop game" })).toHaveCount(0);
  await expect(panel).not.toContainText("connected_idle");
  // The conversation is a peer surface, so proving it stayed independent of the
  // Game surface means returning to it and finding it untouched.
  await page.goBack();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByText("A durable delegated draft.")).toBeVisible();
});

test("ready-actions-paused renders the Resume actions control and converges on the authoritative reopened projection", async ({ page }) => {
  let reopenRequests = 0;
  let stateRequests = 0;
  let tavernMutationRequests = 0;
  const pausedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "connected_idle",
      actionAuthority: "paused",
    },
  };
  const reopenedGame = {
    ...pausedGame,
    game: { ...pausedGame.game, actionAuthority: "active" },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: pausedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/reopen", async (route) => {
    reopenRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      expectedAttachmentGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "reopened" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    const projection = reopenRequests === 0 ? pausedGame : reopenedGame;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: projection }) });
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
  await page.route("**/api/tavern/v1/message-submission-status", async (route) => {
    tavernMutationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await expect(panel).toContainText("ConnectionConnected");
  const reopen = panel.getByRole("button", { name: "Resume actions", exact: true });
  await expect(reopen).toBeVisible();
  await expect(panel.getByText("Game actions are paused.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await reopen.dblclick();
  await expect.poll(() => reopenRequests).toBe(1);
  // The strict `reopened` result is never projected as synthetic success; the
  // composed authoritative Game projection must converge to actionAuthority
  // active at the same attachment generation before the drawer updates.
  await expect.poll(() => stateRequests).toBeGreaterThanOrEqual(1);
  await expect(reopen).toHaveCount(0);
  await expect(panel.getByText("Game actions are paused.")).toHaveCount(0);
  await expect(panel).not.toContainText("could not be resumed");
  await expect(panel).not.toContainText("reopened");
  // The conversation is a peer surface, so proving it stayed independent of the
  // Game surface means returning to it and finding it untouched.
  await page.goBack();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByText("A durable delegated draft.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("The game projection is read-only.");
  expect(tavernMutationRequests).toBe(0);
});


test("Resume actions stays hidden outside the ready-actions-paused projection", async ({ page }) => {
  const scenarios = [
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "connected_idle", actionAuthority: "active" }, connectionText: "Connected" },
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "connected_idle", actionAuthority: "unavailable" }, connectionText: "Connected" },
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "syncing", actionAuthority: "paused" }, connectionText: "Syncing…" },
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "reconnecting", actionAuthority: "paused" }, connectionText: "Reconnecting…" },
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "failed", actionAuthority: "paused" }, connectionText: "Connection failed" },
    { overrides: { attachment: { status: "attached", generation: 1 }, connectionStatus: "disconnected", actionAuthority: "paused" }, connectionText: "Disconnected" },
    { overrides: {}, connectionText: "No game connection" },
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
    // A fresh query keeps every iteration a real document navigation: the app
    // strips the boot token from the hash on first mount, so fragment-only
    // gotos would skip the bootstrap fetch and replay the previous projection.
     await page.goto(`/?scenario=${scenarioIndex}#profile=composed-reference-game&boot=${token}`);
     await openGameDrawer(page);
     const panel = page.getByRole("region", { name: "Game state" });
    await expect(panel).toContainText(`Connection${scenario.connectionText}`);
    await expect(panel.getByRole("button", { name: "Resume actions", exact: true })).toHaveCount(0);
    await expect(panel.getByText("Game actions are paused.")).toHaveCount(0);
  }
});


test("failed Game reopen renders no synthetic success and preserves its generation key for an idempotent exact replay", async ({ page }) => {
  const pausedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 2 },
      connectionStatus: "connected_idle",
      actionAuthority: "paused",
    },
  };
  const keys: string[] = [];
  let stateRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: pausedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/reopen", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string; expectedAttachmentGeneration: number };
    keys.push(command.idempotencyKey);
    expect(command.expectedAttachmentGeneration).toBe(2);
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "state_unavailable" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: pausedGame }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const reopen = panel.getByRole("button", { name: "Resume actions", exact: true });
  await reopen.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect.poll(() => stateRequests).toBe(1);
  // Fail closed: the failure is presented, the authoritative paused projection
  // is retained, and no synthetic reopened success is ever projected.
  await expect(panel).toContainText("The game actions could not be resumed");
  await expect(panel.getByText("Game actions are paused.")).toBeVisible();
  await expect(panel).not.toContainText("reopened");
  await expect(reopen).toBeVisible();
  // A player retry replays the exact same idempotent envelope at the same
  // generation because no side effect or success was ever established.
  await reopen.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  await expect.poll(() => stateRequests).toBe(2);
  await expect(panel).toContainText("The game actions could not be resumed");
  await page.waitForTimeout(50);
  expect(keys).toHaveLength(2);
});


test("stale-generation Game reopen rereads a newer attachment without mutating or failing it", async ({ page }) => {
  const pausedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "connected_idle",
      actionAuthority: "paused",
    },
  };
  const newerGame = {
    ...pausedGame,
    game: { ...pausedGame.game, attachment: { status: "attached", generation: 2 } },
  };
  const keys: string[] = [];
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: pausedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/reopen", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string; expectedAttachmentGeneration: number };
    keys.push(command.idempotencyKey);
    if (keys.length === 1) {
      expect(command.expectedAttachmentGeneration).toBe(1);
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "game_attachment_conflict" }) });
      return;
    }
    expect(command.expectedAttachmentGeneration).toBe(2);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "reopened" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    const projection = keys.length === 0 ? pausedGame : newerGame;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: projection }) });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const reopen = panel.getByRole("button", { name: "Resume actions", exact: true });
  await reopen.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect(panel).not.toContainText("The game actions could not be resumed");
  // The newer attached generation stays paused and connected, so the drawer
  // keeps offering the exact generation-bound Reopen with a fresh key.
  const newerReopen = panel.getByRole("button", { name: "Resume actions", exact: true });
  await expect(newerReopen).toBeVisible();
  await newerReopen.click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
  await expect(panel).not.toContainText("The game actions could not be resumed");
  await page.waitForTimeout(50);
  expect(keys).toHaveLength(2);
});test("failed GAME Resume surface offers Retry, Cancel, and Start new game; Cancel pins the exact reconnect generation", async ({ page }) => {
  const failedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "failed",
    },
  };
  const cancelledGame = {
    ...failedGame,
    game: { ...failedGame.game, connectionStatus: "disconnected" },
  };
  const keys: string[] = [];
  let cancelRequests = 0;
  let stateRequests = 0;
  let tavernMutationRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: failedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/resume", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string };
    keys.push(command.idempotencyKey);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "unavailable" }) });
  });
  await page.route("**/api/composed-reference-game/v1/game/resume/cancel", async (route) => {
    cancelRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      expectedAttachmentGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "cancelled" }) });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    // After the cancellation the authoritative projection shows the same
    // armed generation as disconnected; the session stays resumable.
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: cancelledGame }) });
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
  const resume = panel.getByRole("button", { name: "Resume game" });
  await resume.click();
  await expect(panel).toContainText("could not be resumed right now");
  const retry = panel.getByRole("button", { name: "Retry", exact: true });
  const cancel = panel.getByRole("button", { name: "Cancel", exact: true });
  const startNew = panel.getByRole("button", { name: "Start new game" });
  await expect(retry).toBeVisible();
  await expect(cancel).toBeVisible();
  await expect(startNew).toBeVisible();
  await cancel.dblclick();
  await expect.poll(() => cancelRequests).toBe(1);
  await expect.poll(() => stateRequests).toBeGreaterThanOrEqual(2);
  await expect(panel).toContainText("ConnectionDisconnected");
  // The cancelled epoch clears the failure surface: no stale Reopen, no
  // Retry/Cancel/Start rollup, no synthetic success text, and the session
  // stays resumable at the same armed generation.
  await expect(panel.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Start new game" })).toHaveCount(0);
  await expect(panel).not.toContainText("cancelled");
  await expect(panel).not.toContainText("could not be resumed");
  await expect(resume).toBeVisible();
  await page.waitForTimeout(50);
  expect(cancelRequests).toBe(1);
  expect(keys).toHaveLength(1);
  expect(tavernMutationRequests).toBe(0);
});

