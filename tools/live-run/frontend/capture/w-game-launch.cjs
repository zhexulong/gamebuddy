// Driver W: the product's headline path — open the game from the Game surface, say one line into it,
// and read the companion's answer back.
//
// Every step below is the product's own seam, in the order a player meets it
// (`dialogue-web/src/components/GameStatePanel.tsx`, `dialogue-web/src/game-lifecycle-controls.ts`):
//
//   register the installation  -> `game_browser_api/v1` prerequisites: met
//   activate the lifecycle     -> POST /lifecycle/activate  (reserves and stages the owned Player Host)
//   launch the game            -> POST /game/launch        (arms and launches through the Guardian session)
//   say one line               -> the Game surface's own composer
//   read the reply             -> its own transcript, while the attachment is `attached`
//   stop the game              -> POST /game/stop          (so no game process is left behind)
//
// WHAT THIS DRIVER DOES NOT DO. It never launches Stardew itself, never spawns SMAPI, never writes the
// Mod, and never kills anything: the game process is the Host's, started and contained by its Guardian
// session, and the driver's last act is the product's own stop control. A driver that spawned the game
// would be measuring itself.
//
// THE HONEST ABSENCE. The frontend run launches the product through
// `tools/desktop-composition-launch.mjs`, which binds the run's own guardian endpoint (the one whose name
// is derived from a per-launch id — this file deliberately does not spell it, `tools/lib/`
// `live-run-preflight.test.mjs` holds the three files that do) and answers `hello` only: any
// `arm_attempt`/`launch_role`/`contain_role` frame destroys that socket
// (`tools/desktop-composition-launch.mjs:542-545`). The Host's composition hands that session to the game
// runtime (`host/src/composition/desktop-host-composition.ts:241-247`), and `arm` is attempted inside
// `launchRole` (`host/src/containment/runtime/core/contained-game-runtime.ts:192-201`), so on a machine
// with no native Desktop supervisor the launch request reaches the Host and is refused there. This driver
// therefore asserts every link up to and including the launch REQUEST, records the product's own refusal,
// and reports `not_measured: guardian_pipe_unreachable` with the endpoint population that decided it
// (`game-launch-verdict.mjs`). It never reports a pass it did not measure, and never a failure for a
// prerequisite this machine does not hold.
//
// Named outcomes, never a bare timeout:
//   NOT-MEASURED: guardian_pipe_unreachable | game_prerequisites_missing | game_install_absent |
//                 installation_registration_refused | lifecycle_activation_refused |
//                 no_installation_panel | no_installation_discovered | game_state_unreadable |
//                 game_surface_cannot_start_turn
//   game_never_reached_ready:<instance>/<attachment>
//   companion_silent_after:<ms>
//   game_launch_unavailable:<code>[:<cause>]
const path = require("node:path");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const {
  connect,
  reporter,
  PAGE_HELPERS,
  activateSurface,
  shot,
  canStartTurn,
  observe,
  observationStart,
  REPO_ROOT,
} = require("./common.cjs");
const {
  GAME_LAUNCH_PREFIX,
  LAUNCH_STEPS,
  VERDICTS,
  classifyLaunchRefusal,
  classifySilentLaunch,
  describeGameState,
  notMeasuredLine,
  readinessOf,
} = require("./game-launch-verdict.mjs");

/** The line the player says into the game surface. One line, in the language the product is set to. */
const PLAYER_LINE = "你好，你在我旁边吗？";

const BUDGET = Object.freeze({
  /** The panel's own first read; the discovery scan is a Host filesystem walk. */
  discoveryMs: 90_000,
  /** A lifecycle control that the panel draws from a fresh Game read, after the fact behind it landed. */
  controlMs: 30_000,
  activationMs: 120_000,
  /** The Host arms the Guardian, starts SMAPI, waits for the Mod's bridge and the attachment. */
  launchMs: 300_000,
  /** One real provider turn, the same budget driver F gives its reply. */
  replyMs: 240_000,
  stopMs: 120_000,
});

