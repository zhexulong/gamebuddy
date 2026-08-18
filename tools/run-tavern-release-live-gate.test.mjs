import assert from "node:assert/strict";
import test from "node:test";
import { runTavernReleaseLiveGate } from "./run-tavern-release-live-gate.mjs";

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
const mappingBlocker = "mounted_composed_tavern_profile_operation_to_evidence_mapping_not_implemented";

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
