#!/usr/bin/env node
/**
 * Starts exactly one target-version SMAPI process for an M8 Portfolio
 * transaction. Ladder and elevator first establish their declared Given in a
 * launcher-owned staged save slot; enter_mine accepts only an already prepared
 * profile. SMAPI owns the target game child; this launcher must never start a
 * second Stardew executable. It attaches the action runner after the Mod has
 * published its native pipe binding and always tears the owned profile down.
 * It never uses UI/input or raw native dispatch. Fixture setup is isolated from
 * the typed bridge request, receipt, evidence, and postcondition.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  M8_STAGED_SAVE_FIXTURES,
  applyM8StagedSaveGiven,
  disposeM8StagedSaveFixture,
  prepareM8StagedSaveFixture,
  verifyM8CanonicalSaveUnchanged,
  verifyM8StagedSaveFixtureReady,
} from "./lib/stardew-portfolio-staged-save-fixture.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { preparePortfolioExistingSaveProfile, restorePortfolioProfile } from "./lib/stardew-portfolio-profile.mjs";
import { terminatePortfolioProcessTree } from "./run-stardew-portfolio-p0b-lifecycle.mjs";

const execFileAsync = promisify(execFile);
const PHASE = "m8_target_version_live_action";
const ELEVATOR_ACTION = "select_mine_elevator_floor";
const LADDER_ACTION = "use_mine_ladder";
const MINE_ROUTE_ACTION = "enter_mine";
const LIVE_MODES = Object.freeze({
  ACTION: "action",
  PREFLIGHT: "preflight",
});
const ACTION_RUNNERS = Object.freeze({
  [ELEVATOR_ACTION]: "tools/run-stardew-portfolio-m8-action.mjs",
  [LADDER_ACTION]: "tools/run-stardew-portfolio-m8-ladder-action.mjs",
  [MINE_ROUTE_ACTION]: "tools/run-stardew-portfolio-m8-entry-action.mjs",
});
// The prepared one-shot profile must carry exactly this EnabledActions list.
// Each M8 action gets its own profile and live closure; entry never silently
// enables the ladder action.
const ACTION_ENABLED_SETS = Object.freeze({
  [ELEVATOR_ACTION]: Object.freeze([ELEVATOR_ACTION]),
  [LADDER_ACTION]: Object.freeze([LADDER_ACTION]),
  [MINE_ROUTE_ACTION]: Object.freeze([MINE_ROUTE_ACTION]),
});
const FIXTURE_FOR_ACTION = Object.freeze({
  [LADDER_ACTION]: "m8_ladder_given_v1",
  [ELEVATOR_ACTION]: "m8_elevator_floor_5_given_v1",
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

/**
 * Own the complete validation-only staged-save transaction for a single M8
 * ladder/elevator closure. Fixture identity is derived from the fixed action;
 * callers receive no save patch, slot-name, XML, or action-policy surface.
 */
