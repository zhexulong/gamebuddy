#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Exclusive, strict, pure JSON validator for the Task 5 multi-source
 * transition characterization artifact.
 *
 * This validator is intentionally fail-closed and exclusive to multi-source
 * artifacts. It never accepts source-only artifact shapes, current-source-only
 * scope, or any topology/privacy primitive.
 *
 * A passed artifact has all observation booleans true, invocation count 1, and
 * all mutation/warp/receipt/publication counts zero.
 *
 * A publishable blocked artifact carries exactly one named predicate consistent
 * with its observed boolean/count body. It never enables topology implementation.
 *
 * Cleanup incomplete and observation authentication failure are NOT publishable
 * artifact predicates and must reject at validator input.
 */

export const SCHEMA_VERSION = 1;
export const TARGET_BUILD = "1.6.15.24356";
export const TERMINAL_STATES = Object.freeze(["passed", "blocked"]);
export const OBSERVATION_SCOPE = "multi_hop_ordinary_warp";
export const PASS_PREDICATE = "successful_multisource_characterization";
export const BLOCK_PREDICATES = Object.freeze([
  "production_binary_identity_mismatch",
  "exact_production_callsite_invalid",
  "profile_dependency_closure_invalid",
  "production_modentry_activated",
  "world_not_ready",
  "production_topology_creation_rejected",
  "multi_source_not_observed",
  "ordinary_warp_family_not_observed",
  "gameplay_mutation_observed",
  "player_state_changed_during_observation",
]);

const ROOT_KEYS = Object.freeze([
  "schemaVersion",
  "terminalStatus",
  "targetBuild",
  "observationScope",
  "productionExtractorInvoked",
  "productionExtractorInvocationCount",
  "gameThreadObserved",
  "worldReadyObserved",
  "multiSourceObserved",
  "ordinaryWarpFamilyObserved",
  "correlationApiShapeVerified",
  "gameplayMutationCount",
  "playerWarpEventCount",
  "executionReceiptCount",
  "bridgeOrCatalogPublicationCount",
  "fixtureCleanup",
  "predicateCode",
]);

const CLEANUP_KEYS = Object.freeze(["restored", "noStardewProcess", "noSmapiProcess", "temporaryProfileRemoved"]);
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

