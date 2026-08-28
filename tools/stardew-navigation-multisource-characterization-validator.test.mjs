import assert from "node:assert";
import test from "node:test";
import {
  validateMultiSourceTransitionCharacterization,
  allowsMultiHopTopologyImplementation,
  SCHEMA_VERSION,
  TARGET_BUILD,
  OBSERVATION_SCOPE,
  PASS_PREDICATE,
  BLOCK_PREDICATES,
} from "./stardew-navigation-multisource-characterization-validator.mjs";

/**
 * Deterministic unit tests for the multi-source characterization validator.
 * All inputs are in-memory JavaScript objects; no files or fixtures are read.
 */

function passArtifact(overrides = {}) {
  return Object.freeze({
    schemaVersion: 1,
    terminalStatus: "passed",
    targetBuild: "1.6.15.24356",
    observationScope: "multi_hop_ordinary_warp",
    productionExtractorInvoked: true,
    productionExtractorInvocationCount: 1,
    gameThreadObserved: true,
    worldReadyObserved: true,
    multiSourceObserved: true,
    ordinaryWarpFamilyObserved: true,
    correlationApiShapeVerified: true,
    gameplayMutationCount: 0,
    playerWarpEventCount: 0,
    executionReceiptCount: 0,
    bridgeOrCatalogPublicationCount: 0,
    fixtureCleanup: { restored: true, noStardewProcess: true, noSmapiProcess: true, temporaryProfileRemoved: true },
    predicateCode: "successful_multisource_characterization",
    ...overrides,
  });
}

function blockedArtifact(predicate, overrides = {}) {
  const base = {
    schemaVersion: 1,
    terminalStatus: "blocked",
    targetBuild: "1.6.15.24356",
    observationScope: "multi_hop_ordinary_warp",
    productionExtractorInvoked: false,
    productionExtractorInvocationCount: 0,
    gameThreadObserved: false,
    worldReadyObserved: false,
    multiSourceObserved: false,
    ordinaryWarpFamilyObserved: false,
    correlationApiShapeVerified: false,
    gameplayMutationCount: 0,
    playerWarpEventCount: 0,
    executionReceiptCount: 0,
    bridgeOrCatalogPublicationCount: 0,
    fixtureCleanup: { restored: true, noStardewProcess: true, noSmapiProcess: true, temporaryProfileRemoved: true },
    predicateCode: predicate,
  };
  // Apply predicate-consistent defaults
  if (predicate === "world_not_ready") base.worldReadyObserved = false;
  if (predicate === "multi_source_not_observed") base.multiSourceObserved = false;
  if (predicate === "ordinary_warp_family_not_observed") base.ordinaryWarpFamilyObserved = false;
  if (predicate === "production_topology_creation_rejected") {
    base.productionExtractorInvoked = true;
    base.productionExtractorInvocationCount = 1;
  }
  if (predicate === "gameplay_mutation_observed") base.gameplayMutationCount = 1;
  if (predicate === "player_state_changed_during_observation") base.playerWarpEventCount = 1;
  return Object.freeze({ ...base, ...overrides });
}

// ====== Pass tests ======

test("validator: a valid passed multi-source artifact passes structural validation", () => {
  const artifact = passArtifact();
  const validation = validateMultiSourceTransitionCharacterization(artifact);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(allowsMultiHopTopologyImplementation(artifact), true);
});

test("validator: passed predicate classification is true only for structurally valid passed artifacts", () => {
  assert.equal(allowsMultiHopTopologyImplementation(passArtifact()), true);
  assert.equal(allowsMultiHopTopologyImplementation(blockedArtifact("world_not_ready")), false);
  assert.equal(allowsMultiHopTopologyImplementation(null), false);
  assert.equal(allowsMultiHopTopologyImplementation("string"), false);
  assert.equal(allowsMultiHopTopologyImplementation(42), false);
});

// ====== Scope rejection tests ======