export async function runM8TargetVersionStagedFixtureAction(options = {}) {
  const env = options.env ?? process.env;
  if ((options.platform ?? process.platform) !== "win32") throw new Error("m8_live_windows_only");
  const input = validate(env, options);
  const fixtureId = FIXTURE_FOR_ACTION[input.action];
  if (!fixtureId) throw new Error("m8_live_fixture_action_unavailable");
  const declaration = M8_STAGED_SAVE_FIXTURES[fixtureId];
  const saveRoot = resolveM8SaveRoot(options.saveRoot ?? defaultM8SaveRoot(env));
  const canonicalSlotDirectory = join(saveRoot, input.observedSaveSlot);
  const transactionId = `m8-${input.action}-${randomBytes(12).toString("hex")}`;
  await (options.verifyTargetAssembly ?? verifyFixtureTargetAssembly)(input.gamePath, declaration);
  const staged = await (options.prepareFixture ?? prepareM8StagedSaveFixture)({
    canonicalSlotDirectory,
    saveRoot,
    declaration,
    transactionId,
  });
  const fixtureTransaction = Object.freeze({
    fixtureId,
    declaration,
    transactionId,
    canonicalSlotDirectory,
    canonicalManifestSha256: staged.canonicalManifestSha256,
    stagedSlotDirectory: staged.stagedSlotDirectory,
    stagedSlotName: staged.stagedSlotName,
    stagedSaveName: staged.stagedSaveName,
  });
  let handoff = false;
  let profilePrepared = false;
  let profileRestored = false;
  let primaryError = null;
  const originalRestore = options.restore ?? restorePortfolioProfile;
  const restore = async (restoreInput) => {
    await originalRestore(restoreInput);
    profileRestored = true;
  };
  try {
    await (options.applyFixture ?? applyM8StagedSaveGiven)({
      stagedSlotDirectory: staged.stagedSlotDirectory,
      declaration,
    });
    await verifyFixtureReady(fixtureTransaction, options);
    await recordFixtureSetup(options, fixtureTransaction, "staged_given_ready", null);
    const profileOptions = validateStagedProfileOptions(options.profile ?? defaultM8Profile(env), input, staged.stagedSlotName);
    await (options.prepareProfile ?? preparePortfolioExistingSaveProfile)({
      ...profileOptions,
      profileRoot: input.profileRoot,
      modsPath: input.profileRoot,
      dataRoot: input.dataRoot,
      saveName: input.saveName,
      gamePath: input.gamePath,
      backupName: input.backupName,
      pipeName: input.pipeName,
      bridgeToken: input.bridgeToken,
      saveId: input.saveId,
      worldId: input.worldId,
      localPlayerId: input.localPlayerId,
      companionId: input.companionId,
      observedSaveSlot: staged.stagedSlotName,
      enabledActions: ACTION_ENABLED_SETS[input.action],
    });
    profilePrepared = true;
    handoff = true;
    return await runM8TargetVersionLiveAction({
      ...options,
      restore,
      env: Object.freeze({
        ...env,
        GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT: staged.stagedSlotName,
      }),
      fixtureTransaction,
      fixtureSetupRecord: async (outcome) => recordFixtureSetup(options, fixtureTransaction, outcome, null),
    });
  } catch (error) {
    primaryError = error;
    try {
      await recordFixtureSetup(options, fixtureTransaction, "staged_transaction_blocked", message(error));
    } catch {
      // Preserve the primary transaction failure as the authoritative verdict.
    }
    throw error;
  } finally {
    // Once the inner launcher owns the armed profile it also owns disposal.
    // Before that handoff, this outer transaction is the only proven owner.
    const cleanupErrors = [];
    if (profilePrepared && !profileRestored) {
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
    }
    if (!handoff) {
      try {
        await (options.disposeFixture ?? disposeM8StagedSaveFixture)({
          stagedSlotDirectory: staged.stagedSlotDirectory,
          transactionId,
        });
      } catch (error) {
        // Preserve a root whose proof cannot be verified; the retained journal
        // is the sole recovery record and the transaction remains fail-closed.
        cleanupErrors.push(`staged_save_cleanup:${message(error)}`);
      }
    }
    if (cleanupErrors.length > 0) {
      const cleanupMessage = `m8_live_staged_fixture_cleanup_failed:${cleanupErrors.join(",")}`;
      if (primaryError === null) throw new Error(cleanupMessage);
      primaryError.message = `${primaryError.message};${cleanupMessage}`;
    }
  }
}

/** Route command-line M8 closure through the staged Given only where declared. */
export async function runM8TargetVersionM8Closure(options = {}) {
  const action = (options.env ?? process.env).GAMEBUDDY_PORTFOLIO_M8_ACTION ?? ELEVATOR_ACTION;
  return FIXTURE_FOR_ACTION[action]
    ? runM8TargetVersionStagedFixtureAction(options)
    : runM8TargetVersionLiveAction(options);
}

