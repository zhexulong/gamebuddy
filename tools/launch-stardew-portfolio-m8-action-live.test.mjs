import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { runM8TargetVersionLiveAction } from "./launch-stardew-portfolio-m8-action-live.mjs";

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

function child(pid = 1234) {
  const result = new EventEmitter();
  result.pid = pid;
  return result;
}

function preparedConfig(action = "select_mine_elevator_floor") {
  return JSON.stringify({
    Portfolio: {
      Enable: true,
      Topology: "single_player_native_companion",
      EnableObserveBridge: true,
      EnabledActions: [action],
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
    wait: async (ms) => { waits.push(ms); },
    processExists: () => false,
    restore: async (value) => { restored.push(value); },
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

test("M8 live runner rejects an unknown action before process work", async () => {
  const { options, spawned, restored } = setup({
    env: { ...environment, GAMEBUDDY_PORTFOLIO_M8_ACTION: "enter_mine" },
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
    readFile: async () => JSON.stringify({
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
  const { options, spawned, restored } = setup({ env: { ...environment, GAMEBUDDY_PORTFOLIO_PIPE_NAME: "gamebuddy-stardew-portfolio-wrong" } });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /m8_live_prepared_config_invalid/);
  assert.equal(spawned.length, 0);
  assert.equal(restored.length, 0);
});

test("M8 live runner rejects invalid target-version scope syntax before process work", async () => {
  const { options, spawned, restored } = setup({ env: { ...environment, GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT: "GameBuddyPortfolioNative02_bad" } });
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
  const { options, restored } = setup({ runAction: async () => ({ state: "BLOCKED", code: "m8_probe_given_not_ready" }) });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /m8_live_action_not_terminal:m8_probe_given_not_ready/);
  assert.equal(restored.length, 1);
});

test("M8 live runner preserves a post-admission action verdict and restores", async () => {
  const { options, restored } = setup({ runAction: async () => ({ state: "BLOCKED", code: "portfolio_bridge_closed:pipe_closed" }) });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /m8_live_action_not_terminal:portfolio_bridge_closed:pipe_closed/);
  assert.equal(restored.length, 1);
});

test("M8 live runner labels a missing action verdict rather than masking it", async () => {
  const { options, restored } = setup({ runAction: async () => ({ state: "BLOCKED" }) });
  await assert.rejects(() => runM8TargetVersionLiveAction(options), /m8_live_action_not_terminal:missing_action_verdict/);
  assert.equal(restored.length, 1);
});