test("validator: a source-only artifact (current_source_only scope) is rejected", () => {
  const artifact = passArtifact({ observationScope: "current_source_only" });
  const validation = validateMultiSourceTransitionCharacterization(artifact);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes("observation_scope")));
  assert.equal(allowsMultiHopTopologyImplementation(artifact), false);
});

test("validator: an unknown scope is rejected", () => {
  const artifact = passArtifact({ observationScope: "multi_hop_doors_and_special" });
  const validation = validateMultiSourceTransitionCharacterization(artifact);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes("observation_scope")));
});

// ====== Schema structure tests ======

test("validator: null/undefined/non-object inputs are rejected", () => {
  assert.equal(validateMultiSourceTransitionCharacterization(null).valid, false);
  assert.equal(validateMultiSourceTransitionCharacterization(undefined).valid, false);
  assert.equal(validateMultiSourceTransitionCharacterization("string").valid, false);
  assert.equal(validateMultiSourceTransitionCharacterization(42).valid, false);
  assert.equal(validateMultiSourceTransitionCharacterization([]).valid, false);
});

test("validator: an extra unknown key is rejected", () => {
  const artifact = passArtifact({ extraField: "value" });
  assert.equal(validateMultiSourceTransitionCharacterization(artifact).valid, false);
});

test("validator: a missing key is rejected", () => {
  const { schemaVersion, ...noVersion } = passArtifact();
  assert.equal(validateMultiSourceTransitionCharacterization(noVersion).valid, false);
});

test("validator: wrong schemaVersion is rejected", () => {
  assert.equal(validateMultiSourceTransitionCharacterization(passArtifact({ schemaVersion: 2 })).valid, false);
});

test("validator: wrong targetBuild is rejected", () => {
  assert.equal(validateMultiSourceTransitionCharacterization(passArtifact({ targetBuild: "1.6.14.9999" })).valid, false);
});

test("validator: wrong terminalStatus is rejected", () => {
  assert.equal(validateMultiSourceTransitionCharacterization(passArtifact({ terminalStatus: "pending" })).valid, false);
});

// ====== Forbidden primitive key tests ======

test("validator: topology primitive keys are rejected", () => {
  const forbiddenKeys = [
    "location", "source", "target", "destination",
    "route", "path", "hop", "leg",
    "tile", "coordinate", "x", "y",
    "warp", "door", "edge",
    "opaqueId", "assemblyIdentity", "assemblyPath",
    "log", "trace", "reason",
  ];
  for (const key of forbiddenKeys) {
    const artifact = passArtifact({ [key]: "some_value" });
    const result = validateMultiSourceTransitionCharacterization(artifact);
    assert.equal(result.valid, false, `key "${key}" should be rejected`);
    assert.ok(result.errors.some((e) => e.includes(`forbidden_key:${key}`)), `expected forbidden_key:${key} error`);
  }
});

// ====== Pass proof requirements ======

test("validator: a passed artifact with false observation boolean is rejected", () => {
  const tests = [
    { override: { productionExtractorInvoked: false }, expected: "production_extractor_invoked" },
    { override: { gameThreadObserved: false }, expected: "game_thread_observed" },
    { override: { worldReadyObserved: false }, expected: "world_ready_observed" },
    { override: { multiSourceObserved: false }, expected: "multi_source_observed" },
    { override: { ordinaryWarpFamilyObserved: false }, expected: "ordinary_warp_family_observed" },
    { override: { correlationApiShapeVerified: false }, expected: "correlation_api_shape_verified" },
  ];
  for (const { override, expected } of tests) {
    const result = validateMultiSourceTransitionCharacterization(passArtifact(override));
    assert.equal(result.valid, false, `override ${JSON.stringify(override)} should be rejected`);
    assert.ok(result.errors.some((e) => e.includes(expected)), `expected error containing ${expected}`);
  }
});

