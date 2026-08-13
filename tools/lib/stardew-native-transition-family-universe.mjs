import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const KINDS = new Set([
  "input_lifecycle",
  "world_interaction_dispatch",
  "movement_lifecycle",
  "content_protocol",
  "event_protocol",
  "save_day_network_protocol",
]);
const EXIT_KINDS = new Set([
  "direct_handoff",
  "polymorphic_handoff",
  "event_registration",
  "event_resume",
  "update_resume",
  "content_dispatch",
  "terminal",
]);
const FORBIDDEN = new Set([
  "action",
  "actionId",
  "primitive",
  "primitiveId",
  "operation",
  "operationId",
  "semanticFamily",
  "intent",
  "contract",
  "receipt",
  "evidence",
  "policy",
  "capability",
  "publicActionId",
  "projection",
  "reuse",
  "playerOutcome",
]);
function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function noProductTerms(value, at = "$") {
  if (Array.isArray(value)) return value.forEach((item, i) => noProductTerms(item, `${at}[${i}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN.has(key))
      fail("transition_family_universe_forbidden_field", `Transition-family universe must not infer ${key}.`, {
        at: `${at}.${key}`,
      });
    noProductTerms(child, `${at}.${key}`);
  }
}
function exact(anchor, sourceFiles, label) {
  if (
    !anchor ||
    typeof anchor.relativePath !== "string" ||
    !Number.isInteger(anchor.startByte) ||
    !Number.isInteger(anchor.endByte) ||
    anchor.endByte <= anchor.startByte ||
    !SHA256.test(anchor.sliceSha256 ?? "") ||
    !SHA256.test(anchor.sourceFileSha256 ?? "")
  )
    fail("transition_family_universe_anchor_invalid", `Expected exact ${label} anchor.`);
  const source = sourceFiles?.[anchor.relativePath];
  if (!source || source.sha256 !== anchor.sourceFileSha256)
    fail("transition_family_universe_source_missing", `Missing exact source for ${label}.`);
  const bytes = Buffer.from(source.text, "utf8");
  if (anchor.endByte > bytes.length || sha(bytes.subarray(anchor.startByte, anchor.endByte)) !== anchor.sliceSha256)
    fail("transition_family_universe_anchor_stale", `Stale ${label} anchor.`);
}
export function validateNativeTransitionFamilyUniverse(universe, { sourceFiles } = {}) {
  noProductTerms(universe);
  if (
    !universe ||
    ![1, 2].includes(universe.schemaVersion) ||
    universe.artifactKind !== "native_transition_family_universe"
  )
    fail(
      "transition_family_universe_schema_invalid",
      "Expected native transition-family universe schema version 1 or 2.",
    );
  if (universe.schemaVersion === 2) {
    const attestation = universe.attestation;
    const expected = ["targetAssemblySha256", "sourceManifestSha256", "contentManifestSha256"];
    if (
      !attestation ||
      Object.keys(attestation).length !== expected.length ||
      expected.some((name) => !SHA256.test(attestation[name] ?? ""))
    )
      fail(
        "transition_family_universe_attestation_invalid",
        "Schema v2 requires exact target, source, and content attestations.",
      );
  }
  if (!Array.isArray(universe.families) || !universe.families.length)
    fail("transition_family_universe_missing", "At least one family is required.");
  const ids = new Set();
  const exitIds = new Set();
  const gapIds = new Set();
  let gapCount = 0;
  for (const family of universe.families) {
    if (!/^source-family:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(family?.familyId ?? "") || ids.has(family.familyId))
      fail("transition_family_universe_id_invalid", "Family identity must be a unique neutral source-family ID.");
    ids.add(family.familyId);
    if (!KINDS.has(family.familyKind))
      fail("transition_family_universe_kind_invalid", "Unknown structural family kind.");
    if (!Array.isArray(family.regions) || !family.regions.length)
      fail("transition_family_universe_regions_missing", "Every family requires one or more source-owned regions.");
    if (!Array.isArray(family.gaps) || !family.gaps.length)
      fail("transition_family_universe_gaps_missing", "A partial family must preserve source blocking gaps.");
    for (const region of family.regions) {
      if (!/^region:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(region?.regionId ?? ""))
        fail("transition_family_universe_region_invalid", "Region must use neutral region:<kebab-case> ID.");
      exact(region.ownerAnchor, sourceFiles, `region ${region.regionId}`);
      if (!Array.isArray(region.exits) || !region.exits.length)
        fail("transition_family_universe_exits_missing", "Every source-owned region needs an explicit exit inventory.");
      for (const exit of region.exits) {
        if (!/^exit:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(exit?.exitId ?? "") || exitIds.has(exit.exitId))
          fail("transition_family_universe_exit_invalid", "Every exit needs a unique neutral exit:<kebab-case> ID.");
        exitIds.add(exit.exitId);
        if (!EXIT_KINDS.has(exit.exitKind))
          fail("transition_family_universe_exit_kind_invalid", "Every exit needs a structural exit kind.");
        exact(exit.anchor, sourceFiles, `exit ${exit.exitId}`);
      }
    }
    for (const gap of family.gaps) {
      if (
        !/^gap:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gap?.gapId ?? "") ||
        gapIds.has(gap.gapId) ||
        gap.possiblyGameplayBearing !== true
      )
        fail(
          "transition_family_universe_gap_invalid",
          "Every partial family gap must be a unique blocking neutral gap.",
        );
      gapIds.add(gap.gapId);
      exact(gap.anchor, sourceFiles, `gap ${gap.gapId}`);
      gapCount += 1;
    }
  }
  return Object.freeze({
    familyCount: universe.families.length,
    blockingGapCount: gapCount,
    closureState: "partial_with_blocking_gaps",
    analysisBoundary: Object.freeze({
      transitionIdentity: "not_derived",
      primitiveBasis: "not_derived",
      contextualEquivalence: "not_performed",
      playerOperationDerivation: "not_performed",
      publicActionProjection: "not_performed",
    }),
  });
}
