import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CHAT_TAVERN_LIVE_PROFILE,
  MOUNTED_PROFILE_MAPPING_BLOCKER,
  NARRATIVE_RUN_PLAN,
  parseArguments,
  runTavernReleaseLiveGate,
  runTavernReleaseLiveOrchestrator,
  validateMountedProfileOperationEvidence,
} from "./run-tavern-release-live-gate.mjs";
import { prepareReportTarget, writeReport } from "./run-tavern-narrative-gate.mjs";

const sha = "a".repeat(64);
const token = (value) => value.toString(16).padStart(16, "0");
const passingPrerequisites = async () => ({ verdict: "passed" });
const mappingBlocker = MOUNTED_PROFILE_MAPPING_BLOCKER.detail;
const mountedProfile = Object.freeze({
  profileId: "chat-core-v1",
  releaseTier: "chat_core",
  routeIds: Object.freeze(["chat.submit"]),
  operationIds: Object.freeze(["chat.submit"]),
  navigationItemIds: Object.freeze(["chat"]),
});
function validMapping(overrides = {}) {
  return {
    schema_version: 1,
    profile: mountedProfile,
    operations: { "chat.submit": [token(11)] },
    ...overrides,
  };
}

/**
 * A genuine per-run report: the runner state plus the production artifact
 * identity and every assertion the runner derives that state from.
 */
// One release is one artifact: the gate now requires every run's generation and
// inventory digest to agree, so the helper gives all three roles the same pair.
// A test that needs a run to differ passes its own `overrides`.
const PASSED_ARTIFACT = Object.freeze({ generation: "generation_one_aaaaaaaaaaaa", inventoryDigest: "f".repeat(64) });
function passedRun(role, overrides = {}) {
  return {
    role,
    state: "passed",
    runId: token(20),
    artifact: { ...PASSED_ARTIFACT },
    assertions: {
      authenticatedReferenceChatApi: true,
      realDialogueTurnAttempted: true,
      providerRuntimeSessionBound: true,
      providerPreSendSerialized: true,
      realTurnOutcomeObserved: true,
      privateText: "must not be copied",
    },
    statuses: { turn: "completed", private: "removed" },
    prompt: "must not be copied",
    ...overrides,
  };
}
const passedRuns = () => NARRATIVE_RUN_PLAN.map((role) => passedRun(role));

test("mounted profile mapping validates exact identity, membership, and opaque evidence", () => {
  assert.equal(validateMountedProfileOperationEvidence({ mountedProfile, operationEvidenceMapping: validMapping() }).valid, true);
  assert.equal(
    validateMountedProfileOperationEvidence({ mountedProfile, operationEvidenceMapping: validMapping({ profile: { ...mountedProfile } }) }).valid,
    false,
  );
  assert.equal(
    validateMountedProfileOperationEvidence({ mountedProfile, operationEvidenceMapping: validMapping({ operations: { "chat.list": [token(12)] } }) }).valid,
    false,
  );
  assert.equal(
    validateMountedProfileOperationEvidence({ mountedProfile, operationEvidenceMapping: validMapping({ operations: { "chat.submit": ["dialogue-content"] } }) }).valid,
    false,
  );
  assert.equal(
    validateMountedProfileOperationEvidence({ mountedProfile, operationEvidenceMapping: validMapping({ operations: { "chat.submit": ["C:/Users/someone/Downloads"] } }) }).valid,
    false,
  );
});

test("mounted profile mapping requires exactly one identity spelling and treats profile_id as part of the hash pair", () => {
  const { profileId, releaseTier, routeIds, operationIds, navigationItemIds } = mountedProfile;
  const profileHash = createHash("sha256")
    .update(JSON.stringify({ profileId, releaseTier, routeIds, operationIds, navigationItemIds }), "utf8")
    .digest("hex");
  const hashPair = {
    schema_version: 1,
    profile_id: profileId,
    profile_hash: profileHash,
    operations: { "chat.submit": [token(11)] },
  };
  assert.equal(
    validateMountedProfileOperationEvidence({ mountedProfile, operationEvidenceMapping: hashPair }).valid,
    true,
  );
  assert.equal(
    validateMountedProfileOperationEvidence({
      mountedProfile,
      operationEvidenceMapping: { ...hashPair, release_tier: releaseTier },
    }).valid,
    true,
  );

  for (const invalid of [
    { schema_version: 1, profile_id: profileId, operations: { "chat.submit": [token(11)] } },
    { ...hashPair, profile: mountedProfile },
    { ...hashPair, profile_hash: "b".repeat(64) },
    { ...hashPair, release_tier: "tavern_management" },
  ]) {
    const validation = validateMountedProfileOperationEvidence({
      mountedProfile,
      operationEvidenceMapping: invalid,
    });
    assert.equal(validation.valid, false, JSON.stringify(invalid));
    assert.ok(validation.checks.length > 0);
  }
});

