const SHA256 = /^[a-f0-9]{64}$/;
function fail(code, message, details = {}) { const error = new Error(message); error.code = code; error.details = details; throw error; }
function sameAnchor(left, right) { return left && right && left.sourcePath === right.sourcePath && left.startByte === right.startByte && left.endByte === right.endByte && left.sourceSliceSha256 === right.sourceSliceSha256 && left.sourceFileSha256 === right.sourceFileSha256; }
export function validateNativeTransitionScopeManifest(manifest, { expectedAttestation } = {}) {
  if (!manifest || typeof manifest !== "object" || manifest.schemaVersion !== 1 || manifest.artifactKind !== "native_transition_scope_manifest") fail("transition_scope_manifest_invalid", "Expected native transition scope manifest schema version 1.");
  const attestation = manifest.attestation;
  if (!SHA256.test(attestation?.targetAssemblySha256 ?? "") || !SHA256.test(attestation?.sourceManifestSha256 ?? "")) fail("transition_scope_manifest_invalid", "Scope manifest must attest exact target/source SHA-256 values.");
  if (expectedAttestation && (attestation.targetAssemblySha256 !== expectedAttestation.targetAssemblySha256 || attestation.sourceManifestSha256 !== expectedAttestation.sourceManifestSha256)) fail("transition_scope_manifest_attestation_mismatch", "Scope manifest attestation does not match the exact mechanism report.");
  if (manifest.scope !== "normal_player_vanilla") fail("transition_scope_manifest_invalid", "This derivation accepts only the approved normal_player_vanilla scope.");
  if (!Array.isArray(manifest.exclusionBoundaries)) fail("transition_scope_manifest_invalid", "Scope manifest must have an exclusionBoundaries array.");
  const boundaries = new Map();
  for (const boundary of manifest.exclusionBoundaries) {
    if (!boundary || typeof boundary.boundaryId !== "string" || !boundary.boundaryId || boundaries.has(boundary.boundaryId) || typeof boundary.boundaryKind !== "string" || !boundary.boundaryKind || typeof boundary.scopeReason !== "string" || !boundary.scopeReason) fail("transition_scope_manifest_invalid", "Scope manifest exclusion boundary is malformed.");
    const anchor = boundary.sourceAnchor;
    if (!anchor || typeof anchor.sourcePath !== "string" || !Number.isInteger(anchor.startByte) || !Number.isInteger(anchor.endByte) || anchor.endByte <= anchor.startByte || !SHA256.test(anchor.sourceSliceSha256 ?? "") || !SHA256.test(anchor.sourceFileSha256 ?? "")) fail("transition_scope_manifest_invalid", "Scope manifest exclusion boundary needs an exact source anchor.", { boundaryId: boundary.boundaryId });
    if (["virtual_dispatch", "delegate", "content_lookup", "event_registration", "external"].includes(boundary.boundaryKind)) fail("transition_scope_manifest_disallowed_exclusion", "Dynamic, content, delegate, registration, and external routes cannot be globally excluded from normal-player vanilla scope.", { boundaryId: boundary.boundaryId, boundaryKind: boundary.boundaryKind });
    boundaries.set(boundary.boundaryId, boundary);
  }
  return Object.freeze({ boundaryById: boundaries, sameAnchor });
}
