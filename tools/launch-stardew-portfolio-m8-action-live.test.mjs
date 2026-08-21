import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  isStartupUnavailable,
  runnerFailureCode,
  runM8TargetVersionLiveAction,
  runM8TargetVersionM8Closure,
  runM8TargetVersionStagedFixtureAction,
} from "./launch-stardew-portfolio-m8-action-live.mjs";
import { M8_STAGED_SAVE_FIXTURES } from "./lib/stardew-portfolio-staged-save-fixture.mjs";

const environment = Object.freeze({
  GAMEBUDDY_STARDEW_GAME_PATH: "C:/game",
  GAMEBUDDY_PORTFOLIO_PROFILE_ROOT: "C:/profile",
  GAMEBUDDY_PORTFOLIO_DATA_ROOT: "C:/data",
  GAMEBUDDY_PORTFOLIO_BACKUP_NAME: "m8-live-action-test",
  GAMEBUDDY_PORTFOLIO_PIPE_NAME: "gamebuddy-stardew-portfolio-test",
  GAMEBUDDY_PORTFOLIO_BRIDGE_TOKEN: "a".repeat(32),
  GAMEBUDDY_PORTFOLIO_SAVE_ID: "445880081",
  GAMEBUDDY_PORTFOLIO_WORLD_ID: "-8474196460473483841",
  GAMEBUDDY_PORTFOLIO_LOCAL_PLAYER_ID: "-8474196460473483841",
  GAMEBUDDY_PORTFOLIO_COMPANION_ID: "portfolio_companion",
  GAMEBUDDY_PORTFOLIO_BINDING_GENERATION: "1",
  GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT: "GameBuddyPortfolioNative02_445880081",
  GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: "5",
  GAMEBUDDY_PORTFOLIO_SAVE_NAME: "GameBuddyPortfolioNative02",
});

test("M8 live runner redacts child stderr to an allowed failure code", () => {
  assert.equal(runnerFailureCode("Error: portfolio_bridge_closed:pipe_closed"), "portfolio_bridge_closed:pipe_closed");
  assert.equal(runnerFailureCode("token=secret scope=private"), "runner_output_missing");
});

test("M8 live runner retries only an unpublished native pipe during startup", () => {
  assert.equal(isStartupUnavailable("portfolio_pipe_not_published"), true);
  assert.equal(isStartupUnavailable("portfolio_pipe_connect_failed"), false);
  assert.equal(isStartupUnavailable("portfolio_pipe_connect_closed"), false);
  assert.equal(isStartupUnavailable("portfolio_pipe_write_timeout"), false);
  assert.equal(isStartupUnavailable("portfolio_environment_missing"), false);
});

function child(pid = 1234) {
  const result = new EventEmitter();
  result.pid = pid;
  return result;
}

function preparedConfig(actions = "select_mine_elevator_floor") {
  const enabled = Array.isArray(actions) ? actions : [actions];
  return JSON.stringify({
    Portfolio: {
      Enable: true,
      Topology: "single_player_native_companion",
      EnableObserveBridge: true,
      EnabledActions: enabled,
      PipeName: environment.GAMEBUDDY_PORTFOLIO_PIPE_NAME,
      BridgeToken: environment.GAMEBUDDY_PORTFOLIO_BRIDGE_TOKEN,
      SaveId: environment.GAMEBUDDY_PORTFOLIO_SAVE_ID,
      WorldId: environment.GAMEBUDDY_PORTFOLIO_WORLD_ID,
      LocalPlayerId: environment.GAMEBUDDY_PORTFOLIO_LOCAL_PLAYER_ID,
      CompanionId: environment.GAMEBUDDY_PORTFOLIO_COMPANION_ID,
      DataRoot: environment.GAMEBUDDY_PORTFOLIO_DATA_ROOT,
      ExpectedGameVersion: "1.6.15",
      ExpectedGameBuildNumber: 24356,
      Bootstrap: { Enable: false },
      InitialNativeLoad: { Enable: true, ObservedSaveSlot: "GameBuddyPortfolioNative02_445880081" },
      ...(Array.isArray(enabled) && enabled.includes("enter_mine") ? { MineEntryGivenFixture: { Enable: true } } : {}),
      ...(enabled.length === 1 && enabled[0] === "use_mine_ladder" ? { MineLadderGivenFixture: { Enable: true } } : {}),
      ...(enabled.length === 1 && enabled[0] === "select_mine_elevator_floor" ? { MineElevatorGivenFixture: { Enable: true } } : {}),
      P0bLifecycleProducer: { Enable: false },
    },
  });
}

