import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_TAVERN_LIVE_PROFILE,
  MOUNTED_PROFILE_MAPPING_BLOCKER,
  NARRATIVE_RUN_PLAN,
  runTavernReleaseLiveGate,
  runTavernReleaseLiveOrchestrator,
  validateMountedProfileOperationEvidence,
} from "./run-tavern-release-live-gate.mjs";

const sha = "a".repeat(64);
const token = (value) => value.toString(16).padStart(16, "0");
function validRecord() {
  return {
    schema_version: 1,
    metadata: {
      run_id: token(1),
      operator_id: token(2),
      started_at: "2026-03-22T10:00:00.000Z",
      build_commit: "abcdef1",
      release_profile_id: token(3),
      release_profile_hash: sha,
      magic_context_vendor_hash: sha,
      provider_configuration_id: token(4),
      compatibility_manifest_hash: sha,
      semantic_reference_registry_hash: sha,
      fixture_manifest_hash: sha,
      companion_id: token(5),
      continuity_id: token(6),
      chat_thread_id: token(7),
      surface_session_id: token(8),
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
}
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
});

test("valid mapping removes only mapping blocker and never claims full release", async () => {
  const report = await runTavernReleaseLiveGate({ record: validRecord(), mountedProfile, operationEvidenceMapping: validMapping(), prerequisites: passingPrerequisites });
  assert.equal(report.verdict, "inconclusive");
  assert.equal(report.checks.some((check) => check.detail === mappingBlocker), false);
  assert.deepEqual(report.mappedOperationIds, ["chat.submit"]);
  assert.equal(report.claims.fullReleaseClaim, false);
  assert.equal(report.claims.requiredMustFlowsExecuted, false);
});

test("Tavern live gate fails closed despite privacy-safe operator evidence and passed prerequisites", async () => {
  const report = await runTavernReleaseLiveGate({ record: validRecord(), prerequisites: passingPrerequisites });
  assert.equal(report.verdict, "inconclusive");
  assert.equal(report.prerequisite, "passed");
  assert.ok(report.checks.some((check) => check.detail === mappingBlocker));
  assert.equal("requiredSteps" in report, false);
});

test("Tavern live gate does not derive a release pass from caller-supplied target flow names", async () => {
  const report = await runTavernReleaseLiveGate({
    record: validRecord(),
    prerequisites: passingPrerequisites,
    targetMustFlows: ["companion-library", "new-chat", "memory-management"],
  });
  assert.equal(report.verdict, "inconclusive");
  assert.ok(report.checks.some((check) => check.detail === mappingBlocker));
  assert.equal("requiredSteps" in report, false);
});

test("Tavern live gate is inconclusive without an authentic operator record", async () => {
  const report = await runTavernReleaseLiveGate({ record: undefined, prerequisites: passingPrerequisites });
  assert.equal(report.verdict, "inconclusive");
  assert.ok(report.checks.some((check) => check.detail === "operator_evidence_missing"));
  assert.ok(report.checks.some((check) => check.detail === mappingBlocker));
});

test("Tavern live gate retains privacy and record-shape validation while blocked", async () => {
  const record = validRecord();
  record.observations[0].dialogue = "private dialogue must never be recorded";
  record.metadata.operator_id = "real-person-name";
  record.metadata.extra = "private metadata must never be recorded";
  const report = await runTavernReleaseLiveGate({ record, prerequisites: passingPrerequisites });
  assert.equal(report.verdict, "inconclusive");
  assert.ok(report.checks.some((check) => check.detail === "observation_contains_unsupported_or_content_field"));
  assert.ok(report.checks.some((check) => check.detail === "metadata_contains_unsupported_or_content_field"));
  assert.ok(report.checks.some((check) => check.id === "metadata_operator_id"));
  assert.ok(report.checks.some((check) => check.detail === mappingBlocker));
});

test("Tavern live gate preserves prerequisite validation while mounted profile evidence is unavailable", async () => {
  const report = await runTavernReleaseLiveGate({
    record: validRecord(),
    prerequisites: async () => ({ verdict: "blocked" }),
  });
  assert.equal(report.verdict, "inconclusive");
  assert.ok(report.checks.some((check) => check.detail === "automated_prerequisite_not_passed"));
  assert.ok(report.checks.some((check) => check.detail === mappingBlocker));
});

test("chat-tavern-live profile is explicit on record validation and never claims full release flows", async () => {
  const profiles = [];
  const report = await runTavernReleaseLiveGate({
    record: validRecord(),
    profile: CHAT_TAVERN_LIVE_PROFILE,
    prerequisites: async ({ profile }) => {
      profiles.push(profile);
      return { verdict: "passed" };
    },
  });

  assert.deepEqual(profiles, [CHAT_TAVERN_LIVE_PROFILE]);
  assert.equal(report.profile, CHAT_TAVERN_LIVE_PROFILE);
  assert.equal(report.verdict, "inconclusive");

  const orchestrator = await runTavernReleaseLiveOrchestrator({
    profile: CHAT_TAVERN_LIVE_PROFILE,
    prerequisites: async ({ profile }) => {
      profiles.push(profile);
      return { verdict: "blocked", checks: [{ id: "windows_arbitrary_reparse_enforcement", status: "not_applicable" }] };
    },
    runNarrative: async () => {
      throw new Error("chat profile must stop at blocked prerequisite");
    },
  });

  assert.deepEqual(profiles, [CHAT_TAVERN_LIVE_PROFILE, CHAT_TAVERN_LIVE_PROFILE]);
  assert.equal(orchestrator.profile, CHAT_TAVERN_LIVE_PROFILE);
  assert.equal(orchestrator.verdict, "blocked");
  assert.equal(orchestrator.claims.fullReleaseClaim, false);
  assert.equal(orchestrator.claims.requiredMustFlowsExecuted, false);
});

