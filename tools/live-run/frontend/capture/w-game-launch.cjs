// Driver W: the product's headline path — open the game from the Game surface, say one line into it,
// and read the companion's answer back.
//
// Every step below is the product's own seam, in the order a player meets it
// (`dialogue-web/src/components/GameStatePanel.tsx`, `dialogue-web/src/game-lifecycle-controls.ts`):
//
//   register the installation  -> `game_browser_api/v1` prerequisites: met
//   activate the lifecycle     -> POST /lifecycle/activate  (reserves and stages the owned Player Host)
//   launch the game            -> POST /game/launch        (arms and launches through the Guardian session)
//   choose the cabin           -> `cabin_read` then `cabin_confirm` from the guide's own third step,
//                                 which is the only path to the AI-client profile and the attachment
//                                 (`host/src/stardew-production-lifecycle-coordinator.internal.ts:2082-2152`)
//   say one line               -> the Game surface's own composer
//   read the reply             -> its own transcript, while the attachment is `attached`
//   her agent awake            -> the Host's own `GAME_TURN_ACCOUNT` line, read out of the entry's stderr
//   stop the game              -> POST /game/stop          (so no game process is left behind)
//
// WAITING IS MEASURED, NOT ENOUGH. The launch wait prints the product's own state every few seconds and
// ends on a named plateau as well as on a budget, because "slow" and "stuck" are different findings.
// Measured 2026-11-15 (`.live-runs/gamewait2`, 600 s budget): the launch chain took 9 s to a loaded world,
// the tuple then held `instance=launching/attachment=none` for the whole 120 s plateau, the panel's own
// cabin refresh answered with the cabin in 45 ms, and the confirmation stopped at the Mod's farmhand
// provisioning (`stardew-attachment-response.json`: `awaiting_save`/`binding_persist_pending`) until the
// Host's 60 s window ended `stardew_manifest_handoff_uncertain`. The budget is named and overridable
// (`GAMEBUDDY_LIVE_RUN_LAUNCH_BUDGET_MS`) so a run can buy more time without editing a number nobody can
// see.
//
// WHAT THIS DRIVER DOES NOT DO. It never launches Stardew itself, never spawns SMAPI, never writes the
// Mod, and never kills anything: the game process is the Host's, started and contained by its Guardian
// session, and the driver's last act is the product's own stop control. A driver that spawned the game
// would be measuring itself.
//
// THE HONEST LIMITS. The frontend run launches the product through
// `tools/desktop-composition-launch.mjs`, which binds the run's own guardian endpoint (the one whose name
// is derived from a per-launch id - this file deliberately does not spell it, `tools/lib/`
// `live-run-preflight.test.mjs` holds the files that do) and serves that session by starting the
// INSTALLED generation's resident Guardian and relaying `arm_attempt`/`launch_role`/`contain_role` to
// it (`tools/lib/guardian-role-broker.mjs`). The Host's composition hands that session to the game
// runtime (`host/src/composition/desktop-host-composition.ts:241-247`), and `arm` is attempted inside
// `launchRole` (`host/src/containment/runtime/core/contained-game-runtime.ts:192-201`), so the launch
// request reaches a real Job owner here. Two limits are reported rather than assumed away:
//
//   - whether that peer could ARM at all is read from the launch state's own role-broker mode
//     (`roleBroker.mode`: `armable` / `hello_only`), because a generation that publishes no Guardian
//     leaves the peer hello-only and then no role can be served;
//   - the peer authenticates the Host by the per-launch id only - Node cannot reproduce the Desktop's
//     pid/session/SID check - so a launch that reaches ready here proves the launch chain and is weaker
//     evidence about the Desktop's containment policy.
//
// This driver asserts every link up to and including the launch REQUEST, records the product's own
// refusal, and reports `not_measured: guardian_pipe_unreachable` only while nothing that can arm is
// bound (`game-launch-verdict.mjs`). It never reports a pass it did not measure, and never a failure for
// a prerequisite this machine does not hold.
//
// THREE VERDICTS, NOT TWO. The chain's own target - `instance=running` with `attachment=attached` - is
// unreachable by construction for a GameBuddy-launched Player Host (`PRODUCT_GAPS` in
// `game-launch-verdict.mjs` names each missing state, with the code that makes it missing). A driver
// that failed on that target would fail on every machine, every run, for a reason no operator can act
// on, and its readers would learn to ignore it. So the run prints the chain rung by rung - how far the
// launch got, when, and the fact that proved it - and reports `blocked_by_product:<gap>` ONLY when this
// run's own readings prove the gap it names. Everything else keeps its old word: `failed` is still the
// product refusing something it was asked to do.
//
// WHERE THE CHAIN REALLY STOPPED ON 2026-11-15, and the two things that run REFUTED. The last run
// (`.live-runs/runconfirm`, artifact `w-game-launch.txt`) pressed the cabin choice once and the game
// TOOK it: the press at 1794705319241, the Mod's own stamp 52 ms later, and no
// `stardew_cabin_choice_stale` anywhere in the run. What stopped the chain is the step after that: the
// Mod created a farmhand for the cabin, found it unusable, rolled it back
// (`integrations/stardew/HostFarmhandProvisioner.cs:572-580`) and answered
// `rejected`/`farmhand_not_initialized` - stamped 1794705319293, 110 ms BEFORE the Host answered
// `409 stardew_manifest_handoff_uncertain`. Both facts are in that run's artifact, which is why the stop
// is now `blocked_by_product:farmhand_not_initialized` and not `failed`. Neither hypothesis below should
// be re-derived:
//
//   - the 3 s advertisement was NOT the blocker. The one offer this run read carried a 2087 ms window
//     (`expiresAtMs=1794705320401` read at 01:15:18.314Z) and the press landed 927 ms after that read,
//     leaving 1160 ms of the window unspent. A page that answers inside two thirds of the Mod's beat is
//     not a page the beat starved.
//   - whether `expiresAtMs` is minted once per advertisement or refreshed on every read is UNMEASURED,
//     and that absence is not a zero: the ten cabin reads before the offer was live all answered
//     `state_unavailable` (409 at 1794705309009 .. 1794705317299) and the eleventh, at 1794705318314, was
//     the run's only live offer - so there is no second one to compare it with. "Permanently stale" is
//     therefore not a finding of this run either, and `staleOfferReading` in `game-launch-verdict.mjs`
//     still requires two consecutive live reads before it will say the window is the cause.
//
// Named outcomes, never a bare timeout:
//   NOT-MEASURED: guardian_pipe_unreachable | game_prerequisites_missing | game_install_absent |
//                 smapi_install_absent | guardian_image_absent |
//                 installation_registration_refused | lifecycle_activation_refused |
//                 no_installation_panel | no_installation_discovered |
//                 installation_panel_never_settled | game_state_unreadable |
//                 game_surface_cannot_start_turn | cabin_handoff_not_offered |
//                 host_turn_account_unreadable
//   BLOCKED-BY-PRODUCT: instance_status_never_running |
//                 cabin_offer_expires_before_any_ui_can_answer | farmhand_not_initialized
//   game_never_reached_ready:<instance>/<attachment>
//   cabin_read_never_fired | cabin_handoff_no_cabin:<state> | cabin_handoff_not_admitted |
//   cabin_handoff_did_not_attach:<state>
//   companion_silent_after:<ms>
//   game_launch_unavailable:<code>[:<cause>]
//   turn_account_absent | turn_account_without_world_fact | turn_account_without_world_fact_member
const path = require("node:path");
const { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } = require("node:fs");
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
  waitForPanelSettled,
  REPO_ROOT,
} = require("./common.cjs");
const {
  CHAIN_STEP_NAMES,
  CHAIN_STEPS,
  GAME_LAUNCH_PREFIX,
  LAUNCH_PLATEAU_MS,
  LAUNCH_STEPS,
  LIFECYCLE_SHAPES,
  PRODUCT_GAPS,
  VERDICTS,
  blockedByProductLine,
  chainStepsLine,
  classifyChainStop,
  classifyLaunchRefusal,
  classifySilentLaunch,
  describeChain,
  describeGameState,
  describeLaunchPlateau,
  describeLaunchProgress,
  gameLocaleMismatch,
  lifecycleShapeOf,
  liveGameLocaleOf,
  notMeasuredLine,
  readinessOf,
  responseStampForPress,
} = require("./game-launch-verdict.mjs");
const { pressStop, stepRecorder } = require("./game-surface-states.cjs");
const { prepareOwnWorld, describeOwnWorld } = require("./fixture-world.cjs");
const { readInstallationPanel, registerInstallation } = require("./installation-registration.cjs");
const { agentAwakeOf, describeTurnAccount, readTurnAccount } = require("./turn-account.cjs");

/** The line the player says into the game surface. One line, in the language the product is set to. */
const PLAYER_LINE = "你好，你在我旁边吗？";

/**
 * The launch wait, by name and overridable per run.
 *
 * The Host arms the Guardian, starts SMAPI and waits for the Mod's world; the surface then waits for the
 * cabin step this driver drives below. The default is the same 300 s the driver has always waited; a run
 * that suspects a slower machine than the one measured on 2026-11-15 asks for more by name and the number
 * it used is printed in the report, so no wait in the log is an unnamed constant.
 */
function launchBudgetMs() {
  const raw = process.env.GAMEBUDDY_LIVE_RUN_LAUNCH_BUDGET_MS;
  if (raw === undefined || raw.trim().length === 0) return 300_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 10_000)
    throw new Error(
      `GAMEBUDDY_LIVE_RUN_LAUNCH_BUDGET_MS must be a whole number of milliseconds >= 10000; read ${JSON.stringify(raw)}`,
    );
  return Math.floor(parsed);
}

