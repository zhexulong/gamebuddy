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
function passedRun(role, overrides = {}) {
  return {
    role,
    state: "passed",
    runId: token(20),
    artifact: { generation: `generation_${role}`, inventoryDigest: sha },
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
  const recorderProfile = {
    profileId: "gamebuddy.tavern-management.chat-list-title",
    releaseTier: "tavern_management",
    routeIds: ["chat.rename", "draft.save", "draft.discard"],
    operationIds: ["chat.rename", "draft.save", "draft.discard"],
    navigationItemIds: ["chat"],
  };
  const root = await mkdtemp(join(tmpdir(), "tavern-release-live-gate-recorder-"));
  try {
    const inputPath = join(root, "input.json");
    const outputPath = join(root, "mapping.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        profile: recorderProfile,
        operations: [
          { operationId: "chat.rename", outcome: "passed" },
          { operationId: "draft.save", outcome: "passed" },
          { operationId: "draft.discard", outcome: "not_applicable" },
        ],
      }),
    );
    await recordTavernUiOperationEvidence({ inputPath, outputPath });
    const operationEvidenceMapping = JSON.parse(await readFile(outputPath, "utf8"));
    const validation = validateMountedProfileOperationEvidence({
      mountedProfile: recorderProfile,
      operationEvidenceMapping,
    });
    assert.equal(validation.valid, true, JSON.stringify(validation.checks));
    assert.deepEqual(validation.mappedOperationIds, ["chat.rename", "draft.save"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
