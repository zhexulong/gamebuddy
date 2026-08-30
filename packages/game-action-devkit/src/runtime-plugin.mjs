const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DEFAULT_DEADLINE_MS = 120_000;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_EVIDENCE_LENGTH = 2048;
const MAX_TARGETS = 64;
const MAX_ACTIONS_PER_TARGET = 128;

const API = "gamebuddy-game-runtime-plugin/v1";
const ADMISSION_SCHEMA = "gamebuddy-game-runtime-plugin-admission/v1";
const BLOCKED_SCHEMA = "gamebuddy-game-runtime-plugin-target-blocked/v1";
const SESSION_SCHEMA = "gamebuddy-game-runtime-plugin-session-op/v1";
const RECEIPT_SCHEMA = "gamebuddy-game-runtime-plugin-receipt/v1";
const POSTCONDITION_SCHEMA = "gamebuddy-game-runtime-plugin-postcondition/v1";
const CLEANUP_SCHEMA = "gamebuddy-game-runtime-plugin-cleanup/v1";
const OUTCOME_SCHEMA = "gamebuddy-game-runtime-plugin-outcome/v1";

const SENSITIVE_FIELDS = new Set([
  "pipe", "token", "client", "receipts", "receiptBuffer", "scriptPath", "backupPath",
  "bundlePath", "profilePath", "executablePath", "command", "script", "path", "cwd",
  "argv", "shell", "exec", "spawn", "fork", "process", "child", "stdin", "stdout",
  "stderr", "socket", "connection", "credential", "credentials",
]);
const RECEIPT_STATES = new Set(["succeeded", "blocked", "uncertain"]);
const POSTCONDITION_STATES = new Set(["verified", "not_verified", "not_applicable"]);
const CLEANUP_STATES = new Set(["complete", "incomplete", "not_started", "quarantined"]);
const ACTION_KEYS = new Set(["actionId", "verifier"]);
const OPTION_KEYS = new Set(["gameId", "targets"]);
const TARGET_KEYS = new Set(["targetId", "targetVersion", "actions"]);
const RUNNER_KEYS = new Set(["actionId", "runId", "execute"]);
const RESULT_KEYS = new Set(["receipt", "postcondition", "cleanup"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasSensitiveField(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => hasSensitiveField(entry, seen));
  let keys;
  try { keys = Object.keys(value); } catch { return true; }
  if (keys.some((key) => SENSITIVE_FIELDS.has(key))) return true;
  return keys.some((key) => {
    try { return hasSensitiveField(value[key], seen); } catch { return true; }
  });
}

function freezeDeep(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function exactKeys(value, allowed, code) {
  if (!isObject(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`game_runtime_plugin_${code}`);
  }
}

function identifier(value, code) {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`game_runtime_plugin_${code}`);
  }
  return value;
}

function boundedIdentifier(value) {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value) ? value : null;
}

function boundedText(value, code, { nullable = false, maxLength = MAX_EVIDENCE_LENGTH } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length === 0 || [...value].length > maxLength) {
    throw new TypeError(`game_runtime_plugin_${code}`);
  }
  return value;
}

function assertSerializedWithinBound(value, code = "output_too_large") {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw new TypeError("game_runtime_plugin_output_invalid"); }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_OUTPUT_BYTES) {
    throw new TypeError(`game_runtime_plugin_${code}`);
  }
}

function blockedReport(code, input) {
  return freezeDeep({
    schema: BLOCKED_SCHEMA,
    blocked: true,
    code,
    targetId: boundedIdentifier(input?.targetId),
    actionId: boundedIdentifier(input?.actionId),
    runId: boundedIdentifier(input?.runId),
  });
}

function cleanup(state, code) {
  return freezeDeep({ schema: CLEANUP_SCHEMA, state, code });
}

function failure(phase, code) {
  return Object.freeze({ phase, code });
}

function makeOutcome({ gameId, facts, actionId, runId, state, verdict, receipt = null, postcondition = null, cleanupState, error = null }) {
  const result = {
    schema: OUTCOME_SCHEMA,
    gameId,
    targetId: facts?.targetId ?? null,
    targetVersion: facts?.targetVersion ?? null,
    actionId: actionId ?? null,
    runId: runId ?? null,
    state,
    verdict,
    receipt,
    postcondition,
    cleanup: cleanupState,
    failure: error,
  };
  assertSerializedWithinBound(result);
  return freezeDeep(result);
}