test("chat-tavern-live orchestrator selects its distinct profile and never claims full release flows", async () => {
  const profiles = [];
  const report = await runTavernReleaseLiveOrchestrator({
    profile: CHAT_TAVERN_LIVE_PROFILE,
    prerequisites: async ({ profile }) => {
      profiles.push(profile);
      return { verdict: "blocked", checks: [{ id: "windows_arbitrary_reparse_enforcement", status: "not_applicable" }] };
    },
    runNarrative: async () => {
      throw new Error("chat profile must stop at blocked prerequisite");
    },
  });

  assert.deepEqual(profiles, [CHAT_TAVERN_LIVE_PROFILE]);
  assert.equal(report.profile, CHAT_TAVERN_LIVE_PROFILE);
  assert.equal(report.verdict, "blocked");
  assert.equal(report.claims.fullReleaseClaim, false);
  assert.equal(report.claims.requiredMustFlowsExecuted, false);
});

test("release orchestrator short-circuits before any narrative run when prerequisites block", async () => {
  let calls = 0;
  const report = await runTavernReleaseLiveOrchestrator({
    prerequisites: async () => ({ verdict: "blocked", checks: [{ id: "x", status: "blocked" }] }),
    runNarrative: async () => {
      calls += 1;
      return { state: "passed" };
    },
  });
  assert.equal(calls, 0);
  assert.equal(report.verdict, "blocked");
  assert.deepEqual(report.runs, []);
  assert.deepEqual(report.plannedRunKinds, [...NARRATIVE_RUN_PLAN]);
  assert.equal(report.claims.requiredMustFlowsExecuted, false);
  assert.equal(report.claims.fullReleaseClaim, false);
});

test("release orchestrator aggregates only content-free narrative run summaries and stays inconclusive", async () => {
  const calls = [];
  const report = await runTavernReleaseLiveOrchestrator({
    prerequisites: async () => ({ verdict: "passed", checks: [{ id: "ready", status: "passed" }] }),
    runNarrative: async ({ role, reportPath }) => {
      calls.push({ role, reportPath });
      return {
        state: role === "main" ? "passed" : "blocked",
        runId: "a".repeat(16),
        reasonCode: role === "main" ? undefined : "provider_request_pending",
        artifact: { generation: "generation_1", inventoryDigest: "b".repeat(64) },
        assertions: {
          authenticatedReferenceChatApi: true,
          realDialogueTurnAttempted: true,
          providerRuntimeSessionBound: role === "main",
          providerPreSendSerialized: role === "main",
          realTurnOutcomeObserved: role === "main",
          privateText: "must not be copied",
        },
        statuses: { turn: role === "main" ? "completed" : "timeout", private: "removed" },
        prompt: "must not be copied",
      };
    },
    temporaryReportPath: (role) => `/tmp/${role}.json`,
  });
  assert.deepEqual(calls.map(({ role }) => role), [...NARRATIVE_RUN_PLAN]);
  assert.equal(report.verdict, "inconclusive");
  assert.equal(report.reasonCode, "mounted_profile_operation_evidence_unavailable");
  assert.deepEqual(report.runs.map(({ role }) => role), [...NARRATIVE_RUN_PLAN]);
  assert.equal(report.runs[0].state, "passed");
  assert.equal(report.runs[1].reasonCode, "provider_request_pending");
  assert.equal("prompt" in report.runs[0], false);
  assert.equal("privateText" in report.runs[0].assertions, false);
  assert.equal(report.claims.requiredMustFlowsExecuted, false);
  assert.equal(report.claims.fullReleaseClaim, false);
});

test("release orchestrator records a runner exception as a blocked attempt without fabricating recovery", async () => {
  const report = await runTavernReleaseLiveOrchestrator({
    prerequisites: async () => ({ verdict: "passed" }),
    runNarrative: async ({ role }) => {
      if (role === "recovery") throw new Error("private provider detail");
      return { role, state: "blocked", reasonCode: "runtime_interruption" };
    },
    temporaryReportPath: (role) => `/tmp/${role}.json`,
  });
  assert.equal(report.verdict, "inconclusive");
  assert.deepEqual(report.runs.map(({ role, state }) => ({ role, state })), [
    { role: "main", state: "blocked" },
    { role: "failure", state: "blocked" },
    { role: "recovery", state: "blocked" },
  ]);
  assert.equal(report.runs[2].reasonCode, "narrative_runner_internal_error");
});
