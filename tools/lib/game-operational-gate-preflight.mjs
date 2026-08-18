/**
 * Pure configuration preflight for the future Game Operational Gate runner.
 * It intentionally performs no filesystem, SQLite, process, or bridge access.
 */
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ROOT = /^(?:[A-Za-z]:[\\/]|\/)(?:[^\0<>:"|?*]+(?:[\\/][^\0<>:"|?*]+)*)?$/;
const IDENTITY_KEYS = Object.freeze(["playerId", "companionId", "continuityId"]);
const SURFACE_SESSION_KEYS = Object.freeze(["chat", "game", "foreign"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function blocked(reasonCode) {
  return Object.freeze({ state: "BLOCKED", reasonCode });
}

function validOpaqueIdentity(value) {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function validRoot(value) {
  return (
    typeof value === "string" && value.length > 1 && value.length <= 1024 && ROOT.test(value) && !/[\r\n]/.test(value)
  );
}

/** Validates an exact Memory identity triple. */
export function validateGameOperationalGateIdentity(config) {
  if (!hasExactKeys(config, IDENTITY_KEYS)) return blocked("identity_shape_invalid");
  for (const key of IDENTITY_KEYS) if (!validOpaqueIdentity(config[key])) return blocked(`identity_${key}_invalid`);
  return Object.freeze({ state: "READY", identity: Object.freeze({ ...config }) });
}

/**
 * Validates the exact Memory topology: Chat and Game use separate surface
 * sessions but use one runtime root because their shared identity resolves to
 * runtimeRoot/contexts/<identityKey>. Foreign continuity has its own identity
 * key, which resolves to a distinct context and cannot share Memory.
 */
export function validateGameOperationalGatePreflight(config) {
  if (
    !hasExactKeys(config, ["runtimeRoot", "sharedIdentity", "foreignIdentity", "surfaceSessions", "markerNonceSha256"])
  )
    return blocked("preflight_config_shape_invalid");
  if (!validRoot(config.runtimeRoot)) return blocked("runtime_root_invalid");

  const shared = validateGameOperationalGateIdentity(config.sharedIdentity);
  if (shared.state !== "READY") return blocked(`shared_${shared.reasonCode}`);
  const foreign = validateGameOperationalGateIdentity(config.foreignIdentity);
  if (foreign.state !== "READY") return blocked(`foreign_${foreign.reasonCode}`);
  if (
    foreign.identity.playerId !== shared.identity.playerId ||
    foreign.identity.companionId !== shared.identity.companionId ||
    foreign.identity.continuityId === shared.identity.continuityId
  )
    return blocked("foreign_identity_partition_mapping_invalid");

  if (!hasExactKeys(config.surfaceSessions, SURFACE_SESSION_KEYS)) return blocked("surface_sessions_shape_invalid");
  const surfaceSessions = config.surfaceSessions;
  if (!Object.values(surfaceSessions).every(validOpaqueIdentity)) return blocked("surface_session_invalid");
  if (new Set(Object.values(surfaceSessions)).size !== SURFACE_SESSION_KEYS.length)
    return blocked("surface_sessions_not_distinct");
  if (typeof config.markerNonceSha256 !== "string" || !SHA256.test(config.markerNonceSha256))
    return blocked("marker_nonce_invalid");

  return Object.freeze({
    state: "READY",
    runtimeRoot: config.runtimeRoot,
    sharedIdentity: shared.identity,
    foreignIdentity: foreign.identity,
    surfaceSessions: Object.freeze({ ...surfaceSessions }),
    markerNonceSha256: config.markerNonceSha256,
  });
}