function normalizeVerifier(value) {
  if (!isObject(value) || hasSensitiveField(value)
    || Object.keys(value).length !== 2
    || Object.keys(value).some((key) => !new Set(["admit", "verify"]).has(key))
    || typeof value.admit !== "function" || typeof value.verify !== "function") return null;
  return Object.freeze({ admit: value.admit, verify: value.verify });
}

function normalizeAction(action) {
  exactKeys(action, ACTION_KEYS, "action_invalid");
  if (hasSensitiveField(action)) throw new TypeError("game_runtime_plugin_sensitive_field");
  return Object.freeze({
    actionId: identifier(action.actionId, "invalid_action_id"),
    verifier: normalizeVerifier(action.verifier),
  });
}

function normalizeTarget(target) {
  exactKeys(target, TARGET_KEYS, "target_invalid");
  if (hasSensitiveField(target)) throw new TypeError("game_runtime_plugin_sensitive_field");
  if (!Array.isArray(target.actions) || target.actions.length === 0 || target.actions.length > MAX_ACTIONS_PER_TARGET) {
    throw new TypeError("game_runtime_plugin_invalid_actions");
  }
  const normalized = Object.freeze({
    targetId: identifier(target.targetId, "invalid_target_id"),
    targetVersion: identifier(target.targetVersion, "invalid_target_version"),
    actions: Object.freeze(target.actions.map(normalizeAction)),
  });
  const actionIds = normalized.actions.map(({ actionId }) => actionId);
  if (new Set(actionIds).size !== actionIds.length) throw new TypeError("game_runtime_plugin_duplicate_action");
  return normalized;
}

function normalizeRunner(actionRunner) {
  if (!isObject(actionRunner) || hasSensitiveField(actionRunner)) return { ok: false, code: "INVALID_RUNNER" };
  const keys = Object.keys(actionRunner);
  if (keys.length !== RUNNER_KEYS.size || keys.some((key) => !RUNNER_KEYS.has(key))) {
    return { ok: false, code: "INVALID_RUNNER" };
  }
  if (typeof actionRunner.execute !== "function") return { ok: false, code: "INVALID_RUNNER" };
  try {
    return {
      ok: true,
      actionId: identifier(actionRunner.actionId, "invalid_action_id"),
      runId: identifier(actionRunner.runId, "invalid_run_id"),
      execute: actionRunner.execute,
    };
  } catch {
    return { ok: false, code: "INVALID_RUNNER" };
  }
}

function normalizeReceipt(value) {
  exactKeys(value, new Set(["state", "code", "evidence"]), "receipt_invalid");
  if (hasSensitiveField(value) || !RECEIPT_STATES.has(value.state)) throw new TypeError("game_runtime_plugin_receipt_invalid");
  return freezeDeep({
    schema: RECEIPT_SCHEMA,
    state: value.state,
    code: identifier(value.code, "receipt_invalid_code"),
    evidence: value.evidence === null ? null : boundedText(value.evidence, "receipt_invalid_evidence"),
  });
}

function normalizePostcondition(value) {
  exactKeys(value, new Set(["state", "code", "evidence"]), "postcondition_invalid");
  if (hasSensitiveField(value) || !POSTCONDITION_STATES.has(value.state)) {
    throw new TypeError("game_runtime_plugin_postcondition_invalid");
  }
  return freezeDeep({
    schema: POSTCONDITION_SCHEMA,
    state: value.state,
    code: value.code === null ? null : identifier(value.code, "postcondition_invalid_code"),
    evidence: value.evidence === null ? null : boundedText(value.evidence, "postcondition_invalid_evidence"),
  });
}

function normalizeCleanup(value) {
  exactKeys(value, new Set(["state", "code"]), "cleanup_invalid");
  if (hasSensitiveField(value) || !CLEANUP_STATES.has(value.state)) {
    throw new TypeError("game_runtime_plugin_cleanup_invalid");
  }
  return freezeDeep({
    schema: CLEANUP_SCHEMA,
    state: value.state,
    code: value.code === null ? null : identifier(value.code, "cleanup_invalid_code"),
  });
}

function normalizeRunnerResult(value) {
  exactKeys(value, RESULT_KEYS, "output_invalid");
  if (hasSensitiveField(value)) throw new TypeError("game_runtime_plugin_sensitive_field");
  const normalized = {
    receipt: normalizeReceipt(value.receipt),
    postcondition: normalizePostcondition(value.postcondition),
    cleanup: normalizeCleanup(value.cleanup),
  };
  assertSerializedWithinBound(normalized);
  return normalized;
}

