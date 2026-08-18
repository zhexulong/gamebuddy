import assert from "node:assert/strict";
import test from "node:test";

import {
  isExactReceiptRecoveryPort,
  StardewExecutionRecoverySupervisor,
} from "./stardew-execution-recovery-supervisor.js";
import { createActionExecutionCoordinator } from "./action-execution-coordinator.internal.js";
import type { ExecutionReceipt } from "./protocol.js";
import type { IntegrationConnection } from "./integration-types.js";

function receipt(state: ExecutionReceipt["state"]): ExecutionReceipt {
  return {
    requestId: "request_recovery_01",
    executionId: "execution_recovery_01",
    state,
    reasonCode: state === "succeeded" ? "soil_tilled" : "accepted",
    revision: state === "succeeded" ? 2 : 1,
    evidence: state === "succeeded" ? { targetId: "soil_01" } : null,
  };
}

function coordinatorFixture() {
  const connection = {
    module: {
      cancelExecution: async () => receipt("cancelled"),
    },
  } as unknown as IntegrationConnection;
  return createActionExecutionCoordinator(connection);
}

test("recovery supervisor queries each uncertain immutable tuple once and admits only through coordinator receipt admission", async () => {
  const coordinator = coordinatorFixture();
  const admission = coordinator.createAdmission();
  const dispatch = { ...admission.owner, requestId: "request_recovery_01", idempotencyKey: "idempotency_recovery_01" };
  admission.observer.beforeWrite(dispatch);
  admission.observer.markUncertain(dispatch);

  const calls: unknown[] = [];
  const supervisor = new StardewExecutionRecoverySupervisor(coordinator);
  const result = await supervisor.recoverFromFreshBinding({
    queryExecutionReceipt: async (query) => {
      calls.push(query);
      return receipt("succeeded");
    },
  });

  assert.deepEqual(calls, [{ requestId: "request_recovery_01", idempotencyKey: "idempotency_recovery_01" }]);
  assert.deepEqual(result, [{ requestId: "request_recovery_01", result: "admitted", state: "succeeded" }]);
  assert.deepEqual(coordinator.uncertainDispatches(), []);
});

test("isExactReceiptRecoveryPort accepts only a queryExecutionReceipt function surface", () => {
  assert.equal(isExactReceiptRecoveryPort({ queryExecutionReceipt: async () => ({}) }), true);
  assert.equal(isExactReceiptRecoveryPort({}), false);
  assert.equal(isExactReceiptRecoveryPort({ queryExecutionReceipt: 1 }), false);
  assert.equal(isExactReceiptRecoveryPort(null), false);
  assert.equal(isExactReceiptRecoveryPort(undefined), false);
});

test("receipt_not_found preserves uncertainty and a mismatched receipt never enters coordinator", async () => {
  const coordinator = coordinatorFixture();
  const admission = coordinator.createAdmission();
  const dispatch = { ...admission.owner, requestId: "request_recovery_01", idempotencyKey: "idempotency_recovery_01" };
  admission.observer.beforeWrite(dispatch);
  admission.observer.markUncertain(dispatch);
  const supervisor = new StardewExecutionRecoverySupervisor(coordinator);

  const missing = await supervisor.recoverFromFreshBinding({
    queryExecutionReceipt: async () => {
      throw new Error("bridge_rejected:receipt_not_found");
    },
  });
  assert.deepEqual(missing, [{ requestId: "request_recovery_01", result: "not_found" }]);
  assert.equal(coordinator.uncertainDispatches().length, 1);

  const mismatch = await supervisor.recoverFromFreshBinding({
    queryExecutionReceipt: async () => ({ ...receipt("succeeded"), requestId: "other_request" }),
  });
  assert.deepEqual(mismatch, [{ requestId: "request_recovery_01", result: "rejected", reasonCode: "receipt_request_mismatch" }]);
  assert.equal(coordinator.uncertainDispatches().length, 1);
});
