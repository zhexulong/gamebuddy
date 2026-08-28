import { types } from "node:util";
import { parseJsonWithoutDuplicateKeys } from "./json-text.mjs";
import { validateEquipToolScenarioProof } from "./equip-tool-scenario-result.mjs";

const SCHEMA = "gamebuddy-action-scenario-result/v1";
const KEYS = new Set([
  "schema",
  "runId",
  "gameId",
  "actionId",
  "stage",
  "profileIdentity",
  "claimScope",
  "receipt",
  "postcondition",
  "verdict",
  "reasonCode",
]);
const IDENTITY_KEYS = new Set(["gameId", "actionId", "runId", "stage", "profileIdentity", "claimScope"]);
const FORBIDDEN_PAYLOAD_KEYS = new Set(["authorization", "credential", "endpoint", "password", "rawoutput", "secret", "stderr", "stdout", "token"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PAYLOAD_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_PAYLOAD_DEPTH = 8;
const MAX_PAYLOAD_ITEMS = 64;
const MAX_PAYLOAD_STRING_BYTES = 8 * 1024;

function fail(code) {
  throw new Error(`stardew_action_scenario_result_${code}`);
}

function opaque(value, code) {
  if (typeof value !== "string" || !ID.test(value)) fail(code);
  return value;
}

function exactDataRecord(value, allowedKeys, code) {
  if (types.isProxy(value) || value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowedKeys.size || keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))) fail(code);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail(code);
  }
}

function safePayload(value, depth = 0) {
  if (depth > MAX_PAYLOAD_DEPTH) fail("invalid_payload");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_payload");
    return value;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_PAYLOAD_STRING_BYTES) fail("invalid_payload");
    return value;
  }
  if (types.isProxy(value) || typeof value !== "object") fail("invalid_payload");
  if (Array.isArray(value)) {
    if (value.length > MAX_PAYLOAD_ITEMS) fail("invalid_payload");
    return Object.freeze(value.map((item) => safePayload(item, depth + 1)));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) fail("invalid_payload");
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_PAYLOAD_ITEMS || keys.some((key) => typeof key !== "string" || !PAYLOAD_KEY.test(key) || FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase()))) fail("invalid_payload");
  const output = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("invalid_payload");
    output[key] = safePayload(descriptor.value, depth + 1);
  }
  return Object.freeze(output);
}

function expectedIdentity(value) {
  exactDataRecord(value, IDENTITY_KEYS, "invalid_expected_identity");
  const normalized = {};
  for (const key of IDENTITY_KEYS) normalized[key] = opaque(value[key], `invalid_expected_${key}`);
  return Object.freeze(normalized);
}

export function validateScenarioResult(input, expected) {
  exactDataRecord(input, KEYS, "invalid_shape");
  if (input.schema !== SCHEMA) fail("invalid_schema");
  const result = Object.freeze({
    schema: SCHEMA,
    runId: opaque(input.runId, "invalid_run_id"),
    gameId: opaque(input.gameId, "invalid_game_id"),
    actionId: opaque(input.actionId, "invalid_action_id"),
    stage: opaque(input.stage, "invalid_stage"),
    profileIdentity: opaque(input.profileIdentity, "invalid_profile_identity"),
    claimScope: opaque(input.claimScope, "invalid_claim_scope"),
    receipt: safePayload(input.receipt),
    postcondition: safePayload(input.postcondition),
    verdict: input.verdict,
    reasonCode: opaque(input.reasonCode, "invalid_reason_code"),
  });
  if (result.verdict !== "passed" && result.verdict !== "failed") fail("invalid_verdict");
  const identity = expectedIdentity(expected);
  for (const key of IDENTITY_KEYS) {
    if (result[key] !== identity[key]) fail("identity_mismatch");
  }
  return result;
}

export function parseScenarioResultText(text, expected) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") === 0 || Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) fail("invalid_size");
  const result = validateScenarioResult(parseJsonWithoutDuplicateKeys(text, "stardew_action_scenario_result"), expected);
  return result.actionId === "equip_tool" && result.stage === "run-live" && result.claimScope === "native-local-equip-tool-v1"
    ? validateEquipToolScenarioProof(result)
    : result;
}

export { MAX_RESULT_BYTES };