test("mounted profile mapping accepts the recorder's automation evidence kind and no other", () => {
  assert.equal(
    validateMountedProfileOperationEvidence({
      mountedProfile,
      operationEvidenceMapping: validMapping({ evidence_kind: "automation_evidence" }),
    }).valid,
    true,
  );
  assert.equal(
    validateMountedProfileOperationEvidence({
      mountedProfile,
      operationEvidenceMapping: validMapping({ evidence_kind: "operator_observation" }),
    }).valid,
    false,
  );
  assert.equal(
    validateMountedProfileOperationEvidence({
      mountedProfile,
      operationEvidenceMapping: validMapping({ operator_note: "looked fine to me" }),
    }).valid,
    false,
  );
});

test("the live UI evidence recorder's own export validates as mounted operation evidence", async () => {
  const { recordTavernUiOperationEvidence } = await import("./record-tavern-ui-operation-evidence.mjs");
  const { readMountedTavernManagementProfile } = await import("./lib/tavern-mounted-operation-vocabulary.mjs");
  // The recorder only accepts a `tavern_management` profile, and that tier is now
  // bound to the exact profile the composition owner mounts, so this uses the
  // real one. That is also the stronger test: the recorder-to-gate seam is only
  // proven when it is exercised with the profile production actually passes.
  const recorderProfile = { ...readMountedTavernManagementProfile() };
  const root = await mkdtemp(join(tmpdir(), "tavern-release-live-gate-recorder-"));
  try {
    const inputPath = join(root, "input.json");
    const outputPath = join(root, "mapping.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        profile: recorderProfile,
        operations: recorderProfile.operationIds.map((operationId) => ({ operationId, outcome: "passed" })),
      }),
    );
    await recordTavernUiOperationEvidence({ inputPath, outputPath });
    const operationEvidenceMapping = JSON.parse(await readFile(outputPath, "utf8"));
    const validation = validateMountedProfileOperationEvidence({
      mountedProfile: recorderProfile,
      operationEvidenceMapping,
    });
    assert.equal(validation.valid, true, JSON.stringify(validation.checks));
    assert.deepEqual(validation.mappedOperationIds, [...recorderProfile.operationIds]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the completeness check refuses a mapping that skips a declared operation", () => {
  // run-01..run-05 all passed with a mapping of five operations against a profile
  // that declared more, because membership was checked in only one direction.
  //
  // This profile is deliberately not `tavern_management`: that tier is bound to
  // the exact profile the Host mounts, so a plausible-looking four-operation
  // stand-in would be rejected for the wrong reason and this test would stop
  // measuring completeness (see the mounted-surface tests below).
  const wideProfile = Object.freeze({
    profileId: "chat-core-v1",
    releaseTier: "chat_core",
    routeIds: Object.freeze(["chat.rename", "draft.save", "draft.discard", "chat.submit"]),
    operationIds: Object.freeze(["chat.rename", "draft.save", "draft.discard", "chat.submit"]),
    navigationItemIds: Object.freeze(["chat"]),
  });
  const validation = validateMountedProfileOperationEvidence({
    mountedProfile: wideProfile,
    operationEvidenceMapping: {
      schema_version: 1,
      profile: wideProfile,
      operations: { "chat.rename": [token(11)], "draft.save": [token(12)] },
    },
  });
  assert.equal(validation.valid, false);
  const missing = validation.checks.filter(
    (check) => check.id === "mounted_profile_operation_evidence_completeness",
  );
  assert.equal(missing.length, 2, "draft.discard and chat.submit were never exercised");

  // The same profile with every operation mapped is accepted, so the check is
  // completeness and not an accidental always-fail.
  assert.equal(
    validateMountedProfileOperationEvidence({
      mountedProfile: wideProfile,
      operationEvidenceMapping: {
        schema_version: 1,
        profile: wideProfile,
        operations: {
          "chat.rename": [token(11)],
          "draft.save": [token(12)],
          "draft.discard": [token(13)],
          "chat.submit": [token(14)],
        },
      },
    }).valid,
    true,
  );
});

