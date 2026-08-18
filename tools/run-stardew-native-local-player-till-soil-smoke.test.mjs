import assert from "node:assert/strict";
import test from "node:test";
import { runTillSoilSmoke } from "./run-stardew-native-local-player-till-soil-smoke.mjs";

const CAPABILITIES = ["cancel_active_execution", "equip_tool", "inspect_self", "move_to_tile", "travel", "till_soil"];

function fixtureConfig(overrides = {}) {
  return {
    NativeLocalPlayerFixture: {
      Enable: true,
      FixtureScenario: "native_till_soil_v1",
      LogicalSaveName: "GameBuddyFixture",
      ObservedSaveSlot: "GameBuddyFixture_445094166",
    },
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    ActionPolicyVersion: 0,
    EnabledActions: ["move_to_tile", "travel", "equip_tool", "till_soil"],
    ...overrides,
  };
}

function createFake() {
  const listeners = new Set();
  let revision = 7;
  let tilled = false;
  const snapshotOf = () => ({
    revision,
    location: "Farm",
    tile: { x: 2, y: 2 },
    actionable: true,
    activeExecution: null,
    capabilities: CAPABILITIES,
    toolSlots: [{ label: "Hoe", slot: 0 }],
    currentTool: "Hoe",
    soilTiles: tilled ? [] : [{ x: 2, y: 1 }],
  });
  const client = {
    state: { snapshot: snapshotOf() },
    observe: async () => {
      const snapshot = snapshotOf();
      client.state.snapshot = snapshot;
      return snapshot;
    },
    execute: async ({ requestId, action, args }) => {
      const executionId = `execution-${action}`;
      if (action === "equip_tool") {
        revision += 1;
        return { requestId, executionId, state: "succeeded", reasonCode: "tool_selected", revision };
      }
      if (action === "till_soil") {
        revision += 1;
        const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
        publish(receipt);
        tilled = true;
        publish({
          ...receipt,
          state: "succeeded",
          reasonCode: "soil_tilled",
          revision,
          evidence: { detail: `location=Farm;target=${args.x},${args.y};before=none;after=HoeDirt` },
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

test("till-soil runner passes with a reachable bare soil tile", async () => {
  const client = createFake();
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runTillSoilSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "soil_tilled");
  assert.deepEqual(result.target, { x: 2, y: 1 });
  assert.equal(result.evidence.before, "none");
  assert.equal(result.evidence.after, "HoeDirt");
  assert.equal(result.freshTargetGone, true);
  assert.equal(result.after.revision, result.receipt.revision);
});

test("till-soil runner rejects a non-isolated action policy", async () => {
  const client = createFake();
  await assert.rejects(
    runTillSoilSmoke(client, [], fixtureConfig({ EnabledActions: ["till_soil"] })),
    (error) => error?.message === "native_local_till_soil_action_policy_invalid",
  );
});
