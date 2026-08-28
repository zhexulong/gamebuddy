import assert from "node:assert";
import test from "node:test";
import {
  allowsTransitionImplementation,
  BLOCK_PREDICATES,
  PASS_PREDICATE,
  summarizeTransitionCharacterization,
  validateTransitionCharacterization,
} from "./stardew-navigation-transition-characterization-validator.mjs";

/**
 * Pure deterministic tests for the strict transition-characterization validator.
 * The artifact is strictly source-only: it may describe only observed current
 * source candidates and a static `Player.Warped` API-shape proof, never a full
 * route, tracer, or event causal correlation. No target runtime, fixture, or
 * mutation is involved.
 */

function passedArtifact(overrides = {}) {
  return {
    schemaVersion: 1,
    terminalStatus: "passed",
    targetBuild: "1.6.15.24356",
    targetBinding: "tb1_0f4e8b1a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80a1b2c3d4e5f6a7b8c9d0e1",
    methodAnchors: {
      warpResolver: "GameLocation.warps",
      doorResolver: "GameLocation.getWarpFromDoor",
      approachPlanner: "PathFindController",
      correlation: "IPlayerEvents.Warped",
    },
    observationScope: "current_source_only",
    opaqueEdgeIds: ["te1_7f2aB9cE42d81fG0a3", "te1_91b4C8dF5a0e27H1c9"],
    permittedFamilyCounts: { ordinaryWarp: 1, ordinaryDoor: 1 },
    excludedFamilyCounts: {
      action: 0,
      touchAction: 0,
      modHook: 0,
      special: 0,
      m8: 0,
      missingIdentity: 0,
      unsafeApproach: 0,
    },
    dryPlanSafe: true,
    correlationApiShapeVerified: true,
    mutationCount: 0,
    executionReceiptCount: 0,
    fixtureCleanup: { restored: true, noStardewProcess: true, noSmapiProcess: true },
    predicateCode: PASS_PREDICATE,
    ...overrides,
  };
}

function blockedArtifact(predicate, body = {}) {
  return passedArtifact({ terminalStatus: "blocked", predicateCode: predicate, ...body });
}

function blockedFromPredicate(predicate) {
  const base = {
    dryPlanSafe: true,
    correlationApiShapeVerified: true,
    fixtureCleanup: { restored: true, noStardewProcess: true, noSmapiProcess: true },
    excludedFamilyCounts: {
      action: 0,
      touchAction: 0,
      modHook: 0,
      special: 0,
      m8: 0,
      missingIdentity: 0,
      unsafeApproach: 0,
    },
  };
  switch (predicate) {
    case "transition_family_unapproved":
      return blockedArtifact(predicate, {
        ...base,
        excludedFamilyCounts: { ...base.excludedFamilyCounts, action: 1 },
      });
    case "approach_not_safe":
      return blockedArtifact(predicate, { ...base, dryPlanSafe: false });
    case "correlation_api_shape_unavailable":
      return blockedArtifact(predicate, { ...base, correlationApiShapeVerified: false });
    case "cleanup_incomplete":
      return blockedArtifact(predicate, {
        ...base,
        fixtureCleanup: { restored: false, noStardewProcess: true, noSmapiProcess: true },
      });
    case "no_permitted_candidates":
      return blockedArtifact(predicate, {
        ...base,
        permittedFamilyCounts: { ordinaryWarp: 0, ordinaryDoor: 0 },
        opaqueEdgeIds: [],
      });
    default:
      throw new Error(`unhandled predicate ${predicate}`);
  }
}
test("accepts a complete passed artifact and permits implementation", () => {
  const artifact = passedArtifact();
  const validation = validateTransitionCharacterization(artifact);
  assert.equal(validation.valid, true, validation.errors.join(","));
  assert.equal(validation.errors.includes("passed_proof:correlation_api_shape"), false, validation.errors.join(","));
  assert.equal(allowsTransitionImplementation(artifact), true);
  assert.match(summarizeTransitionCharacterization(artifact).artifactDigest, /^[a-f0-9]{64}$/);
});