test("a shrunken management profile cannot shrink its way past the mounted surface", async () => {
  // The completeness check proves the mapping covers the profile it was given. It
  // cannot see whether that profile still describes what the Host mounts, so a
  // five-operation profile plus a five-operation mapping validated cleanly - the
  // run-05 false green, reachable by editing the profile instead of the evidence.
  const shrunken = Object.freeze({
    profileId: "gamebuddy.tavern-management.chat-list-title",
    releaseTier: "tavern_management",
    routeIds: Object.freeze(["chat.rename"]),
    operationIds: Object.freeze(["chat.rename"]),
    navigationItemIds: Object.freeze(["chat"]),
  });
  const calls = [];
  const report = await runTavernReleaseLiveOrchestrator({
    mountedProfile: shrunken,
    operationEvidenceMapping: {
      schema_version: 1,
      profile: shrunken,
      operations: { "chat.rename": [token(11)] },
    },
    prerequisites: passingPrerequisites,
    runNarrative: async ({ role }) => {
      calls.push(role);
      return passedRun(role);
    },
    temporaryReportPath: (role) => `/tmp/${role}.json`,
  });
  assert.equal(report.verdict, "blocked");
  assert.equal(report.reasonCode, "verdict_inputs_incomplete");
  assert.ok(report.blockerIds.includes("mounted_profile_operation_evidence_mounted_surface"));
  assert.deepEqual(calls, [], "live runs were launched for a verdict that was already impossible");

  // A chat-core profile legitimately declares a smaller surface and is unaffected.
  const chatCore = await runTavernReleaseLiveOrchestrator({
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    prerequisites: async () => ({ verdict: "blocked", checks: [{ id: "x", status: "blocked" }] }),
    runNarrative: async () => {
      throw new Error("a blocked prerequisite must not run narrative work");
    },
    temporaryReportPath: (role) => `/tmp/${role}.json`,
  });
  assert.deepEqual(
    chatCore.blockerIds.filter((id) => id === "mounted_profile_operation_evidence_mounted_surface"),
    [],
    "chat_core must not be held to the management surface",
  );
});

test("the runner's own negative disclosure survives the real two-stage normalization", async () => {
  // `runNarrativeProcess` already normalizes once, and the orchestrator normalizes
  // that result again. The second pass read disclosures from `assertions` and the
  // turn status from `statuses.turn`, both of which the first pass had already
  // rewritten - so run-03..run-06 showed a clean five-of-five while the runner had
  // reported `providerAcceptedOrSemanticAnswer: false`.
  const report = await runTavernReleaseLiveOrchestrator({
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    prerequisites: passingPrerequisites,
    runNarrative: async ({ role }) => ({
      role,
      state: "passed",
      runId: token(20),
      artifact: { ...PASSED_ARTIFACT },
      assertions: {
        authenticatedReferenceChatApi: true,
        realDialogueTurnAttempted: true,
        providerRuntimeSessionBound: true,
        providerPreSendSerialized: true,
        realTurnOutcomeObserved: true,
      },
      disclosures: { providerAcceptedOrSemanticAnswer: false },
      turn: "completed",
    }),
    temporaryReportPath: (role) => `/tmp/${role}.json`,
  });
  assert.equal(report.verdict, "passed");
  assert.deepEqual(report.runs[0].disclosures, { providerAcceptedOrSemanticAnswer: false });
  assert.equal(report.runs[0].turn, "completed");
});

test("a raw runner report survives the whole normalization chain", async () => {
  // The three tests around this one cover a spelling each. This one drives the
  // REAL chain end to end: `runNarrativeProcess` normalizes the runner's raw
  // report once and the orchestrator normalizes that result again, so a field
  // that only survives one pass is silently lost in production. Feeding a raw
  // shape directly to the orchestrator would NOT reproduce it - the first pass
  // was never broken - so this test chains two orchestrator calls and hands the
  // first call's own run summary to the second, which is exactly what the
  // production pair does.
  const rawRun = (role) => ({
    role,
    state: "passed",
    runId: token(20),
    artifact: { ...PASSED_ARTIFACT },
    // The runner's raw spelling: the non-passing disclosure rides inside
    // `assertions`, and the turn status lives under `statuses`.
    assertions: {
      authenticatedReferenceChatApi: true,
      realDialogueTurnAttempted: true,
      providerRuntimeSessionBound: true,
      providerPreSendSerialized: true,
      realTurnOutcomeObserved: true,
      providerAcceptedOrSemanticAnswer: false,
    },
    statuses: { turn: "completed", lastState: "idle", p4Stages: [] },
  });

  const once = await runTavernReleaseLiveOrchestrator({
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    prerequisites: passingPrerequisites,
    runNarrative: async ({ role }) => rawRun(role),
    temporaryReportPath: (role) => `/tmp/${role}.json`,
  });
  assert.equal(once.verdict, "passed");

  // Second pass: hand the first pass's own summary back in, as the orchestrator
  // does with `runNarrativeProcess`'s return value.
  const twice = await runTavernReleaseLiveOrchestrator({
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    prerequisites: passingPrerequisites,
    runNarrative: async ({ role }) => once.runs.find((run) => run.role === role),
    temporaryReportPath: (role) => `/tmp/${role}.json`,
  });
  assert.equal(twice.verdict, "passed");
  assert.deepEqual(twice.runs[0].disclosures, { providerAcceptedOrSemanticAnswer: false });
  assert.equal(twice.runs[0].turn, "completed");
});

