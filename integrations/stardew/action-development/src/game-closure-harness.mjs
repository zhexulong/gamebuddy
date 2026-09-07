// Game-neutral closure-harness role seam (design/98 cross-game contract).
// Contains no Stardew imports, phase vocabulary, or transport mechanics.
// A game project injects its own closure harness and its own scenario-result
// verifier; the helper correlates lifecycle completion, cleanup state, and
// scenario-result admission into one bounded outcome.

export const GAME_CLOSURE_HARNESS_RESULT_SCHEMA =
  "gamebuddy-game-closure-harness-result/v1";

const HARNESSED_FAILURE_PHASES = new Set([
  "harness",
  "input_validation",
  "timeout",
  "cleanup",
  "scenario",
]);
const HARNESSED_FAILURE_CODES = new Set(["harness_failed", "input_invalid", "harness_timeout", "cleanup_uncertain", "scenario_result_missing", "scenario_result_invalid"]);

function fail(code) {
  throw new Error(`game_closure_harness_${code}`);
}

function validatePositiveInt(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) fail("invalid_input");
}

function boundedFailureCode(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  if (message.startsWith("game_closure_harness_")) return message.slice("game_closure_harness_".length);
  if (message.startsWith("harness_timeout")) return "harness_timeout";
  return "harness_failed";
}

/**
 * Game-neutral orchestration helper. Accepts an injected game-owned closure
 * harness (`runHarness`) and an optional action-owned scenario-result verifier
 * (`verifyScenarioResult`). Returns one bounded outcome separating lifecycle
 * completion, cleanup state, and scenario-result admission. Never synthesizes
 * or validates action proof directly — the verifier injection is owned by the
 * action layer.
 *
 * @param {object} options
 * @param {string} options.runIdentity
 * @param {object} options.targetProfile
 * @param {string} options.stagedArtifact
 * @param {object} options.scenario
 * @param {object} options.privateResults
 * @param {number} options.deadline - timeoutMs
 * @param {function} options.runHarness - game-owned closure harness
 * @param {function} [options.verifyScenarioResult] - action-owned proof verifier; called only on completed lifecycle + completed cleanup
 */
export async function runGameClosure({
  runIdentity,
  targetProfile,
  stagedArtifact,
  scenario,
  privateResults,
  deadline,
  runHarness,
  verifyScenarioResult,
} = {}) {
  if (typeof runIdentity !== "string" || runIdentity.length === 0) fail("invalid_input");
  if (!targetProfile || typeof targetProfile !== "object") fail("invalid_input");
  if (typeof stagedArtifact !== "string" || stagedArtifact.length === 0) fail("invalid_input");
  if (!scenario || typeof scenario !== "object") fail("invalid_input");
  if (!privateResults || typeof privateResults !== "object") fail("invalid_input");
  validatePositiveInt(deadline, "deadline");
  if (typeof runHarness !== "function") fail("invalid_input");
  if (verifyScenarioResult !== undefined && typeof verifyScenarioResult !== "function") fail("invalid_input");

  let harnessOutcome;
  try {
    harnessOutcome = await runHarness({
      runIdentity,
      targetProfile,
      stagedArtifact,
      scenario,
      privateResults,
      deadline,
    });
  } catch (error) {
    const code = boundedFailureCode(error);
    return Object.freeze({
      schema: GAME_CLOSURE_HARNESS_RESULT_SCHEMA,
      state: "incomplete",
      lifecycle: "failed",
      failure: Object.freeze({ phase: "harness", code }),
      cleanup: Object.freeze({ state: "uncertain" }),
      scenarioResult: null,
    });
  }

  if (!harnessOutcome || typeof harnessOutcome !== "object") fail("harness_outcome_invalid");

  const harnessLifecycle = harnessOutcome.lifecycle;
  const harnessFailure = harnessOutcome.failure ?? null;
  const harnessCleanupState = harnessOutcome.cleanup?.state === "completed" ? "completed" : "uncertain";

  if (harnessLifecycle !== "completed") {
    return Object.freeze({
      schema: GAME_CLOSURE_HARNESS_RESULT_SCHEMA,
      state: "incomplete",
      lifecycle: harnessLifecycle === "failed" ? "failed" : "incomplete",
      failure: harnessFailure,
      cleanup: Object.freeze({ state: harnessCleanupState }),
      scenarioResult: null,
    });
  }

  if (harnessCleanupState !== "completed") {
    return Object.freeze({
      schema: GAME_CLOSURE_HARNESS_RESULT_SCHEMA,
      state: "incomplete",
      lifecycle: "completed",
      failure: Object.freeze({ phase: "cleanup", code: "cleanup_uncertain" }),
      cleanup: Object.freeze({ state: harnessCleanupState }),
      scenarioResult: null,
    });
  }

  // Lifecycle completion is not an action proof. A missing owner verifier
  // must remain incomplete so no caller can mistake settlement for success.
  if (!verifyScenarioResult) {
    return Object.freeze({
      schema: GAME_CLOSURE_HARNESS_RESULT_SCHEMA,
      state: "incomplete",
      lifecycle: "completed",
      failure: Object.freeze({ phase: "scenario", code: "scenario_result_missing" }),
      cleanup: Object.freeze({ state: "completed" }),
      scenarioResult: null,
    });
  }

  let scenarioResult;
  try {
    scenarioResult = await verifyScenarioResult({
      runIdentity,
      targetProfile,
      stagedArtifact,
      scenario,
      privateResults,
      deadline,
      lifecycle: "completed",
      cleanup: Object.freeze({ state: "completed" }),
    });
  } catch (error) {
    return Object.freeze({
      schema: GAME_CLOSURE_HARNESS_RESULT_SCHEMA,
      state: "incomplete",
      lifecycle: "completed",
      failure: Object.freeze({ phase: "scenario", code: boundedFailureCode(error) }),
      cleanup: Object.freeze({ state: "completed" }),
      scenarioResult: null,
    });
  }

  if (scenarioResult == null) {
    return Object.freeze({
      schema: GAME_CLOSURE_HARNESS_RESULT_SCHEMA,
      state: "incomplete",
      lifecycle: "completed",
      failure: Object.freeze({ phase: "scenario", code: "scenario_result_missing" }),
      cleanup: Object.freeze({ state: "completed" }),
      scenarioResult: null,
    });
  }

  return Object.freeze({
    schema: GAME_CLOSURE_HARNESS_RESULT_SCHEMA,
    state: "completed",
    lifecycle: "completed",
    failure: null,
    cleanup: Object.freeze({ state: "completed" }),
    scenarioResult,
  });
}