test("rejects the retired exact-correlation field (no compatibility retained)", () => {
  assert.equal(validateTransitionCharacterization(passedArtifact({ correlationExact: true })).valid, false);
  assert.equal(validateTransitionCharacterization(passedArtifact({ correlationExact: false })).valid, false);
});

test("rejects an observationScope other than current_source_only", () => {
  assert.equal(
    validateTransitionCharacterization(passedArtifact({ observationScope: "future_full_route" })).valid,
    false,
  );
  assert.equal(
    validateTransitionCharacterization(passedArtifact({ observationScope: "mine_exterior_tracer" })).valid,
    false,
  );
});

test("rejects a passed artifact whose Player.Warped API shape was not verified", () => {
  assert.equal(validateTransitionCharacterization(passedArtifact({ correlationApiShapeVerified: false })).valid, false);
});

test("rejects the legacy correlation anchor string on the method anchor set", () => {
  assert.equal(
    validateTransitionCharacterization(
      passedArtifact({ methodAnchors: { ...passedArtifact().methodAnchors, correlation: "Player.Warped" } }),
    ).valid,
    false,
  );
});

test("rejects a missing required root key", () => {
  const { fixtureCleanup, ...rest } = passedArtifact();
  void fixtureCleanup;
  assert.equal(validateTransitionCharacterization(rest).valid, false);
});

test("rejects an unknown extra root key", () => {
  assert.equal(validateTransitionCharacterization(passedArtifact({ leakKey: "x" })).valid, false);
});

test("rejects wrong schema version and wrong target build", () => {
  assert.equal(validateTransitionCharacterization(passedArtifact({ schemaVersion: 2 })).valid, false);
  assert.equal(validateTransitionCharacterization(passedArtifact({ targetBuild: "1.6.14" })).valid, false);
});

test("rejects a terminal status outside passed/blocked", () => {
  assert.equal(validateTransitionCharacterization(passedArtifact({ terminalStatus: "unknown" })).valid, false);
  assert.equal(validateTransitionCharacterization(passedArtifact({ terminalStatus: "in_progress" })).valid, false);
});

test("rejects a passed artifact tagged with a success modifier / non-pass predicate", () => {
  assert.equal(validateTransitionCharacterization(passedArtifact({ predicateCode: "unreviewed_pass" })).valid, false);
  assert.equal(validateTransitionCharacterization(passedArtifact({ predicateCode: "needs_review" })).valid, false);
});
test("rejects a blocked artifact that claims the pass predicate", () => {
  const artifact = blockedArtifact(PASS_PREDICATE);
  assert.equal(validateTransitionCharacterization(artifact).valid, false);
  assert.equal(allowsTransitionImplementation(artifact), false);
});

test("rejects a blocked artifact with an unknown predicate code", () => {
  const artifact = blockedArtifact("some_unknown_failure");
  assert.equal(validateTransitionCharacterization(artifact).valid, false);
});

test("rejects mutation and execution-receipt drift (must stay zero)", () => {
  assert.equal(validateTransitionCharacterization(passedArtifact({ mutationCount: 1 })).valid, false);
  assert.equal(validateTransitionCharacterization(passedArtifact({ executionReceiptCount: 1 })).valid, false);
});

test("rejects a passed artifact with any excluded family present", () => {
  assert.equal(
    validateTransitionCharacterization(
      passedArtifact({ excludedFamilyCounts: { ...passedArtifact().excludedFamilyCounts, touchAction: 1 } }),
    ).valid,
    false,
  );
});

test("rejects a passed artifact with zero permitted family counts", () => {
  assert.equal(
    validateTransitionCharacterization(passedArtifact({ permittedFamilyCounts: { ordinaryWarp: 0, ordinaryDoor: 0 } }))
      .valid,
    false,
  );
});
test("rejects an artifact over the serialized disclosure bound", () => {
  const oversized = passedArtifact({
    opaqueEdgeIds: Array.from({ length: 300 }, (_, index) => `te1_${index.toString(16).padStart(32, "0")}`),
    permittedFamilyCounts: { ordinaryWarp: 300, ordinaryDoor: 0 },
  });
  const validation = validateTransitionCharacterization(oversized);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes("artifact_size"), validation.errors.join(","));
});

