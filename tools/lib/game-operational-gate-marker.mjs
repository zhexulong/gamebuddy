/**
 * Pure, payload-blind validation for Game Operational Gate marker IPC.
 *
 * This module deliberately accepts only the aggregate marker contract. It does
 * not open an IPC channel, retain reports, or inspect prompt/provider payloads.
 */
export const GAME_OPERATIONAL_GATE_MARKER_SCHEMA = "gamebuddy-game-operational-gate-marker/v1";

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SURFACES = new Set(["chat", "game"]);
const REPORT_KEYS = Object.freeze([
  "schema",
  "sessionId",
  "nonceSha256",
  "surface",
  "m1MaxMemoryMutationId",
  "materializedCategoryCounts",
]);
const CATEGORY_KEYS = Object.freeze(["SEMANTIC_MEMORY", "INTERACTION_EPISODE"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function invalid(reasonCode) {
  return Object.freeze({ observed: false, reasonCode });
}

/**
 * Validates only a redacted aggregate report. Unknown fields fail closed so a
 * future source producer cannot accidentally add text, paths, IDs, or provider
 * data without a separately reviewed contract revision.
 */
export function validateGameOperationalGateMarkerReport(report) {
  if (!hasExactKeys(report, REPORT_KEYS)) return invalid("marker_report_shape_invalid");
  if (report.schema !== GAME_OPERATIONAL_GATE_MARKER_SCHEMA) return invalid("marker_report_schema_invalid");
  if (typeof report.sessionId !== "string" || !OPAQUE_ID.test(report.sessionId))
    return invalid("marker_report_session_invalid");
  if (typeof report.nonceSha256 !== "string" || !SHA256.test(report.nonceSha256))
    return invalid("marker_report_nonce_invalid");
  if (typeof report.surface !== "string" || !SURFACES.has(report.surface))
    return invalid("marker_report_surface_invalid");
  if (!Number.isSafeInteger(report.m1MaxMemoryMutationId) || report.m1MaxMemoryMutationId < 0)
    return invalid("marker_report_m1_max_memory_mutation_id_invalid");
  if (!hasExactKeys(report.materializedCategoryCounts, CATEGORY_KEYS))
    return invalid("marker_report_materialized_category_counts_invalid");
  if (
    !Number.isSafeInteger(report.materializedCategoryCounts.SEMANTIC_MEMORY) ||
    report.materializedCategoryCounts.SEMANTIC_MEMORY < 0 ||
    !Number.isSafeInteger(report.materializedCategoryCounts.INTERACTION_EPISODE) ||
    report.materializedCategoryCounts.INTERACTION_EPISODE < 0
  )
    return invalid("marker_report_materialized_category_counts_invalid");

  return Object.freeze({
    observed: true,
    sessionId: report.sessionId,
    nonceSha256: report.nonceSha256,
    surface: report.surface,
    m1MaxMemoryMutationId: report.m1MaxMemoryMutationId,
    materializedCategoryCounts: Object.freeze({ ...report.materializedCategoryCounts }),
  });
}

/**
 * Binds one source-owned report to its runner-issued nonce and the independently
 * observed Pi session/surface. The supplied Set provides one-shot consumption.
 */
export function verifyGameOperationalGateMarkerReport(report, expected, consumedSessions = new Set()) {
  const validated = validateGameOperationalGateMarkerReport(report);
  if (!validated.observed) return validated;
  if (!hasExactKeys(expected, ["sessionId", "nonceSha256", "surface"])) return invalid("marker_expectation_invalid");
  if (
    typeof expected.sessionId !== "string" ||
    !OPAQUE_ID.test(expected.sessionId) ||
    typeof expected.nonceSha256 !== "string" ||
    !SHA256.test(expected.nonceSha256) ||
    typeof expected.surface !== "string" ||
    !SURFACES.has(expected.surface)
  )
    return invalid("marker_expectation_invalid");
  if (
    validated.sessionId !== expected.sessionId ||
    validated.nonceSha256 !== expected.nonceSha256 ||
    validated.surface !== expected.surface
  )
    return invalid("marker_binding_mismatch");
  if (!(consumedSessions instanceof Set)) return invalid("marker_consumption_state_invalid");
  if (consumedSessions.has(validated.sessionId)) return invalid("marker_report_replayed");
  consumedSessions.add(validated.sessionId);
  return Object.freeze({ ...validated, oneShot: true });
}
