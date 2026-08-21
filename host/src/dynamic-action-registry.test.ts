// host/src/dynamic-action-registry.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { fc } from "./test-support/fast-check.js";
import {
  createDynamicActionRegistry,
  type DeclarativeDomainActionSpec,
} from "./dynamic-action-registry.js";
import type { PreflightSnapshot } from "./action-preflight-interpreter.js";
import type { ExecutionReceipt } from "./protocol.js";

test("Dynamic Action Registry: catalogs SOP macro and produces diagnostic feedback", async () => {
  const registry = createDynamicActionRegistry();

  const spec: DeclarativeDomainActionSpec = {
    actionId: "custom_water_crop_sequence",
    family: "crop_farming",
    description: "Equip watering can in slot 1 and water target crop handle.",
    pipeline: [
      { type: "equip_tool", slot: 1, toolName: "Watering Can" },
      { type: "water_crop", targetHandle: "soil:24,34" },
    ],
    preflightInvariants: {
      requiredLocation: "Farm",
      requiredTools: ["Watering Can"],
      minimumStamina: 2,
    },
    pullbackEqualizer: {
      targetProperty: "terrain.soil_dirt.state.watered",
      targetLocation: { location: "Farm", tile: { x: 24, y: 34 } },
      expectedValue: true,
    },
  };

  const registerResult = registry.register(spec);
  assert.equal(registerResult.success, true);
  assert.equal(registry.hasAction("custom_water_crop_sequence"), true);

  const snapshot: PreflightSnapshot = {
    currentLocation: "Farm",
    playerStamina: 50,
    inventorySlots: [{ slot: 1, label: "Watering Can" }],
    verifiedHandles: ["soil:24,34"],
  };

  const preflight = registry.preflight("custom_water_crop_sequence", snapshot);
  assert.equal(preflight.isValid, true);
  assert.equal(preflight.estimatedStaminaCost, 2);

  // Equalizer verification feedback test
  const successReceipt: ExecutionReceipt = {
    executionId: "exec_01",
    requestId: "req_01",
    state: "succeeded",
    reasonCode: "equalizer_matched",
    revision: 10,
    evidence: {
      action: "custom_water_crop_sequence",
      targetProperty: "terrain.soil_dirt.state.watered",
      targetLocation: { location: "Farm", tile: { x: 24, y: 34 } },
      expectedValue: true,
      actualValue: true,
      equalizerMatched: true,
    },
  };
  const successFeedback = registry.evaluateReceipt("custom_water_crop_sequence", successReceipt);
  assert.equal(successFeedback.status, "verified");

  // Diagnostic feedback on mismatch (Zero auto-retry!)
  const mismatchReceipt: ExecutionReceipt = {
    executionId: "exec_02",
    requestId: "req_02",
    state: "failed",
    reasonCode: "equalizer_mismatch",
    revision: 11,
    evidence: {
      action: "custom_water_crop_sequence",
      targetProperty: "terrain.soil_dirt.state.watered",
      targetLocation: { location: "Farm", tile: { x: 24, y: 34 } },
      expectedValue: true,
      actualValue: false,
      equalizerMatched: false,
      failedStepIndex: null,
    },
  };
  const mismatchFeedback = registry.evaluateReceipt("custom_water_crop_sequence", mismatchReceipt);
  assert.equal(mismatchFeedback.status, "diagnostic_feedback");
  assert.equal(mismatchFeedback.delta?.expectedValue, true);
  assert.equal(mismatchFeedback.delta?.actualValue, false);

  // Infrastructure error feedback
  const errorReceipt: ExecutionReceipt = {
    executionId: "exec_03",
    requestId: "req_03",
    state: "cancelled",
    reasonCode: "epoch_interrupted",
    revision: 12,
    evidence: null,
  };
  const errorFeedback = registry.evaluateReceipt("custom_water_crop_sequence", errorReceipt);
  assert.equal(errorFeedback.status, "execution_error");
});

test("Dynamic Action Registry: enforces spec preflightInvariants", () => {
  const registry = createDynamicActionRegistry();
  const spec: DeclarativeDomainActionSpec = {
    actionId: "test_action_location_gate",
    family: "test",
    description: "Requires FarmHouse location",
    pipeline: [{ type: "skip_event" }],
    preflightInvariants: {
      requiredLocation: "FarmHouse",
      minimumStamina: 80,
    },
    pullbackEqualizer: {
      targetProperty: "none",
      targetLocation: { location: "FarmHouse", tile: { x: 0, y: 0 } },
      expectedValue: null,
    },
  };
  registry.register(spec);

  const wrongLocationSnapshot: PreflightSnapshot = {
    currentLocation: "Farm",
    playerStamina: 100,
    inventorySlots: [],
    verifiedHandles: [],
  };
  const preflightRes = registry.preflight("test_action_location_gate", wrongLocationSnapshot);
  assert.equal(preflightRes.isValid, false);
});

test("Dynamic Action Registry: PBT Registration Idempotency Invariants", () => {
  const registry = createDynamicActionRegistry();

  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 20 }), (actionName) => {
      const spec: DeclarativeDomainActionSpec = {
        actionId: `action_${actionName}`,
        family: "generic",
        description: "Dynamic test action",
        pipeline: [{ type: "skip_event" }],
        preflightInvariants: { minimumStamina: 0 },
        pullbackEqualizer: {
          targetProperty: "none",
          targetLocation: { location: "Farm", tile: { x: 0, y: 0 } },
          expectedValue: null,
        },
      };

      registry.register(spec);
      assert.equal(registry.hasAction(`action_${actionName}`), true);
      registry.unregister(`action_${actionName}`);
      assert.equal(registry.hasAction(`action_${actionName}`), false);
    }),
    { numRuns: 100 },
  );
});
