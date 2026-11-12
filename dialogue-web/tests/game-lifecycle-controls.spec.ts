/**
 * The two authenticated ends of the Game lifecycle: activation and endgame.
 *
 * Activation is a fieldless POST that publishes the one generation only the Host can own, and
 * each refusal it can answer with - not staged, missing installation, a drawer fact, an
 * unmounted seam - reads as the reason it is instead of as an uncertain launch. Endgame is a
 * separate operation with its own confirm, and its control is absent whenever no live session
 * could be ended.
 */
import { expect, test } from "./frontend-coverage";
import {
  token,
  csrfToken,
  draft,
  game,
  root,
  openGameDrawer,
  jsonOk,
  stagedGame,
} from "./composed-reference-game-fixtures";

test("a first run activates the lifecycle with a fieldless POST before launch is ever offered", async ({ page }) => {
  let activationRequests = 0;
  let activationBody: string | null | undefined;
  let stateReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/lifecycle/activate", async (route) => {
    activationRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().headers()["content-type"]).toBe("application/json");
    activationBody = route.request().postData();
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    const projection = activationRequests === 0 ? root.game : stagedGame;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...root, game: projection }),
    });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  // Before activation the coordinator owns no staged Player Host, so the exact
  // expected generation is absent and launch must not be on offer at all.
  await expect(panel.getByRole("button", { name: "Play with companion" })).toHaveCount(0);
  const activate = panel.getByRole("button", { name: "Enable companion play" });
  await expect(activate).toBeVisible();
  await activate.click();
  await expect.poll(() => activationRequests).toBe(1);
  // The route refuses any body with 409; the admission alone names the session.
  expect(activationBody).toBeNull();
  await expect.poll(() => stateReads).toBe(2);
  // 204 is the activation; the authoritative reread is what puts launch on offer.
  await expect(panel.getByRole("button", { name: "Play with companion" })).toBeVisible();
  await expect(activate).toHaveCount(0);
});


test("a launch refused as not staged names activation as the reason instead of an uncertain launch", async ({ page }) => {
  let launchRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: stagedGame }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/launch", async (route) => {
    launchRequests += 1;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "game_prerequisites_missing" }),
    });
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: stagedGame }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Play with companion" }).click();
  await expect.poll(() => launchRequests).toBe(1);
  await expect(panel).toContainText("Companion play is not ready yet. Enable companion play, then try again.");
  await expect(panel).not.toContainText("The game launch result is uncertain");
});


/**
 * The refusal a first run really produces, measured in the live product (2026-10-19, the composed Game
 * surface at HEAD): with no Stardew installation registered for the session, pressing "Enable companion
 * play" answers `409 {"code":"state_unavailable","cause":"stardew_bootstrap_registration_unavailable"}`
 * (`scratch/probe-game-activation.mjs`). Activation reserves and stages the owned Player Host against the
 * registered installation, so with none bound the attempt can only be refused - the player has not set the
 * game up yet, and the installation panel on this same surface is where they do that.
 *
 * The failure this catches: that refusal rendered as "companion play could not be enabled. The latest
 * authoritative game state is shown." - a dead-end fault over a state the player fixes on this very screen.
 * It now states the missing prerequisite and names the control that supplies it, the way the cabin handoff
 * renders its own not-yet state.
 */
test("an activation refused for a missing installation reads as the prerequisite, and lays out as one status line", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/lifecycle/activate", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "state_unavailable", cause: "stardew_bootstrap_registration_unavailable" }),
    }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Enable companion play" }).click();

  const statusLine = panel.locator('[data-guide-step="1"] .game-status');
  // The attempt's own in-progress line is already one `.game-status` in step 1, so waiting for the count
  // alone measures the press rather than its answer: wait for the refusal's sentence to land, and for that
  // line to be laid out, before anything is measured.
  await expect(statusLine).toContainText("Companion play needs a Stardew Valley installation");
  await expect(statusLine).toBeVisible();
  await expect(statusLine).toHaveCount(1);
  const measurement = await statusLine.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const step = node.closest('[data-guide-step="1"]');
    return Object.freeze({
      tone: node.getAttribute("data-tone"),
      textLength: node.textContent?.length ?? 0,
      width: box.width,
      height: box.height,
      stepWidth: step === null ? 0 : step.getBoundingClientRect().width,
    });
  });
  console.log(`[activation-not-configured] ${JSON.stringify(measurement)}`);

  // A missing installation is a state to act on, not a failure to report: the line carries the informative
  // tone the cabin handoff's own not-yet state carries, and it says which prerequisite is missing and where
  // the player supplies it.
  expect(measurement.tone).toBe("info");
  await expect(statusLine).toContainText("Companion play needs a Stardew Valley installation");
  await expect(statusLine).toContainText("Choose your game folder in Game installation on this page");
  await expect(panel).not.toContainText("Companion play could not be enabled");
  // It is really laid out inside step 1: a line that renders, fits the step, and is not a zero-height ghost.
  expect(measurement.textLength).toBeGreaterThan(0);
  expect(measurement.height).toBeGreaterThan(0);
  expect(measurement.width).toBeGreaterThan(0);
  expect(measurement.width).toBeLessThanOrEqual(measurement.stepWidth);
  // The refusal is not a dead end: once the installation is chosen the same control is what the player presses.
  await expect(panel.getByRole("button", { name: "Enable companion play" })).toBeVisible();
});