/** The Host's state, read through the product's own route with the page's own session. */
const readGameState = async () => {
  try {
    const response = await fetch("/api/composed-reference-game/v1/state", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { ok: false, status: response.status, href: location.href };
    const root = await response.json();
    const state = root?.game ?? null;
    const game = state?.game ?? null;
    return {
      ok: true,
      status: response.status,
      prerequisites: game?.prerequisites?.status ?? null,
      detectedGame: game?.prerequisites?.detectedGame ?? null,
      missingItems: Array.isArray(game?.prerequisites?.missingItems) ? game.prerequisites.missingItems : null,
      instanceStatus: game?.instance?.status ?? null,
      instanceGeneration: game?.instance?.generation ?? null,
      attachmentStatus: game?.attachment?.status ?? null,
      attachmentGeneration: game?.attachment?.generation ?? null,
      role: game?.role ?? null,
      companionName: game?.companionName ?? null,
      latestOutcome: game?.latestOutcome ?? null,
    };
  } catch (error) {
    // A fetch the browser could not complete is a reading of the page, not a crash in the driver: the URL
    // says whether the document moved and the driver's own Host probe (from Node) says whether the Host
    // that serves it is still there. Recorded rather than thrown, so the state is reported by name.
    return { ok: false, status: `unreachable:${String(error)}`, href: typeof location === "undefined" ? null : location.href };
  }
};

/** The installation panel's own typed state (`StardewInstallationDiscovery.tsx`). */
const readInstallationPanel = () => {
  const surface = document.querySelector('[data-testid="game-surface"]');
  const panel = surface === null ? null : surface.querySelector(".game-installation-panel");
  if (panel === null) return { present: false, surfacePresent: surface !== null, candidates: [] };
  const candidates = [...panel.querySelectorAll(".installation-candidate")].map((row) => {
    const button = row.querySelector("button");
    return {
      text: (row.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
      confirm:
        button === null
          ? null
          : { name: (button.getAttribute("aria-label") ?? button.textContent ?? "").replace(/\s+/g, " ").trim(), disabled: button.disabled === true },
    };
  });
  return {
    present: true,
    surfacePresent: true,
    dataState: panel.getAttribute("data-state"),
    statusText: (panel.querySelector(".installation-state")?.textContent ?? "").trim(),
    candidates,
  };
};

/** The Game surface's lifecycle controls as the player's own controls, with their published state. */
const readLifecycleControls = () => {
  const surface = document.querySelector('[data-testid="game-surface"]');
  const of = (testId) => {
    const el = surface === null ? null : surface.querySelector(`[data-testid="${testId}"]`);
    if (el === null) return null;
    const rect = el.getBoundingClientRect();
    return {
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden",
      name: (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim(),
    };
  };
  const panel = surface === null ? null : surface.querySelector('[data-testid="game-state-panel"]');
  const arrival = surface === null ? null : surface.querySelector('[data-testid="game-arrival-notice"]');
  return {
    panelPresent: panel !== null,
    panelState: panel === null ? null : panel.getAttribute("data-game-state"),
    activate: of("game-activate"),
    launch: of("game-launch"),
    stop: of("game-stop"),
    arrivalNotice: arrival === null ? null : (arrival.textContent ?? "").trim(),
  };
};

/** The Game surface's own transcript: a reply read here is a row the game surface painted. */
const readGameTranscript = () => {
  const surface = document.querySelector('[data-testid="game-surface"]');
  if (surface === null) return { surfacePresent: false, rows: [], settled: [], notice: null };
  const rows = [...surface.querySelectorAll(".message-list > li.message")].map((row) => ({
    role: row.className.includes("player") ? "player" : "companion",
    streaming: row.hasAttribute("data-streaming"),
    handle: row.getAttribute("data-handle"),
    text: (row.querySelector(".message-bubble")?.innerText ?? "").trim(),
  }));
  const notice = surface.querySelector(".reference-turn-notice");
  return {
    surfacePresent: true,
    rows,
    settled: rows.filter((row) => row.streaming !== true),
    notice: notice === null ? null : (notice.innerText ?? "").trim(),
  };
};

/**
 * Read-only: the pids of the two processes a running game lives in. Never a kill, and never a filter by
 * image name — the driver reports what it found and the Host's own stop control is what ends a game.
 */
const runningGameProcesses = () => {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "(Get-Process -Name StardewModdingAPI,Stardew* -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','",
      ],
      { encoding: "utf8", timeout: 20_000, windowsHide: true },
    ).trim();
    if (out.length === 0) return [];
    return out
      .split(",")
      .map((value) => Number.parseInt(value, 10))
      .filter((pid) => Number.isFinite(pid));
  } catch {
    return null;
  }
};

