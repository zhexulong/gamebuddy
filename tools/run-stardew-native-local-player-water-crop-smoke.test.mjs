import assert from "node:assert/strict";
import test from "node:test";
import { runWaterCropSmoke } from "./run-stardew-native-local-player-water-crop-smoke.mjs";

const CROP_TARGET = {
  targetId: "crop_0000000000000001",
  x: 2,
  y: 1,
  cropId: "(O)472",
};

const config = {
  SaveId: "save",
  WorldId: "world",
  PlayerId: "player",
  CompanionId: "companion",
  PipeName: "pipe",
  BridgeToken: "token",
  ActionPolicyVersion: 0,
  EnabledActions: ["move_to_tile", "travel", "equip_tool", "water_crop"],
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: "native_water_crop_v1",
    LogicalSaveName: "GameBuddyFixtureWater",
    ObservedSaveSlot: "GameBuddyFixtureWater_1",
  },
};

const CAPABILITIES = ["cancel_active_execution", "equip_tool", "inspect_self", "move_to_tile", "travel", "water_crop"];

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
    currentTool: "Axe",
    cropTargets: [],
    ...extra,
  };
}

test("water-crop runner uses shared dispatch and stable fresh postcondition", async () => {
  let snapshot = baseSnapshot(5, { x: 1, y: 1 }, { cropTargets: [{ ...CROP_TARGET }] });
  let tool = "Axe";
  const calls = [];
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      calls.push(request.action);
      if (request.action === "equip_tool") {
        tool = "Watering Can";
        snapshot = baseSnapshot(6, { x: 1, y: 1 }, { cropTargets: [{ ...CROP_TARGET }], currentTool: tool });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "equip-execution",
          state: "succeeded",
          reasonCode: "tool_selected",
          revision: 6,
          evidence: { detail: "slot=1;before=Axe;expected=Watering Can;after=Watering Can" },
        };
      }
      if (request.action === "water_crop") {
        assert.deepEqual(request.args, { x: 2, y: 1, expectedTargetId: CROP_TARGET.targetId });
        assert.equal(request.expectedRevision, 6);
        snapshot = baseSnapshot(7, { x: 1, y: 1 }, { cropTargets: [], currentTool: tool });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "water-execution",
          state: "succeeded",
          reasonCode: "crop_watered",
          revision: 7,
          evidence: {
            detail:
              "after_watered=true;before_watered=false;location=Farm;target=crop_0000000000000001;tile=2,1;water_after=39;water_before=40;water_consumed=true",
          },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };

  const result = await runWaterCropSmoke(client, [], config);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "crop_watered");
  assert.equal(result.receipt.reasonCode, "crop_watered");
  assert.equal(result.preciseWaterDelta, true);
  assert.equal(result.sourceTargetGone, true);
  assert.deepEqual(calls, ["equip_tool", "water_crop"]);
});

test("water-crop runner fails closed on a stale post-terminal revision", async () => {
  let snapshot = baseSnapshot(5, { x: 1, y: 1 }, { cropTargets: [{ ...CROP_TARGET }] });
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      if (request.action === "equip_tool") {
        snapshot = baseSnapshot(6, { x: 1, y: 1 }, { cropTargets: [{ ...CROP_TARGET }], currentTool: "Watering Can" });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "equip-execution",
          state: "succeeded",
          reasonCode: "tool_selected",
          revision: 6,
          evidence: { detail: "slot=1;before=Axe;expected=Watering Can;after=Watering Can" },
        };
      }
      if (request.action === "water_crop") {
        // The observe immediately after this terminal advances past the
        // terminal revision, which must fail the stable reread closed.
        snapshot = baseSnapshot(8, { x: 1, y: 1 }, { cropTargets: [], currentTool: "Watering Can" });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "water-execution",
          state: "succeeded",
          reasonCode: "crop_watered",
          revision: 7,
          evidence: {
            detail:
              "after_watered=true;before_watered=false;location=Farm;target=crop_0000000000000001;tile=2,1;water_after=39;water_before=40;water_consumed=true",
          },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };

  const result = await runWaterCropSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /native_post_terminal_revision_mismatch/);
});
