import { types } from "node:util";
import { parseJsonWithoutDuplicateKeys } from "./json-text.mjs";

const START_KEYS = new Set(["protocolVersion", "runId", "correlationId", "scenarioId", "deadlineEpochMs", "cancellationId"]);
const RESULT_KEYS = new Set(["protocolVersion", "runId", "correlationId", "terminalCode", "actionOutcome", "harnessOutcome", "cleanupOutcome", "proof", "cleanupFacts"]);
const PROOF_KEYS = new Set(["issuer", "binding", "data"]);
const PROOF_BINDING_KEYS = new Set(["runId", "correlationId", "requestId", "executionId", "actionId"]);
const TERMINAL_CODES = new Set(["succeeded", "blocked", "cancelled", "deadline_exceeded", "protocol_error", "child_exit", "supervisor_closed", "recovery_incomplete"]);
const ACTION_OUTCOMES = new Set(["succeeded", "failed", "not_started", "indeterminate"]);
const HARNESS_OUTCOMES = new Set(["succeeded", "failed", "cancelled", "not_started"]);
const CLEANUP_OUTCOMES = new Set(["succeeded", "failed", "not_started"]);
const DATA_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FORBIDDEN_DATA_KEYS = new Set([
  "action", "actionid", "arguments", "authorization", "bridge", "bridgetoken", "cancellationid",
  "credential", "deadlineepochms", "endpoint", "envelope", "idempotencykey", "journal", "path",
  "pid", "pipe", "port", "profile", "receipt", "recovery", "requestid", "executionid", "revision", "session",
  "token",
]);
const MAX_ID_BYTES = 128;
const MAX_DATA_DEPTH = 8;
const MAX_DATA_ITEMS = 64;
const MAX_DATA_STRING_BYTES = 8 * 1024;
const MAX_CONTROL_MESSAGE_BYTES = 32_768;

function fail(code) {
  throw new Error(`stardew_control_protocol_${code}`);
}

function plainRecord(value, code) {
  if (types.isProxy(value) || value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
}

function exactRecord(value, keys, code) {
  plainRecord(value, code);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.size || ownKeys.some((key) => typeof key !== "string" || !keys.has(key))) fail(code);
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail(code);
  }
}

function opaqueId(value, code) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") === 0 || Buffer.byteLength(value, "utf8") > MAX_ID_BYTES) fail(code);
  return value;
}

function normalizedDataKey(key) {
  return key.replaceAll(/[_-]/g, "").toLowerCase();
}

function boundedArray(value, depth) {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value > MAX_DATA_ITEMS) fail("invalid_data");
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) fail("invalid_data");
  const output = [];
  for (let index = 0; index < length; index++) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail("invalid_data");
    output.push(boundedData(descriptor.value, depth + 1));
  }
  return Object.freeze(output);
}

function boundedData(value, depth = 0) {
  if (depth > MAX_DATA_DEPTH) fail("invalid_data");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_data");
    return value;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_DATA_STRING_BYTES) fail("invalid_data");
    return value;
  }
  if (types.isProxy(value) || typeof value !== "object") fail("invalid_data");
  if (Array.isArray(value)) return boundedArray(value, depth);
  plainRecord(value, "invalid_data");
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_DATA_ITEMS || keys.some((key) => typeof key !== "string" || !DATA_KEY.test(key) || FORBIDDEN_DATA_KEYS.has(normalizedDataKey(key)))) fail("invalid_data");
  const output = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("invalid_data");
    output[key] = boundedData(descriptor.value, depth + 1);
  }
  return Object.freeze(output);
}

function boundedRecord(value, code) {
  plainRecord(value, code);
  return boundedData(value);
}

function enumValue(value, allowed, code) {
  if (!allowed.has(value)) fail(code);
  return value;
}

