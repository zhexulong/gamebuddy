import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_RESOLVED = "source_resolved", RUNTIME_MODELED = "runtime_modeled", APPROVED_SCOPE_BOUNDARY = "approved_scope_boundary", UNKNOWN_BLOCKING = "unknown_blocking";
const VALID_DISPOSITIONS = new Set([SOURCE_RESOLVED, RUNTIME_MODELED, APPROVED_SCOPE_BOUNDARY, UNKNOWN_BLOCKING]);
const VALID_TERMINALS = new Set(["native_transition", "native_protocol", "approved_scope_boundary", "unknown_blocking"]);
const FORBIDDEN = /\b(primitive|operation|capability|contract|receipt|evidence|policy|projection|semantic[_ -]?family)\b/i;
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function assertObject(value, code, message) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, message); }
function assertString(value, code, message) { if (typeof value !== "string" || value.length === 0) fail(code, message); }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
export function sourceClosureDigest(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function assertAttestation(attestation) { assertObject(attestation, "source_closure_attestation_missing", "attestation must be an object"); for (const field of ["targetAssemblySha256", "sourceManifestSha256", "contentManifestSha256", "boundaryModelSha256"]) if (!SHA256.test(attestation[field] ?? "")) fail("source_closure_attestation_invalid", `${field} must be a lowercase SHA-256`); }
function assertNoForbiddenVocabulary(value, at = "$") { if (typeof value === "string") return; if (Array.isArray(value)) return value.forEach((item, index) => assertNoForbiddenVocabulary(item, `${at}[${index}]`)); if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { const normalized = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " "); if (FORBIDDEN.test(normalized)) fail("source_closure_forbidden_vocabulary", `forbidden key ${at}.${key}`); assertNoForbiddenVocabulary(item, `${at}.${key}`); } }
function exactAnchor(anchor, sourceFiles, label) {
  assertObject(anchor, "source_closure_anchor_invalid", `exact ${label} anchor must be an object`);
  if (typeof anchor.relativePath !== "string" || !Number.isInteger(anchor.startByte) || !Number.isInteger(anchor.endByte) || anchor.endByte <= anchor.startByte || !SHA256.test(anchor.sliceSha256 ?? "") || !SHA256.test(anchor.sourceFileSha256 ?? "")) fail("source_closure_anchor_invalid", `exact ${label} anchor is malformed`);
  if (!sourceFiles) return;
  const source = sourceFiles[anchor.relativePath]; if (!source || source.sha256 !== anchor.sourceFileSha256) fail("source_closure_source_missing", `exact source missing for ${label}`);
  const bytes = Buffer.from(source.text, "utf8"); const actual = createHash("sha256").update(bytes.subarray(anchor.startByte, anchor.endByte)).digest("hex");
  if (anchor.endByte > bytes.length || actual !== anchor.sliceSha256) fail("source_closure_anchor_stale", `exact ${label} anchor is stale`);
}
/** Validates a source closure certificate. schema v2 is source-attested; v1 exists only for isolated legacy unit fixtures. */
export function validateNativeSourceClosure(certificate, { sourceFiles } = {}) {
  assertObject(certificate, "source_closure_invalid", "certificate must be an object");
  if (![1, 2].includes(certificate.schemaVersion) || certificate.artifactKind !== "native_source_closure") fail("source_closure_kind_invalid", "expected native_source_closure schema version 1 or 2");
  const exact = certificate.schemaVersion === 2;
  assertNoForbiddenVocabulary(certificate); assertAttestation(certificate.attestation);
  if (!Array.isArray(certificate.mechanisms) || !certificate.mechanisms.length) fail("source_closure_mechanisms_missing", "mechanisms must be a non-empty array");
  const mechanismIds = new Set(), edgeIds = new Set(), unresolved = [];
  for (const mechanism of certificate.mechanisms) {
    assertObject(mechanism, "source_closure_mechanism_invalid", "mechanism must be an object"); assertString(mechanism.mechanismId, "source_closure_mechanism_id_invalid", "mechanismId is required");
    if (mechanismIds.has(mechanism.mechanismId)) fail("source_closure_mechanism_duplicate", `duplicate mechanism ${mechanism.mechanismId}`); mechanismIds.add(mechanism.mechanismId);
    if (!Array.isArray(mechanism.edges) || !mechanism.edges.length) fail("source_closure_edges_missing", `${mechanism.mechanismId} has no edges`);
    if (!VALID_TERMINALS.has(mechanism.terminal)) fail("source_closure_terminal_invalid", `${mechanism.mechanismId} has invalid terminal`);
    for (const edge of mechanism.edges) {
      assertObject(edge, "source_closure_edge_invalid", "edge must be an object"); assertString(edge.edgeId, "source_closure_edge_id_invalid", "edgeId is required");
      if (edgeIds.has(edge.edgeId)) fail("source_closure_edge_duplicate", `duplicate edge ${edge.edgeId}`); edgeIds.add(edge.edgeId);
      if (!VALID_DISPOSITIONS.has(edge.disposition)) fail("source_closure_disposition_invalid", `invalid disposition for ${edge.edgeId}`);
      if (exact) exactAnchor(edge.sourceAnchor, sourceFiles, `edge ${edge.edgeId}`); else assertString(edge.sourceAnchor, "source_closure_anchor_missing", `sourceAnchor is required for ${edge.edgeId}`);
      if (edge.disposition === RUNTIME_MODELED && !SHA256.test(edge.runtimeModelSha256 ?? "")) fail("source_closure_runtime_model_missing", `${edge.edgeId} requires runtimeModelSha256`);
      if (edge.disposition === APPROVED_SCOPE_BOUNDARY && !SHA256.test(edge.scopeBoundarySha256 ?? "")) fail("source_closure_scope_boundary_missing", `${edge.edgeId} requires scopeBoundarySha256`);
      if (edge.disposition === UNKNOWN_BLOCKING) unresolved.push(edge.edgeId);
    }
    if (mechanism.terminal === UNKNOWN_BLOCKING && !mechanism.edges.some((edge) => edge.disposition === UNKNOWN_BLOCKING)) fail("source_closure_terminal_gap_missing", `${mechanism.mechanismId} terminal gap lacks unknown edge`);
  }
  const claimedComplete = certificate.closureState === "bounded_source_closure_complete";
  if (!["partial_with_unknown_blocking", "bounded_source_closure_complete"].includes(certificate.closureState)) fail("source_closure_state_invalid", "invalid closureState");
  if (claimedComplete && unresolved.length) fail("source_closure_unknown_blocks_complete", "unknown blocking edges prevent closure completion");
  if (!claimedComplete && !unresolved.length) fail("source_closure_partial_without_unknown", "partial certificate must retain an unknown blocking edge");
  return { mechanismCount: mechanismIds.size, edgeCount: edgeIds.size, unknownBlockingEdgeIds: unresolved.sort(), closureState: certificate.closureState, certificateSha256: sourceClosureDigest(certificate) };
}
