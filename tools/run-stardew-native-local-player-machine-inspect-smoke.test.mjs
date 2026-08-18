import assert from "node:assert/strict";
import test from "node:test";
import { runMachineInspectSmoke } from "./run-stardew-native-local-player-machine-inspect-smoke.mjs";

const CAPABILITIES = ["cancel_active_execution", "inspect_self", "machine_inspect", "move_to_tile"];

const INSPECT_TARGET = {
  targetId: "machine-1",
  x: 3,
  y: 2,
  qualifiedItemId: "(BC)12",
  readyForHarvest: false,
  minutesUntilReady: 240,
  heldObjectQualifiedItemId: null,
  lastInputQualifiedItemId: null,
};

function fixtureConfig(overrides = {}) {
  return {
    NativeLocalPlayerFixture: {
      Enable: true,
      FixtureScenario: "native_machine_inspect_v1",
      LogicalSaveName: "GameBuddyFixture",
      ObservedSaveSlot: "GameBuddyFixture_445094166",
    },
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    ActionPolicyVersion: 0,
    EnabledActions: ["move_to_tile", "machine_inspect"],
    ...overrides,
  };
}

function createFake(machineTargets) {
  const listeners = new Set();
  let revision = 5;
  const snapshotOf = () => ({
    revision,
    location: "Farm",
    tile: { x: 3, y: 3 },
    actionable: true,
    activeExecution: null,
    capabilities: CAPABILITIES,
    warps: [],
    machineTargets,
  });
  const client = {
    state: { snapshot: snapshotOf() },
    observe: async () => {
      const snapshot = snapshotOf();
      client.state.snapshot = snapshot;
      return snapshot;
    },
    execute: async ({ requestId, action }) => {
      if (action !== "machine_inspect") throw new Error(`unexpected_action:${action}`);
      const executionId = "execution-1";
      revision += 1;
      const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
      publish(receipt);
      publish({
        ...receipt,
        state: "succeeded",
        reasonCode: "machine_inspected",
        revision,
        evidence: {
          detail:
            "location=Farm;target=machine-1;tile=3,2;machine=(BC)12;ready_for_harvest=false;minutes_until_ready=240;held=none;last_input=none",
        },
      });
      return receipt;
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

test("machine-inspect runner passes with an unchanged fresh opaque target", async () => {
  const client = createFake([INSPECT_TARGET]);
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runMachineInspectSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "machine_inspected");
  assert.equal(result.receipt.state, "succeeded");
  assert.equal(result.unchangedTarget, true);
  assert.equal(result.evidence.target, "machine-1");
  assert.equal(result.evidence.machine, "(BC)12");
  assert.deepEqual(result.after.tile, { x: 3, y: 3 });
  assert.equal(result.after.revision >= result.receipt.revision, true);
});

test("machine-inspect runner fails closed on an ambiguous target set", async () => {
  const client = createFake([INSPECT_TARGET, { ...INSPECT_TARGET, targetId: "machine-2", x: 4, y: 3 }]);
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runMachineInspectSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /ambiguous_live_machine_targets/);
});

test("machine-inspect runner rejects a non-isolated fixture policy", async () => {
  const client = createFake([INSPECT_TARGET]);
  await assert.rejects(
    runMachineInspectSmoke(client, [], fixtureConfig({ EnabledActions: ["move_to_tile"] })),
    (error) => error?.message === "native_local_machine_action_policy_invalid",
  );
});
