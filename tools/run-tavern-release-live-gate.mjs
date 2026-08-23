import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTavernReleasePrerequisites } from "./check-tavern-release-prerequisites.mjs";

export const TAVERN_LIVE_RECORD_SCHEMA_VERSION = 1;
export const TAVERN_LIVE_GATE = "tavern_release_live_gate/v1";

const OUTCOMES = new Set(["pass", "fail", "blocked", "inconclusive", "not_applicable"]);
const REASONS = new Set([
  "observed",
  "operation_not_declared",
  "participant_stopped",
  "runtime_interruption",
  "prerequisite_blocked",
  "privacy_exposure",
  "wrong_behavior",
  "insufficient_observation",
]);
// Hex-only tokens deliberately make this record incapable of carrying dialogue or labels.
const OPAQUE_ID = /^[a-f0-9]{16,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{7,64}$/;

function check(condition, id, detail, checks) {
  if (!condition) checks.push({ id, status: "blocked", detail });
}

function opaque(value) {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

/**
 * Validates a deliberately minimal, non-content Tavern operator observation record.
 * This checker cannot infer UI behavior. Until a mounted ComposedTavernProfile-derived,
 * independently verified operation-to-evidence mapping exists, it always fails closed.
 */
export async function runTavernReleaseLiveGate({ record, prerequisites = checkTavernReleasePrerequisites } = {}) {
  const checks = [];
  const mappingBlocker = {
    id: "mounted_profile_operation_evidence",
    status: "blocked",
    detail: "mounted_composed_tavern_profile_operation_to_evidence_mapping_not_implemented",
  };
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return {
      gate: TAVERN_LIVE_GATE,
      verdict: "inconclusive",
      checks: [{ id: "operator_record", status: "blocked", detail: "operator_evidence_missing" }, mappingBlocker],
    };
  }

  check(
    record.schema_version === TAVERN_LIVE_RECORD_SCHEMA_VERSION,
    "record_schema",
    "record_schema_version_invalid",
    checks,
  );
  const metadata = record.metadata;
  const metadataFields = [
    "run_id",
    "operator_id",
    "started_at",
    "build_commit",
    "release_profile_id",
    "release_profile_hash",
    "magic_context_vendor_hash",
    "provider_configuration_id",
    "compatibility_manifest_hash",
    "semantic_reference_registry_hash",
    "fixture_manifest_hash",
    "companion_id",
    "continuity_id",
    "chat_thread_id",
    "surface_session_id",
  ];
  check(
    metadata && typeof metadata === "object" && !Array.isArray(metadata),
    "record_metadata",
    "record_metadata_missing",
    checks,
  );
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    check(
      Object.keys(metadata).every((key) => metadataFields.includes(key)),
      "record_metadata_shape",
      "metadata_contains_unsupported_or_content_field",
      checks,
    );
    for (const field of [
      "run_id",
      "operator_id",
      "release_profile_id",
      "provider_configuration_id",
      "companion_id",
      "continuity_id",
      "chat_thread_id",
      "surface_session_id",
    ]) {
      check(opaque(metadata[field]), `metadata_${field}`, `metadata_${field}_must_be_opaque_id`, checks);
    }
    check(
      typeof metadata.started_at === "string" && !Number.isNaN(Date.parse(metadata.started_at)),
      "metadata_started_at",
      "metadata_started_at_invalid",
      checks,
    );
    check(
      typeof metadata.build_commit === "string" && COMMIT.test(metadata.build_commit),
      "metadata_build_commit",
      "metadata_build_commit_invalid",
      checks,
    );
    for (const field of [
      "release_profile_hash",
      "magic_context_vendor_hash",
      "compatibility_manifest_hash",
      "semantic_reference_registry_hash",
      "fixture_manifest_hash",
    ]) {
      check(
        typeof metadata[field] === "string" && HASH.test(metadata[field]),
        `metadata_${field}`,
        `metadata_${field}_must_be_sha256`,
        checks,
      );
    }
  }

  const observations = record.observations;
  check(
    Array.isArray(observations) && observations.length > 0,
    "operator_observations",
    "operator_observations_missing",
    checks,
  );
  const seen = new Map();
  if (Array.isArray(observations)) {
    for (const observation of observations) {
      const validShape =
        observation &&
        typeof observation === "object" &&
        !Array.isArray(observation) &&
        Object.keys(observation).every((key) =>
          ["step_id", "outcome", "reason_category", "operator_observed_at", "evidence_ids"].includes(key),
        );
      check(validShape, "observation_shape", "observation_contains_unsupported_or_content_field", checks);
      if (!validShape) continue;
      check(opaque(observation.step_id), "observation_step", "observation_step_must_be_opaque_id", checks);
      check(OUTCOMES.has(observation.outcome), "observation_outcome", "observation_outcome_invalid", checks);
      check(
        REASONS.has(observation.reason_category),
        "observation_reason",
        "observation_reason_category_invalid",
        checks,
      );
      check(
        typeof observation.operator_observed_at === "string" &&
          !Number.isNaN(Date.parse(observation.operator_observed_at)),
        "observation_timestamp",
        "operator_observation_timestamp_invalid",
        checks,
      );
      check(
        Array.isArray(observation.evidence_ids) &&
          observation.evidence_ids.length > 0 &&
          observation.evidence_ids.every(opaque),
        "observation_evidence",
        "observation_evidence_must_be_nonempty_opaque_ids",
        checks,
      );
      if (observation.outcome === "pass")
        check(
          observation.reason_category === "observed",
          "pass_observation",
          "pass_requires_direct_operator_observation",
          checks,
        );
      if (observation.outcome === "not_applicable")
        check(
          observation.reason_category === "operation_not_declared",
          "not_applicable_observation",
          "not_applicable_requires_undeclared_operation",
          checks,
        );
      if (seen.has(observation.step_id)) check(false, "observation_duplicate", "duplicate_step_observation", checks);
      seen.set(observation.step_id, observation);
    }
  }
  let prerequisiteReport;
  try {
    prerequisiteReport = await prerequisites();
    check(
      prerequisiteReport?.verdict === "passed",
      "prerequisite_verdict",
      "automated_prerequisite_not_passed",
      checks,
    );
  } catch {
    check(false, "prerequisite_verdict", "automated_prerequisite_unavailable", checks);
  }

  return {
    gate: TAVERN_LIVE_GATE,
    verdict: "inconclusive",
    checks: [...checks, mappingBlocker],
    prerequisite: prerequisiteReport?.verdict ?? "unavailable",
  };
}

async function main() {
  const input = process.argv.slice(2);
  const index = input.indexOf("--record");
  if (index < 0 || !input[index + 1] || input.length !== 2)
    throw new Error("usage: node tools/run-tavern-release-live-gate.mjs --record <privacy-safe-record.json>");
  const record = JSON.parse(
    await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "..", input[index + 1]), "utf8"),
  );
  const report = await runTavernReleaseLiveGate({ record });
  console.log(JSON.stringify(report, null, 2));
  if (report.verdict !== "passed") process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.log(
      JSON.stringify(
        {
          gate: TAVERN_LIVE_GATE,
          verdict: "inconclusive",
          checks: [{ id: "runner_execution", status: "blocked", detail: error.message }],
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
  });
}
