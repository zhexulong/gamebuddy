import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { runBoundedChild } from "@gamebuddy/game-action-devkit";
import { parseJsonWithoutDuplicateKeys } from "./json-text.mjs";
import {
  LIFECYCLE_FAILURE_PHASES,
  STARDEW_CLOSURE_BACKEND_RESULT_SCHEMA,
} from "./write-lifecycle-result.mjs";

// The PowerShell launcher runs the game against its own internal lifecycle
// deadline derived from profile.timeoutMs (see -TimeoutSeconds). The outer
// bounded-child deadline must not expire in the same instant: reserve an
// explicit bounded grace budget so the launcher can finish process teardown,
// fixture restore, save cleanup, and lifecycle-result publication before the
// supervisor terminates it. A hung teardown still fails closed because the
// supervisor keeps a hard outer deadline.
export const TEARDOWN_RECEIPT_GRACE_MS = 30_000;

const MAX_LIFECYCLE_RESULT_BYTES = 64 * 1024;
const FAILURE_PHASE_SET = new Set(LIFECYCLE_FAILURE_PHASES);
const CLAIM_SCOPE = "native-local-equip-tool-v1";

function fail(code) {
  throw new Error(`stardew_closure_backend_${code}`);
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

function lifecycleTimeoutMs(timeoutMs) {
  return Math.ceil(timeoutMs / 1_000) * 1_000;
}

function parseBackendResult(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") === 0) fail("lifecycle_result_invalid");
  let value;
  try {
    value = parseJsonWithoutDuplicateKeys(text, "stardew_closure_backend_result");
  } catch {
    fail("lifecycle_result_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== STARDEW_CLOSURE_BACKEND_RESULT_SCHEMA) fail("lifecycle_result_invalid");
  if (value.state === "completed") {
    if (Object.keys(value).length !== 2) fail("lifecycle_result_invalid");
    return Object.freeze({ schema: STARDEW_CLOSURE_BACKEND_RESULT_SCHEMA, state: "completed" });
  }
  if (value.state === "failed") {
    if (Object.keys(value).length !== 4
      || !FAILURE_PHASE_SET.has(value.phase)
      || (value.code !== "failed" && value.code !== "child_nonzero")) fail("lifecycle_result_invalid");
    return Object.freeze({
      schema: STARDEW_CLOSURE_BACKEND_RESULT_SCHEMA,
      state: "failed",
      phase: value.phase,
      code: value.code,
    });
  }
  fail("lifecycle_result_invalid");
}

async function readLifecycleResultFile(resultFile) {
  if (typeof resultFile !== "string" || !path.isAbsolute(resultFile)) fail("lifecycle_result_invalid");
  let stat;
  try {
    stat = await lstat(resultFile);
  } catch (error) {
    if (error?.code === "ENOENT") fail("lifecycle_result_missing");
    fail("lifecycle_result_invalid");
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0 || stat.size > MAX_LIFECYCLE_RESULT_BYTES) {
    fail("lifecycle_result_invalid");
  }
  const bytes = Buffer.alloc(stat.size);
  const handle = await open(resultFile, "r");
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) fail("lifecycle_result_invalid");
      offset += bytesRead;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("lifecycle_result_invalid");
    }
    return text;
  } finally {
    await handle.close();
  }
}

async function readResultBounded(readResult, lifecycleResultFile) {
  try {
    const text = await readResult(lifecycleResultFile);
    if (typeof text !== "string") fail("lifecycle_result_invalid");
    return text;
  } catch (error) {
    const message = typeof error?.message === "string" ? error.message : "";
    if (message.startsWith("stardew_closure_backend_")) throw error;
    fail("lifecycle_result_invalid");
  }
}

async function consumeFailedLifecycle(readResult, lifecycleResultFile) {
  const result = parseBackendResult(await readResultBounded(readResult, lifecycleResultFile));
  if (result.state === "completed") fail("lifecycle_result_contradicts_child");
  fail(`phase_${result.phase}_${result.code}`);
}

