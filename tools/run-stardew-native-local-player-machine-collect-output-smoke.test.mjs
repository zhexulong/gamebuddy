import assert from "node:assert/strict";
import test from "node:test";
import { runMachineCollectOutputSmoke } from "./run-stardew-native-local-player-machine-collect-output-smoke.mjs";

const CAPABILITIES = ["cancel_active_execution", "inspect_self", "machine_load", "machine_collect_output"];

const COLLECT_EVIDENCE =
  "location=Farm;target=machine-1;tile=5,6;machine=(BC)12;output=(O)395;input=(O)433;ready_before=true;minutes_until_ready_before=0;inventory_coffee_before=0;inventory_coffee_after=1;held_after=none;ready_after=false;native_check_action=true";

function fixtureConfig(overrides = {}) {
  return {
    NativeLocalPlayerFixture: { Enable: true, FixtureScenario: "native_machine_coffee_load_v1" },
    ActionPolicyVersion: 0,
    EnabledActions: ["machine_load", "machine_collect_output"],
    ...overrides,
  };
}

function liveTarget(phase) {
  const base = {
    targetId: "machine-1",
    x: 5,
    y: 6,
    qualifiedItemId: "(BC)12",
    loadInputSlot: 10,
    loadInputQualifiedItemId: "(O)433",
    loadInputStack: 5,
  };
  if (phase === "before")
    return {
      ...base,
      readyForHarvest: false,
      minutesUntilReady: 0,
      heldObjectQualifiedItemId: null,
      lastInputQualifiedItemId: null,
    };
  if (phase === "loaded")
    return {
      ...base,
      readyForHarvest: false,
      minutesUntilReady: 120,
      heldObjectQualifiedItemId: "(O)395",
      lastInputQualifiedItemId: "(O)433",
    };
  if (phase === "ready")
    return {
      ...base,
      readyForHarvest: true,
      minutesUntilReady: 0,
      heldObjectQualifiedItemId: "(O)395",
      lastInputQualifiedItemId: "(O)433",
      collectOutputReady: true,
    };
  return {
    ...base,
    readyForHarvest: false,
    minutesUntilReady: 0,
    heldObjectQualifiedItemId: null,
    lastInputQualifiedItemId: null,
    collectOutputReady: false,
  };
}

function createFake() {
  const listeners = new Set();
  let revision = 10;
  let phase = "before";
  let loadedReads = 0;
  const snapshotOf = () => ({
    revision,
    location: "Farm",
    tile: { x: 5, y: 5 },
    actionable: true,
    activeExecution: null,
    capabilities: CAPABILITIES,
    machineTargets: [liveTarget(phase)],
  });
  const client = {
    state: { snapshot: snapshotOf() },
    observe: async () => {
      // Real game time advances the processing keg to ready after the
      // loaded postcondition is read.
      if (phase === "loaded") {
        loadedReads += 1;
        if (loadedReads >= 2) phase = "ready";
      }
      const snapshot = snapshotOf();
      client.state.snapshot = snapshot;
      return snapshot;
    },
    execute: async ({ requestId, action }) => {
      const executionId = `execution-${action}`;
      revision += 1;
      const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
      publish(receipt);
      if (action === "machine_load") {
        phase = "loaded";
        publish({ ...receipt, state: "succeeded", reasonCode: "machine_coffee_loaded", revision });
      } else if (action === "machine_collect_output") {
        phase = "after";
        publish({
          ...receipt,
          state: "succeeded",
          reasonCode: "machine_coffee_collected",
          revision,
          evidence: { detail: COLLECT_EVIDENCE },
        });
      } else {
        throw new Error(`unexpected_action:${action}`);
      }
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

test("machine-collect runner passes the load-to-collect lifecycle", async () => {
  const client = createFake();
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runMachineCollectOutputSmoke(client, receipts, fixtureConfig(), { readyTimeoutMs: 5_000 });
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "machine_coffee_collected");
  assert.equal(result.loadReceipt.reasonCode, "machine_coffee_loaded");
  assert.equal(result.collectReceipt.state, "succeeded");
  assert.equal(result.evidence.machine, "(BC)12");
  assert.equal(result.evidence.held_after, "none");
  assert.equal(result.reread.heldObjectQualifiedItemId, null);
  assert.equal(result.reread.readyForHarvest, false);
  assert.equal(result.reread.collectOutputReady, false);
  assert.ok(result.durationMs >= 0);
});

test("machine-collect runner rejects a mismatched fixture scenario", async () => {
  const client = createFake();
  await assert.rejects(
    runMachineCollectOutputSmoke(
      client,
      [],
      fixtureConfig({ NativeLocalPlayerFixture: { Enable: true, FixtureScenario: "native_machine_inspect_v1" } }),
    ),
    (error) => error?.message === "native_local_machine_collect_fixture_config_invalid",
  );
});
