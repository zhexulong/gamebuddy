import assert from "node:assert/strict";
import test from "node:test";
import { runWaterPetBowlSmoke } from "./run-stardew-native-local-player-water-pet-bowl-smoke.mjs";

const BOWL_TARGET = {
  targetId: "pet_bowl_0000000000000001",
  x: 53,
  y: 7,
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
    FixtureScenario: "native_water_pet_bowl_v1",
    LogicalSaveName: "GameBuddyFixturePetBowl",
    ObservedSaveSlot: "GameBuddyFixturePetBowl_1",
  },
};

const CAPABILITIES = ["cancel_active_execution", "equip_tool", "inspect_self", "move_to_tile", "travel", "water_pet_bowl"];

function baseSnapshot(revision, tile, extra) {
  return {
    revision,
    location: "Farm",
    tile,
    actionable: true,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    warps: [],
    toolSlots: [{ slot: 1, label: "Watering Can" }],
    currentTool: "Watering Can",
    petBowlTargets: [],
    ...extra,
  };
}

const WATER_EVIDENCE =
  "after_watered=true;before_watered=false;expected_stamina_cost=2;location=Farm;native_menu_opened=false;stamina_after=98;stamina_before=100;stamina_delta=-2;target=pet_bowl_0000000000000001;tile=53,7;water_after=39;water_before=40;water_consumed=true";

test("water-pet-bowl runner requires the native watered transition and a fresh postcondition", async () => {
  let snapshot = baseSnapshot(5, { x: 53, y: 8 }, { petBowlTargets: [{ ...BOWL_TARGET }] });
  const calls = [];
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      calls.push(request.action);
      if (request.action === "water_pet_bowl") {
        assert.deepEqual(request.args, { x: BOWL_TARGET.x, y: BOWL_TARGET.y, expectedTargetId: BOWL_TARGET.targetId });
        snapshot = baseSnapshot(6, { x: 53, y: 8 }, { petBowlTargets: [] });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "water-bowl-execution",
          state: "succeeded",
          reasonCode: "pet_bowl_watered",
          revision: 6,
          evidence: { detail: WATER_EVIDENCE },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };

  const result = await runWaterPetBowlSmoke(client, [], config);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "pet_bowl_watered");
  assert.equal(result.receipt.reasonCode, "pet_bowl_watered");
  assert.equal(result.preciseWaterDelta, true);
  assert.equal(result.sourceTargetGone, true);
  assert.equal(result.freshPostcondition, true);
  assert.deepEqual(calls, ["water_pet_bowl"]);
});

test("water-pet-bowl runner fails closed when the bowl target is absent and unreachable", async () => {
  // The fixture precondition is missing: no bowl target is advertised, so the
  // runner must search for an approach and refuse to submit the action.
  let snapshot = baseSnapshot(5, { x: 53, y: 8 }, { petBowlTargets: [] });
  const submitted = [];
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      if (request.action === "water_pet_bowl") {
        submitted.push(request.action);
        throw new Error("water_pet_bowl_must_not_be_submitted_without_a_target");
      }
      if (request.action === "move_to_tile") {
        return {
          requestId: request.requestId,
          executionId: "move-execution",
          state: "rejected",
          reasonCode: "no_native_path",
          revision: snapshot.revision,
          evidence: { detail: "reason=no_native_path" },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };

  const result = await runWaterPetBowlSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /no_reachable_native_water_pet_bowl_fixture_target/);
  assert.deepEqual(submitted, [], "the action must never be submitted without a live target");
});

test("water-pet-bowl runner does not claim success when the native postcondition is absent", async () => {
  let snapshot = baseSnapshot(5, { x: 53, y: 8 }, { petBowlTargets: [{ ...BOWL_TARGET }] });
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      if (request.action === "water_pet_bowl") {
        // The native postcondition did not hold: the receipt is `uncertain`, not
        // `succeeded`. The snapshot still retires the target (the Mod stopped
        // advertising it) so the reread stabilizes and the ONLY reason the
        // runner must refuse success is the terminal state itself.
        snapshot = baseSnapshot(6, { x: 53, y: 8 }, { petBowlTargets: [] });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "water-bowl-execution",
          state: "uncertain",
          reasonCode: "pet_bowl_water_postcondition_unavailable",
          revision: 6,
          evidence: {
            detail:
              "after_watered=false;before_watered=false;expected_stamina_cost=2;location=Farm;native_menu_opened=false;stamina_after=100;stamina_before=100;stamina_delta=0;target=pet_bowl_0000000000000001;tile=53,7;water_after=40;water_before=40;water_consumed=false",
          },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };

  const result = await runWaterPetBowlSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.equal(result.receipt.reasonCode, "pet_bowl_water_postcondition_unavailable");
  assert.equal(result.reasonCode, "water_pet_bowl_postcondition_mismatch");
});

test("water-pet-bowl runner rejects a stale post-terminal revision", async () => {
  let snapshot = baseSnapshot(5, { x: 53, y: 8 }, { petBowlTargets: [{ ...BOWL_TARGET }] });
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      if (request.action === "water_pet_bowl") {
        // The observe immediately after this terminal jumps past the terminal
        // revision, which must fail the stable reread closed.
        snapshot = baseSnapshot(9, { x: 53, y: 8 }, { petBowlTargets: [] });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "water-bowl-execution",
          state: "succeeded",
          reasonCode: "pet_bowl_watered",
          revision: 8,
          evidence: { detail: WATER_EVIDENCE },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };

  const result = await runWaterPetBowlSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /native_post_terminal_revision_mismatch/);
});

test("water-pet-bowl runner refuses a mismatched fixture scenario or action set", async () => {
  const wrongScenario = {
    ...config,
    NativeLocalPlayerFixture: { ...config.NativeLocalPlayerFixture, FixtureScenario: "native_water_crop_v1" },
  };
  const client = { state: {}, observe: async () => ({}), execute: async () => ({}) };
  // Config validation precedes the bridge session, so an invalid profile rejects
  // instead of returning a receipt-shaped result.
  await assert.rejects(
    () => runWaterPetBowlSmoke(client, [], wrongScenario),
    /native_local_water_pet_bowl_scenario_invalid/,
  );

  // Narrowing the surface under deny-by-exception means denying an action the
  // run needs; the retired allowlist used to express this by listing only one.
  const wrongActions = { ...config, DeniedActions: ["water_pet_bowl"] };
  await assert.rejects(
    () => runWaterPetBowlSmoke(client, [], wrongActions),
    /native_fixture_policy_denies_required/,
  );
});
