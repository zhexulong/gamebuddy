import { types } from "node:util";

const RECEIPT_KEYS = new Set(["state", "reasonCode", "hasEvidence", "request", "accepted", "terminal", "evidence"]);
const REQUEST_KEYS = new Set(["requestId", "idempotencyKey", "action", "args", "expectedRevision"]);
const ARGS_KEYS = new Set(["tool"]);
const IDENTITY_KEYS = new Set(["requestId", "executionId"]);
const TERMINAL_KEYS = new Set(["requestId", "executionId", "state", "reasonCode", "revision"]);
const EVIDENCE_KEYS = new Set(["tool", "before", "expected", "after"]);
const POSTCONDITION_KEYS = new Set(["revision", "currentTool", "expectedTool", "selected"]);
const SELECTED_KEYS = new Set(["tool", "resolvedLabel"]);
// Canonical equip_tool/v2 semantic tool selectors; slot stays Mod-private.
const TOOL_SELECTOR_VALUES = new Set([
  "axe",
  "pickaxe",
  "hoe",
  "watering_can",
  "fishing_rod",
  "weapon",
  "scythe",
  "shears",
  "milk_pail",
  "pan",
]);
const SUCCESS_REASON_CODES = new Set(["tool_equipped", "already_equipped"]);

function fail(code) {
  throw new Error(`stardew_equip_tool_scenario_result_${code}`);
}

function exactRecord(value, keys, code) {
  if (types.isProxy(value) || value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.size || ownKeys.some((key) => typeof key !== "string" || !keys.has(key))) fail(code);
}

function id(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) fail(code);
  return value;
}

function revision(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function toolSelector(value, code) {
  if (typeof value !== "string" || !TOOL_SELECTOR_VALUES.has(value)) fail(code);
  return value;
}

function label(value, code) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 256) fail(code);
  return value;
}

/** Enforce the exact equip_tool proof only for a claimed passing scenario. */
export function validateEquipToolScenarioProof(result) {
  if (result.verdict !== "passed") return result;

  exactRecord(result.receipt, RECEIPT_KEYS, "invalid_receipt_shape");
  exactRecord(result.receipt.request, REQUEST_KEYS, "invalid_request_shape");
  exactRecord(result.receipt.request.args, ARGS_KEYS, "invalid_args_shape");
  exactRecord(result.receipt.accepted, IDENTITY_KEYS, "invalid_accepted_shape");
  exactRecord(result.receipt.terminal, TERMINAL_KEYS, "invalid_terminal_shape");
  exactRecord(result.receipt.evidence, EVIDENCE_KEYS, "invalid_evidence_shape");
  exactRecord(result.postcondition, POSTCONDITION_KEYS, "invalid_postcondition_shape");
  exactRecord(result.postcondition.selected, SELECTED_KEYS, "invalid_selected_shape");

  const request = result.receipt.request;
  const accepted = result.receipt.accepted;
  const terminal = result.receipt.terminal;
  const evidence = result.receipt.evidence;
  const postcondition = result.postcondition;

  id(request.requestId, "invalid_request_id");
  id(request.idempotencyKey, "invalid_idempotency_key");
  if (request.action !== "equip_tool") fail("action_mismatch");
  toolSelector(request.args.tool, "invalid_request_tool");
  revision(request.expectedRevision, "invalid_expected_revision");
  id(accepted.requestId, "invalid_accepted_request_id");
  id(accepted.executionId, "invalid_accepted_execution_id");
  id(terminal.requestId, "invalid_terminal_request_id");
  id(terminal.executionId, "invalid_terminal_execution_id");
  revision(terminal.revision, "invalid_terminal_revision");
  toolSelector(evidence.tool, "invalid_evidence_tool");
  label(evidence.before, "invalid_evidence_before");
  label(evidence.expected, "invalid_evidence_expected");
  label(evidence.after, "invalid_evidence_after");
  revision(postcondition.revision, "invalid_postcondition_revision");
  toolSelector(postcondition.selected.tool, "invalid_selected_tool");
  label(postcondition.selected.resolvedLabel, "invalid_selected_resolved_label");
  label(postcondition.currentTool, "invalid_current_tool");
  label(postcondition.expectedTool, "invalid_expected_tool");

  if (result.receipt.state !== "succeeded" || !SUCCESS_REASON_CODES.has(result.receipt.reasonCode) || result.receipt.hasEvidence !== true) fail("non_authoritative_terminal");
  if (terminal.state !== "succeeded" || !SUCCESS_REASON_CODES.has(terminal.reasonCode)) fail("non_authoritative_terminal");
  if (accepted.requestId !== request.requestId || terminal.requestId !== request.requestId) fail("request_id_mismatch");
  if (terminal.executionId !== accepted.executionId) fail("execution_id_mismatch");
  if (terminal.revision <= request.expectedRevision || postcondition.revision !== terminal.revision) fail("revision_mismatch");
  if (evidence.tool !== request.args.tool || postcondition.selected.tool !== request.args.tool) fail("selector_mismatch");
  if (evidence.expected !== postcondition.selected.resolvedLabel || evidence.after !== evidence.expected || postcondition.currentTool !== evidence.expected || postcondition.expectedTool !== evidence.expected) fail("tool_mismatch");
  if (!SUCCESS_REASON_CODES.has(result.reasonCode)) fail("reason_code_mismatch");
  return result;
}
