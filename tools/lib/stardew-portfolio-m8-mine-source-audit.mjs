import { createHash } from "node:crypto";
const HASH = /^[a-f0-9]{64}$/;
const ROOT = "ref/external/StardewValleyDecompiled/Stardew Valley/";
const EXPECTED_ANCHORS = Object.freeze(
  new Map([
    [
      "normal_player_mine_check_action_ingress",
      { semanticRole: "normal_player_nearby_mine_transition_ingress", relativePath: "StardewValley/Game1.cs" },
    ],
    [
      "mine_elevator_presentation_ingress",
      { semanticRole: "mine_elevator_presentation_ingress", relativePath: "StardewValley.Locations/MineShaft.cs" },
    ],
    [
      "mine_elevator_progress_guard",
      { semanticRole: "mine_elevator_prior_depth_guard", relativePath: "StardewValley.Menus/MineElevatorMenu.cs" },
    ],
    [
      "mine_elevator_target_transition",
      {
        semanticRole: "mine_elevator_target_floor_transition",
        relativePath: "StardewValley.Menus/MineElevatorMenu.cs",
      },
    ],
    [
      "mine_ladder_target_transition",
      { semanticRole: "mine_ladder_target_floor_transition", relativePath: "StardewValley.Locations/MineShaft.cs" },
    ],
    [
      "mine_target_floor_warp",
      { semanticRole: "mine_target_floor_native_warp", relativePath: "StardewValley/Game1.cs" },
    ],
    [
      "mine_ladder_spawn_guard",
      { semanticRole: "mine_ladder_spawn_prerequisite_guard", relativePath: "StardewValley.Locations/MineShaft.cs" },
    ],
    [
      "mine_ladder_pending_creation",
      { semanticRole: "mine_ladder_pending_creation_event", relativePath: "StardewValley.Locations/MineShaft.cs" },
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
    fail(`${name} must be an object.`, "portfolio_m8_source_audit_invalid");
  return value;
}
function exactKeys(value, expected, name) {
  record(value, name);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    fail(`${name} has unknown or missing fields.`, "portfolio_m8_source_audit_invalid");
}
function text(value, name) {
  if (typeof value !== "string" || value.trim() === "")
    fail(`${name} must be a non-empty string.`, "portfolio_m8_source_audit_invalid");
  return value;
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
export function validatePortfolioM8MineSourceAudit(model, sourceFiles) {
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
    "M8 source audit",
  );
  if (
    model.schemaVersion !== 1 ||
    model.artifactKind !== "portfolio_focused_source_audit" ||
    model.auditId !== "portfolio_m8_mine_route_source_audit_v1" ||
    model.traceFamilyId !== "portfolio_m8_native_mine_route" ||
    model.topology !== "single_player_native_companion"
  )
    fail("M8 source audit identity/topology is invalid.", "portfolio_m8_source_audit_invalid");
  exactKeys(model.charterAuthority, ["modelId", "scopeDocument", "scopeDocumentSha256"], "charterAuthority");
  if (
    model.charterAuthority.modelId !== "core_valley_milestone_portfolio_v1_command_path_charter" ||
    model.charterAuthority.scopeDocument !== "design/16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md" ||
    !HASH.test(model.charterAuthority.scopeDocumentSha256 ?? "")
  )
    fail("M8 source audit is not bound to the Portfolio Charter authority.", "portfolio_m8_source_audit_invalid");
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
      "M8 source audit must retain its unverified audit-aid boundary.",
      "portfolio_m8_source_audit_boundary_invalid",
    );
  if (!Array.isArray(model.anchors) || model.anchors.length !== EXPECTED_ANCHORS.size)
    fail("M8 source audit must retain its complete focused anchor set.", "portfolio_m8_source_audit_anchor_invalid");
  const ids = new Set();
  for (const anchor of model.anchors) {
    exactKeys(
      anchor,
      ["anchorId", "relativePath", "startByte", "endByte", "fileSha256", "sliceSha256", "needle", "semanticRole"],
      "M8 source anchor",
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
      fail("M8 source audit anchor identity or shape is invalid.", "portfolio_m8_source_audit_anchor_invalid");
    ids.add(id);
    const bytes = sourceFiles?.[anchor.relativePath];
    if (!Buffer.isBuffer(bytes))
      fail(
        `M8 source audit source is unavailable: ${anchor.relativePath}.`,
        "portfolio_m8_source_audit_source_missing",
      );
    const slice = bytes.subarray(anchor.startByte, anchor.endByte);
    if (
      anchor.endByte > bytes.length ||
      hash(bytes) !== anchor.fileSha256 ||
      hash(slice) !== anchor.sliceSha256 ||
      !slice.toString("utf8").includes(text(anchor.needle, `${id}.needle`))
    )
      fail(`M8 source audit anchor drifted: ${id}.`, "portfolio_m8_source_audit_anchor_drift");
  }
  if (ids.size !== EXPECTED_ANCHORS.size)
    fail("M8 source audit anchor set is incomplete.", "portfolio_m8_source_audit_anchor_invalid");
  if (
    !Array.isArray(model.observedSemanticConstraints) ||
    model.observedSemanticConstraints.length < 6 ||
    !Array.isArray(model.unresolvedQuestions) ||
    model.unresolvedQuestions.length < 4
  )
    fail(
      "M8 source audit must preserve semantic constraints and unresolved blockers.",
      "portfolio_m8_source_audit_invalid",
    );
  for (const question of model.unresolvedQuestions) {
    exactKeys(question, ["questionId", "question", "disposition"], "unresolved question");
    text(question.questionId, "questionId");
    text(question.question, "question");
    if (question.disposition !== "blocks_projection")
      fail("M8 source audit has an invalid unresolved-question disposition.", "portfolio_m8_source_audit_invalid");
  }
  exactKeys(model.conclusion, ["sourceRealizationStatus", "projectionState", "liveState", "nonClaim"], "conclusion");
  if (
    model.conclusion.sourceRealizationStatus !== "unknown" ||
    model.conclusion.projectionState !== "blocked" ||
    model.conclusion.liveState !== "not_performed"
  )
    fail(
      "M8 source audit cannot be promoted to realization, projection, or live closure.",
      "portfolio_m8_source_audit_boundary_invalid",
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