test("the exported gate refuses a shrunken management profile too, not only the orchestrator", async () => {
  // The mounted-surface check first lived in runTavernReleaseLiveOrchestrator,
  // which left the other exported entry point accepting a one-operation
  // tavern_management profile and minting `passed`. The round-2 audit found it by
  // calling the gate directly. Both entries now share one validation, and this
  // test pins the gate's own behaviour so the split cannot come back.
  const shrunken = Object.freeze({
    profileId: "gamebuddy.tavern-management.chat-list-title",
    releaseTier: "tavern_management",
    routeIds: Object.freeze(["chat.rename"]),
    operationIds: Object.freeze(["chat.rename"]),
    navigationItemIds: Object.freeze(["chat"]),
  });
  const mapping = Object.freeze({
    schema_version: 1,
    profile: shrunken,
    operations: { "chat.rename": [token(11)] },
  });

  const validation = validateMountedProfileOperationEvidence({
    mountedProfile: shrunken,
    operationEvidenceMapping: mapping,
  });
  assert.equal(validation.valid, false);
  assert.ok(
    validation.checks.some((check) => check.id === "mounted_profile_operation_evidence_mounted_surface"),
    "the shared validator must name the under-declared profile",
  );

  const gate = await runTavernReleaseLiveGate({
    mountedProfile: shrunken,
    operationEvidenceMapping: mapping,
    runs: passedRuns(),
    prerequisites: passingPrerequisites,
  });
  assert.notEqual(gate.verdict, "passed");
  assert.deepEqual(gate.mappedOperationIds, []);
});

test("a profile with the right tier and operation count but a forged identity is refused", async () => {
  // Shrinking was only half the hole. A profile that declares all fourteen
  // operations still passed when its identity was forged: a profileId the Host
  // never mounts, no bootstrap/state.read/draft.read routes, and no memory
  // navigation item. Charging the tier, the count or the route set individually
  // just moves the forgery to whichever property is not yet checked, so the
  // validator compares the supplied profile against the one the composition
  // owner derives. This test pins the identity half.
  const { readMountedTavernManagementProfile } = await import("./lib/tavern-mounted-operation-vocabulary.mjs");
  const real = readMountedTavernManagementProfile();
  const forged = Object.freeze({
    profileId: "fake.management",
    releaseTier: "tavern_management",
    routeIds: Object.freeze([...real.operationIds]),
    operationIds: Object.freeze([...real.operationIds]),
    navigationItemIds: Object.freeze(["chat"]),
  });
  const mapping = Object.freeze({
    schema_version: 1,
    profile: forged,
    operations: Object.fromEntries(real.operationIds.map((id) => [id, [token(11)]])),
  });

  const validation = validateMountedProfileOperationEvidence({
    mountedProfile: forged,
    operationEvidenceMapping: mapping,
  });
  assert.equal(validation.valid, false);
  assert.ok(
    validation.checks.some((check) => check.id === "mounted_profile_operation_evidence_mounted_surface"),
    "a forged identity must be refused even when every operation is declared",
  );

  const report = await runTavernReleaseLiveOrchestrator({
    mountedProfile: forged,
    operationEvidenceMapping: mapping,
    prerequisites: passingPrerequisites,
    runNarrative: async ({ role }) => passedRun(role),
    temporaryReportPath: (role) => `/tmp/${role}.json`,
  });
  assert.equal(report.verdict, "blocked");

  // The real mounted profile still validates, so the equality is not a
  // always-fail dressed up as a check.
  assert.equal(
    validateMountedProfileOperationEvidence({
      mountedProfile: real,
      operationEvidenceMapping: {
        schema_version: 1,
        profile: real,
        operations: Object.fromEntries(real.operationIds.map((id) => [id, [token(11)]])),
      },
    }).valid,
    true,
  );
});