test("rejects a passed artifact with empty or malformed opaque edge ids", () => {
  assert.equal(validateTransitionCharacterization(passedArtifact({ opaqueEdgeIds: [] })).valid, false);
  assert.equal(
    validateTransitionCharacterization(passedArtifact({ opaqueEdgeIds: ["has spaces and is_wrong", "te1_xx"] })).valid,
    false,
  );
  assert.equal(
    validateTransitionCharacterization(passedArtifact({ opaqueEdgeIds: ["te1_invalid!chars_1234567890"] })).valid,
    false,
  );
});

test("rejects a passed artifact whose opaque id count differs from the permitted candidate total", () => {
  // one opaque id per observed permitted candidate: fewer ids than counted candidates
  const short = passedArtifact({ permittedFamilyCounts: { ordinaryWarp: 2, ordinaryDoor: 1 } });
  const shortValidation = validateTransitionCharacterization(short);
  assert.equal(shortValidation.valid, false);
  assert.ok(shortValidation.errors.includes("passed_proof:opaque_edge_coverage"), shortValidation.errors.join(","));
  assert.equal(shortValidation.errors.includes("passed_proof:opaque_edge_ids"), false);

  // and more ids than counted candidates is equally rejected (no arbitrary cap)
  const extra = passedArtifact({
    opaqueEdgeIds: ["te1_7f2aB9cE42d81fG0a3", "te1_91b4C8dF5a0e27H1c9", "te1_a1b2c3d4e5f6a7b8c9"],
  });
  const extraValidation = validateTransitionCharacterization(extra);
  assert.equal(extraValidation.valid, false);
  assert.ok(extraValidation.errors.includes("passed_proof:opaque_edge_coverage"), extraValidation.errors.join(","));
});

test("rejects duplicate opaque edge ids in passed and blocked terminals alike", () => {
  const duplicated = "te1_7f2aB9cE42d81fG0a3";
  const passed = passedArtifact({ opaqueEdgeIds: [duplicated, duplicated] });
  const passedValidation = validateTransitionCharacterization(passed);
  assert.equal(passedValidation.valid, false);
  assert.ok(passedValidation.errors.includes("opaque_edge_id_duplicate"), passedValidation.errors.join(","));

  // duplicates are structurally invalid in a blocked terminal too, which may
  // otherwise legitimately carry zero ids or a full id list.
  const blocked = blockedArtifact("approach_not_safe", {
    dryPlanSafe: false,
    opaqueEdgeIds: [duplicated, duplicated],
  });
  const blockedValidation = validateTransitionCharacterization(blocked);
  assert.equal(blockedValidation.valid, false);
  assert.ok(blockedValidation.errors.includes("opaque_edge_id_duplicate"), blockedValidation.errors.join(","));
  assert.equal(allowsTransitionImplementation(blocked), false);
});

test("rejects an incorrect or partial method anchor set", () => {
  assert.equal(
    validateTransitionCharacterization(
      passedArtifact({ methodAnchors: { ...passedArtifact().methodAnchors, warpResolver: "GameLocation.GETWarps()" } }),
    ).valid,
    false,
  );
  const { approachPlanner, ...partial } = passedArtifact().methodAnchors;
  void approachPlanner;
  assert.equal(validateTransitionCharacterization(passedArtifact({ methodAnchors: partial })).valid, false);
});
test("rejects negative or non-integer family counts", () => {
  assert.equal(
    validateTransitionCharacterization(passedArtifact({ permittedFamilyCounts: { ordinaryWarp: -1, ordinaryDoor: 3 } }))
      .valid,
    false,
  );
  assert.equal(
    validateTransitionCharacterization(
      passedArtifact({ excludedFamilyCounts: { ...passedArtifact().excludedFamilyCounts, m8: -1 } }),
    ).valid,
    false,
  );
});

test("rejects a fixture-cleanup claim that was not verified", () => {
  assert.equal(
    validateTransitionCharacterization(
      passedArtifact({ fixtureCleanup: { restored: true, noStardewProcess: true, noSmapiProcess: false } }),
    ).valid,
    false,
  );
});

