import { readGeneratedEquipToolContract } from "./contract-export.mjs";
import { validateActionContractEquipTool } from "./action-contract.mjs";
import { preflightEquipTool } from "./equip-tool-preflight.mjs";
import {
  readEquipToolLiveStatus,
  runEquipToolLive,
  verifyEquipToolCleanup,
  verifyEquipToolReceiptEvidencePostcondition,
} from "./equip-tool-live.mjs";

const ACTION_ID_PATTERN = /^[a-z][a-z0-9_]{1,127}$/;
const REQUIRED_HANDLERS = Object.freeze([
  "check",
  "preflight",
  "status",
  "verifyContract",
  "verifyReceiptEvidencePostcondition",
  "verifyCleanup",
]);

function fail(code) {
  throw new Error(`stardew_action_registration_${code}`);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function actionIdentity(actionId, value, code = "identity_mismatch") {
  if (!object(value) || value.gameId !== "stardew" || value.actionId !== actionId) fail(code);
}

function runIdentity(actionId, invocation, value, code = "identity_mismatch") {
  actionIdentity(actionId, value, code);
  if (value.runId !== invocation.runId) fail(code);
}

function exactVerifierResult(value, keys, code) {
  if (!object(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string") || keys.some((key) => !ownKeys.includes(key))) fail(code);
  return value;
}

export function validateVerifierResult(kind, { actionId, invocation, result } = {}) {
  if (kind !== "contract" && kind !== "receipt" && kind !== "cleanup") fail("verifier_kind_invalid");
  const invalidResultCode = kind === "cleanup"
    ? "cleanup_verification_result_invalid"
    : kind === "receipt" ? "receipt_verification_result_invalid" : "contract_verification_result_invalid";
  const identityCode = kind === "cleanup"
    ? "cleanup_verifier_identity_mismatch"
    : kind === "receipt" ? "receipt_verifier_identity_mismatch" : "contract_verifier_identity_mismatch";
  const incompleteCode = kind === "cleanup"
    ? "cleanup_incomplete"
    : kind === "receipt" ? "receipt_evidence_postcondition_invalid" : "contract_verification_invalid";
  if (kind === "contract") {
    exactVerifierResult(result, ["gameId", "actionId", "verified"], invalidResultCode);
    actionIdentity(actionId, result, identityCode);
    if (result.verified !== true) fail(incompleteCode);
    return Object.freeze({ gameId: "stardew", actionId, verified: true });
  }
  if (!invocation || typeof invocation.runId !== "string" || invocation.runId.length === 0) fail("verifier_input_invalid");
  const keys = kind === "cleanup" ? ["gameId", "actionId", "runId", "complete"] : ["gameId", "actionId", "runId", "verified"];
  exactVerifierResult(result, keys, invalidResultCode);
  runIdentity(actionId, invocation, result, identityCode);
  if (kind === "cleanup" ? result.complete !== true : result.verified !== true) fail(incompleteCode);
  return Object.freeze({ gameId: "stardew", actionId, runId: invocation.runId, ...(kind === "cleanup" ? { complete: true } : { verified: true }) });
}

function verifyContractResult(actionId, result) {
  return validateVerifierResult("contract", { actionId, result });
}

async function verifyLiveResult(actionId, invocation, result) {
  let verified;
  try { verified = await verifyEquipToolReceiptEvidencePostcondition({ actionId, invocation, result }); } catch { fail("receipt_evidence_postcondition_invalid"); }
  return validateVerifierResult("receipt", { actionId, invocation, result: verified });
}

async function verifyCleanupResult(actionId, invocation, result) {
  let verified;
  try { verified = await verifyEquipToolCleanup({ actionId, invocation, result }); } catch { fail("cleanup_incomplete"); }
  return validateVerifierResult("cleanup", { actionId, invocation, result: verified });
}

async function checkEquipTool({ actionId, dependencies } = {}) {
  if (actionId !== "equip_tool") fail("identity_mismatch");
  let generated;
  try {
    generated = await (dependencies?.readGeneratedEquipToolContract ?? readGeneratedEquipToolContract)();
    validateActionContractEquipTool(JSON.parse(generated.toString("utf8")));
  } catch {
    fail("contract_invalid");
  }
  return Object.freeze({ gameId: "stardew", actionId, verified: true });
}

async function runEquipToolRegistration(input = {}) {
  return runEquipToolLive(input);
}

const equipToolActionRegistration = Object.freeze({
  actionId: "equip_tool",
  check: checkEquipTool,
  preflight: preflightEquipTool,
  status: readEquipToolLiveStatus,
  runLive: runEquipToolRegistration,
  verifyContract: async ({ actionId, result }) => verifyContractResult(actionId, result),
  verifyReceiptEvidencePostcondition: async ({ actionId, invocation, result }) => verifyLiveResult(actionId, invocation, result),
  verifyCleanup: async ({ actionId, invocation, result }) => verifyCleanupResult(actionId, invocation, result),
});

export const ACTION_REGISTRATIONS = Object.freeze([equipToolActionRegistration]);
export const ACTION_REGISTRATION_MANIFEST = Object.freeze({
  schema: "gamebuddy-stardew-action-registration/v1",
  gameId: "stardew",
  actionIds: Object.freeze(ACTION_REGISTRATIONS.map(({ actionId }) => actionId)),
});

function normalizeRegistrations(registrations) {
  if (registrations instanceof Map) return [...registrations.values()];
  if (Array.isArray(registrations)) return registrations;
  if (object(registrations)) return Object.values(registrations);
  fail("registry_invalid");
}

export function validateActionRegistration(registration) {
  if (!object(registration) || typeof registration.actionId !== "string" || !ACTION_ID_PATTERN.test(registration.actionId)) {
    fail("invalid_registration");
  }
  for (const name of REQUIRED_HANDLERS) {
    if (typeof registration[name] !== "function") {
      fail(`${name.startsWith("verify") ? "required_verifier_missing" : "required_handler_missing"}:${name}`);
    }
  }
  if (registration.runLive !== undefined && typeof registration.runLive !== "function") fail("invalid_run_live");
  if (registration.blockedPolicy !== undefined) {
    if (!object(registration.blockedPolicy)
      || Object.keys(registration.blockedPolicy).length !== 2
      || !Object.hasOwn(registration.blockedPolicy, "state")
      || !Object.hasOwn(registration.blockedPolicy, "reasonCode")
      || registration.blockedPolicy.state !== "BLOCKED"
      || typeof registration.blockedPolicy.reasonCode !== "string"
      || registration.blockedPolicy.reasonCode.length === 0) {
      fail("invalid_blocked_policy");
    }
    if (registration.runLive !== undefined) fail("run_live_and_blocked_policy_conflict");
  }
  if (registration.runLive === undefined && registration.blockedPolicy === undefined) fail("required_handler_missing:runLive");
  return registration;
}

export function createActionRegistry(registrations = ACTION_REGISTRATIONS) {
  const entries = normalizeRegistrations(registrations).map(validateActionRegistration);
  if (entries.some((entry) => entry === undefined)) fail("registry_invalid");
  const byActionId = new Map();
  for (const registration of entries) {
    if (byActionId.has(registration.actionId)) fail(`duplicate_action_id:${registration.actionId}`);
    byActionId.set(registration.actionId, registration);
  }
  return Object.freeze({
    get(actionId) {
      if (typeof actionId !== "string") return undefined;
      return byActionId.get(actionId);
    },
    has(actionId) {
      return byActionId.has(actionId);
    },
    entries: Object.freeze([...entries]),
  });
}

export const ACTION_REGISTRY = createActionRegistry();

export function resolveActionRegistration(actionId, registrations = ACTION_REGISTRY) {
  const registry = registrations?.get instanceof Function && registrations?.entries !== undefined
    ? registrations
    : createActionRegistry(registrations);
  const registration = registry.get(actionId);
  if (!registration) fail("action_not_available");
  return validateActionRegistration(registration);
}

export { REQUIRED_HANDLERS, equipToolActionRegistration };
