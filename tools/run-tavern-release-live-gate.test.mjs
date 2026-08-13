import assert from "node:assert/strict";
import test from "node:test";
import { runTavernReleaseLiveGate } from "./run-tavern-release-live-gate.mjs";

const sha = "a".repeat(64);
const token = (value) => value.toString(16).padStart(16, "0");
const requiredSteps = ["TVL-00", "TVL-01", "TVL-02", "TVL-03", "TVL-04", "TVL-05", "TVL-06", "TVL-07", "TVL-09"];
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
    observations: requiredSteps.map((step, index) => ({
      step_id: step,
      outcome: step === "TVL-06" ? "not_applicable" : "pass",
      reason_category: step === "TVL-06" ? "operation_not_declared" : "observed",
      operator_observed_at: "2026-03-22T10:01:00.000Z",
      evidence_ids: [token(index + 10)],
    })),
  };
}
const passingPrerequisites = async () => ({ verdict: "passed" });

test("Tavern live gate passes only complete direct non-content operator observations after prerequisites pass", async () => {
  const report = await runTavernReleaseLiveGate({ record: validRecord(), prerequisites: passingPrerequisites });
  assert.equal(report.verdict, "passed");
  assert.deepEqual(report.requiredSteps, requiredSteps);
});

test("Tavern live gate is inconclusive without authentic operator evidence", async () => {
  const report = await runTavernReleaseLiveGate({ record: undefined, prerequisites: passingPrerequisites });
  assert.equal(report.verdict, "inconclusive");
  assert.match(report.checks[0].detail, /operator_evidence_missing/);
});

test("Tavern live gate fails closed for raw dialogue fields and missing must-flow coverage", async () => {
  const record = validRecord();
  record.observations[0].dialogue = "private dialogue must never be recorded";
  record.observations.pop();
  const report = await runTavernReleaseLiveGate({ record, prerequisites: passingPrerequisites });
  assert.equal(report.verdict, "inconclusive");
  assert.ok(report.checks.some((check) => check.detail === "observation_contains_unsupported_or_content_field"));
  assert.ok(report.checks.some((check) => check.detail === "required_step_missing:TVL-09"));
});

test("Tavern live gate rejects non-opaque labels, metadata content fields, and never upgrades an unobserved or prerequisite-blocked run", async () => {
  const record = validRecord();
  Object.assign(record.metadata, { dialogue: "private dialogue must never be recorded" });
  let report = await runTavernReleaseLiveGate({ record, prerequisites: passingPrerequisites });
  assert.equal(report.verdict, "inconclusive");
  assert.ok(report.checks.some((check) => check.detail === "metadata_contains_unsupported_or_content_field"));
  record.metadata.operator_id = "real-person-name";
  report = await runTavernReleaseLiveGate({ record, prerequisites: passingPrerequisites });
  record.observations[0].outcome = "inconclusive";
  record.observations[0].reason_category = "insufficient_observation";
  assert.equal(report.verdict, "inconclusive");
  assert.ok(report.checks.some((check) => check.id === "metadata_operator_id"));
  report = await runTavernReleaseLiveGate({
    record: validRecord(),
    prerequisites: async () => ({ verdict: "blocked" }),
  });
  assert.equal(report.verdict, "inconclusive");
  assert.ok(report.checks.some((check) => check.detail === "automated_prerequisite_not_passed"));
});
