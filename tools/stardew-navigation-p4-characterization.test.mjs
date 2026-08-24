import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  correlateP4CTelemetry,
  createP4DCharacterizationIssuer,
  deriveNavigationCharacterization,
  findDestination,
  findDestinationWithPolicy,
  P4A_TARGET_BINDING_V1,
  SEARCH_POLICY_V1,
  validateP4CTelemetryEvent,
} from "./stardew-navigation-p4-characterization.mjs";
import { CORPUS_V1, checkPrivateRealSelection } from "./stardew-navigation-p4-corpus-check.mjs";

test("P4A accepts only a redacted unique Mine source-join lineage", () => {
  const probe = {
    artifactKind: "stardew_navigation_p4_redacted_probe",
    schemaVersion: 2,
    gameAssemblyVersion: P4A_TARGET_BINDING_V1.gameAssemblyVersion,
    inputDigest: P4A_TARGET_BINDING_V1.inputDigest,
    loaders: { locations: { count: 91 }, worldMap: { count: 2 } },
    shapes: { location: ["DisplayName"], worldMapRegion: ["MapAreas"] },
    hierarchy: {
      regionCount: 2,
      areaCount: 17,
      tooltipCount: 56,
      worldPositionCount: 67,
      maxDepth: 3,
      nodesByDepth: [2, 17, 56, 67],
      pagination: {
        pageSize: 16,
        rootPageCount: 1,
        maximumAreaChildren: 12,
        maximumTooltipChildren: 20,
        maximumPositionChildren: 19,
      },
    },
    conditions: {
      areas: { absent: 16, presentNotEvaluated: 1 },
      tooltips: { absent: 42, presentNotEvaluated: 14 },
      knownConditions: { absent: 41, presentNotEvaluated: 15 },
    },
    joins: {
      directWorldPositionToLocation: {
        candidateCount: 67,
        resolvedUniqueCount: 57,
        unresolvedCount: 4,
        nonUniqueCount: 6,
      },
      tooltipToLocation: {
        status: "no_explicit_location_identity_member",
        candidateCount: 0,
        resolvedUniqueCount: 0,
        unresolvedCount: 56,
        nonUniqueCount: 0,
      },
    },
    collisions: {
      duplicateRegionKeys: 0,
      duplicateAreaIdsWithinRegion: 0,
      duplicateTooltipIdsWithinArea: 0,
      duplicateLocationKeys: 0,
      duplicateDirectLocationJoinTargets: 2,
    },
    leafResolution: {
      directResolvedUniqueCount: 55,
      directUnresolvedCount: 4,
      directNonUniqueCount: 6,
      contentPresentNotRuntimeEvaluated: true,
    },
    counts: { mountainAreaCount: 1, mountainTooltipCount: 5, minesTooltipIdCount: 1 },
    mineLineage: {
      locationIdentity: "Mine",
      locationDisplayTokenSha256: "b".repeat(64),
      displayNameSource: {
        tokenPresent: true,
        tokenSha256: "b".repeat(64),
        currentLocaleResolution: "blocked_requires_runtime_token_parser",
        fallbackLocaleResolution: "blocked_no_safe_per_locale_target_api_proven",
      },
      mountainBinding: "Mountain/Mines",
      mapRegionGetLocationNameApi: "present_static_api_only",
      currentWorldFact: "blocked_no_game_runtime_or_current_world_instance",
      sourceJoin: {
        regionToMountainAreaMultiplicity: 1,
        mountainAreaToMinesTooltipMultiplicity: 1,
        mineCanonicalLocationInLocations: 1,
        areaConditionStates: ["absent"],
        tooltipConditionStates: ["absent"],
        tooltipKnownConditionStates: ["absent"],
        inclusionState: "content_present_not_runtime_evaluated",
      },
    },
    nonClaim: "aggregate/redacted characterization only",
  };
  const derived = deriveNavigationCharacterization(probe);
  assert.equal(derived.mineLineage.sourceJoin.mineCanonicalLocationInLocations, 1);
  assert.equal(derived.hierarchy.pagination.maximumAreaChildren, 12);
  assert.equal(derived.joins.tooltipToLocation.status, "no_explicit_location_identity_member");
  assert.equal(
    derived.mineLineage.displayNameSource.fallbackLocaleResolution,
    "blocked_no_safe_per_locale_target_api_proven",
  );
  assert.doesNotMatch(JSON.stringify(derived), /localized-label|coordinate|route/i);
  assert.throws(
    () => deriveNavigationCharacterization({ ...probe, gameAssemblyVersion: "1.6.15.0" }),
    /target_navigation_probe_drift/,
  );
  assert.throws(
    () => deriveNavigationCharacterization({ ...probe, inputDigest: "a".repeat(64) }),
    /target_navigation_probe_drift/,
  );
  assert.throws(
    () => deriveNavigationCharacterization({ ...probe, hierarchy: { ...probe.hierarchy, tooltipCount: 57 } }),
    /target_navigation_probe_drift/,
  );
  assert.throws(
    () =>
      deriveNavigationCharacterization({
        ...probe,
        joins: {
          ...probe.joins,
          tooltipToLocation: { ...probe.joins.tooltipToLocation, status: "inferred_from_text" },
        },
      }),
    /target_navigation_probe_drift/,
  );
  assert.throws(
    () =>
      deriveNavigationCharacterization({
        ...probe,
        mineLineage: {
          ...probe.mineLineage,
          sourceJoin: { ...probe.mineLineage.sourceJoin, mountainAreaToMinesTooltipMultiplicity: 2 },
        },
      }),
    /target_navigation_probe_drift/,
  );
  assert.throws(
    () =>
      deriveNavigationCharacterization({
        ...probe,
        mineLineage: {
          ...probe.mineLineage,
          sourceJoin: { ...probe.mineLineage.sourceJoin, tooltipConditionStates: ["present_not_evaluated"] },
        },
      }),
    /target_navigation_probe_drift/,
  );
});