export async function runM8TargetVersionLiveAction(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") throw new Error("m8_live_windows_only");
  const input = validate(env, options);
  const fixture = validateFixtureTransaction(input, options.fixtureTransaction);
  const processList = options.processList ?? defaultProcessList;
  const spawnProcess = options.spawnProcess ?? spawn;
  const wait = options.wait ?? delay;
  const runAction = options.runAction ?? defaultRunAction;
  const restore = options.restore ?? restorePortfolioProfile;
  const processExists = options.processExists ?? defaultProcessExists;
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 1_800_000)
    throw new Error("m8_live_timeout_invalid");

  let smapiChild = null;
  let actionResult = null;
  let primaryError = null;
  let profileVerified = false;
  try {
    await assertNoStardewProcesses(processList);
    if (fixture !== null) await verifyFixtureReady(fixture, options);
    const skipEventEnabled = await verifyPreparedM8Profile(input, options.readFile ?? readFile);
    profileVerified = true;
    // A freshly deployed one-shot M8 profile always opens its first binding from
    // the Mod's zeroed process-local counter. The runtime-owned binding is thus
    // generation 1; do not accept a caller's stale prior-process generation.
    const runtimeEnv = materializeInitialBindingEnvironment(env, skipEventEnabled);
    if (fixture !== null) await verifyFixtureReady(fixture, options);
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
    actionResult = await runAction(runtimeEnv, input.actionRunnerPath, timeoutMs, wait, input.mode);
    if (fixture !== null && options.fixtureSetupRecord) {
      const outcome =
        input.mode === LIVE_MODES.PREFLIGHT && actionResult?.state === "M8_GIVEN_READY"
          ? "fresh_given_observed"
          : input.mode === LIVE_MODES.PREFLIGHT
            ? "fresh_given_not_observed"
            : "action_mode_completed";
      await options.fixtureSetupRecord(outcome);
    }
    const preflightReady =
      input.mode === LIVE_MODES.PREFLIGHT &&
      (actionResult?.state === "M8_GIVEN_READY" || actionResult?.state === "M8_SEQUENCE_READY");
    const actionTerminal = input.mode === LIVE_MODES.ACTION && actionResult?.state === "M8_ACTION_TERMINAL";
    if (!preflightReady && !actionTerminal) {
      // Preserve the runner's bounded verdict. Preflight never sends a typed
      // action request, while action mode consumes the explicitly sequenced
      // skip_event and enter_mine requests.
      const code =
        typeof actionResult?.code === "string" && actionResult.code.length > 0
          ? message(actionResult.code)
          : "missing_action_verdict";
      const phase = input.mode === LIVE_MODES.PREFLIGHT ? "preflight_not_ready" : "action_not_terminal";
      throw new Error(`m8_live_${phase}:${code}`);
    }
    return Object.freeze({
      state:
        input.mode === LIVE_MODES.PREFLIGHT
          ? actionResult.state === "M8_SEQUENCE_READY"
            ? "M8_ACTION_LIVE_PREFLIGHT_SEQUENCE_READY"
            : "M8_ACTION_LIVE_PREFLIGHT_READY"
          : "M8_ACTION_LIVE_TERMINAL",
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
    if (fixture !== null) {
      try {
        await verifyFixtureReady(fixture, options);
      } catch (error) {
        cleanupErrors.push(`staged_save_integrity:${message(error)}`);
      }
      try {
        await disposeFixture(fixture, options);
      } catch (error) {
        cleanupErrors.push(`staged_save_cleanup:${message(error)}`);
      }
    }
    if (profileVerified) {
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
    }
    if (cleanupErrors.length > 0) {
      const cleanupMessage = `m8_live_cleanup_failed:${cleanupErrors.join(",")}`;
      if (primaryError === null) throw new Error(cleanupMessage);
      primaryError.message = `${primaryError.message};${cleanupMessage}`;
    }
  }
}

function materializeInitialBindingEnvironment(env, skipEventEnabled = false) {
  return Object.freeze({
    ...env,
    GAMEBUDDY_PORTFOLIO_BINDING_GENERATION: "1",
    GAMEBUDDY_PORTFOLIO_M8_SKIP_EVENT_ENABLED: skipEventEnabled ? "1" : "0",
  });
}

function validate(env, options) {
  const action = env.GAMEBUDDY_PORTFOLIO_M8_ACTION ?? ELEVATOR_ACTION;
  const mode = env.GAMEBUDDY_PORTFOLIO_M8_MODE ?? LIVE_MODES.ACTION;
  if (!Object.hasOwn(ACTION_RUNNERS, action)) throw new Error("m8_live_action_invalid");
  if (!Object.values(LIVE_MODES).includes(mode)) throw new Error("m8_live_mode_invalid");
  const missing = REQUIRED.filter((key) => typeof env[key] !== "string" || env[key].length === 0);
  if (
    action === ELEVATOR_ACTION &&
    (!env.GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT || typeof env.GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT !== "string")
  )
    missing.push("GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT");
  if (missing.length > 0) throw new Error(`m8_live_environment_missing:${missing.join(",")}`);
  const gamePath = absolute(env.GAMEBUDDY_STARDEW_GAME_PATH, "m8_live_game_path_invalid");
  const profileRoot = absolute(env.GAMEBUDDY_PORTFOLIO_PROFILE_ROOT, "m8_live_profile_root_invalid");
  const dataRoot = absolute(env.GAMEBUDDY_PORTFOLIO_DATA_ROOT, "m8_live_data_root_invalid");
  const backupName = env.GAMEBUDDY_PORTFOLIO_BACKUP_NAME;
  if (!SAFE_NAME.test(backupName)) throw new Error("m8_live_backup_name_invalid");
  if (!PIPE_NAME.test(env.GAMEBUDDY_PORTFOLIO_PIPE_NAME) || !BRIDGE_TOKEN.test(env.GAMEBUDDY_PORTFOLIO_BRIDGE_TOKEN))
    throw new Error("m8_live_bridge_identity_invalid");
  if (
    [
      env.GAMEBUDDY_PORTFOLIO_SAVE_ID,
      env.GAMEBUDDY_PORTFOLIO_WORLD_ID,
      env.GAMEBUDDY_PORTFOLIO_LOCAL_PLAYER_ID,
      env.GAMEBUDDY_PORTFOLIO_COMPANION_ID,
    ].some((value) => !OPAQUE_ID.test(value)) ||
    !isObservedPortfolioSlot(env.GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT)
  )
    throw new Error("m8_live_scope_invalid");
  const checkpoint =
    env.GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT === undefined ? null : Number(env.GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT);
  if (
    action === ELEVATOR_ACTION &&
    (!Number.isSafeInteger(checkpoint) || checkpoint < 5 || checkpoint > 120 || checkpoint % 5 !== 0)
  )
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
    mode,
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
    [portfolio?.MineEntryGivenFixture?.Enable === true, input.action === MINE_ROUTE_ACTION],
    [portfolio?.MineLadderGivenFixture?.Enable === true, input.action === LADDER_ACTION],
    [portfolio?.MineElevatorGivenFixture?.Enable === true, input.action === ELEVATOR_ACTION],
  ];
  if (
    !portfolio ||
    portfolio.Enable !== true ||
    portfolio.Topology !== "single_player_native_companion" ||
    portfolio.ExpectedGameVersion !== "1.6.15" ||
    portfolio.ExpectedGameBuildNumber !== 24356 ||
    portfolio.EnableObserveBridge !== true ||
    !Array.isArray(portfolio.EnabledActions) ||
    !enabledActionsMatch(portfolio.EnabledActions, input.action, expected) ||
    portfolio.InitialNativeLoad?.Enable !== true ||
    portfolio.P0bLifecycleProducer?.Enable === true ||
    portfolio.Bootstrap?.Enable === true ||
    (portfolio.MineEntryGivenFixture !== undefined &&
      (typeof portfolio.MineEntryGivenFixture !== "object" ||
        Array.isArray(portfolio.MineEntryGivenFixture) ||
        Object.keys(portfolio.MineEntryGivenFixture).length !== 1 ||
        portfolio.MineEntryGivenFixture.Enable !== (input.action === MINE_ROUTE_ACTION))) ||
    (portfolio.MineLadderGivenFixture !== undefined &&
      (typeof portfolio.MineLadderGivenFixture !== "object" ||
        Array.isArray(portfolio.MineLadderGivenFixture) ||
        Object.keys(portfolio.MineLadderGivenFixture).length !== 1 ||
        portfolio.MineLadderGivenFixture.Enable !== (input.action === LADDER_ACTION))) ||
    (portfolio.MineElevatorGivenFixture !== undefined &&
      (typeof portfolio.MineElevatorGivenFixture !== "object" ||
        Array.isArray(portfolio.MineElevatorGivenFixture) ||
        Object.keys(portfolio.MineElevatorGivenFixture).length !== 1 ||
        portfolio.MineElevatorGivenFixture.Enable !== (input.action === ELEVATOR_ACTION))) ||
    exact.some(([actual, expectedValue]) => actual !== expectedValue)
  )
    throw new Error("m8_live_prepared_config_invalid");
  return input.action === MINE_ROUTE_ACTION &&
    Array.isArray(portfolio.EnabledActions) &&
    portfolio.EnabledActions.length === 2 &&
    portfolio.EnabledActions[0] === "skip_event" &&
    portfolio.EnabledActions[1] === MINE_ROUTE_ACTION;
}

