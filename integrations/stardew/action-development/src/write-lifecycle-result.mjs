import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export const STARDEW_CLOSURE_BACKEND_RESULT_SCHEMA =
  "gamebuddy-stardew-closure-backend-result/v1";
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

export function serializeStardewClosureBackendResult({ state, phase, code }) {
  if (state === "completed" && phase === undefined && code === undefined) {
    return JSON.stringify({ schema: STARDEW_CLOSURE_BACKEND_RESULT_SCHEMA, state });
  }
  if (state === "failed" && FAILURE_PHASE_SET.has(phase) && FAILURE_CODE_SET.has(code)) {
    return JSON.stringify({ schema: STARDEW_CLOSURE_BACKEND_RESULT_SCHEMA, state, phase, code });
  }
  throw new Error("stardew_closure_backend_result_invalid");
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

export async function writeStardewClosureBackendResult(resultFile, result) {
  await writeLifecycleResult(resultFile, serializeStardewClosureBackendResult(result));
}
