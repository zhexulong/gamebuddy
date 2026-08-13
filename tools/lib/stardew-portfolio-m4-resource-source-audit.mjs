import { createHash } from "node:crypto";

const HASH = /^[a-f0-9]{64}$/;
const ROOT = "ref/external/StardewValleyDecompiled/Stardew Valley/";
const EXPECTED_ANCHORS = Object.freeze(
  new Map([
    [
      "tool_location_ingress",
      { semanticRole: "native_tool_to_location_resource_router", relativePath: "StardewValley/GameLocation.cs" },
    ],
    [
      "resource_clump_dispatch",
      { semanticRole: "resource_clump_target_dispatch", relativePath: "StardewValley/GameLocation.cs" },
    ],
    [
      "resource_clump_tool_guard",
      {
        semanticRole: "resource_source_tool_guard_owner",
        relativePath: "StardewValley.TerrainFeatures/ResourceClump.cs",
      },
    ],
    [
      "resource_clump_health_commit",
      { semanticRole: "resource_source_health_commit", relativePath: "StardewValley.TerrainFeatures/ResourceClump.cs" },
    ],
    [
      "resource_clump_terminal_destroy",
      {
        semanticRole: "resource_source_terminal_destroy_owner",
        relativePath: "StardewValley.TerrainFeatures/ResourceClump.cs",
      },
    ],
    [
      "resource_clump_fresh_drop_creation",
      {
        semanticRole: "resource_source_debris_creation",
        relativePath: "StardewValley.TerrainFeatures/ResourceClump.cs",
      },
    ],
    ["debris_factory", { semanticRole: "native_debris_set_creation_owner", relativePath: "StardewValley/Game1.cs" }],
    [
      "debris_delivery_capacity_commit",
      { semanticRole: "debris_inventory_delivery_and_capacity_owner", relativePath: "StardewValley/Debris.cs" },
    ],
    [
      "debris_update_collection_continuation",
      { semanticRole: "debris_update_collection_continuation", relativePath: "StardewValley/Debris.cs" },
    ],
  ]),
);
function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function record(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${name} must be an object.`, "portfolio_m4_source_audit_invalid");
  return value;
}
function exactKeys(value, expected, name) {
  record(value, name);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    fail(`${name} has unknown or missing fields.`, "portfolio_m4_source_audit_invalid");
}
function text(value, name) {
  if (typeof value !== "string" || value.trim() === "")
    fail(`${name} must be a non-empty string.`, "portfolio_m4_source_audit_invalid");
  return value;
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Revalidates a deliberately non-publishable M4 local source-snapshot audit aid. */
export function validatePortfolioM4ResourceSourceAudit(model, sourceFiles) {
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
    "M4 source audit",
  );
  if (
    model.schemaVersion !== 1 ||
    model.artifactKind !== "portfolio_focused_source_audit" ||
    model.auditId !== "portfolio_m4_resource_delivery_source_audit_v1" ||
    model.traceFamilyId !== "portfolio_m4_source_to_delivery" ||
    model.topology !== "single_player_native_companion"
  )
    fail("M4 source audit identity/topology is invalid.", "portfolio_m4_source_audit_invalid");
  exactKeys(model.charterAuthority, ["modelId", "scopeDocument", "scopeDocumentSha256"], "charterAuthority");
  if (
    model.charterAuthority.modelId !== "core_valley_milestone_portfolio_v1_command_path_charter" ||
    model.charterAuthority.scopeDocument !== "design/16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md" ||
    !HASH.test(model.charterAuthority.scopeDocumentSha256 ?? "")
  )
    fail("M4 source audit is not bound to the Portfolio Charter authority.", "portfolio_m4_source_audit_invalid");
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
      "M4 source audit must retain its unverified audit-aid boundary.",
      "portfolio_m4_source_audit_boundary_invalid",
    );
  if (!Array.isArray(model.anchors) || model.anchors.length !== EXPECTED_ANCHORS.size)
    fail("M4 source audit must retain its complete focused anchor set.", "portfolio_m4_source_audit_anchor_invalid");
  const ids = new Set();
  for (const anchor of model.anchors) {
    exactKeys(
      anchor,
      ["anchorId", "relativePath", "startByte", "endByte", "fileSha256", "sliceSha256", "needle", "semanticRole"],
      "M4 source anchor",
    );
    const id = text(anchor.anchorId, "anchorId");
    const expected = EXPECTED_ANCHORS.get(id);
    if (
      ids.has(id) ||
      !expected ||
      expected.semanticRole !== anchor.semanticRole ||
      expected.relativePath !== anchor.relativePath ||
      !Number.isInteger(anchor.startByte) ||
      !Number.isInteger(anchor.endByte) ||
      anchor.startByte < 0 ||
      anchor.endByte <= anchor.startByte ||
      !HASH.test(anchor.fileSha256 ?? "") ||
      !HASH.test(anchor.sliceSha256 ?? "")
    )
      fail("M4 source audit anchor identity or shape is invalid.", "portfolio_m4_source_audit_anchor_invalid");
    ids.add(id);
    const bytes = sourceFiles?.[anchor.relativePath];
    if (!Buffer.isBuffer(bytes))
      fail(
        `M4 source audit source is unavailable: ${anchor.relativePath}.`,
        "portfolio_m4_source_audit_source_missing",
      );
    const slice = bytes.subarray(anchor.startByte, anchor.endByte);
    if (
      anchor.endByte > bytes.length ||
      hash(bytes) !== anchor.fileSha256 ||
      hash(slice) !== anchor.sliceSha256 ||
      !slice.toString("utf8").includes(text(anchor.needle, `${id}.needle`))
    )
      fail(`M4 source audit anchor drifted: ${id}.`, "portfolio_m4_source_audit_anchor_drift");
  }
  if (ids.size !== EXPECTED_ANCHORS.size)
    fail("M4 source audit anchor set is incomplete.", "portfolio_m4_source_audit_anchor_invalid");
  if (
    !Array.isArray(model.observedSemanticConstraints) ||
    model.observedSemanticConstraints.length < 6 ||
    !Array.isArray(model.unresolvedQuestions) ||
    model.unresolvedQuestions.length < 5
  )
    fail(
      "M4 source audit must preserve semantic constraints and unresolved blockers.",
      "portfolio_m4_source_audit_invalid",
    );
  for (const question of model.unresolvedQuestions) {
    exactKeys(question, ["questionId", "question", "disposition"], "unresolved question");
    text(question.questionId, "questionId");
    text(question.question, "question");
    if (!["blocks_projection", "requires_signed_dsm_selection"].includes(question.disposition))
      fail("M4 source audit has an invalid unresolved-question disposition.", "portfolio_m4_source_audit_invalid");
  }
  exactKeys(model.conclusion, ["sourceRealizationStatus", "projectionState", "liveState", "nonClaim"], "conclusion");
  if (
    model.conclusion.sourceRealizationStatus !== "unknown" ||
    model.conclusion.projectionState !== "blocked" ||
    model.conclusion.liveState !== "not_performed"
  )
    fail(
      "M4 source audit cannot be promoted to realization, projection, or live closure.",
      "portfolio_m4_source_audit_boundary_invalid",
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