test("runs against different artifacts cannot pass as one release", async () => {
  // Each run carried a generation and an inventory digest, but nothing required
  // them to agree: three runs against three different generations validated
  // cleanly and the report presented them as one release. The gate proves the
  // runs passed; it must also prove they passed the same build.
  const assertions = {
    authenticatedReferenceChatApi: true,
    realDialogueTurnAttempted: true,
    providerRuntimeSessionBound: true,
    providerPreSendSerialized: true,
    realTurnOutcomeObserved: true,
  };
  const runs = ["main", "failure", "recovery"].map((role, index) => ({
    role,
    state: "passed",
    runnerRunId: String(index + 1).repeat(16),
    artifact: {
      generation: `generation_${index}_${"a".repeat(12)}`,
      inventoryDigest: String(index + 1).repeat(64),
    },
    assertions,
  }));

  const report = await runTavernReleaseLiveGate({
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    runs,
    prerequisites: passingPrerequisites,
  });
  assert.notEqual(report.verdict, "passed");
  assert.ok(
    report.blockerIds.includes("narrative_run_artifact_identity"),
    "the multi-artifact evidence must be named",
  );

  // The same three runs against one artifact still pass, so the rule is
  // agreement and not an accidental always-fail.
  const shared = runs.map((run) => ({
    ...run,
    artifact: { generation: "generation_one_aaaaaaaaaaaa", inventoryDigest: "f".repeat(64) },
  }));
  const ok = await runTavernReleaseLiveGate({
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    runs: shared,
    prerequisites: passingPrerequisites,
  });
  assert.equal(ok.verdict, "passed");
  assert.deepEqual(ok.blockerIds, []);
});

test("Tavern live gate passes when prerequisites, real runs, and operation evidence all genuinely pass", async () => {
  const report = await runTavernReleaseLiveGate({
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    runs: passedRuns(),
    prerequisites: passingPrerequisites,
  });
  assert.equal(report.verdict, "passed");
  assert.equal(report.prerequisite, "passed");
  assert.equal("reasonCode" in report, false);
  assert.deepEqual(report.blockerIds, []);
  assert.deepEqual(report.checks, []);
  assert.deepEqual(report.mappedOperationIds, ["chat.submit"]);
  assert.deepEqual(report.runEvidence.map(({ role, state }) => ({ role, state })), [
    { role: "main", state: "passed" },
    { role: "failure", state: "passed" },
    { role: "recovery", state: "passed" },
  ]);
});

test("a passed verdict names the exact operation evidence it was decided on", async () => {
  // The audit of run-01..run-04 found the recorded `passed` verdict could not be
  // re-derived from the artifact set: the mapping is a caller-supplied file and was not
  // among the recorded data, so `mappedOperationIds` could only be taken on trust. The
  // report must therefore carry the profile identity and the mapping's fingerprint.
  const report = await runTavernReleaseLiveGate({
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    runs: passedRuns(),
    prerequisites: passingPrerequisites,
  });
  const identity = report.operationEvidence;
  assert.equal(identity.profileId, mountedProfile.profileId);
  assert.equal(identity.releaseTier, mountedProfile.releaseTier);
  assert.match(identity.profileHash, /^[a-f0-9]{64}$/);
  assert.match(identity.mappingDigest, /^[a-f0-9]{64}$/);
  assert.equal(identity.mappingSchemaVersion, 1);

  // The digest must be re-derivable from the input alone, and independent of JSON key
  // order (a mapping that differs only in key order is the same mapping).
  const reordered = {
    operations: { "chat.submit": [token(11)] },
    profile: mountedProfile,
    schema_version: 1,
  };
  const second = await runTavernReleaseLiveGate({
    mountedProfile,
    operationEvidenceMapping: reordered,
    runs: passedRuns(),
    prerequisites: passingPrerequisites,
  });
  assert.equal(second.operationEvidence.mappingDigest, identity.mappingDigest);

  // A DIFFERENT mapping must NOT collide, or the binding proves nothing.
  const third = await runTavernReleaseLiveGate({
    mountedProfile,
    operationEvidenceMapping: validMapping({ operations: { "chat.submit": [token(12)] } }),
    runs: passedRuns(),
    prerequisites: passingPrerequisites,
  });
  assert.notEqual(third.operationEvidence.mappingDigest, identity.mappingDigest);
});