const BUDGET = Object.freeze({
  /** The panel's own first read; the discovery scan is a Host filesystem walk. */
  discoveryMs: 90_000,
  /** One press of the panel's confirm, and of its 重新查找: both answer a Host walk, not a pixel. */
  registrationMs: 20_000,
  /** A lifecycle control that the panel draws from a fresh Game read, after the fact behind it landed. */
  controlMs: 30_000,
  activationMs: 120_000,
  /** The launch request's own wait: see `launchBudgetMs` for the default and the override. */
  launchMs: launchBudgetMs(),
  /** How often the launch wait prints the product's own state and the game's last log line. */
  progressMs: 5_000,
  /** An unchanged launch state for this long is a plateau, not a slow launch. */
  plateauMs: LAUNCH_PLATEAU_MS,
  /** How long the guide's third step is given to offer a cabin before the run names the refusal. */
  cabinReadMs: 120_000,
  /** The cabin confirmation itself: the Mod provisions a farmhand and the Host admits its signed manifest. */
  cabinConfirmMs: 180_000,
  /** One real provider turn, the same budget driver F gives its reply. */
  replyMs: 240_000,
  /**
   * How long the attached session runs before the STOP, so her client's first observations reach the Host and her
   * turn opens. The STOP settles that turn and step 7 reads the account; a run whose turn settles inside the
   * window leaves sooner. See step 4b.
   */
  attachedWindowMs: 90_000,
  /**
   * How long the account may take to land after the STOP settled the turn it reports: this is a write's lag
   * behind a settlement the product has already acknowledged, not a turn's budget. See step 7.
   */
  accountGraceMs: 20_000,
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
      instanceStatus: game?.instance?.status ?? null,
      instanceGeneration: game?.instance?.generation ?? null,
      attachmentStatus: game?.attachment?.status ?? null,
      attachmentGeneration: game?.attachment?.generation ?? null,
      // The coordinator's `stopping`/`stopped` word, published at `game-browser-contract/index.ts:367`; the stop
      // wait reads it through `capture/game-surface-states.cjs`.
      connectionStatus: game?.connectionStatus ?? null,
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

/**
 * The guide's third step as the player reads it: the cabin the Host offers, and the one control that can
 * ask again.
 *
 * The shapes are the panel's own (`dialogue-web/src/components/GameStatePanel.tsx:944-1029`): the section,
 * the choice list with one confirm per cabin, and - in every state that has no choice to offer - the
 * single secondary control `deriveCabinHandoffActions` says is the step (`read_cabins_again` for a
 * read that returned nothing, `read_game_again` after an unconfirmed confirmation). The driver names what
 * it sees instead of deciding what the panel meant.
 */
const readCabinHandoff = () => {
  const surface = document.querySelector('[data-testid="game-surface"]');
  const handoff = surface === null ? null : surface.querySelector("section.stardew-cabin-handoff");
  if (handoff === null) return { present: false, choices: [], secondary: [], sentences: [], launchLine: null };
  const list = handoff.querySelector('[data-testid="cabin-choice-list"]');
  const describeButton = (button) => {
    const rect = button.getBoundingClientRect();
    return {
      name: (button.getAttribute("aria-label") ?? button.textContent ?? "").replace(/\s+/gu, " ").trim(),
      disabled: button.disabled === true || button.getAttribute("aria-disabled") === "true",
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(button).visibility !== "hidden",
    };
  };
  const choices =
    list === null
      ? []
      : [...list.querySelectorAll("li.game-choice")].map((row) => {
          const button = row.querySelector("button");
          return {
            label: (row.querySelector(".game-choice-label")?.textContent ?? "").trim(),
            confirm: button === null ? null : describeButton(button),
          };
        });
  /*
   * The panel's own account of the launch wait, which is a different fact from the choice list:
   * `reading` is the panel still asking the Host by itself (the admitted launch's bounded read), and
   * `wait_expired` is its budget spent with nothing back. Read from the panel's own test ids rather
   * than from the copy, so the driver is not deciding what a sentence meant
   * (`dialogue-web/src/components/GameStatePanel.tsx:980-1000`).
   */
  const launchLineFor = (testId, kind) => {
    const node = handoff.querySelector(`[data-testid="${testId}"]`);
    return node === null ? null : { kind, text: (node.textContent ?? "").replace(/\s+/gu, " ").trim() };
  };
  const launchLine =
    launchLineFor("cabin-launch-reading", "reading") ??
    launchLineFor("cabin-launch-found", "cabin_ready") ??
    launchLineFor("cabin-launch-wait-expired", "wait_expired");
  return {
    present: true,
    choices,
    secondary: [...handoff.querySelectorAll("button.game-secondary-action")].map(describeButton),
    sentences: [...handoff.querySelectorAll(".game-status, .game-subpanel-note")]
      .map((node) => (node.textContent ?? "").replace(/\s+/gu, " ").trim())
      .filter((text) => text.length > 0),
    launchLine,
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
 * Read-only: the pids and image names of the processes a running game lives in.
 *
 * Never a kill, and never a filter by image name for anything but READING the table: the driver reports
 * what it found, and the Host's own stop control is what ends a game.
 */
const gameProcesses = () => {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "(Get-Process -Name StardewModdingAPI,Stardew* -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id):$($_.ProcessName)\" }) -join ','",
      ],
      { encoding: "utf8", timeout: 20_000, windowsHide: true },
    ).trim();
    if (out.length === 0) return [];
    return out
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const [pid, name] = entry.split(":");
        return { pid: Number.parseInt(pid, 10), name: name ?? "unknown" };
      })
      .filter((row) => Number.isFinite(row.pid));
  } catch {
    return null;
  }
};

/** Just the pids: the shape `machinePrerequisites` records and the verdict line prints. */
const runningGameProcesses = () => {
  const rows = gameProcesses();
  return rows === null ? null : rows.map((row) => row.pid);
};


/**
 * The machine's own Game prerequisites, read from the file system and the process table.
 *
 * The Mod folder is a directory scan, not a name spelled here: the Host deploys the companion Mod into
 * the installation's `Mods` root and chooses the folder, so a driver that knew one spelling would
 * report a deployed Mod as absent.
 *
 * `launchChain` states what the chain below actually needs from this machine, one line per prerequisite,
 * with the fact that was read for it. Four of them, and they are different kinds of thing: the game and
 * SMAPI are files this driver can see; the generation and its resident Guardian image are published by
 * the run's own launch phase and recorded in `state/launch.json` (`roleBroker.mode` is `armable` only
 * when the generation ships the image, `hello_only` when it does not). Naming all four is what lets a
 * later reader tell "this machine has no game" from "this generation cannot arm a role".
 */