function setup(overrides = {}) {
  const spawned = [];
  const restored = [];
  const waits = [];
  const options = {
    platform: "win32",
    env: environment,
    startupDelayMs: 1_000,
    timeoutMs: 30_000,
    processList: async () => [],
    readFile: async () => preparedConfig(),
    spawnProcess: (program, args) => {
      const value = child(spawned.length === 0 ? 1234 : spawned.length === 1 ? 2345 : 5678);
      spawned.push({ program, args, child: value });
      return value;
    },
    wait: async (ms) => {
      waits.push(ms);
    },
    processExists: () => false,
    restore: async (value) => {
      restored.push(value);
    },
    runAction: async () => ({ state: "M8_ACTION_TERMINAL", terminal: { state: "succeeded" } }),
    ...overrides,
  };
  return { options, spawned, restored, waits };
}

// The production reader is intentionally dependency-free; inject the exact
// JSON through a temporary readFile implementation by patching the expected
// profile with a real test fixture at the filesystem boundary is unnecessary
// here, so this test asserts the admission ordering with a prebuilt config.
test("M8 live runner refuses a pre-existing game before launch or action", async () => {
  const { options, spawned, restored } = setup({ processList: async () => ["StardewModdingAPI.exe"] });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /m8_live_stardew_process_running/);
  assert.equal(spawned.length, 0);
  assert.equal(restored.length, 0);
});

test("M8 live runner rejects missing environment before process work", async () => {
  const { options, spawned } = setup({ env: { ...environment, GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: "" } });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /m8_live_environment_missing/);
  assert.equal(spawned.length, 0);
});

test("M8 live runner rejects a fixture bound to another action before process work", async () => {
  const { options, spawned } = setup({
    env: { ...environment, GAMEBUDDY_PORTFOLIO_M8_ACTION: "use_mine_ladder", GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: undefined },
    fixtureTransaction: {
      fixtureId: "m8_elevator_floor_5_given_v1",
      declaration: M8_STAGED_SAVE_FIXTURES.m8_elevator_floor_5_given_v1,
      transactionId: "fixture-1",
      stagedSlotDirectory: "C:/Saves/GameBuddyPortfolioNative02_M8Elevator_fixture-1_445880081",
      stagedSlotName: environment.GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT,
      canonicalSlotDirectory: "C:/Saves/GameBuddyPortfolioNative02_445880081",
      canonicalManifestSha256: "a".repeat(64),
    },
  });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /fixture_action_mismatch/);
  assert.equal(spawned.length, 0);
});

test("M8 live runner verifies and disposes an exact named staged fixture", async () => {
  const verified = [];
  const disposed = [];
  const stagedSlotName = "GameBuddyPortfolioNative02_M8Ladder_fixture-1_445880081";
  const declaration = M8_STAGED_SAVE_FIXTURES.m8_ladder_given_v1;
  const { options, spawned } = setup({
    env: { ...environment, GAMEBUDDY_PORTFOLIO_M8_ACTION: "use_mine_ladder", GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: undefined, GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT: stagedSlotName },
    readFile: async () => preparedConfig("use_mine_ladder").replaceAll(environment.GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT, stagedSlotName),
    fixtureTransaction: {
      fixtureId: "m8_ladder_given_v1",
      declaration,
      transactionId: "fixture-1",
      stagedSlotDirectory: `C:/Saves/${stagedSlotName}`,
      stagedSlotName,
      canonicalSlotDirectory: "C:/Saves/GameBuddyPortfolioNative02_445880081",
      canonicalManifestSha256: "a".repeat(64),
    },
    verifyFixture: async (value) => {
      verified.push(value);
      return { fixtureId: "m8_ladder_given_v1", actionId: "use_mine_ladder", stagedSlotName };
    },
    verifyCanonical: async (value) => verified.push(value),
    disposeFixture: async (value) => disposed.push(value),
  });
  const result = await runM8TargetVersionLiveAction(options);
  assert.equal(result.state, "M8_ACTION_LIVE_TERMINAL");
  assert.equal(spawned.length, 2);
  assert.equal(verified.length, 6, "fixture and canonical state are checked before launch, immediately before launch, and during cleanup");
  assert.deepEqual(disposed, [{ stagedSlotDirectory: `C:/Saves/${stagedSlotName}`, transactionId: "fixture-1" }]);
});