/**
 * Validate EnabledActions against the action-specific allowed set.
 *
 * For enter_mine, both ["enter_mine"] and ["skip_event", "enter_mine"] are
 * valid — the latter includes an event-skip fixture before the mine entry.
 * All other actions require a strict exact match with their single-action set.
 */
function validateStagedProfileOptions(profile, input, stagedSlotName) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("m8_live_profile_setup_invalid");
  if (Object.hasOwn(profile, "enabledActions") || Object.hasOwn(profile, "observedSaveSlot") || Object.hasOwn(profile, "mineEntryGivenFixture") || Object.hasOwn(profile, "mineLadderGivenFixture") || Object.hasOwn(profile, "mineElevatorGivenFixture"))
    throw new Error("m8_live_profile_setup_action_override");
  if (typeof profile.releaseDir !== "string") throw new Error("m8_live_profile_setup_invalid");
  return Object.freeze({ ...profile, observedSaveSlot: stagedSlotName, enabledActions: ACTION_ENABLED_SETS[input.action] });
}
function defaultM8Profile(env) {
  return Object.freeze({ releaseDir: absolute(env.GAMEBUDDY_PORTFOLIO_RELEASE_DIR, "m8_live_release_dir_invalid") });
}
function defaultM8SaveRoot(env) {
  if (typeof env.APPDATA !== "string" || !/^[A-Za-z]:[\\/]/.test(env.APPDATA)) throw new Error("m8_live_save_root_invalid");
  return join(env.APPDATA, "StardewValley", "Saves");
}
function resolveM8SaveRoot(value) {
  return absolute(value, "m8_live_save_root_invalid");
}
async function verifyFixtureTargetAssembly(gamePath, declaration) {
  const assembly = join(gamePath, "Stardew Valley.dll");
  let contents;
  try {
    contents = await readFile(assembly);
  } catch {
    throw new Error("m8_live_target_assembly_missing");
  }
  const actual = createHash("sha256").update(contents).digest("hex");
  if (actual !== declaration.target.assemblySha256) throw new Error("m8_live_target_assembly_mismatch");
}
function validateFixtureTransaction(input, fixture) {
  if (fixture === undefined) return null;
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) throw new Error("m8_live_fixture_transaction_invalid");
  const expectedFixtureId = FIXTURE_FOR_ACTION[input.action];
  if (!expectedFixtureId || fixture.fixtureId !== expectedFixtureId || fixture.declaration !== M8_STAGED_SAVE_FIXTURES[expectedFixtureId])
    throw new Error("m8_live_fixture_action_mismatch");
  if (fixture.stagedSlotName !== input.observedSaveSlot || typeof fixture.transactionId !== "string")
    throw new Error("m8_live_fixture_transaction_invalid");
  return fixture;
}
async function recordFixtureSetup(options, fixture, outcome, detail) {
  if (!options.recordFixtureSetup) return;
  const record = Object.freeze({
    fixtureId: fixture.fixtureId,
    targetVersion: fixture.declaration.target.gameVersion,
    stagedSlotName: fixture.stagedSlotName,
    ownership: "transaction_owned",
    canonicalIntegrity: "verified",
    outcome,
    ...(detail === null ? {} : { detail: String(detail).slice(0, 128) }),
  });
  await options.recordFixtureSetup(record);
}
async function verifyFixtureReady(fixture, options) {
  const ready = await (options.verifyFixture ?? verifyM8StagedSaveFixtureReady)({
    stagedSlotDirectory: fixture.stagedSlotDirectory,
    transactionId: fixture.transactionId,
  });
  if (ready.fixtureId !== fixture.fixtureId || ready.actionId !== fixture.declaration.actionId || ready.stagedSlotName !== fixture.stagedSlotName)
    throw new Error("m8_live_fixture_ready_mismatch");
  await (options.verifyCanonical ?? verifyM8CanonicalSaveUnchanged)({
    canonicalSlotDirectory: fixture.canonicalSlotDirectory,
    expectedManifestSha256: fixture.canonicalManifestSha256,
  });
}
async function disposeFixture(fixture, options) {
  await (options.disposeFixture ?? disposeM8StagedSaveFixture)({
    stagedSlotDirectory: fixture.stagedSlotDirectory,
    transactionId: fixture.transactionId,
  });
}
function enabledActionsMatch(actual, action, expected) {
  if (!Array.isArray(actual)) return false;
  if (action === MINE_ROUTE_ACTION) {
    // Accept either the direct entry config or the skip-then-entry combo.
    const direct = actual.length === 1 && actual[0] === expected[0];
    const skipThenEntry = actual.length === 2 && actual[0] === "skip_event" && actual[1] === expected[0];
    return direct || skipThenEntry;
  }
  // All other actions: strict exact match.
  return actual.length === expected.length && actual.every((v, i) => v === expected[i]);
}

