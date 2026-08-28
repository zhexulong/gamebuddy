import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const SCHEMA = "gamebuddy-stardew-lifecycle-cleanup-result/v1";

export function serializeLifecycleCleanupResult({ completed }) {
  if (typeof completed !== "boolean") throw new Error("lifecycle_result_completed_invalid");
  return JSON.stringify({ schema: SCHEMA, completed });
}

export async function writeLifecycleCleanupResult(resultFile, { completed }) {
  if (!path.isAbsolute(resultFile ?? "")) throw new Error("lifecycle_result_path_not_absolute");
  const parent = path.dirname(resultFile);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await realpath(parent) !== parent) {
    throw new Error("lifecycle_result_parent_untrusted");
  }
  const handle = await open(resultFile, "wx", 0o600);
  try {
    await handle.writeFile(serializeLifecycleCleanupResult({ completed }), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
