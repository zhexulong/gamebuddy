import { createHash } from "node:crypto";
const HASH = /^[a-f0-9]{64}$/;
const ROOT = "ref/external/StardewValleyDecompiled/Stardew Valley/";
const EXPECTED = new Map([
  ["museum_item_eligibility_guard", ["museum_donation_eligibility_guard", "StardewValley.Locations/LibraryMuseum.cs"]],
  [
    "museum_donation_mutex_presentation",
    ["museum_donation_mutex_presentation_boundary", "StardewValley.Locations/LibraryMuseum.cs"],
  ],
  ["museum_placement_guard", ["museum_piece_and_tile_eligibility_guard", "StardewValley.Menus/MuseumMenu.cs"]],
  ["museum_piece_commit", ["museum_piece_collection_commit", "StardewValley.Menus/MuseumMenu.cs"]],
  [
    "museum_donation_item_consumption",
    ["museum_donation_item_consumption_commit", "StardewValley.Menus/MuseumMenu.cs"],
  ],
  ["museum_reward_eligibility_guard", ["museum_reward_eligibility_guard", "StardewValley.Locations/LibraryMuseum.cs"]],
  [
    "museum_reward_collection_presentation",
    ["museum_reward_collection_presentation_boundary", "StardewValley.Locations/LibraryMuseum.cs"],
  ],
  ["museum_reward_claim_commit", ["museum_reward_claim_mail_commit", "StardewValley.Locations/LibraryMuseum.cs"]],
]);
function fail(message, code) {
  const e = new Error(message);
  e.code = code;
  throw e;
}
function record(v, n) {
  if (!v || typeof v !== "object" || Array.isArray(v))
    fail(`${n} must be an object.`, "portfolio_m10_source_audit_invalid");
  return v;
}
function exact(v, k, n) {
  record(v, n);
  const a = Object.keys(v).sort(),
    b = [...k].sort();
  if (a.length !== b.length || a.some((x, i) => x !== b[i]))
    fail(`${n} has unknown or missing fields.`, "portfolio_m10_source_audit_invalid");
}
function text(v, n) {
  if (typeof v !== "string" || !v.trim())
    fail(`${n} must be a non-empty string.`, "portfolio_m10_source_audit_invalid");
  return v;
}
const hash = (b) => createHash("sha256").update(b).digest("hex");
/** Revalidates a deliberately non-publishable M10 local source-snapshot audit aid. */
export function validatePortfolioM10MuseumSourceAudit(model, files) {
  exact(
    model,
    [
      "schemaVersion",
      "artifactKind",
      "auditId",
      "traceFamilyId",
      "topology",
      "charterAuthority",
      "auditSource",
      "anchors",
      "observedSemanticConstraints",
      "unresolvedQuestions",
      "conclusion",
    ],
    "M10 source audit",
  );
  if (
    model.schemaVersion !== 1 ||
    model.artifactKind !== "portfolio_focused_source_audit" ||
    model.auditId !== "portfolio_m10_museum_source_audit_v1" ||
    model.traceFamilyId !== "portfolio_m10_museum_subset_to_reward" ||
    model.topology !== "single_player_native_companion"
  )
    fail("M10 source audit identity/topology is invalid.", "portfolio_m10_source_audit_invalid");
  exact(model.charterAuthority, ["modelId", "scopeDocument", "scopeDocumentSha256"], "charterAuthority");
  if (
    model.charterAuthority.modelId !== "core_valley_milestone_portfolio_v1_command_path_charter" ||
    model.charterAuthority.scopeDocument !== "design/16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md" ||
    !HASH.test(model.charterAuthority.scopeDocumentSha256 ?? "")
  )
    fail("M10 source audit is not bound to Charter authority.", "portfolio_m10_source_audit_invalid");
  exact(
    model.auditSource,
    ["provenanceDocument", "localSnapshotContentManifestSha256", "targetAssemblySha256", "disposition"],
    "auditSource",
  );
  if (
    model.auditSource.provenanceDocument !== "design/13_STARDEW_NATIVE_PROVENANCE.md" ||
    !HASH.test(model.auditSource.localSnapshotContentManifestSha256 ?? "") ||
    !HASH.test(model.auditSource.targetAssemblySha256 ?? "") ||
    model.auditSource.disposition !== "unverified_audit_aid_blocks_target_version_realization"
  )
    fail("M10 source audit must retain its audit-aid boundary.", "portfolio_m10_source_audit_boundary_invalid");
  if (!Array.isArray(model.anchors) || model.anchors.length !== EXPECTED.size)
    fail("M10 source audit must retain its complete focused anchor set.", "portfolio_m10_source_audit_anchor_invalid");
  const ids = new Set();
  for (const a of model.anchors) {
    exact(
      a,
      ["anchorId", "relativePath", "startByte", "endByte", "fileSha256", "sliceSha256", "needle", "semanticRole"],
      "M10 source anchor",
    );
    const id = text(a.anchorId, "anchorId"),
      want = EXPECTED.get(id);
    if (
      ids.has(id) ||
      !want ||
      want[0] !== a.semanticRole ||
      want[1] !== a.relativePath ||
      !Number.isInteger(a.startByte) ||
      !Number.isInteger(a.endByte) ||
      a.startByte < 0 ||
      a.endByte <= a.startByte ||
      !HASH.test(a.fileSha256 ?? "") ||
      !HASH.test(a.sliceSha256 ?? "")
    )
      fail("M10 source audit anchor identity or shape is invalid.", "portfolio_m10_source_audit_anchor_invalid");
    ids.add(id);
    const bytes = files?.[a.relativePath];
    if (!Buffer.isBuffer(bytes))
      fail(`M10 source audit source is unavailable: ${a.relativePath}.`, "portfolio_m10_source_audit_source_missing");
    const slice = bytes.subarray(a.startByte, a.endByte);
    if (
      a.endByte > bytes.length ||
      hash(bytes) !== a.fileSha256 ||
      hash(slice) !== a.sliceSha256 ||
      !slice.toString("utf8").includes(text(a.needle, `${id}.needle`))
    )
      fail(`M10 source audit anchor drifted: ${id}.`, "portfolio_m10_source_audit_anchor_drift");
  }
  if (ids.size !== EXPECTED.size)
    fail("M10 source audit anchor set is incomplete.", "portfolio_m10_source_audit_anchor_invalid");
  if (
    !Array.isArray(model.observedSemanticConstraints) ||
    model.observedSemanticConstraints.length < 6 ||
    !Array.isArray(model.unresolvedQuestions) ||
    model.unresolvedQuestions.length < 5
  )
    fail(
      "M10 source audit must preserve semantic constraints and unresolved blockers.",
      "portfolio_m10_source_audit_invalid",
    );
  for (const q of model.unresolvedQuestions) {
    exact(q, ["questionId", "question", "disposition"], "unresolved question");
    text(q.questionId, "questionId");
    text(q.question, "question");
    if (!["blocks_projection", "requires_signed_dsm_selection"].includes(q.disposition))
      fail("M10 source audit has invalid unresolved disposition.", "portfolio_m10_source_audit_invalid");
  }
  exact(model.conclusion, ["sourceRealizationStatus", "projectionState", "liveState", "nonClaim"], "conclusion");
  if (
    model.conclusion.sourceRealizationStatus !== "unknown" ||
    model.conclusion.projectionState !== "blocked" ||
    model.conclusion.liveState !== "not_performed"
  )
    fail("M10 source audit cannot be promoted.", "portfolio_m10_source_audit_boundary_invalid");
  return Object.freeze({
    auditId: model.auditId,
    traceFamilyId: model.traceFamilyId,
    anchorCount: ids.size,
    sourceRealizationStatus: "unknown",
    projectionState: "blocked",
    liveState: "not_performed",
    sourceRoot: ROOT,
  });
}
