import assert from "node:assert/strict";
import test from "node:test";
import { MAX_RESULT_BYTES, parseScenarioResultText, validateScenarioResult } from "../src/scenario-result.mjs";

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

test("parses an exact private scenario result bound to its invocation", () => {
  const parsed = parseScenarioResultText(JSON.stringify(result), identity);
  assert.deepEqual(parsed, result);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.receipt));
  assert.ok(Object.isFrozen(parsed.postcondition));
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
