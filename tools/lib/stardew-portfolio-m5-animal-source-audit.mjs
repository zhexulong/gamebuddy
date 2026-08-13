import { createHash } from "node:crypto";

const HASH = /^[a-f0-9]{64}$/;
const ROOT = "ref/external/StardewValleyDecompiled/Stardew Valley/";
const EXPECTED_ANCHORS = Object.freeze(
  new Map([
    [
      "trough_hay_placement_commit",
      { semanticRole: "animal_housing_trough_hay_commit", relativePath: "StardewValley/AnimalHouse.cs" },
    ],
    [
      "location_to_animal_day_update",
      { semanticRole: "native_location_animal_day_continuation", relativePath: "StardewValley/GameLocation.cs" },
    ],
    [
      "animal_day_update_owner",
      { semanticRole: "same_animal_native_day_owner", relativePath: "StardewValley/FarmAnimal.cs" },
    ],
    [
      "animal_produce_eligibility_partition",
      {
        semanticRole: "animal_product_eligibility_and_randomness_partition",
        relativePath: "StardewValley/FarmAnimal.cs",
      },
    ],
    [
      "animal_product_availability_commit",
      { semanticRole: "same_animal_product_availability_commit", relativePath: "StardewValley/FarmAnimal.cs" },
    ],
    [
      "milk_pail_target_selection",
      { semanticRole: "normal_player_tool_target_selection", relativePath: "StardewValley.Tools/MilkPail.cs" },
    ],
    [
      "milk_pail_delivery_guard",
      { semanticRole: "animal_product_tool_and_capacity_guard", relativePath: "StardewValley.Tools/MilkPail.cs" },
    ],
    [
      "milk_pail_inventory_commit",
      { semanticRole: "animal_product_inventory_delivery_commit", relativePath: "StardewValley.Tools/MilkPail.cs" },
    ],
    [
      "milk_pail_product_consumption",
      { semanticRole: "same_animal_product_consumption_commit", relativePath: "StardewValley.Tools/MilkPail.cs" },
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
    fail(`${name} must be an object.`, "portfolio_m5_source_audit_invalid");
  return value;
}
function exactKeys(value, expected, name) {
  record(value, name);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    fail(`${name} has unknown or missing fields.`, "portfolio_m5_source_audit_invalid");
}
function text(value, name) {
  if (typeof value !== "string" || value.trim() === "")
    fail(`${name} must be a non-empty string.`, "portfolio_m5_source_audit_invalid");
  return value;
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Revalidates a deliberately non-publishable M5 local source-snapshot audit aid. */
export function validatePortfolioM5AnimalSourceAudit(model, sourceFiles) {
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
    "M5 source audit",
  );
  if (
    model.schemaVersion !== 1 ||
    model.artifactKind !== "portfolio_focused_source_audit" ||
    model.auditId !== "portfolio_m5_animal_product_source_audit_v1" ||
    model.traceFamilyId !== "portfolio_m5_animal_housing_to_product" ||
    model.topology !== "single_player_native_companion"
  )
    fail("M5 source audit identity/topology is invalid.", "portfolio_m5_source_audit_invalid");
  exactKeys(model.charterAuthority, ["modelId", "scopeDocument", "scopeDocumentSha256"], "charterAuthority");
  if (
    model.charterAuthority.modelId !== "core_valley_milestone_portfolio_v1_command_path_charter" ||
    model.charterAuthority.scopeDocument !== "design/16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md" ||
    !HASH.test(model.charterAuthority.scopeDocumentSha256 ?? "")
  )
    fail("M5 source audit is not bound to the Portfolio Charter authority.", "portfolio_m5_source_audit_invalid");
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
      "M5 source audit must retain its unverified audit-aid boundary.",
      "portfolio_m5_source_audit_boundary_invalid",
    );
  if (!Array.isArray(model.anchors) || model.anchors.length !== EXPECTED_ANCHORS.size)
    fail("M5 source audit must retain its complete focused anchor set.", "portfolio_m5_source_audit_anchor_invalid");
  const ids = new Set();
  for (const anchor of model.anchors) {
    exactKeys(
      anchor,
      ["anchorId", "relativePath", "startByte", "endByte", "fileSha256", "sliceSha256", "needle", "semanticRole"],
      "M5 source anchor",
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
      fail("M5 source audit anchor identity or shape is invalid.", "portfolio_m5_source_audit_anchor_invalid");
    ids.add(id);
    const bytes = sourceFiles?.[anchor.relativePath];
    if (!Buffer.isBuffer(bytes))
      fail(
        `M5 source audit source is unavailable: ${anchor.relativePath}.`,
        "portfolio_m5_source_audit_source_missing",
      );
    const slice = bytes.subarray(anchor.startByte, anchor.endByte);
    if (
      anchor.endByte > bytes.length ||
      hash(bytes) !== anchor.fileSha256 ||
      hash(slice) !== anchor.sliceSha256 ||
      !slice.toString("utf8").includes(text(anchor.needle, `${id}.needle`))
    )
      fail(`M5 source audit anchor drifted: ${id}.`, "portfolio_m5_source_audit_anchor_drift");
  }
  if (ids.size !== EXPECTED_ANCHORS.size)
    fail("M5 source audit anchor set is incomplete.", "portfolio_m5_source_audit_anchor_invalid");
  if (
    !Array.isArray(model.observedSemanticConstraints) ||
    model.observedSemanticConstraints.length < 6 ||
    !Array.isArray(model.unresolvedQuestions) ||
    model.unresolvedQuestions.length < 5
  )
    fail(
      "M5 source audit must preserve semantic constraints and unresolved blockers.",
      "portfolio_m5_source_audit_invalid",
    );
  for (const question of model.unresolvedQuestions) {
    exactKeys(question, ["questionId", "question", "disposition"], "unresolved question");
    text(question.questionId, "questionId");
    text(question.question, "question");
    if (!["blocks_projection", "requires_signed_dsm_selection"].includes(question.disposition))
      fail("M5 source audit has an invalid unresolved-question disposition.", "portfolio_m5_source_audit_invalid");
  }
  exactKeys(model.conclusion, ["sourceRealizationStatus", "projectionState", "liveState", "nonClaim"], "conclusion");
  if (
    model.conclusion.sourceRealizationStatus !== "unknown" ||
    model.conclusion.projectionState !== "blocked" ||
    model.conclusion.liveState !== "not_performed"
  )
    fail(
      "M5 source audit cannot be promoted to realization, projection, or live closure.",
      "portfolio_m5_source_audit_boundary_invalid",
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