test("validator: a passed artifact with wrong invocation count is rejected", () => {
  const zero = validateMultiSourceTransitionCharacterization(passArtifact({ productionExtractorInvocationCount: 0 }));
  assert.equal(zero.valid, false);
  assert.ok(zero.errors.some((e) => e.includes("production_extractor_invocation_count") || e.includes("passed_proof")));

  const two = validateMultiSourceTransitionCharacterization(passArtifact({ productionExtractorInvocationCount: 2 }));
  assert.equal(two.valid, false);
  assert.ok(two.errors.some((e) => e.includes("production_extractor_invocation_count")));
});

test("validator: a passed artifact with nonzero mutation/warp/receipt/publication count is rejected", () => {
  const mutationArtifact = passArtifact({ gameplayMutationCount: 1 });
  assert.equal(validateMultiSourceTransitionCharacterization(mutationArtifact).valid, false);

  const warpArtifact = passArtifact({ playerWarpEventCount: 1 });
  assert.equal(validateMultiSourceTransitionCharacterization(warpArtifact).valid, false);

  const receiptArtifact = passArtifact({ executionReceiptCount: 1 });
  assert.equal(validateMultiSourceTransitionCharacterization(receiptArtifact).valid, false);

  const pubArtifact = passArtifact({ bridgeOrCatalogPublicationCount: 1 });
  assert.equal(validateMultiSourceTransitionCharacterization(pubArtifact).valid, false);
});

test("validator: a passed artifact with incomplete cleanup is rejected", () => {
  const noRestore = passArtifact({ fixtureCleanup: { restored: false, noStardewProcess: true, noSmapiProcess: true, temporaryProfileRemoved: true } });
  assert.equal(validateMultiSourceTransitionCharacterization(noRestore).valid, false);

  const processRunning = passArtifact({ fixtureCleanup: { restored: true, noStardewProcess: false, noSmapiProcess: true, temporaryProfileRemoved: true } });
  assert.equal(validateMultiSourceTransitionCharacterization(processRunning).valid, false);

  const partialCleanup = passArtifact({ fixtureCleanup: { restored: true, noStardewProcess: true, noSmapiProcess: true, temporaryProfileRemoved: false } });
  assert.equal(validateMultiSourceTransitionCharacterization(partialCleanup).valid, false);
});

// ====== Blocked predicate tests ======

test("validator: a blocked artifact with consistent predicate is accepted but does NOT enable implementation", () => {
  for (const predicate of BLOCK_PREDICATES) {
    const artifact = blockedArtifact(predicate);
    const result = validateMultiSourceTransitionCharacterization(artifact);
    assert.equal(result.valid, true, `blocked predicate "${predicate}" should be valid: ${JSON.stringify(result.errors)}`);
    assert.equal(allowsMultiHopTopologyImplementation(artifact), false);
  }
});

test("validator: a blocked artifact with inconsistent predicate is rejected", () => {
  // world_not_ready with worldReadyObserved=true is inconsistent
  const bad = blockedArtifact("world_not_ready", { worldReadyObserved: true });
  const result = validateMultiSourceTransitionCharacterization(bad);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("blocked_predicate_inconsistent")), JSON.stringify(result.errors));

  // gameplay_mutation_observed with gameplayMutationCount=0 is inconsistent
  const bad2 = blockedArtifact("gameplay_mutation_observed", { gameplayMutationCount: 0 });
  assert.equal(validateMultiSourceTransitionCharacterization(bad2).valid, false);

  // player_state_changed_during_observation with playerWarpEventCount=0 is inconsistent
  const bad3 = blockedArtifact("player_state_changed_during_observation", { playerWarpEventCount: 0 });
  assert.equal(validateMultiSourceTransitionCharacterization(bad3).valid, false);
});