test("M8 staged fixture launcher derives the matching fixture, stages, patches, profiles, and launches only its staged slot", async () => {
  const events = [];
  const stagedSlotName = "GameBuddyPortfolioNative02_M8Ladder_m8-use_mine_ladder-abc_445880081";
  const { options } = setup({
    env: { ...environment, APPDATA: "C:/Users/test/AppData/Roaming", GAMEBUDDY_PORTFOLIO_M8_ACTION: "use_mine_ladder", GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: undefined },
    profile: { releaseDir: "C:/release" },
    saveRoot: "C:/Users/test/AppData/Roaming/StardewValley/Saves",
    prepareFixture: async (value) => {
      events.push(["prepare", value]);
      return {
        stagedSlotDirectory: `C:/Users/test/AppData/Roaming/StardewValley/Saves/${stagedSlotName}`,
        stagedSlotName,
        stagedSaveName: environment.GAMEBUDDY_PORTFOLIO_SAVE_NAME,
        canonicalManifestSha256: "a".repeat(64),
      };
    },
    applyFixture: async (value) => events.push(["apply", value]),
    verifyFixture: async () => ({ fixtureId: "m8_ladder_given_v1", actionId: "use_mine_ladder", stagedSlotName }),
    verifyCanonical: async () => {},
    prepareProfile: async (value) => events.push(["profile", value]),
    readFile: async () => preparedConfig("use_mine_ladder").replaceAll(environment.GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT, stagedSlotName),
    verifyTargetAssembly: async (gamePath, declaration) => events.push(["target", gamePath, declaration.fixtureId]),
    disposeFixture: async (value) => events.push(["dispose", value]),
  });
  const result = await runM8TargetVersionStagedFixtureAction(options);
  assert.equal(result.state, "M8_ACTION_LIVE_TERMINAL");
  assert.deepEqual(events.map(([name]) => name), ["target", "prepare", "apply", "profile", "dispose"]);
  assert.equal(events[0][2], "m8_ladder_given_v1");
  assert.equal(events[1][1].saveRoot, "C:\\Users\\test\\AppData\\Roaming\\StardewValley\\Saves");
  assert.equal(events[3][1].observedSaveSlot, stagedSlotName);
  assert.deepEqual(events[3][1].enabledActions, ["use_mine_ladder"]);
});

test("M8 staged fixture launcher derives its profile release directory from the process environment", async () => {
  const stagedSlotName = "GameBuddyPortfolioNative02_M8Ladder_m8-use_mine_ladder-abc_445880081";
  const profiles = [];
  const { options } = setup({
    env: { ...environment, APPDATA: "C:/Users/test/AppData/Roaming", GAMEBUDDY_PORTFOLIO_RELEASE_DIR: "C:/release", GAMEBUDDY_PORTFOLIO_M8_ACTION: "use_mine_ladder", GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: undefined },
    saveRoot: "C:/Users/test/AppData/Roaming/StardewValley/Saves",
    verifyTargetAssembly: async () => {},
    prepareFixture: async () => ({ stagedSlotDirectory: `C:/Users/test/AppData/Roaming/StardewValley/Saves/${stagedSlotName}`, stagedSlotName, canonicalManifestSha256: "a".repeat(64) }),
    applyFixture: async () => {},
    verifyFixture: async () => ({ fixtureId: "m8_ladder_given_v1", actionId: "use_mine_ladder", stagedSlotName }),
    verifyCanonical: async () => {},
    disposeFixture: async () => {},
    prepareProfile: async (value) => profiles.push(value),
    readFile: async () => preparedConfig("use_mine_ladder").replaceAll(environment.GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT, stagedSlotName),
  });
  await runM8TargetVersionStagedFixtureAction(options);
  assert.equal(profiles[0].releaseDir, "C:\\release");
});