/**
 * The machine's own Game prerequisites, read from the file system and the process table.
 *
 * The Mod folder is a directory scan, not a name spelled here: the Host deploys the companion Mod into
 * the installation's `Mods` root and chooses the folder, so a driver that knew one spelling would
 * report a deployed Mod as absent.
 */
function machinePrerequisites(gameDir) {
  const inGame = (...parts) => path.join(gameDir, ...parts);
  const modsRoot = inGame("Mods");
  let modFolders = [];
  try {
    modFolders = readdirSync(modsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(path.join(modsRoot, name, "GameBuddy.Stardew.dll")));
  } catch {
    modFolders = [];
  }
  return {
    gameDir,
    gameInstalled: existsSync(inGame("Stardew Valley.dll")) || existsSync(inGame("Stardew Valley.exe")),
    smapiInstalled: existsSync(inGame("StardewModdingAPI.exe")),
    modsRootPresent: existsSync(modsRoot),
    modFoldersCarryingTheMod: modFolders,
    modConfigBesideTheMod: modFolders.map((name) => ({ folder: name, config: existsSync(path.join(modsRoot, name, "config.json")) })),
    runningGameProcesses: runningGameProcesses(),
  };
}

/**
 * The run's own config, read from beside the launch state the phase hands every driver
 * (`GB_SHOTS_LAUNCH_STATE` -> `<stage>/state/launch.json`, so `<stage>/state/run.json` is its sibling).
 * `gameDir` lives there and nowhere else: the launch state records the mount, the config records the run.
 */
function readRunGameDir(launchStatePath) {
  if (launchStatePath === null) return null;
  try {
    const config = JSON.parse(readFileSync(path.join(path.dirname(launchStatePath), "run.json"), "utf8"));
    return typeof config?.gameDir === "string" && config.gameDir.length > 0 ? config.gameDir : null;
  } catch {
    return null;
  }
}

/** The run's own launch state, handed to every capture driver by the phase (`GB_SHOTS_LAUNCH_STATE`). */
function readLaunchState() {
  const launchStatePath = process.env.GB_SHOTS_LAUNCH_STATE;
  if (typeof launchStatePath !== "string" || launchStatePath.length === 0) return { path: null, state: null };
  try {
    return { path: launchStatePath, state: JSON.parse(readFileSync(launchStatePath, "utf8")) };
  } catch {
    return { path: launchStatePath, state: null };
  }
}

/**
 * The pid this run recorded for its launch driver — the process that created the gate's Guardian peer.
 *
 * Read so the driver can say WHICH endpoint it found: the gate's hello-only peer is a reachable endpoint
 * that can serve no role, and mistaking it for a supervisor is how a `not_measured` would silently become
 * a fabricated pass.
 */