test("validator: a blocked artifact that looks like a pass is rejected (blocked_implies_pass)", () => {
  // A blocked artifact with all pass booleans true and zero counts implies pass
  const bad = blockedArtifact("world_not_ready", {
    productionExtractorInvoked: true,
    productionExtractorInvocationCount: 1,
    gameThreadObserved: true,
    worldReadyObserved: true,
    multiSourceObserved: true,
    ordinaryWarpFamilyObserved: true,
    correlationApiShapeVerified: true,
    gameplayMutationCount: 0,
    playerWarpEventCount: 0,
    executionReceiptCount: 0,
    bridgeOrCatalogPublicationCount: 0,
    fixtureCleanup: { restored: true, noStardewProcess: true, noSmapiProcess: true, temporaryProfileRemoved: true },
  });
  const result = validateMultiSourceTransitionCharacterization(bad);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("blocked_implies_pass")), JSON.stringify(result.errors));
});

test("validator: an unknown blocked predicate is rejected", () => {
  const artifact = blockedArtifact("unknown_blocked_predicate");
  assert.equal(validateMultiSourceTransitionCharacterization(artifact).valid, false);
});

// ====== Size limit test ======

test("validator: oversized artifact is rejected", () => {
  const big = passArtifact({
    fixtureCleanup: {
      restored: true,
      noStardewProcess: true,
      noSmapiProcess: true,
      temporaryProfileRemoved: true,
      extraLongField: "x".repeat(9000),
    },
  });
  // This should fail fixtureCleanup schema shape AND size
  const result = validateMultiSourceTransitionCharacterization(big);
  assert.equal(result.valid, false);
});

// ====== Non-source-only artifact shape tests ======

test("validator: a correctly scoped multi-source shape may pass structural validation only", () => {
  // Structural validation is audit-only. Registry-pinned raw-byte receipt
  // binding, not this shape, is required for capability authorization.
  const artifact = passArtifact({ observationScope: "multi_hop_ordinary_warp" });
  assert.equal(validateMultiSourceTransitionCharacterization(artifact).valid, true);
});

test("validator: a null predicateCode is rejected", () => {
  assert.equal(validateMultiSourceTransitionCharacterization(passArtifact({ predicateCode: null })).valid, false);
});

test("validator: a missing predicateCode is rejected", () => {
  const { predicateCode, ...noPredicate } = passArtifact();
  assert.equal(validateMultiSourceTransitionCharacterization(noPredicate).valid, false);
});

// ====== Non-Gameplay ======

test("validator: the validator never accepts source-only validator output shapes", () => {
  // The source-only validator has different root keys entirely
  const sourceOnlyShape = {
    schemaVersion: 1,
    terminalStatus: "passed",
    targetBuild: "1.6.15.24356",
    targetBinding: "tb1_7a1c9e0d22b4f6a1c3e5d7098a2b4c6e8d0f1a3c5d7e9f1a3b5c7d9e1f3a5b7c",
    methodAnchors: { warpResolver: "GameLocation.warps", doorResolver: "GameLocation.getWarpFromDoor", approachPlanner: "PathFindController", correlation: "IPlayerEvents.Warped" },
    observationScope: "current_source_only",
    opaqueEdgeIds: ["te1_91aF2bC3dE4f5a6b7c8d9e0f1A2B3c4D"],
    permittedFamilyCounts: { ordinaryWarp: 1, ordinaryDoor: 0 },
    excludedFamilyCounts: { action: 0, touchAction: 0, modHook: 0, special: 0, m8: 0, missingIdentity: 0, unsafeApproach: 0 },
    dryPlanSafe: true,
    correlationApiShapeVerified: true,
    mutationCount: 0,
    executionReceiptCount: 0,
    fixtureCleanup: { restored: true, noStardewProcess: true, noSmapiProcess: true },
    predicateCode: "successful_characterization",
  };
  const result = validateMultiSourceTransitionCharacterization(sourceOnlyShape);
  assert.equal(result.valid, false);
  assert.equal(allowsMultiHopTopologyImplementation(sourceOnlyShape), false);
});