test("M8 closure command routes ladder through the staged fixture launcher", async () => {
  const stagedSlotName = "GameBuddyPortfolioNative02_M8Ladder_m8-use_mine_ladder-abc_445880081";
  const { options } = setup({
    env: { ...environment, APPDATA: "C:/Users/test/AppData/Roaming", GAMEBUDDY_PORTFOLIO_M8_ACTION: "use_mine_ladder", GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: undefined },
    profile: { releaseDir: "C:/release" },
    saveRoot: "C:/Users/test/AppData/Roaming/StardewValley/Saves",
    verifyTargetAssembly: async () => {},
    prepareFixture: async () => ({ stagedSlotDirectory: `C:/Users/test/AppData/Roaming/StardewValley/Saves/${stagedSlotName}`, stagedSlotName, canonicalManifestSha256: "a".repeat(64) }),
    applyFixture: async () => {},
    verifyFixture: async () => ({ fixtureId: "m8_ladder_given_v1", actionId: "use_mine_ladder", stagedSlotName }),
    verifyCanonical: async () => {},
    disposeFixture: async () => {},
    prepareProfile: async () => {},
    readFile: async () => preparedConfig("use_mine_ladder").replaceAll(environment.GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT, stagedSlotName),
  });
  const result = await runM8TargetVersionM8Closure(options);
  assert.equal(result.state, "M8_ACTION_LIVE_TERMINAL");
});

test("M8 staged fixture launcher records redacted Given setup separately from action output", async () => {
  const stagedSlotName = "GameBuddyPortfolioNative02_M8Ladder_m8-use_mine_ladder-abc_445880081";
  const records = [];
  const { options } = setup({
    env: { ...environment, APPDATA: "C:/Users/test/AppData/Roaming", GAMEBUDDY_PORTFOLIO_M8_ACTION: "use_mine_ladder", GAMEBUDDY_PORTFOLIO_M8_MODE: "preflight", GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: undefined },
    profile: { releaseDir: "C:/release" },
    saveRoot: "C:/Users/test/AppData/Roaming/StardewValley/Saves",
    verifyTargetAssembly: async () => {},
    prepareFixture: async () => ({ stagedSlotDirectory: `C:/Users/test/AppData/Roaming/StardewValley/Saves/${stagedSlotName}`, stagedSlotName, canonicalManifestSha256: "a".repeat(64) }),
    applyFixture: async () => {},
    verifyFixture: async () => ({ fixtureId: "m8_ladder_given_v1", actionId: "use_mine_ladder", stagedSlotName }),
    verifyCanonical: async () => {},
    disposeFixture: async () => {},
    prepareProfile: async () => {},
    readFile: async () => preparedConfig("use_mine_ladder").replaceAll(environment.GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT, stagedSlotName),
    runAction: async () => ({ state: "M8_GIVEN_READY", action: "use_mine_ladder", probe: { facility: true } }),
    recordFixtureSetup: async (record) => records.push(record),
  });
  const result = await runM8TargetVersionStagedFixtureAction(options);
  assert.equal(result.state, "M8_ACTION_LIVE_PREFLIGHT_READY");
  assert.deepEqual(records.map((record) => record.outcome), ["staged_given_ready", "fresh_given_observed"]);
  assert.deepEqual(Object.keys(records[0]).sort(), ["canonicalIntegrity", "fixtureId", "outcome", "ownership", "stagedSlotName", "targetVersion"]);
  assert.equal("probe" in records[1], false);
});

