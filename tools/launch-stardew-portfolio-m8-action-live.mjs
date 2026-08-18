#!/usr/bin/env node
/**
 * Starts exactly one target-version SMAPI process for the already prepared M8
 * Portfolio transaction. SMAPI owns the target game child; this launcher must
 * never start a second Stardew executable. It attaches the M8 action runner
 * (elevator, ladder, or the one-generation enter_mine → use_mine_ladder route)
 * after the Mod has had time to publish its native pipe binding, and always
 * tears the owned profile transaction back down. It does not select a save,
 * use UI/input, write save data, call raw save APIs, or perform any game
 * mutation outside the typed M8 bridge request made by the action runner.
 */
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { restorePortfolioProfile } from "./lib/stardew-portfolio-profile.mjs";
import { terminatePortfolioProcessTree } from "./run-stardew-portfolio-p0b-lifecycle.mjs";

const execFileAsync = promisify(execFile);
const PHASE = "m8_target_version_live_action";
const ELEVATOR_ACTION = "select_mine_elevator_floor";
const LADDER_ACTION = "use_mine_ladder";
const MINE_ROUTE_ACTION = "enter_mine";
const ACTION_RUNNERS = Object.freeze({
  [ELEVATOR_ACTION]: "tools/run-stardew-portfolio-m8-action.mjs",
  [LADDER_ACTION]: "tools/run-stardew-portfolio-m8-ladder-action.mjs",
  [MINE_ROUTE_ACTION]: "tools/run-stardew-portfolio-m8-mine-route-action.mjs",
});
// The prepared one-shot profile must carry exactly this EnabledActions list:
// the route sends both the independent entry and ladder typed requests over
// one bridge generation, and the Mod rechecks its own allowlist for each
// action at every game-thread admission.
const ACTION_ENABLED_SETS = Object.freeze({
  [ELEVATOR_ACTION]: Object.freeze([ELEVATOR_ACTION]),
  [LADDER_ACTION]: Object.freeze([LADDER_ACTION]),
  [MINE_ROUTE_ACTION]: Object.freeze([MINE_ROUTE_ACTION, LADDER_ACTION]),
});
const REQUIRED = Object.freeze([
  "GAMEBUDDY_STARDEW_GAME_PATH",
  "GAMEBUDDY_PORTFOLIO_PROFILE_ROOT",
  "GAMEBUDDY_PORTFOLIO_DATA_ROOT",
  "GAMEBUDDY_PORTFOLIO_BACKUP_NAME",
  "GAMEBUDDY_PORTFOLIO_PIPE_NAME",
  "GAMEBUDDY_PORTFOLIO_BRIDGE_TOKEN",
  "GAMEBUDDY_PORTFOLIO_SAVE_ID",
  "GAMEBUDDY_PORTFOLIO_WORLD_ID",
  "GAMEBUDDY_PORTFOLIO_LOCAL_PLAYER_ID",
  "GAMEBUDDY_PORTFOLIO_COMPANION_ID",
  "GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT",
]);
const SAFE_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PIPE_NAME = /^gamebuddy-stardew-portfolio[A-Za-z0-9_-]{0,96}$/;
const BRIDGE_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
// Same physical-slot grammar as PortfolioInitialNativeLoadConfig: the entire
// basename is bounded, the logical component is nonempty, and the exact
// target-version native ID suffix is decimal.
const OBSERVED_SLOT = /^GameBuddyPortfolio[A-Za-z0-9_-]+_[0-9]{1,32}$/;
const MIN_OBSERVED_SLOT_LENGTH = 21;
const MAX_OBSERVED_SLOT_LENGTH = 179;
const PROCESS_NAMES = Object.freeze(["StardewModdingAPI.exe", "Stardew Valley.exe", "StardewValley.exe"]);

