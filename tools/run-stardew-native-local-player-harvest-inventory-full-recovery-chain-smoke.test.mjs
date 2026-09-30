import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runHarvestInventoryFullRecoveryChainSmoke } from "./run-stardew-native-local-player-harvest-inventory-full-recovery-chain-smoke.mjs";

const SCENARIO = "native_harvest_crop_inventory_full_recovery_v1";
const CROP = {
  targetId: "crop_0000000000000001",
  x: 62,
  y: 18,
  qualifiedHarvestItemId: "(O)24",
  regrowsAfterHarvest: false,
};
const CHEST = {
  targetId: "chest_0000000000000001",
  x: 61,
  y: 18,
  slot: 0,
  qualifiedItemId: "(O)390",
};

const config = {
  SaveId: "save",
  WorldId: "world",
  PlayerId: "player",
  CompanionId: "companion",
  PipeName: "pipe",
  BridgeToken: "token",
  DeniedActions: [],
  DeniedActionFamilies: [],
  ExperimentalActions: [],
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: SCENARIO,
    LogicalSaveName: "GameBuddyFixtureFullBag",
    ObservedSaveSlot: "GameBuddyFixtureFullBag_1",
  },
};

const CAPABILITIES = ["cancel_active_execution", "chest_store", "harvest_crop", "inspect_self", "move_to_tile", "travel"];

// Field spellings must match the Mod exactly: the handler emits
// `regrowsAfterHarvest.ToString().ToLowerInvariant()`, i.e. a lowercase boolean.
const HARVEST_EVIDENCE =
  "crop_present_after=false;inventory_after=1;inventory_before=0;inventory_gained=true;item=(O)24;native_accepted=true;regrow_advanced=false;regrows=false;target=crop_0000000000000001;tile=62,18";
const STORE_EVIDENCE =
  "chest_stack_after=1;chest_stack_before=0;item=(O)390;native_menu_opened=false;source_consumed=true;target=chest_0000000000000001;tile=61,18";

/** Mock bridge whose observable revision tracks every terminal revision. */
function createMock({ revision, cropPresent, chestStorePresent, tileOverride }) {
  const state = { revision, cropPresent, chestStorePresent, client: null };
  const snapshot = () => ({
    revision: state.revision,
    location: "Farm",
    tile: tileOverride ?? { x: 62, y: 19 },
    actionable: true,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    warps: [],
    harvestTargets: state.cropPresent ? [{ ...CROP }] : [],
    chestStoreTargets: state.chestStorePresent ? [{ ...CHEST }] : [],
  });
  const advance = (patch) => {
    state.revision += 1;
    Object.assign(state, patch);
    const next = snapshot();
    if (state.client) state.client.state.snapshot = next;
    return next;
  };
  return { state, snapshot, advance };
}

