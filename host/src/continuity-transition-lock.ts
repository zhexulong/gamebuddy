import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { withPathLock } from "./path-lock.js";

const LOCK_DIRECTORY = ".gamebuddy-internal-locks";
const LOCK_NAMESPACE = "gamebuddy:continuity-surface-transition-lock:v1\0";

/**
 * Serializes an atomic Chat/Game surface transition for one validated opaque
 * continuity partition across local Host processes sharing `runtimeRoot`.
 *
 * Future transition guards must call this as their outermost critical section:
 * `await withContinuitySurfaceTransitionLock(runtimeRoot, continuityId, async
 * () => { validate durable state; perform the guarded transition; commit its
 * durable result; })`. The callback runs only after durable lock ownership is
 * acquired, and any acquisition error (including the path-lock timeout) is
 * propagated without executing it. This utility owns no lifecycle state and
 * neither returns nor exposes a path containing the continuity identifier.
 */
export async function withContinuitySurfaceTransitionLock<T>(
  runtimeRoot: string,
  continuityId: string,
  work: () => Promise<T>,
): Promise<T> {
  const root = validateRuntimeRoot(runtimeRoot);
  const partition = validateContinuityPartition(continuityId);
  const target = join(root, LOCK_DIRECTORY, `continuity-surface-transition-${partition}`);
  return withPathLock(target, work);
}

function validateRuntimeRoot(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    throw new Error("invalid_continuity_transition_runtime_root");
  }
  return value;
}

function validateContinuityPartition(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new Error("invalid_continuity_transition_partition");
  return createHash("sha256").update(`${LOCK_NAMESPACE}${value}`, "utf8").digest("hex");
}