async function defaultRunAction(env, actionRunnerPath, timeoutMs, wait, mode) {
  // Both modes use one authenticated bridge connection. `--preflight` only
  // observes the Given; `--action` consumes the one allowed typed request.
  const runnerMode = mode === LIVE_MODES.PREFLIGHT ? "--preflight" : "--action";
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await runActionMode(env, actionRunnerPath, runnerMode, Math.max(1_000, deadline - Date.now()));
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
    throw new Error(`m8_live_action_process_failed:${runnerFailureCode(error?.stderr)}`);
  }
}

export function runnerFailureCode(stderr) {
  const value = String(stderr ?? "").trim();
  const match = /\b(portfolio_[a-z0-9_:.-]+|m8_[a-z0-9_:.-]+)\b/i.exec(value);
  return match === null ? "runner_output_missing" : match[1].slice(0, 128);
}

export function isStartupUnavailable(code) {
  // The only retryable bridge error is absence of the named pipe while the
  // owned SMAPI child is starting. Protocol, snapshot, scope, or probe
  // failures are terminal admission failures and must not be retried.
  return code === "portfolio_pipe_not_published";
}

function parseActionOutput(stdout) {
  const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("m8_live_action_output_missing");
  try {
    return JSON.parse(line);
  } catch {
    throw new Error("m8_live_action_output_invalid");
  }
}