test("a non-passed verdict carries no evidence identity to misread as one", async () => {
  // When the mapping never reaches a valid state there is no evidence to name, and
  // recording a digest would invite a reader to treat an unusable input as verified.
  const report = await runTavernReleaseLiveGate({
    mountedProfile,
    operationEvidenceMapping: { schema_version: 1, operations: {} },
    runs: passedRuns(),
    prerequisites: passingPrerequisites,
  });
  assert.equal(report.verdict, "inconclusive");
  assert.equal("operationEvidence" in report, false);
  assert.deepEqual(report.mappedOperationIds, []);
});

test("Tavern live gate refuses to burn live runs on verdict inputs it can already reject", async () => {
  // Found by auditing the real artifacts: 9 of 12 live embedded-provider turns
  // belonged to attempts whose verdict was already impossible at invocation time,
  // because the mapping validator is a pure function over caller-supplied files and it
  // ran AFTER three production-grade live sessions. `mapping.valid === false` makes
  // `passed` unreachable, so there is nothing the live runs could have taught us.
  for (const missing of [
    { mountedProfile: undefined, operationEvidenceMapping: undefined },
    { mountedProfile, operationEvidenceMapping: undefined },
  ]) {
    let calls = 0;
    const report = await runTavernReleaseLiveOrchestrator({
      ...missing,
      prerequisites: passingPrerequisites,
      runNarrative: async () => {
        calls += 1;
        return passedRun("main");
      },
    });
    assert.equal(calls, 0, "a live narrative run was launched for an unmintable verdict");
    assert.equal(report.verdict, "blocked");
    assert.equal(report.reasonCode, "verdict_inputs_incomplete");
    assert.deepEqual(report.runs, []);
    assert.equal(report.prerequisite.verdict, "not_attempted");
    assert.ok(report.blockerIds.length > 0);
  }
});

test("Tavern live gate blocks and skips every narrative run when an automated prerequisite fails", async () => {
  let calls = 0;
  const report = await runTavernReleaseLiveOrchestrator({
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    prerequisites: async () => ({ verdict: "blocked", checks: [{ id: "magic_context_stable_source", status: "blocked" }] }),
    runNarrative: async () => {
      calls += 1;
      return passedRun("main");
    },
  });
  assert.equal(calls, 0);
  assert.equal(report.verdict, "blocked");
  assert.equal(report.reasonCode, "automated_prerequisite_not_passed");
  assert.deepEqual(report.runs, []);
  assert.deepEqual(report.plannedRunKinds, [...NARRATIVE_RUN_PLAN]);
  assert.ok(report.blockerIds.includes("prerequisite_verdict"));
  assert.equal(report.claims.requiredMustFlowsExecuted, false);
  assert.equal(report.claims.fullReleaseClaim, false);
});

test("Tavern live gate stays blocked when the prerequisite checker itself cannot run", async () => {
  const report = await runTavernReleaseLiveGate({
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    runs: passedRuns(),
    prerequisites: async () => {
      throw new Error("private checker detail");
    },
  });
  assert.equal(report.verdict, "blocked");
  assert.equal(report.reasonCode, "automated_prerequisite_unavailable");
  assert.equal(report.prerequisite, "unavailable");
});

test("Tavern live gate is inconclusive when a planned run is missing or incomplete", async () => {
  const missing = await runTavernReleaseLiveGate({
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    runs: passedRuns().filter(({ role }) => role !== "recovery"),
    prerequisites: passingPrerequisites,
  });
  assert.equal(missing.verdict, "inconclusive");
  assert.equal(missing.reasonCode, "narrative_run_evidence_incomplete");
  assert.deepEqual(missing.runEvidence.find(({ role }) => role === "recovery"), {
    role: "recovery",
    state: "blocked",
    reasonCode: "narrative_run_not_executed",
  });

  for (const override of [
    { state: "blocked", reasonCode: "provider_request_pending" },
    { artifact: undefined },
    { assertions: { ...passedRun("main").assertions, providerPreSendSerialized: false } },
    { assertions: undefined },
  ]) {
    const report = await runTavernReleaseLiveGate({
      mountedProfile,
      operationEvidenceMapping: validMapping(),
      runs: NARRATIVE_RUN_PLAN.map((role) => (role === "main" ? passedRun(role, override) : passedRun(role))),
      prerequisites: passingPrerequisites,
    });
    assert.equal(report.verdict, "inconclusive", JSON.stringify(override));
    assert.equal(report.reasonCode, "narrative_run_evidence_incomplete");
    assert.equal(report.claims.fullReleaseClaim, false);
  }
});

