import { expect, test, type Page } from "./frontend-coverage";

/**
 * The end-or-recover half of the Game surface, driven the way a player drives it.
 *
 * `tests/frontend-coverage-surface.md` ranked `GameStatePanel.tsx` first on the
 * strength of one fact: 54% of it was covered, and the uncovered half was
 * *entirely* the half a player needs **when things have gone wrong** - the Endgame
 * arm/confirm pair, a Stop that did not succeed, a Disconnect that did not
 * succeed, and the three ways out of a failed Resume. The gate in
 * `tests/game-lifecycle-launch-gate.test.mjs` now proves the state machine offers
 * every state a forward action; these journeys prove the controls that carry them
 * actually work over the real shell, and that the player reads what happened.
 *
 * Every test here asserts two things, and never one without the other: **the
 * sentence the player reads** and **what they can press next**. A journey that
 * only checks the sentence would pass over a state with nothing to press.
 */

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const chat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [
    { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
  ],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle, generation: 1, stateRevision: chatHandle },
  chat: {
    companion: { name: "Mira", handle: companionHandle },
    title: null,
    transcript: [],
    draft: { revision: 4, present: true },
    turn: null,
    worldInfo: null,
  },
  memory: { readAvailable: true, mutationAvailable: true, projectionRevision: null },
  eventStream: null,
};

/** The Host's Game projection, as one mutable record the routes answer from. */
type GameFacts = Readonly<Record<string, unknown>>;

const ATTACHED_CONNECTED: GameFacts = {
  prerequisites: { status: "met", detectedGame: "Stardew Valley", missingItems: [] },
  instance: { status: "running", gameTitle: "Stardew Valley", generation: 1 },
  compatibility: { status: "compatible", message: null },
  attachment: { status: "attached", generation: 1 },
  connectionStatus: "connected_idle",
  actionAuthority: "active",
  role: "companion",
  companionName: "Mira",
  selectedWorld: "The Farm",
  selectedSave: "Save One",
  capabilitySummary: { available: false, count: 0 },
  latestOutcome: "none",
};

function gameProjection(facts: GameFacts) {
  return {
    apiVersion: 1,
    build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
    csrfToken,
    browserSession: { expiresAtMs },
    game: facts,
  };
}

function composedRoot(facts: GameFacts) {
  return {
    apiVersion: 1,
    build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
    chat,
    game: gameProjection(facts),
  };
}

/** The Host routes, answered from one mutable fact record so a journey can move it mid-run. */
async function stubHost(page: Page, facts: GameFacts): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot(facts))));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot(facts))));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "state_unavailable" }),
    }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
}

const openGame = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
};

const panelOf = (page: Page) => page.getByTestId("game-state-panel");

/* ==========================================================================
   1. Endgame: the arm step, the confirm step, and what the surface says
      between them. Confirming is irreversible, so the surface must say so
      BEFORE the press, not after it.
   ========================================================================== */

