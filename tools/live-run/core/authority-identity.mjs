import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Diagnose a `production_authority_artifact_present` refusal caused by a
 * deployment-identity mismatch.
 *
 * The product's authority marker binds the `bootstrapOperationId` (and
 * `authorityGeneration`) that PROVISIONED the runtime root; every later launch
 * must present the same deployment manifest or it is refused with the same
 * opaque reason code as a genuinely foreign artifact. A live-run harness that
 * mints a fresh operation id per run therefore cannot reopen an existing
 * authority, and the bare reason code hides which two ids disagree.
 *
 * Real run evidence (2026-10-04, ladder-5 repeat run on one continuity):
 *   marker.bootstrapOperationId   = agent-ab-1791121825880
 *   manifest.bootstrapOperationId = agent-ab-1791122324799
 *   -> dialogue_exited_before_ready:1:production_authority_artifact_present
 *
 * Both files live inside the runtime root, which the harness owns, so naming
 * the mismatch costs nothing and saves the next person the same three-step
 * hunt. Never throws: an unreadable or matching pair returns the original
 * error unchanged, so a real failure is never masked by diagnostics.
 */

export const AUTHORITY_DIRECTORY_NAME = ".gamebuddy-semantic-continuity-v1";
export const AUTHORITY_MARKER_NAME = "production-authority-marker.json";

export function authorityMarkerPath(root) {
  return join(root, AUTHORITY_DIRECTORY_NAME, AUTHORITY_MARKER_NAME);
}

export function readAuthorityOperationId(root, { readFileSyncImpl = readFileSync } = {}) {
  try {
    const marker = JSON.parse(readFileSyncImpl(authorityMarkerPath(root), "utf8"));
    return typeof marker?.bootstrapOperationId === "string" ? marker.bootstrapOperationId : undefined;
  } catch {
    return undefined;
  }
}

export function explainAuthorityIdentityMismatch(error, root, manifest, { readFileSyncImpl = readFileSync } = {}) {
  const markerId = readAuthorityOperationId(root, { readFileSyncImpl });
  const manifestId = manifest?.bootstrapOperationId;
  if (typeof markerId !== "string" || typeof manifestId !== "string" || markerId === manifestId) return error;
  return new Error(
    `runtime_root_authority_identity_mismatch: the authority was provisioned with bootstrapOperationId ${markerId} but the deployment manifest carries ${manifestId}. The runtime root must keep the manifest that provisioned it; a fresh operation id cannot open an existing authority. ${String(error?.message ?? error)}`,
    { cause: error },
  );
}