test("M8 staged fixture launcher restores its profile if profile deployment succeeds but prelaunch fails", async () => {
  const stagedSlotName = "GameBuddyPortfolioNative02_M8Ladder_m8-use_mine_ladder-abc_445880081";
  const restores = [];
  const { options } = setup({
    env: { ...environment, APPDATA: "C:/Users/test/AppData/Roaming", GAMEBUDDY_PORTFOLIO_M8_ACTION: "use_mine_ladder", GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: undefined },
    profile: { releaseDir: "C:/release" },
    saveRoot: "C:/Users/test/AppData/Roaming/StardewValley/Saves",
    verifyTargetAssembly: async () => {},
    prepareFixture: async () => ({ stagedSlotDirectory: `C:/Users/test/AppData/Roaming/StardewValley/Saves/${stagedSlotName}`, stagedSlotName, canonicalManifestSha256: "a".repeat(64) }),
    applyFixture: async () => {},
    verifyFixture: async () => ({ fixtureId: "m8_ladder_given_v1", actionId: "use_mine_ladder", stagedSlotName }),
    verifyCanonical: async () => {},
    disposeFixture: async () => {},
    prepareProfile: async () => {},
    processList: async () => ["StardewModdingAPI.exe"],
    restore: async (value) => restores.push(value),
  });
  await assert.rejects(() => runM8TargetVersionStagedFixtureAction(options), /m8_live_stardew_process_running/);
  assert.equal(restores.length, 1);
});

test("M8 live runner selects the ladder runner without an elevator checkpoint", async () => {
  const observed = [];
  const { options, spawned, restored } = setup({
    env: {
      ...environment,
      GAMEBUDDY_PORTFOLIO_M8_ACTION: "use_mine_ladder",
      GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: undefined,
    },
    readFile: async () => preparedConfig("use_mine_ladder"),
    runAction: async (runtimeEnv, actionRunnerPath) => {
      observed.push({ generation: runtimeEnv.GAMEBUDDY_PORTFOLIO_BINDING_GENERATION, actionRunnerPath });
      return { state: "M8_ACTION_TERMINAL", terminal: { state: "succeeded" } };
    },
  });
  const result = await runM8TargetVersionLiveAction(options);
  assert.equal(result.state, "M8_ACTION_LIVE_TERMINAL");
  assert.equal(observed.length, 1);
  assert.match(observed[0].actionRunnerPath, /run-stardew-portfolio-m8-ladder-action\.mjs$/);
  assert.equal(observed[0].generation, "1");
  assert.equal(spawned.length, 2);
  assert.match(spawned[0].program, /StardewModdingAPI\.exe$/);
  assert.match(spawned[1].program, /taskkill$/);
  assert.equal(restored.length, 1);
});

test("M8 live runner uses entry preflight without sending an action request", async () => {
  const observed = [];
  const { options, spawned, restored } = setup({
    env: {
      ...environment,
      GAMEBUDDY_PORTFOLIO_M8_ACTION: "enter_mine",
      GAMEBUDDY_PORTFOLIO_M8_MODE: "preflight",
      GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: undefined,
    },
    readFile: async () => preparedConfig("enter_mine"),
    runAction: async (runtimeEnv, actionRunnerPath, timeoutMs, wait, mode) => {
      observed.push({
        generation: runtimeEnv.GAMEBUDDY_PORTFOLIO_BINDING_GENERATION,
        actionRunnerPath,
        timeoutMs,
        wait,
        mode,
      });
      return { state: "M8_GIVEN_READY", action: "enter_mine" };
    },
  });
  const result = await runM8TargetVersionLiveAction(options);
  assert.equal(result.state, "M8_ACTION_LIVE_PREFLIGHT_READY");
  assert.equal(observed.length, 1);
  assert.equal(observed[0].mode, "preflight");
  assert.match(observed[0].actionRunnerPath, /run-stardew-portfolio-m8-entry-action\.mjs$/);
  assert.equal(spawned.length, 2);
  assert.equal(restored.length, 1);
});

test("M8 live runner preserves a non-mutating skip-event sequence preflight verdict", async () => {
  const { options, spawned, restored } = setup({
    env: {
      ...environment,
      GAMEBUDDY_PORTFOLIO_M8_ACTION: "enter_mine",
      GAMEBUDDY_PORTFOLIO_M8_MODE: "preflight",
      GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: undefined,
    },
    readFile: async () => preparedConfig(["skip_event", "enter_mine"]),
    runAction: async (runtimeEnv) => {
      assert.equal(runtimeEnv.GAMEBUDDY_PORTFOLIO_M8_SKIP_EVENT_ENABLED, "1");
      return { state: "M8_SEQUENCE_READY", action: "enter_mine", skipEventProbe: { eventObserved: true } };
    },
  });
  const result = await runM8TargetVersionLiveAction(options);
  assert.equal(result.state, "M8_ACTION_LIVE_PREFLIGHT_SEQUENCE_READY");
  assert.equal(result.action.state, "M8_SEQUENCE_READY");
  assert.equal(spawned.length, 2);
  assert.equal(restored.length, 1);
});

