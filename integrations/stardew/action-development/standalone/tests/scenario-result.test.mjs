import assert from "node:assert/strict";
import test from "node:test";
import { MAX_RESULT_BYTES, parseScenarioResultText, validateScenarioResult } from "../src/scenario-result.mjs";
import { validateEquipToolScenarioProof } from "../src/equip-tool-scenario-result.mjs";

const identity = Object.freeze({
  gameId: "stardew",
  actionId: "equip_tool",
  runId: "run-1",
  stage: "deterministic-check",
  profileIdentity: "stardew-local-example",
  claimScope: "equip-tool-static-contract",
});
const result = Object.freeze({
  schema: "gamebuddy-action-scenario-result/v1",
  ...identity,
  receipt: { executionId: "exec-1", state: "succeeded" },
  postcondition: { currentTool: "Axe" },
  verdict: "passed",
  reasonCode: "tool_selected",
});
const liveIdentity = Object.freeze({
  gameId: "stardew",
  actionId: "equip_tool",
  runId: "live-run-1",
  stage: "run-live",
  profileIdentity: "target-profile",
  claimScope: "native-local-equip-tool-v1",
});
const liveResult = Object.freeze({
  schema: "gamebuddy-action-scenario-result/v1",
  ...liveIdentity,
  receipt: {
    state: "succeeded",
    reasonCode: "tool_selected",
    hasEvidence: true,
    request: {
      requestId: "request-1",
      idempotencyKey: "idempotency-1",
      action: "equip_tool",
      args: { slot: 1 },
      expectedRevision: 2,
    },
    accepted: { requestId: "request-1", executionId: "execution-1" },
    terminal: {
      requestId: "request-1",
      executionId: "execution-1",
      state: "succeeded",
      reasonCode: "tool_selected",
      revision: 3,
    },
    evidence: { slot: 1, before: "Axe", expected: "Hoe", after: "Hoe" },
  },
  postcondition: {
    revision: 3,
    currentTool: "Hoe",
    expectedTool: "Hoe",
    selected: { slot: 1, label: "Hoe" },
  },
  verdict: "passed",
  reasonCode: "tool_selected",
});

test("parses an exact private scenario result bound to its invocation", () => {
  const parsed = parseScenarioResultText(JSON.stringify(result), identity);
  assert.deepEqual(parsed, result);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.receipt));
  assert.ok(Object.isFrozen(parsed.postcondition));
});

test("accepts a complete action-owned equip_tool live proof", () => {
  const parsed = validateEquipToolScenarioProof(parseScenarioResultText(JSON.stringify(liveResult), liveIdentity));
  assert.deepEqual(parsed, liveResult);
  assert.ok(Object.isFrozen(parsed.receipt.request));
  assert.ok(Object.isFrozen(parsed.receipt.evidence));
  assert.ok(Object.isFrozen(parsed.postcondition.selected));
});

test("rejects mismatched, malformed, unknown, and secret-bearing results", () => {
  assert.throws(() => validateScenarioResult({ ...result, actionId: "enter_mine" }, identity), /identity_mismatch/);
  assert.throws(() => validateScenarioResult({ ...result, stdout: "private" }, identity), /invalid_shape/);
  assert.throws(() => validateScenarioResult({ ...result, receipt: { token: "secret" } }, identity), /invalid_payload/);
  assert.throws(() => parseScenarioResultText("{", identity), /invalid_json/);
  assert.throws(() => parseScenarioResultText('{"schema":"gamebuddy-action-scenario-result/v1","schema":"wrong"}', identity), /duplicate_key/);
  assert.throws(() => parseScenarioResultText('{"schema":"gamebuddy-action-scenario-result/v1","runId":"run-1","gameId":"stardew","actionId":"equip_tool","stage":"deterministic-check","profileIdentity":"stardew-local-example","claimScope":"equip-tool-static-contract","receipt":{"state":"succeeded","state":"failed"},"postcondition":{},"verdict":"passed","reasonCode":"tool_selected"}', identity), /duplicate_key/);
  assert.throws(() => parseScenarioResultText("", identity), /invalid_size/);
  assert.throws(() => parseScenarioResultText("x".repeat(MAX_RESULT_BYTES + 1), identity), /invalid_size/);
});

test("fails closed for incomplete equip_tool live passed proofs", () => {
  const { evidence: _evidence, ...receiptWithoutEvidence } = liveResult.receipt;
  const { selected: _selected, ...postconditionWithoutSelected } = liveResult.postcondition;
  const incompleteResults = [
    { ...liveResult, receipt: { state: "succeeded" } },
    { ...liveResult, receipt: receiptWithoutEvidence },
    { ...liveResult, postcondition: postconditionWithoutSelected },
  ];
  for (const incomplete of incompleteResults) {
    assert.throws(() => validateEquipToolScenarioProof(parseScenarioResultText(JSON.stringify(incomplete), liveIdentity)), /invalid_(receipt|postcondition|evidence)/);
  }
});

test("preserves failed result facts without promoting them", () => {
  const parsed = validateScenarioResult({ ...result, verdict: "failed", reasonCode: "fixture_restore_failed" }, identity);
  assert.equal(parsed.verdict, "failed");
  assert.equal(parsed.reasonCode, "fixture_restore_failed");
});

test("rejects accessors, proxies, and invalid expected identities", () => {
  const accessor = { ...result };
  Object.defineProperty(accessor, "runId", { enumerable: true, get: () => result.runId });
  assert.throws(() => validateScenarioResult(accessor, identity), /invalid_shape/);
  assert.throws(() => validateScenarioResult(new Proxy(result, {}), identity), /invalid_shape/);
  assert.throws(() => validateScenarioResult(result, { ...identity, runId: "../outside" }), /invalid_expected_runId/);
  assert.throws(() => validateScenarioResult(result, new Proxy(identity, {})), /invalid_expected_identity/);
  const incompleteIdentity = { ...identity };
  delete incompleteIdentity.runId;
  assert.throws(() => validateScenarioResult(result, incompleteIdentity), /invalid_expected_identity/);
});

test("rejects payload depth, size, invalid records, and forbidden nested field names", () => {
  const deeplyNested = { value: "leaf" };
  let nested = deeplyNested;
  for (let index = 0; index <= 9; index++) nested = { nested };
  assert.throws(() => validateScenarioResult({ ...result, receipt: nested }, identity), /invalid_payload/);
  assert.throws(() => validateScenarioResult({ ...result, postcondition: { secret: "no" } }, identity), /invalid_payload/);
  assert.throws(() => validateScenarioResult({ ...result, postcondition: { rawOutput: "no" } }, identity), /invalid_payload/);
  assert.throws(() => validateScenarioResult({ ...result, receipt: "x".repeat(8193) }, identity), /invalid_payload/);
});
