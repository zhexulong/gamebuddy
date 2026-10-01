/**
 * The mounted Tavern management profile's operation vocabulary, in one place.
 *
 * Both the release gate and the operation-evidence recorder must accept exactly
 * the profile the Host actually mounts
 * (`host/src/composition/desktop-presentation-admission-owner.ts`,
 * `composeTavernManagementProfile`). They previously each carried their own
 * copy, which drifted twice: `ac5baeb` added the voice settings surface to the
 * profile and extended the gate but not the recorder, and the connection
 * surface did the same again. Each time the stale consumer rejected the real
 * production profile outright -- the recorder with
 * `mounted_profile_operations_invalid`, the gate with
 * `mounted_profile_operationIds_members` -- so the evidence mapping could never
 * be produced and the live gate could only report `inconclusive`.
 *
 * The ids are therefore read out of the profile source rather than restated
 * here. The profile remains the authority; this module only extracts what it
 * declares. A third hand-maintained copy is what caused both drifts, so adding
 * an operation must not require editing this file.
 */

import { readFileSync } from "node:fs";

const PROFILE_SOURCE = new URL(
  "../../host/src/composition/desktop-presentation-admission-owner.ts",
  import.meta.url,
);

/** The ids declared by `composeTavernManagementProfile()`'s `operationIds`. */
export function readMountedTavernManagementOperationIds() {
  const ids = readProfileField("operationIds");
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("mounted_profile_operation_ids_invalid");
  }
  return ids;
}

function profileSource() {
  const source = readFileSync(PROFILE_SOURCE, "utf8");
  const at = source.indexOf("function composeTavernManagementProfile");
  if (at < 0) {
    throw new Error("mounted_profile_composition_owner_missing");
  }
  // Scope every read to the management composer's own body. A file-wide search
  // matches the reference profiles that share this module and would report the
  // wrong identity - which is how a first attempt at this returned the chat-core
  // profile instead of the management one.
  return source.slice(at, source.indexOf("\n}", at));
}

function readProfileField(field) {
  const block = new RegExp(`${field}:\\s*\\[([\\s\\S]*?)\\]`).exec(profileSource());
  if (block === null) {
    throw new Error(`mounted_profile_${field}_missing`);
  }
  return [...block[1].matchAll(/"([a-z][a-z.\-]+\.?[a-z.\-]*)"/g)].map((m) => m[1]);
}

/**
 * The complete redacted profile projection the release gate consumes.
 *
 * A hand-written copy of this drifted three times, most recently when the
 * `settings.connection.*` surface was added to the profile and the checked-in
 * transcription kept the old 8 ids. The release gate then rejected the REAL
 * production profile with `mounted_profile_operationIds_members`, which is
 * indistinguishable from a genuine regression. Callers must derive the
 * projection from the composition source (this function) rather than restate
 * it, so a new surface can never require editing a fixture by hand.
 */
export function readMountedTavernManagementProfile() {
  const body = profileSource();
  const releaseTier = /releaseTier:\s*"([a-z_]+)"/.exec(body);
  const profileId = /profileId:\s*"([a-z0-9.\-]+)"/.exec(body);
  if (releaseTier === null || profileId === null) {
    throw new Error("mounted_profile_identity_missing");
  }
  return Object.freeze({
    profileId: profileId[1],
    releaseTier: releaseTier[1],
    routeIds: readProfileField("routeIds"),
    operationIds: readProfileField("operationIds"),
    navigationItemIds: readProfileField("navigationItemIds"),
  });
}

export const MOUNTED_TAVERN_MANAGEMENT_OPERATION_IDS = Object.freeze(
  readMountedTavernManagementOperationIds(),
);

const KNOWN = new Set(MOUNTED_TAVERN_MANAGEMENT_OPERATION_IDS);

/**
 * True when every id the profile declares is in the shared vocabulary. Kept as
 * a guard for callers that hold a profile object already read from disk; a
 * `false` result means the profile on disk and the profile source disagree,
 * which must fail closed rather than drop the unknown id.
 */
export function declaresOnlyKnownOperations(profile) {
  return (
    Array.isArray(profile?.operationIds) &&
    profile.operationIds.length > 0 &&
    profile.operationIds.every((id) => typeof id === "string" && KNOWN.has(id))
  );
}

/**
 * The route each operation is served by. The mounted profile serves every
 * operation through the route of the same id, which is what the browser
 * contract declares for the settings surfaces.
 */
export const MOUNTED_TAVERN_MANAGEMENT_OPERATION_ROUTES = Object.freeze(
  Object.fromEntries(MOUNTED_TAVERN_MANAGEMENT_OPERATION_IDS.map((id) => [id, id])),
);