import path from "node:path";
import {
  beginPrivateResultFile,
  cleanupPrivateResultFile,
  readPrivateResultFile,
  runBoundedChild,
} from "@gamebuddy/game-action-devkit";
import { parseScenarioResultText } from "./scenario-result.mjs";
import { parseJsonWithoutDuplicateKeys } from "./json-text.mjs";
import { LIFECYCLE_FAILURE_PHASES, LIFECYCLE_PHASE_RESULT_SCHEMA } from "./write-lifecycle-result.mjs";

const CLEANUP_SCHEMA = "gamebuddy-stardew-lifecycle-cleanup-result/v1";
const FAILURE_PHASE_SET = new Set(LIFECYCLE_FAILURE_PHASES);
const CLAIM_SCOPE = "native-local-equip-tool-v1";

function fail(code) {
  throw new Error(`stardew_equip_tool_lifecycle_${code}`);
}

function parseCleanup(text) {
  const value = parseJsonWithoutDuplicateKeys(text, "stardew_equip_tool_lifecycle_cleanup");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2
    || value.schema !== CLEANUP_SCHEMA
    || typeof value.completed !== "boolean") fail("cleanup_result_invalid");
  if (value.completed !== true) fail("cleanup_not_completed");
  return Object.freeze({ schema: CLEANUP_SCHEMA, completed: true });
}

function isMissingResult(error) {
  return error?.code === "ENOENT" || error?.message === "game_action_private_result_missing";
}

function parsePhaseResult(text) {
  const value = parseJsonWithoutDuplicateKeys(text, "stardew_equip_tool_lifecycle_phase");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 3
    || value.schema !== LIFECYCLE_PHASE_RESULT_SCHEMA
    || !FAILURE_PHASE_SET.has(value.phase)
    || (value.code !== "failed" && value.code !== "child_nonzero")) {
    fail("phase_result_invalid");
  }
  return Object.freeze({ phase: value.phase, code: value.code });
}

function childFailureCode(error) {
  if (error?.message === "game_action_child_timeout") return "child_timeout";
  if (error?.message === "game_action_child_spawn_failed") return "child_spawn_failed";
  return "child_failed";
}

function scenarioIdentity({ runId, profileIdentity }) {
  return JSON.stringify({
    gameId: "stardew",
    actionId: "equip_tool",
    runId,
    stage: "run-live",
    profileIdentity,
    claimScope: CLAIM_SCOPE,
  });
}

export async function runEquipToolLifecycle({
  projectRoot,
  profile,
  runId,
  releaseDir,
  resultRoot,
  runChild = runBoundedChild,
  beginResult = beginPrivateResultFile,
  readResult = readPrivateResultFile,
  cleanupResult = cleanupPrivateResultFile,
  resolvePowerShell = () => "powershell.exe",
} = {}) {
  if (!path.isAbsolute(projectRoot ?? "") || !path.isAbsolute(releaseDir ?? "")
    || !path.isAbsolute(resultRoot ?? "")
    || typeof runId !== "string" || runId.length === 0
    || !profile || typeof profile !== "object"
    || !["gameInstallPath", "modsPath", "nativeFixtureRoot", "saveIdentity", "templateIdentity", "profileIdentity"].every(
      (field) => typeof profile[field] === "string" && profile[field].length > 0,
    )
    || !Number.isSafeInteger(profile.timeoutMs)) fail("invalid_input");
  const script = path.resolve(projectRoot, "../../../tools/run-stardew-native-local-player-move-fixture.ps1");
  let actionClaim;
  let lifecycleClaim;
  let phaseClaim;
  try {
    try {
      actionClaim = await beginResult({ root: resultRoot });
      lifecycleClaim = await beginResult({ root: resultRoot });
      phaseClaim = await beginResult({ root: resultRoot });
    } catch {
      const cleanupFailures = [];
      for (const claim of [actionClaim, lifecycleClaim, phaseClaim]) {
        if (!claim) continue;
        try { await cleanupResult(claim); } catch (error) { cleanupFailures.push(error); }
      }
      actionClaim = undefined;
      lifecycleClaim = undefined;
      phaseClaim = undefined;
      if (cleanupFailures.length) fail("result_cleanup_failed");
      fail("result_claim_failed");
    }
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
      "-GamePath", profile.gameInstallPath,
      "-ModsPath", profile.modsPath,
      "-FixtureRoot", profile.nativeFixtureRoot,
      "-SaveName", profile.saveIdentity,
      "-TemplateName", profile.templateIdentity,
      "-ReleaseDir", releaseDir,
      "-ResultFile", actionClaim.resultFile,
       "-LifecycleResultFile", lifecycleClaim.resultFile,
       "-LifecyclePhaseResultFile", phaseClaim.resultFile,
       "-ScenarioIdentity", scenarioIdentity({ runId, profileIdentity: profile.profileIdentity }),
      "-Action", "equip_tool",
      "-TimeoutSeconds", String(Math.max(30, Math.min(300, Math.ceil(profile.timeoutMs / 1_000)))),
    ];
    let child;
    try {
      child = await runChild({
        command: resolvePowerShell(),
        args,
        cwd: projectRoot,
        timeoutMs: profile.timeoutMs,
        stdio: "pipe",
        terminationPolicy: "immediate",
      });
    } catch (error) {
      try {
        const phase = parsePhaseResult(await readResult(phaseClaim));
        fail(`child_${phase.phase}_${phase.code}`);
      } catch (phaseError) {
        if (typeof phaseError?.message === "string" && phaseError.message.startsWith("stardew_equip_tool_lifecycle_child_")) throw phaseError;
        fail(childFailureCode(error));
      }
    }
    if (child?.signal || child?.code !== 0) {
      try {
        const phase = parsePhaseResult(await readResult(phaseClaim));
        fail(`child_${phase.phase}_${phase.code}`);
      } catch (phaseError) {
        if (typeof phaseError?.message === "string" && phaseError.message.startsWith("stardew_equip_tool_lifecycle_child_")) throw phaseError;
        fail(child?.signal ? "child_signal" : "child_nonzero");
      }
    }
    let proof;
    try {
      proof = parseScenarioResultText(await readResult(actionClaim), {
        gameId: "stardew",
        actionId: "equip_tool",
        runId,
        stage: "run-live",
        profileIdentity: profile.profileIdentity,
        claimScope: CLAIM_SCOPE,
      });
    } catch (error) {
      fail(isMissingResult(error) ? "action_result_missing" : "action_result_invalid");
    }
    let cleanup;
    try { cleanup = parseCleanup(await readResult(lifecycleClaim)); }
    catch (error) {
      if (isMissingResult(error)) fail("cleanup_result_missing");
      if (error?.message === "stardew_equip_tool_lifecycle_cleanup_not_completed") fail("cleanup_not_completed");
      fail("cleanup_result_invalid");
    }
    return Object.freeze({ operationResult: proof, cleanupResult: cleanup });
  } finally {
    const failures = [];
    if (actionClaim) {
      try { await cleanupResult(actionClaim); } catch (error) { failures.push(error); }
    }
    if (lifecycleClaim) {
      try { await cleanupResult(lifecycleClaim); } catch (error) { failures.push(error); }
    }
    if (phaseClaim) {
      try { await cleanupResult(phaseClaim); } catch (error) { failures.push(error); }
    }
    if (failures.length) fail("result_cleanup_failed");
  }
}
