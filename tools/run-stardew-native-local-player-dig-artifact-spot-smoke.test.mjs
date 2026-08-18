import assert from "node:assert/strict";
import test from "node:test";
import { runDigArtifactSpotSmoke } from "./run-stardew-native-local-player-dig-artifact-spot-smoke.mjs";

const ARTIFACT_TARGET = {
  targetId: "artifact_0000000000000001",
  location: "Farm",
  x: 3,
  y: 3,
  qualifiedItemId: "(O)590",
};

const config = {
  SaveId: "save",
  WorldId: "world",
  PlayerId: "player",
  CompanionId: "companion",
  PipeName: "pipe",
  BridgeToken: "token",
  ActionPolicyVersion: 0,
  EnabledActions: ["move_to_tile", "travel", "equip_tool", "dig_artifact_spot"],
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: "native_dig_artifact_spot_v1",
  },
};

const CAPABILITIES = [
  "cancel_active_execution",
  "dig_artifact_spot",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "travel",
];

function baseSnapshot(revision, extra) {
  return {
    revision,
    location: "Farm",
    tile: { x: 1, y: 1 },
    actionable: true,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    toolSlots: [{ slot: 0, label: "(T)Hoe" }],
    artifactSpotTargets: [{ ...ARTIFACT_TARGET }],
    artifactSpotResultTargets: [],
    artifactSpotFarmSourceCount: 2,
    ...extra,
  };
}

function terminalEvidence(detailOverrides) {
  return {
    detail:
      "location=Farm;target=artifact_0000000000000001;result_target=artifact_0000000000000001;tile=3,3;tool=hoe;slot=0;stamina_before=268;stamina_after=267;stamina_delta=-1;expected_stamina_cost=1;qualified_item_id=(O)590;source_present_before=true;source_present_after=false;hoedirt_present_before=false;hoedirt_present_after=true;source_removed=true",
    ...detailOverrides,
  };
}

test("dig-artifact-spot runner uses shared dispatch and exact terminal receipt", async () => {
  let snapshot = baseSnapshot(5);
  const calls = [];
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      calls.push(request.action);
      if (request.action === "equip_tool") {
        assert.deepEqual(request.args, { slot: 0 });
        snapshot = baseSnapshot(6);
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "equip-execution",
          state: "succeeded",
          reasonCode: "tool_selected",
          revision: 6,
          evidence: { detail: "slot=0;before=Axe;expected=(T)Hoe;after=(T)Hoe" },
        };
      }
      if (request.action === "dig_artifact_spot") {
        assert.deepEqual(request.args, { slot: 0, x: 3, y: 3, expectedTargetId: ARTIFACT_TARGET.targetId });
        assert.equal(request.expectedRevision, 6);
        snapshot = baseSnapshot(7, {
          artifactSpotTargets: [],
          artifactSpotResultTargets: [
            { targetId: ARTIFACT_TARGET.targetId, location: "Farm", x: 3, y: 3, crop: false, ground: true },
          ],
          artifactSpotFarmSourceCount: 1,
        });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "dig-execution",
          state: "succeeded",
          reasonCode: "artifact_spot_dug",
          revision: 7,
          evidence: terminalEvidence(),
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };

  const result = await runDigArtifactSpotSmoke(client, [], config);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "artifact_spot_dug");
  assert.equal(result.receipt.reasonCode, "artifact_spot_dug");
  assert.equal(result.receipt.executionId, "dig-execution");
  assert.deepEqual(result.target, ARTIFACT_TARGET);
  assert.equal(result.after.artifactSpotFarmSourceCount, 1);
  assert.deepEqual(calls, ["equip_tool", "dig_artifact_spot"]);
});

test("dig-artifact-spot runner fails closed when the fresh target changes after equip", async () => {
  let snapshot = baseSnapshot(5);
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      if (request.action === "equip_tool") {
        // The fresh snapshot after equip no longer publishes the chosen target.
        snapshot = baseSnapshot(6, { artifactSpotTargets: [] });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "equip-execution",
          state: "succeeded",
          reasonCode: "tool_selected",
          revision: 6,
          evidence: { detail: "slot=0;before=Axe;expected=(T)Hoe;after=(T)Hoe" },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };

  const result = await runDigArtifactSpotSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "dig_artifact_spot_target_changed_after_equip");
});

test("dig-artifact-spot runner fails closed on stamina evidence mismatch", async () => {
  let snapshot = baseSnapshot(5);
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      if (request.action === "equip_tool") {
        snapshot = baseSnapshot(6);
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "equip-execution",
          state: "succeeded",
          reasonCode: "tool_selected",
          revision: 6,
          evidence: { detail: "slot=0;before=Axe;expected=(T)Hoe;after=(T)Hoe" },
        };
      }
      if (request.action === "dig_artifact_spot") {
        snapshot = baseSnapshot(7, {
          artifactSpotTargets: [],
          artifactSpotResultTargets: [
            { targetId: ARTIFACT_TARGET.targetId, location: "Farm", x: 3, y: 3, crop: false, ground: true },
          ],
          artifactSpotFarmSourceCount: 1,
        });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "dig-execution",
          state: "succeeded",
          reasonCode: "artifact_spot_dug",
          revision: 7,
          // stamina_delta -2 does not match expected_stamina_cost 1 within the epsilon.
          evidence: terminalEvidence({ detail: terminalEvidence().detail.replace("stamina_delta=-1", "stamina_delta=-2") }),
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };

  const result = await runDigArtifactSpotSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "dig_artifact_spot_postcondition_mismatch");
});