test("Tavern live gate is inconclusive when the mounted operation evidence is unavailable", async () => {
  const report = await runTavernReleaseLiveGate({ runs: passedRuns(), prerequisites: passingPrerequisites });
  assert.equal(report.verdict, "inconclusive");
  assert.equal(report.reasonCode, "mounted_profile_operation_evidence_unavailable");
  assert.ok(report.checks.some((check) => check.detail === mappingBlocker));
  assert.deepEqual(report.mappedOperationIds, []);
  assert.equal("requiredSteps" in report, false);
});

test("Tavern live gate is inconclusive when the operation evidence does not match the mounted profile", async () => {
  const report = await runTavernReleaseLiveGate({
    mountedProfile,
    operationEvidenceMapping: validMapping({ profile: { ...mountedProfile } }),
    runs: passedRuns(),
    prerequisites: passingPrerequisites,
  });
  assert.equal(report.verdict, "inconclusive");
  assert.equal(report.claims.fullReleaseClaim, false);
});

test("an invalid mapping never projects its untrusted operation keys into the report", async () => {
  // The mapping keys are caller-supplied and only become trustworthy after
  // membership validation. The report is printed and written to disk behind a
  // content guard that screens eight fixed phrases, so an unvalidated key could
  // otherwise smuggle arbitrary text into the evidence file.
  const smuggled = "C:/Users/someone/Downloads/private-notes";
  const report = await runTavernReleaseLiveGate({
    mountedProfile,
    operationEvidenceMapping: validMapping({ operations: { [smuggled]: [token(1)] } }),
    runs: passedRuns(),
    prerequisites: passingPrerequisites,
  });
  assert.equal(report.verdict, "inconclusive");
  assert.deepEqual(report.mappedOperationIds, []);
  assert.equal(JSON.stringify(report).includes(smuggled), false, "an unvalidated mapping key reached the report");
});

test("Tavern live gate never accepts an operator record or an operator observation list", async () => {
  const record = {
    schema_version: 1,
    metadata: {
      run_id: token(1),
      operator_id: token(2),
      started_at: "2026-03-22T10:00:00.000Z",
      build_commit: "abcdef1",
    },
    observations: [
      {
        step_id: token(9),
        outcome: "pass",
        reason_category: "observed",
        operator_observed_at: "2026-03-22T10:01:00.000Z",
        evidence_ids: [token(10)],
      },
    ],
  };

  // A record changes nothing: it can neither lift a missing prerequisite nor
  // manufacture run evidence.
  const withRecord = await runTavernReleaseLiveGate({
    record,
    observations: record.observations,
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    prerequisites: async () => ({ verdict: "blocked" }),
  });
  assert.equal(withRecord.verdict, "blocked");
  assert.equal(
    withRecord.checks.some((check) => check.id.startsWith("operator_") || check.id.startsWith("record_") || check.id.startsWith("observation_")),
    false,
  );

  // And it is not required: a genuine pass needs no record at all.
  const withoutRecord = await runTavernReleaseLiveGate({
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    runs: passedRuns(),
    prerequisites: passingPrerequisites,
  });
  assert.equal(withoutRecord.verdict, "passed");
  assert.deepEqual(withoutRecord.checks, []);
});

