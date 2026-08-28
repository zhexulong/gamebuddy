#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Strict, pure JSON validator for the Task 7 frozen successor prerequisite:
 * the non-mutating "transition characterization" artifact.
 *
 * This validator is intentionally fail-closed. A valid artifact is either:
 *   - a `passed` terminal that proves a source-only characterization of the
 *     current loaded location: observed permitted source candidate families, a
 *     dry-plan safe approach, the SMAPI `Player.Warped` API shape verified,
 *     zero excluded families, zero mutations/receipts and a full fixture
 *     cleanup — it never asserts future route edges or event causal
 *     correlation; or
 *   - a `blocked` terminal carrying exactly one failure predicate whose body is
 *     consistent with the observed failure and that never implies a pass.
 *
 * It performs no target-runtime launch, no fixture, and no mutation.
 */

export const SCHEMA_VERSION = 1;
export const TARGET_BUILD = "1.6.15.24356";
export const TERMINAL_STATES = Object.freeze(["passed", "blocked"]);
export const PASS_PREDICATE = "successful_characterization";
export const BLOCK_PREDICATES = Object.freeze([
  "transition_family_unapproved",
  "approach_not_safe",
  "correlation_api_shape_unavailable",
  "cleanup_incomplete",
  "no_permitted_candidates",
]);

const METHOD_ANCHORS = Object.freeze({
  warpResolver: "GameLocation.warps",
  doorResolver: "GameLocation.getWarpFromDoor",
  approachPlanner: "PathFindController",
  correlation: "IPlayerEvents.Warped",
});

const ROOT_KEYS = Object.freeze([
  "schemaVersion",
  "terminalStatus",
  "targetBuild",
  "targetBinding",
  "methodAnchors",
  "observationScope",
  "opaqueEdgeIds",
  "permittedFamilyCounts",
  "excludedFamilyCounts",
  "dryPlanSafe",
  "correlationApiShapeVerified",
  "mutationCount",
  "executionReceiptCount",
  "fixtureCleanup",
  "predicateCode",
]);