test("End the game arms a confirm that says it cannot be undone, and only the confirm sends it", async ({ page }) => {
  let endgameRequests = 0;
  let facts: GameFacts = ATTACHED_CONNECTED;
  await stubHost(page, ATTACHED_CONNECTED);
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot(facts))));
  await page.route("**/api/composed-reference-game/v1/game/endgame", async (route) => {
    endgameRequests += 1;
    expect(route.request().postDataJSON()).toMatchObject({ confirm: true, expectedAttachmentGeneration: 1 });
    facts = {
      ...ATTACHED_CONNECTED,
      attachment: { status: "none", generation: 0 },
      connectionStatus: "stopped",
      actionAuthority: "unavailable",
      latestOutcome: "succeeded",
    };
    await route.fulfill(jsonOk({ apiVersion: 1, status: "gameended" }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGame(page);
  const panel = panelOf(page);

  // The arm step: one control, named for what it does.
  const open = panel.getByTestId("game-endgame-open");
  await expect(open).toBeVisible();
  await expect(open).toHaveText("End the game");
  await open.click();

  // What the surface shows BETWEEN the press and the command: the irreversible
  // warning, and two controls - confirm and keep playing. Arming sends nothing.
  const confirm = panel.getByTestId("game-endgame-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("This ends and permanently closes the player's game world. This cannot be undone.");
  await expect(confirm.getByTestId("game-endgame-confirm-yes")).toBeVisible();
  await expect(confirm.getByTestId("game-endgame-confirm-no")).toHaveText("Keep playing");
  expect(endgameRequests, "arming the confirm must not send the terminal command").toBe(0);

  // The confirm is the one sender.
  await confirm.getByTestId("game-endgame-confirm-yes").click();
  await expect.poll(() => endgameRequests).toBe(1);
  await expect(panel).toContainText("ConnectionStopped");
  await expect(panel).toContainText("Last resultCompleted successfully");
});

test("Keep playing is the way back out of the armed Endgame confirmation", async ({ page }) => {
  const endgameRequests: number[] = [];
  await stubHost(page, ATTACHED_CONNECTED);
  await page.route("**/api/composed-reference-game/v1/game/endgame", async (route) => {
    endgameRequests.push(1);
    await route.fulfill(jsonOk({ apiVersion: 1, status: "gameended" }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGame(page);
  const panel = panelOf(page);

  await panel.getByTestId("game-endgame-open").click();
  await expect(panel.getByTestId("game-endgame-confirm")).toBeVisible();

  // Backing out returns the surface to exactly the state it armed from: the
  // ordinary arm control is offered again and the destructive pair is gone.
  await panel.getByTestId("game-endgame-confirm-no").click();
  await expect(panel.getByTestId("game-endgame-confirm")).toHaveCount(0);
  await expect(panel.getByTestId("game-endgame-open")).toBeVisible();
  // And the session's other controls are still there: backing out is not a way of
  // losing the way out of a live game.
  await expect(panel.getByTestId("game-disconnect")).toBeVisible();
  expect(endgameRequests, "backing out sends nothing").toEqual([]);
});

/* ==========================================================================
   2. Stop failure: what the player reads when stopping does not succeed, and
      what they can still press.
   ========================================================================== */

test("a Stop that does not succeed says so and leaves the player a control that settles the session", async ({ page }) => {
  let stopRequests = 0;
  // The Host answers the stop with a refusal, and its projection lands in the
  // degraded-but-attached shape a failed stop really produces.
  const stopRefused: GameFacts = { ...ATTACHED_CONNECTED, connectionStatus: "failed" };
  await stubHost(page, ATTACHED_CONNECTED);
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill(jsonOk(composedRoot(stopRequests === 0 ? ATTACHED_CONNECTED : stopRefused))),
  );
  await page.route("**/api/composed-reference-game/v1/game/stop", async (route) => {
    stopRequests += 1;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "state_unavailable" }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGame(page);
  const panel = panelOf(page);

  const stop = panel.getByTestId("game-stop");
  await expect(stop).toBeVisible();
  await stop.click();
  await expect.poll(() => stopRequests).toBe(1);

  // What the player reads: the honest uncertainty, not a claim of success and not
  // a raw code.
  await expect(panel).toContainText("The game stop result is uncertain. The latest authoritative game state is shown.");
  await expect(panel).toContainText("ConnectionConnection failed");
  await expect(panel).not.toContainText("state_unavailable");

  // What they can press: the Stop itself is gone, because the connection is no
  // longer the connected shape a stop may act on - and the recovery group is what
  // replaces it. Disconnect is still offered, so the session is not a dead end.
  await expect(stop).toHaveCount(0);
  await expect(panel.getByTestId("game-disconnect")).toBeVisible();
  await expect(panel.getByTestId("game-resume")).toBeVisible();
});

/* ==========================================================================
   3. Disconnect failure: the same shape, and its own sentence.
   ========================================================================== */

test("a Disconnect that does not succeed says the attachment was kept, and offers the retry", async ({ page }) => {
  let disconnectRequests = 0;
  await stubHost(page, ATTACHED_CONNECTED);
  await page.route("**/api/composed-reference-game/v1/game/disconnect", async (route) => {
    disconnectRequests += 1;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "state_unavailable" }),
    });
  });

  await page.goto(`#profile=composed-reference-game&boot=${token}`);
  await openGame(page);
  const panel = panelOf(page);

  const disconnect = panel.getByTestId("game-disconnect");
  await expect(disconnect).toBeVisible();
  await disconnect.click();
  await expect.poll(() => disconnectRequests).toBe(1);

  // The sentence names the consequence that matters - the attachment was kept -
  // rather than a generic failure.
  await expect(panel).toContainText("The game could not be disconnected. Its attachment was retained.");
  await expect(panel).not.toContainText("state_unavailable");

  // And the control is still there to press: a failed disconnect that withdrew
  // its own control would strand a live attachment.
  await expect(disconnect).toBeVisible();
  await expect(disconnect).toBeEnabled();
  await disconnect.click();
  await expect.poll(() => disconnectRequests).toBe(2);
});

/* ==========================================================================
   4. A failed Resume, and the three ways out. This is the one the coverage
      report called out as the explicit recovery surface, and the one where a
      wrong answer strands a player.
   ========================================================================== */

/**
 * A dropped connection with no attempt of this surface's own yet: the state the
 * `Resume game` control belongs to. `latestOutcome` stays `none` because the Host's
 * own failed outcome is a different fact - it withdraws the restore control rather
 * than offering it, which is the rule `deriveGameSessionControls` keeps.
 */
const attachedDropped: GameFacts = { ...ATTACHED_CONNECTED, connectionStatus: "failed" };

test("a failed Resume offers Retry, Cancel and Start new game, and each one carries the player forward", async ({
  page,
}) => {
  const resumeKeys: string[] = [];
  let cancelRequests = 0;
  let createRequests = 0;
  let facts: GameFacts = attachedDropped;
  await stubHost(page, attachedDropped);  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot(facts))));
  await page.route("**/api/composed-reference-game/v1/game/resume", async (route) => {
    const command = route.request().postDataJSON() as { idempotencyKey: string };
    resumeKeys.push(command.idempotencyKey);
    await route.fulfill(jsonOk({ apiVersion: 1, status: "unavailable" }));
  });
  await page.route("**/api/composed-reference-game/v1/game/resume/cancel", async (route) => {
    cancelRequests += 1;
    expect(route.request().postDataJSON()).toMatchObject({ expectedAttachmentGeneration: 1 });
    // The epoch is settled: the authoritative projection is the honest
    // disconnected shape, and the session stays resumable.
    facts = { ...ATTACHED_CONNECTED, connectionStatus: "disconnected" };
    await route.fulfill(jsonOk({ apiVersion: 1, status: "cancelled" }));
  });
  await page.route("**/api/composed-reference-game/v1/game/create", async (route) => {
    createRequests += 1;
    await route.fulfill(jsonOk({ apiVersion: 1, status: "unavailable", gameSessionId: null }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGame(page);
  const panel = panelOf(page);

  // The restore control is what a player presses first, and pressing it fails.
  await panel.getByTestId("game-resume").click();
  await expect.poll(() => resumeKeys.length).toBe(1);
  await expect(panel).toContainText("The game could not be resumed right now. Reload the page or try again later.");

  // Way out 1: Retry. It is the same command replayed under the same
  // generation-bound key, and the surface still offers the other two after.
  const retry = panel.getByTestId("game-resume");
  await expect(retry).toBeVisible();
  await expect(retry).toHaveText("Retry");
  await expect(panel.getByTestId("game-resume-cancel")).toBeVisible();
  await expect(panel.getByTestId("game-create")).toBeVisible();
  await retry.click();
  await expect.poll(() => resumeKeys.length).toBe(2);
  expect(resumeKeys[1], "Retry replays the exact attempt's key, not a second command").toBe(resumeKeys[0]);

  // Way out 2: Start new game. It opens the form, and the form's own failure keeps
  // the three ways out on screen - a failed create is not a one-way door either.
  await panel.getByTestId("game-create").click();
  await expect(panel.getByText("Start a new game session")).toBeVisible();
  await expect(panel.getByLabel("Continuity binding")).toBeVisible();
  await panel.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => createRequests).toBe(1);
  await expect(panel).toContainText("could not be created right now");
  await expect(panel.getByText("Retry", { exact: true })).toBeVisible();
  await expect(panel.getByTestId("game-resume-cancel")).toBeVisible();
  await expect(panel.getByTestId("game-create")).toBeVisible();

  // Way out 3: Cancel. It settles the reconnect, and the surface comes back to a
  // resumable session rather than a blank panel.
  await panel.getByTestId("game-resume-cancel").click();
  await expect.poll(() => cancelRequests).toBe(1);
  await expect(panel).toContainText("ConnectionDisconnected");
  await expect(panel.getByText("Retry", { exact: true })).toHaveCount(0);
  await expect(panel.getByTestId("game-resume")).toHaveText("Resume game");
  await expect(panel).not.toContainText("could not be resumed");
});

test("Cancel failing still leaves the player a way forward, and says which one failed", async ({ page }) => {
  // The second-order failure: the recovery rollup itself refused. The surface must
  // not withdraw the controls on the strength of a failed cancel.
  await stubHost(page, attachedDropped);
  await page.route("**/api/composed-reference-game/v1/game/resume", async (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, status: "unavailable" })),
  );
  await page.route("**/api/composed-reference-game/v1/game/resume/cancel", async (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "state_unavailable" }),
    }),
  );

  await page.goto(`#profile=composed-reference-game&boot=${token}`);
  await openGame(page);
  const panel = panelOf(page);

  await panel.getByTestId("game-resume").click();
  await expect(panel.getByTestId("game-resume-cancel")).toBeVisible();
  await panel.getByTestId("game-resume-cancel").click();
  await expect(panel).toContainText(
    "The reconnect could not be cancelled. The latest authoritative game state is shown.",
  );

  // Every way out is still offered: the failed cancel did not consume them.
  await expect(panel.getByText("Retry", { exact: true })).toBeVisible();
  await expect(panel.getByTestId("game-resume-cancel")).toBeVisible();
  await expect(panel.getByTestId("game-create")).toBeVisible();
});