test("Tavern live gate report never carries content-bearing fields and stays writable", async () => {
  const report = await runTavernReleaseLiveGate({
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    runs: passedRuns(),
    prerequisites: passingPrerequisites,
  });
  // Free text supplied by a runner is dropped, never copied. Only the bounded
  // turn status is projected; the raw `statuses` object is not carried over.
  assert.equal("prompt" in report.runEvidence[0], false);
  assert.equal("privateText" in report.runEvidence[0].assertions, false);
  assert.equal("statuses" in report.runEvidence[0], false);
  assert.equal(report.runEvidence[0].turn, "completed");

  const root = await mkdtemp(join(tmpdir(), "tavern-release-live-gate-"));
  try {
    // The gate's own report output is what `--report` persists, so the writer's
    // content guard must accept it. A report that failed the guard would throw.
    const target = await prepareReportTarget(join(root, "report.json"));
    await writeReport(target, report);
    const persisted = JSON.parse(await readFile(target, "utf8"));
    assert.equal(persisted.gate, "tavern_release_live_gate/v1");
    assert.equal(persisted.verdict, "passed");

    // A content-bearing report is rejected outright by the same writer.
    await assert.rejects(
      writeReport(await prepareReportTarget(join(root, "leak.json")), {
        ...report,
        prompt: "private prompt",
      }),
      /evidence_report_content_guard_rejected/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Tavern live gate does not derive a release pass from caller-supplied target flow names", async () => {
  const report = await runTavernReleaseLiveGate({
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    runs: passedRuns(),
    prerequisites: passingPrerequisites,
    targetMustFlows: ["companion-library", "new-chat", "memory-management"],
  });
  assert.equal(report.verdict, "passed");
  assert.equal(report.claims.requiredMustFlowsExecuted, false);
  assert.equal(report.claims.fullReleaseClaim, false);
  assert.equal("requiredSteps" in report, false);
});

test("chat-tavern-live is explicit on the selected profile and mints no full release claim", async () => {
  const profiles = [];
  const report = await runTavernReleaseLiveGate({
    profile: CHAT_TAVERN_LIVE_PROFILE,
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    runs: passedRuns(),
    prerequisites: async ({ profile }) => {
      profiles.push(profile);
      return { verdict: "passed" };
    },
  });

  assert.deepEqual(profiles, [CHAT_TAVERN_LIVE_PROFILE]);
  assert.equal(report.profile, CHAT_TAVERN_LIVE_PROFILE);
  assert.equal(report.verdict, "passed");
  // A Chat/Tavern live pass is not a full release claim.
  assert.equal(report.claims.fullReleaseClaim, false);
  assert.equal(report.claims.requiredMustFlowsExecuted, false);
});

test("release orchestrator aggregates content-free run summaries and reaches the same verdict as the gate", async () => {
  const calls = [];
  const report = await runTavernReleaseLiveOrchestrator({
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    prerequisites: async () => ({ verdict: "passed", checks: [{ id: "ready", status: "passed" }] }),
    runNarrative: async ({ role, reportPath }) => {
      calls.push({ role, reportPath });
      return passedRun(role, { privateText: "must not be copied" });
    },
    temporaryReportPath: (role) => `/tmp/${role}.json`,
  });
  assert.deepEqual(calls.map(({ role }) => role), [...NARRATIVE_RUN_PLAN]);
  assert.equal(report.verdict, "passed");
  assert.equal("reasonCode" in report, false);
  assert.deepEqual(report.runs.map(({ role }) => role), [...NARRATIVE_RUN_PLAN]);
  assert.equal(report.runs[0].state, "passed");
  assert.equal(report.runs[0].runnerRunId, token(20));
  assert.equal("prompt" in report.runs[0], false);
  assert.equal("privateText" in report.runs[0].assertions, false);
  assert.equal(report.claims.requiredMustFlowsExecuted, false);
  assert.equal(report.claims.fullReleaseClaim, false);
});

test("release orchestrator records a runner exception as a blocked attempt without fabricating recovery", async () => {
  const report = await runTavernReleaseLiveOrchestrator({
    mountedProfile,
    operationEvidenceMapping: validMapping(),
    prerequisites: passingPrerequisites,
    runNarrative: async ({ role }) => {
      if (role === "recovery") throw new Error("private provider detail");
      return { role, state: "blocked", reasonCode: "runtime_interruption" };
    },
    temporaryReportPath: (role) => `/tmp/${role}.json`,
  });
  assert.equal(report.verdict, "inconclusive");
  assert.equal(report.reasonCode, "narrative_run_evidence_incomplete");
  assert.deepEqual(report.runs.map(({ role, state }) => ({ role, state })), [
    { role: "main", state: "blocked" },
    { role: "failure", state: "blocked" },
    { role: "recovery", state: "blocked" },
  ]);
  assert.equal(report.runs[2].reasonCode, "narrative_runner_internal_error");
});

test("release orchestrator accepts only the orchestrate mode and its four flags", () => {
  assert.deepEqual(parseArguments(["--orchestrate"]), {
    profile: "full",
    reportPath: undefined,
    mountedProfilePath: undefined,
    operationEvidenceMappingPath: undefined,
  });
  assert.equal(parseArguments(["--orchestrate", "--profile", CHAT_TAVERN_LIVE_PROFILE]).profile, CHAT_TAVERN_LIVE_PROFILE);
  assert.throws(() => parseArguments(["--record", "record.json"]), /usage:/);
  assert.throws(() => parseArguments(["--orchestrate", "--record", "record.json"]), /usage:/);
  assert.throws(() => parseArguments(["--orchestrate", "--profile"]), /usage:/);
  assert.throws(() => parseArguments(["--orchestrate", "--profile", "full", "--profile", "full"]), /duplicate_profile/);
});