const PERMITTED_FAMILY_KEYS = Object.freeze(["ordinaryWarp", "ordinaryDoor"]);
const EXCLUDED_FAMILY_KEYS = Object.freeze([
  "action",
  "touchAction",
  "modHook",
  "special",
  "m8",
  "missingIdentity",
  "unsafeApproach",
]);
const CLEANUP_KEYS = Object.freeze(["restored", "noStardewProcess", "noSmapiProcess"]);
// The probe hashes its private canonical source binding before it
// writes the artifact. Requiring this fixed opaque form proves the result cannot
// contain a location name, route, tile, or coordinate without trying to guess
// semantic words inside otherwise random opaque identifiers.
const OPAQUE_EDGE_ID = /^te1_[A-Za-z0-9_-]{16,}$/;
const BINDING_VALUE = /^tb1_[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 8 * 1024;

function exactRecord(value, keys) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isNonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateTransitionCharacterization(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({ valid: false, errors: Object.freeze(["artifact_invalid"]) });
  }

  if (!exactRecord(value, ROOT_KEYS)) errors.push("schema_shape:root");
  if (value.schemaVersion !== SCHEMA_VERSION) errors.push("schema_version");
  if (value.targetBuild !== TARGET_BUILD) errors.push("target_build");
  if (!TERMINAL_STATES.includes(value.terminalStatus)) errors.push("terminal_status");

  if (!exactRecord(value.methodAnchors, Object.keys(METHOD_ANCHORS))) {
    errors.push("schema_shape:method_anchors");
  } else if (!Object.entries(METHOD_ANCHORS).every(([key, expected]) => value.methodAnchors[key] === expected)) {
    errors.push("method_anchor");
  }

  if (!Array.isArray(value.opaqueEdgeIds)) {
    errors.push("opaque_edge_id");
  } else {
    // Every observed permitted source candidate carries exactly one opaque id;
    // duplicated ids are structurally invalid in any terminal state because a
    // single id cannot prove two distinct candidates.
    if (new Set(value.opaqueEdgeIds).size !== value.opaqueEdgeIds.length) errors.push("opaque_edge_id_duplicate");
    if (!value.opaqueEdgeIds.every((entry) => typeof entry === "string" && OPAQUE_EDGE_ID.test(entry)))
      errors.push("opaque_edge_id");
  }

  if (!exactRecord(value.permittedFamilyCounts, PERMITTED_FAMILY_KEYS)) {
    errors.push("schema_shape:permitted_family_counts");
  } else if (!PERMITTED_FAMILY_KEYS.every((key) => isNonNegativeInt(value.permittedFamilyCounts[key]))) {
    errors.push("permitted_family_count");
  }

  if (!exactRecord(value.excludedFamilyCounts, EXCLUDED_FAMILY_KEYS)) {
    errors.push("schema_shape:excluded_family_counts");
  } else if (!EXCLUDED_FAMILY_KEYS.every((key) => isNonNegativeInt(value.excludedFamilyCounts[key]))) {
    errors.push("excluded_family_count");
  }

  // The artifact may only describe the current loaded source location; it must
  // never claim coverage of a future route, a full tracer, or event correlation.
  if (value.observationScope !== "current_source_only") errors.push("observation_scope");
  if (typeof value.dryPlanSafe !== "boolean") errors.push("dry_plan_safe");
  if (typeof value.correlationApiShapeVerified !== "boolean") errors.push("correlation_api_shape_verified");
  if (value.mutationCount !== 0) errors.push("non_mutating_invariant:mutationCount");
  if (value.executionReceiptCount !== 0) errors.push("non_mutating_invariant:executionReceiptCount");

  if (!exactRecord(value.fixtureCleanup, CLEANUP_KEYS)) {
    errors.push("schema_shape:fixture_cleanup");
  } else if (!CLEANUP_KEYS.every((key) => typeof value.fixtureCleanup[key] === "boolean")) {
    errors.push("fixture_cleanup");
  }
  const status = value.terminalStatus;
  const predicate = value.predicateCode;
  if (typeof predicate !== "string") {
    errors.push("predicate_code");
  } else if (status === "passed" && predicate !== PASS_PREDICATE) {
    errors.push("terminal_predicate_mismatch");
  } else if (status === "blocked" && !BLOCK_PREDICATES.includes(predicate)) {
    errors.push("terminal_predicate_mismatch");
  } else if (status === "passed" && BLOCK_PREDICATES.includes(predicate)) {
    errors.push("terminal_predicate_mismatch");
  }
  // ---- pass-terminal proof requirements ----
  if (status === "passed") {
    const permittedTotal =
      (value.permittedFamilyCounts?.ordinaryWarp ?? 0) + (value.permittedFamilyCounts?.ordinaryDoor ?? 0);
    if (!(permittedTotal > 0)) errors.push("passed_proof:permitted_family_count");
    if (!(Array.isArray(value.opaqueEdgeIds) && value.opaqueEdgeIds.length > 0))
      errors.push("passed_proof:opaque_edge_ids");
    // One opaque id per observed permitted source candidate: the passed artifact
    // must cover exactly the candidates it counts, with no arbitrary cap.
    if (!(Array.isArray(value.opaqueEdgeIds) && value.opaqueEdgeIds.length === permittedTotal))
      errors.push("passed_proof:opaque_edge_coverage");
    if (value.dryPlanSafe !== true) errors.push("passed_proof:dry_plan_safe");
    // Static API-shape proof only: the SMAPI Player.Warped event surface
    // (WarpedEventArgs Player/OldLocation/NewLocation) exists. It does not
    // assert correlation with any future warp.
    if (value.correlationApiShapeVerified !== true) errors.push("passed_proof:correlation_api_shape");
    if (!value.excludedFamilyCounts || !EXCLUDED_FAMILY_KEYS.every((key) => value.excludedFamilyCounts[key] === 0))
      errors.push("passed_proof:excluded_family_count");
    if (!value.fixtureCleanup || !CLEANUP_KEYS.every((key) => value.fixtureCleanup[key] === true))
      errors.push("passed_proof:fixture_cleanup");
  }

  // ---- blocked terminal must be consistent with the observed failure and never imply a pass ----
  if (status === "blocked" && typeof predicate === "string") {
    const excludedPositive =
      !!value.excludedFamilyCounts && EXCLUDED_FAMILY_KEYS.some((key) => value.excludedFamilyCounts[key] > 0);
    if (predicate === "transition_family_unapproved" && !excludedPositive)
      errors.push("blocked_predicate_inconsistent");
    if (predicate === "approach_not_safe" && value.dryPlanSafe !== false) errors.push("blocked_predicate_inconsistent");
    if (predicate === "correlation_api_shape_unavailable" && value.correlationApiShapeVerified !== false)
      errors.push("blocked_predicate_inconsistent");
    if (
      predicate === "cleanup_incomplete" &&
      (!value.fixtureCleanup || CLEANUP_KEYS.every((key) => value.fixtureCleanup[key] === true))
    )
      errors.push("blocked_predicate_inconsistent");
    if (
      predicate === "no_permitted_candidates" &&
      (!value.permittedFamilyCounts ||
        value.permittedFamilyCounts.ordinaryWarp + value.permittedFamilyCounts.ordinaryDoor !== 0)
    )
      errors.push("blocked_predicate_inconsistent");
    // A blocked terminal carrying full pass evidence is contradictory (implies pass).
    const looksLikePass =
      !!value.permittedFamilyCounts &&
      value.permittedFamilyCounts.ordinaryWarp + value.permittedFamilyCounts.ordinaryDoor > 0 &&
      (Array.isArray(value.opaqueEdgeIds) ? value.opaqueEdgeIds.length : 0) > 0 &&
      value.dryPlanSafe === true &&
      value.correlationApiShapeVerified === true &&
      !!value.excludedFamilyCounts &&
      EXCLUDED_FAMILY_KEYS.every((key) => value.excludedFamilyCounts[key] === 0) &&
      !!value.fixtureCleanup &&
      CLEANUP_KEYS.every((key) => value.fixtureCleanup[key] === true);
    if (looksLikePass) errors.push("blocked_implies_pass");
  }

  // ---- redaction: the only caller-supplied free-form fields must stay opaque ----
  if (typeof value.targetBinding !== "string" || !BINDING_VALUE.test(value.targetBinding))
    errors.push("target_binding");

  let serializedBytes = Number.POSITIVE_INFINITY;
  try {
    serializedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    errors.push("artifact_serialization");
  }
  if (serializedBytes > MAX_ARTIFACT_BYTES) errors.push("artifact_size");

  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze([...new Set(errors)]) });
}

export function allowsTransitionImplementation(value) {
  const validation = validateTransitionCharacterization(value);
  return validation.valid && value?.terminalStatus === "passed";
}

export function summarizeTransitionCharacterization(value) {
  const validation = validateTransitionCharacterization(value);
  return Object.freeze({
    artifactDigest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    terminalStatus: value?.terminalStatus,
    predicateCode: value?.predicateCode,
    validation,
  });
}

if (process.argv[1] && new URL(`file:${process.argv[1]}`).href === import.meta.url) {
  const path = process.argv[2];
  if (!path)
    throw new Error("usage: node tools/stardew-navigation-transition-characterization-validator.mjs <artifact.json>");
  const value = JSON.parse(await readFile(path, "utf8"));
  const report = summarizeTransitionCharacterization(value);
  console.log(JSON.stringify(report));
  if (!report.validation.valid) process.exitCode = 2;
  else if (!allowsTransitionImplementation(value)) process.exitCode = 3;
}