function verifierAllows(value) {
  return value === true || (isObject(value) && value.ok === true);
}

function createSession() {
  let consumed = false;
  let closed = false;
  function observeFresh() {
    if (closed) return Object.freeze({ schema: SESSION_SCHEMA, ok: false, operation: "observe", code: "SESSION_CLOSED" });
    return Object.freeze({ schema: SESSION_SCHEMA, ok: true, operation: "observe", state: "unavailable" });
  }
  function executeOnce() {
    if (closed) return Object.freeze({ schema: SESSION_SCHEMA, ok: false, operation: "execute", code: "SESSION_CLOSED" });
    if (consumed) return Object.freeze({ schema: SESSION_SCHEMA, ok: false, operation: "execute", code: "SESSION_CONSUMED" });
    consumed = true;
    return Object.freeze({ schema: SESSION_SCHEMA, ok: false, operation: "execute", code: "NOT_WIRED" });
  }
  function close() {
    closed = true;
  }
  return Object.freeze({ observeFresh, executeOnce, close });
}

export const GAME_RUNTIME_PLUGIN_API = API;

export function createGameRuntimePlugin(options) {
  exactKeys(options, OPTION_KEYS, "invalid_options");
  if (hasSensitiveField(options)) throw new TypeError("game_runtime_plugin_sensitive_field");
  const gameId = identifier(options.gameId, "invalid_game_id");
  if (!Array.isArray(options.targets) || options.targets.length === 0 || options.targets.length > MAX_TARGETS) {
    throw new TypeError("game_runtime_plugin_invalid_targets");
  }
  const targets = options.targets.map(normalizeTarget);
  const targetById = new Map();
  for (const target of targets) {
    if (targetById.has(target.targetId)) throw new TypeError("game_runtime_plugin_duplicate_target");
    targetById.set(target.targetId, target);
  }
  const admissions = new WeakSet();
  const factsByAdmission = new WeakMap();
  const consumedAdmissions = new WeakSet();
  let closed = false;

  function inspectTarget(input) {
    if (!isObject(input)) return Object.freeze({ blocked: true, report: blockedReport("INVALID_INPUT", input) });
    if (hasSensitiveField(input)) return Object.freeze({ blocked: true, report: blockedReport("SENSITIVE_FIELD", input) });
    const allowed = new Set(["targetId", "targetVersion", "actionId", "runId", "deadlineMs"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) {
      return Object.freeze({ blocked: true, report: blockedReport("INVALID_INPUT", input) });
    }
    if (closed) return Object.freeze({ blocked: true, report: blockedReport("PLUGIN_CLOSED", input) });
    const { targetId, targetVersion, actionId, runId } = input;
    if (typeof targetId !== "string" || typeof targetVersion !== "string" || typeof actionId !== "string") {
      return Object.freeze({ blocked: true, report: blockedReport("INVALID_INPUT", input) });
    }
    if (typeof runId !== "string" || !IDENTIFIER_PATTERN.test(runId)) {
      return Object.freeze({ blocked: true, report: blockedReport("INVALID_RUN_ID", input) });
    }
    const deadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > DEFAULT_DEADLINE_MS) {
      return Object.freeze({ blocked: true, report: blockedReport("INVALID_DEADLINE", input) });
    }
    const target = targetById.get(targetId);
    if (!target || target.targetVersion !== targetVersion) {
      return Object.freeze({ blocked: true, report: blockedReport("UNKNOWN_TARGET", input) });
    }
    const action = target.actions.find((candidate) => candidate.actionId === actionId);
    if (!action) return Object.freeze({ blocked: true, report: blockedReport("UNSUPPORTED_ACTION", input) });
    if (!action.verifier) return Object.freeze({ blocked: true, report: blockedReport("VERIFIER_REQUIRED", input) });
    let admitted;
    try {
      admitted = action.verifier.admit(Object.freeze({ targetId, targetVersion, actionId, runId, deadlineMs }));
    } catch {
      return Object.freeze({ blocked: true, report: blockedReport("VERIFIER_REJECTED", input) });
    }
    if (!verifierAllows(admitted)) return Object.freeze({ blocked: true, report: blockedReport("VERIFIER_REJECTED", input) });

    const admission = Object.freeze({});
    const facts = Object.freeze({ gameId, targetId, targetVersion, actionId, runId, deadlineMs, verifier: action.verifier });
    admissions.add(admission);
    factsByAdmission.set(admission, facts);
    return Object.freeze({
      blocked: false,
      admission,
      summary: freezeDeep({ schema: ADMISSION_SCHEMA, gameId, targetId, targetVersion, actionId, runId, deadlineMs }),
    });
  }

  function consume(admission, actionId, runId) {
    if (closed) return { ok: false, code: "PLUGIN_CLOSED" };
    if (!admission || typeof admission !== "object" || !admissions.has(admission)) return { ok: false, code: "INVALID_ADMISSION" };
    if (consumedAdmissions.has(admission)) return { ok: false, code: "ADMISSION_CONSUMED" };
    const facts = factsByAdmission.get(admission);
    if (facts.actionId !== actionId) return { ok: false, code: "WRONG_ACTION" };
    if (facts.runId !== runId) return { ok: false, code: "WRONG_RUN" };
    consumedAdmissions.add(admission);
    return { ok: true, facts };
  }

  function run({ admission, actionRunner } = {}) {
    const runner = normalizeRunner(actionRunner);
    if (!runner.ok) {
      return makeOutcome({ gameId, cleanupState: cleanup("not_started", "ADMISSION_NOT_CONSUMED"), state: "INCOMPLETE", verdict: "uncertain", error: failure("admission", runner.code) });
    }
    const consumed = consume(admission, runner.actionId, runner.runId);
    if (!consumed.ok) {
      return makeOutcome({ gameId, actionId: runner.actionId, runId: runner.runId, cleanupState: cleanup("not_started", "ADMISSION_NOT_CONSUMED"), state: "INCOMPLETE", verdict: "uncertain", error: failure("admission", consumed.code) });
    }
    const session = createSession();
    let rawResult;
    try { rawResult = runner.execute(session); } catch {
      session.close();
      return makeOutcome({ gameId, facts: consumed.facts, actionId: runner.actionId, runId: runner.runId, cleanupState: cleanup("incomplete", "RUNNER_ERROR"), state: "INCOMPLETE", verdict: "uncertain", error: failure("runner", "RUNNER_ERROR") });
    }
    session.close();
    if (rawResult && typeof rawResult.then === "function") {
      return makeOutcome({ gameId, facts: consumed.facts, actionId: runner.actionId, runId: runner.runId, cleanupState: cleanup("incomplete", "ASYNC_RUNNER_UNSUPPORTED"), state: "INCOMPLETE", verdict: "uncertain", error: failure("runner", "ASYNC_RUNNER_UNSUPPORTED") });
    }
    let result;
    try { result = normalizeRunnerResult(rawResult); } catch {
      return makeOutcome({ gameId, facts: consumed.facts, actionId: runner.actionId, runId: runner.runId, cleanupState: cleanup("incomplete", "OUTPUT_INVALID"), state: "INCOMPLETE", verdict: "uncertain", error: failure("output", "OUTPUT_INVALID") });
    }
    if (result.cleanup.state !== "complete") {
      return makeOutcome({ gameId, facts: consumed.facts, actionId: runner.actionId, runId: runner.runId, ...result, cleanupState: result.cleanup, state: "INCOMPLETE", verdict: "uncertain", error: failure("cleanup", "CLEANUP_INCOMPLETE") });
    }
    let verified = false;
    try { verified = verifierAllows(consumed.facts.verifier.verify(Object.freeze(result))); } catch { verified = false; }
    if (result.receipt.state === "succeeded"
      && result.receipt.evidence !== null
      && result.postcondition.state === "verified"
      && result.postcondition.evidence !== null
      && verified) {
      return makeOutcome({ gameId, facts: consumed.facts, actionId: runner.actionId, runId: runner.runId, ...result, cleanupState: result.cleanup, state: "PASSED", verdict: "passed" });
    }
    if (result.receipt.state === "blocked") {
      return makeOutcome({ gameId, facts: consumed.facts, actionId: runner.actionId, runId: runner.runId, ...result, cleanupState: result.cleanup, state: "BLOCKED", verdict: "blocked" });
    }
    return makeOutcome({ gameId, facts: consumed.facts, actionId: runner.actionId, runId: runner.runId, ...result, cleanupState: result.cleanup, state: "INCOMPLETE", verdict: "uncertain", error: failure("execution", "POSTCONDITION_UNVERIFIED") });
  }

  function close() { closed = true; }
  return Object.freeze({ inspectTarget, run, close });
}