export async function runM8TargetVersionLiveAction(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") throw new Error("m8_live_windows_only");
  const input = validate(env, options);
  const processList = options.processList ?? defaultProcessList;
  const spawnProcess = options.spawnProcess ?? spawn;
  const wait = options.wait ?? delay;
  const runAction = options.runAction ?? defaultRunAction;
  const restore = options.restore ?? restorePortfolioProfile;
  const processExists = options.processExists ?? defaultProcessExists;
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 1_800_000)
    throw new Error("m8_live_timeout_invalid");

  await assertNoStardewProcesses(processList);
  await verifyPreparedM8Profile(input, options.readFile ?? readFile);
  // A freshly deployed one-shot M8 profile always opens its first binding from
  // the Mod's zeroed process-local counter. The runtime-owned binding is thus
  // generation 1; do not accept a caller's stale prior-process generation.
  const runtimeEnv = materializeInitialBindingEnvironment(env);

  let smapiChild = null;
  let actionResult = null;
  let primaryError = null;
  try {
    smapiChild = spawnProcess(input.smapiExecutable, ["--mods-path", input.profileRoot], {
      cwd: input.gamePath,
      env: runtimeEnv,
      shell: false,
      windowsHide: false,
      stdio: options.stdio ?? "ignore",
    });
    if (!smapiChild || !Number.isInteger(smapiChild.pid) || smapiChild.pid <= 0)
      throw new Error("m8_live_smapi_identity_invalid");

    // SMAPI is the sole launch owner. It starts and supervises the target
    // Stardew process; spawning the game executable here creates duplicates.
    await wait(input.startupDelayMs);
    actionResult = await runAction(runtimeEnv, input.actionRunnerPath, timeoutMs, wait);
    if (actionResult?.state !== "M8_ACTION_TERMINAL") {
      // The attach-only runner emits a bounded, action-specific verdict. Keep
      // that exact verdict in the outer live-gate record: collapsing it would
      // make it impossible to determine whether Given failed before any typed
      // elevator request, versus a failure after the action was admitted.
      const code = typeof actionResult?.code === "string" && actionResult.code.length > 0
        ? message(actionResult.code)
        : "missing_action_verdict";
      throw new Error(`m8_live_action_not_terminal:${code}`);
    }
    return Object.freeze({
      state: "M8_ACTION_LIVE_TERMINAL",
      phase: PHASE,
      processId: smapiChild.pid,
      action: actionResult,
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    try {
      await terminatePortfolioProcessTree(smapiChild, {
        platform,
        spawnProcess,
        wait,
        processExists,
      });
      await assertNoStardewProcesses(processList);
    } catch (error) {
      cleanupErrors.push(`smapi_process_cleanup:${message(error)}`);
    }
    try {
      await restore({
        profileRoot: input.profileRoot,
        dataRoot: input.dataRoot,
        saveName: input.saveName,
        backupName: input.backupName,
        processNames: PROCESS_NAMES,
      });
    } catch (error) {
      cleanupErrors.push(`profile_restore:${message(error)}`);
    }
    if (cleanupErrors.length > 0 && primaryError === null)
      throw new Error(`m8_live_cleanup_failed:${cleanupErrors.join(",")}`);
  }
}

function materializeInitialBindingEnvironment(env) {
  return Object.freeze({ ...env, GAMEBUDDY_PORTFOLIO_BINDING_GENERATION: "1" });
}

function validate(env, options) {
  const action = env.GAMEBUDDY_PORTFOLIO_M8_ACTION ?? ELEVATOR_ACTION;
  if (!Object.hasOwn(ACTION_RUNNERS, action)) throw new Error("m8_live_action_invalid");
  const missing = REQUIRED.filter((key) => typeof env[key] !== "string" || env[key].length === 0);
  if (action === ELEVATOR_ACTION && (!env.GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT || typeof env.GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT !== "string"))
    missing.push("GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT");
  if (missing.length > 0) throw new Error(`m8_live_environment_missing:${missing.join(",")}`);
  const gamePath = absolute(env.GAMEBUDDY_STARDEW_GAME_PATH, "m8_live_game_path_invalid");
  const profileRoot = absolute(env.GAMEBUDDY_PORTFOLIO_PROFILE_ROOT, "m8_live_profile_root_invalid");
  const dataRoot = absolute(env.GAMEBUDDY_PORTFOLIO_DATA_ROOT, "m8_live_data_root_invalid");
  const backupName = env.GAMEBUDDY_PORTFOLIO_BACKUP_NAME;
  if (!SAFE_NAME.test(backupName)) throw new Error("m8_live_backup_name_invalid");
  if (!PIPE_NAME.test(env.GAMEBUDDY_PORTFOLIO_PIPE_NAME) || !BRIDGE_TOKEN.test(env.GAMEBUDDY_PORTFOLIO_BRIDGE_TOKEN))
    throw new Error("m8_live_bridge_identity_invalid");
  if ([env.GAMEBUDDY_PORTFOLIO_SAVE_ID, env.GAMEBUDDY_PORTFOLIO_WORLD_ID, env.GAMEBUDDY_PORTFOLIO_LOCAL_PLAYER_ID, env.GAMEBUDDY_PORTFOLIO_COMPANION_ID]
    .some((value) => !OPAQUE_ID.test(value)) || !isObservedPortfolioSlot(env.GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT))
    throw new Error("m8_live_scope_invalid");
  const checkpoint = env.GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT === undefined
    ? null
    : Number(env.GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT);
  if (action === ELEVATOR_ACTION && (!Number.isSafeInteger(checkpoint) || checkpoint < 5 || checkpoint > 120 || checkpoint % 5 !== 0))
    throw new Error("m8_live_checkpoint_invalid");
  const startupDelayMs = Number(options.startupDelayMs ?? env.GAMEBUDDY_PORTFOLIO_M8_STARTUP_DELAY_MS ?? 10_000);
  if (!Number.isInteger(startupDelayMs) || startupDelayMs < 1_000 || startupDelayMs > 60_000)
    throw new Error("m8_live_startup_delay_invalid");
  return Object.freeze({
    gamePath,
    profileRoot,
    dataRoot,
    backupName,
    pipeName: env.GAMEBUDDY_PORTFOLIO_PIPE_NAME,
    bridgeToken: env.GAMEBUDDY_PORTFOLIO_BRIDGE_TOKEN,
    saveId: env.GAMEBUDDY_PORTFOLIO_SAVE_ID,
    worldId: env.GAMEBUDDY_PORTFOLIO_WORLD_ID,
    localPlayerId: env.GAMEBUDDY_PORTFOLIO_LOCAL_PLAYER_ID,
    companionId: env.GAMEBUDDY_PORTFOLIO_COMPANION_ID,
    action,
    checkpoint,
    observedSaveSlot: env.GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT,
    saveName: env.GAMEBUDDY_PORTFOLIO_SAVE_NAME ?? "GameBuddyPortfolioNative02",
    smapiExecutable: join(gamePath, "StardewModdingAPI.exe"),
    gameExecutable: join(gamePath, "Stardew Valley.exe"),
    actionRunnerPath: options.actionRunnerPath ?? resolve(ACTION_RUNNERS[action]),
    startupDelayMs,
  });
}

async function verifyPreparedM8Profile(input, readConfig) {
  let config;
  try {
    config = JSON.parse(await readConfig(join(input.profileRoot, "GameBuddy", "config.json"), "utf8"));
  } catch {
    throw new Error("m8_live_prepared_config_missing");
  }
  const portfolio = config?.Portfolio;
  const expected = ACTION_ENABLED_SETS[input.action];
  const exact = [
    [portfolio?.PipeName, input.pipeName],
    [portfolio?.BridgeToken, input.bridgeToken],
    [portfolio?.SaveId, input.saveId],
    [portfolio?.WorldId, input.worldId],
    [portfolio?.LocalPlayerId, input.localPlayerId],
    [portfolio?.CompanionId, input.companionId],
    [sameAbsolute(portfolio?.DataRoot, input.dataRoot), true],
    [portfolio?.InitialNativeLoad?.ObservedSaveSlot, input.observedSaveSlot],
  ];
  if (!portfolio || portfolio.Enable !== true || portfolio.Topology !== "single_player_native_companion" ||
      portfolio.ExpectedGameVersion !== "1.6.15" || portfolio.ExpectedGameBuildNumber !== 24356 ||
      portfolio.EnableObserveBridge !== true || !Array.isArray(portfolio.EnabledActions) ||
      JSON.stringify(portfolio.EnabledActions) !== JSON.stringify(expected) ||
      portfolio.InitialNativeLoad?.Enable !== true ||
      portfolio.P0bLifecycleProducer?.Enable === true || portfolio.Bootstrap?.Enable === true ||
      exact.some(([actual, expectedValue]) => actual !== expectedValue))
    throw new Error("m8_live_prepared_config_invalid");
}

async function defaultRunAction(env, actionRunnerPath, timeoutMs, wait) {
  // `--action` performs its own read-only Given probe and its typed When/Then
  // over one authenticated bridge connection. Retrying a separate preflight
  // client would disconnect and invalidate this exact binding generation.
  // A startup pipe absence occurs before any request and is the sole retryable
  // result; every connected verdict consumes the one allowed action attempt.
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await runActionMode(env, actionRunnerPath, "--action", Math.max(1_000, deadline - Date.now()));
    if (!isStartupUnavailable(result.code)) return result;
    if (Date.now() >= deadline) throw new Error("m8_live_action_startup_timeout");
    await wait(1_000);
  }
}

