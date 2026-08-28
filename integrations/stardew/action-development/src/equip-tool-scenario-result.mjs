import { types } from "node:util";

const RECEIPT_KEYS = new Set(["state", "reasonCode", "hasEvidence", "request", "accepted", "terminal", "evidence"]);
const REQUEST_KEYS = new Set(["requestId", "idempotencyKey", "action", "args", "expectedRevision"]);
const ARGS_KEYS = new Set(["slot"]);
const IDENTITY_KEYS = new Set(["requestId", "executionId"]);
const TERMINAL_KEYS = new Set(["requestId", "executionId", "state", "reasonCode", "revision"]);
const EVIDENCE_KEYS = new Set(["slot", "before", "expected", "after"]);
const POSTCONDITION_KEYS = new Set(["revision", "currentTool", "expectedTool", "selected"]);
const SELECTED_KEYS = new Set(["slot", "label"]);

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

function slot(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
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
  slot(request.args.slot, "invalid_request_slot");
  revision(request.expectedRevision, "invalid_expected_revision");
  id(accepted.requestId, "invalid_accepted_request_id");
  id(accepted.executionId, "invalid_accepted_execution_id");
  id(terminal.requestId, "invalid_terminal_request_id");
  id(terminal.executionId, "invalid_terminal_execution_id");
  revision(terminal.revision, "invalid_terminal_revision");
  slot(evidence.slot, "invalid_evidence_slot");
  label(evidence.before, "invalid_evidence_before");
  label(evidence.expected, "invalid_evidence_expected");
  label(evidence.after, "invalid_evidence_after");
  revision(postcondition.revision, "invalid_postcondition_revision");
  slot(postcondition.selected.slot, "invalid_selected_slot");
  label(postcondition.selected.label, "invalid_selected_label");
  label(postcondition.currentTool, "invalid_current_tool");
  label(postcondition.expectedTool, "invalid_expected_tool");

  if (result.receipt.state !== "succeeded" || result.receipt.reasonCode !== "tool_selected" || result.receipt.hasEvidence !== true) fail("non_authoritative_terminal");
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "tool_selected") fail("non_authoritative_terminal");
  if (accepted.requestId !== request.requestId || terminal.requestId !== request.requestId) fail("request_id_mismatch");
  if (terminal.executionId !== accepted.executionId) fail("execution_id_mismatch");
  if (terminal.revision <= request.expectedRevision || postcondition.revision !== terminal.revision) fail("revision_mismatch");
  if (evidence.slot !== request.args.slot || postcondition.selected.slot !== request.args.slot) fail("slot_mismatch");
  if (evidence.expected !== postcondition.selected.label || evidence.after !== evidence.expected || postcondition.currentTool !== evidence.expected || postcondition.expectedTool !== evidence.expected) fail("tool_mismatch");
  if (result.reasonCode !== "tool_selected") fail("reason_code_mismatch");
  return result;
}
