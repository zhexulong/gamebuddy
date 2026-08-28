import assert from "node:assert";
import test from "node:test";
import {
  allowsTransitionImplementation,
  BLOCK_PREDICATES,
  PASS_PREDICATE,
  validateTransitionCharacterization,
} from "./stardew-navigation-transition-characterization-validator.mjs";

/**
 * Replay-style regression for the transition-characterization gate. This is a
 * pure test: it replays deterministic artifact inputs against the strict
 * validator and proves that no `blocked` artifact can ever be treated as a
 * passed/completed characterization or enable downstream implementation. The
 * characterized artifact is source-only — observed current source candidates
 * and a static `Player.Warped` API-shape proof only, never a full route or
 * future-warp correlation. It is not a runner and performs no target-runtime,
 * fixture, or mutation work.
 */

const PASS_BODY = Object.freeze({
  schemaVersion: 1,
  terminalStatus: "passed",
  targetBuild: "1.6.15.24356",
  targetBinding: "tb1_7a1c9e0d22b4f6a1c3e5d7098a2b4c6e8d0f1a3c5d7e9f1a3b5c7d9e1f3a5b7c",
  methodAnchors: Object.freeze({
    warpResolver: "GameLocation.warps",
    doorResolver: "GameLocation.getWarpFromDoor",
    approachPlanner: "PathFindController",
    correlation: "IPlayerEvents.Warped",
  }),
  observationScope: "current_source_only",
  opaqueEdgeIds: Object.freeze(["te1_91aF2bC3dE4f5a6b7c8d9e0f1A2B3c4D", "te1_02b4C6d8E0f2a3b4c5d6e7f8a9b0A1B2C"]),
  permittedFamilyCounts: Object.freeze({ ordinaryWarp: 1, ordinaryDoor: 1 }),
  excludedFamilyCounts: Object.freeze({
    action: 0,
    touchAction: 0,
    modHook: 0,
    special: 0,
    m8: 0,
    missingIdentity: 0,
    unsafeApproach: 0,
  }),
  dryPlanSafe: true,
  correlationApiShapeVerified: true,
  mutationCount: 0,
  executionReceiptCount: 0,
  fixtureCleanup: Object.freeze({ restored: true, noStardewProcess: true, noSmapiProcess: true }),
  predicateCode: PASS_PREDICATE,
});

function blockedCopy(predicate) {
  const base = JSON.parse(JSON.stringify(PASS_BODY));
  base.terminalStatus = "blocked";
  base.predicateCode = predicate;
  base.dryPlanSafe = predicate !== "approach_not_safe";
  base.correlationApiShapeVerified = predicate !== "correlation_api_shape_unavailable";
  if (predicate === "transition_family_unapproved") {
    base.excludedFamilyCounts = { ...base.excludedFamilyCounts, action: 1 };
  }
  if (predicate === "cleanup_incomplete") {
    base.fixtureCleanup = { ...base.fixtureCleanup, restored: false };
  }
  if (predicate === "no_permitted_candidates") {
    base.permittedFamilyCounts = { ordinaryWarp: 0, ordinaryDoor: 0 };
    base.opaqueEdgeIds = [];
  }
  return base;
}

test("replay: a well-formed blocked artifact is never a pass and never sets the success sink", () => {
  for (const predicate of BLOCK_PREDICATES) {
    const artifact = blockedCopy(predicate);
    const validation = validateTransitionCharacterization(artifact);
    assert.equal(validation.valid, true, `${predicate}: ${validation.errors.join(",")}`);
    // The read-only replay sink only opens on a validated, passed, source-only,
    // correlation-API-shape-verified, dry-plan-safe artifact; a blocked terminal
    // always stays closed.
    assert.equal(allowsTransitionImplementation(artifact), false, predicate);
    if (predicate === "transition_family_unapproved") {
      assert.equal(artifact.excludedFamilyCounts.action, 1);
    }
    if (predicate === "cleanup_incomplete") {
      assert.equal(artifact.fixtureCleanup.restored, false);
    }
  }
});

test("replay: a blocked artifact can never be relabeled to pass an implementation gate", () => {
  // Producers may not promote a blocked terminal by swapping in the pass predicate.
  const relabeled = blockedCopy("approach_not_safe");
  relabeled.predicateCode = PASS_PREDICATE;
  assert.equal(validateTransitionCharacterization(relabeled).valid, false);
  assert.equal(allowsTransitionImplementation(relabeled), false);

  // nor by leaving a full pass body but marking the terminal blocked (implies pass).
  const smuggled = JSON.parse(JSON.stringify(PASS_BODY));
  smuggled.terminalStatus = "blocked";
  smuggled.predicateCode = "transition_family_unapproved";
  const validation = validateTransitionCharacterization(smuggled);
  assert.equal(validation.valid, false);
  assert.equal(validation.errors.includes("blocked_implies_pass"), true);
  assert.equal(allowsTransitionImplementation(smuggled), false);
});

test("replay: only an authentic passed terminal opens implementation", () => {
  assert.equal(validateTransitionCharacterization(PASS_BODY).valid, true);
  assert.equal(allowsTransitionImplementation(PASS_BODY), true);
});