/* ==========================================================================
   5. A launch that failed for good. The step out of it is a fresh GameBuddy,
      which is not a control on this page - so the surface has to say so.
   ========================================================================== */

test("a launch that failed for good names the only step out of it instead of a guide it cannot carry out", async ({
  page,
}) => {
  await stubHost(page, {
    ...ATTACHED_CONNECTED,
    instance: { status: "crashed", gameTitle: "Stardew Valley", generation: 0 },
    attachment: { status: "none", generation: 0 },
    connectionStatus: "none",
    actionAuthority: "unavailable",
    latestOutcome: "failed",
  });

  await page.goto(`#profile=composed-reference-game&boot=${token}`);
  await openGame(page);
  const panel = panelOf(page);

  // The state says what happened and what the step is, in one sentence that names
  // restarting rather than a control that could only fail.
  const quarantined = panel.getByTestId("game-launch-quarantined");
  await expect(quarantined).toBeVisible();
  await expect(quarantined).toContainText("Close GameBuddy completely, open it again");
  await expect(panel).toContainText("Last resultDid not complete");
  await expect(panel).toContainText("InstanceStardew Valley");

  // And the getting-going guide is held back: every control in it is refused for
  // the life of this Host process, so showing it would be the trap design/26 §1
  // rules out - a control that can only fail on press.
  await expect(panel.getByTestId("game-start-guide")).toHaveCount(0);
  await expect(panel.getByTestId("game-activate")).toHaveCount(0);
  await expect(panel.getByTestId("game-setup")).toHaveCount(0);
  await expect(panel.getByTestId("game-launch")).toHaveCount(0);
});

/* ==========================================================================
   6. Waiting on the game. A state with no control is only safe when the
      surface says the wait is the wait.
   ========================================================================== */

test("a game that has not handed over a session says the wait, rather than showing a guide that cannot proceed", async ({
  page,
}) => {
  await stubHost(page, {
    ...ATTACHED_CONNECTED,
    instance: { status: "launching", gameTitle: "Stardew Valley", generation: 1 },
    attachment: { status: "none", generation: 0 },
    connectionStatus: "none",
    actionAuthority: "unavailable",
  });

  await page.goto(`#profile=composed-reference-game&boot=${token}`);
  await openGame(page);
  const panel = panelOf(page);

  const waiting = panel.getByTestId("game-waiting-for-game");
  await expect(waiting).toBeVisible();
  await expect(waiting).toContainText("Waiting for the game to hand this window your farm.");
});
