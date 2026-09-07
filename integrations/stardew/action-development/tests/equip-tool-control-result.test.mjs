import assert from "node:assert/strict";
import test from "node:test";
import {
  mapEquipToolControlRunResult,
  verifyEquipToolControlProof,
} from "../src/equip-tool-control-result.mjs";

const start = Object.freeze({
  protocolVersion: 1,
  runId: "control-run-1",
  correlationId: "platform-correlation-1",
  scenarioId: "equip_tool_control",
  deadlineEpochMs: 1_800_000_000_000,
  cancellationId: "cancel-1",
});

const result = Object.freeze({
  protocolVersion: 1,
  runId: start.runId,
  correlationId: start.correlationId,
  terminalCode: "succeeded",
  actionOutcome: "succeeded",
  harnessOutcome: "succeeded",
  cleanupOutcome: "succeeded",
  proof: Object.freeze({
    issuer: "host_control_runner",
    binding: Object.freeze({
      runId: start.runId,
      correlationId: start.correlationId,
      requestId: "host-request-1",
      executionId: "host-execution-1",
      actionId: "equip_tool",
    }),
    data: Object.freeze({
      reasonCode: "tool_selected",
      expectedRevision: 4,
      terminalRevision: 5,
      slot: 1,
      before: "Axe",
      expected: "Hoe",
      after: "Hoe",
    }),
  }),
  cleanupFacts: Object.freeze({ restore: "completed" }),
});

function resultWith(patch) {
  return {
    ...result,
    ...patch,
    proof: patch.proof === undefined ? result.proof : patch.proof,
  };
}

test("action-owned verifier consumes exact bounded Host proof and projects no Host authority", () => {
  const verified = verifyEquipToolControlProof({ start, result });
  assert.deepEqual(verified, {
    actionId: "equip_tool",
    runId: start.runId,
    correlationId: start.correlationId,
    verified: true,
  });
  assert.ok(Object.isFrozen(verified));
  for (const field of ["proof", "binding", "requestId", "executionId", "data", "cleanupFacts", "bridge", "port", "fixture", "recovery"]) {
    assert.equal(Object.hasOwn(verified, field), false, field);
  }
});

test("rejects Host proof data that is incomplete, mismatched, or attempts to carry extra authority", () => {
  const proofWith = (data) => ({ ...result.proof, data });
  for (const data of [
    { ...result.proof.data, requestId: "smuggled" },
    { ...result.proof.data, reasonCode: "other" },
    { ...result.proof.data, terminalRevision: 4 },
    { ...result.proof.data, after: "Axe" },
    { ...result.proof.data, before: "Hoe" },
    { ...result.proof.data, slot: 37 },
  ]) {
    assert.throws(
      () => verifyEquipToolControlProof({ start, result: resultWith({ proof: proofWith(data) }) }),
      /stardew_(?:control_protocol_invalid_data|equip_tool_control_result_)/,
    );
  }
  assert.throws(
    () => verifyEquipToolControlProof({ start: { ...start, runId: "other-run" }, result }),
    /run_binding_mismatch/,
  );
});

test("accepts the published equip_tool upper slot boundary", () => {
  const upperBoundResult = resultWith({
    proof: { ...result.proof, data: { ...result.proof.data, slot: 36 } },
  });
  assert.equal(verifyEquipToolControlProof({ start, result: upperBoundResult }).verified, true);
});

test("separates action, harness, and cleanup outcomes without treating settlement as action success", () => {
  const success = mapEquipToolControlRunResult({ start, result });
  assert.deepEqual(success, {
    schema: "gamebuddy-stardew-equip-tool-control-outcome/v1",
    runId: start.runId,
    correlationId: start.correlationId,
    terminalCode: "succeeded",
    actionOutcome: "succeeded",
    harnessOutcome: "succeeded",
    cleanupOutcome: "succeeded",
    actionVerified: true,
    state: "PASSED",
  });

  const cleanupFailed = mapEquipToolControlRunResult({ start, result: resultWith({ cleanupOutcome: "failed" }) });
  assert.equal(cleanupFailed.actionVerified, true);
  assert.equal(cleanupFailed.actionOutcome, "succeeded");
  assert.equal(cleanupFailed.cleanupOutcome, "failed");
  assert.equal(cleanupFailed.state, "INCOMPLETE");

  const blocked = mapEquipToolControlRunResult({
    start,
    result: resultWith({ terminalCode: "blocked", actionOutcome: "not_started", harnessOutcome: "succeeded" }),
  });
  assert.equal(blocked.actionVerified, false);
  assert.equal(blocked.state, "INCOMPLETE");

  const recoveryIncomplete = mapEquipToolControlRunResult({
    start,
    result: resultWith({ terminalCode: "recovery_incomplete", actionOutcome: "indeterminate", harnessOutcome: "failed" }),
  });
  assert.equal(recoveryIncomplete.actionVerified, false);
  assert.equal(recoveryIncomplete.actionOutcome, "indeterminate");
  assert.equal(recoveryIncomplete.state, "INCOMPLETE");
});

test("module exposes only pure proof-consumption and outcome-mapping seams", async () => {
  const controlResultModule = await import("../src/equip-tool-control-result.mjs");
  assert.deepEqual(Object.keys(controlResultModule).sort(), [
    "mapEquipToolControlRunResult",
    "verifyEquipToolControlProof",
  ]);
  assert.equal(typeof mapEquipToolControlRunResult, "function");
});
