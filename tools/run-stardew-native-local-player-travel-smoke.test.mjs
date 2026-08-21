import assert from "node:assert/strict";
import test from "node:test";
import { runTravelSmoke } from "./run-stardew-native-local-player-travel-smoke.mjs";

const CAPABILITIES = ["cancel_active_execution", "inspect_self", "move_to_tile", "travel"];

function fixtureConfig(overrides = {}) {
  return {
    NativeLocalPlayerFixture: { Enable: true },
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    ...overrides,
  };
}

function warpSnapshot(location, tile, revision, capabilities = CAPABILITIES) {
  return {
    revision,
    location,
    tile,
    actionable: true,
    activeExecution: null,
    capabilities,
    warps: [{ sourceX: 1, sourceY: 2, targetLocation: "Farm", targetX: 3, targetY: 4 }],
  };
}

function createFake({
  tile: initialTile = { x: 2, y: 2 },
  location: initialLocation = "FarmHouse",
  capabilities = CAPABILITIES,
} = {}) {
  const listeners = new Set();
  let revision = 7;
  let tile = initialTile;
  let location = initialLocation;
  const snapshotOf = () => warpSnapshot(location, tile, revision, capabilities);
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

test("travel runner passes when already adjacent to the warp source", async () => {
  const client = createFake();
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runTravelSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "travel_completed");
  assert.equal(result.receipt.reasonCode, "travel_completed");
  assert.equal(result.before.location, "FarmHouse");
  assert.equal(result.after.location, "Farm");
  assert.deepEqual(result.after.tile, { x: 3, y: 4 });
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].action, "travel");
});

test("travel runner moves to the warp source before traveling", async () => {
  const client = createFake({ tile: { x: 6, y: 6 } });
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runTravelSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "travel_completed");
  assert.deepEqual(
    result.trace.map((entry) => entry.action),
    ["move_to_tile", "travel"],
  );
  assert.equal(result.after.location, "Farm");
  assert.deepEqual(result.after.tile, { x: 3, y: 4 });
});

test("travel runner blocks on a non-isolated capability surface", async () => {
  const client = createFake({ capabilities: ["cancel_active_execution", "inspect_self", "move_to_tile"] });
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runTravelSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "native_capability_surface_mismatch");
  assert.equal(result.trace.length, 0);
});

test("travel runner rejects a non-isolated topology", async () => {
  const client = createFake();
  await assert.rejects(
    runTravelSmoke(client, [], fixtureConfig({ Portfolio: { Enable: true } })),
    (error) => error?.message === "native_local_fixture_topology_not_isolated",
  );
});