async function runActionMode(env, actionRunnerPath, mode, timeoutMs) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [actionRunnerPath, mode], {
      env,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return parseActionOutput(stdout);
  } catch (error) {
    // The action runner uses exit code 2 for all fail-closed verdicts. Its
    // bounded JSON output remains the authoritative reason, not the process
    // exit code.
    if (typeof error?.stdout === "string" && error.stdout.trim()) return parseActionOutput(error.stdout);
    throw new Error("m8_live_action_process_failed");
  }
}

function isStartupUnavailable(code) {
  // The only retryable bridge error is absence of the named pipe while the
  // owned SMAPI child is starting. Protocol, snapshot, scope, or probe
  // failures are terminal admission failures and must not be retried.
  return code === "portfolio_environment_missing" ||
    (typeof code === "string" && /^connect ENOENT \\\\.\\pipe\\/.test(code));
}

function parseActionOutput(stdout) {
  const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("m8_live_action_output_missing");
  try { return JSON.parse(line); } catch { throw new Error("m8_live_action_output_invalid"); }
}

async function assertNoStardewProcesses(processList) {
  let found;
  try { found = await processList(PROCESS_NAMES); } catch { throw new Error("m8_live_process_query_failed"); }
  if (!Array.isArray(found) || found.some((name) => !PROCESS_NAMES.includes(name)) || new Set(found).size !== found.length)
    throw new Error("m8_live_process_query_ambiguous");
  if (found.length > 0) throw new Error(`m8_live_stardew_process_running:${found.join(",")}`);
}

