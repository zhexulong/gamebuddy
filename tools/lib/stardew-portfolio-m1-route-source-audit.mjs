import { createHash } from "node:crypto";

const HASH = /^[a-f0-9]{64}$/;
const ROOT = "ref/external/StardewValleyDecompiled/Stardew Valley/";
const EXPECTED_CHARTER_DOCUMENT = "tools/stardew-portfolio-command-path-charter.json";
const REQUIRED_SEMANTIC_CONSTRAINTS = Object.freeze([
  "normal_local_player_movement_discovers_a_live_map_warp_before_delegating_to_the_native_warp_lifecycle",
  "a_warp_request_can_adjust_or reject route-dependent destination state before it starts the native fade/location-request protocol",
  "the_location_transition_has_a_pending_protocol_boundary_before_current_location_and_player_current_location_commit",
  "map_and_door_transition_targets_are_content_and_current-state dependent rather_than_a_static_bridge_coordinate_list",
  "selected_outside_obligation_completion_is_not_implied_by_arrival_and_return_requires_a_fresh_current_location_observation",
  "source_snapshot_does_not_authorize_raw_position_mutation_raw_ui_input_generic_route_dispatch_or_any_bridge_projection",
]);
const REQUIRED_NON_CLAIM =
  "This is a focused audit-aid dossier. It does not mark the Charter trace realized, derive a capability, authorize a bridge route, close a CCM row, or establish a live result.";