function validateProof(value, runId, correlationId) {
  exactRecord(value, PROOF_KEYS, "invalid_proof");
  if (value.issuer !== "host_control_runner") fail("invalid_proof");
  exactRecord(value.binding, PROOF_BINDING_KEYS, "invalid_proof");
  const binding = Object.freeze({
    runId: opaqueId(value.binding.runId, "invalid_proof"),
    correlationId: opaqueId(value.binding.correlationId, "invalid_proof"),
    requestId: opaqueId(value.binding.requestId, "invalid_request_id"),
    executionId: opaqueId(value.binding.executionId, "invalid_execution_id"),
    actionId: value.binding.actionId,
  });
  if (binding.runId !== runId || binding.correlationId !== correlationId || binding.actionId !== "equip_tool") fail("invalid_proof");
  return Object.freeze({ issuer: "host_control_runner", binding, data: boundedRecord(value.data, "invalid_proof") });
}

function validateTerminalConsistency(terminalCode, actionOutcome) {
  if (terminalCode === "succeeded" && actionOutcome !== "succeeded") fail("invalid_terminal_action_outcome");
  if (terminalCode === "recovery_incomplete" && actionOutcome !== "indeterminate") fail("invalid_terminal_action_outcome");
  if (terminalCode !== "succeeded" && terminalCode !== "recovery_incomplete" && actionOutcome === "succeeded") fail("invalid_terminal_action_outcome");
}

function serialize(value) {
  const text = JSON.stringify(value);
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_CONTROL_MESSAGE_BYTES) fail("invalid_size");
  return text;
}

export function validateControlRunStart(input) {
  exactRecord(input, START_KEYS, "invalid_shape");
  if (input.protocolVersion !== 1) fail("invalid_protocol_version");
  if (input.scenarioId !== "equip_tool_control") fail("invalid_scenario_id");
  if (!Number.isSafeInteger(input.deadlineEpochMs) || input.deadlineEpochMs <= 0) fail("invalid_deadline");
  return Object.freeze({
    protocolVersion: 1,
    runId: opaqueId(input.runId, "invalid_run_id"),
    correlationId: opaqueId(input.correlationId, "invalid_correlation_id"),
    scenarioId: "equip_tool_control",
    deadlineEpochMs: input.deadlineEpochMs,
    cancellationId: opaqueId(input.cancellationId, "invalid_cancellation_id"),
  });
}

export function validateControlRunResult(input) {
  exactRecord(input, RESULT_KEYS, "invalid_shape");
  if (input.protocolVersion !== 1) fail("invalid_protocol_version");
  const runId = opaqueId(input.runId, "invalid_run_id");
  const correlationId = opaqueId(input.correlationId, "invalid_correlation_id");
  const terminalCode = enumValue(input.terminalCode, TERMINAL_CODES, "invalid_terminal_code");
  const actionOutcome = enumValue(input.actionOutcome, ACTION_OUTCOMES, "invalid_action_outcome");
  validateTerminalConsistency(terminalCode, actionOutcome);
  return Object.freeze({
    protocolVersion: 1,
    runId,
    correlationId,
    terminalCode,
    actionOutcome,
    harnessOutcome: enumValue(input.harnessOutcome, HARNESS_OUTCOMES, "invalid_harness_outcome"),
    cleanupOutcome: enumValue(input.cleanupOutcome, CLEANUP_OUTCOMES, "invalid_cleanup_outcome"),
    proof: validateProof(input.proof, runId, correlationId),
    cleanupFacts: boundedRecord(input.cleanupFacts, "invalid_cleanup_facts"),
  });
}

export function buildControlRunStart(input) {
  return serialize(validateControlRunStart(input));
}

export function buildControlRunResult(input) {
  return serialize(validateControlRunResult(input));
}

export function parseControlRunStartText(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") === 0 || Buffer.byteLength(text, "utf8") > MAX_CONTROL_MESSAGE_BYTES) fail("invalid_size");
  return validateControlRunStart(parseJsonWithoutDuplicateKeys(text, "stardew_control_protocol"));
}

export function parseControlRunResultText(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") === 0 || Buffer.byteLength(text, "utf8") > MAX_CONTROL_MESSAGE_BYTES) fail("invalid_size");
  return validateControlRunResult(parseJsonWithoutDuplicateKeys(text, "stardew_control_protocol"));
}

export { MAX_CONTROL_MESSAGE_BYTES };
