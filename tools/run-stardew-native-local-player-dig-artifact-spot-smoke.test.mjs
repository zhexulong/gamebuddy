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
  // The fixture writes a deny-by-exception policy; `ActionPolicyVersion` and
  // `EnabledActions` no longer exist, and asserting them made this runner reject
  // every real fixture config.
  DeniedActions: [],
  DeniedActionFamilies: [],
  ExperimentalActions: [],
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
        assert.deepEqual(request.args, { tool: "hoe" });
        snapshot = baseSnapshot(6);
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "equip-execution",
          state: "succeeded",
          reasonCode: "tool_equipped",
          revision: 6,
          evidence: { detail: "tool=hoe;before=Axe;expected=(T)Hoe;after=(T)Hoe" },
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
  // `summarizeReceipt` publishes only state/reasonCode/revision/hasEvidence, so the
  // execution identity is deliberately not part of the action result. Asserting it
  // here could never pass; the per-phase identity lives in the runner's own trace.
  assert.equal(result.receipt.reasonCode, "artifact_spot_dug");
  assert.equal(result.receipt.hasEvidence, true);
  assert.deepEqual(
    result.trace.map((entry) => entry.phase),
    ["equip_hoe", "dig_artifact_spot"],
  );
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
          reasonCode: "tool_equipped",
          revision: 6,
          evidence: { detail: "tool=hoe;before=Axe;expected=(T)Hoe;after=(T)Hoe" },
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
          reasonCode: "tool_equipped",
          revision: 6,
          evidence: { detail: "tool=hoe;before=Axe;expected=(T)Hoe;after=(T)Hoe" },
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
          // The delta does not match the expected cost.
          evidence: terminalEvidence({
            detail:
              "location=Farm;target=artifact_0000000000000001;result_target=artifact_0000000000000001;tile=3,3;tool=hoe;slot=0;stamina_before=268;stamina_after=200;stamina_delta=-68;expected_stamina_cost=1;qualified_item_id=(O)590;source_present_before=true;source_present_after=false;hoedirt_present_before=false;hoedirt_present_after=true;source_removed=true",
          }),
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };

  const result = await runDigArtifactSpotSmoke(client, [], config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "dig_artifact_spot_postcondition_mismatch");
});

// The engine spawns `(O)590` and `(O)SeedSpot` through one `t is Hoe` dig branch
// (Object.cs:1310), and every spawn site picks between them at random
// (GameLocation.cs:15233 at 1/6). A runner that accepted only `(O)590` would keep
// passing even if the Mod regressed to a single-id predicate, so this case drives
// the variant end to end and asserts the receipt reports the id that was dug.
test("dig-artifact-spot runner completes for the (O)SeedSpot variant", async () => {
  const seedSpotTarget = { ...ARTIFACT_TARGET, targetId: "artifact_seedspot0000001", qualifiedItemId: "(O)SeedSpot" };
  let snapshot = baseSnapshot(5, { artifactSpotTargets: [seedSpotTarget] });
  let digArgs = null;
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      if (request.action === "equip_tool") {
        snapshot = baseSnapshot(6, { artifactSpotTargets: [seedSpotTarget] });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "equip-execution-seed",
          state: "succeeded",
          reasonCode: "tool_equipped",
          revision: 6,
          evidence: { detail: "tool=hoe;before=Axe;expected=(T)Hoe;after=(T)Hoe" },
        };
      }
      if (request.action === "dig_artifact_spot") {
        digArgs = request.args;
        snapshot = baseSnapshot(7, {
          artifactSpotTargets: [],
          artifactSpotResultTargets: [
            { targetId: seedSpotTarget.targetId, location: "Farm", x: 3, y: 3, crop: false, ground: true },
          ],
          artifactSpotFarmSourceCount: 1,
        });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "dig-execution-seed",
          state: "succeeded",
          reasonCode: "artifact_spot_dug",
          revision: 7,
          evidence: terminalEvidence({
            detail:
              "location=Farm;target=artifact_seedspot0000001;result_target=artifact_seedspot0000001;tile=3,3;tool=hoe;slot=0;stamina_before=268;stamina_after=267;stamina_delta=-1;expected_stamina_cost=1;qualified_item_id=(O)SeedSpot;source_present_before=true;source_present_after=false;hoedirt_present_before=false;hoedirt_present_after=true;source_removed=true",
          }),
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };

  const result = await runDigArtifactSpotSmoke(client, [], config);

  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "artifact_spot_dug");
  assert.equal(result.target.qualifiedItemId, "(O)SeedSpot");
  assert.equal(digArgs?.expectedTargetId, seedSpotTarget.targetId);
  assert.equal(result.evidence.qualified_item_id, "(O)SeedSpot");
});

// A receipt naming a different id than the requested target must not pass: the id is
// the evidence that the variant-aware predicate resolved the live object rather than
// a neighbouring id that happens to be diggable too.
test("dig-artifact-spot runner fails closed when the receipt reports another id", async () => {
  const seedSpotTarget = { ...ARTIFACT_TARGET, targetId: "artifact_seedspot0000002", qualifiedItemId: "(O)SeedSpot" };
  let snapshot = baseSnapshot(5, { artifactSpotTargets: [seedSpotTarget] });
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      if (request.action === "equip_tool") {
        snapshot = baseSnapshot(6, { artifactSpotTargets: [seedSpotTarget] });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "equip-execution-mismatch",
          state: "succeeded",
          reasonCode: "tool_equipped",
          revision: 6,
          evidence: { detail: "tool=hoe;before=Axe;expected=(T)Hoe;after=(T)Hoe" },
        };
      }
      if (request.action === "dig_artifact_spot") {
        snapshot = baseSnapshot(7, {
          artifactSpotTargets: [],
          artifactSpotResultTargets: [
            { targetId: seedSpotTarget.targetId, location: "Farm", x: 3, y: 3, crop: false, ground: true },
          ],
          artifactSpotFarmSourceCount: 1,
        });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId: "dig-execution-mismatch",
          state: "succeeded",
          reasonCode: "artifact_spot_dug",
          revision: 7,
          // Reports `(O)590` while the requested target was `(O)SeedSpot`.
          evidence: terminalEvidence(),
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };

  const result = await runDigArtifactSpotSmoke(client, [], config);

  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "dig_artifact_spot_postcondition_mismatch");
});