export function validateMultiSourceTransitionCharacterization(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({ valid: false, errors: Object.freeze(["artifact_invalid"]) });
  }

  // Reject unknown keys — the schema is exact and allowlisted.
  if (!exactRecord(value, ROOT_KEYS)) errors.push("schema_shape:root");

  // Reject topology/privacy primitives that should never appear in any artifact.
  const forbiddenPrimitives = [
    "location", "locations", "source", "sources", "target", "targets", "destination",
    "route", "routes", "path", "paths", "hop", "hops", "leg", "legs",
    "tile", "tiles", "coordinate", "coordinates", "x", "y",
    "warp", "warps", "door", "doors", "edge", "edges",
    "opaqueId", "opaqueIds", "assemblyIdentity", "assemblyPath", "assemblyHash", "mvid",
    "log", "logs", "trace", "traces", "reason", "reasons", "stack",
  ];
  for (const key of Object.keys(value)) {
    if (forbiddenPrimitives.includes(key)) {
      errors.push(`forbidden_key:${key}`);
    }
  }

  if (value.schemaVersion !== SCHEMA_VERSION) errors.push("schema_version");
  if (value.targetBuild !== TARGET_BUILD) errors.push("target_build");
  if (!TERMINAL_STATES.includes(value.terminalStatus)) errors.push("terminal_status");
  if (value.observationScope !== OBSERVATION_SCOPE) errors.push("observation_scope");

  if (typeof value.productionExtractorInvoked !== "boolean") errors.push("production_extractor_invoked");
  if (!isNonNegativeInt(value.productionExtractorInvocationCount)) errors.push("production_extractor_invocation_count");
  if (value.productionExtractorInvocationCount > 1) errors.push("production_extractor_invocation_count");

  if (typeof value.gameThreadObserved !== "boolean") errors.push("game_thread_observed");
  if (typeof value.worldReadyObserved !== "boolean") errors.push("world_ready_observed");
  if (typeof value.multiSourceObserved !== "boolean") errors.push("multi_source_observed");
  if (typeof value.ordinaryWarpFamilyObserved !== "boolean") errors.push("ordinary_warp_family_observed");
  if (typeof value.correlationApiShapeVerified !== "boolean") errors.push("correlation_api_shape_verified");

  // Non-mutating invariants are enforced for passed artifacts and for blocked
  // artifacts whose predicate does NOT require the nonzero count.
  const status = value.terminalStatus;
  const predicate = value.predicateCode;
  if (status === "passed") {
    if (value.gameplayMutationCount !== 0) errors.push("non_mutating_invariant:gameplayMutationCount");
    if (value.playerWarpEventCount !== 0) errors.push("non_mutating_invariant:playerWarpEventCount");
    if (value.executionReceiptCount !== 0) errors.push("non_mutating_invariant:executionReceiptCount");
    if (value.bridgeOrCatalogPublicationCount !== 0) errors.push("non_mutating_invariant:bridgeOrCatalogPublicationCount");
  } else if (status === "blocked" && typeof predicate === "string") {
    // A blocked artifact may carry a nonzero count only when its predicate
    // requires that fact. If the predicate is unrelated to the count, it
    // must be zero.
    if (predicate !== "gameplay_mutation_observed" && value.gameplayMutationCount !== 0)
      errors.push("non_mutating_invariant:gameplayMutationCount");
    if (predicate !== "player_state_changed_during_observation" && value.playerWarpEventCount !== 0)
      errors.push("non_mutating_invariant:playerWarpEventCount");
    // executionReceiptCount and bridgeOrCatalogPublicationCount must always be
    // zero for any blocked publishable artifact (no predicate requires them).
    if (value.executionReceiptCount !== 0) errors.push("non_mutating_invariant:executionReceiptCount");
    if (value.bridgeOrCatalogPublicationCount !== 0) errors.push("non_mutating_invariant:bridgeOrCatalogPublicationCount");
  } else {
    // Unknown status; enforce all zero.
    if (value.gameplayMutationCount !== 0) errors.push("non_mutating_invariant:gameplayMutationCount");
    if (value.playerWarpEventCount !== 0) errors.push("non_mutating_invariant:playerWarpEventCount");
    if (value.executionReceiptCount !== 0) errors.push("non_mutating_invariant:executionReceiptCount");
    if (value.bridgeOrCatalogPublicationCount !== 0) errors.push("non_mutating_invariant:bridgeOrCatalogPublicationCount");
  }

  if (!exactRecord(value.fixtureCleanup, CLEANUP_KEYS)) {
    errors.push("schema_shape:fixture_cleanup");
  } else if (!CLEANUP_KEYS.every((key) => typeof value.fixtureCleanup[key] === "boolean")) {
    errors.push("fixture_cleanup");
  }

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
    if (value.productionExtractorInvoked !== true) errors.push("passed_proof:production_extractor_invoked");
    if (value.productionExtractorInvocationCount !== 1) errors.push("passed_proof:production_extractor_invocation_count");
    if (value.gameThreadObserved !== true) errors.push("passed_proof:game_thread_observed");
    if (value.worldReadyObserved !== true) errors.push("passed_proof:world_ready_observed");
    if (value.multiSourceObserved !== true) errors.push("passed_proof:multi_source_observed");
    if (value.ordinaryWarpFamilyObserved !== true) errors.push("passed_proof:ordinary_warp_family_observed");
    if (value.correlationApiShapeVerified !== true) errors.push("passed_proof:correlation_api_shape_verified");
    if (value.gameplayMutationCount !== 0) errors.push("passed_proof:gameplay_mutation_count");
    if (value.playerWarpEventCount !== 0) errors.push("passed_proof:player_warp_event_count");
    if (value.executionReceiptCount !== 0) errors.push("passed_proof:execution_receipt_count");
    if (value.bridgeOrCatalogPublicationCount !== 0) errors.push("passed_proof:bridge_or_catalog_publication_count");
    if (!value.fixtureCleanup || !CLEANUP_KEYS.every((key) => value.fixtureCleanup[key] === true))
      errors.push("passed_proof:fixture_cleanup");
  }

  // ---- blocked terminal must be consistent with the observed failure and never imply a pass ----
  if (status === "blocked" && typeof predicate === "string") {
    if (predicate === "production_binary_identity_mismatch" && value.productionExtractorInvoked !== false)
      errors.push("blocked_predicate_inconsistent");
    if (predicate === "exact_production_callsite_invalid" && value.productionExtractorInvoked !== false)
      errors.push("blocked_predicate_inconsistent");
    if (predicate === "profile_dependency_closure_invalid" && value.productionExtractorInvoked !== false)
      errors.push("blocked_predicate_inconsistent");
    if (predicate === "production_modentry_activated" && value.productionExtractorInvoked !== false)
      errors.push("blocked_predicate_inconsistent");
    if (predicate === "world_not_ready" && value.worldReadyObserved !== false)
      errors.push("blocked_predicate_inconsistent");
    if (predicate === "production_topology_creation_rejected" && value.productionExtractorInvoked !== true)
      errors.push("blocked_predicate_inconsistent");
    if (predicate === "multi_source_not_observed" && value.multiSourceObserved !== false)
      errors.push("blocked_predicate_inconsistent");
    if (predicate === "ordinary_warp_family_not_observed" && value.ordinaryWarpFamilyObserved !== false)
      errors.push("blocked_predicate_inconsistent");
    if (predicate === "gameplay_mutation_observed" && value.gameplayMutationCount !== 1)
      errors.push("blocked_predicate_inconsistent");
    if (predicate === "player_state_changed_during_observation" && value.playerWarpEventCount !== 1)
      errors.push("blocked_predicate_inconsistent");

    // A blocked terminal carrying full pass evidence is contradictory (implies pass).
    const looksLikePass =
      value.productionExtractorInvoked === true &&
      value.productionExtractorInvocationCount === 1 &&
      value.gameThreadObserved === true &&
      value.worldReadyObserved === true &&
      value.multiSourceObserved === true &&
      value.ordinaryWarpFamilyObserved === true &&
      value.correlationApiShapeVerified === true &&
      value.gameplayMutationCount === 0 &&
      value.playerWarpEventCount === 0 &&
      value.executionReceiptCount === 0 &&
      value.bridgeOrCatalogPublicationCount === 0 &&
      !!value.fixtureCleanup &&
      CLEANUP_KEYS.every((key) => value.fixtureCleanup[key] === true);
    if (looksLikePass) errors.push("blocked_implies_pass");
  }

  // ---- size limit ----
  let serializedBytes = Number.POSITIVE_INFINITY;
  try {
    serializedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    errors.push("artifact_serialization");
  }
  if (serializedBytes > MAX_ARTIFACT_BYTES) errors.push("artifact_size");

  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze([...new Set(errors)]) });
}

export function allowsMultiHopTopologyImplementation(value) {
  const validation = validateMultiSourceTransitionCharacterization(value);
  return validation.valid && value?.terminalStatus === "passed";
}

export function summarizeMultiSourceTransitionCharacterization(value) {
  const validation = validateMultiSourceTransitionCharacterization(value);
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
    throw new Error("usage: node tools/stardew-navigation-multisource-characterization-validator.mjs <artifact.json>");
  const value = JSON.parse(await readFile(path, "utf8"));
  const report = summarizeMultiSourceTransitionCharacterization(value);
  console.log(JSON.stringify(report));
  if (!report.validation.valid) process.exitCode = 2;
  else if (!allowsMultiHopTopologyImplementation(value)) process.exitCode = 3;
}