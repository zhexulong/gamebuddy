import assert from "node:assert/strict";
import test from "node:test";
import { runBaitCrabPotSmoke } from "./run-stardew-native-local-player-bait-crab-pot-smoke.mjs";

const target = {
  targetId: "bait-target",
  x: 2,
  y: 1,
  slot: 4,
  location: "Farm",
  qualifiedItemId: "(O)710",
  baitQualifiedItemId: "(O)685",
  baitStack: 1,
  ownerId: "owner",
};

const config = {
  EnabledActions: ["bait_crab_pot"],
  SaveId: "save",
  WorldId: "world",
  PlayerId: "player",
  CompanionId: "companion",
  PipeName: "pipe",
  BridgeToken: "token",
};

test("bait-crab-pot runner uses shared dispatch and fresh result reread", async () => {
  let snapshot = {
    revision: 1,
    location: "Farm",
    tile: { x: 1, y: 1 },
    actionable: true,
    activeExecution: null,
    capabilities: ["cancel_active_execution", "bait_crab_pot"],
    baitCrabPotTargets: [target],
    baitCrabPotResultTargets: [],
  };
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      assert.equal(request.action, "bait_crab_pot");
      assert.equal(request.expectedRevision, 1);
      assert.deepEqual(request.args, {
        slot: 4,
        x: 2,
        y: 1,
        expectedQualifiedItemId: "(O)685",
        expectedTargetId: "bait-target",
      });
      snapshot = {
        ...snapshot,
        revision: 2,
        baitCrabPotTargets: [],
        baitCrabPotResultTargets: [target],
      };
      client.state.snapshot = snapshot;
      return {
        requestId: request.requestId,
        executionId: "bait-execution",
        state: "succeeded",
        reasonCode: "crab_pot_baited",
        revision: 2,
        evidence: {
          detail:
            "source=(O)685;pot=(O)710;bait_before=none;bait_after=(O)685;x=2;y=1;target=bait-target;slot=4;inventory_before=1;inventory_after=0;owner=owner",
        },
      };
    },
  };

  const result = await runBaitCrabPotSmoke(client, config);
  assert.equal(result.state, "passed");
  assert.equal(result.receipt.reasonCode, "crab_pot_baited");
  assert.equal(result.result.targetId, "bait-target");
});
