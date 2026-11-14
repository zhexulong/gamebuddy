// The readings a game's END is made of, shared by the three drivers that measure one
// (`x-game-death.cjs`, `y-game-endgame.cjs`, `z-game-disconnect.cjs`).
//
// Its own module for the reason `game-launch-verdict.mjs` is: the three scenarios read the same four things -
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
const { REPO_ROOT } = require("./common.cjs");
const { classifyLaunchRefusal, notMeasuredLine, describeGameState, readinessOf } = require("./game-launch-verdict.mjs");
const { GAME_STATES_PREFIX, verdictLine } = require("./game-states-verdict.mjs");

/** One line, in the language the product is set to: the same line the launch driver says. */
const PLAYER_LINE = "你好，你在我旁边吗？";

const BUDGET = Object.freeze({
  controlMs: 30_000,
  activationMs: 120_000,
  launchMs: 300_000,
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
  if (surface === null) return { surfacePresent: false, facts: {}, controls: {}, state: null };
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
  return {
    surfacePresent: true,
    state: panel === null ? null : panel.getAttribute("data-game-state"),
    facts,
    controls: {
      launch: control("game-launch"),
      activate: control("game-activate"),
      stop: control("game-stop"),
      disconnect: control("game-disconnect"),
      endgame: control("game-endgame-open"),
      endgameConfirm: control("game-endgame-confirm-yes"),
      reopen: control("game-reopen"),
      resume: control("game-resume"),
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
 */
const readCabinFact = async () => {
  try {
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
 */
const postGameRoute = async (route, body) => {
  const state = await readGameState();
  if (state.ok !== true || typeof state.csrfToken !== "string")
    return { status: "state_unavailable", code: null, detail: `the state read answered ${String(state.status)}` };
  try {
    const response = await fetch(`/api/composed-reference-game/v1${route}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": state.csrfToken,
      },
      body: JSON.stringify({
        apiVersion: 1,
        idempotencyKey: randomBytes(16).toString("base64url"),
        ...body,
      }),
    });
    let answer = null;
    try {
      answer = await response.json();
    } catch {
      answer = null;
    }
    return { status: response.status, body: answer, code: answer?.code ?? null };
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
 * starts at the lifecycle: activate when there is no instance, press launch, wait for `running`+`attached`.
 * A launch refusal goes through the run's ONE classification (`game-launch-verdict.mjs`) so a missing guardian
 * is `not_measured: guardian_pipe_unreachable` here exactly as it is for driver W, and never a second spelling.
 */
async function activateAndLaunch({ page, say, record, guardian, problems }) {
  let state = await page.evaluate(readGameState);
  if (state.ok !== true) return { kind: "not_measured", reason: "game_state_unreadable", detail: `the state route answered ${String(state.status)}` };
  if (state.prerequisites !== "met")
    return {
      kind: "not_measured",
      reason: "game_installation_not_registered",
      detail: `the run root holds no registered installation (prerequisites=${String(state.prerequisites)}); driver w-game-launch registers it, and this scenario starts after it`,
    };

  const activated = state.instanceStatus === "none" && Number.isInteger(state.instanceGeneration) && state.instanceGeneration >= 1;
  if (!activated) {
    const ready = await waitForControl(page, "activate", BUDGET.controlMs);
    record("activation control", { settled: ready.settled, control: ready.facts.controls.activate });
    if (!ready.settled)
      return { kind: "not_measured", reason: "game_lifecycle_not_activated", detail: `no usable activation control within ${String(BUDGET.controlMs)}ms at ${describeGameState(state)}` };
    await page.locator('[data-testid="game-activate"]').first().click();
    const activation = await waitForState(
      page,
      (reading) =>
        reading.ok === true && reading.instanceStatus === "none" && Number.isInteger(reading.instanceGeneration) && reading.instanceGeneration >= 1,
      BUDGET.activationMs,
    );
    record("activation", { settled: activation.settled, elapsedMs: activation.elapsedMs, state: activation.state });
    if (!activation.settled)
      return {
        kind: "not_measured",
        reason: "game_lifecycle_not_activated",
        detail: `the activation never published a generation within ${String(BUDGET.activationMs)}ms (last ${describeGameState(activation.state)})${problemOf(problems, "lifecycle/activate")}`,
      };
  }

  const launchReady = await waitForControl(page, "launch", BUDGET.controlMs);
  record("launch control", { settled: launchReady.settled, control: launchReady.facts.controls.launch });
  if (!launchReady.settled)
    return { kind: "not_measured", reason: "game_prerequisites_missing", detail: `no usable launch control within ${String(BUDGET.controlMs)}ms at ${describeGameState(await page.evaluate(readGameState))}` };

  const began = Date.now();
  await page.locator('[data-testid="game-launch"]').first().click();
  say(`launch requested through the product's own control (${JSON.stringify(launchReady.facts.controls.launch.name)})`);
  let launched = await page.evaluate(readGameState);
  let unreachable = launched.ok === true ? 0 : 1;
  while (Date.now() - began < BUDGET.launchMs) {
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
  if (reading.verdict === "not_measured") say(notMeasuredLine(reading.reason, reading.detail));
  say(`${GAME_STATES_PREFIX} ${driver}: ${reading.verdict} ${reading.reason}; ${scenario}`);
  say(`DONE-${driver.toUpperCase()}`);
  flush();
  await browser.close().catch(() => undefined);
  process.exit(reading.verdict === "failed" ? 1 : 0);
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
  waitForControl,
  activateAndLaunch,
  gamePids,
  killExactPid,
  pidAlive,
  probeGuardian,
  attachProblems,
  conclude,
};
