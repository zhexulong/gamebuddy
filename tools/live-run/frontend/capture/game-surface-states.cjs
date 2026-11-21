// The readings a game's lifecycle state is made of, shared by the three drivers that measure an END
// (`x-game-death.cjs`, `y-game-endgame.cjs`, `z-game-disconnect.cjs`) and by the one press driver W makes
// that none of them shows: the Stop (`w-game-launch.cjs`, whose world keeps running after it).
//
// Its own module for the reason `game-launch-verdict.mjs` is: these drivers read the same four things -
// the Host's state route, the panel's own fact rows and controls, the game surface's transcript, and the
// process table - and a second copy of any of them in a driver would eventually answer differently from the
// first one.
//
// It drives only the product's own seams: the Game surface's controls, its routes with the page's own
// session, and the OS's process table. It never writes game or Host state, and the ONE destructive act in this
// module kills a single process by exact pid - the pid this run's own launch created - because that is what a
// player's game dying looks like from outside.
const { randomBytes } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, reporter, connect, PAGE_HELPERS, activateSurface } = require("./common.cjs");
const { prepareOwnWorld, describeOwnWorld } = require("./fixture-world.cjs");
const { registerInstallation } = require("./installation-registration.cjs");
const {
  LAUNCH_PLATEAU_MS,
  LIFECYCLE_SHAPES,
  attachmentActionsStopped,
  blockedByProductLine,
  classifyChainStop,
  classifyLaunchRefusal,
  classifySilentLaunch,
  notMeasuredLine,
  describeGameState,
  describeStopReading,
  lifecycleShapeOf,
  readinessOf,
} = require("./game-launch-verdict.mjs");
const { GAME_STATES_PREFIX, verdictLine, NOT_MEASURED_REASONS } = require("./game-states-verdict.mjs");

/** One line, in the language the product is set to: the same line the launch driver says. */
const PLAYER_LINE = "你好，你在我旁边吗？";

