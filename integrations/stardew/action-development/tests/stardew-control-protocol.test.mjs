import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CONTROL_MESSAGE_BYTES,
  buildControlRunResult,
  buildControlRunStart,
  parseControlRunResultText,
  parseControlRunStartText,
  validateControlRunResult,
  validateControlRunStart,
} from "../src/stardew-control-protocol.mjs";

const start = Object.freeze({
  protocolVersion: 1,
  runId: "run-1",
  correlationId: "platform-correlation-1",
  scenarioId: "equip_tool_control",
  deadlineEpochMs: 1_800_000_000_000,
  cancellationId: "cancel-1",
});

const proof = Object.freeze({
  issuer: "host_control_runner",
  binding: Object.freeze({
    runId: "run-1",
    correlationId: "platform-correlation-1",
    requestId: "request-1",
    executionId: "execution-1",
    actionId: "equip_tool",
  }),
  data: Object.freeze({ evidence: Object.freeze({ before: "Hoe", after: "Axe" }), attempts: Object.freeze([1, 2]) }),
});

const result = Object.freeze({
  protocolVersion: 1,
  runId: "run-1",
  correlationId: "platform-correlation-1",
  terminalCode: "succeeded",
  actionOutcome: "succeeded",
  harnessOutcome: "succeeded",
  cleanupOutcome: "succeeded",
  proof,
  cleanupFacts: Object.freeze({ restore: "completed" }),
});

function resultWith(proofPatch) {
  return { ...result, proof: { ...proof, ...proofPatch } };
}

test("builds and parses only the frozen equip_tool control start without actionId", () => {
  const text = buildControlRunStart(start);
  assert.deepEqual(parseControlRunStartText(text), start);
  assert.deepEqual(validateControlRunStart(start), start);
  assert.ok(Object.isFrozen(parseControlRunStartText(text)));
  assert.ok(Buffer.byteLength(text, "utf8") <= MAX_CONTROL_MESSAGE_BYTES);
  assert.throws(() => validateControlRunStart({ ...start, actionId: "equip_tool" }), /invalid_shape/);
});

test("builds and parses the exact host control proof binding and bounded facts", () => {
  const parsed = parseControlRunResultText(buildControlRunResult(result));
  assert.deepEqual(parsed, result);
  assert.deepEqual(validateControlRunResult(result), result);
  assert.ok(Object.isFrozen(parsed.proof.data));
  assert.ok(Object.isFrozen(parsed.cleanupFacts));
});

test("rejects missing, mismatched, and non-equip proof binding facts", () => {
  assert.throws(() => validateControlRunResult(resultWith({ issuer: "other" })), /invalid_proof/);
  assert.throws(() => validateControlRunResult(resultWith({ binding: { ...proof.binding, runId: "other" } })), /invalid_proof/);
  assert.throws(() => validateControlRunResult(resultWith({ binding: { ...proof.binding, correlationId: "other" } })), /invalid_proof/);
  assert.throws(() => validateControlRunResult(resultWith({ binding: { ...proof.binding, actionId: "other" } })), /invalid_proof/);
  assert.throws(() => validateControlRunResult(resultWith({ binding: { ...proof.binding, requestId: "" } })), /invalid_request_id/);
  assert.throws(() => validateControlRunResult(resultWith({ binding: { ...proof.binding, extra: "forbidden" } })), /invalid_proof/);
});

test("rejects forbidden data keys after separator and case normalization recursively", () => {
  for (const key of [
    "requestId", "request_id", "request-id",
    "executionId", "execution_id", "execution-id",
    "BRIDGE_TOKEN", "bridge-token", "action_id",
  ]) {
    assert.throws(() => validateControlRunResult(resultWith({ data: { nested: { [key]: "host-owned" } } })), /invalid_data/);
  }
});

test("rejects invalid fact roots and hostile bounded arrays without invoking input methods", () => {
  for (const field of ["proof", "cleanupFacts"]) {
    for (const value of [null, 1, [], "facts"]) {
      const candidate = field === "proof" ? { ...result, proof: value } : { ...result, cleanupFacts: value };
      assert.throws(() => validateControlRunResult(candidate), /invalid_(proof|data|cleanup_facts)/);
    }
  }
  const getterArray = [];
  Object.defineProperty(getterArray, "0", { get() { throw new Error("getter invoked"); }, enumerable: true });
  getterArray.length = 1;
  assert.throws(() => validateControlRunResult(resultWith({ data: { values: getterArray } })), /invalid_data/);
  const customMap = [1];
  customMap.map = () => { throw new Error("map invoked"); };
  assert.throws(() => validateControlRunResult(resultWith({ data: { values: customMap } })), /invalid_data/);
  const sparse = new Array(1);
  assert.throws(() => validateControlRunResult(resultWith({ data: { values: sparse } })), /invalid_data/);
  assert.throws(() => validateControlRunResult(resultWith({ data: { values: new Proxy([], {}) } })), /invalid_data/);
});

test("rejects unknown, duplicate, malformed, oversized, and recursively authority-bearing results", () => {
  assert.throws(() => validateControlRunResult({ ...result, receipt: {} }), /invalid_shape/);
  assert.throws(() => parseControlRunResultText('{"protocolVersion":1,"runId":"run-1","correlationId":"platform-correlation-1","terminalCode":"succeeded","actionOutcome":"succeeded","harnessOutcome":"succeeded","cleanupOutcome":"succeeded","proof":{"issuer":"host_control_runner","binding":{"runId":"run-1","correlationId":"platform-correlation-1","requestId":"r","requestId":"r2","executionId":"e","actionId":"equip_tool"},"data":{}},"cleanupFacts":{}}'), /duplicate_key/);
  assert.throws(() => parseControlRunStartText("{"), /invalid_json/);
  assert.throws(() => parseControlRunStartText("x".repeat(MAX_CONTROL_MESSAGE_BYTES + 1)), /invalid_size/);
  assert.throws(() => buildControlRunResult(resultWith({ data: { evidence: "x".repeat(MAX_CONTROL_MESSAGE_BYTES) } })), /invalid_size|invalid_data/);
});

test("enforces terminal and action outcome consistency while preserving cleanup independence", () => {
  assert.throws(() => validateControlRunResult({ ...result, actionOutcome: "failed" }), /invalid_terminal_action_outcome/);
  for (const terminalCode of ["blocked", "cancelled", "deadline_exceeded", "protocol_error", "child_exit", "supervisor_closed", "recovery_incomplete"]) {
    assert.throws(() => validateControlRunResult({ ...result, terminalCode }), /invalid_terminal_action_outcome/);
  }
  assert.throws(() => validateControlRunResult({ ...result, terminalCode: "recovery_incomplete", actionOutcome: "failed" }), /invalid_terminal_action_outcome/);
  const cleanupFailed = validateControlRunResult({ ...result, cleanupOutcome: "failed" });
  assert.equal(cleanupFailed.actionOutcome, "succeeded");
  assert.equal(cleanupFailed.cleanupOutcome, "failed");
});
