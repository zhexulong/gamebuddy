import assert from "node:assert/strict";
import test from "node:test";

import { runFertilizeTileSmoke } from "./run-stardew-native-local-player-fertilize-tile-smoke.mjs";
import { runHarvestCropSmoke } from "./run-stardew-native-local-player-harvest-crop-smoke.mjs";
import { runPlantSeedSmoke } from "./run-stardew-native-local-player-plant-seed-smoke.mjs";

function actionClient(initialSnapshot, transition) {
  const receipts = [];
  const state = { snapshot: initialSnapshot, capabilities: initialSnapshot.capabilities };
  return {
    client: {
      state,
      observe: async () => state.snapshot,
      execute: async (request) => {
        const { snapshot, terminal } = transition(request);
        state.snapshot = snapshot;
        const accepted = {
          requestId: request.requestId,
          executionId: `${request.action}-execution`,
          state: "accepted",
          reasonCode: "accepted",
          revision: terminal.revision,
        };
        receipts.push(accepted, { ...accepted, ...terminal });
        return accepted;
      },
    },
    receipts,
  };
}

function nativeFixtureConfig(scenario, enabledActions = undefined) {
  return {
    SaveId: "save",
    WorldId: "world",
    PlayerId: "player",
    CompanionId: "companion",
    NativeLocalPlayerFixture: {
      Enable: true,
      FixtureScenario: scenario,
      LogicalSaveName: "GameBuddyFixtureCrop",
      ObservedSaveSlot: "GameBuddyFixtureCrop_1",
    },
    ...(enabledActions === undefined ? {} : { ActionPolicyVersion: 0, EnabledActions: enabledActions }),
  };
}

test("fertilize runner uses the shared receipt and fresh-reread mechanics", async () => {
  const capabilities = ["cancel_active_execution", "fertilize_tile", "inspect_self", "move_to_tile", "travel"];
  const target = { slot: 1, x: 2, y: 1, targetId: "fertilizer-target", qualifiedItemId: "(O)369" };
  const { client, receipts } = actionClient(
    {
      revision: 1,
      location: "Farm",
      tile: { x: 1, y: 1 },
      actionable: true,
      activeExecution: null,
      capabilities,
      fertilizerTargets: [target],
    },
    (request) => {
      assert.equal(request.action, "fertilize_tile");
      assert.deepEqual(request.args, {
        slot: target.slot,
        x: target.x,
        y: target.y,
        expectedQualifiedItemId: target.qualifiedItemId,
        expectedTargetId: target.targetId,
      });
      return {
        snapshot: {
          revision: 2,
          location: "Farm",
          tile: { x: 1, y: 1 },
          actionable: true,
          activeExecution: null,
          capabilities,
          fertilizerTargets: [],
        },
        terminal: {
          state: "succeeded",
          reasonCode: "fertilizer_applied",
          revision: 2,
          evidence: {
            detail:
              "location=Farm;target=fertilizer-target;tile=2,1;item=(O)369;fertilizer_before=none;fertilizer_after=(O)369;inventory_before=2;inventory_after=1",
          },
        },
      };
    },
  );
  const result = await runFertilizeTileSmoke(client, receipts, nativeFixtureConfig("native_fertilize_tile_v1"));
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "fertilizer_applied");
});

test("plant runner retains typed target and evidence validation with shared mechanics", async () => {
  const capabilities = ["cancel_active_execution", "inspect_self", "move_to_tile", "plant_seed", "travel"];
  const target = { slot: 2, x: 2, y: 1, targetId: "seed-target", qualifiedItemId: "(O)472" };
  const { client, receipts } = actionClient(
    {
      revision: 1,
      location: "Farm",
      tile: { x: 1, y: 1 },
      actionable: true,
      activeExecution: null,
      capabilities,
      seedTargets: [target],
    },
    (request) => {
      assert.equal(request.action, "plant_seed");
      assert.equal(request.args.expectedTargetId, target.targetId);
      return {
        snapshot: {
          revision: 2,
          location: "Farm",
          tile: { x: 1, y: 1 },
          actionable: true,
          activeExecution: null,
          capabilities,
          seedTargets: [],
        },
        terminal: {
          state: "succeeded",
          reasonCode: "seed_planted",
          revision: 2,
          evidence: {
            detail:
              "crop=24;inventory_after=1;inventory_before=2;item=(O)472;location=Farm;target=seed-target;tile=2,1",
          },
        },
      };
    },
  );
  const result = await runPlantSeedSmoke(
    client,
    receipts,
    nativeFixtureConfig("native_plant_seed_v1", ["move_to_tile", "travel", "plant_seed"]),
  );
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "seed_planted");
});

test("harvest runner retains target-specific postcondition with shared mechanics", async () => {
  const capabilities = ["cancel_active_execution", "harvest_crop", "inspect_self", "move_to_tile", "travel"];
  const target = {
    x: 2,
    y: 1,
    targetId: "harvest-target",
    qualifiedHarvestItemId: "(O)24",
    cropId: "24",
    regrowsAfterHarvest: false,
  };
  const { client, receipts } = actionClient(
    {
      revision: 1,
      location: "Farm",
      tile: { x: 1, y: 1 },
      actionable: true,
      activeExecution: null,
      capabilities,
      warps: [],
      harvestTargets: [target],
      currentTool: null,
    },
    (request) => {
      assert.equal(request.action, "harvest_crop");
      assert.equal(request.args.expectedTargetId, target.targetId);
      return {
        snapshot: {
          revision: 2,
          location: "Farm",
          tile: { x: 1, y: 1 },
          actionable: true,
          activeExecution: null,
          capabilities,
          warps: [],
          harvestTargets: [],
          currentTool: null,
        },
        terminal: {
          state: "succeeded",
          reasonCode: "crop_harvested",
          revision: 2,
          evidence: {
            detail:
              "target=harvest-target;item=(O)24;regrows=false;native_accepted=true;inventory_gained=true;inventory_before=1;inventory_after=2;crop_present_after=false",
          },
        },
      };
    },
  );
  const result = await runHarvestCropSmoke(client, receipts, nativeFixtureConfig("native_harvest_crop_v1"));
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "crop_harvested");
});
