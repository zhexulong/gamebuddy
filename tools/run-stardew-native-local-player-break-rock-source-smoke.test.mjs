import assert from "node:assert/strict";
import test from "node:test";
import { runBreakRockSourceSmoke } from "./run-stardew-native-local-player-break-rock-source-smoke.mjs";

const CAPABILITIES = ["cancel_active_execution", "inspect_self", "move_to_tile", "travel", "break_rock_source"];

const ROCK = {
  targetId: "rock-target",
  x: 4,
  y: 3,
  location: "Farm",
  health: 1,
  qualifiedItemId: "(O)2",
};

const BREAK_EVIDENCE =
  "location=Farm;target=rock-target;tile=4,3;tool=pickaxe;slot=2;qualified_item_id=(O)2;durability_before=1;durability_after=removed;removed=true";

function fixtureConfig(overrides = {}) {
  return {
    ActionPolicyVersion: 0,
    EnabledActions: ["move_to_tile", "travel", "equip_tool", "break_rock_source"],
    NativeLocalPlayerFixture: {
      Enable: true,
      Bootstrap: { Enable: false },
      FixtureScenario: "native_break_rock_source_v1",
    },
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    ...overrides,
  };
}

function createFake({ capabilities = CAPABILITIES, removeRock = true } = {}) {
  const listeners = new Set();
  let revision = 7;
  let location = "FarmHouse";
  let tile = { x: 1, y: 1 };
  let rockRemoved = false;
  const snapshotOf = () => ({
    revision,
    location,
    tile,
    actionable: true,
    activeExecution: null,
    capabilities,
    warps: [{ sourceX: 1, sourceY: 1, targetLocation: "Farm", targetX: 3, targetY: 3 }],
    toolSlots: [{ slot: 2, label: "(T)Pickaxe" }],
    rockSourceTargets: rockRemoved ? [] : [ROCK],
  });
  const client = {
    state: { snapshot: snapshotOf() },
    observe: async () => {
      const snapshot = snapshotOf();
      client.state.snapshot = snapshot;
      return snapshot;
    },
    execute: async ({ requestId, action }) => {
      const executionId = `execution-${action}`;
      if (action === "travel") {
        revision += 1;
        const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
        publish({ ...receipt, state: "succeeded", reasonCode: "travel_completed", revision });
        location = "Farm";
        tile = { x: 3, y: 3 };
        return receipt;
      }
      if (action === "equip_tool") {
        revision += 1;
        return {
          requestId,
          executionId,
          state: "succeeded",
          reasonCode: "tool_selected",
          revision,
        };
      }
      if (action === "break_rock_source") {
        revision += 1;
        if (removeRock) rockRemoved = true;
        return {
          requestId,
          executionId,
          state: "succeeded",
          reasonCode: "rock_source_broken",
          revision,
          evidence: { detail: BREAK_EVIDENCE },
        };
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

test("break-rock runner passes with exact terminal identity and full postcondition", async () => {
  const client = createFake();
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runBreakRockSourceSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "break_rock_source");
  assert.equal(result.receipt.reasonCode, "rock_source_broken");
  assert.equal(result.target.targetId, "rock-target");
  assert.equal(result.evidence.removed, "true");
  assert.deepEqual(result.after.tile, { x: 3, y: 3 });
  assert.equal(result.after.rockSourceTargets, 0);
  assert.deepEqual(
    result.trace.map((entry) => entry.phase),
    ["travel", "travel_terminal", "equip_pickaxe", "break_rock_source"],
  );
});

test("break-rock runner blocks on a non-isolated capability surface", async () => {
  const client = createFake({
    capabilities: ["cancel_active_execution", "inspect_self", "move_to_tile", "travel"],
  });
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runBreakRockSourceSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "native_capability_surface_mismatch");
  assert.equal(result.trace.length, 0);
});

test("break-rock runner rejects a non-isolated topology", async () => {
  const client = createFake();
  await assert.rejects(
    runBreakRockSourceSmoke(client, [], fixtureConfig({ Portfolio: { Enable: true } })),
    (error) => error?.message === "native_local_break_rock_source_action_policy_invalid",
  );
});

test("break-rock runner rejects an invalid fixture scenario", async () => {
  const client = createFake();
  await assert.rejects(
    runBreakRockSourceSmoke(
      client,
      [],
      fixtureConfig({
        NativeLocalPlayerFixture: {
          ...fixtureConfig().NativeLocalPlayerFixture,
          FixtureScenario: "native_chop_tree_source_v1",
        },
      }),
    ),
    (error) => error?.message === "native_local_break_rock_source_fixture_config_invalid",
  );
});

test("break-rock runner blocks when the rock survives the break postcondition", async () => {
  const client = createFake({ removeRock: false });
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runBreakRockSourceSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "break_rock_source_postcondition_mismatch");
  assert.equal(result.after.rockSourceTargets, 1);
});