test("an activation refusal stays a drawer fact with its own reason, and an unmounted seam says so", async ({ page }) => {
  const scenarios = [
    { refusal: { status: 409, code: "game_unavailable" }, expected: "Companion play could not be enabled" },
    // The shell answers 404 when the owner mounted no activation seam at all;
    // that is not the same thing as an activation that failed.
    { refusal: { status: 404, code: "not_found" }, expected: "This build cannot enable companion play" },
  ];
  let current = scenarios[0];
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/composed-reference-game/v1/lifecycle/activate", (route) =>
    route.fulfill({
      status: current.refusal.status,
      contentType: "application/json",
      body: JSON.stringify({ code: current.refusal.code }),
    }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    current = scenario;
     await page.goto(`/?activation=${scenarioIndex}#profile=composed-reference-game&boot=${token}`);
     await openGameDrawer(page);
     const panel = page.getByRole("region", { name: "Game state" });
    await panel.getByRole("button", { name: "Enable companion play" }).click();
    await expect(panel).toContainText(scenario.expected);
    // The refusal is a Game-surface fact; the conversation returns when the
    // player goes back to it.
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();
    await openGameDrawer(page);
    const panelAgain = page.getByRole("region", { name: "Game state" });
    await expect(panelAgain.getByRole("button", { name: "Enable companion play" })).toBeVisible();
  }
});


/**
 * The one terminal operation (`game.endgame`). It is deliberately not a routine
 * session control: the player must confirm it, and only the confirm sends the
 * command. This journey drives it the way a player would, over the real shell
 * against the composed routes, and asserts both directions of the honesty:
 * the confirm step happens before the POST, and the control is absent - not a
 * disabled lookalike - when no live session can be ended.
 */
test("Game endgame requires an explicit confirm before the POST and reaches the terminal route once", async ({ page }) => {
  const attachedGame = {
    ...game,
    game: {
      ...game.game,
      attachment: { status: "attached", generation: 1 },
      connectionStatus: "connected_idle",
    },
  };
  const endedGame = {
    ...attachedGame,
    game: {
      ...attachedGame.game,
      attachment: { status: "none", generation: 0 },
      connectionStatus: "stopped",
      actionAuthority: "unavailable",
      latestOutcome: "succeeded",
    },
  };
  let endgameRequests = 0;
  let stateRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill(jsonOk({ ...root, game: attachedGame })),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/endgame", async (route) => {
    endgameRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      expectedAttachmentGeneration: 1,
      confirm: true,
    });
    // A slow confirmation proves in-flight single-flight: the button stays
    // disabled and a double activation is still one command.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill(jsonOk({ apiVersion: 1, status: "gameended" }));
  });
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateRequests += 1;
    const projection = endgameRequests === 0 ? attachedGame : endedGame;
    return route.fulfill(jsonOk({ ...root, game: projection }));
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk(draft)),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  const endgame = panel.getByTestId("game-endgame");
  await expect(endgame).toBeVisible();

  // Step one only arms the confirm: no command has been sent yet.
  await endgame.getByTestId("game-endgame-open").click();
  const confirm = panel.getByTestId("game-endgame-confirm");
  await expect(confirm).toBeVisible();
  expect(endgameRequests, "arming the confirm must not send the terminal command").toBe(0);

  // The confirm is the one and only sender, and it is single-flight.
  await confirm.getByTestId("game-endgame-confirm-yes").dblclick();
  await expect.poll(() => endgameRequests).toBe(1);
  await expect.poll(() => stateRequests).toBe(2);
  await expect(endgame).toHaveCount(0);
  await expect(panel).toContainText("ConnectionStopped");
  await expect(panel).not.toContainText("The game could not be ended");
});


test("Game endgame control is absent when no live session can be ended", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill(jsonOk(root)),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  // The default root has no attachment, so there is nothing to end: absent
  // rather than a disabled lookalike (design/26 §1).
  await expect(panel.getByTestId("game-endgame")).toHaveCount(0);
});