async function defaultProcessList(names) {
  const found = [];
  for (const imageName of names) {
    try {
      const { stdout } = await execFileAsync("tasklist.exe", ["/FI", `IMAGENAME eq ${imageName}`, "/NH", "/FO", "CSV"], { windowsHide: true });
      for (const line of String(stdout).split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
        if (/^INFO:\s+No tasks are running/i.test(line)) continue;
        const match = /^\"([^\"]+)\",/.exec(line);
        if (!match) throw new Error("m8_live_process_query_ambiguous");
        if (match[1].toLowerCase() === imageName.toLowerCase()) found.push(imageName);
      }
    } catch (error) {
      if (error?.code === 1) continue;
      throw error;
    }
  }
  return Object.freeze(found);
}

function defaultProcessExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error?.code === "ESRCH") return false; if (error?.code === "EPERM") return true; throw error; }
}
function absolute(value, code) { if (typeof value !== "string" || !value || !/^[A-Za-z]:[\\/]/.test(value)) throw new Error(code); return resolve(value); }
function sameAbsolute(value, expected) {
  try { return absolute(value, "m8_live_prepared_config_invalid") === expected; } catch { return false; }
}
function isObservedPortfolioSlot(value) {
  return typeof value === "string" &&
    value.length >= MIN_OBSERVED_SLOT_LENGTH && value.length <= MAX_OBSERVED_SLOT_LENGTH &&
    OBSERVED_SLOT.test(value);
}
function message(error) { return String(error instanceof Error ? error.message : error).replace(/\s+/g, " ").slice(0, 256); }
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    emit(await runM8TargetVersionLiveAction());
  } catch (error) {
    emit({ state: "BLOCKED", phase: PHASE, reason: message(error) });
    process.exitCode = 2;
  }
}
