import assert from "node:assert/strict";
import test from "node:test";
import { runPickupItemSmoke } from "./run-stardew-native-local-player-pickup-item-smoke.mjs";

const CAPABILITIES = ["cancel_active_execution", "inspect_self", "move_to_tile", "travel", "pickup_item"];
const TARGET = { x: 5, y: 5, targetId: "target-1", qualifiedItemId: "(O)128", stack: 2 };
const PICKUP_EVIDENCE = [
  "location=Farm",
  "target=target-1",
  "tile=5,5",
  "item=(O)128",
  "stack=2",
  "native_auto_collect=true",
  "chunk_removed=true",
  "inventory_before=10",
  "inventory_after=12",
].join(";");

function fixtureConfig(overrides = {}) {
  return {
    NativeLocalPlayerFixture: {
      Enable: true,
      FixtureScenario: "native_pickup_item_v1",
      LogicalSaveName: "GameBuddyFixtureA",
      ObservedSaveSlot: "GameBuddyFixtureA_1",
    },
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    ...overrides,
  };
}

function pickupSnapshot(location, tile, revision, itemTargets, capabilities = CAPABILITIES) {
  return {
    revision,
    location,
    tile,
    actionable: true,
    activeExecution: null,
    capabilities,
    warps: [{ sourceX: 1, sourceY: 2, targetLocation: "Farm", targetX: 3, targetY: 4 }],
    itemTargets,
  };
}

function createFake({
  tile: initialTile = { x: 2, y: 2 },
  location: initialLocation = "Farm",
  itemTargets: initialTargets = [TARGET],
  capabilities = CAPABILITIES,
  pickupEvidence = PICKUP_EVIDENCE,
} = {}) {
  const listeners = new Set();
  let revision = 7;
  let tile = initialTile;
  let location = initialLocation;
  let itemTargets = initialTargets;
  const snapshotOf = () => pickupSnapshot(location, tile, revision, itemTargets, capabilities);
  const publish = (payload) => {
    for (const listener of listeners) listener({ type: "execution_receipt", payload });
  };
  const client = {
    state: { snapshot: snapshotOf() },
    observe: async () => {
      const snapshot = snapshotOf();
      client.state.snapshot = snapshot;
      return snapshot;
    },
    execute: async ({ requestId, action, args }) => {
      const executionId = `execution-${action}`;
      if (action === "move_to_tile") {
        revision += 1;
        const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
        publish(receipt);
        tile = { x: args.x, y: args.y };
        publish({ ...receipt, state: "succeeded", reasonCode: "target_reached", revision });
        return receipt;
      }
      if (action === "travel") {
        revision += 1;
        const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
        publish(receipt);
        location = "Farm";
        tile = { x: 3, y: 4 };
        publish({ ...receipt, state: "succeeded", reasonCode: "travel_completed", revision });
        return receipt;
      }
      if (action === "pickup_item") {
        revision += 1;
        const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
        publish(receipt);
        itemTargets = [];
        publish({
          ...receipt,
          state: "succeeded",
          reasonCode: "item_picked_up",
          revision,
          evidence: { detail: pickupEvidence },
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
  return client;
}

test("pickup item runner passes on Farm with one fresh live target", async () => {
  const client = createFake();
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runPickupItemSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "item_picked_up");
  assert.equal(result.receipt.reasonCode, "item_picked_up");
  assert.deepEqual(result.trace.map((entry) => entry.action), ["pickup_item"]);
  assert.equal(result.before.location, "Farm");
  assert.deepEqual(result.after.itemTargets, []);
  assert.equal(result.inventoryDelta, 2);
  assert.equal(result.targetGone, true);
});

test("pickup item runner travels from FarmHouse before picking up", async () => {
  const client = createFake({ tile: { x: 6, y: 6 }, location: "FarmHouse" });
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runPickupItemSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "item_picked_up");
  assert.deepEqual(result.trace.map((entry) => entry.action), ["move_to_tile", "travel", "pickup_item"]);
  assert.equal(result.after.location, "Farm");
});

test("pickup item runner blocks on a non-isolated capability surface", async () => {
  const client = createFake({ capabilities: ["cancel_active_execution", "inspect_self", "move_to_tile", "travel"] });
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runPickupItemSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "native_capability_surface_mismatch");
  assert.equal(result.trace.length, 0);
});

test("pickup item runner blocks without a fresh live item target", async () => {
  const client = createFake({ itemTargets: [] });
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runPickupItemSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "no_fresh_live_item_target");
  assert.equal(result.trace.length, 0);
});

test("pickup item runner blocks on an evidence postcondition mismatch", async () => {
  const client = createFake({ pickupEvidence: PICKUP_EVIDENCE.replace("inventory_after=12", "inventory_after=10") });
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runPickupItemSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "pickup_item_postcondition_mismatch");
  assert.equal(result.trace.length, 1);
});

test("pickup item runner rejects a non-isolated topology", async () => {
  const client = createFake();
  await assert.rejects(
    runPickupItemSmoke(client, [], fixtureConfig({ Portfolio: { Enable: true } })),
    (error) => error?.message === "native_local_fixture_topology_not_isolated",
  );
});