function runLaunchDriverPid(launchStatePath) {
  if (launchStatePath === null) return { pid: null, alive: false };
  try {
    const pid = Number.parseInt(readFileSync(path.join(path.dirname(launchStatePath), "launch-driver.pid"), "utf8").trim(), 10);
    if (!Number.isFinite(pid)) return { pid: null, alive: false };
    const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue | Measure-Object).Count`], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    }).trim();
    return { pid, alive: Number.parseInt(out, 10) > 0 };
  } catch {
    return { pid: null, alive: false };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether the Host that serves the product page still answers, asked from Node rather than from the page. */
async function hostAnswers(port) {
  if (!Number.isFinite(Number(port))) return { answered: null, reason: "no port in the launch state" };
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, { signal: AbortSignal.timeout(5000) });
    return { answered: response.ok || response.status < 500, status: response.status };
  } catch (error) {
    return { answered: false, reason: String(error) };
  }
}

(async () => {
  const launch = readLaunchState();
  const { say, flush } = reporter("w-game-launch.txt");
  const started = Date.now();
  const facts = { steps: [], detail: null, reply: null };
  const record = (step, value) => {
    facts.steps.push(step);
    say(`--- step ${step} ---`);
    say(JSON.stringify(value, null, 1));
  };

  /** The refusal body a lifecycle POST answered, captured where the product itself reads it. */
  const problems = new Map();

  const conclude = async (browser, { verdict, code, exit }) => {
    say("=== ITEM: the verdict ===");
    if (verdict === VERDICTS.notMeasured) {
      say(notMeasuredLine(code, facts.detail ?? ""));
      say(`${GAME_LAUNCH_PREFIX} w: not_measured ${code} after ${Math.round((Date.now() - started) / 1000)}s; steps=${facts.steps.join(">")}`);
    } else if (verdict === VERDICTS.failed) {
      say(`FAILED: ${code} (${facts.detail ?? ""})`);
      say(`${GAME_LAUNCH_PREFIX} w: failed ${code}; steps=${facts.steps.join(">")}`);
    } else {
      say(`${GAME_LAUNCH_PREFIX} w: measured launch=ready line=sent reply_chars=${[...(facts.reply ?? "")].length}; steps=${facts.steps.join(">")}`);
    }
    say(`the game's own processes at the end: ${JSON.stringify(runningGameProcesses())}`);
    say("DONE-W");
    flush();
    await browser.close().catch(() => undefined);
    process.exit(exit);
  };

  /** Classify one refusal through the run's one classification, then stop with its verdict. */
  const refuse = async (browser, step, { code, cause, guardian }) => {
    const reading = classifyLaunchRefusal({ step, code, cause, guardian });
    facts.detail = reading.detail;
    say(`refusal classification: ${JSON.stringify(reading)}`);
    return await conclude(browser, {
      verdict: reading.verdict === VERDICTS.notMeasured ? VERDICTS.notMeasured : VERDICTS.failed,
      code: reading.reason,
      exit: reading.verdict === VERDICTS.failed ? 1 : 0,
    });
  };

  const notMeasured = async (browser, reason, detail) => {
    facts.detail = detail;
    say(notMeasuredLine(reason, detail));
    return await conclude(browser, { verdict: VERDICTS.notMeasured, code: reason, exit: 0 });
  };

  // ---- the machine, before a browser is touched ----
  const gameDir = readRunGameDir(launch.path) ?? "D:\\Steam\\steamapps\\common\\Stardew Valley";
  const machine = machinePrerequisites(gameDir);
  record("machine", machine);
  if (!machine.gameInstalled) {
    say(notMeasuredLine("game_install_absent", `no Stardew Valley installation at ${gameDir}`));
    say(`${GAME_LAUNCH_PREFIX} w: not_measured game_install_absent; steps=${facts.steps.join(">")}`);
    say("DONE-W");
    flush();
    process.exit(0);
  }

  // The pipe namespace, read with the Host's own probe: the driver's word for
  // `guardian_pipe_unreachable` is the preflight's word, not a second spelling.
  const preflight = await import(pathToFileURL(path.join(REPO_ROOT, "tools", "lib", "live-run-preflight.mjs")).href);
  const probe = preflight.probeGuardianPipe();
  const driverPid = runLaunchDriverPid(launch.path);
  const guardian = {
    examined: probe.examined,
    endpoints: [...probe.endpoints],
    unreadable: probe.unreadable,
    runLaunchDriverPid: driverPid.pid,
    runLaunchDriverAlive: driverPid.alive,
    // The basis, stated: exactly one endpoint is bound and this run's own launch driver — the process
    // that created it — is alive, so the endpoint is that gate's hello-only peer. A second endpoint
    // makes this false, and the driver then refuses to excuse a launch refusal.
    onlyRunOwnGatePeer: probe.unreadable === null && probe.endpoints.length === 1 && driverPid.alive === true,
  };
  record("guardian", guardian);

  const { browser, page } = await connect();
  const observationFrom = await observationStart(page);
  await page.evaluate(`${PAGE_HELPERS};undefined`);
  /** The page's own story of the moment the state read stopped answering, kept for the verdict's detail. */
  const pageEvents = [];
  page.on("pageerror", (error) => pageEvents.push({ kind: "pageerror", text: String(error).slice(0, 300) }));
  page.on("requestfailed", (request) => pageEvents.push({ kind: "requestfailed", url: request.url().slice(0, 200), reason: request.failure()?.errorText ?? null }));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) pageEvents.push({ kind: "navigated", url: frame.url().slice(0, 200) });
  });
  page.on("response", (response) => {
    const match = /\/(lifecycle\/activate|game\/launch|game\/stop|game\/installation\/discovery\/confirm)$/u.exec(response.url());
    if (match === null || response.status() < 400) return;
    const route = match[1];
    response
      .text()
      .then((text) => {
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = { code: "unparseable_problem_body" };
        }
        problems.set(route, { status: response.status(), code: body?.code ?? null, cause: body?.cause ?? null });
      })
      .catch(() => problems.set(route, { status: response.status(), code: "unreadable_problem_body", cause: null }));
  });

  /** Poll the product's own state until `predicate` holds, or the budget runs out. Never a bare sleep. */
  const waitForState = async (predicate, budgetMs) => {
    const began = Date.now();
    let state = await page.evaluate(readGameState);
    while (Date.now() - began < budgetMs) {
      if (predicate(state)) return { settled: true, state, elapsedMs: Date.now() - began };
      await sleep(1000);
      state = await page.evaluate(readGameState);
    }
    return { settled: predicate(state), state, elapsedMs: Date.now() - began };
  };

  /**
   * Poll until ONE lifecycle control is drawn, visible and pressable, or the budget runs out.
   *
   * The control is not there the instant the Host publishes the fact behind it: the panel re-reads the
   * Game projection after an admitted installation and after an activation (`onAdmitted={() =>
   * void rereadGame()}` in `dialogue-web/src/components/GameSurface.tsx:1168`, `dialogue-web/src/components/
   * GameSurface.tsx:390`), so a single read taken right after the route said `prerequisites: met` still
   * sees the control disabled and would report a refusal the product never made. Measured 2026-11-15:
   * reading it once reported `lifecycle_activation_refused` one second after the Host answered `met`.
   */
  const waitForControl = async (name, budgetMs) => {
    const began = Date.now();
    let controls = await page.evaluate(readLifecycleControls);
    for (;;) {
      const control = controls[name];
      if (control !== null && control.visible === true && control.disabled !== true)
        return { settled: true, controls, elapsedMs: Date.now() - began };
      if (Date.now() - began >= budgetMs) return { settled: false, controls, elapsedMs: Date.now() - began };
      await sleep(500);
      controls = await page.evaluate(readLifecycleControls);
    }
  };

  // ---- the Game surface ----
  await page.setViewportSize({ width: 1440, height: 900 });
  const switchKind = await activateSurface(page, "游戏");
  record("surface", { switchKind, mounted: await page.evaluate(() => document.querySelector('[data-testid="game-surface"]') !== null) });
  await shot(page, "90-game-surface-before.png");

  let state = await page.evaluate(readGameState);
  record("state before", state);
  if (state.ok !== true) return await notMeasured(browser, "game_state_unreadable", `the product's own state route answered HTTP ${String(state.status)}`);

  // ---- 1. the installation registration ----
  if (state.prerequisites !== "met") {
    let panel = await page.evaluate(readInstallationPanel);
    const panelBegan = Date.now();
    const terminal = new Set(["no-candidates", "source-unavailable", "error", "cancelled", "expired"]);
    while (Date.now() - panelBegan < BUDGET.discoveryMs && panel.present === true && panel.candidates.length === 0 && !terminal.has(panel.dataState)) {
      await sleep(1000);
      panel = await page.evaluate(readInstallationPanel);
    }
    record("installation panel", panel);
    if (panel.present !== true) return await notMeasured(browser, "no_installation_panel", "the Game surface painted no installation panel, so no registration control exists to drive");
    if (panel.candidates.length === 0)
      return await notMeasured(
        browser,
        "no_installation_discovered",
        `the panel reached data-state=${JSON.stringify(panel.dataState)} with no candidate within ${String(BUDGET.discoveryMs)}ms: ${JSON.stringify(panel.statusText)}`,
      );
    const first = panel.candidates[0];
    if (first.confirm === null || first.confirm.disabled)
      return await notMeasured(browser, "no_installation_discovered", `the first candidate offered no enabled confirm control: ${JSON.stringify(first)}`);
    say(`confirming the first candidate: ${JSON.stringify(first.text)}`);
    await page.locator(".game-installation-panel .installation-candidate button").first().click();
    const registration = await waitForState((reading) => reading.ok === true && reading.prerequisites === "met", BUDGET.discoveryMs);
    record("registration", registration);
    if (!registration.settled) {
      const problem = problems.get("game/installation/discovery/confirm") ?? null;
      if (problem !== null) return await refuse(browser, LAUNCH_STEPS.installation, { code: problem.code, cause: problem.cause, guardian });
      return await notMeasured(
        browser,
        "installation_registration_refused",
        `the Host never published prerequisites: met within ${String(BUDGET.discoveryMs)}ms (last prerequisites=${String(registration.state.prerequisites)})`,
      );
    }
  } else {
    say("the installation was already registered for this run root");
    record("installation", { prerequisites: "met", detectedGame: state.detectedGame });
  }

  // ---- 2. the lifecycle activation ----
  state = await page.evaluate(readGameState);
  record("state after registration", state);
  const activated = () => state.instanceStatus === "none" && typeof state.instanceGeneration === "number" && state.instanceGeneration >= 1;
  if (!activated()) {
    const activationReady = await waitForControl("activate", BUDGET.controlMs);
    record("activation control", activationReady);
    if (!activationReady.settled)
      return await notMeasured(
        browser,
        "lifecycle_activation_refused",
        `no usable activation control within ${String(BUDGET.controlMs)}ms at ${describeGameState(state)} (prerequisites=${String(state.prerequisites)}): ${JSON.stringify(activationReady.controls.activate)}`,
      );
    await page.locator('[data-testid="game-activate"]').first().click();
    say(`activation requested through the product's own control (${JSON.stringify(activationReady.controls.activate.name)})`);
    const activation = await waitForState(
      (reading) =>
        reading.ok === true &&
        reading.prerequisites === "met" &&
        reading.instanceStatus === "none" &&
        typeof reading.instanceGeneration === "number" &&
        reading.instanceGeneration >= 1,
      BUDGET.activationMs,
    );
    record("activation", activation);
    const launchReady = await waitForControl("launch", BUDGET.controlMs);
    record("launch control", launchReady);
    if (!launchReady.settled) {
      const problem = problems.get("lifecycle/activate") ?? null;
      if (problem !== null) return await refuse(browser, LAUNCH_STEPS.activation, { code: problem.code, cause: problem.cause, guardian });
      return await notMeasured(
        browser,
        "lifecycle_activation_refused",
        `no launch control appeared within ${String(BUDGET.activationMs)}ms of the activation request (last ${describeGameState(activation.state)}; activation settled=${String(activation.settled)}; launch control ${JSON.stringify(launchReady.controls.launch)})`,
      );
    }
  } else {
    say(`the lifecycle is already activated for generation ${String(state.instanceGeneration)}`);
  }

  // ---- 3. the launch request. Everything above ran whatever the refusal below turns out to be. ----
  state = await page.evaluate(readGameState);
  const launchReady = await waitForControl("launch", BUDGET.controlMs);
  record("launch preconditions", { state, controls: launchReady.controls, elapsedMs: launchReady.elapsedMs });
  if (!launchReady.settled)
    return await notMeasured(
      browser,
      "game_prerequisites_missing",
      `no usable launch control within ${String(BUDGET.controlMs)}ms at ${describeGameState(state)}: ${JSON.stringify(launchReady.controls.launch)}`,
    );
  const controls = launchReady.controls;
  const launchBegan = Date.now();
  await page.locator('[data-testid="game-launch"]').first().click();
  say(`launch requested through the product's own control (${JSON.stringify(controls.launch.name)})`);
  /*
   * The launch is waited for by NAME, and it gives up in two ways rather than one: the readiness it asked
   * for (`readinessOf`), or a state read that stopped answering for five consecutive seconds - the shape a
   * Host that died under the launch request leaves. Waiting the whole launch budget for a page that cannot
   * reach its Host turns a named failure into a timeout, which is what this driver exists to avoid.
   */
  let launched = await page.evaluate(readGameState);
  let unreachable = launched.ok === true ? 0 : 1;
  while (Date.now() - launchBegan < BUDGET.launchMs) {
    if (readinessOf(launched) !== "pending" || unreachable >= 5) break;
    await sleep(1000);
    launched = await page.evaluate(readGameState);
    unreachable = launched.ok === true ? 0 : unreachable + 1;
  }
  record("launch", {
    settled: readinessOf(launched) !== "pending",
    elapsedMs: Date.now() - launchBegan,
    state: launched,
    preconditions: { controls, guardian },
    problems: [...problems.entries()],
    hostAnswers: await hostAnswers(launch.state?.port),
    pageEvents: pageEvents.slice(-12),
  });
  const launchProblem = problems.get("game/launch") ?? null;
  if (launchProblem !== null) return await refuse(browser, LAUNCH_STEPS.launch, { code: launchProblem.code, cause: launchProblem.cause, guardian });
  if (readinessOf(launched) !== "ready") {
    const host = await hostAnswers(launch.state?.port);
    const stateText = launched.ok === true ? describeGameState(launched) : `state_unreadable:${String(launched.status)}`;
    const observed = `the launch was requested through the product's own control (${JSON.stringify(controls.launch.name)}) and the surface then answered ${stateText}; the Host answers its own port: ${JSON.stringify(host)}; the page's own events: ${JSON.stringify(pageEvents.slice(-4))}`;
    /*
     * Two shapes, and they are not interchangeable. A Host that answered a bounded problem is classified
     * from that problem. A Host that stopped answering at all is the same missing prerequisite reached
     * through the transport when nothing bound can arm - and the Host's own failure when something can.
     */
    const reading = launched.ok === true ? null : classifySilentLaunch({ guardian, detail: observed });
    facts.detail = reading === null ? `${observed}; the surface never reached instance=running/attachment=attached within ${String(BUDGET.launchMs)}ms` : reading.detail;
    if (reading !== null) {
      say(`refusal classification: ${JSON.stringify(reading)}`);
      return await conclude(browser, {
        verdict: reading.verdict === VERDICTS.notMeasured ? VERDICTS.notMeasured : VERDICTS.failed,
        code: reading.reason,
        exit: reading.verdict === VERDICTS.failed ? 1 : 0,
      });
    }
    const code = `game_never_reached_ready:${stateText}`;
    say(`FAILED: ${code}`);
    return await conclude(browser, { verdict: VERDICTS.failed, code, exit: 1 });
  }
  say(`the game reached ready: ${describeGameState(launched)} after ${String(Date.now() - launchBegan)}ms`);
  await shot(page, "91-game-ready.png");

  // ---- 4. one player line, in the game surface ----
  const turnGate = await canStartTurn(page);
  const transcriptBefore = await page.evaluate(readGameTranscript);
  record("composer", { turnGate, settledBefore: transcriptBefore.settled.length, surfacePresent: transcriptBefore.surfacePresent });
  if (!turnGate.ok)
    return await notMeasured(
      browser,
      "game_surface_cannot_start_turn",
      `the launched game surface cannot start a turn (${turnGate.reason}); it says: ${turnGate.sentence ?? "(no sentence)"}`,
    );
  await page.evaluate((line) => {
    const scope = document.querySelector('[data-testid="game-surface"]');
    const area = scope.querySelector(".composer-textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(area, line);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }, PLAYER_LINE);
  await page.waitForTimeout(250);
  await page.locator('[data-testid="game-surface"] .composer-button.send-button').first().click();
  say(`one player line sent in the game surface: ${JSON.stringify(PLAYER_LINE)}`);
  const companionsBefore = transcriptBefore.settled.filter((row) => row.role === "companion").length;
  const replyBegan = Date.now();
  let after = await page.evaluate(readGameTranscript);
  while (Date.now() - replyBegan < BUDGET.replyMs && after.settled.filter((row) => row.role === "companion").length <= companionsBefore) {
    await sleep(1000);
    after = await page.evaluate(readGameTranscript);
  }
  const elapsedReply = Date.now() - replyBegan;
  record("reply", { elapsedMs: elapsedReply, notice: after.notice, settled: after.settled });
  await shot(page, "92-game-reply.png");
  const companions = after.settled.filter((row) => row.role === "companion");
  const replyRow = companions.length === 0 ? null : companions[companions.length - 1];
  if (replyRow === null || replyRow.text.trim().length === 0) {
    const code = `companion_silent_after:${String(elapsedReply)}`;
    facts.detail = `no companion row carried text within ${String(BUDGET.replyMs)}ms; the surface's own notice was ${JSON.stringify(after.notice)}`;
    say(`FAILED: ${code}`);
    return await conclude(browser, { verdict: VERDICTS.failed, code, exit: 1 });
  }
  // The reply is from the game path because it arrived on the game surface while the Host held the
  // attachment. Both facts are read here; neither is a screenshot.
  const stateAfterReply = await page.evaluate(readGameState);
  record("state after the reply", stateAfterReply);
  facts.reply = replyRow.text;
  say("=== ITEM: the companion's reply (VERBATIM) ===");
  say(JSON.stringify(replyRow.text));
  say(
    `reply role=${replyRow.role} handle=${JSON.stringify(replyRow.handle)} chars=${[...replyRow.text].length} instance=${String(stateAfterReply.instanceStatus)} attachment=${String(stateAfterReply.attachmentStatus)}`,
  );
  if (stateAfterReply.instanceStatus !== "running" || stateAfterReply.attachmentStatus !== "attached") {
    const code = `game_never_reached_ready:${describeGameState(stateAfterReply)}`;
    facts.detail = `the reply settled while the Host reported ${describeGameState(stateAfterReply)}, so it is not a reply from an attached game`;
    say(`FAILED: ${code}`);
    return await conclude(browser, { verdict: VERDICTS.failed, code, exit: 1 });
  }
  await observe(page, say, "w", { sinceMs: observationFrom });

  // ---- 5. stop the game this driver asked the product to start ----
  const stopControl = await page.evaluate(readLifecycleControls);
  record("stop control", stopControl);
  if (stopControl.stop !== null && stopControl.stop.visible === true) {
    await page.locator('[data-testid="game-stop"]').first().click();
    const stopped = await waitForState(
      (reading) => reading.ok === true && (reading.instanceStatus === "stopped" || reading.instanceStatus === "none") && reading.attachmentStatus !== "attached",
      BUDGET.stopMs,
    );
    record("stop", stopped);
    if (!stopped.settled)
      say(`the stop request did not settle within ${String(BUDGET.stopMs)}ms (last ${describeGameState(stopped.state)}); the run's own cleanup names what remained`);
  } else say(`no stop control was offered (${JSON.stringify(stopControl.stop)}); the run's own cleanup names what remained`);
  return await conclude(browser, { verdict: VERDICTS.measured, code: "measured", exit: 0 });
})().catch((error) => {
  console.log("DRIVER W FAILED:", String(error).slice(0, 900));
  process.exit(1);
});