function machinePrerequisites(gameDir, launchState) {
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
  const roleBroker = launchState?.roleBroker ?? null;
  return {
    gameDir,
    gameInstalled: existsSync(inGame("Stardew Valley.dll")) || existsSync(inGame("Stardew Valley.exe")),
    smapiInstalled: existsSync(inGame("StardewModdingAPI.exe")),
    modsRootPresent: existsSync(modsRoot),
    modFoldersCarryingTheMod: modFolders,
    modConfigBesideTheMod: modFolders.map((name) => ({ folder: name, config: existsSync(path.join(modsRoot, name, "config.json")) })),
    launchChain: {
      game: existsSync(inGame("Stardew Valley.dll")) || existsSync(inGame("Stardew Valley.exe")),
      smapi: existsSync(inGame("StardewModdingAPI.exe")),
      mod: modFolders.length > 0,
      generationServesTheGuardian: roleBroker?.mode ?? null,
      guardianImage: roleBroker?.image?.path ?? null,
      guardianImageSha256: roleBroker?.image?.sha256 ?? null,
    },
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

/**
 * The world policy this run was configured with (`--world=existing`), read from the run's own config.
 *
 * `own` is the default: the run creates the world it measures. `existing` enters the world the product
 * already has, which is how a run measures a world an earlier run created (`capture/fixture-world.cjs`).
 */
function readRunWorldPolicy(launchStatePath) {
  if (launchStatePath === null) return "own";
  try {
    return JSON.parse(readFileSync(path.join(path.dirname(launchStatePath), "run.json"), "utf8"))?.world === "existing"
      ? "existing"
      : "own";
  } catch {
    return "own";
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
 * Read so the driver can say WHICH endpoint it found: this run's own peer is a reachable endpoint whose
 * ability to serve a role depends on the generation it launched (`roleBroker.mode` in the launch state),
 * and mistaking it for a supervisor - or for a peer that cannot arm - is how a `not_measured` would
 * silently become a fabricated pass in either direction.
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

/**
 * The tail of SMAPI's own log: `{ lines, writtenAtMs }`, or `null` when this machine has no such file.
 *
 * The Mod writes it (`%APPDATA%\StardewValley\ErrorLogs\SMAPI-latest.txt`), so a wait that stops moving can
 * be attributed to a game that is idle rather than to a Host still working. Read-only, bounded to the tail,
 * and the file's mtime travels with the lines because the log outlives the process that wrote it.
 */
function smapiLogTail(budgetBytes = 262_144) {
  const appData = process.env.APPDATA;
  if (typeof appData !== "string" || appData.length === 0) return null;
  const file = path.join(appData, "StardewValley", "ErrorLogs", "SMAPI-latest.txt");
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.max(0, Math.min(budgetBytes, size));
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, size - length);
      const lines = buffer.toString("utf8", 0, read).split(/\r?\n/gu).filter((line) => line.trim().length > 0);
      return { lines, writtenAtMs: statSync(file).mtimeMs };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** The launched game's own last word, read from the log's tail. `null` when there was no log to read. */
function lastSmapiLine(budgetBytes = 16_384) {
  const tail = smapiLogTail(budgetBytes);
  if (tail === null) return null;
  const salient =
    [...tail.lines].reverse().find((line) => line.includes("GameBuddy")) ?? tail.lines[tail.lines.length - 1] ?? null;
  return { line: salient, writtenAtMs: tail.writtenAtMs };
}

/**
 * The rungs of the chain the launched GAME is the only witness of, each as the line that proves it.
 *
 * The Host's own state route answers `launching/none` for a whole launch and cannot say whether a save
 * was loaded or a cabin was built; the game can, in its own words. Each pattern is the engine's or the
 * Mod's own sentence (`Context: loaded save` is SMAPI echoing the engine; the cabin line is
 * `ModEntry`'s own log of the native construction path), and the LAST match is the one that counts
 * because the log is append-only within one run.
 */
const CHAIN_LOG_PATTERNS = Object.freeze([
  { rung: CHAIN_STEPS.saveLoaded, pattern: /Context: loaded save '([^']+)'/u },
  {
    // Two sentences, one fact: the Mod's own answer for this world's Cabin. The first is a build on a free
    // cabin pad; the second is a world whose own starting Cabin was already there, with the engine's own
    // unclaimed native slot released so the companion can be provisioned into it (a fresh world always
    // answers this way). Both leave a Cabin this companion may use, which is what the rung names.
    rung: CHAIN_STEPS.cabinReady,
    pattern:
      /gave the companion world a native Cabin.*cabins_now=(\d+)|released the unclaimed native Farmhand slot .*provisioned into it/u,
  },
]);

/**
 * What the game's own log proves about this launch, or why it proves nothing.
 *
 * Freshness is part of the proof: `SMAPI-latest.txt` is rewritten by each game start but it outlives
 * the process, so a tail written before this run's launch cannot be cited for it.
 */
function gameLogChainFacts(launchBeganMs) {
  const tail = smapiLogTail();
  if (tail === null) return { read: false, reason: "no SMAPI log to read on this machine", facts: {} };
  if (Number.isFinite(launchBeganMs) && tail.writtenAtMs < launchBeganMs)
    return {
      read: true,
      writtenAtMs: tail.writtenAtMs,
      reason: `SMAPI-latest.txt was last written ${new Date(tail.writtenAtMs).toISOString()}, before this launch`,
      facts: {},
    };
  const facts = {};
  for (const { rung, pattern } of CHAIN_LOG_PATTERNS) {
    // `line` is the fragment the rung names; `raw` is the whole SMAPI line it was found on, which is what
    // a reader of a DIFFERENT fact on that line needs (the launch locale lives at the end of the save-loaded
    // line, outside the pattern). Measured 2026-11-16: reading the locale out of `line` found nothing, so the
    // verdict said the run and the game agreed while the game was English.
    const found = [...tail.lines].reverse().map((text) => ({ text, match: pattern.exec(text) })).find((entry) => entry.match !== null);
    if (found !== undefined) facts[rung] = { line: found.match[0], captured: found.match[1] ?? null, raw: found.text };
  }
  return { read: true, writtenAtMs: tail.writtenAtMs, reason: null, facts };
}

/**
 * The Mod's own published word for an attachment request, read from the run root it was written into.
 *
 * The response file lives at `<declaredDataRoot>/stardew-private-bootstrap/<bootstrap>/session/`
 * (`integrations/stardew/FarmhandProvisioningModels.cs:17`), one directory per bootstrap, so the read is
 * a bounded scan of that level rather than a path this driver spells. Its `state`/`reasonCode` are the
 * Mod's classification of the confirmation, which the Host's `409` does not carry.
 */
function readAttachmentResponse(declaredDataRoot) {
  if (typeof declaredDataRoot !== "string" || declaredDataRoot.length === 0) return null;
  const bootstrapRoot = path.join(declaredDataRoot, "stardew-private-bootstrap");
  let bootstraps = [];
  try {
    bootstraps = readdirSync(bootstrapRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  const readings = [];
  for (const name of bootstraps) {
    const file = path.join(bootstrapRoot, name, "session", "stardew-attachment-response.json");
    try {
      readings.push({ file: path.basename(name), ...JSON.parse(readFileSync(file, "utf8")) });
    } catch {
      /* no response published for this bootstrap yet */
    }
  }
  // The newest write is the one this run's confirmation caused; an older one belongs to a prior run.
  return readings.sort((left, right) => Number(right.updatedAtUnixMs ?? 0) - Number(left.updatedAtUnixMs ?? 0))[0] ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The window the game's own offer leaves a page, quoted from the wire rather than from a code reading.
 *
 * A cabin read answers with one `expiresAtMs` per choice. What a page can do with it is the difference
 * between that deadline and the moment the answer arrived: the page still has to render the list, the
 * player has to see and click it, and the confirmation has to travel back inside whatever is left. The
 * last two reads are quoted one after the other because "the same deadline every time" and "a fresh short
 * one each time" are different facts for whoever owns the game, and only two readings side by side say
 * which one this is. `null` when no read carried a live offer.
 */
function describeCabinOffers(offers) {
  const readable = (Array.isArray(offers) ? offers : []).filter(
    (entry) =>
      Array.isArray(entry?.choices) &&
      entry.choices.length > 0 &&
      entry.choices.every((choice) => Number.isFinite(choice?.expiresAtMs)),
  );
  if (readable.length === 0) return null;
  const windows = readable.map((entry) => ({
    readAtMs: entry.readAtMs,
    label: entry.choices[0].label,
    expiresAtMs: entry.choices[0].expiresAtMs,
    windowMs: entry.choices[0].expiresAtMs - entry.readAtMs,
  }));
  const quoted = windows
    .slice(-2)
    .map(
      (window) =>
        `${String(window.windowMs)}ms left (expiresAtMs=${String(window.expiresAtMs)}, read at ${new Date(window.readAtMs).toISOString()}, label=${JSON.stringify(window.label)})`,
    );
  const all = windows.map((window) => window.windowMs);
  return `${String(windows.length)} cabin read(s) in this run carried a live offer; the last ${String(quoted.length)}: ${quoted.join(" then ")}; every window was ${String(Math.min(...all))}..${String(Math.max(...all))}ms`;
}

/** One answer on the confirm route, as a reader needs it: the status and the game's own refusal code. */
function describeConfirmAnswer(answer) {
  if (answer === null || answer === undefined) return "nothing";
  const code = typeof answer.code === "string" && answer.code.length > 0 ? ` ${answer.code}` : "";
  return `HTTP ${String(answer.status)}${code}`;
}

/** The tuple a launch wait is waiting to see move: a change in any of these is a step that happened. */
const stateKey = (state) =>
  state?.ok !== true
    ? `unreadable:${String(state?.status)}`
    : `${String(state.instanceStatus)}/${String(state.attachmentStatus)}/${String(state.instanceGeneration)}/${String(state.latestOutcome)}`;

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
  const facts = { steps: [], chain: [], detail: null, reply: null };
  const record = stepRecorder(facts, say);

  /*
   * The chain, rung by rung: what the launch actually got through, when, and the fact that proved it.
   *
   * The driver's own cells (`record` above) say what it looked at; this says how far the PRODUCT got,
   * which is the question a reader has after a run that did not reach the end. A rung is recorded once,
   * at the moment the fact it names was first true, so the elapsed time is the chain's own cost and not
   * the driver's polling cadence. `atMs` is that moment when the caller knows it and it is not now: the
   * confirmation's rung is written after the attachment wait that FOLLOWS it, and stamping it then printed
   * `cabin confirm @204s` for a press taken at 16 s - an elapsed that belonged to the wait, not to the step.
   */
  const chainReached = (rung, proof, atMs = null) => {
    if (!CHAIN_STEP_NAMES.includes(rung)) throw new Error(`chain_step_unknown:${rung}`);
    if (facts.chain.some((entry) => entry.name === rung)) return;
    const reachedAt = Number.isFinite(atMs) ? atMs : Date.now();
    facts.chain.push({ name: rung, atMs: reachedAt - started, proof });
    say(`CHAIN RUNG: ${rung} @${Math.round((reachedAt - started) / 1000)}s - ${proof}`);
  };

  /** The chain as the next reader wants it, printed on every way out. */
  const sayChain = () => {
    say("=== ITEM: the chain, rung by rung ===");
    for (const line of describeChain(facts.chain)) say(line);
    say(`steps=${chainStepsLine(facts.chain)}`);
  };

  /**
   * The two facts about the cabin step a reader needs on every way out, quoted from the run's own wire:
   * whether a confirmation was SENT, what the game ANSWERED it, and how much time the offer gave the page.
   *
   * The rung list says how far the chain got; this says what the game and the page said to each other at
   * the rung it stopped at. A press answered by the page and a press answered by the game read the same on
   * screen, and only these two counts tell them apart.
   */
  const sayCabins = () => {
    const confirmAnswers = answers.filter((entry) => entry.route === "game/stardew/cabins/confirm");
    say("=== ITEM: the cabin offer and the confirmation, as the wire carried them ===");
    say(
      `cabin read requests: ${String(cabinReads.requested)} (${String(cabinReads.afterDriverPress)} of them after this driver pressed the refresh control); confirm requests: ${String(cabinConfirms.requested)}`,
    );
    say(
      `confirm answers: ${confirmAnswers.length === 0 ? "none" : JSON.stringify(confirmAnswers.map((answer) => ({ status: answer.status, code: answer.code ?? null, atMs: answer.atMs })))}`,
    );
    say(`the offer's window: ${describeCabinOffers(cabinOffers) ?? "no cabin read in this run carried a live offer"}`);
    for (const entry of cabinOffers.slice(-2))
      say(`cabins response at ${new Date(entry.readAtMs).toISOString()}: ${JSON.stringify(entry.choices ?? entry.unreadable)}`);
  };

  const conclude = async (browser, { verdict, code, exit }) => {
    sayCabins();
    say("=== ITEM: the verdict ===");
    if (verdict === VERDICTS.notMeasured) {
      say(notMeasuredLine(code, facts.detail ?? ""));
      sayChain();
      say(
        `${GAME_LAUNCH_PREFIX} w: not_measured ${code} after ${Math.round((Date.now() - started) / 1000)}s; steps=${chainStepsLine(facts.chain)} records=${facts.steps.join(">")}`,
      );
    } else if (verdict === VERDICTS.blockedByProduct) {
      say(blockedByProductLine(code, facts.detail ?? ""));
      sayChain();
      say(
        `${GAME_LAUNCH_PREFIX} w: blocked_by_product ${code}; steps=${chainStepsLine(facts.chain)} records=${facts.steps.join(">")}`,
      );
    } else if (verdict === VERDICTS.failed) {
      say(`FAILED: ${code} (${facts.detail ?? ""})`);
      sayChain();
      say(`${GAME_LAUNCH_PREFIX} w: failed ${code}; steps=${chainStepsLine(facts.chain)} records=${facts.steps.join(">")}`);
    } else {
      sayChain();
      say(
        `${GAME_LAUNCH_PREFIX} w: measured launch=ready line=${String(facts.line ?? "none")} reply_chars=${[...(facts.reply ?? "")].length}; steps=${chainStepsLine(facts.chain)} records=${facts.steps.join(">")}`,
      );
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

  /** A failure the product owes an answer for; named here so the cabin step can stop with one. */
  const failed = async (browser, code, detail) => {
    facts.detail = detail;
    say(`FAILED: ${code} (${detail})`);
    return await conclude(browser, { verdict: VERDICTS.failed, code, exit: 1 });
  };

  /** The refusal body a lifecycle POST answered, captured where the product itself reads it. */
  const problems = new Map();

  /**
   * Every answer the chain's own routes gave, refusals included, in the order they arrived.
   *
   * `problems` above carries the four refusals the classification reads; this carries the ANSWERS too,
   * because "the launch request was admitted" is a fact about a 2xx that nothing else in the run
   * records - the state route only says the instance is `launching`, which an activation also says.
   */
  const answers = [];

  /**
   * How many times the PANEL asked the Host for cabins, and who was asking when it did.
   *
   * The admitted launch's own bounded read is a request the panel makes by itself, so counting the
   * requests is the measurement the fix can be held to - a driver that only looked at the choice list
   * could not tell the panel's read from its own press. `pressedByDriver` is the second half: a request
   * that arrived after this driver pressed the refresh control is not the same fact.
   */
  const cabinReads = { requested: 0, afterDriverPress: 0 };
  let driverPressedAtMs = null;

  /**
   * The offers the Host handed the page, read off the wire rather than off the panel.
   *
   * A choice carries `expiresAtMs`, and how far ahead that deadline sits decides whether any UI can answer
   * inside it at all: the page has to render the list, the player has to see and click it, and the
   * confirmation has to travel back. The panel's DOM does not show the deadline, so the response body is
   * the only place it can be read. Each entry is `{ readAtMs, choices: [{ label, expiresAtMs }] }`, in
   * arrival order; `readAtMs` is when this driver saw the answer, which is the page's own clock. The window
   * a read leaves is `expiresAtMs - readAtMs`.
   */
  const cabinOffers = [];

  /**
   * How many confirmations the page actually SENT, as requests.
   *
   * A press the page answers itself - a client-side deadline check re-reading the handoff instead of
   * confirming - produces a cabin read and no confirmation request, so these two counts are what tells the
   * page's own refusal apart from the game's.
   */
  const cabinConfirms = { requested: 0 };

  // ---- the machine, before a browser is touched ----
  const gameDir = readRunGameDir(launch.path) ?? "D:\\Steam\\steamapps\\common\\Stardew Valley";
  const machine = machinePrerequisites(gameDir, launch.state);
  record("machine", machine);
  if (!machine.gameInstalled) {
    say(notMeasuredLine("game_install_absent", `no Stardew Valley installation at ${gameDir}`));
    say(`${GAME_LAUNCH_PREFIX} w: not_measured game_install_absent; steps=none records=${facts.steps.join(">")}`);
    say("DONE-W");
    flush();
    process.exit(0);
  }
  /*
   * The other two machine prerequisites, named before a browser is touched and before a launch is asked
   * for: the launch chain runs SMAPI out of the installation's own copy, and its third step arms a role
   * through the generation's resident Guardian image. A machine missing either would spend minutes
   * waiting for a game that cannot start; the run says which one is absent in a second instead.
   */
  if (!machine.smapiInstalled) {
    say(notMeasuredLine("smapi_install_absent", `no StardewModdingAPI.exe beside the game at ${gameDir}`));
    say(`${GAME_LAUNCH_PREFIX} w: not_measured smapi_install_absent; steps=none records=${facts.steps.join(">")}`);
    say("DONE-W");
    flush();
    process.exit(0);
  }
  if (machine.launchChain.generationServesTheGuardian === "hello_only") {
    say(
      notMeasuredLine(
        "guardian_image_absent",
        `the generation this run published serves the guardian session hello-only: it ships no native/windows-bootstrap-guardian/win-x64 image, so no arm/launch/contain frame can be served (launch state roleBroker.mode=hello_only, image=${String(machine.launchChain.guardianImage)})`,
      ),
    );
    say(`${GAME_LAUNCH_PREFIX} w: not_measured guardian_image_absent; steps=none records=${facts.steps.join(">")}`);
    say("DONE-W");
    flush();
    process.exit(0);
  }

  // The pipe namespace, read with the Host's own probe: the driver's word for
  // `guardian_pipe_unreachable` is the preflight's word, not a second spelling.
  const preflight = await import(pathToFileURL(path.join(REPO_ROOT, "tools", "lib", "live-run-preflight.mjs")).href);
  // The OS's process table, for the one rung no log on this machine carries: whether the generation's
  // Guardian was started for THIS run and what it started inside its Job (`lib/process-table.mjs`).
  const { processTable } = await import(
    pathToFileURL(path.join(REPO_ROOT, "tools", "live-run", "frontend", "lib", "process-table.mjs")).href
  );
  const probe = preflight.probeGuardianPipe();
  const driverPid = runLaunchDriverPid(launch.path);
  const guardian = {
    examined: probe.examined,
    endpoints: [...probe.endpoints],
    unreadable: probe.unreadable,
    runLaunchDriverPid: driverPid.pid,
    runLaunchDriverAlive: driverPid.alive,
    // The basis, stated: exactly one endpoint is bound and this run's own launch driver — the process
    // that created it — is alive, so the endpoint is this run's own gate peer. A second endpoint makes
    // this false, and the driver then refuses to excuse a launch refusal on this ground at all.
    onlyRunOwnGatePeer: probe.unreadable === null && probe.endpoints.length === 1 && driverPid.alive === true,
    // What that peer said it can do. `hello_only` is the generation publishing no Guardian; `null` is a
    // launch state written before the broker existed, and `guardianCanArm` reads it as unable to arm
    // rather than assuming the better case.
    runGatePeerMode: launch.state?.roleBroker?.mode ?? null,
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
    const match = /\/(lifecycle\/activate|game\/launch|game\/stop|game\/stardew\/cabins|game\/stardew\/cabins\/confirm|game\/installation\/discovery\/confirm)$/u.exec(response.url());
    if (match === null) return;
    const route = match[1];
    const status = response.status();
    if (status < 400) {
      /*
       * A success is an answer too: the chain's first rung is the launch route admitting the request,
       * and nothing else in this run records that fact. A cabin read's body is where the offer's own
       * deadline lives, so the same answer is also read as the window it left the page.
       */
      const seenAtMs = Date.now();
      answers.push({ route, status, atMs: seenAtMs });
      if (route !== "game/stardew/cabins") return;
      response
        .text()
        .then((text) => {
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {
            cabinOffers.push({ readAtMs: seenAtMs, choices: null, unreadable: "unparseable_cabin_body" });
            return;
          }
          const choices = Array.isArray(body?.choices)
            ? body.choices.map((choice) => ({
                label: choice?.displayLabel ?? null,
                expiresAtMs: Number.isFinite(choice?.expiresAtMs) ? choice.expiresAtMs : null,
              }))
            : null;
          cabinOffers.push({ readAtMs: seenAtMs, choices, unreadable: null });
        })
        .catch((error) => cabinOffers.push({ readAtMs: seenAtMs, choices: null, unreadable: String(error) }));
      return;
    }
    response
      .text()
      .then((text) => {
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = { code: "unparseable_problem_body" };
        }
        const reading = { status, code: body?.code ?? null, cause: body?.cause ?? null, atMs: Date.now() };
        problems.set(route, reading);
        answers.push({ route, ...reading });
      })
      .catch(() => {
        const reading = { status, code: "unreadable_problem_body", cause: null, atMs: Date.now() };
        problems.set(route, reading);
        answers.push({ route, ...reading });
      });
  });
  page.on("request", (request) => {
    if (/\/game\/stardew\/cabins\/confirm$/u.test(request.url())) cabinConfirms.requested += 1;
    if (!/\/game\/stardew\/cabins$/u.test(request.url())) return;
    cabinReads.requested += 1;
    if (driverPressedAtMs !== null) cabinReads.afterDriverPress += 1;
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

  /**
   * The guide's third step, driven through the panel's own controls.
   *
   * `game_browser_api_v1` has exactly one path from a launched Player Host to an attached companion: the
   * cabin read, then the confirmed choice. The confirmation is what materialises the AI-client profile,
   * launches that role and takes its bridge, and it is the only caller of
   * `materializeAiClientProfileAfterManifestAdmission`
   * (`host/src/stardew-production-lifecycle-coordinator.internal.ts:2082-2152`; the staging it performs is
   * `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.internal.ts:2397-2457`).
   *
   * The panel read the handoff once, when the surface mounted, and re-read only the composed root after
   * an admitted launch until 2026-11-15 (`dialogue-web/src/components/GameSurface.tsx`, `keepAskingForCabin`);
   * the player's own refresh press used to be the only thing that asked the Host again, and in the
   * `launching` phase it was the only control on the panel that could change anything. Both are now
   * measured rather than assumed: this step waits for the panel's own read, presses the refresh control
   * only when the panel's budget is spent (or when it is asking nothing at all), and records how many
   * requests the Host received for that handoff.
   */
  const driveCabinHandoff = async () => {
    const began = Date.now();
    const reads = [];
    const fingerprint = (handoff) =>
      JSON.stringify({
        choices: handoff.choices.map((choice) => choice.label),
        secondary: handoff.secondary.map((control) => control.name),
        sentences: handoff.sentences,
      });
    let handoff = await page.evaluate(readCabinHandoff);
    /*
     * The panel's read first, and this driver's press only as the second chance.
     *
     * An admitted launch now starts the surface's own bounded read of this same handoff
     * (`CABIN_REREAD_MAX_ATTEMPTS` reads `CABIN_REREAD_INTERVAL_MS` apart, `dialogue-web/src/components/
     * GameSurface.tsx:283-350`) and says which shape it is in through `data-testid="cabin-launch-reading"`
     * / `cabin-launch-found` / `cabin-launch-wait-expired`. Pressing the refresh control while that line is
     * on screen would measure the driver's own click: the panel is already asking. So this wait watches the
     * panel's own line and presses only when the panel says its budget is spent, or when nothing is being
     * asked at all - the shape a build without the fix leaves, which is a finding about the fix and is
     * reported as one below rather than papered over with a press.
     */
    while (handoff.present === true && handoff.choices.length === 0 && Date.now() - began < BUDGET.cabinReadMs) {
      if (handoff.launchLine?.kind === "reading") {
        // The panel is asking by itself. This driver waits, and records that it waited.
        await sleep(500);
        handoff = await page.evaluate(readCabinHandoff);
        continue;
      }
      const refresh = handoff.secondary.find((control) => control.visible === true && control.disabled !== true) ?? null;
      if (refresh === null)
        return {
          outcome: "no_control",
          reads,
          handoff,
          cabinReads: { ...cabinReads },
          elapsedMs: Date.now() - began,
        };
      const before = fingerprint(handoff);
      driverPressedAtMs = Date.now();
      await page.locator('[data-testid="game-surface"] section.stardew-cabin-handoff button.game-secondary-action').first().click();
      reads.push({ pressed: refresh.name, at: Date.now() - began, launchLine: handoff.launchLine });
      /*
       * The press only asks; the answer is a later render. A state without a choice and without a control is
       * the panel's `loading`, so the read has not answered yet; a state with a control is an answer, and it
       * counts as the answer to THIS press only once it differs from what was on screen before it.
       */
      const pressedAt = Date.now();
      let answeredAt = null;
      while (Date.now() - pressedAt < BUDGET.controlMs) {
        await sleep(250);
        const next = await page.evaluate(readCabinHandoff);
        handoff = next;
        const answered = next.present !== true || next.choices.length > 0 || next.secondary.length > 0;
        if (!answered) {
          answeredAt = null;
          continue;
        }
        if (next.present !== true || next.choices.length > 0 || fingerprint(next) !== before) break;
        if (answeredAt === null) answeredAt = Date.now();
        if (Date.now() - answeredAt >= 2000) break;
      }
      if (handoff.choices.length > 0 || handoff.present !== true) break;
      await sleep(1000);
    }
    if (handoff.present !== true) return { outcome: "no_handoff", reads, handoff, elapsedMs: Date.now() - began };
    if (handoff.choices.length === 0)
      return {
        outcome: "no_choices",
        reads,
        handoff,
        cabinReads: { ...cabinReads },
        elapsedMs: Date.now() - began,
        problems: [...problems.entries()],
      };
    /*
     * The cabin is in hand. WHO asked for it is the measurement this run exists for: a request that
     * arrived while no press of this driver's was outstanding is the panel's own read.
     */
    const autoReads = cabinReads.requested - cabinReads.afterDriverPress;
    chainReached(
      autoReads > 0 && cabinReads.afterDriverPress === 0 ? CHAIN_STEPS.cabinReadAuto : CHAIN_STEPS.cabinReadPressed,
      `the Host answered the cabin read with ${JSON.stringify(handoff.choices.map((choice) => choice.label).join(", "))} after ${String(cabinReads.requested)} request(s) for this handoff (${String(autoReads)} of them not caused by this driver's press); the panel's own launch line read ${JSON.stringify(handoff.launchLine?.text ?? null)}`,
    );

    /*
     * One press per attempt, and a second attempt only for the one failure a press can have silently: a
     * choice handle expires with the advertisement beat it was read from
     * (`stardew-private-bootstrap-composer.core.internal.ts:2282`), and the panel then re-reads instead of
     * confirming (`GameSurface.tsx:263-268`). "Admitted" is read from the panel's own shapes - the list in
     * `confirming` (every confirm disabled), or no list at all.
     */
    /*
     * One press per attempt, and the next attempt presses the FRESH offer the previous one produced.
     *
     * A confirmation can come back as a new choice rather than as a confirmation: the game refuses the
     * handle by name and the panel re-reads, leaving a new, freshly-expiring choice on screen. A press that
     * stops there measures nothing about the window - it measures a driver that gave up - so the next
     * attempt presses what a player would press: the choice that is on screen now. "The game answered this
     * press" is read from the wire (an answer on `game/stardew/cabins/confirm`), never guessed from the DOM,
     * and it is the fact that tells a fresh offer apart from the same screen re-rendered.
     *
     * "Admitted" is read from the panel's own shapes - the list in `confirming` (every confirm disabled),
     * or no list at all.
     */
    const confirmAnswersSince = (atMs) =>
      answers.filter((entry) => entry.route === "game/stardew/cabins/confirm" && entry.atMs >= atMs);
    const presses = [];
    let inFlight = false;
    let confirmPressedAtMs = null;
    const readsBeforePresses = cabinReads.requested;
    for (let attempt = 1; attempt <= 3 && !inFlight; attempt += 1) {
      const press = {
        attempt,
        choices: handoff.choices.map((choice) => choice.label),
        confirm: handoff.choices[0]?.confirm?.name ?? null,
        offerReadAtMs: cabinOffers.at(-1)?.readAtMs ?? null,
      };
      presses.push(press);
      confirmPressedAtMs = Date.now();
      press.pressedAtMs = confirmPressedAtMs;
      await page.locator('[data-testid="cabin-choice-list"] li.game-choice button').first().click();
      const pressedAt = Date.now();
      let goneForMs = 0;
      while (Date.now() - pressedAt < 15_000) {
        await sleep(250);
        const next = await page.evaluate(readCabinHandoff);
        handoff = next;
        const confirming = next.choices.length > 0 && next.choices.every((choice) => choice.confirm === null || choice.confirm.disabled === true);
        if (confirming) {
          inFlight = true;
          break;
        }
        const offeredAgain = next.choices.some((choice) => choice.confirm !== null && choice.confirm.disabled !== true);
        if (offeredAgain) {
          const answered = confirmAnswersSince(pressedAt);
          if (answered.length > 0) {
            // The game answered this press and a new choice is on screen: press that one, now.
            press.answer = answered.at(-1);
            break;
          }
          goneForMs = 0;
          continue;
        }
        if (next.choices.length === 0) goneForMs += 250;
        else goneForMs = 0;
        if (goneForMs >= 2000) {
          inFlight = true;
          break;
        }
      }
    }
    for (const press of presses)
      if (press.answer === undefined) press.answer = confirmAnswersSince(press.pressedAtMs).at(-1) ?? null;
    /* The confirmation's own answer, in the order the Host gave them: the fact the chain's rung prints. */
    const confirmAnswers = answers.filter((entry) => entry.route === "game/stardew/cabins/confirm");
    const offerWindows = describeCabinOffers(cabinOffers);
    if (!inFlight) {
      /*
       * The confirm step was TAKEN and the game answered it. The rung is recorded here rather than left as
       * "not reached", because the next reader must see the confirm's own answer: a rung that stays empty
       * after three confirmations went out would read as if the step had never been attempted.
       */
      const last = confirmAnswers.at(-1) ?? null;
      chainReached(
        CHAIN_STEPS.cabinConfirm,
        confirmAnswers.length === 0
          ? `the panel answered all ${String(presses.length)} confirm press(es) itself: ${String(cabinConfirms.requested)} confirmation request(s) reached the Host, and ${String(cabinReads.requested - readsBeforePresses)} cabin read(s) were sent instead`
          : `the confirm was SENT ${String(cabinConfirms.requested)} time(s) and the Host ANSWERED ${describeConfirmAnswer(last)}${offerWindows === null ? "" : `; ${offerWindows}`}`,
      );
      return {
        outcome: "not_admitted",
        reads,
        presses,
        handoff,
        cabinReads: { ...cabinReads },
        confirmPressedAtMs,
        /*
         * What the press actually caused. A confirmation that reached the Host is a request on
         * `game/stardew/cabins/confirm`; a press that produced a cabin READ instead never got that far -
         * the panel's own client-side branch (`choice.expiresAtMs <= Date.now()` -> `readCabins("stale_choice")`,
         * `dialogue-web/src/components/GameSurface.tsx:378-382`) re-reads the handoff and draws the same
         * control again, so the player's click appears to do nothing. Counting the two requests is the only
         * way to tell those apart from outside the page.
         */
        mechanism: `${String(presses.length)} confirm press(es) caused ${String(cabinReads.requested - readsBeforePresses)} further cabin read(s) and ${String(cabinConfirms.requested)} confirm request(s): a press that produces a re-read instead of a confirmation was answered by the page, not by the Host`,
        confirmAnswers,
        confirms: { ...cabinConfirms },
        offers: cabinOffers,
        elapsedMs: Date.now() - began,
        problems: [...problems.entries()],
      };
    }

    /* The confirmation is in flight: the Mod provisions the farmhand and the Host admits its manifest. */
    say(`the cabin choice was confirmed; waiting up to ${String(BUDGET.cabinConfirmMs)}ms for the attachment`);
    /*
     * The Mod's own answer to THIS press, read once here rather than after the wait: it is what the press
     * caused, it arrives within milliseconds of it, and the rung below carries that latency. The same
     * reading is returned with the step, so the chain rung and the classification quote one file.
     */
    const attachmentResponse = readAttachmentResponse(launch.state?.declaredDataRoot ?? null);
    const acceptStamp = responseStampForPress(attachmentResponse, confirmPressedAtMs);
    const attachBegan = Date.now();
    let attached = await page.evaluate(readGameState);
    let attachProgressAt = attachBegan;
    while (Date.now() - attachBegan < BUDGET.cabinConfirmMs) {
      if (attached.ok === true && attached.attachmentStatus === "attached") break;
      if (Date.now() - attachProgressAt >= BUDGET.progressMs) {
        attachProgressAt = Date.now();
        say(
          describeLaunchProgress({
            elapsedMs: Date.now() - attachBegan,
            state: attached,
            problems: [...problems.entries()],
            game: lastSmapiLine(),
          }),
        );
      }
      await sleep(1000);
      attached = await page.evaluate(readGameState);
    }
    const confirmAnswer = answers.filter((entry) => entry.route === "game/stardew/cabins/confirm").at(-1) ?? null;
    /*
     * The rung is stamped at the PRESS, not here: the wait below belongs to the attachment the confirmation
     * was supposed to start, and printing it as this rung's elapsed reads as if the confirmation itself took
     * minutes when it was answered in one round trip.
     */
    chainReached(
      CHAIN_STEPS.cabinConfirm,
      `the choice ${JSON.stringify(presses[0]?.choices?.join(", ") ?? null)} was pressed and the confirm route answered ${describeConfirmAnswer(confirmAnswer)}; this driver then waited up to ${String(BUDGET.cabinConfirmMs)}ms for the attachment`,
      confirmPressedAtMs,
    );
    /*
     * The next rung, and it is a different fact from the one above: the game TOOK the choice. The proof is
     * the Mod's own stamp for this press, which arrives in milliseconds and carries the latency here; a
     * confirmation the page answered itself, or one written by an earlier launch, has no such stamp and the
     * rung stays "not reached".
     */
    if (acceptStamp !== null)
      chainReached(
        CHAIN_STEPS.cabinConfirmAccepted,
        `the game took the choice and the Mod answered this press ${String(acceptStamp - Number(confirmPressedAtMs))}ms later: state=${String(attachmentResponse.state)}/reason=${String(attachmentResponse.reasonCode ?? "no_reason_code")}, stamped ${new Date(acceptStamp).toISOString()} (${String(attachmentResponse.file)}/session/stardew-attachment-response.json)`,
        acceptStamp,
      );
    const attachLanded = attached.ok === true && attached.attachmentStatus === "attached";
    if (attachLanded) chainReached(CHAIN_STEPS.attach, `the Host published attachment=attached (${describeGameState(attached)}) ${String(Date.now() - attachBegan)}ms after the confirmation`);
    return {
      outcome: attachLanded ? "attached" : "not_attached",
      reads,
      presses,
      handoff: await page.evaluate(readCabinHandoff),
      state: attached,
      cabinReads: { ...cabinReads },
      confirmPressedAtMs,
      confirmAnswer,
      confirms: { ...cabinConfirms },
      offers: cabinOffers,
      attachmentResponse,
      elapsedMs: Date.now() - began,
      confirmMs: Date.now() - attachBegan,
      problems: [...problems.entries()],
      gameLog: lastSmapiLine(),
    };
  };

  /**
   * Whether this run's Guardian is up and what it started inside its Job, read from the OS.
   *
   * The broker's own `role-broker:` lines go to its stderr, which the launch phase does NOT put in
   * `launch.log` (measured 2026-11-15: 0 such lines in a run whose Guardian and game were both up), so the
   * proof is taken from the process table instead: the generation's Guardian image, live, whose parent is
   * THIS run's own launch driver, and the game as the Guardian's own child. That is the Job relationship
   * itself, which no log line could carry more directly, and every pid in it is the OS's answer.
   */
  const guardianArmedReading = () => {
    const driver = runLaunchDriverPid(launch.path);
    if (driver.pid === null || driver.alive !== true) return null;
    const table = processTable();
    if (table === null) return null;
    const guardian =
      table.rows.find(
        (row) => row.name === "GameBuddy.WindowsBootstrapGuardian.exe" && row.parentPid === driver.pid,
      ) ?? null;
    if (guardian === null) return null;
    const role = table.rows.find((row) => row.parentPid === guardian.pid && /^Stardew/u.test(row.name)) ?? null;
    return { driver, guardian, role, examined: table.examined };
  };

  /**
   * One bounded sample of the rungs only the launched game and this run's own launcher can witness.
   *
   * The Host's state route answers `launching/none` for a whole launch, so the four steps between the
   * launch request and the cabin handoff have no representation there at all. Two witnesses do: the
   * launcher's own log, where the broker records the Guardian it started for this session, and the game's
   * own log, where SMAPI echoes the save it loaded and the Mod records the cabin it built. Both are read
   * every progress tick (cheap: two bounded file tails), and the process table is asked the one question
   * only the OS can answer - whether a game is running at all.
   */
  const sampleLaunchFacts = (reading) => {
    /* 1. the launch request was admitted - the product's own route said so, or the instance moved. */
    if (!facts.chain.some((entry) => entry.name === CHAIN_STEPS.launchAdmitted)) {
      const admitted = answers.find((entry) => entry.route === "game/launch" && entry.status < 400) ?? null;
      if (admitted !== null)
        chainReached(
          CHAIN_STEPS.launchAdmitted,
          `the launch route answered HTTP ${String(admitted.status)}; the surface then read ${describeGameState(reading)}`,
        );
      else if (reading?.ok === true && reading.instanceStatus === "launching")
        chainReached(
          CHAIN_STEPS.launchAdmitted,
          `the surface moved to ${describeGameState(reading)} after the launch control was pressed (the route's own answer had not arrived when this was read)`,
        );
    }
    /* 2. the Guardian was armed and started for this session: the OS's own account of the Job. */
    if (!facts.chain.some((entry) => entry.name === CHAIN_STEPS.guardianArmed)) {
      const armed = guardianArmedReading();
      if (armed !== null)
        chainReached(
          CHAIN_STEPS.guardianArmed,
          `the OS lists the generation's Guardian (pid ${String(armed.guardian.pid)}) as a child of this run's own launch driver (pid ${String(armed.driver.pid)})${
            armed.role === null
              ? ""
              : `, and the game it launched as the Guardian's own child (${armed.role.name} pid ${String(armed.role.pid)})`
          }: the role was armed and launched inside its Job (${String(armed.examined)} processes examined; the image was admitted from the launch state as ${JSON.stringify(launch.state?.roleBroker?.mode ?? null)})`,
        );
    }
    /* 3. a game process exists: the OS's answer, not the Host's. */
    if (!facts.chain.some((entry) => entry.name === CHAIN_STEPS.processStarted)) {
      const running = gameProcesses();
      if (running !== null && running.length > 0)
        chainReached(
          CHAIN_STEPS.processStarted,
          `the OS lists a running game: ${running.map((row) => `${row.name} pid ${String(row.pid)}`).join(", ")} (read with Get-Process -Name StardewModdingAPI,Stardew*)`,
        );
    }
    /* 4. and 5. the game's own log: the save it loaded, and the Cabin the Mod gave her. */
    const gameLog = gameLogChainFacts(launchBegan);
    for (const rung of [CHAIN_STEPS.saveLoaded, CHAIN_STEPS.cabinReady]) {
      const fact = gameLog.facts?.[rung] ?? null;
      if (fact === null || facts.chain.some((entry) => entry.name === rung)) continue;
      chainReached(rung, `the launched game's own log says so: ${JSON.stringify(fact.line)}`);
    }
    return gameLog;
  };

  // ---- the Game surface ----
  await page.setViewportSize({ width: 1440, height: 900 });
  const switchKind = await activateSurface(page, "游戏");
  record("surface", { switchKind, mounted: await page.evaluate(() => document.querySelector('[data-testid="game-surface"]') !== null) });
  await shot(page, "90-game-surface-before.png");

  let state = await page.evaluate(readGameState);
  record("state before", state);
  if (state.ok !== true) return await notMeasured(browser, "game_state_unreadable", `the product's own state route answered HTTP ${String(state.status)}`);

  // ---- 1. the installation registration (`capture/installation-registration.cjs`) ----
  const registration = await registerInstallation({
    page,
    say,
    record,
    problems,
    waitForState,
    budgets: { discoveryMs: BUDGET.discoveryMs, registrationMs: BUDGET.registrationMs },
    state,
  });
  if (registration.kind === "not_measured") return await notMeasured(browser, registration.reason, registration.detail);
  if (registration.kind === "refused")
    return await refuse(browser, LAUNCH_STEPS.installation, { code: registration.code, cause: registration.cause, guardian });

  // ---- 2. the lifecycle activation ----
  state = await page.evaluate(readGameState);
  record("state after registration", state);
  /*
   * The shape, from the run's one state model (`game-launch-verdict.mjs` `lifecycleShapeOf`): activation is
   * offered for `none` with no generation and for nothing else. Reading "activated" as
   * `instanceStatus === "none" && generation >= 1` was the same defect the state drivers had - it read an
   * instance that EXISTS (`launching`, `running`, `stopped`, `crashed`) as a lifecycle nobody had activated,
   * so the driver hunted a control the product forbids in that state for 30 s and then named the whole
   * lifecycle `lifecycle_activation_refused`. A stage re-run in the same Host meets exactly that shape.
   */
  const lifecycleShape = lifecycleShapeOf(state);
  if (lifecycleShape === LIFECYCLE_SHAPES.unactivated) {
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
        lifecycleShapeOf(reading) === LIFECYCLE_SHAPES.activated,
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
    say(`the lifecycle needs no activation: shape=${lifecycleShape} at ${describeGameState(state)} (generation ${String(state.instanceGeneration)})`);
  }

  /*
   * THE RUN'S OWN WORLD, CLAIMED BEFORE THE GAME IS ASKED TO ENTER ONE.
   *
   * The Player Host asks the Mod for one world name, and Stardew keeps that world in the machine's single
   * save folder, so a run that enters whatever is already there enters the world its predecessors filled -
   * and each run binds one more Cabin in it for good. `D:/gb-modcheck/frontend--r25` is that world at the end:
   * seven Cabins, every one bound to an earlier run's companion, no free cabin pad left, and the panel
   * answering 409 `stardew_player_host_cabin_missing` sixty times. A full farm is a truthful product answer;
   * it is not a launch this kit can measure. So the saves carrying the name the PRODUCT staged are moved
   * into this run root before the launch, and the world the game creates here is this run's own. Nothing is
   * deleted, and a save of any other name is not touched (`capture/fixture-world.cjs`).
   */
  const fixtureWorld = prepareOwnWorld({
    declaredDataRoot: launch.state?.declaredDataRoot,
    runRoot: launch.state?.runRoot,
    policy: readRunWorldPolicy(launch.path),
  });
  record("fixture world", fixtureWorld);
  say(describeOwnWorld(fixtureWorld));
  if (fixtureWorld.kind === "refused")
    return await notMeasured(
      browser,
      "fixture_world_not_prepared",
      `this run could not claim a world of its own, so a launch it measured would be a launch into whatever world the previous run left behind: ${describeOwnWorld(fixtureWorld)}`,
    );

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
  say(`launch budget: ${String(BUDGET.launchMs)}ms, plateau named after ${String(BUDGET.plateauMs)}ms, progress every ${String(BUDGET.progressMs)}ms`);
  await page.locator('[data-testid="game-launch"]').first().click();
  say(`launch requested through the product's own control (${JSON.stringify(controls.launch.name)})`);
  /*
   * The launch is waited for by NAME, and it gives up in three ways rather than one: the readiness it asked
   * for (`readinessOf`), a state read that stopped answering for five consecutive seconds - the shape a
   * Host that died under the launch request leaves - or a state that has not changed for the plateau window.
   * The third is the one that turns a silent wait into a finding: the launch chain and the cabin step after
   * it are different steps, and a tuple that stops moving while the game is visibly up is the state waiting
   * for a step nobody sent, not a launch that is slow. Waiting the whole budget for it is what turned a
   * named step into a 300 s timeout on 2026-11-15.
   */
  let launched = await page.evaluate(readGameState);
  let unreachable = launched.ok === true ? 0 : 1;
  let plateaued = false;
  let unchangedForMs = 0;
  let unchangedSince = Date.now();
  let unchangedKey = stateKey(launched);
  let lastProgressAt = launchBegan;
  let launchGameLog = sampleLaunchFacts(launched);
  while (Date.now() - launchBegan < BUDGET.launchMs) {
    if (readinessOf(launched) !== "pending" || unreachable >= 5) break;
    /*
     * The launch request's own chain ends there: once the game has built her cabin, the only step left is
     * the cabin handoff, which the panel is already asking for and this driver drives next. Waiting for
     * the instance word instead would wait out the whole budget on a state that cannot move for a
     * GameBuddy-launched host (`PRODUCT_GAPS` in `game-launch-verdict.mjs`).
     */
    if (facts.chain.some((entry) => entry.name === CHAIN_STEPS.cabinReady)) break;
    const key = stateKey(launched);
    if (key !== unchangedKey) {
      unchangedKey = key;
      unchangedSince = Date.now();
    }
    unchangedForMs = Date.now() - unchangedSince;
    if (unchangedForMs >= BUDGET.plateauMs) {
      plateaued = true;
      break;
    }
    if (Date.now() - lastProgressAt >= BUDGET.progressMs) {
      lastProgressAt = Date.now();
      launchGameLog = sampleLaunchFacts(launched);
      say(
        describeLaunchProgress({
          elapsedMs: Date.now() - launchBegan,
          state: launched,
          problems: [...problems.entries()],
          game: lastSmapiLine(),
        }),
      );
    }
    await sleep(1000);
    launched = await page.evaluate(readGameState);
    unreachable = launched.ok === true ? 0 : unreachable + 1;
  }
  launchGameLog = sampleLaunchFacts(launched);
  const launchElapsedMs = Date.now() - launchBegan;
  if (plateaued)
    say(
      describeLaunchPlateau({
        elapsedMs: launchElapsedMs,
        unchangedForMs,
        state: launched,
        game: lastSmapiLine(),
      }),
    );
  const expectedGameLocale = typeof launch.state?.locale?.locale === "string" ? launch.state.locale.locale : null;
  const gameSaveLoadedLine = launchGameLog.facts?.[CHAIN_STEPS.saveLoaded]?.raw ?? null;
  const gameLocale = { expected: expectedGameLocale, saw: liveGameLocaleOf(gameSaveLoadedLine) };
  const localeMismatch = gameLocaleMismatch({ expected: expectedGameLocale, saveLoadedLine: gameSaveLoadedLine });
  record("launch", {
    settled: readinessOf(launched) !== "pending",
    plateaued,
    elapsedMs: launchElapsedMs,
    unchangedForMs,
    budgetMs: BUDGET.launchMs,
    state: launched,
    preconditions: { controls, guardian },
    problems: [...problems.entries()],
    answers: [...answers],
    cabinReads: { ...cabinReads },
    gameLog: lastSmapiLine(),
    gameLogChainFacts: launchGameLog,
    gameLocale,
    hostAnswers: await hostAnswers(launch.state?.port),
    pageEvents: pageEvents.slice(-12),
  });
  const launchProblem = problems.get("game/launch") ?? null;
  if (launchProblem !== null) return await refuse(browser, LAUNCH_STEPS.launch, { code: launchProblem.code, cause: launchProblem.cause, guardian });

  /*
   * The language the launched game is really in, read from the line SMAPI echoed when it loaded the save.
   * It is the product's own fact - the engine's localized-asset suffix, empty for English - and it is the
   * only witness of whether this run measured the product in the language it configured. A run that seeded
   * a language and got another one is red BY NAME here instead of being readable only by someone who
   * happens to notice the English on screen.
   */
  say(
    localeMismatch !== null
      ? `launched game locale: ${JSON.stringify(gameLocale)} - the run is configured for ${localeMismatch.expected} and the game is in ${localeMismatch.saw}`
      : `launched game locale: ${JSON.stringify(gameLocale)}${
          gameLocale.saw === null
            ? " (nothing measured: the game never logged a save load)"
            : " (the run and the game agree)"
        }`,
  );
  if (localeMismatch !== null) {
    facts.detail = `the launched game's own log says ${JSON.stringify(localeMismatch.line)}: the run is configured for ${localeMismatch.expected} and the game is in ${localeMismatch.saw}`;
    say(`FAILED: ${localeMismatch.code}`);
    return await conclude(browser, { verdict: VERDICTS.failed, code: localeMismatch.code, exit: 1 });
  }

  /*
   * ---- 4. the guide's third step. Reached whenever the launch has not already produced an attachment:
   * a launch that settled without one, and a launch that plateaued without one, are the same state from
   * here - a Player Host world waiting for the cabin choice - and the step is the same step. ----
   */
  let cabin = null;
  if (launched.ok === true && launched.attachmentStatus !== "attached" && readinessOf(launched) !== "failed") {
    cabin = await driveCabinHandoff();
    record("cabin handoff", cabin);
    if (cabin.state !== undefined) launched = cabin.state;
    else launched = await page.evaluate(readGameState);
    if (cabin.outcome === "no_handoff")
      return await notMeasured(
        browser,
        "cabin_handoff_not_offered",
        `the launch produced ${describeGameState(launched)} and the Game surface drew no cabin handoff section at all, so the guide's third step had no control to press (${JSON.stringify(cabin.handoff)})`,
      );
    if (cabin.outcome === "no_control")
      return await failed(
        browser,
        "cabin_read_never_fired",
        `the cabin handoff was drawn with no pressable control and no launch-wait line in ${String(cabin.elapsedMs)}ms, so nothing asked the Host for the cabin: ${String(cabin.cabinReads.requested)} request(s) for the handoff, ${String(cabin.reads.length)} press(es) by this driver; the handoff read ${JSON.stringify(cabin.handoff)}`,
      );
  }

  /*
   * The pair the driver calls ready is `running` + `attached`, and the instance word is published by the
   * coordinator's own projection of its launch state (`host/src/stardew-role-lifecycle-projection.internal.ts:44-45`
   * -> `host/src/game-browser/game-browser-state-provider.ts:167-172`). For a GameBuddy-launched host that
   * word can never be `running` (see `PRODUCT_GAPS` in `game-launch-verdict.mjs`), so a run that waited for
   * it would wait out its budget on every machine for ever. What is measured instead is the chain: how far
   * it got, and whether the step that is left is one of the gaps the product owns (`classifyChainStop`,
   * which says nothing at all unless this run's own readings prove the gap it names).
   */
  let instanceGap = null;
  if (readinessOf(launched) !== "ready") {
    const host = await hostAnswers(launch.state?.port);
    const stateText = launched.ok === true ? describeGameState(launched) : `state_unreadable:${String(launched.status)}`;
    const cabinText = cabin === null ? "the cabin step was not reached" : `the cabin step read ${JSON.stringify(cabin)}`;
    const observed = `the launch was requested through the product's own control (${JSON.stringify(controls.launch.name)}) and the surface then answered ${stateText}; ${cabinText}; the Host answers its own port: ${JSON.stringify(host)}; the page's own events: ${JSON.stringify(pageEvents.slice(-4))}`;
    /*
     * Two shapes, and they are not interchangeable. A Host that answered a bounded problem is classified
     * from that problem. A Host that stopped answering at all is the same missing prerequisite reached
     * through the transport when nothing bound can arm - and the Host's own failure when something can.
     */
    const reading = launched.ok === true ? null : classifySilentLaunch({ guardian, detail: observed });
    if (reading !== null) {
      facts.detail = reading.detail;
      say(`refusal classification: ${JSON.stringify(reading)}`);
      return await conclude(browser, {
        verdict: reading.verdict === VERDICTS.notMeasured ? VERDICTS.notMeasured : VERDICTS.failed,
        code: reading.reason,
        exit: reading.verdict === VERDICTS.failed ? 1 : 0,
      });
    }
    /*
     * The chain's furthest reachable state, and the step that is left. `classifyChainStop` returns a gap
     * only when this run's own readings prove it: an attachment that landed, the Mod's own word for the
     * confirmation it is still waiting on, or a game that refused a confirmation the run sent against an
     * offer whose window no page could answer inside. Anything else is `null` and stays a failure below.
     */
    const gap = classifyChainStop({
      state: launched,
      attachmentResponse: cabin?.attachmentResponse ?? readAttachmentResponse(launch.state?.declaredDataRoot ?? null),
      confirmPressedAtMs: cabin?.confirmPressedAtMs ?? null,
      /*
       * Both sides of the confirmation, as this run's wire recorded them: what the page sent, what the game
       * answered, and the window every offer carried. `classifyChainStop` reads them; this driver only has
       * the facts, never the judgement.
       */
      cabinConfirm: {
        requested: cabinConfirms.requested,
        refusals: answers
          .filter((entry) => entry.route === "game/stardew/cabins/confirm" && typeof entry.code === "string")
          .map((entry) => ({ status: entry.status, code: entry.code })),
        offers: cabinOffers
          .filter((entry) => Array.isArray(entry.choices) && entry.choices.length > 0)
          .map((entry) => ({ readAtMs: entry.readAtMs, expiresAtMs: entry.choices[0].expiresAtMs })),
      },
    });
    if (gap !== null) {
      facts.detail = `${observed}; ${gap.detail}`;
      if (gap.gap === PRODUCT_GAPS.instanceStatusNeverRunning) {
        /*
         * The companion IS in the farm: the rest of the chain - a player line, her answer - is still
         * measurable, and measuring it is worth more than stopping here. The verdict at the end says
         * which step is unreachable and why; it never claims `measured`, because `measured` is the
         * product's own `running`+`attached` and the product does not publish it.
         */
        instanceGap = gap;
        say(
          `the chain reached attachment=attached while the instance word reads ${String(launched.instanceStatus)}: measuring the rest of the chain; the verdict will name ${gap.gap}.`,
        );
      } else {
        say(`BLOCKED BY PRODUCT: ${gap.gap} - ${gap.detail}`);
        return await conclude(browser, { verdict: VERDICTS.blockedByProduct, code: gap.gap, exit: 0 });
      }
    } else {
      facts.detail = `${observed}; the surface never reached instance=running/attachment=attached within ${String(BUDGET.launchMs)}ms`;
      const cabinProblem = problems.get("game/stardew/cabins") ?? problems.get("game/stardew/cabins/confirm") ?? null;
      const refused =
        cabin === null
          ? `game_never_reached_ready:${stateText}`
          : cabin.outcome === "no_choices"
            ? `cabin_handoff_no_cabin:${stateText}${cabinProblem === null ? "" : `:${String(cabinProblem.code ?? cabinProblem.status)}`}`
            : cabin.outcome === "not_admitted"
              ? `cabin_handoff_not_admitted:${stateText}`
              : `cabin_handoff_did_not_attach:${stateText}`;
      say(`FAILED: ${refused}`);
      return await conclude(browser, { verdict: VERDICTS.failed, code: refused, exit: 1 });
    }
  } else {
    say(`the game reached ready: ${describeGameState(launched)} after ${String(Date.now() - launchBegan)}ms`);
  }
  await shot(page, "91-game-ready.png");

  /*
   * ---- 4b. the attached session's first minute: her client's observations reach the Host and open her turn ----
   *
   * The step this driver measures is `daily-agent-awake`, and its fact is the Host's own account line. Two things
   * about that line decide where the reading goes, both measured on 2026-11-22:
   *
   *   1. it is printed when the turn it opened SETTLES, not when it opens (`CompanionLoop.flush` awaits the
   *      pump's delivery and only then calls `#reportTurnDecision`, `host/src/companion-loop.ts:321-386`);
   *   2. her first turn after an attachment is an acting turn (a body program), not a reply - in
   *      `D:\gb-lanes\agentawake` it was still running 180 s later, with 16 provider requests in the run's wire.
   *
   * So the account cannot be final while she is still working, and a session stopped within a second of the
   * attachment has no turn at all to report (`D:\gb-lanes\agentawake4`: attach @173s, `stop settled in 0s`, 735
   * bytes of entry stderr, no account line). This window is what gives the world the minute in which her client
   * starts and its observations reach the Host; the STOP below settles whatever is still running, and step 7 reads
   * the account afterwards. The loop leaves as soon as the account says something, so a run whose first turn
   * settles inside the window pays only what that turn cost.
   */
  const attachBegan = Date.now();
  let firstAccount = agentAwakeOf(readTurnAccount(launch.state?.entryStderrFile ?? null));
  while (firstAccount.kind !== "awake" && Date.now() - attachBegan < BUDGET.attachedWindowMs) {
    await sleep(1000);
    firstAccount = agentAwakeOf(readTurnAccount(launch.state?.entryStderrFile ?? null));
  }
  record("the attached window", {
    elapsedMs: Date.now() - attachBegan,
    windowMs: BUDGET.attachedWindowMs,
    kind: firstAccount.kind,
    reason: firstAccount.reason,
    bytes: firstAccount.reading === null ? null : firstAccount.reading.bytes,
  });
  say(
    firstAccount.kind === "awake"
      ? `the account was final ${String(Date.now() - attachBegan)}ms into the attached session: ${describeTurnAccount(firstAccount)}`
      : `the attached session ran ${String(Date.now() - attachBegan)}ms with the account still ${String(firstAccount.reason)}; the STOP below settles whatever is running and step 7 reads it`,
  );

  // ---- 5. one player line, in the game surface ----
  //
  // The gate is asked OF THE GAME SURFACE. A document-wide question answers `ok` off the Chat
  // surface's composer even when this surface renders no input at all, and the fill then handed a
  // native setter `null` (`Illegal invocation`, measured on `frontend--r23`).
  const turnGate = await canStartTurn(page, { surface: "game-surface" });
  const transcriptBefore = await page.evaluate(readGameTranscript);
  record("composer", { turnGate, settledBefore: transcriptBefore.settled.length, surfacePresent: transcriptBefore.surfacePresent });
  facts.line = turnGate.ok ? "sent" : "none";
  if (!turnGate.ok) {
    /*
     * Nothing to type into. The Game surface is the lifecycle panel
     * (`design/architecture/product-surfaces.md`: installation, launch, cabin handoff, stop/disconnect/
     * endgame, her model settings), and a player's words reach her through the WORLD - the Mod reads the
     * game's own chat box and her line is the speech bubble over her head (`ModEntry.cs`,
     * `CompanionBubble.cs`) - so no browser route carries a player line here. The launch chain, which is
     * this driver's subject, is measured to attach; the reply is reported as absent by name instead of
     * typed into a field this surface does not render.
     */
    say(
      `the game surface offers no player input (${String(turnGate.reason)}): the chain is measured to attach and the reply is not typed into a field this surface does not render`,
    );
  } else {
    await page.evaluate((line) => {
      const scope = document.querySelector('[data-testid="game-surface"]');
      const area = scope.querySelector("textarea.composer-textarea");
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
      /*
       * The reply settles the question the whole chain was asking: the companion is in the farm and
       * answered in the Game surface. What is missing is the projection's word, which this host can never
       * publish - so the verdict names that gap instead of failing a launch that did everything.
       */
      if (instanceGap !== null) {
        facts.detail = `the companion's reply settled on the game surface while the Host reported ${describeGameState(stateAfterReply)}; ${instanceGap.detail}`;
        say(`BLOCKED BY PRODUCT: ${instanceGap.gap} - ${instanceGap.detail}`);
        return await conclude(browser, { verdict: VERDICTS.blockedByProduct, code: instanceGap.gap, exit: 0 });
      }
      const code = `game_never_reached_ready:${describeGameState(stateAfterReply)}`;
      facts.detail = `the reply settled while the Host reported ${describeGameState(stateAfterReply)}, so it is not a reply from an attached game`;
      say(`FAILED: ${code}`);
      return await conclude(browser, { verdict: VERDICTS.failed, code, exit: 1 });
    }
  }
  await observe(page, say, "w", { sinceMs: observationFrom });

  // ---- 6. stop the game this driver asked the product to start ----
  /*
   * A STOP IS NOT AN ENDED GAME. The press settles the companion's game actions and leaves the world standing
   * (project rules #3023/#506), so `pressStop` waits on the product's own `attached_stopped` phase and the
   * Host's `game/stop` answer - never on `instance=stopped|none`, which is the shape a game's DEATH leaves.
   * On HEAD before this lane both `firstjoin-r1` and `launchorphan-r1` printed the same sentence for both
   * outcomes: `settled: false, elapsedMs 120000, last instance=running/attachment=attached`.
   */
  const stopControl = await page.evaluate(readLifecycleControls);
  record("stop control", stopControl);
  if (stopControl.stop !== null && stopControl.stop.visible === true)
    await pressStop({
      page,
      say,
      record,
      budgetMs: BUDGET.stopMs,
      // The wire's own receipt: the `game/stop` answer this run saw, read by the listener above.
      stopAnswer: () => answers.filter((answer) => answer.route === "game/stop").at(-1) ?? null,
    });
  else say(`no stop control was offered (${JSON.stringify(stopControl.stop)}); the run's own cleanup names what remained`);

  /*
   * ---- 7. her agent's own account: the world's facts opened her turns with nobody speaking ----
   *
   * `daily-agent-awake`, and the one reading in this driver that is not the page's. The Host owns these turns:
   * `acceptHostMintedFact` enqueues the fact and starts the flush with nothing awaiting it
   * (`host/src/host-service.ts:976-982`), and `CompanionLoop.flush` prints `GAME_TURN_ACCOUNT` for every turn
   * it opens (`host/src/companion-loop.ts:385`). Those bytes reach this process only as the product entry's
   * stderr, which the launch phase keeps in `launch.state.entryStderrFile`; `capture/turn-account.cjs` reads the
   * line and `agentAwakeOf` says whether a turn opened FOR A WORLD FACT. Nobody has spoken in this run (the Game
   * surface mounts no composer, so `facts.line` above is `none`), so a turn that opened was opened by the world.
   *
   * WHY IT IS READ AFTER THE STOP, and not when the attachment lands. The line is printed when the turn it
   * opened SETTLES, not when it starts: `flush` awaits the pump's delivery and only then calls
   * `#reportTurnDecision` (`host/src/companion-loop.ts:321-386`). Her first turn here is an acting turn, not a
   * reply - measured 2026-11-22 in `D:\gb-lanes\agentawake`: 180 s after `attach`, with 16 provider requests for
   * one still-running turn in the run's wire, the entry's stderr held 6635 bytes and no account line at all. A
   * wait in front of that would have reported `turn_account_absent` about a turn that was busy working, which is
   * the opposite of what the line says. The STOP is what settles it (`pressStop` waits on the product's own
   * `attached_stopped` phase, project rules #3023/#565), so the account is final here - and the grace below only
   * covers the write landing after the settlement it reports.
   */
  const awakeBegan = Date.now();
  let awake = agentAwakeOf(readTurnAccount(launch.state?.entryStderrFile ?? null));
  while (awake.kind !== "awake" && Date.now() - awakeBegan < BUDGET.accountGraceMs) {
    await sleep(500);
    awake = agentAwakeOf(readTurnAccount(launch.state?.entryStderrFile ?? null));
  }
  record("her agent awake", {
    elapsedMs: Date.now() - awakeBegan,
    graceMs: BUDGET.accountGraceMs,
    kind: awake.kind,
    reason: awake.reason,
    playerLineSent: facts.line === "sent",
    reading:
      awake.reading === null
        ? null
        : { path: awake.reading.path, held: awake.reading.held, bytes: awake.reading.bytes, lines: awake.reading.lines.length },
  });
  say(`GAME-LAUNCH ${describeTurnAccount(awake)}`);
  if (awake.kind === "unreadable") return await notMeasured(browser, awake.reason, awake.detail);
  if (awake.kind !== "awake") return await failed(browser, awake.reason, awake.detail);
  return await conclude(browser, { verdict: VERDICTS.measured, code: "measured", exit: 0 });
})().catch((error) => {
  console.log("DRIVER W FAILED:", String(error).slice(0, 900));
  process.exit(1);
});
