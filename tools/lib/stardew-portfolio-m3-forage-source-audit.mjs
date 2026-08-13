import { createHash } from "node:crypto";

const HASH = /^[a-f0-9]{64}$/;
const ROOT = "ref/external/StardewValleyDecompiled/Stardew Valley/";
const EXPECTED_ANCHORS = Object.freeze(
  new Map([
    ["forage_normal_player_range_ingress", "normal_player_check_action_range_ingress"],
    ["spawned_object_delivery_branch", "spawned_object_delivery_branch_owner"],
    ["forage_capacity_guard", "forage_capacity_guard"],
    ["forage_inventory_and_removal_commit", "spawned_object_inventory_delivery_commit"],
    ["forage_object_removal_commit", "spawned_object_removal_commit"],
    ["debris_inventory_delivery_capacity_commit", "debris_inventory_delivery_and_capacity_owner"],
  ]),
);
const EXPECTED_SOURCE_FILES = Object.freeze(
  new Map([
    ["forage_normal_player_range_ingress", "StardewValley/Game1.cs"],
    ["spawned_object_delivery_branch", "StardewValley/GameLocation.cs"],
    ["forage_capacity_guard", "StardewValley/GameLocation.cs"],
    ["forage_inventory_and_removal_commit", "StardewValley/GameLocation.cs"],
    ["forage_object_removal_commit", "StardewValley/GameLocation.cs"],
    ["debris_inventory_delivery_capacity_commit", "StardewValley/Debris.cs"],
  ]),
);
function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function record(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${name} must be an object.`, "portfolio_m3_source_audit_invalid");
  return value;
}
function exactKeys(value, expected, name) {
  record(value, name);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    fail(`${name} has unknown or missing fields.`, "portfolio_m3_source_audit_invalid");
}
function text(value, name) {
  if (typeof value !== "string" || value.trim() === "")
    fail(`${name} must be a non-empty string.`, "portfolio_m3_source_audit_invalid");
  return value;
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Revalidates the deliberately non-publishable M3 audit-aid dossier against its local source snapshot. */
export function validatePortfolioM3ForageSourceAudit(model, sourceFiles) {
  exactKeys(
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
    "M3 source audit",
  );
  if (
    model.schemaVersion !== 1 ||
    model.artifactKind !== "portfolio_focused_source_audit" ||
    model.auditId !== "portfolio_m3_forage_delivery_source_audit_v1" ||
    model.traceFamilyId !== "portfolio_m3_forage_to_inventory" ||
    model.topology !== "single_player_native_companion"
  )
    fail("M3 source audit identity/topology is invalid.", "portfolio_m3_source_audit_invalid");
  exactKeys(model.charterAuthority, ["modelId", "scopeDocument", "scopeDocumentSha256"], "charterAuthority");
  if (
    model.charterAuthority.modelId !== "core_valley_milestone_portfolio_v1_command_path_charter" ||
    model.charterAuthority.scopeDocument !== "design/16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md" ||
    !HASH.test(model.charterAuthority.scopeDocumentSha256 ?? "")
  )
    fail("M3 source audit is not bound to the Portfolio Charter authority.", "portfolio_m3_source_audit_invalid");
  exactKeys(
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
    fail(
      "M3 source audit must retain its unverified audit-aid boundary.",
      "portfolio_m3_source_audit_boundary_invalid",
    );
  if (!Array.isArray(model.anchors) || model.anchors.length !== EXPECTED_ANCHORS.size)
    fail("M3 source audit must retain its complete focused anchor set.", "portfolio_m3_source_audit_anchor_invalid");
  const ids = new Set();
  for (const anchor of model.anchors) {
    exactKeys(
      anchor,
      ["anchorId", "relativePath", "startByte", "endByte", "fileSha256", "sliceSha256", "needle", "semanticRole"],
      "M3 source anchor",
    );
    const id = text(anchor.anchorId, "anchorId");
    if (
      ids.has(id) ||
      EXPECTED_ANCHORS.get(id) !== anchor.semanticRole ||
      EXPECTED_SOURCE_FILES.get(id) !== anchor.relativePath ||
      !Number.isInteger(anchor.startByte) ||
      !Number.isInteger(anchor.endByte) ||
      anchor.startByte < 0 ||
      anchor.endByte <= anchor.startByte ||
      !HASH.test(anchor.fileSha256 ?? "") ||
      !HASH.test(anchor.sliceSha256 ?? "")
    )
      fail("M3 source audit anchor identity or shape is invalid.", "portfolio_m3_source_audit_anchor_invalid");
    ids.add(id);
    const bytes = sourceFiles?.[anchor.relativePath];
    if (!Buffer.isBuffer(bytes))
      fail(
        `M3 source audit source is unavailable: ${anchor.relativePath}.`,
        "portfolio_m3_source_audit_source_missing",
      );
    const slice = bytes.subarray(anchor.startByte, anchor.endByte);
    if (
      anchor.endByte > bytes.length ||
      hash(bytes) !== anchor.fileSha256 ||
      hash(slice) !== anchor.sliceSha256 ||
      !slice.toString("utf8").includes(text(anchor.needle, `${id}.needle`))
    )
      fail(`M3 source audit anchor drifted: ${id}.`, "portfolio_m3_source_audit_anchor_drift");
  }
  if (ids.size !== EXPECTED_ANCHORS.size)
    fail("M3 source audit anchor set is incomplete.", "portfolio_m3_source_audit_anchor_invalid");
  if (
    !Array.isArray(model.observedSemanticConstraints) ||
    model.observedSemanticConstraints.length < 5 ||
    !Array.isArray(model.unresolvedQuestions) ||
    model.unresolvedQuestions.length < 5
  )
    fail(
      "M3 source audit must preserve semantic constraints and unresolved blockers.",
      "portfolio_m3_source_audit_invalid",
    );
  for (const question of model.unresolvedQuestions) {
    exactKeys(question, ["questionId", "question", "disposition"], "unresolved question");
    text(question.questionId, "questionId");
    text(question.question, "question");
    if (!["blocks_projection", "requires_signed_dsm_selection"].includes(question.disposition))
      fail("M3 source audit has an invalid unresolved-question disposition.", "portfolio_m3_source_audit_invalid");
  }
  exactKeys(model.conclusion, ["sourceRealizationStatus", "projectionState", "liveState", "nonClaim"], "conclusion");
  if (
    model.conclusion.sourceRealizationStatus !== "unknown" ||
    model.conclusion.projectionState !== "blocked" ||
    model.conclusion.liveState !== "not_performed"
  )
    fail(
      "M3 source audit cannot be promoted to realization, projection, or live closure.",
      "portfolio_m3_source_audit_boundary_invalid",
    );
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