test("P4C separates below-threshold not_found, low-margin candidates, and exact ambiguity ordering", () => {
  for (const entry of CORPUS_V1.cases)
    assert.deepEqual(
      findDestination(CORPUS_V1.entries, entry.query, entry.currentLocale, entry.fallbackLocale),
      entry.expected,
      entry.id,
    );
  assert.deepEqual(findDestination([...CORPUS_V1.entries].reverse(), "Stone", "en-US", "en-US").candidates, [
    "synthetic-tie-a",
    "synthetic-tie-b",
  ]);
  assert.deepEqual(findDestination([...CORPUS_V1.entries].reverse(), "North Hal", "en-US", "en-US").candidates, [
    "synthetic-close-a",
    "synthetic-close-b",
    "synthetic-beta",
  ]);
});
test("P4C v2 private checker executes semantic corpus cases and redacts aggregates", async () => {
  await assert.rejects(checkPrivateRealSelection(), /private_real_selection_input_unavailable/);
  const dir = await mkdtemp(join(tmpdir(), "p4c-")),
    path = join(dir, "private.json");
  const fixture = () => {
    const alpha = "p4c-entry-alpha",
      beta = "p4c-entry-beta",
      nearA = "p4c-entry-near-a",
      nearB = "p4c-entry-near-b",
      duplicateA = "p4c-entry-duplicate-a",
      duplicateB = "p4c-entry-duplicate-b";
    const entries = [
      {
        key: alpha,
        labels: { "en-US": "Private Alpha Hall", "zh-CN": "私密阿尔法厅", "ja-JP": "プライベートアルファホール" },
        aliases: [{ text: "Private Old Alpha", provenance: "explicit_content_former_name" }],
      },
      {
        key: beta,
        labels: { "en-US": "Private Beta Hall", "zh-CN": "私密贝塔厅", "ja-JP": "プライベートベータホール" },
        aliases: [{ text: "Private Alias Beta", provenance: "explicit_content_alias" }],
      },
      { key: nearA, labels: { "en-US": "Near Hall", "zh-CN": "近厅甲", "ja-JP": "ニアホール甲" }, aliases: [] },
      { key: nearB, labels: { "en-US": "Near Hail", "zh-CN": "近厅乙", "ja-JP": "ニアホール乙" }, aliases: [] },
      { key: duplicateA, labels: { "en-US": "Shared Venue", "zh-CN": "共享场地甲", "ja-JP": "共有会場" }, aliases: [] },
      { key: duplicateB, labels: { "en-US": "Shared Venue", "zh-CN": "共享场地乙", "ja-JP": "共有会場" }, aliases: [] },
    ];
    const result = (kind, stage, canonicalKey, candidates) => ({ kind, stage, canonicalKey, candidates });
    const cases = [
      {
        id: "p4c-case-exact",
        category: "exact",
        query: "Private Alpha Hall",
        currentLocale: "en-US",
        fallbackLocale: "en-US",
        expected: result("resolved", "current_locale_exact", alpha, [alpha]),
      },
      {
        id: "p4c-case-paraphrase",
        category: "natural_paraphrase",
        query: "Private Alpha Hal",
        currentLocale: "en-US",
        fallbackLocale: "en-US",
        expected: result("resolved", "fuzzy", alpha, [alpha]),
      },
      {
        id: "p4c-case-punctuation",
        category: "case_whitespace_punctuation",
        query: " PRIVATE Alpha Hall! ",
        currentLocale: "en-US",
        fallbackLocale: "en-US",
        expected: result("resolved", "current_locale_exact", alpha, [alpha]),
      },
      {
        id: "p4c-case-zh",
        category: "zh",
        query: "私密阿尔法厅",
        currentLocale: "zh-CN",
        fallbackLocale: "zh-CN",
        expected: result("resolved", "current_locale_exact", alpha, [alpha]),
      },
      {
        id: "p4c-case-fallback",
        category: "fallback",
        query: "Private Beta Hall",
        currentLocale: "zh-CN",
        fallbackLocale: "en-US",
        expected: result("resolved", "fallback_locale_exact", beta, [beta]),
      },
      {
        id: "p4c-case-alias",
        category: "explicit_alias",
        query: "Private Old Alpha",
        currentLocale: "ja-JP",
        fallbackLocale: "en-US",
        expected: result("resolved", "alias_exact", alpha, [alpha]),
      },
      {
        id: "p4c-case-typo",
        category: "typo",
        query: "Private Alpha Hlllll",
        currentLocale: "en-US",
        fallbackLocale: "en-US",
        expected: result("resolved", "fuzzy", alpha, [alpha]),
      },
      {
        id: "p4c-case-short",
        category: "short_query",
        query: "x",
        currentLocale: "ja-JP",
        fallbackLocale: "ja-JP",
        expected: result("not_found", "short_query", null, []),
      },
      {
        id: "p4c-case-duplicate",
        category: "duplicate_name",
        query: "Shared Venue",
        currentLocale: "en-US",
        fallbackLocale: "en-US",
        expected: result("ambiguous", "current_locale_exact", null, [duplicateA, duplicateB]),
      },
      {
        id: "p4c-case-near",
        category: "near_name",
        query: "Near Hal",
        currentLocale: "en-US",
        fallbackLocale: "en-US",
        expected: result("candidates", "fuzzy_low_margin", null, [nearA, nearB, alpha]),
      },
      {
        id: "p4c-case-control",
        category: "control_path_shaped",
        query: "warp: private",
        currentLocale: "en-US",
        fallbackLocale: "en-US",
        expected: result("invalid_query", null, null, []),
      },
      {
        id: "p4c-case-below",
        category: "below_threshold",
        query: "zzzzzz",
        currentLocale: "zh-CN",
        fallbackLocale: "zh-CN",
        expected: result("not_found", "fuzzy_below_threshold", null, []),
      },
      {
        id: "p4c-case-tie",
        category: "tie",
        query: "共有会場",
        currentLocale: "ja-JP",
        fallbackLocale: "en-US",
        expected: result("ambiguous", "current_locale_exact", null, [duplicateA, duplicateB]),
      },
    ];
    return {
      artifactKind: "stardew_navigation_p4c_private_corpus",
      schemaVersion: 2,
      targetVersion: P4A_TARGET_BINDING_V1.gameAssemblyVersion,
      p4aInputDigest: P4A_TARGET_BINDING_V1.inputDigest,
      claimedTargetContentDigest: "a".repeat(64),
      claimedTargetProvenanceDigest: "b".repeat(64),
      callerClaimedLabelProvenance: "target_private",
      entries,
      cases,
      expectedPolicy: { fuzzyThreshold: 0.82, fuzzyMargin: 0.08 },
    };
  };
  const check = async (value) => {
    await writeFile(path, JSON.stringify(value));
    return checkPrivateRealSelection(path);
  };
  const valid = fixture(),
    report = await check(valid),
    serialized = JSON.stringify(report);
  assert.equal(report.metrics.correct, report.metrics.total);
  assert.equal(report.provenanceStatus, "caller_unverified_requires_independent_attestation");
  assert.equal(report.partitions.category.exact.total, 1);
  const privateEntries = valid.entries.map((entry) => ({
    id: entry.key,
    labels: entry.labels,
    aliases: entry.aliases.map((alias) => alias.text),
  }));
  const fuzzyCase = valid.cases.find((item) => item.category === "typo");
  const alternate = findDestinationWithPolicy(
    privateEntries,
    fuzzyCase.query,
    fuzzyCase.currentLocale,
    fuzzyCase.fallbackLocale,
    { ...SEARCH_POLICY_V1, fuzzyThreshold: 0.86, fuzzyMargin: 0.08 },
  );
  const fixed = findDestination(privateEntries, fuzzyCase.query, fuzzyCase.currentLocale, fuzzyCase.fallbackLocale);
  assert.notDeepEqual(alternate, fixed);
  assert.ok(report.policy.candidateMetrics.some((candidate) => candidate.metrics.correct !== report.metrics.correct));
  for (const secret of ["Private Alpha Hall", "私密阿尔法厅", "p4c-entry-alpha", "p4c-case-exact", "Private Old Alpha"])
    assert.doesNotMatch(serialized, new RegExp(secret));
  await assert.rejects(check({ ...fixture(), targetVersion: "wrong" }), /input_invalid/);
  await assert.rejects(check({ ...fixture(), extra: true }), /input_invalid/);
  const noCategory = fixture();
  noCategory.cases = noCategory.cases.slice(1);
  await assert.rejects(check(noCategory), /input_invalid/);
  const noLocale = fixture();
  noLocale.cases = noLocale.cases.map((item) => ({ ...item, currentLocale: "en-US", fallbackLocale: "en-US" }));
  await assert.rejects(check(noLocale), /input_invalid/);
  const unsafe = fixture();
  unsafe.cases[0].query = "warp: private";
  await assert.rejects(check(unsafe), /input_invalid/);
  const categoryMismatch = fixture();
  categoryMismatch.cases[9].expected.stage = "fuzzy";
  await assert.rejects(check(categoryMismatch), /input_invalid/);
  const stageMismatch = fixture();
  stageMismatch.cases[0].expected.stage = "fallback_locale_exact";
  await assert.rejects(check(stageMismatch), /input_invalid/);
  await assert.rejects(check({ ...fixture(), claimedTargetProvenanceDigest: "not-a-hash" }), /input_invalid/);
  const wrongExpected = fixture();
  wrongExpected.cases[0].expected.canonicalKey = "p4c-entry-beta";
  wrongExpected.cases[0].expected.candidates = ["p4c-entry-beta"];
  await assert.rejects(check(wrongExpected), /policy_or_match_mismatch/);
  await assert.rejects(
    check({ ...fixture(), expectedPolicy: { fuzzyThreshold: 0.8, fuzzyMargin: 0.08 } }),
    /policy_or_match_mismatch/,
  );
  await rm(dir, { recursive: true });
});
test("P4D later execution first-use, binding and trusted-only advance never grant permission", () => {
  const clock = 100;
  const state = {
    issuer: "issuer",
    runtimeInstance: "runtime-1",
    scope: "scope",
    save: "save-1",
    world: "world-1",
    player: "player-1",
    companion: "companion-1",
    owner: "owner",
    canonical: "canonical",
    worldGeneration: "world-1",
    contentGeneration: "content-1",
  };
  const trustedExecutions = new WeakMap();
  const beginTrustedExecution = () => {
    const token = Object.freeze({});
    trustedExecutions.set(token, Object.freeze({ ...state }));
    return token;
  };
  const issuer = createP4DCharacterizationIssuer({
    now: () => clock,
    privateFactSource: () => state,
    privateTrustedExecutionFactFor: (token) => trustedExecutions.get(token),
    ttlMs: 10,
  });
  const handle = issuer.issueFindHandle();
  assert.equal(issuer.consume(handle, Object.freeze({})).reason, "ref_wrong_kind");
  const laterExecution = beginTrustedExecution();
  assert.deepEqual(issuer.consume(handle, laterExecution), {
    outcome: "consumed",
    handleState: "bound",
    permission: "none",
  });
  assert.deepEqual(issuer.observeTrustedExecution(laterExecution), {
    outcome: "advanced",
    observationSequence: 1,
    permission: "none",
  });
  assert.equal(issuer.consume(handle, laterExecution).reason, "ref_replay_transition");
});
test("P4D rejects other execution, untrusted attempts, forge, drift, and exact expiry", () => {
  let clock = 0;
  let state = {
    issuer: "issuer",
    runtimeInstance: "runtime-1",
    scope: "scope",
    save: "save-1",
    world: "world-1",
    player: "player-1",
    companion: "companion-1",
    owner: "owner",
    canonical: "canonical",
    worldGeneration: "world",
    contentGeneration: "v1",
  };
  const trustedExecutions = new WeakMap();
  const beginTrustedExecution = () => {
    const token = Object.freeze({});
    trustedExecutions.set(token, Object.freeze({ ...state }));
    return token;
  };
  const make = () =>
    createP4DCharacterizationIssuer({
      now: () => clock,
      privateFactSource: () => state,
      privateTrustedExecutionFactFor: (token) => trustedExecutions.get(token),
      ttlMs: 10,
    });
  const resetState = () => {
    state = {
      issuer: "issuer",
      runtimeInstance: "runtime-1",
      scope: "scope",
      save: "save-1",
      world: "world-1",
      player: "player-1",
      companion: "companion-1",
      owner: "owner",
      canonical: "canonical",
      worldGeneration: "world",
      contentGeneration: "v1",
    };
  };
  let issuer = make(),
    handle = issuer.issueFindHandle();
  assert.equal(issuer.consume(handle, {}).reason, "ref_wrong_kind");
  const mutableTrustedToken = Object.freeze({});
  trustedExecutions.set(mutableTrustedToken, state);
  assert.equal(issuer.consume(handle, mutableTrustedToken).reason, "ref_wrong_kind");
  const incompleteTrustedToken = Object.freeze({});
  trustedExecutions.set(incompleteTrustedToken, Object.freeze({ issuer: "issuer" }));
  assert.equal(issuer.consume(handle, incompleteTrustedToken).reason, "ref_wrong_kind");
  assert.equal(issuer.consume("p4d-h-999999999999", beginTrustedExecution()).reason, "ref_forged");
  issuer = make();
  handle = issuer.issueFindHandle();
  const one = beginTrustedExecution(),
    other = beginTrustedExecution();
  assert.equal(issuer.consume(handle, other).outcome, "consumed");
  assert.equal(issuer.observeTrustedExecution(one).reason, "ref_replay_transition");
  for (const [key, reason] of [
    ["issuer", "ref_wrong_issuer"],
    ["runtimeInstance", "ref_scope"],
    ["scope", "ref_scope"],
    ["save", "ref_scope"],
    ["world", "ref_scope"],
    ["player", "ref_scope"],
    ["companion", "ref_scope"],
    ["owner", "ref_owner_drift"],
    ["canonical", "ref_canonical_drift"],
    ["worldGeneration", "ref_scope"],
    ["contentGeneration", "ref_content_generation_drift"],
  ]) {
    issuer = make();
    handle = issuer.issueFindHandle();
    const token = beginTrustedExecution();
    state = { ...state, [key]: `${state[key]}-drift` };
    assert.equal(issuer.consume(handle, token).reason, reason);
    resetState();
    assert.equal(issuer.consume(handle, token).reason, reason);
  }
  issuer = make();
  handle = issuer.issueFindHandle();
  const observed = beginTrustedExecution();
  assert.equal(issuer.consume(handle, observed).outcome, "consumed");
  state = { ...state, contentGeneration: "v2" };
  assert.equal(issuer.observeTrustedExecution(observed).reason, "ref_content_generation_drift");
  resetState();
  assert.equal(issuer.observeTrustedExecution(observed).reason, "ref_content_generation_drift");
  issuer = make();
  handle = issuer.issueFindHandle();
  const expiresAfterBinding = beginTrustedExecution();
  assert.equal(issuer.consume(handle, expiresAfterBinding).outcome, "consumed");
  clock = 10;
  assert.equal(issuer.observeTrustedExecution(expiresAfterBinding).reason, "ref_expired");
  clock = 0;
  assert.equal(issuer.observeTrustedExecution(expiresAfterBinding).reason, "ref_expired");
  issuer = make();
  handle = issuer.issueFindHandle();
  clock = 10;
  assert.equal(issuer.consume(handle, beginTrustedExecution()).reason, "ref_expired");
});
test("P4C telemetry rejects raw identity fields and promotes only correlated consumption", () => {
  const base = {
    invocationId: "p4c-inv-a",
    resultId: "p4c-res-a",
    exactLabelDisclosed: false,
    matchStage: "fuzzy",
    candidateCount: 1,
    scoreBucket: "pass",
    marginBucket: "clear",
    latencyBucket: "fast",
    navigationConsumptionId: null,
    outcome: "used_not_consumed",
  };
  assert.equal(validateP4CTelemetryEvent({ ...base, query: "forbidden" }), false);
  assert.deepEqual(correlateP4CTelemetry([base]), [
    { invocationId: "p4c-inv-a", resultId: "p4c-res-a", outcome: "used_not_consumed" },
  ]);
  assert.deepEqual(
    correlateP4CTelemetry([
      base,
      {
        ...base,
        invocationId: "p4c-inv-b",
        resultId: "p4c-res-b",
        navigationConsumptionId: "p4c-res-a",
        outcome: "used_and_consumed",
      },
    ])[0].outcome,
    "used_and_consumed",
  );
});