test("M8 live runner maps enter_mine to the independent entry runner", async () => {
  const observed = [];
  const { options, spawned, restored } = setup({
    env: {
      ...environment,
      GAMEBUDDY_PORTFOLIO_M8_ACTION: "enter_mine",
      GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: undefined,
    },
    readFile: async () => preparedConfig("enter_mine"),
    runAction: async (runtimeEnv, actionRunnerPath) => {
      observed.push({ generation: runtimeEnv.GAMEBUDDY_PORTFOLIO_BINDING_GENERATION, actionRunnerPath });
      return { state: "M8_ACTION_TERMINAL", terminal: { state: "succeeded" } };
    },
  });
  const result = await runM8TargetVersionLiveAction(options);
  assert.equal(result.state, "M8_ACTION_LIVE_TERMINAL");
  assert.equal(observed.length, 1);
  assert.match(observed[0].actionRunnerPath, /run-stardew-portfolio-m8-entry-action\.mjs$/);
  assert.equal(observed[0].generation, "1");
  assert.equal(spawned.length, 2);
  assert.match(spawned[0].program, /StardewModdingAPI\.exe$/);
  assert.match(spawned[1].program, /taskkill$/);
  assert.equal(restored.length, 1);
});

test("M8 live runner accepts an entry profile with skip_event fixture before enter_mine", async () => {
  const { options, spawned, restored } = setup({
    env: {
      ...environment,
      GAMEBUDDY_PORTFOLIO_M8_ACTION: "enter_mine",
      GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: undefined,
    },
    readFile: async () => preparedConfig(["skip_event", "enter_mine"]),
    runAction: async () => ({ state: "M8_ACTION_TERMINAL", terminal: { state: "succeeded" } }),
  });
  const result = await runM8TargetVersionLiveAction(options);
  assert.equal(result.state, "M8_ACTION_LIVE_TERMINAL");
  assert.equal(spawned.length, 2);
  assert.match(spawned[0].program, /StardewModdingAPI\.exe$/);
  assert.equal(restored.length, 1);
});

test("M8 live runner rejects an entry profile with skip_event but wrong second action", async () => {
  const { options, spawned, restored } = setup({
    env: {
      ...environment,
      GAMEBUDDY_PORTFOLIO_M8_ACTION: "enter_mine",
      GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: undefined,
    },
    readFile: async () => preparedConfig(["skip_event", "use_mine_ladder"]),
  });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /m8_live_prepared_config_invalid/);
  assert.equal(spawned.length, 0);
  assert.equal(restored.length, 0);
});

test("M8 live runner rejects an entry profile with skip_event alone (no enter_mine)", async () => {
  const { options, spawned, restored } = setup({
    env: {
      ...environment,
      GAMEBUDDY_PORTFOLIO_M8_ACTION: "enter_mine",
      GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: undefined,
    },
    readFile: async () => preparedConfig(["skip_event"]),
  });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /m8_live_prepared_config_invalid/);
  assert.equal(spawned.length, 0);
  assert.equal(restored.length, 0);
});

test("M8 live runner rejects an entry profile with empty actions", async () => {
  const { options, spawned, restored } = setup({
    env: {
      ...environment,
      GAMEBUDDY_PORTFOLIO_M8_ACTION: "enter_mine",
      GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: undefined,
    },
    readFile: async () => preparedConfig([]),
  });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /m8_live_prepared_config_invalid/);
  assert.equal(spawned.length, 0);
  assert.equal(restored.length, 0);
});

test("M8 live runner rejects an entry profile with duplicate enter_mine", async () => {
  const { options, spawned, restored } = setup({
    env: {
      ...environment,
      GAMEBUDDY_PORTFOLIO_M8_ACTION: "enter_mine",
      GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: undefined,
    },
    readFile: async () => preparedConfig(["enter_mine", "enter_mine"]),
  });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /m8_live_prepared_config_invalid/);
  assert.equal(spawned.length, 0);
  assert.equal(restored.length, 0);
});