test("rejects location-like or coordinate data leaked through the opaque binding", () => {
  assert.equal(validateTransitionCharacterization(passedArtifact({ targetBinding: "Farm_route_5" })).valid, false);
  assert.equal(validateTransitionCharacterization(passedArtifact({ targetBinding: "24x13" })).valid, false);
  assert.equal(validateTransitionCharacterization(passedArtifact({ targetBinding: "12,34" })).valid, false);
});

test("rejects a path-like or smuggled identity binding", () => {
  assert.equal(validateTransitionCharacterization(passedArtifact({ targetBinding: "./worlds/save" })).valid, false);
  assert.equal(validateTransitionCharacterization(passedArtifact({ targetBinding: "playerId:abc" })).valid, false);
});
test("rejects extra nested keys inside a nested family-count record", () => {
  assert.equal(
    validateTransitionCharacterization(
      passedArtifact({ permittedFamilyCounts: { ordinaryWarp: 12, ordinaryDoor: 3, leash: 1 } }),
    ).valid,
    false,
  );
  assert.equal(
    validateTransitionCharacterization(
      passedArtifact({ excludedFamilyCounts: { ...passedArtifact().excludedFamilyCounts, wonder: 1 } }),
    ).valid,
    false,
  );
});

test("rejects a non-object / array artifact and wrong cleanup shape", () => {
  assert.equal(validateTransitionCharacterization(null).valid, false);
  assert.equal(validateTransitionCharacterization([]).valid, false);
  assert.equal(validateTransitionCharacterization(passedArtifact({ fixtureCleanup: { restored: true } })).valid, false);
});
test("accepts no-permitted-candidates as a consistent blocked predicate", () => {
  const artifact = blockedFromPredicate("no_permitted_candidates");
  const validation = validateTransitionCharacterization(artifact);
  assert.equal(validation.valid, true, validation.errors.join(","));
  assert.equal(allowsTransitionImplementation(artifact), false);
});

test("rejects a blocked no-permitted-candidates artifact with a nonzero candidate count", () => {
  const artifact = blockedArtifact("no_permitted_candidates", {
    permittedFamilyCounts: { ordinaryWarp: 1, ordinaryDoor: 0 },
    opaqueEdgeIds: ["te1_7f2aB9cE42d81fG0a3"],
  });
  const validation = validateTransitionCharacterization(artifact);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes("blocked_predicate_inconsistent"), validation.errors.join(","));
});

test("rejects a blocked artifact whose body contradicts its own predicate", () => {
  // approach_not_safe is claimed while the probe actually reports a safe approach.
  const artifact = blockedFromPredicate("approach_not_safe");
  artifact.dryPlanSafe = true;
  assert.equal(validateTransitionCharacterization(artifact).valid, false);
});

test("a consistent blocked artifact is structurally valid but never enables implementation", () => {
  for (const predicate of BLOCK_PREDICATES) {
    const artifact = blockedFromPredicate(predicate);
    const validation = validateTransitionCharacterization(artifact);
    assert.equal(validation.valid, true, `${predicate}: ${validation.errors.join(",")}`);
    assert.equal(validation.errors.includes("blocked_implies_pass"), false, predicate);
    assert.equal(allowsTransitionImplementation(artifact), false, predicate);
    assert.equal(summarizeTransitionCharacterization(artifact).terminalStatus, "blocked", predicate);
  }
});

test("a blocked artifact carrying full pass evidence is rejected as implying a pass", () => {
  const artifact = blockedArtifact("approach_not_safe", {
    dryPlanSafe: true,
    correlationApiShapeVerified: true,
    excludedFamilyCounts: { ...passedArtifact().excludedFamilyCounts },
    fixtureCleanup: { restored: true, noStardewProcess: true, noSmapiProcess: true },
  });
  const validation = validateTransitionCharacterization(artifact);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes("blocked_predicate_inconsistent"));
  assert.ok(validation.errors.includes("blocked_implies_pass"));
  assert.equal(allowsTransitionImplementation(artifact), false);
});
