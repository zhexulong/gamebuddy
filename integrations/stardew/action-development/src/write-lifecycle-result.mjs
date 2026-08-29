import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const CLEANUP_SCHEMA = "gamebuddy-stardew-lifecycle-cleanup-result/v1";
export const LIFECYCLE_PHASE_RESULT_SCHEMA = "gamebuddy-stardew-lifecycle-phase-result/v1";
export const LIFECYCLE_FAILURE_PHASES = Object.freeze([
  "runner_resolution",
  "input_validation",
  "fixture_prepare",
  "working_save_restore",
  "smapi_launch",
  "pipe_readiness",
  "launch_identity",
  "live_child",
  "process_teardown",
  "fixture_restore",
  "working_save_cleanup",
  "lifecycle_result_publication",
]);
const FAILURE_PHASE_SET = new Set(LIFECYCLE_FAILURE_PHASES);
const FAILURE_CODE_SET = new Set(["failed", "child_nonzero"]);

export function serializeLifecycleCleanupResult({ completed }) {
  if (typeof completed !== "boolean") throw new Error("lifecycle_result_completed_invalid");
  return JSON.stringify({ schema: CLEANUP_SCHEMA, completed });
}

export function serializeLifecyclePhaseResult({ phase, code }) {
  if (!FAILURE_PHASE_SET.has(phase) || !FAILURE_CODE_SET.has(code)) {
    throw new Error("lifecycle_phase_result_invalid");
  }
  return JSON.stringify({ schema: LIFECYCLE_PHASE_RESULT_SCHEMA, phase, code });
}

async function writeLifecycleResult(resultFile, text) {
  if (!path.isAbsolute(resultFile ?? "")) throw new Error("lifecycle_result_path_not_absolute");
  const parent = path.dirname(resultFile);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await realpath(parent) !== parent) {
    throw new Error("lifecycle_result_parent_untrusted");
  }
  const handle = await open(resultFile, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeLifecycleCleanupResult(resultFile, { completed }) {
  await writeLifecycleResult(resultFile, serializeLifecycleCleanupResult({ completed }));
}

export async function writeLifecyclePhaseResult(resultFile, { phase, code }) {
  await writeLifecycleResult(resultFile, serializeLifecyclePhaseResult({ phase, code }));
}