const BUDGET = Object.freeze({
  controlMs: 30_000,
  /** The panel's own discovery scan, and the confirm press that registers its answer (`w-game-launch.cjs`). */
  discoveryMs: 90_000,
  registrationMs: 20_000,
  activationMs: 120_000,
  launchMs: 300_000,
  /** How long an instance that already exists gets to leave the state this driver found it in. */
  plateauMs: LAUNCH_PLATEAU_MS,
  /** One real provider turn. */
  turnMs: 240_000,
  /** How long a turn already in flight gets to settle after the game died. */
  settleMs: 120_000,
  endgameMs: 120_000,
  disconnectMs: 120_000,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The run's launch state, which names the product's port as well as its Host child pid. */
function readLaunchState() {
  const file = process.env.GB_SHOTS_LAUNCH_STATE;
  if (typeof file !== "string" || file.length === 0) return { path: null, state: null, run: null };
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    let run = null;
    try {
      run = JSON.parse(readFileSync(path.join(path.dirname(file), "run.json"), "utf8"));
    } catch {
      run = null;
    }
    return { path: file, state, run };
  } catch {
    return { path: file, state: null, run: null };
  }
}

/** The Host's own projection, read through the product's route with the page's session. */
const readGameState = async () => {
  try {
    const response = await fetch("/api/composed-reference-game/v1/state", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { ok: false, status: response.status };
    const root = await response.json();
    const game = root?.game?.game ?? null;
    return {
      ok: true,
      csrfToken: root?.csrfToken ?? null,
      prerequisites: game?.prerequisites?.status ?? null,
      instanceStatus: game?.instance?.status ?? null,
      instanceGeneration: game?.instance?.generation ?? null,
      // Present only when the Guardian reported an exit for this activation: that is the field's whole contract.
      playerHostExitCode: game?.instance?.playerHostExitCode,
      attachmentStatus: game?.attachment?.status ?? null,
      attachmentGeneration: game?.attachment?.generation ?? null,
      connectionStatus: game?.connectionStatus ?? null,
      actionAuthority: game?.actionAuthority ?? null,
      latestOutcome: game?.latestOutcome ?? null,
    };
  } catch (error) {
    return { ok: false, status: `unreachable:${String(error).slice(0, 160)}` };
  }
};

/**
 * The panel's own fact rows and controls.
 *
 * `facts` is `{ label: value }` straight out of the product's `<dl class="game-facts">`, so a driver asks the
 * panel what it says instead of re-deriving the sentence from the state route: the two can disagree, and the
 * player reads the panel.
 */
const readGameFacts = () => {
  const surface = document.querySelector('[data-testid="game-surface"]');
  if (surface === null) return { surfacePresent: false, facts: {}, controls: {}, sentences: {}, state: null };
  const facts = {};
  for (const fact of surface.querySelectorAll('[data-testid="game-state-panel"] .game-fact')) {
    const label = (fact.querySelector("dt")?.textContent ?? "").trim();
    if (label.length > 0) facts[label] = (fact.querySelector("dd")?.textContent ?? "").trim();
  }
  const control = (testId) => {
    const element = surface.querySelector(`[data-testid="${testId}"]`);
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return {
      disabled: element.disabled === true || element.getAttribute("aria-disabled") === "true",
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden",
      name: (element.getAttribute("aria-label") ?? element.textContent ?? "").replace(/\s+/g, " ").trim(),
    };
  };
  const panel = surface.querySelector('[data-testid="game-state-panel"]');
  // The panel's own status sentences, by the testid the panel gives each one. A driver that reads the state
  // route knows what the Host published, not what the player was told: the two have disagreed before, and the
  // sentence is what a player acts on.
  const sentence = (testId) => {
    const element = surface.querySelector(`[data-testid="${testId}"]`);
    return element === null ? null : (element.textContent ?? "").replace(/\s+/g, " ").trim();
  };
  return {
    surfacePresent: true,
    state: panel === null ? null : panel.getAttribute("data-game-state"),
    facts,
    sentences: {
      waitingForGame: sentence("game-waiting-for-game"),
      disconnectedWorldRunning: sentence("game-disconnected-world-running"),
      notRead: sentence("game-not-read"),
      quarantined: sentence("game-launch-quarantined"),
    },
    controls: {
      launch: control("game-launch"),
      activate: control("game-activate"),
      stop: control("game-stop"),
      disconnect: control("game-disconnect"),
      endgame: control("game-endgame-open"),
      endgameConfirm: control("game-endgame-confirm-yes"),
      reopen: control("game-reopen"),
      resume: control("game-resume"),
      reread: control("game-reread"),
    },
  };
};

/** The Game surface's transcript rows: a reply read here is a row the game surface painted. */
const readGameTranscript = () => {
  const surface = document.querySelector('[data-testid="game-surface"]');
  if (surface === null) return { surfacePresent: false, rows: [], notice: null };
  const rows = [...surface.querySelectorAll(".message-list > li.message")].map((row) => ({
    role: row.className.includes("player") ? "player" : "companion",
    streaming: row.hasAttribute("data-streaming"),
    text: (row.querySelector(".message-bubble")?.innerText ?? "").trim(),
  }));
  const notice = surface.querySelector(".reference-turn-notice");
  return { surfacePresent: true, rows, notice: notice === null ? null : (notice.innerText ?? "").trim() };
};

/**
 * The Host's bounded answer to a cabin read of the world that just ended.
 *
 * `stardew_player_host_exited` is the code the Host answers with when the Guardian reported the game's exit
 * (`host/src/composed-reference-game-browser.ts:647-668`), and it is the only place the death reaches the
 * player as a named fact rather than as `state_unavailable`.
 *
 * ASKED FROM THE PAGE, because the route is the page's own origin: a `fetch("/api/…")` issued in the driver
 * process has no base to resolve against and threw `TypeError: Failed to parse URL from
 * /api/composed-reference-game/v1/game/stardew/cabins` on every run that reached it (measured 2026-11-21,
 * `D:\gb-lanes\livenow10-wx`), so the reading had never been taken. The page also carries the session the
 * route is served under, which the driver process does not.
 */
const readCabinFact = async (page) => {
  try {
    return await page.evaluate(async () => {
      const response = await fetch("/api/composed-reference-game/v1/game/stardew/cabins", {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, code: body?.code ?? null };
    });
  } catch (error) {
    return { status: `unreachable:${String(error).slice(0, 160)}`, code: null };
  }
};

/**
 * One authenticated mutation, sent the way the product's own client sends it: the page's session cookie, the
 * state read's CSRF token, and a 22-character canonical base64url idempotency key.
 *
 * It is used only for an operation the surface does not offer as a control (the endgame after the panel has
 * stopped drawing it) - a control that exists is always pressed instead.
 *
 * The request is issued IN THE PAGE for the same reason `readCabinFact` is: the route is an origin-relative
 * path, and the page is where the session that authorizes it lives. The key is minted here so the page
 * receives a finished value instead of a second generator.
 */
const postGameRoute = async (page, route, body) => {
  const state = await page.evaluate(readGameState);
  if (state.ok !== true || typeof state.csrfToken !== "string")
    return { status: "state_unavailable", code: null, detail: `the state read answered ${String(state.status)}` };
  const idempotencyKey = randomBytes(16).toString("base64url");
  try {
    return await page.evaluate(
      async ({ route, body, idempotencyKey, csrfToken }) => {
        const response = await fetch(`/api/composed-reference-game/v1${route}`, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-csrf-token": csrfToken,
          },
          body: JSON.stringify({ apiVersion: 1, idempotencyKey, ...body }),
        });
        let answer = null;
        try {
          answer = await response.json();
        } catch {
          answer = null;
        }
        return { status: response.status, body: answer, code: answer?.code ?? null };
      },
      { route, body, idempotencyKey, csrfToken: state.csrfToken },
    );
  } catch (error) {
    return { status: `unreachable:${String(error).slice(0, 160)}`, code: null };
  }
};

/** Poll the product's own state until `predicate` holds, or the budget runs out. Never a bare sleep. */
async function waitForState(page, predicate, budgetMs) {
  const began = Date.now();
  let state = await page.evaluate(readGameState);
  while (Date.now() - began < budgetMs) {
    if (predicate(state)) return { settled: true, state, elapsedMs: Date.now() - began };
    await sleep(1000);
    state = await page.evaluate(readGameState);
  }
  return { settled: predicate(state), state, elapsedMs: Date.now() - began };
}

/**
 * The same wait, bound to one page, in the shape a module that does not own the page receives it.
 *
 * `capture/installation-registration.cjs` asks its caller for `waitForState(predicate, budgetMs)`
 * (`:149`) and does not take a page, so the page-first function above cannot be handed to it: called
 * that way its `page` is the predicate and its first `page.evaluate` throws `page.evaluate is not a
 * function`. Measured 2026-11-21 on driver X's own run (`D:\gb-lanes\livenow10-x`): every driver that
 * comes up through `activateAndLaunch` on an unregistered run root died there, and it stayed invisible
 * while driver W ran first, because W registers the installation with its own bound waiter and the
 * branch is then never entered.
 */
function stateWaiter(page) {
  return (predicate, budgetMs) => waitForState(page, predicate, budgetMs);
}

/**
 * The Stop press, waited on the two facts the product publishes for it and on nothing else.
 *
 * WHAT SETTLES IT: the attachment's phase reports the stopped shape (`attachmentActionsStopped` - the
 * panel's own `attached_stopped`, its publishers named there) AND the Host's `game/stop` answer has
 * arrived, which is the wire's receipt for the same fact because that route returns the STOP's settled
 * promise (`host/src/stardew-production-lifecycle-coordinator.internal.ts:2598-2662`).
 *
 * WHAT DOES NOT SETTLE IT, AND USED TO BE THE WHOLE PREDICATE: `instance=stopped|none` with the
 * attachment gone. That is the ENDGAME/death shape - a stop leaves the world running by design (project
 * rules #3023/#506) - so a wait for it reports every stop that works as a timeout. Measured on HEAD
 * before this reading existed: `E:\gb-lanes\launchorphan-r1\w-game-launch.txt` and
 * `firstjoin-r1`'s, both `settled: false, elapsedMs 120000, last instance=running/attachment=attached`,
 * with no way to tell a settled stop from a stuck one.
 *
 * A REFUSAL ENDS THE WAIT AT ONCE: a 4xx on the same route is the Host's own answer that it did not stop
 * anything, and waiting the rest of the budget for a phase that can no longer arrive would print the same
 * "did not settle" for a named refusal.
 */
async function waitForStop(page, { budgetMs, stopAnswer = () => null } = {}) {
  const began = Date.now();
  let state = await page.evaluate(readGameState);
  for (;;) {
    const answer = stopAnswer();
    const elapsedMs = Date.now() - began;
    if (answer !== null && Number.isFinite(answer?.status) && answer.status >= 400)
      return { settled: false, refused: answer, answer, state, elapsedMs };
    if (answer !== null && attachmentActionsStopped(state)) return { settled: true, answer, state, elapsedMs };
    if (elapsedMs >= budgetMs) return { settled: false, answer, state, elapsedMs };
    await sleep(1000);
    state = await page.evaluate(readGameState);
  }
}

/**
 * The Stop press in one unit: press it, wait on the two facts above, and say what happened either way.
 *
 * The outcome is SAID, not only recorded: `settled` is one boolean in a facts file, and the sentence beside it
 * carries the wire's receipt and the world that is still running - the two things a reader needs to tell a stop
 * that worked from a stop nobody answered.
 */
async function pressStop({ page, say, record, budgetMs, stopAnswer = () => null }) {
  await page.locator('[data-testid="game-stop"]').first().click();
  const stopped = await waitForStop(page, { budgetMs, stopAnswer });
  record("stop", stopped);
  say(describeStopReading(stopped));
  if (!stopped.settled)
    say(
      `the stop did not settle within ${String(budgetMs)}ms (${describeGameState(stopped.state)}${stopped.answer === null ? ", and the Host has answered no game/stop" : `, and the Host answered game/stop HTTP ${String(stopped.answer.status)}`}); the run's own cleanup names what remained`,
    );
  return stopped;
}

/** Poll until one lifecycle control is drawn, visible and pressable, or the budget runs out. */
async function waitForControl(page, name, budgetMs) {
  const began = Date.now();
  let facts = await page.evaluate(readGameFacts);
  for (;;) {
    const control = facts.controls[name];
    if (control !== null && control.visible === true && control.disabled !== true)
      return { settled: true, facts, elapsedMs: Date.now() - began };
    if (Date.now() - began >= budgetMs) return { settled: false, facts, elapsedMs: Date.now() - began };
    await sleep(500);
    facts = await page.evaluate(readGameFacts);
  }
}

/**
 * Bring the game up through the product's own controls, and classify every way that can fail.
 *
 * The installation is registered once per run root (driver W does it, and it stays registered), so this step
 * starts at the lifecycle: press activation only for the shape the product draws it in, press launch only when
 * nothing is running, wait for `running`+`attached`.
 *
 * AN INSTANCE THAT ALREADY EXISTS IS NOT AN UNACTIVATED LIFECYCLE. `launching`, `running`, `stopped` and
 * `crashed` all mean an instance is there, and the product offers neither the activate nor the launch control
 * for them (`dialogue-web/src/game-lifecycle-controls.ts:89-99,388-408`); a launch this driver did not ask for
 * is also not this driver's to ask for a second time. The words are read through the run's one state model
 * (`lifecycleShapeOf`), so this driver and driver W cannot answer the same state differently.
 *
 * A launch refusal goes through the run's ONE classification (`game-launch-verdict.mjs`) so a missing guardian
 * is `not_measured: guardian_pipe_unreachable` here exactly as it is for driver W, and never a second spelling.
 */
async function activateAndLaunch({ page, say, record, guardian, problems, budget = BUDGET }) {
  let state = await page.evaluate(readGameState);
  /*
   * A state route that does not answer is the same missing prerequisite reached through the transport, and it is
   * classified by the run's ONE rule for it (`classifySilentLaunch`): a Host whose guardian session died leaves
   * deliberately (`host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts:188-196`), and the gate launcher
   * destroys that socket on the first frame after `hello`. Measured 2026-11-15: the first driver to request a
   * launch ends the mounted Host for every driver after it, and reporting that as a nameless
   * `game_state_unreadable` would name a symptom instead of the cause.
   */
  if (state.ok !== true) {
    const reading = classifySilentLaunch({ guardian, detail: `the game state route answered ${String(state.status)}` });
    return { kind: reading.verdict === "failed" ? "failed" : "not_measured", reason: reading.reason, detail: reading.detail };
  }
  if (state.prerequisites !== "met") {
    const registration = await registerInstallation({
      page,
      say,
      record,
      problems,
      waitForState: stateWaiter(page),
      budgets: {
        discoveryMs: budget.discoveryMs ?? BUDGET.discoveryMs,
        registrationMs: budget.registrationMs ?? BUDGET.registrationMs,
      },
      state,
    });
    if (registration.kind === "not_measured")
      return { kind: "not_measured", reason: registration.reason, detail: registration.detail };
    if (registration.kind === "refused") {
      const reading = classifyLaunchRefusal({ step: "installation", code: registration.code, cause: registration.cause, guardian });
      return { kind: reading.verdict === "failed" ? "failed" : "not_measured", reason: reading.reason, detail: reading.detail };
    }
    // The registration is a mutation of this run root, so the state the rest of this function reads has moved.
    state = await page.evaluate(readGameState);
  }

  const shape = lifecycleShapeOf(state);
  if (shape === LIFECYCLE_SHAPES.unread)
    return {
      kind: "not_measured",
      reason: NOT_MEASURED_REASONS.gameNotRead,
      detail: `the Host holds no reading of the game (${describeGameState(state)}): the surface's own step for this shape is the reread, so no activation and no launch control exists to press`,
    };

  if (shape === LIFECYCLE_SHAPES.unactivated) {
    const ready = await waitForControl(page, "activate", budget.controlMs);
    record("activation control", { settled: ready.settled, control: ready.facts.controls.activate });
    if (!ready.settled)
      return { kind: "not_measured", reason: "game_lifecycle_not_activated", detail: `no usable activation control within ${String(budget.controlMs)}ms at ${describeGameState(state)}` };
    await page.locator('[data-testid="game-activate"]').first().click();
    const activation = await waitForState(
      page,
      (reading) => reading.ok === true && lifecycleShapeOf(reading) === LIFECYCLE_SHAPES.activated,
      budget.activationMs,
    );
    record("activation", { settled: activation.settled, elapsedMs: activation.elapsedMs, state: activation.state });
    if (!activation.settled)
      return {
        kind: "not_measured",
        reason: "game_lifecycle_not_activated",
        detail: `the activation never published a generation within ${String(budget.activationMs)}ms (last ${describeGameState(activation.state)})${problemOf(problems, "lifecycle/activate")}`,
      };
  } else {
    record("activation", { needed: false, shape, state });
    say(
      `the lifecycle already holds the game: shape=${shape} at ${describeGameState(state)}, so the product draws no activation control for it and this driver presses none`,
    );
  }

  // The launch is for a lifecycle with nothing running. An instance that exists is a launch already
  // requested - by driver W, whose chain this driver starts behind - and its outcome is a reading.
  if (shape === LIFECYCLE_SHAPES.instantiated) return await settleInFlightInstance({ page, say, record, budget, state });

  const launchReady = await waitForControl(page, "launch", budget.controlMs);
  record("launch control", { settled: launchReady.settled, control: launchReady.facts.controls.launch });
  if (!launchReady.settled)
    return { kind: "not_measured", reason: "game_prerequisites_missing", detail: `no usable launch control within ${String(budget.controlMs)}ms at ${describeGameState(await page.evaluate(readGameState))}` };

  /*
   * THE RUN'S OWN WORLD, CLAIMED BEFORE THE GAME IS ASKED TO ENTER ONE (`capture/fixture-world.cjs`): the
   * Player Host asks the Mod for one world name, Stardew keeps that world in the machine's single save
   * folder, and every run that entered it left one more Cabin bound to its own companion in it - which is
   * how `frontend--r25` met a farm with no free cabin pad and 409 `stardew_player_host_cabin_missing` on
   * every cabin read. The saves of that name move into this run root; a save of any other name does not.
   */
  const runLaunch = readLaunchState();
  const fixtureWorld = prepareOwnWorld({
    declaredDataRoot: runLaunch.state?.declaredDataRoot,
    runRoot: runLaunch.state?.runRoot,
    policy: runLaunch.run?.world === "existing" ? "existing" : "own",
  });
  record("fixture world", fixtureWorld);
  say(describeOwnWorld(fixtureWorld));
  if (fixtureWorld.kind === "refused")
    return {
      kind: "not_measured",
      reason: "fixture_world_not_prepared",
      detail: `this run could not claim a world of its own, so a launch it measured would be a launch into whatever world the previous run left behind: ${describeOwnWorld(fixtureWorld)}`,
    };

  const began = Date.now();
  await page.locator('[data-testid="game-launch"]').first().click();
  say(`launch requested through the product's own control (${JSON.stringify(launchReady.facts.controls.launch.name)})`);
  let launched = await page.evaluate(readGameState);
  let unreachable = launched.ok === true ? 0 : 1;
  while (Date.now() - began < budget.launchMs) {
    if (readinessOf(launched) !== "pending" || unreachable >= 5) break;
    await sleep(1000);
    launched = await page.evaluate(readGameState);
    unreachable = launched.ok === true ? 0 : unreachable + 1;
  }
  record("launch", { settled: readinessOf(launched) !== "pending", elapsedMs: Date.now() - began, state: launched });
  const problem = problems.get("game/launch") ?? null;
  if (problem !== null) {
    const reading = classifyLaunchRefusal({ step: "launch", code: problem.code, cause: problem.cause, guardian });
    return { kind: reading.verdict === "failed" ? "failed" : "not_measured", reason: reading.reason, detail: reading.detail };
  }
  if (readinessOf(launched) !== "ready")
    return {
      kind: "not_measured",
      reason: "game_never_reached_ready",
      detail: `the launch settled at ${describeGameState(launched)} without reaching instance=running/attachment=attached${problemOf(problems, "game/launch")}`,
    };
  say(`the game reached ready: ${describeGameState(launched)} after ${String(Date.now() - began)}ms`);
  return { kind: "ready", state: launched };
}

/** The tuple a wait watches: a change in any of these is a step the product took. */
const instanceKey = (state) =>
  state?.ok !== true
    ? `unreadable:${String(state?.status)}`
    : `${String(state.instanceStatus)}/${String(state.attachmentStatus)}/${String(state.instanceGeneration)}`;

/**
 * Wait for the instance this run found to reach ready, and classify what it settled at.
 *
 * Nothing may be pressed here: an existing instance has no activation control, and asking for a second launch
 * would be a request the product forbids for the same reason. So the three ways this ends are readings -
 * the launch finished (`ready`), the instance died on the way up, or it stopped moving.
 *
 * The third one is not a timeout, it is the run's own proof of a product gap: `classifyChainStop` names
 * `instance_status_never_running` when the tuple stays put for `LAUNCH_PLATEAU_MS` while a launch is in
 * flight and nothing is attached. That is the gap the harness already has a word for - a GameBuddy-launched
 * Player Host is projected as `launching` for its whole life - and it is reported through the harness's
 * `blocked_by_product` path rather than as a failure or a pass.
 */
async function settleInFlightInstance({ page, say, record, budget, state }) {
  const began = Date.now();
  let current = state;
  let key = instanceKey(current);
  let unchangedSince = began;
  while (readinessOf(current) === "pending") {
    if (Date.now() - unchangedSince >= budget.plateauMs) break;
    if (Date.now() - began >= budget.launchMs) break;
    await sleep(1000);
    const next = await page.evaluate(readGameState);
    if (instanceKey(next) !== key) {
      key = instanceKey(next);
      unchangedSince = Date.now();
    }
    current = next;
  }
  const unchangedForMs = Date.now() - unchangedSince;
  record("in-flight instance", { settled: readinessOf(current), unchangedForMs, state: current });
  if (readinessOf(current) === "ready") {
    say(`the instance this driver found had already finished its launch: ${describeGameState(current)}`);
    return { kind: "ready", state: current };
  }
  const gap = classifyChainStop({ state: current, unchangedForMs, plateauMs: budget.plateauMs });
  if (gap !== null) {
    say(`the instance stopped at a gap the product owns: ${blockedByProductLine(gap.gap, gap.detail)}`);
    return {
      kind: "not_measured",
      reason: gap.gap,
      gap: gap.gap,
      detail: `this driver found an instance already in flight at ${describeGameState(state)}, and it stayed at ${describeGameState(current)} for ${String(unchangedForMs)}ms without reaching running+attached. ${gap.detail}`,
    };
  }
  return {
    kind: "not_measured",
    reason: NOT_MEASURED_REASONS.gameNeverReady,
    detail: `the instance this driver found never reached instance=running/attachment=attached (${describeGameState(current)} after ${String(Date.now() - began)}ms, unchanged for ${String(unchangedForMs)}ms)`,
  };
}

const problemOf = (problems, route) => {
  const problem = problems?.get(route) ?? null;
  return problem === null ? "" : ` (the route answered ${String(problem.status)} ${JSON.stringify(problem.code)})`;
};

/**
 * The pids of the game this run launched: the client and the loader under the installation this run was
 * configured with, appearing AFTER the driver started.
 *
 * Two filters, and both are needed: the installation folder is the player's own, so the path alone would claim
 * their session, and the start time is what separates a process this launch created from one that was already
 * running. `examined` travels with the answer so an empty reading prints its population.
 */
function gamePids({ gameDir, sinceMs }) {
  let processTable = null;
  try {
    // The kit's one process probe (`lib/process-table.mjs`), not a second PowerShell query beside it.
    processTable = require(path.join(REPO_ROOT, "tools", "live-run", "frontend", "lib", "process-table.mjs"));
  } catch (error) {
    return { examined: null, reason: `process_table_not_importable:${String(error).slice(0, 120)}`, client: [], loader: [] };
  }
  const matches = (executable) => {
    const measured = processTable.processesWithCommandLine(path.join(gameDir, executable));
    if (measured === null) return null;
    return {
      examined: measured.examined,
      rows: measured.rows.filter((row) => {
        const started = row.startTime === null ? null : Date.parse(row.startTime);
        return started !== null && Number.isFinite(started) && started >= sinceMs;
      }),
    };
  };
  const client = matches("Stardew Valley.exe");
  const loader = matches("StardewModdingAPI.exe");
  if (client === null || loader === null)
    return { examined: null, reason: "process_table_unavailable", client: [], loader: [] };
  return { examined: client.examined, client: client.rows, loader: loader.rows };
}

/** The one destructive act here: one process, by the exact pid this run's own launch created. */
function killExactPid(pid) {
  const processTable = require(path.join(REPO_ROOT, "tools", "live-run", "frontend", "lib", "process-table.mjs"));
  return processTable.killProcessTree(pid);
}

/** Whether one pid is alive, from the same probe. `null` when the machine cannot be asked. */
function pidAlive(pid) {
  const processTable = require(path.join(REPO_ROOT, "tools", "live-run", "frontend", "lib", "process-table.mjs"));
  const row = processTable.processRow(pid);
  return row === null ? null : true;
}

/**
 * The three ways these drivers end, in one place, so each driver's last act is a reading rather than a shape
 * of its own: `measured` (exit 0), `failed` (exit 1) and `not_measured` (exit 0) - the last one because a
 * machine without a guardian owes no failure, and the run's totals count it by name from the driver's own
 * facts file.
 */
async function conclude({ browser, say, flush, driver, scenario, reading, facts, factsName }) {
  say(`=== ITEM: ${scenario} ===`);
  say(verdictLine(scenario, reading));
  facts.verdict = { scenario, ...reading };
  /*
   * A reading the product's own gap caused leaves through the harness's `blocked_by_product` path - the one
   * driver W's gaps already use (`capture/game-launch-verdict.mjs`) - and through it alone: the capture phase
   * counts each executed driver in one bucket, and the gap is the more specific word for why the chain stopped.
   * The verdict is still `not_measured` (nothing failed, nothing was measured) and its line still names the gap.
   */
  if (reading.verdict === "not_measured") {
    if (typeof reading.gap === "string") say(blockedByProductLine(reading.gap, reading.detail));
    else say(notMeasuredLine(reading.reason, reading.detail));
  }
  say(`${GAME_STATES_PREFIX} ${driver}: ${reading.verdict} ${reading.reason}; ${scenario}`);
  say(`DONE-${driver.toUpperCase()}`);
  flush();
  await browser.close().catch(() => undefined);
  process.exit(reading.verdict === "failed" ? 1 : 0);
}

/*
 * The moment from which a game process counts as part of THIS run's launch.
 *
 * The boundary is the run's own Host child (`launch.json` `childStartTime`), never only the driver's start: a
 * driver that runs behind another's launch finds the instance already up, `settleInFlightInstance` reports it
 * `ready` (it is the game this RUN launched), and a boundary of "after I started" then finds none of it -
 * measured on `frontend--r24`, which answered `game_process_not_found` with 371 processes examined while the
 * run's own attached game was alive. `sinceWhat` travels with the answer so a reader can tell which boundary
 * was used; a launch state with no readable `childStartTime` keeps the driver's own start rather than inventing
 * one.
 */
function runBoundary({ driverStartedMs, childStartTime }) {
  const childStartMs = Date.parse(String(childStartTime ?? ""));
  if (!Number.isFinite(childStartMs)) return Object.freeze({ sinceMs: driverStartedMs, sinceWhat: "driver_start" });
  return Object.freeze({ sinceMs: Math.min(driverStartedMs, childStartMs), sinceWhat: "run_host_child" });
}

/**
 * The step recorder every driver in this family writes through: a step is a NAME and the value that proves it,
 * kept in `facts.steps` and printed as it happens. One spelling, because the report a reader opens after a run
 * that stopped half way is the only account of which steps ran.
 */
function stepRecorder(facts, say) {
  return (step, value) => {
    facts.steps.push(step);
    say(`--- step ${step} ---`);
    say(JSON.stringify(value, null, 1));
  };
}

/**
 * The prologue the three state drivers share: the run's report writer, the facts object and the step recorder
 * its verdict is reached through, the guardian probe, the page attached to the product, the launch through the
 * product's own controls, and the exact game pid THIS run created. What a driver then does to that game - kill
 * it under a turn, end it explicitly, disconnect the surface from it - is the scenario, and stays in the driver.
 *
 * A machine that owes a prerequisite concludes the driver here as `not_measured`, through the same `conclude`
 * every verdict leaves by, because a driver with no game has no reading to take.
 */
async function startStateDriver({ driver, scenario, reportFile }) {
  const launch = readLaunchState();
  const gameDir = launch.run?.gameDir ?? null;
  const { say, flush } = reporter(reportFile);
  const started = Date.now();
  const facts = { steps: [], scenario };
  const record = stepRecorder(facts, say);
  /**
   * `gap` is the product gap the reading proved, when it proved one: the same reading leaves through the
   * harness's `blocked_by_product` line instead of `NOT-MEASURED`, so a driver that stopped at a step no
   * launch of this product can cross is counted by name and never as a pass.
   */
  const notMeasured = async (browser, reason, detail, gap = null) =>
    await conclude({
      browser,
      say,
      flush,
      driver,
      scenario,
      facts,
      reading: { verdict: "not_measured", reason, detail, ...(gap === null ? {} : { gap }) },
    });

  if (typeof gameDir !== "string" || gameDir.length === 0) {
    say("not_measured: the run config names no game directory");
    say(`DONE-${driver.toUpperCase()}`);
    flush();
    process.exit(0);
  }

  const guardian = await probeGuardian();
  record("guardian", guardian);
  const { browser, page } = await connect();
  const problems = attachProblems(page);
  await page.evaluate(`${PAGE_HELPERS};undefined`);
  await page.setViewportSize({ width: 1440, height: 900 });
  const surfaceSwitch = await activateSurface(page, "游戏");
  const panel = await page.evaluate(readGameFacts);
  record("surface", { switchKind: surfaceSwitch, surfacePresent: panel.surfacePresent });
  if (panel.surfacePresent !== true)
    return await notMeasured(browser, NOT_MEASURED_REASONS.gameSurfaceAbsent, "the Game surface did not mount");

  const launched = await activateAndLaunch({ page, say, record, guardian, problems });
  if (launched.kind !== "ready")
    return await notMeasured(browser, launched.reason, launched.detail ?? "the launch did not reach ready", launched.gap ?? null);

  // The game's own process, created after this RUN started - both filters are needed and both are stated
  // below. The installation folder is shared with the player's own game, and the start time is what
  // separates this run's launch from their session.
  /*
   * The boundary is the RUN's Host child, not this driver's own start.
   *
   * A driver that runs behind another's launch finds the instance already up, and
   * `settleInFlightInstance` reports it `ready` - the game is the one THIS RUN launched. Measuring against
   * this driver's start then finds none of it: `frontend--r24` answered `game_process_not_found` with 371
   * processes examined while the run's own attached game was alive, because driver W had launched it six
   * minutes earlier and its stop had not settled. The installation folder still separates the player's own
   * session from ours, and the run's Host child (`launch.json` `childStartTime`) is later than anything the
   * run did not create, so the target stays a process this run launched and never one found by image name.
   */
  const launchState = readLaunchState();
  const boundary = runBoundary({
    driverStartedMs: started,
    childStartTime: launchState.state?.childStartTime ?? null,
  });
  const pids = gamePids({ gameDir, sinceMs: boundary.sinceMs });
  record("game pids", { sinceMs: boundary.sinceMs, sinceWhat: boundary.sinceWhat, pids });
  const target = pids.client[0] ?? pids.loader[0] ?? null;
  if (target === null)
    return await notMeasured(
      browser,
      NOT_MEASURED_REASONS.noGamePid,
      `no process under ${gameDir} was created by this run (${String(pids.examined ?? "unreadable")} processes examined; the population is processes started at or after ${new Date(sinceMs).toISOString()})`,
    );

  return { say, flush, facts, record, notMeasured, browser, page, problems, gameDir, target };
}

/**
 * The guardian endpoint population, read exactly as driver W reads it: the preflight's probe for the pipe
 * namespace, plus the pid of the launch driver this run recorded. `onlyRunOwnGatePeer` states the BASIS on
 * which a launch refusal may be excused - exactly one endpoint, and the process that created it is this run's
 * own hello-only gate peer (`tools/desktop-composition-launch.mjs:542-545`) - so a real supervisor can never be
 * mistaken for it.
 */
async function probeGuardian() {
  const { execFileSync } = require("node:child_process");
  const { pathToFileURL } = require("node:url");
  const preflight = await import(pathToFileURL(path.join(REPO_ROOT, "tools", "lib", "live-run-preflight.mjs")).href);
  const probe = preflight.probeGuardianPipe();
  const launchFile = process.env.GB_SHOTS_LAUNCH_STATE;
  let driverPid = null;
  if (typeof launchFile === "string" && launchFile.length > 0) {
    try {
      driverPid = Number.parseInt(readFileSync(path.join(path.dirname(launchFile), "launch-driver.pid"), "utf8").trim(), 10);
      if (!Number.isFinite(driverPid)) driverPid = null;
    } catch {
      driverPid = null;
    }
  }
  let driverAlive = false;
  if (driverPid !== null) {
    try {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `(Get-Process -Id ${String(driverPid)} -ErrorAction SilentlyContinue | Measure-Object).Count`],
        { encoding: "utf8", timeout: 20_000, windowsHide: true },
      ).trim();
      driverAlive = Number.parseInt(out, 10) > 0;
    } catch {
      driverAlive = false;
    }
  }
  return {
    examined: probe.examined,
    endpoints: [...probe.endpoints],
    unreadable: probe.unreadable,
    runLaunchDriverPid: driverPid,
    runLaunchDriverAlive: driverAlive,
    onlyRunOwnGatePeer: probe.unreadable === null && probe.endpoints.length === 1 && driverAlive === true,
  };
}