const EXPECTED_ANCHORS = Object.freeze(
  new Map([
    [
      "normal_player_warp_collision_ingress",
      {
        semanticRole: "normal_player_movement_warp_guard_and_target_discovery",
        relativePath: "StardewValley/Farmer.cs",
      },
    ],
    [
      "normal_player_warp_dispatch",
      { semanticRole: "normal_player_native_warp_dispatch", relativePath: "StardewValley/Farmer.cs" },
    ],
    [
      "normal_player_warp_native_delegation",
      { semanticRole: "normal_player_warp_delegation", relativePath: "StardewValley/Farmer.cs" },
    ],
    [
      "warp_request_entry",
      { semanticRole: "native_location_warp_request_and_route_adjustment", relativePath: "StardewValley/Game1.cs" },
    ],
    ["warp_protocol_begin", { semanticRole: "native_warp_protocol_start", relativePath: "StardewValley/Game1.cs" }],
    [
      "warp_location_commit",
      { semanticRole: "native_location_and_player_location_commit", relativePath: "StardewValley/Game1.cs" },
    ],
    [
      "warp_post_commit_hook",
      { semanticRole: "native_post_warp_lifecycle_hook", relativePath: "StardewValley/Game1.cs" },
    ],
    [
      "map_warp_population",
      { semanticRole: "map_defined_native_warp_discovery", relativePath: "StardewValley/GameLocation.cs" },
    ],
    [
      "door_warp_resolution",
      { semanticRole: "native_door_transition_resolution", relativePath: "StardewValley/GameLocation.cs" },
    ],
    [
      "touch_warp_transition",
      { semanticRole: "native_touch_transition_guard_and_dispatch", relativePath: "StardewValley/GameLocation.cs" },
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
    fail(`${name} must be an object.`, "portfolio_m1_source_audit_invalid");
  return value;
}
function exactKeys(value, expected, name) {
  record(value, name);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    fail(`${name} has unknown or missing fields.`, "portfolio_m1_source_audit_invalid");
}
function text(value, name) {
  if (typeof value !== "string" || value.trim() === "")
    fail(`${name} must be a non-empty string.`, "portfolio_m1_source_audit_invalid");
  return value;
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function sameArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** Verifies that the declared Charter exists and retains the exact M1 trace/topology binding. */
export function validatePortfolioM1RouteCharterBinding(model, charter) {
  record(charter, "Portfolio Charter");
  if (
    charter.modelId !== model.charterAuthority.modelId ||
    charter.topology !== model.topology ||
    charter.scopeAuthority?.document !== model.charterAuthority.scopeDocument ||
    charter.scopeAuthority?.sha256 !== model.charterAuthority.scopeDocumentSha256 ||
    !Array.isArray(charter.traceFamilies) ||
    !charter.traceFamilies.some((trace) => trace?.traceFamilyId === model.traceFamilyId)
  ) {
    fail(
      "M1 source audit no longer matches the current Portfolio Charter trace binding.",
      "portfolio_m1_source_audit_charter_mismatch",
    );
  }
}

/** Verifies each provenance hash within its designated design/13 evidence row, not merely anywhere in the document. */
export function validatePortfolioM1RouteProvenance(model, provenance) {
  const textValue = text(provenance, "M1 source audit provenance");
  const snapshot = model.auditSource.localSnapshotContentManifestSha256;
  const assembly = model.auditSource.targetAssemblySha256;
  if (
    !textValue.includes(`| Tree **content** manifest hash | \`${snapshot}\``) ||
    !textValue.includes(
      `| Licensed assembly path/version/SHA-256 | \`Stardew Valley.dll\`; file version \`1.6.15.24356\`; length \`6,268,416\` bytes; SHA-256 \`${assembly}\``,
    )
  ) {
    fail(
      "M1 source audit provenance hashes are absent from their designated design/13 evidence rows.",
      "portfolio_m1_source_audit_provenance_mismatch",
    );
  }
}

/** Revalidates M1's non-publishable local source-audit dossier without promoting its Charter trace. */
export function validatePortfolioM1RouteSourceAudit(model, sourceFiles) {
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
    "M1 source audit",
  );
  if (
    model.schemaVersion !== 1 ||
    model.artifactKind !== "portfolio_focused_source_audit" ||
    model.auditId !== "portfolio_m1_route_source_audit_v1" ||
    model.traceFamilyId !== "portfolio_m1_leave_and_return_route" ||
    model.topology !== "single_player_native_companion"
  )
    fail("M1 source audit identity/topology is invalid.", "portfolio_m1_source_audit_invalid");
  exactKeys(
    model.charterAuthority,
    ["modelId", "charterDocument", "scopeDocument", "scopeDocumentSha256"],
    "charterAuthority",
  );
  if (
    model.charterAuthority.modelId !== "core_valley_milestone_portfolio_v1_command_path_charter" ||
    model.charterAuthority.charterDocument !== EXPECTED_CHARTER_DOCUMENT ||
    model.charterAuthority.scopeDocument !== "design/16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md" ||
    !HASH.test(model.charterAuthority.scopeDocumentSha256 ?? "")
  )
    fail("M1 source audit is not bound to the Portfolio Charter authority.", "portfolio_m1_source_audit_invalid");
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
      "M1 source audit must retain its unverified audit-aid boundary.",
      "portfolio_m1_source_audit_boundary_invalid",
    );
  if (!Array.isArray(model.anchors) || model.anchors.length !== EXPECTED_ANCHORS.size)
    fail("M1 source audit must retain its complete focused anchor set.", "portfolio_m1_source_audit_anchor_invalid");
  const ids = new Set();
  for (const anchor of model.anchors) {
    exactKeys(
      anchor,
      ["anchorId", "relativePath", "startByte", "endByte", "fileSha256", "sliceSha256", "needle", "semanticRole"],
      "M1 source anchor",
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
      fail("M1 source audit anchor identity or shape is invalid.", "portfolio_m1_source_audit_anchor_invalid");
    ids.add(id);
    const bytes = sourceFiles?.[anchor.relativePath];
    if (!Buffer.isBuffer(bytes))
      fail(
        `M1 source audit source is unavailable: ${anchor.relativePath}.`,
        "portfolio_m1_source_audit_source_missing",
      );
    const slice = bytes.subarray(anchor.startByte, anchor.endByte);
    if (
      anchor.endByte > bytes.length ||
      hash(bytes) !== anchor.fileSha256 ||
      hash(slice) !== anchor.sliceSha256 ||
      !slice.toString("utf8").includes(text(anchor.needle, `${id}.needle`))
    )
      fail(`M1 source audit anchor drifted: ${id}.`, "portfolio_m1_source_audit_anchor_drift");
  }
  if (ids.size !== EXPECTED_ANCHORS.size)
    fail("M1 source audit anchor set is incomplete.", "portfolio_m1_source_audit_anchor_invalid");
  if (
    !sameArray(model.observedSemanticConstraints, REQUIRED_SEMANTIC_CONSTRAINTS) ||
    !Array.isArray(model.unresolvedQuestions) ||
    model.unresolvedQuestions.length < 5
  )
    fail(
      "M1 source audit must preserve its fixed semantic constraints and unresolved blockers.",
      "portfolio_m1_source_audit_invalid",
    );
  for (const question of model.unresolvedQuestions) {
    exactKeys(question, ["questionId", "question", "disposition"], "unresolved question");
    text(question.questionId, "questionId");
    text(question.question, "question");
    if (!["blocks_projection", "requires_signed_dsm_selection"].includes(question.disposition))
      fail("M1 source audit has an invalid unresolved-question disposition.", "portfolio_m1_source_audit_invalid");
  }
  exactKeys(
    model.conclusion,
    ["sourceRealizationStatus", "projectionState", "liveState", "authorizationBoundary", "nonClaim"],
    "conclusion",
  );
  exactKeys(
    model.conclusion.authorizationBoundary,
    [
      "rawUiInput",
      "rawPositionMutation",
      "genericRouteDispatch",
      "bridgeProjection",
      "capabilityDerivation",
      "ccmClosure",
      "liveResult",
    ],
    "conclusion.authorizationBoundary",
  );
  if (
    model.conclusion.sourceRealizationStatus !== "unknown" ||
    model.conclusion.projectionState !== "blocked" ||
    model.conclusion.liveState !== "not_performed" ||
    model.conclusion.authorizationBoundary.rawUiInput !== "forbidden" ||
    model.conclusion.authorizationBoundary.rawPositionMutation !== "forbidden" ||
    model.conclusion.authorizationBoundary.genericRouteDispatch !== "forbidden" ||
    model.conclusion.authorizationBoundary.bridgeProjection !== "forbidden" ||
    model.conclusion.authorizationBoundary.capabilityDerivation !== "forbidden" ||
    model.conclusion.authorizationBoundary.ccmClosure !== "forbidden" ||
    model.conclusion.authorizationBoundary.liveResult !== "not_established" ||
    model.conclusion.nonClaim !== REQUIRED_NON_CLAIM
  )
    fail(
      "M1 source audit cannot authorize execution or be promoted to realization, projection, CCM, or live closure.",
      "portfolio_m1_source_audit_boundary_invalid",
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
