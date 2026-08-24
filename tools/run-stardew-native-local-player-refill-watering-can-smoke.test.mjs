import assert from "node:assert/strict";
import test from "node:test";
import { runRefillWateringCanSmoke } from "./run-stardew-native-local-player-refill-watering-can-smoke.mjs";

const CONFIG = {
  SaveId: "save_01",
  WorldId: "world_01",
  PlayerId: "player_01",
  CompanionId: "companion_01",
  PipeName: "pipe",
  BridgeToken: "secret-token",
  ActionPolicyVersion: 0,
  EnabledActions: ["move_to_tile", "equip_tool", "refill_watering_can"],
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: "native_refill_watering_can_v1",
  },
};

const EXPECTED_CAPABILITIES = [
  "cancel_active_execution",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "refill_watering_can",
];

function wateringCanFacts(water) {
  return [{ slot: 0, qualifiedItemId: "(W)101", water, max: 40 }];
}

const REFILL_TARGETS = [{ targetId: "refill-1", x: 2, y: 2 }];

/** Mock bridge whose execute() publishes exact-correlated terminal receipts. */
function scriptedBridge({ postconditionRefilled = true, capabilities = EXPECTED_CAPABILITIES } = {}) {
  const listeners = new Set();
  const receipts = [];
  const calls = [];
  let revision = 1;
  let snapshot = {
    revision,
    location: "FarmHouse",
    tile: { x: 1, y: 2 },
    actionable: true,
    activeExecution: null,
    capabilities: [...capabilities],
    wateringCanFacts: wateringCanFacts(0),
    refillWateringCanTargets: REFILL_TARGETS,
  };
  const publish = (payload) => {
    receipts.push(payload);
    for (const listener of listeners) listener({ type: "execution_receipt", payload });
  };
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      calls.push(request);
      const executionId = request.action === "equip_tool" ? "equip-execution" : "refill-execution";
      if (request.action === "equip_tool") {
        revision += 1;
        publish({
          requestId: request.requestId,
          executionId,
          state: "succeeded",
          reasonCode: "tool_selected",
          revision,
          evidence: { detail: "expected=Watering Can;after=Watering Can" },
        });
        snapshot = { ...snapshot, revision };
      } else {
        revision += 1;
        publish({
          requestId: request.requestId,
          executionId,
          state: "succeeded",
          reasonCode: "watering_can_refilled",
          revision,
          evidence: {
            detail: "target=refill-1;slot=0;water_before=0;water_after=40;water_max=40",
          },
        });
        snapshot = {
          ...snapshot,
          revision,
          wateringCanFacts: postconditionRefilled ? wateringCanFacts(40) : wateringCanFacts(0),
          refillWateringCanTargets: postconditionRefilled ? [] : REFILL_TARGETS,
        };
      }
      return {
        requestId: request.requestId,
        executionId,
        state: "accepted",
        reasonCode: "accepted",
        revision: request.expectedRevision,
      };
    },
    onFact: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { client, receipts, calls };
}

test("refill-watering-can runner uses shared dispatch, exact terminal correlation, evidence, and fresh postcondition", async () => {
  const { client, receipts, calls } = scriptedBridge();
  const result = await runRefillWateringCanSmoke(client, receipts, CONFIG);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "watering_can_refilled");
  // Typed dispatch with revision-bound requests.
  assert.equal(calls[0].action, "equip_tool");
  assert.deepEqual(calls[0].args, { slot: 0 });
  assert.equal(calls[0].expectedRevision, 1);
  assert.equal(calls[1].action, "refill_watering_can");
  assert.deepEqual(calls[1].args, { slot: 0, x: 2, y: 2, expectedTargetId: "refill-1" });
  assert.equal(calls[1].expectedRevision, 2);
  // Exact terminal correlation and evidence validation.
  assert.equal(result.receipt.executionId, "refill-execution");
  assert.equal(result.receipt.requestId, calls[1].requestId);
  assert.equal(result.receipt.reasonCode, "watering_can_refilled");
  assert.equal(result.evidence.water_before, "0");
  assert.equal(result.evidence.water_after, "40");
  // Fresh postcondition reread.
  assert.equal(result.after.wateringCanFacts[0].water, 40);
  assert.equal(result.after.wateringCanFacts[0].max, 40);
});

test("refill-watering-can runner fails closed when the fresh postcondition did not refill", async () => {
  const { client, receipts } = scriptedBridge({ postconditionRefilled: false });
  const result = await runRefillWateringCanSmoke(client, receipts, CONFIG);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "refill_watering_can_postcondition_mismatch");
});

test("refill-watering-can runner rejects a capability surface superset", async () => {
  const { client, receipts } = scriptedBridge({
    capabilities: [...EXPECTED_CAPABILITIES, "travel"],
  });
  const result = await runRefillWateringCanSmoke(client, receipts, CONFIG);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "native_capability_surface_mismatch");
});
