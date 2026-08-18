import assert from "node:assert/strict";
import test from "node:test";
import { runChopTreeSourceSmoke } from "./run-stardew-native-local-player-chop-tree-source-smoke.mjs";

const CAPABILITIES = [
  "cancel_active_execution",
  "chop_tree_source",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "travel",
];

function fixtureConfig(overrides = {}) {
  return {
    NativeLocalPlayerFixture: {
      Enable: true,
      FixtureScenario: "native_chop_tree_source_v1",
      LogicalSaveName: "GameBuddyFixture",
      ObservedSaveSlot: "GameBuddyFixture_445094166",
    },
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    ActionPolicyVersion: 0,
    EnabledActions: ["move_to_tile", "travel", "equip_tool", "chop_tree_source"],
    ...overrides,
  };
}

function createFake({ startAtFarmHouse = true } = {}) {
  const listeners = new Set();
  let revision = 7;
  let location = startAtFarmHouse ? "FarmHouse" : "Farm";
  let tile = startAtFarmHouse ? { x: 1, y: 1 } : { x: 5, y: 5 };
  let chopped = false;
  const warps = [{ sourceX: 1, sourceY: 1, targetX: 5, targetY: 5, targetLocation: "Farm" }];
  const snapshotOf = () => ({
    revision,
    location,
    tile,
    actionable: true,
    activeExecution: null,
    capabilities: CAPABILITIES,
    toolSlots: [{ label: "(T)Axe", slot: 3 }],
    warps,
    treeChopSourceTargets:
      location === "Farm" && !chopped
        ? [
            {
              targetId: "tree-1",
              x: 5,
              y: 6,
              location: "Farm",
              treeType: "Oak",
              growthStage: 5,
              health: 1,
              stump: false,
              moss: false,
              tapped: false,
            },
          ]
        : [],
    treeChopResultTargets: chopped
      ? [
          {
            targetId: "tree-1",
            x: 5,
            y: 6,
            location: "Farm",
            treeType: "Oak",
            health: 5,
            stump: true,
            moss: false,
            tapped: false,
          },
        ]
      : [],
  });
  const client = {
    state: { snapshot: snapshotOf() },
    observe: async () => {
      const snapshot = snapshotOf();
      client.state.snapshot = snapshot;
      return snapshot;
    },
    execute: async ({ requestId, action, args }) => {
      const executionId = `execution-${action}-${revision}`;
      if (action === "travel") {
        revision += 1;
        const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
        publish(receipt);
        location = "Farm";
        tile = { x: 5, y: 5 };
        revision += 1;
        publish({ ...receipt, state: "succeeded", reasonCode: "travel_completed", revision });
        return receipt;
      }
      if (action === "equip_tool") {
        revision += 1;
        return { requestId, executionId, state: "succeeded", reasonCode: "tool_selected", revision };
      }
      if (action === "chop_tree_source") {
        revision += 1;
        const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
        publish(receipt);
        chopped = true;
        revision += 1;
        publish({
          ...receipt,
          state: "succeeded",
          reasonCode: "tree_source_chopped",
          revision,
          evidence: {
            detail: `target=${args.expectedTargetId};tool=axe;slot=${args.slot};health_before=1;health_after=5;stump_before=false;stump_after=true;source_transformed=true`,
          },
        });
        return receipt;
      }
      throw new Error(`unexpected_action:${action}`);
    },
    onFact: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const publish = (payload) => {
    for (const listener of listeners) listener({ type: "execution_receipt", payload });
  };
  return client;
}

test("chop-tree-source runner passes after FarmHouse travel, axe equip, and terminal tree chop", async () => {
  const client = createFake();
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runChopTreeSourceSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "tree_source_chopped");
  assert.equal(result.target.targetId, "tree-1");
  assert.equal(result.receipt.reasonCode, "tree_source_chopped");
  assert.equal(result.evidence.health_before, "1");
  assert.equal(result.evidence.health_after, "5");
  assert.equal(result.evidence.source_transformed, "true");
  assert.equal(result.after.treeChopSourceTargets, 0);
  assert.equal(result.after.treeChopResultTargets, 1);
  assert.equal(result.after.revision, result.receipt.revision);
});

test("chop-tree-source runner rejects a non-isolated action policy", async () => {
  const client = createFake();
  await assert.rejects(
    runChopTreeSourceSmoke(client, [], fixtureConfig({ EnabledActions: ["chop_tree_source"] })),
    (error) => error?.message === "native_local_chop_tree_source_action_policy_invalid",
  );
});

test("chop-tree-source runner blocks when the session does not start at FarmHouse", async () => {
  const client = createFake({ startAtFarmHouse: false });
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runChopTreeSourceSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "chop_tree_source_route_must_start_at_farmhouse");
});