test("M8 live runner rejects an entry profile that silently enables ladder", async () => {
  const { options, spawned, restored } = setup({
    env: {
      ...environment,
      GAMEBUDDY_PORTFOLIO_M8_ACTION: "enter_mine",
      GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT: undefined,
    },
    readFile: async () => preparedConfig(["enter_mine", "use_mine_ladder"]),
  });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /m8_live_prepared_config_invalid/);
  assert.equal(spawned.length, 0);
  assert.equal(restored.length, 0);
});

test("M8 live runner rejects an unknown mode before process work", async () => {
  const { options, spawned, restored } = setup({
    env: { ...environment, GAMEBUDDY_PORTFOLIO_M8_MODE: "observe_and_act" },
  });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /m8_live_mode_invalid/);
  assert.equal(spawned.length, 0);
  assert.equal(restored.length, 0);
});

test("M8 live runner rejects an unknown action before process work", async () => {
  const { options, spawned, restored } = setup({
    env: { ...environment, GAMEBUDDY_PORTFOLIO_M8_ACTION: "single_player_sleep_and_advance_day" },
  });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /m8_live_action_invalid/);
  assert.equal(spawned.length, 0);
  assert.equal(restored.length, 0);
});

test("M8 live runner launches once, accepts one terminal action, then restores the owned profile", async () => {
  const { options, spawned, restored, waits } = setup();
  const result = await runM8TargetVersionLiveAction(options);
  assert.equal(result.state, "M8_ACTION_LIVE_TERMINAL");
  assert.equal(spawned.length, 2, "one SMAPI root and one cleanup process");
  assert.match(spawned[0].program, /C:[\\/]game[\\/]StardewModdingAPI\.exe$/);
  assert.match(spawned[1].program, /taskkill$/);
  assert.equal(spawned[0].args[0], "--mods-path");
  assert.match(spawned[0].args[1], /C:[\\/]profile$/);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].backupName, "m8-live-action-test");
  assert.ok(waits.includes(1_000));
});

test("M8 live runner refuses a prepared profile without the one-shot native load", async () => {
  const { options, spawned, restored } = setup({
    readFile: async () =>
      JSON.stringify({
        Portfolio: {
          Enable: true,
          Topology: "single_player_native_companion",
          EnableObserveBridge: true,
          EnabledActions: ["select_mine_elevator_floor"],
          Bootstrap: { Enable: false },
          InitialNativeLoad: { Enable: false, ObservedSaveSlot: "GameBuddyPortfolioNative02_445880081" },
          P0bLifecycleProducer: { Enable: false },
        },
      }),
  });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /m8_live_prepared_config_invalid/);
  assert.equal(spawned.length, 0);
  assert.equal(restored.length, 0);
});

test("M8 live runner refuses an environment/config identity mismatch before launch", async () => {
  const { options, spawned, restored } = setup({
    env: { ...environment, GAMEBUDDY_PORTFOLIO_PIPE_NAME: "gamebuddy-stardew-portfolio-wrong" },
  });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /m8_live_prepared_config_invalid/);
  assert.equal(spawned.length, 0);
  assert.equal(restored.length, 0);
});

test("M8 live runner rejects invalid target-version scope syntax before process work", async () => {
  const { options, spawned, restored } = setup({
    env: { ...environment, GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT: "GameBuddyPortfolioNative02_bad" },
  });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /m8_live_scope_invalid/);
  assert.equal(spawned.length, 0);
  assert.equal(restored.length, 0);
});

test("M8 live runner treats binding generation as native runtime state, not a launch precondition", async () => {
  const env = { ...environment };
  delete env.GAMEBUDDY_PORTFOLIO_BINDING_GENERATION;
  const observed = [];
  const { options, spawned, restored } = setup({
    env,
    runAction: async (runtimeEnv) => {
      observed.push(runtimeEnv.GAMEBUDDY_PORTFOLIO_BINDING_GENERATION);
      return { state: "M8_ACTION_TERMINAL", terminal: { state: "succeeded" } };
    },
  });
  const result = await runM8TargetVersionLiveAction(options);
  assert.equal(result.state, "M8_ACTION_LIVE_TERMINAL");
  assert.deepEqual(observed, ["1"]);
  assert.equal(spawned[0].child.pid, 1234);
  assert.equal(restored.length, 1);
});

