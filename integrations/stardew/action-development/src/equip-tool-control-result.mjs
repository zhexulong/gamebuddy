import {
  validateControlRunResult,
  validateControlRunStart,
} from "./stardew-control-protocol.mjs";

const PROOF_DATA_KEYS = new Set([
  "reasonCode",
  "expectedRevision",
  "terminalRevision",
  "slot",
  "before",
  "expected",
  "after",
]);
const LABEL_MAX_BYTES = 256;
const EQUIP_TOOL_MAX_SLOT = 36;

function fail(code) {
  throw new Error(`stardew_equip_tool_control_result_${code}`);
}

function exactRecord(value, keys, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.size || actual.some((key) => typeof key !== "string" || !keys.has(key))) fail(code);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail(code);
  }
}

function revision(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function slot(value, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > EQUIP_TOOL_MAX_SLOT) fail(code);
  return value;
}

function label(value, code) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > LABEL_MAX_BYTES) fail(code);
  return value;
}

/**
 * Consume only the bounded Host proof for a succeeded equip_tool control run.
 * This action-owned mapping deliberately receives no bridge, lifecycle, fixture,
 * process, or recovery authority and returns no Host-minted identity or proof data.
 */
export function verifyEquipToolControlProof({ start, result } = {}) {
  const validatedStart = validateControlRunStart(start);
  const validatedResult = validateControlRunResult(result);
  if (validatedResult.runId !== validatedStart.runId
    || validatedResult.correlationId !== validatedStart.correlationId) {
    fail("run_binding_mismatch");
  }
  if (validatedResult.actionOutcome !== "succeeded") fail("action_not_succeeded");

  const { binding, data } = validatedResult.proof;
  if (binding.actionId !== "equip_tool") fail("action_mismatch");
  exactRecord(data, PROOF_DATA_KEYS, "invalid_proof_data");
  if (data.reasonCode !== "tool_selected") fail("reason_code_mismatch");

  const expectedRevision = revision(data.expectedRevision, "invalid_expected_revision");
  const terminalRevision = revision(data.terminalRevision, "invalid_terminal_revision");
  const selectedSlot = slot(data.slot, "invalid_slot");
  const before = label(data.before, "invalid_before");
  const expected = label(data.expected, "invalid_expected");
  const after = label(data.after, "invalid_after");
  if (terminalRevision <= expectedRevision) fail("revision_mismatch");
  if (before === expected || after !== expected) fail("postcondition_mismatch");

  // The verifier consumes the binding to ensure Host-minted action identities
  // exist and are non-empty (the protocol validates them), but does not project
  // them across the Stardew adapter boundary.
  if (binding.requestId.length === 0 || binding.executionId.length === 0 || selectedSlot < 0) fail("invalid_proof_binding");

  return Object.freeze({
    actionId: "equip_tool",
    runId: validatedStart.runId,
    correlationId: validatedStart.correlationId,
    verified: true,
  });
}

/**
 * Produce the adapter-safe, bounded control outcome. Action, harness, and
 * cleanup facts remain separate; harness or cleanup settlement never invokes
 * the action verifier, and neither can manufacture action success.
 */
export function mapEquipToolControlRunResult({ start, result } = {}) {
  const validatedStart = validateControlRunStart(start);
  const validatedResult = validateControlRunResult(result);
  if (validatedResult.runId !== validatedStart.runId
    || validatedResult.correlationId !== validatedStart.correlationId) {
    fail("run_binding_mismatch");
  }

  const actionVerified = validatedResult.actionOutcome === "succeeded"
    ? verifyEquipToolControlProof({ start: validatedStart, result: validatedResult }).verified
    : false;
  const complete = actionVerified
    && validatedResult.harnessOutcome === "succeeded"
    && validatedResult.cleanupOutcome === "succeeded"
    && validatedResult.terminalCode === "succeeded";

  return Object.freeze({
    schema: "gamebuddy-stardew-equip-tool-control-outcome/v1",
    runId: validatedStart.runId,
    correlationId: validatedStart.correlationId,
    terminalCode: validatedResult.terminalCode,
    actionOutcome: validatedResult.actionOutcome,
    harnessOutcome: validatedResult.harnessOutcome,
    cleanupOutcome: validatedResult.cleanupOutcome,
    actionVerified,
    state: complete ? "PASSED" : "INCOMPLETE",
  });
}