function validateInput({
  projectRoot,
  profile,
  runId,
  releaseDir,
  actionResultFile,
  lifecycleResultFile,
}) {
  if (!path.isAbsolute(projectRoot ?? "") || !path.isAbsolute(releaseDir ?? "")
    || !path.isAbsolute(actionResultFile ?? "") || !path.isAbsolute(lifecycleResultFile ?? "")
    || typeof runId !== "string" || runId.length === 0
    || !profile || typeof profile !== "object"
    || !["gameInstallPath", "modsPath", "nativeFixtureRoot", "saveIdentity", "templateIdentity", "profileIdentity"].every(
      (field) => typeof profile[field] === "string" && profile[field].length > 0,
    )
    || !Number.isSafeInteger(profile.timeoutMs)
    || profile.timeoutMs < 30_000) fail("invalid_input");
  const timeoutMs = lifecycleTimeoutMs(profile.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs + TEARDOWN_RECEIPT_GRACE_MS)) fail("invalid_input");
  if (actionResultFile === lifecycleResultFile) fail("invalid_input");
  return timeoutMs;
}

/**
 * Stardew-only closure backend. Owns the Windows lifecycle command shape, its
 * deadline containment, and the exact bounded lifecycle-result transfer. It
 * never judges action success and never reads/parses the action result.
 *
 * Resolves only `{ state: "completed" }`. Rejects only
 * `stardew_closure_backend_<bounded_code>` errors: on a child terminal failure
 * it consumes the lifecycle result first (valid failed result =>
 * `phase_<phase>_<code>`; missing/invalid => `lifecycle_result_missing` /
 * `lifecycle_result_invalid`); supervisor timeout/spawn before child terminal
 * output => `child_timeout` / `child_spawn_failed`.
 */
export async function runStardewClosureBackend({
  projectRoot,
  profile,
  runId,
  releaseDir,
  actionResultFile,
  lifecycleResultFile,
  runChild = runBoundedChild,
  readResult = readLifecycleResultFile,
  resolvePowerShell = () => "powershell.exe",
} = {}) {
  const timeoutMs = validateInput({
    projectRoot,
    profile,
    runId,
    releaseDir,
    actionResultFile,
    lifecycleResultFile,
  });
  const script = path.resolve(projectRoot, "../../../tools/run-stardew-native-local-player-move-fixture.ps1");
  const args = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-GamePath", profile.gameInstallPath,
    "-ModsPath", profile.modsPath,
    "-FixtureRoot", profile.nativeFixtureRoot,
    "-SaveName", profile.saveIdentity,
    "-TemplateName", profile.templateIdentity,
    "-ReleaseDir", releaseDir,
    "-ResultFile", actionResultFile,
    "-LifecycleResultFile", lifecycleResultFile,
    "-ScenarioIdentity", scenarioIdentity({ runId, profileIdentity: profile.profileIdentity }),
    "-Action", "equip_tool",
    "-TimeoutSeconds", String(timeoutMs / 1_000),
  ];
  let childResult;
  let childError;
  try {
    childResult = await runChild({
      command: resolvePowerShell(),
      args,
      cwd: projectRoot,
      timeoutMs: timeoutMs + TEARDOWN_RECEIPT_GRACE_MS,
      stdio: "pipe",
      terminationPolicy: "immediate",
    });
  } catch (error) {
    childError = error;
  }
  if (childError) {
    const message = typeof childError?.message === "string" ? childError.message : "";
    if (message.startsWith("test_supervisor_timeout")) fail("child_timeout");
    if (message.startsWith("test_runner_failed:spawn")) fail("child_spawn_failed");
    return consumeFailedLifecycle(readResult, lifecycleResultFile);
  }
  if (childResult && (childResult.signal || childResult.code !== 0)) {
    return consumeFailedLifecycle(readResult, lifecycleResultFile);
  }
  const result = parseBackendResult(await readResultBounded(readResult, lifecycleResultFile));
  if (result.state !== "completed") fail("lifecycle_result_not_completed");
  return Object.freeze({ state: "completed" });
}
