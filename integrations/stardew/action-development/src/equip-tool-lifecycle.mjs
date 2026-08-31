import path from "node:path";
import { beginPrivateResultFile, cleanupPrivateResultFile, readPrivateResultFile } from "@gamebuddy/game-action-devkit";
import { runStardewClosureBackend, TEARDOWN_RECEIPT_GRACE_MS } from "./stardew-closure-backend.mjs";
import { parseScenarioResultText } from "./scenario-result.mjs";
import { validateEquipToolScenarioProof } from "./equip-tool-scenario-result.mjs";

const BACKEND_FAILURE_PREFIX = "stardew_closure_backend_";
const BACKEND_FAILURE_CODE_PATTERN = /^(?:child_(?:timeout|spawn_failed)|lifecycle_result_(?:missing|invalid|contradicts_child|not_completed)|phase_(?:runner_resolution|input_validation|fixture_prepare|working_save_restore|smapi_launch|pipe_readiness|launch_identity|live_child|process_teardown|fixture_restore|working_save_cleanup|lifecycle_result_publication)_(?:failed|child_nonzero))$/;

function fail(code) {
  throw new Error(`stardew_equip_tool_lifecycle_${code}`);
}

function boundedBackendCode(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  if (!message.startsWith(BACKEND_FAILURE_PREFIX)) return "backend_unknown";
  const code = message.slice(BACKEND_FAILURE_PREFIX.length);
  return BACKEND_FAILURE_CODE_PATTERN.test(code) ? `backend_${code}` : "backend_unknown";
}

/**
 * Adapter-owned orchestrator. Owns the two private action and lifecycle
 * claims, delegates the closed PowerShell transaction to
 * `runStardewClosureBackend`, then verifies the exact action proof and
 * finalizes a complete bundle only after cleanup. Bounded lifecycle/backend
 * failures are mapped to `stardew_equip_tool_lifecycle_backend_<suffix>` and
 * never forward `cause`, `errors`, paths, PIDs, or raw child detail.
 */
export async function runEquipToolLifecycle({
  projectRoot,
  profile,
  runId,
  releaseDir,
  resultRoot,
  beginResult = beginPrivateResultFile,
  readResult = readPrivateResultFile,
  cleanupResult = cleanupPrivateResultFile,
  runBackend = runStardewClosureBackend,
} = {}) {
  if (!path.isAbsolute(projectRoot ?? "") || !path.isAbsolute(releaseDir ?? "")
    || !path.isAbsolute(resultRoot ?? "")
    || typeof runId !== "string" || runId.length === 0
    || !profile || typeof profile !== "object"
    || !["gameInstallPath", "modsPath", "nativeFixtureRoot", "saveIdentity", "templateIdentity", "profileIdentity"].every(
      (field) => typeof profile[field] === "string" && profile[field].length > 0,
    )
    || !Number.isSafeInteger(profile.timeoutMs)
    || profile.timeoutMs < 30_000
    || !Number.isSafeInteger(Math.ceil(profile.timeoutMs / 1_000) * 1_000 + TEARDOWN_RECEIPT_GRACE_MS)) fail("invalid_input");
  if (typeof beginResult !== "function" || typeof readResult !== "function" || typeof cleanupResult !== "function"
    || typeof runBackend !== "function") fail("invalid_input");

  let actionClaim;
  let lifecycleClaim;
  try {
    try {
      actionClaim = await beginResult({ root: resultRoot });
      lifecycleClaim = await beginResult({ root: resultRoot });
    } catch (error) {
      const cleanupFailures = [];
      for (const claim of [actionClaim, lifecycleClaim]) {
        if (!claim) continue;
        try { await cleanupResult(claim); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
      }
      actionClaim = undefined;
      lifecycleClaim = undefined;
      if (cleanupFailures.length) fail("result_cleanup_failed");
      fail("result_claim_failed");
    }
    let backendResult;
    try {
      backendResult = await runBackend({
        projectRoot,
        profile,
        runId,
        releaseDir,
        actionResultFile: actionClaim.resultFile,
        lifecycleResultFile: lifecycleClaim.resultFile,
      });
    } catch (error) {
      const message = typeof error?.message === "string" ? error.message : "";
      if (message.startsWith("stardew_closure_backend_")) {
        // Bounded redacted backend failure; no `cause`/`errors`/raw detail may leak.
        fail(boundedBackendCode(error));
      }
      fail("backend_unknown");
    }
    if (!backendResult || backendResult.state !== "completed") fail("backend_not_completed");
    let proof;
    try {
      proof = validateEquipToolScenarioProof(parseScenarioResultText(await readResult(actionClaim), {
        gameId: "stardew",
        actionId: "equip_tool",
        runId,
        stage: "run-live",
        profileIdentity: profile.profileIdentity,
        claimScope: "native-local-equip-tool-v1",
      }));
    } catch (error) {
      const message = typeof error?.message === "string" ? error.message : "";
      if (message.includes("stardew_action_scenario_result_invalid_size")
        || error?.code === "ENOENT"
        || message === "game_action_private_result_missing") fail("action_result_missing");
      fail("action_result_invalid");
    }
    return Object.freeze({ operationResult: proof, cleanupResult: Object.freeze({ schema: "gamebuddy-stardew-lifecycle-cleanup-result/v1", completed: true }) });
  } finally {
    const failures = [];
    if (actionClaim) {
      try { await cleanupResult(actionClaim); } catch (error) { failures.push(error); }
    }
    if (lifecycleClaim) {
      try { await cleanupResult(lifecycleClaim); } catch (error) { failures.push(error); }
    }
    if (failures.length) fail("result_cleanup_failed");
  }
}

export { TEARDOWN_RECEIPT_GRACE_MS };
