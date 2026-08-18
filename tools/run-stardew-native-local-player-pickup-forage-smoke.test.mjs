import assert from "node:assert/strict";
import test from "node:test";
import { runPickupForageSmoke } from "./run-stardew-native-local-player-pickup-forage-smoke.mjs";

const CAPABILITIES = ["cancel_active_execution", "pickup_forage", "inspect_self", "move_to_tile", "travel"];

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

function createFake({
  location = "Farm",
  tile = { x: 3, y: 4 },
  capabilities = CAPABILITIES,
  forageTargets = [],
  warps = [],
  includeStaleReceipt = false,
  evidenceDetail,
} = {}) {
  const listeners = new Set();
  let revision = 3;
  let currentLocation = location;
  let currentTile = { ...tile };
  let targets = forageTargets.map((target) => ({ ...target }));
  const state = { latestReceipt: null };
  const snapshotOf = () => ({
    revision,
    location: currentLocation,
    tile: { ...currentTile },
    actionable: true,
    activeExecution: null,
    capabilities: [...capabilities],
    forageTargets: targets.map((target) => ({ ...target })),
    warps: warps.map((warp) => ({ ...warp })),
  });
  state.snapshot = snapshotOf();
  const publish = (payload) => {
    state.latestReceipt = payload;
    for (const listener of listeners) listener({ type: "execution_receipt", payload });
  };
  const client = {
    state,
    observe: async () => {
      state.snapshot = snapshotOf();
      return state.snapshot;
    },
    execute: async ({ requestId, action, args }) => {
      const accepted = {
        requestId,
        executionId: `execution-${action}-${revision + 1}`,
        state: "accepted",
        reasonCode: "accepted",
        revision: revision + 1,
      };
      if (action === "move_to_tile") {
        revision += 1;
        publish(accepted);
        currentTile = { x: args.x, y: args.y };
        publish({ ...accepted, state: "succeeded", reasonCode: "target_reached", revision });
        return accepted;
      }
      if (action === "travel") {
        revision += 1;
        publish(accepted);
        currentLocation = "Farm";
        currentTile = { x: warps[0]?.targetX ?? args.x, y: warps[0]?.targetY ?? args.y };
        publish({ ...accepted, state: "succeeded", reasonCode: "travel_completed", revision });
        return accepted;
      }
      if (action === "pickup_forage") {
        revision += 1;
        publish(accepted);
        const picked = targets.find((entry) => entry.targetId === args.expectedTargetId);
        if (!picked) throw new Error(`unknown_forage_target:${args.expectedTargetId}`);
        targets = targets.filter((entry) => entry.targetId !== picked.targetId);
        if (includeStaleReceipt)
          // A stale receipt for a different execution must never satisfy the wait.
          publish({ ...accepted, executionId: "execution-stale", state: "succeeded", reasonCode: "forage_picked_up" });
        publish({
          ...accepted,
          state: "succeeded",
          reasonCode: "forage_picked_up",
          revision,
          evidence: {
            detail:
              evidenceDetail ??
              `location=${currentLocation};target=${picked.x},${picked.y};item=${picked.qualifiedItemId};removed=True;inventory_before=0;inventory_after=${picked.stack}`,
          },
        });
        return accepted;
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

const OPTIONS = { moveTimeoutMs: 2_000, travelTimeoutMs: 2_000, forageTimeoutMs: 2_000, postconditionTimeoutMs: 2_000 };

test("pickup-forage runner passes with exact terminal correlation and fresh reread", async () => {
  const target = { targetId: "forage_target_1", x: 3, y: 4, qualifiedItemId: "(O)16", stack: 1 };
  const client = createFake({ forageTargets: [target], includeStaleReceipt: true });
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });

  const result = await runPickupForageSmoke(client, receipts, fixtureConfig(), OPTIONS);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "forage_picked_up");
  assert.equal(result.receipt.executionId, "execution-pickup_forage-4");
  assert.equal(result.evidence.item, "(O)16");
  assert.equal(result.evidence.removed, "True");
  assert.equal(result.targetGone, true);
  assert.equal(result.inventoryDeltaProven, true);
  assert.deepEqual(result.trace.map((entry) => entry.action), ["pickup_forage"]);
  assert.deepEqual(result.after.forageTargets, []);
  assert.equal(result.after.location, "Farm");
});

test("pickup-forage runner blocks on mismatched evidence", async () => {
  const target = { targetId: "forage_target_1", x: 3, y: 4, qualifiedItemId: "(O)16", stack: 1 };
  const client = createFake({
    forageTargets: [target],
    evidenceDetail: "location=Farm;target=5,5;item=(O)16;removed=True;inventory_before=0;inventory_after=1",
  });
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });

  const result = await runPickupForageSmoke(client, receipts, fixtureConfig(), OPTIONS);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "forage_postcondition_mismatch");
});

test("pickup-forage runner blocks on invalid evidence format", async () => {
  const target = { targetId: "forage_target_1", x: 3, y: 4, qualifiedItemId: "(O)16", stack: 1 };
  const client = createFake({ forageTargets: [target], evidenceDetail: "location=Farm;broken" });
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });

  const result = await runPickupForageSmoke(client, receipts, fixtureConfig(), OPTIONS);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "invalid_forage_evidence");
});

test("pickup-forage runner blocks on a non-isolated capability surface", async () => {
  const client = createFake({ capabilities: ["cancel_active_execution", "pickup_forage", "inspect_self", "move_to_tile"] });
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });

  const result = await runPickupForageSmoke(client, receipts, fixtureConfig(), OPTIONS);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "native_capability_surface_mismatch");
  assert.equal(result.trace.length, 0);
});

test("pickup-forage runner moves to the forage target before picking up", async () => {
  const target = { targetId: "forage_target_1", x: 10, y: 10, qualifiedItemId: "(O)16", stack: 1 };
  const client = createFake({ tile: { x: 6, y: 6 }, forageTargets: [target] });
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });

  const result = await runPickupForageSmoke(client, receipts, fixtureConfig(), OPTIONS);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "forage_picked_up");
  const actions = result.trace.map((entry) => entry.action);
  assert.equal(actions[0], "move_to_tile");
  assert.equal(actions[actions.length - 1], "pickup_forage");
  assert.ok(actions.length > 2, "expected bounded movement search before pickup");
});

test("pickup-forage runner travels to Farm before picking up forage", async () => {
  const target = { targetId: "forage_target_1", x: 3, y: 4, qualifiedItemId: "(O)16", stack: 1 };
  const client = createFake({
    location: "FarmHouse",
    tile: { x: 2, y: 2 },
    warps: [{ sourceX: 1, sourceY: 2, targetLocation: "Farm", targetX: 3, targetY: 4 }],
    forageTargets: [target],
  });
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });

  const result = await runPickupForageSmoke(client, receipts, fixtureConfig(), OPTIONS);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "forage_picked_up");
  assert.deepEqual(result.trace.map((entry) => entry.action), ["travel", "pickup_forage"]);
  assert.equal(result.before.location, "Farm");
  assert.equal(result.after.location, "Farm");
});

test("pickup-forage runner rejects a non-isolated topology", async () => {
  const client = createFake();
  await assert.rejects(
    runPickupForageSmoke(client, [], fixtureConfig({ Portfolio: { Enable: true } })),
    (error) => error?.message === "native_local_fixture_topology_not_isolated",
  );
});

test("pickup-forage runner rejects a disabled fixture", async () => {
  const client = createFake();
  await assert.rejects(
    runPickupForageSmoke(client, [], {}),
    (error) => error?.message === "native_local_fixture_not_enabled",
  );
});
