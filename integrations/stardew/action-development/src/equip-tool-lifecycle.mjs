import path from "node:path";
import {
  beginPrivateResultFile,
  cleanupPrivateResultFile,
  readPrivateResultFile,
  runBoundedChild,
} from "@gamebuddy/game-action-devkit";
import { parseScenarioResultText } from "./scenario-result.mjs";
import { parseJsonWithoutDuplicateKeys } from "./json-text.mjs";

const CLEANUP_SCHEMA = "gamebuddy-stardew-lifecycle-cleanup-result/v1";
const CLAIM_SCOPE = "native-local-equip-tool-v1";

function fail(code, cause) {
  throw new Error(`stardew_equip_tool_lifecycle_${code}`, cause ? { cause } : undefined);
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
    || typeof runId !== "string" || runId.length === 0) fail("invalid_input");
  const script = path.resolve(projectRoot, "../../../tools/run-stardew-native-local-player-move-fixture.ps1");
  const actionClaim = await beginResult({ root: resultRoot });
  let lifecycleClaim;
  try {
    lifecycleClaim = await beginResult({ root: resultRoot });
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
      "-GamePath", profile.gameInstallPath,
      "-ModsPath", profile.modsPath,
      "-FixtureRoot", profile.fixtureRoot,
      "-SaveName", profile.saveIdentity,
      "-TemplateName", profile.templateIdentity,
      "-ReleaseDir", releaseDir,
      "-ResultFile", actionClaim.resultFile,
      "-LifecycleResultFile", lifecycleClaim.resultFile,
      "-ScenarioIdentity", scenarioIdentity({ runId, profileIdentity: profile.profileIdentity }),
      "-Action", "equip_tool",
      "-TimeoutSeconds", String(Math.max(30, Math.min(300, Math.ceil(profile.timeoutMs / 1_000)))),
    ];
    const child = await runChild({
      command: resolvePowerShell(),
      args,
      cwd: projectRoot,
      timeoutMs: profile.timeoutMs,
      stdio: "pipe",
      terminationPolicy: "immediate",
    });
    if (child?.code !== 0 || child?.signal) fail("child_failed");
    const proof = parseScenarioResultText(await readResult(actionClaim), {
      gameId: "stardew",
      actionId: "equip_tool",
      runId,
      stage: "run-live",
      profileIdentity: profile.profileIdentity,
      claimScope: CLAIM_SCOPE,
    });
    const cleanup = parseCleanup(await readResult(lifecycleClaim));
    return Object.freeze({ operationResult: proof, cleanupResult: cleanup });
  } finally {
    const failures = [];
    try { await cleanupResult(actionClaim); } catch (error) { failures.push(error); }
    if (lifecycleClaim) {
      try { await cleanupResult(lifecycleClaim); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "stardew_equip_tool_lifecycle_result_cleanup_failed");
  }
}
