import assert from "node:assert/strict";
import test from "node:test";
import { runWaterSlimeHutchTroughSmoke } from "./run-stardew-native-local-player-water-slime-hutch-trough-smoke.mjs";

const TROUGH_TARGET = {
  targetId: "slime_hutch_trough_0000000000000001",
  x: 16,
  y: 6,
};

const INTERIOR = "Slime Hutch";

const config = {
  SaveId: "save",
  WorldId: "world",
  PlayerId: "player",
  CompanionId: "companion",
  PipeName: "pipe",
  BridgeToken: "token",
  ActionPolicyVersion: 0,
  EnabledActions: ["move_to_tile", "travel", "equip_tool", "water_slime_hutch_trough"],
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: "native_water_slime_hutch_trough_v1",
    LogicalSaveName: "GameBuddyFixtureSlimeHutch",
    ObservedSaveSlot: "GameBuddyFixtureSlimeHutch_1",
  },
};

const CAPABILITIES = [
  "cancel_active_execution",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "travel",
  "water_slime_hutch_trough",
];

function baseSnapshot(revision, tile, extra) {
  return {
    revision,
    location: INTERIOR,
    tile,
    actionable: true,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    warps: [],
    toolSlots: [{ slot: 1, label: "Watering Can" }],
    currentTool: "Watering Can",
    slimeHutchTroughTargets: [],
    ...extra,
  };
}

const WATER_EVIDENCE =
  "after_watered=true;before_watered=false;expected_stamina_cost=2;location=Slime Hutch;native_menu_opened=false;stamina_after=98;stamina_before=100;stamina_delta=-2;target=slime_hutch_trough_0000000000000001;tile=16,6;water_after=39;water_before=40;water_consumed=true";

test("water-slime-hutch-trough runner requires the native waterSpots transition and a fresh postcondition", async () => {
  let snapshot = baseSnapshot(5, { x: 17, y: 6 }, { slimeHutchTroughTargets: [{ ...TROUGH_TARGET }] });
  const calls = [];
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      calls.push(request.action);
      if (request.action === "water_slime_hutch_trough") {
        assert.deepEqual(request.args, {
          x: TROUGH_TARGET.x,
          y: TROUGH_TARGET.y,
          expectedTargetId: TROUGH_TARGET.targetId,
        });
        snapshot = baseSnapshot(6, { x: 17, y: 6 }, { slimeHutchTroughTargets: [] });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "water-trough-execution",
          state: "succeeded",
          reasonCode: "slime_hutch_trough_watered",
          revision: 6,
          evidence: { detail: WATER_EVIDENCE },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };

  const result = await runWaterSlimeHutchTroughSmoke(client, [], config);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "slime_hutch_trough_watered");
  assert.equal(result.receipt.reasonCode, "slime_hutch_trough_watered");
  assert.equal(result.preciseWaterDelta, true);
  assert.equal(result.sourceTargetGone, true);
  assert.equal(result.freshPostcondition, true);
  assert.deepEqual(calls, ["water_slime_hutch_trough"]);
});

test("water-slime-hutch-trough runner fails closed when the trough target is absent and unreachable", async () => {
  // The fixture precondition is missing: no trough target is advertised, so the
  // runner must search for an approach and refuse to submit the action.
  let snapshot = baseSnapshot(5, { x: 17, y: 6 }, { slimeHutchTroughTargets: [] });
  const submitted = [];
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      if (request.action === "water_slime_hutch_trough") {
        submitted.push(request.action);
        throw new Error("water_slime_hutch_trough_must_not_be_submitted_without_a_target");
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

  const result = await runWaterSlimeHutchTroughSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /no_reachable_native_water_slime_hutch_trough_fixture_target/);
  assert.deepEqual(submitted, [], "the action must never be submitted without a live target");
});

test("water-slime-hutch-trough runner does not claim success when the native postcondition is absent", async () => {
  let snapshot = baseSnapshot(5, { x: 17, y: 6 }, { slimeHutchTroughTargets: [{ ...TROUGH_TARGET }] });
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      if (request.action === "water_slime_hutch_trough") {
        // The native postcondition did not hold: the receipt is `uncertain`, not
        // `succeeded`. The snapshot still retires the target (the Mod stopped
        // advertising it) so the reread stabilizes and the ONLY reason the
        // runner must refuse success is the terminal state itself.
        snapshot = baseSnapshot(6, { x: 17, y: 6 }, { slimeHutchTroughTargets: [] });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "water-trough-execution",
          state: "uncertain",
          reasonCode: "slime_hutch_trough_water_postcondition_unavailable",
          revision: 6,
          evidence: {
            detail:
              "after_watered=false;before_watered=false;expected_stamina_cost=2;location=Slime Hutch;native_menu_opened=false;stamina_after=100;stamina_before=100;stamina_delta=0;target=slime_hutch_trough_0000000000000001;tile=16,6;water_after=40;water_before=40;water_consumed=false",
          },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };

  const result = await runWaterSlimeHutchTroughSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "water_slime_hutch_trough_postcondition_mismatch");
});

test("water-slime-hutch-trough runner rejects a scenario or action set it is not authorized for", async () => {
  const client = { state: {}, observe: async () => baseSnapshot(1, { x: 17, y: 6 }, {}) };
  const wrongScenario = {
    ...config,
    NativeLocalPlayerFixture: { ...config.NativeLocalPlayerFixture, FixtureScenario: "native_water_pet_bowl_v1" },
  };
  await assert.rejects(
    () => runWaterSlimeHutchTroughSmoke(client, [], wrongScenario),
    /native_local_water_slime_hutch_trough_scenario_invalid/,
  );

  const wrongActions = { ...config, EnabledActions: ["move_to_tile", "travel", "equip_tool", "water_pet_bowl"] };
  await assert.rejects(
    () => runWaterSlimeHutchTroughSmoke(client, [], wrongActions),
    /native_local_water_slime_hutch_trough_action_set_invalid/,
  );
});
