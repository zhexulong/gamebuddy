import assert from "node:assert/strict";
import test from "node:test";
import { runCollectAnimalProductSmoke } from "./run-stardew-native-local-player-collect-animal-product-smoke.mjs";

const target = {
  targetId: "animal_target_1",
  slot: 2,
  x: 3,
  y: 4,
  qualifiedProduceItemId: "(O)184",
  toolKind: "milk_pail",
  produceStack: 1,
};

const config = {
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: "native_collect_animal_product_v1",
  },
  ActionPolicyVersion: 0,
  EnabledActions: ["collect_animal_product"],
  SaveId: "save",
  WorldId: "world",
  PlayerId: "player",
  CompanionId: "companion",
  PipeName: "pipe",
  BridgeToken: "token",
};

test("collect-animal-product runner uses shared dispatch, exact terminal correlation, and fresh reread", async () => {
  let snapshot = {
    revision: 3,
    location: "Farm",
    tile: { x: 3, y: 4 },
    actionable: true,
    activeExecution: null,
    capabilities: ["cancel_active_execution", "collect_animal_product", "inspect_self"],
    animalProductTargets: [target],
    inventoryItemFacts: [{ qualifiedItemId: "(O)184", stack: 0 }],
  };
  const receipts = [];
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      assert.equal(request.action, "collect_animal_product");
      assert.equal(request.expectedRevision, 3);
      assert.deepEqual(request.args, { slot: 2, x: 3, y: 4, expectedTargetId: "animal_target_1" });
      snapshot = {
        ...snapshot,
        revision: 4,
        animalProductTargets: [],
        inventoryItemFacts: [{ qualifiedItemId: "(O)184", stack: 1 }],
      };
      client.state.snapshot = snapshot;
      const accepted = {
        requestId: request.requestId,
        executionId: "execution-1",
        state: "accepted",
        reasonCode: "accepted",
        revision: 4,
      };
      // A stale receipt for a different execution must never satisfy the wait.
      receipts.push({ ...accepted, executionId: "execution-stale", state: "succeeded" });
      receipts.push({
        ...accepted,
        state: "succeeded",
        reasonCode: "animal_product_collected",
        evidence: {
          detail:
            "target=animal_target_1;produce=(O)184;tool=milk_pail;produce_stack=1;produce_cleared=true;inventory_gained=true;animation_complete=true",
        },
      });
      return accepted;
    },
    onFact: () => () => {},
  };

  const result = await runCollectAnimalProductSmoke(client, receipts, config, {
    terminalTimeoutMs: 2_000,
    postconditionTimeoutMs: 2_000,
  });
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "animal_product_collected");
  assert.equal(result.receipt.executionId, "execution-1");
  assert.equal(result.inventory.before, 0);
  assert.equal(result.inventory.after, 1);
  assert.equal(result.after.animalProductTargets, 0);
});

test("collect-animal-product runner blocks on mismatched evidence", async () => {
  let snapshot = {
    revision: 3,
    location: "Farm",
    tile: { x: 3, y: 4 },
    actionable: true,
    activeExecution: null,
    capabilities: ["cancel_active_execution", "collect_animal_product", "inspect_self"],
    animalProductTargets: [target],
    inventoryItemFacts: [{ qualifiedItemId: "(O)184", stack: 0 }],
  };
  const receipts = [];
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      snapshot = {
        ...snapshot,
        revision: 4,
        animalProductTargets: [],
        inventoryItemFacts: [{ qualifiedItemId: "(O)184", stack: 1 }],
      };
      client.state.snapshot = snapshot;
      const accepted = {
        requestId: request.requestId,
        executionId: "execution-2",
        state: "accepted",
        reasonCode: "accepted",
        revision: 4,
      };
      receipts.push({
        ...accepted,
        state: "succeeded",
        reasonCode: "animal_product_collected",
        evidence: {
          detail: "target=other;produce=(O)999;tool=shears;produce_stack=2;produce_cleared=true;inventory_gained=true;animation_complete=true",
        },
      });
      return accepted;
    },
    onFact: () => () => {},
  };

  const result = await runCollectAnimalProductSmoke(client, receipts, config, {
    terminalTimeoutMs: 2_000,
    postconditionTimeoutMs: 2_000,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "collect_animal_product_postcondition_mismatch");
});