/**
 * The bounded problem body of a route the driver asked the product to answer, captured where the product
 * itself reads it. A driver that only waited would report a refusal as a timeout.
 */
function attachProblems(page) {
  const problems = new Map();
  page.on("response", (response) => {
    const match = /\/(lifecycle\/activate|game\/launch|game\/disconnect|game\/endgame|game\/stop)$/u.exec(response.url());
    if (match === null || response.status() < 400) return;
    response
      .text()
      .then((text) => {
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = { code: "unparseable_problem_body" };
        }
        problems.set(match[1], { status: response.status(), code: body?.code ?? null, cause: body?.cause ?? null });
      })
      .catch(() => problems.set(match[1], { status: response.status(), code: "unreadable_problem_body", cause: null }));
  });
  return problems;
}

module.exports = {
  PLAYER_LINE,
  runBoundary,
  BUDGET,
  GAME_STATES_PREFIX,
  sleep,
  readLaunchState,
  readGameState,
  readGameFacts,
  readGameTranscript,
  readCabinFact,
  postGameRoute,
  waitForState,
  stateWaiter,
  waitForStop,
  pressStop,
  waitForControl,
  activateAndLaunch,
  gamePids,
  killExactPid,
  pidAlive,
  probeGuardian,
  attachProblems,
  conclude,
  stepRecorder,
  startStateDriver,
};