async function assertNoStardewProcesses(processList) {
  let found;
  try {
    found = await processList(PROCESS_NAMES);
  } catch {
    throw new Error("m8_live_process_query_failed");
  }
  if (
    !Array.isArray(found) ||
    found.some((name) => !PROCESS_NAMES.includes(name)) ||
    new Set(found).size !== found.length
  )
    throw new Error("m8_live_process_query_ambiguous");
  if (found.length > 0) throw new Error(`m8_live_stardew_process_running:${found.join(",")}`);
}

async function defaultProcessList(names) {
  const found = [];
  for (const imageName of names) {
    try {
      const { stdout } = await execFileAsync(
        "tasklist.exe",
        ["/FI", `IMAGENAME eq ${imageName}`, "/NH", "/FO", "CSV"],
        { windowsHide: true },
      );
      for (const line of String(stdout)
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean)) {
        if (/^INFO:\s+No tasks are running/i.test(line)) continue;
        const match = /^"([^"]+)",/.exec(line);
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
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}
function absolute(value, code) {
  if (typeof value !== "string" || !value || !/^[A-Za-z]:[\\/]/.test(value)) throw new Error(code);
  return resolve(value);
}
function sameAbsolute(value, expected) {
  try {
    return absolute(value, "m8_live_prepared_config_invalid") === expected;
  } catch {
    return false;
  }
}
function isObservedPortfolioSlot(value) {
  return (
    typeof value === "string" &&
    value.length >= MIN_OBSERVED_SLOT_LENGTH &&
    value.length <= MAX_OBSERVED_SLOT_LENGTH &&
    OBSERVED_SLOT.test(value)
  );
}
function message(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\s+/g, " ")
    .slice(0, 256);
}
function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    emit(await runM8TargetVersionM8Closure());
  } catch (error) {
    emit({ state: "BLOCKED", phase: PHASE, reason: message(error) });
    process.exitCode = 2;
  }
}