test("M8 live runner shares the Mod's exact observed-slot upper boundary", async () => {
  const prefix = "GameBuddyPortfolio";
  const maximum = `${prefix}${"a".repeat(128)}_${"9".repeat(32)}`;
  assert.equal(maximum.length, 179);
  const config = JSON.parse(preparedConfig());
  config.Portfolio.InitialNativeLoad.ObservedSaveSlot = maximum;
  const { options, spawned } = setup({
    env: { ...environment, GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT: maximum },
    readFile: async () => JSON.stringify(config),
  });
  await runM8TargetVersionLiveAction(options);
  assert.equal(spawned.length, 2);

  const tooLong = `${maximum}0`;
  const rejected = setup({ env: { ...environment, GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT: tooLong } });
  await assert.rejects(() => runM8TargetVersionLiveAction(rejected.options), /m8_live_scope_invalid/);
  assert.equal(rejected.spawned.length, 0);
});

test("M8 live runner rejects a prepared config with drifted topology facts before launch", async () => {
  const parsed = JSON.parse(preparedConfig());
  parsed.Portfolio.DataRoot = "C:/wrong-data";
  const { options, spawned, restored } = setup({ readFile: async () => JSON.stringify(parsed) });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /m8_live_prepared_config_invalid/);
  assert.equal(spawned.length, 0);
  assert.equal(restored.length, 0);
});

test("M8 live runner refuses a stale caller generation rather than passing it to the action runner", async () => {
  const observed = [];
  const { options } = setup({
    env: { ...environment, GAMEBUDDY_PORTFOLIO_BINDING_GENERATION: "3" },
    runAction: async (runtimeEnv) => {
      observed.push(runtimeEnv.GAMEBUDDY_PORTFOLIO_BINDING_GENERATION);
      return { state: "M8_ACTION_TERMINAL", terminal: { state: "succeeded" } };
    },
  });
  await runM8TargetVersionLiveAction(options);
  assert.deepEqual(observed, ["1"]);
});

test("M8 live runner preserves the bounded pre-mutation action verdict and restores", async () => {
  const { options, restored } = setup({
    runAction: async () => ({ state: "BLOCKED", code: "m8_probe_given_not_ready" }),
  });
  await assert.rejects(
    () => runM8TargetVersionLiveAction(options),
    /m8_live_action_not_terminal:m8_probe_given_not_ready/,
  );
  assert.equal(restored.length, 1);
});

test("M8 live runner preserves a post-admission action verdict and restores", async () => {
  const { options, restored } = setup({
    runAction: async () => ({ state: "BLOCKED", code: "portfolio_bridge_closed:pipe_closed" }),
  });
  await assert.rejects(
    () => runM8TargetVersionLiveAction(options),
    /m8_live_action_not_terminal:portfolio_bridge_closed:pipe_closed/,
  );
  assert.equal(restored.length, 1);
});

test("M8 live runner labels a missing action verdict rather than masking it", async () => {
  const { options, restored } = setup({ runAction: async () => ({ state: "BLOCKED" }) });
  await assert.rejects(
    () => runM8TargetVersionLiveAction(options),
    /m8_live_action_not_terminal:missing_action_verdict/,
  );
  assert.equal(restored.length, 1);
});

test("M8 live runner exposes restore failure after an action failure", async () => {
  let restoreCalled = false;
  const { options } = setup({
    runAction: async () => ({ state: "BLOCKED", code: "action_failed" }),
    restore: async () => {
      restoreCalled = true;
      throw new Error("restore_broken");
    },
  });
  await assert.rejects(
    () => runM8TargetVersionLiveAction(options),
    /m8_live_action_not_terminal:action_failed;m8_live_cleanup_failed:profile_restore:restore_broken/,
  );
  assert.equal(restoreCalled, true);
});