test("container-full chain: reject inventory_full -> chest_store -> same-target retry succeeds", async () => {
  const mock = createMock({ revision: 5, cropPresent: true, chestStorePresent: true });
  const calls = [];
  const client = {
    state: { snapshot: mock.snapshot() },
    observe: async () => mock.snapshot(),
    execute: async (request) => {
      calls.push({ action: request.action, args: request.args });
      if (request.action === "harvest_crop") {
        // The fixture's backpack is full, so the first harvest is a deterministic
        // rejection that leaves the crop in the world.
        if (mock.state.chestStorePresent) {
          const revision = mock.advance({}).revision;
          return {
            requestId: request.requestId,
            executionId: "bp-execution",
            state: "rejected",
            reasonCode: "inventory_full",
            revision,
            evidence: { detail: "item=(O)24" },
          };
        }
        const revision = mock.advance({ cropPresent: false }).revision;
        return {
          requestId: request.requestId,
          executionId: "retry-execution",
          state: "succeeded",
          reasonCode: "crop_harvested",
          revision,
          evidence: { detail: HARVEST_EVIDENCE },
        };
      }
      if (request.action === "chest_store") {
        assert.deepEqual(request.args, {
          slot: CHEST.slot,
          x: CHEST.x,
          y: CHEST.y,
          expectedQualifiedItemId: CHEST.qualifiedItemId,
          expectedTargetId: CHEST.targetId,
        });
        // One carried item moves into the chest, freeing a slot.
        const revision = mock.advance({ chestStorePresent: false }).revision;
        return {
          requestId: request.requestId,
          executionId: "recovery-execution",
          state: "succeeded",
          reasonCode: "chest_stored",
          revision,
          evidence: { detail: STORE_EVIDENCE },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };
  mock.state.client = client;

  const result = await runHarvestInventoryFullRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "passed", `unexpected reason: ${result.reasonCode}`);
  assert.equal(result.reasonCode, "crop_harvested");
  assert.equal(result.chain.breakpointReceipt.reasonCode, "inventory_full");
  assert.equal(result.chain.recoveryReceipt.reasonCode, "chest_stored");
  assert.equal(result.chain.retryReceipt.reasonCode, "crop_harvested");
  assert.equal(result.chain.breakpointReceipt.revision < result.chain.recoveryReceipt.revision, true);
  assert.equal(result.chain.recoveryReceipt.revision < result.chain.retryReceipt.revision, true);
  assert.equal(result.sameJournalLineage, true);
  assert.equal(result.storeConsumed, true);
  assert.equal(result.inventoryGained, true);
  assert.equal(result.targetGone, true);
  assert.equal(result.freshPostcondition, true);
  // The chain must harvest twice (breakpoint + retry) around exactly one store.
  assert.equal(calls.filter((entry) => entry.action === "harvest_crop").length, 2);
  assert.equal(calls.filter((entry) => entry.action === "chest_store").length, 1);
});

test("container-full chain fails closed when the breakpoint never rejects", async () => {
  // If the harvest succeeds on the first attempt there is no container-full
  // breakpoint, so the chain must not report a recovery.
  const mock = createMock({ revision: 5, cropPresent: true, chestStorePresent: true });
  const client = {
    state: { snapshot: mock.snapshot() },
    observe: async () => mock.snapshot(),
    execute: async (request) => {
      if (request.action === "harvest_crop") {
        const revision = mock.advance({ cropPresent: false }).revision;
        return {
          requestId: request.requestId,
          executionId: "unexpected-success",
          state: "succeeded",
          reasonCode: "crop_harvested",
          revision,
          evidence: { detail: HARVEST_EVIDENCE },
        };
      }
      throw new Error("store_must_not_run_without_a_breakpoint");
    },
  };
  mock.state.client = client;

  const result = await runHarvestInventoryFullRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /recovery_chain_breakpoint_missing/);
});

test("container-full chain does not claim success when the retry postcondition is absent", async () => {
  const mock = createMock({ revision: 5, cropPresent: true, chestStorePresent: true });
  const client = {
    state: { snapshot: mock.snapshot() },
    observe: async () => mock.snapshot(),
    execute: async (request) => {
      if (request.action === "harvest_crop") {
        if (mock.state.chestStorePresent) {
          const revision = mock.advance({}).revision;
          return {
            requestId: request.requestId,
            executionId: "bp-execution",
            state: "rejected",
            reasonCode: "inventory_full",
            revision,
            evidence: { detail: "item=(O)24" },
          };
        }
        // Native ran but the crop stays advertised, so the fresh postcondition
        // cannot hold.
        const revision = mock.advance({}).revision;
        return {
          requestId: request.requestId,
          executionId: "retry-execution",
          state: "uncertain",
          reasonCode: "harvest_postcondition_unavailable",
          revision,
          evidence: { detail: HARVEST_EVIDENCE.replace("crop_present_after=false", "crop_present_after=true") },
        };
      }
      if (request.action === "chest_store") {
        const revision = mock.advance({ chestStorePresent: false }).revision;
        return {
          requestId: request.requestId,
          executionId: "recovery-execution",
          state: "succeeded",
          reasonCode: "chest_stored",
          revision,
          evidence: { detail: STORE_EVIDENCE },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };
  mock.state.client = client;

  const result = await runHarvestInventoryFullRecoveryChainSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /retry_harvest_failed/);
});

test("container-full chain keeps searching until BOTH the crop and the chest are in reach", async () => {
  // Settling on a crop-adjacent tile that cannot also reach the chest strands the
  // recovery step (measured live: crop 64,18 / chest 65,19 with the actor at 63,17,
  // which is Chebyshev-1 to the crop but 2 from the chest). The runner must keep
  // searching and must not fire the breakpoint from a stranded tile.
  const mock = createMock({ revision: 5, cropPresent: true, chestStorePresent: true, tileOverride: { x: 63, y: 17 } });
  const submitted = [];
  const receipts = [];
  const client = {
    state: { snapshot: mock.snapshot() },
    observe: async () => mock.snapshot(),
    execute: async (request) => {
      submitted.push({ action: request.action, args: request.args });
      if (request.action === "move_to_tile") {
        // Every movement lands somewhere that reaches the crop but NOT the chest.
        const revision = mock.advance({}).revision;
        const executionId = `move-${revision}`;
        receipts.push({
          requestId: request.requestId,
          executionId,
          state: "succeeded",
          reasonCode: "target_reached",
          revision,
          evidence: { detail: "tile=63,17;target=63,17" },
        });
        return { requestId: request.requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
      }
      throw new Error(`chain_action_must_not_run_without_both_targets_in_reach:${request.action}`);
    },
  };
  mock.state.client = client;

  const result = await runHarvestInventoryFullRecoveryChainSmoke(client, receipts, config);
  // Whatever the final bounded-search failure is, the ONE invariant that matters is
  // that the chain never fired an action from a tile that could not also reach the
  // chest: doing so strands the recovery step mid-chain.
  assert.equal(result.state, "blocked");
  assert.equal(
    submitted.some((entry) => entry.action === "harvest_crop"),
    false,
    "the breakpoint must not run from a tile that cannot also reach the chest",
  );
  assert.equal(
    submitted.some((entry) => entry.action === "chest_store"),
    false,
    "the recovery must not run when the chain never reached a usable position",
  );
});

test("container-full chain refuses a scenario it is not authorized for", async () => {
  const mock = createMock({ revision: 5, cropPresent: true, chestStorePresent: true });
  const client = { state: { snapshot: mock.snapshot() }, observe: async () => mock.snapshot() };
  const wrongScenario = {
    ...config,
    NativeLocalPlayerFixture: { ...config.NativeLocalPlayerFixture, FixtureScenario: "native_harvest_crop_v1" },
  };
  await assert.rejects(
    () => runHarvestInventoryFullRecoveryChainSmoke(client, [], wrongScenario),
    /native_local_fixture_config_invalid/,
  );

  const wrongActions = { ...config, DeniedActions: ["harvest_crop"] };
  await assert.rejects(
    () => runHarvestInventoryFullRecoveryChainSmoke(client, [], wrongActions),
    /native_fixture_policy_denies_required/,
  );
});

test("container-full chain accepts the real crop target id shape", () => {
  // The Mod emits crop_<hex16> (BuildCropTargetId in farmhandexecutioncontroller.cs).
  // This runner previously invented a harvest_ prefix, so every real target failed
  // validation, the runner never saw a reachable target, and it walked the map
  // indefinitely. An offline mock cannot catch that because it shares the runner's
  // own regex, so pin the accepted shape against the Mod source directly.
  const modSource = readFileSync(
    new URL("../integrations/stardew/farmhandexecutioncontroller.cs", import.meta.url),
    "utf8",
  );
  assert.match(modSource, /crop_\{Convert\.ToHexString/);
  const runner = readFileSync(
    new URL("./run-stardew-native-local-player-harvest-inventory-full-recovery-chain-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /crop_\[a-f0-9\]\{16\}/);
  assert.doesNotMatch(runner, /\^harvest_\[a-f0-9\]\{16\}\$/);
});
