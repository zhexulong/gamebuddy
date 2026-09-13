import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  CHAT_TAVERN_LIVE_PROFILE,
  checkTavernReleasePrerequisites,
  DEFAULT_TAVERN_RELEASE_PROFILE,
} from "./check-tavern-release-prerequisites.mjs";

import { prepareReportTarget, writeReport } from "./run-tavern-narrative-gate.mjs";

export { CHAT_TAVERN_LIVE_PROFILE, DEFAULT_TAVERN_RELEASE_PROFILE };

const TAVERN_LIVE_RECORD_SCHEMA_VERSION = 1;
const TAVERN_LIVE_GATE = "tavern_release_live_gate/v1";

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
const ORCHESTRATOR_SCHEMA = "tavern_release_live_orchestrator/v1";
const NARRATIVE_RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), "run-tavern-narrative-gate.mjs");
export const NARRATIVE_RUN_PLAN = Object.freeze(["main", "failure", "recovery"]);
export const MOUNTED_PROFILE_MAPPING_BLOCKER = Object.freeze({
  id: "mounted_profile_operation_evidence",
  status: "blocked",
  detail: "mounted_composed_tavern_profile_operation_to_evidence_mapping_missing_or_invalid",
});
export const MOUNTED_PROFILE_OPERATION_EVIDENCE_SCHEMA_VERSION = 1;

const COMPOSED_TAVERN_PROFILE_KEYS = Object.freeze([
  "profileId",
  "releaseTier",
  "routeIds",
  "operationIds",
  "navigationItemIds",
]);
const OPERATION_ROUTE_IDS = Object.freeze({
  "draft.save": "draft.save",
  "draft.discard": "draft.discard",
  "chat.rename": "chat.rename",
  "chat.submit": "chat.submit",
  "chat.cancel": "chat.cancel",
  "chat.submission_status": "chat.submission_status",
  "memory.mutate": "memory.mutate",
  "world-info.bind": "world-info.bind",
});
const CONTRACT_ROUTE_IDS = new Set([
  "bootstrap",
  "state.read",
  "draft.read",
  "draft.save",
  "draft.discard",
  "chat.submit",
  "chat.submission_status",
  "chat.list",
  "chat.rename",
  "chat.cancel",
  "memory.read",
  "memory.mutate",
  "world-info.read",
  "world-info.bind",
  "events",
]);
const CONTRACT_NAVIGATION_ITEM_IDS = new Set(["chat", "memory"]);
const PROFILE_IDENTITY_MAPPING_KEYS = Object.freeze(["schema_version", "profile", "operations"]);
const PROFILE_ID_HASH_MAPPING_KEYS = Object.freeze(["schema_version", "profile_id", "profile_hash", "release_tier", "operations"]);
const PROFILE_ID_HASH_WITHOUT_TIER_MAPPING_KEYS = Object.freeze([
  "schema_version",
  "profile_id",
  "profile_hash",
  "operations",
]);

function check(condition, id, detail, checks) {
  if (!condition) checks.push({ id, status: "blocked", detail });
}

function opaque(value) {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function plainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected) {
  if (!plainRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every((key) => typeof key === "string" && expected.includes(key));
}

function canonicalProfileHash(profile) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        profileId: profile.profileId,
        releaseTier: profile.releaseTier,
        routeIds: profile.routeIds,
        operationIds: profile.operationIds,
        navigationItemIds: profile.navigationItemIds,
      }),
      "utf8",
    )
    .digest("hex");
}

function validateMountedProfile(mountedProfile, checks) {
  check(
    exactKeys(mountedProfile, COMPOSED_TAVERN_PROFILE_KEYS),
    "mounted_profile_shape",
    "mounted_composed_tavern_profile_shape_invalid",
    checks,
  );
  if (!plainRecord(mountedProfile)) return false;

  check(
    typeof mountedProfile.profileId === "string" && /^[a-z][a-z0-9._-]{0,127}$/.test(mountedProfile.profileId),
    "mounted_profile_identity",
    "mounted_composed_tavern_profile_identity_invalid",
    checks,
  );
  check(
    mountedProfile.releaseTier === "chat_core" || mountedProfile.releaseTier === "tavern_management",
    "mounted_profile_release_tier",
    "mounted_composed_tavern_profile_release_tier_invalid",
    checks,
  );

  for (const [field, detail] of [
    ["routeIds", "mounted_composed_tavern_profile_routes_invalid"],
    ["operationIds", "mounted_composed_tavern_profile_operations_invalid"],
    ["navigationItemIds", "mounted_composed_tavern_profile_navigation_invalid"],
  ]) {
    check(Array.isArray(mountedProfile[field]), `mounted_profile_${field}`, detail, checks);
    if (!Array.isArray(mountedProfile[field])) continue;
    const declared =
      field === "routeIds"
        ? CONTRACT_ROUTE_IDS
        : field === "operationIds"
          ? new Set(Object.keys(OPERATION_ROUTE_IDS))
          : CONTRACT_NAVIGATION_ITEM_IDS;
    check(
      Array.from(mountedProfile[field]).every((value) => typeof value === "string" && declared.has(value)) &&
        new Set(mountedProfile[field]).size === mountedProfile[field].length,
      `mounted_profile_${field}_members`,
      `${detail.replace(/_invalid$/, "")}_must_be_declared_unique_strings`,
      checks,
    );
  }

  if (!Array.isArray(mountedProfile.routeIds) || !Array.isArray(mountedProfile.operationIds)) return false;
  const routes = new Set(mountedProfile.routeIds);
  for (const operationId of mountedProfile.operationIds) {
    const routeId = OPERATION_ROUTE_IDS[operationId];
    if (routeId !== undefined) {
      check(
        routes.has(routeId),
        "mounted_profile_operation_route_membership",
        "mounted_composed_tavern_profile_operation_route_not_declared",
        checks,
      );
    }
  }
  for (const routeId of routes) {
    const operationId = Object.entries(OPERATION_ROUTE_IDS).find(([, candidate]) => candidate === routeId)?.[0];
    if (operationId !== undefined) {
      check(
        mountedProfile.operationIds.includes(operationId),
        "mounted_profile_route_operation_membership",
        "mounted_composed_tavern_profile_route_operation_not_declared",
        checks,
      );
    }
  }
  return checks.length === 0;
}

/**
 * The release record carries a redacted projection of the exact mounted profile
 * and an independently supplied operation-to-evidence map. Evidence is opaque
 * by construction: this contract never accepts operation labels, UI text, URLs,
 * prompts, or any other content as evidence.
 *
 * `operations` is a map whose keys are operation IDs and whose values are
 * non-empty arrays of opaque evidence IDs. A map entry is valid only when its
 * operation is in the supplied mounted profile; the map cannot add capability.
 */
export function validateMountedProfileOperationEvidence({ mountedProfile, operationEvidenceMapping } = {}) {
  const checks = [];
  const profileValid = validateMountedProfile(mountedProfile, checks);
  check(
    plainRecord(operationEvidenceMapping),
    "mounted_profile_operation_evidence_shape",
    "mounted_composed_tavern_profile_operation_to_evidence_mapping_shape_invalid",
    checks,
  );
  if (!plainRecord(operationEvidenceMapping)) return { valid: false, checks, mappedOperationIds: [] };

  check(
    operationEvidenceMapping.schema_version === MOUNTED_PROFILE_OPERATION_EVIDENCE_SCHEMA_VERSION,
    "mounted_profile_operation_evidence_schema",
    "mounted_composed_tavern_profile_operation_to_evidence_mapping_schema_invalid",
    checks,
  );
  const exactIdentity = Object.prototype.hasOwnProperty.call(operationEvidenceMapping, "profile");
  const hashIdentity = Object.prototype.hasOwnProperty.call(operationEvidenceMapping, "profile_hash");
  const idIdentity = Object.prototype.hasOwnProperty.call(operationEvidenceMapping, "profile_id");
  check(
    (exactIdentity ? 1 : 0) + (hashIdentity ? 1 : 0) + (idIdentity ? 1 : 0) === 1,
    "mounted_profile_operation_evidence_identity_shape",
    "mounted_composed_tavern_profile_operation_to_evidence_mapping_identity_invalid",
    checks,
  );
  if (exactIdentity) {
    check(
      exactKeys(operationEvidenceMapping, PROFILE_IDENTITY_MAPPING_KEYS) &&
        operationEvidenceMapping.profile === mountedProfile,
      "mounted_profile_operation_evidence_profile",
      "mounted_composed_tavern_profile_operation_to_evidence_mapping_profile_mismatch",
      checks,
    );
  } else if (hashIdentity) {
    check(
      (idIdentity &&
        (exactKeys(operationEvidenceMapping, PROFILE_ID_HASH_MAPPING_KEYS) ||
        exactKeys(operationEvidenceMapping, PROFILE_ID_HASH_WITHOUT_TIER_MAPPING_KEYS)) &&
        typeof operationEvidenceMapping.profile_id === "string" &&
        typeof operationEvidenceMapping.profile_hash === "string" &&
        HASH.test(operationEvidenceMapping.profile_hash) &&
        profileValid &&
        operationEvidenceMapping.profile_id === mountedProfile?.profileId &&
        (operationEvidenceMapping.release_tier === undefined ||
          operationEvidenceMapping.release_tier === mountedProfile?.releaseTier) &&
        operationEvidenceMapping.profile_hash === canonicalProfileHash(mountedProfile)),
      "mounted_profile_operation_evidence_profile",
      "mounted_composed_tavern_profile_operation_to_evidence_mapping_profile_mismatch",
      checks,
    );
  }

  const operations = operationEvidenceMapping.operations;
  check(
    plainRecord(operations) &&
      Reflect.ownKeys(operations).every((key) => typeof key === "string") &&
      Object.keys(operations).length > 0,
    "mounted_profile_operation_evidence_operations",
    "mounted_composed_tavern_profile_operation_to_evidence_mapping_operations_missing",
    checks,
  );
  if (!plainRecord(operations)) return { valid: false, checks, mappedOperationIds: [] };

  const declaredOperations = new Set(Array.isArray(mountedProfile?.operationIds) ? mountedProfile.operationIds : []);
  const mappedOperationIds = Object.keys(operations);
  for (const operationId of mappedOperationIds) {
    check(
      declaredOperations.has(operationId),
      "mounted_profile_operation_evidence_operation_membership",
      "mounted_composed_tavern_profile_operation_to_evidence_mapping_operation_not_declared",
      checks,
    );
    const evidenceIds = operations[operationId];
    check(
      Array.isArray(evidenceIds) && evidenceIds.length > 0 && Array.from(evidenceIds).every(opaque),
      "mounted_profile_operation_evidence_ids",
      "mounted_composed_tavern_profile_operation_to_evidence_mapping_evidence_ids_invalid",
      checks,
    );
  }

  return { valid: profileValid && checks.length === 0, checks, mappedOperationIds };
}

/**
 * Validates a deliberately minimal, non-content Tavern operator observation record.
 * This checker cannot infer UI behavior. A valid mounted ComposedTavernProfile-derived,
 * independently supplied operation-to-evidence mapping removes only the mapping
 * blocker; it never turns static declarations into a release pass. Mapping
 * evidence may be automation evidence, but it is never accepted as the
 * operator observation record.
 */
export async function runTavernReleaseLiveGate({
  record,
  profile = DEFAULT_TAVERN_RELEASE_PROFILE,
  mountedProfile,
  operationEvidenceMapping,
  prerequisites = checkTavernReleasePrerequisites,
} = {}) {
  const checks = [];
  const mappingBlocker = MOUNTED_PROFILE_MAPPING_BLOCKER;
  const mapping = validateMountedProfileOperationEvidence({ mountedProfile, operationEvidenceMapping });
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return {
      gate: TAVERN_LIVE_GATE,
      verdict: "inconclusive",
       checks: [
         { id: "operator_record", status: "blocked", detail: "operator_evidence_missing" },
         ...mapping.checks,
         ...(mapping.valid ? [] : [mappingBlocker]),
       ],
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
    prerequisiteReport = await prerequisites({ profile });
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
     profile,
     verdict: "inconclusive",
     checks: [...checks, ...mapping.checks, ...(mapping.valid ? [] : [mappingBlocker])],
     prerequisite: prerequisiteReport?.verdict ?? "unavailable",
     mappedOperationIds: mapping.mappedOperationIds,
     claims: { requiredMustFlowsExecuted: false, fullReleaseClaim: false },
   };
}

function safeCode(value, fallback = "narrative_runner_internal_error") {
  return typeof value === "string" && /^[a-z0-9_.:-]{1,160}$/i.test(value) ? value : fallback;
}

function contentFreeNarrativeSummary(role, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { role, state: "blocked", reasonCode: "narrative_report_invalid" };
  }
  const state = value.state === "passed" || value.state === "blocked" ? value.state : "blocked";
  const summary = {
    role,
    state,
    ...(typeof value.reasonCode === "string" ? { reasonCode: safeCode(value.reasonCode) } : {}),
  };
  if (typeof value.runId === "string" && OPAQUE_ID.test(value.runId)) summary.runnerRunId = value.runId;
  if (
    value.artifact &&
    typeof value.artifact === "object" &&
    typeof value.artifact.generation === "string" &&
    /^[A-Za-z0-9_-]{1,160}$/.test(value.artifact.generation) &&
    typeof value.artifact.inventoryDigest === "string" &&
    HASH.test(value.artifact.inventoryDigest)
  ) {
    summary.artifact = {
      generation: value.artifact.generation,
      inventoryDigest: value.artifact.inventoryDigest,
    };
  }
  if (value.assertions && typeof value.assertions === "object" && !Array.isArray(value.assertions)) {
    const assertionKeys = [
      "authenticatedReferenceChatApi",
      "realDialogueTurnAttempted",
      "providerRuntimeSessionBound",
      "providerPreSendSerialized",
      "realTurnOutcomeObserved",
    ];
    summary.assertions = Object.fromEntries(
      assertionKeys.filter((key) => typeof value.assertions[key] === "boolean").map((key) => [key, value.assertions[key]]),
    );
  }
  if (value.statuses && typeof value.statuses === "object" && !Array.isArray(value.statuses)) {
    if (typeof value.statuses.turn === "string") summary.turn = safeCode(value.statuses.turn, "unavailable");
  }
  return summary;
}

async function runNarrativeProcess({ role, reportPath, profile = DEFAULT_TAVERN_RELEASE_PROFILE, spawnProcess = spawn } = {}) {
  if (typeof reportPath !== "string" || reportPath.length === 0)
    return { role, state: "blocked", reasonCode: "narrative_report_target_unavailable" };
  return new Promise((resolveRun) => {
    let settled = false;
    const settle = (summary) => {
      if (settled) return;
      settled = true;
      resolveRun(summary);
    };
    let child;
    try {
      child = spawnProcess(process.execPath, [NARRATIVE_RUNNER, "--report", reportPath], {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
        env: { ...process.env, GAMEBUDDY_TAVERN_PROFILE: profile },
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
    } catch {
      settle({ role, state: "blocked", reasonCode: "narrative_runner_spawn_failed" });
      return;
    }
    child.once("error", () => settle({ role, state: "blocked", reasonCode: "narrative_runner_spawn_failed" }));
    child.once("close", async (code, signal) => {
      let value;
      try {
        value = JSON.parse(await readFile(reportPath, "utf8"));
      } catch {
        settle({
          role,
          state: "blocked",
          reasonCode: signal === null && code === 0 ? "narrative_report_missing" : "narrative_runner_exit_without_report",
        });
        return;
      }
      const summary = contentFreeNarrativeSummary(role, value);
      if (summary.state === "passed" && code !== 0) {
        settle({ role, state: "blocked", reasonCode: "narrative_runner_exit_mismatch" });
        return;
      }
      settle(summary);
    });
  });
}

function prerequisiteSummary(report) {
  const checks = Array.isArray(report?.checks)
    ? report.checks
        .filter((check) => check && typeof check.id === "string" && typeof check.status === "string")
        .map((check) => ({ id: safeCode(check.id, "unknown_check"), status: safeCode(check.status, "blocked") }))
    : [];
  return { verdict: report?.verdict === "passed" ? "passed" : "blocked", checks };
}

/**
 * Runs a small real-run evidence slice. The run labels describe attempts only;
 * they never assert that a failure occurred or that recovery resumed a thread.
 */
export async function runTavernReleaseLiveOrchestrator({
  profile = DEFAULT_TAVERN_RELEASE_PROFILE,
  prerequisites = checkTavernReleasePrerequisites,
  runNarrative = runNarrativeProcess,
  temporaryReportPath,
} = {}) {
  let prerequisiteReport;
  try {
    prerequisiteReport = await prerequisites({ profile });
  } catch {
    prerequisiteReport = { verdict: "blocked", checks: [{ id: "checker_execution", status: "blocked" }] };
  }
  const prerequisite = prerequisiteSummary(prerequisiteReport);
  const base = {
    gate: ORCHESTRATOR_SCHEMA,
    profile,
    plannedRunKinds: [...NARRATIVE_RUN_PLAN],
    claims: {
      requiredMustFlowsExecuted: false,
      fullReleaseClaim: false,
    },
    prerequisite,
    releaseGate: {
      verdict: "inconclusive",
      blockerIds: ["operator_record", MOUNTED_PROFILE_MAPPING_BLOCKER.id],
    },
  };
  if (prerequisite.verdict !== "passed") {
    return { ...base, verdict: "blocked", runs: [], reasonCode: "automated_prerequisite_not_passed" };
  }

  let temporaryRoot;
  let reportRoot = temporaryReportPath;
  if (reportRoot === undefined) {
    temporaryRoot = await mkdtemp(join(tmpdir(), "gamebuddy-tavern-release-live-"));
    reportRoot = (role) => join(temporaryRoot, `${role}.json`);
  }
  try {
    const runs = [];
    for (const role of NARRATIVE_RUN_PLAN) {
      try {
        const value = await runNarrative({ role, profile, reportPath: reportRoot(role) });
        runs.push(contentFreeNarrativeSummary(role, value));
      } catch {
        runs.push({ role, state: "blocked", reasonCode: "narrative_runner_internal_error" });
      }
    }
    return {
      ...base,
      verdict: "inconclusive",
      runs,
      reasonCode: "mounted_profile_operation_evidence_unavailable",
    };
  } finally {
    if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function parseArguments(input) {
  if (input[0] === "--record" && input[1]) {
    let profile = DEFAULT_TAVERN_RELEASE_PROFILE;
    let recordPath = input[1];
    let mountedProfilePath;
    let mappingPath;
    for (let index = 2; index < input.length; index += 2) {
      const flag = input[index];
      const value = input[index + 1];
      if (!["--profile", "--mounted-profile", "--operation-mapping"].includes(flag) || typeof value !== "string" || value.length === 0)
        throw new Error("usage: node tools/run-tavern-release-live-gate.mjs --record <record.json> [--profile <profile>] [--mounted-profile <profile.json>] [--operation-mapping <mapping.json>]");
      if (flag === "--profile") profile = value;
      else if (flag === "--mounted-profile") mountedProfilePath = resolve(value);
      else mappingPath = resolve(value);
    }
    return Object.freeze({ mode: "record", path: recordPath, profile, mountedProfilePath, mappingPath });
  }
  if (input[0] === "--orchestrate") {
    let profile = DEFAULT_TAVERN_RELEASE_PROFILE;
    let profileProvided = false;
    let reportPath;
    for (let index = 1; index < input.length; index += 2) {
      const flag = input[index];
      const value = input[index + 1];
      if ((flag !== "--profile" && flag !== "--report") || typeof value !== "string" || value.length === 0) {
        throw new Error(
          "usage: node tools/run-tavern-release-live-gate.mjs --record <privacy-safe-record.json> | --orchestrate [--profile <profile>] [--report <path>]",
        );
      }
      if (flag === "--profile") {
        if (profileProvided) throw new Error("duplicate_profile");
        profileProvided = true;
        profile = value;
      } else {
        if (reportPath !== undefined) throw new Error("duplicate_report");
        reportPath = resolve(value);
      }
    }
    return Object.freeze({ mode: "orchestrate", profile, reportPath });
  }
  throw new Error(
    "usage: node tools/run-tavern-release-live-gate.mjs --record <privacy-safe-record.json> | --orchestrate [--profile <profile>] [--report <path>]",
  );
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_.mode === "record") {
    const record = JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "..", arguments_.path), "utf8"));
    const mountedProfile = arguments_.mountedProfilePath === undefined ? undefined : JSON.parse(await readFile(arguments_.mountedProfilePath, "utf8"));
    const operationEvidenceMapping = arguments_.mappingPath === undefined ? undefined : JSON.parse(await readFile(arguments_.mappingPath, "utf8"));
    const report = await runTavernReleaseLiveGate({ record, profile: arguments_.profile, mountedProfile, operationEvidenceMapping });
    console.log(JSON.stringify(report, null, 2));
    if (report.verdict !== "passed") process.exitCode = 2;
    return;
  }

  const reportTarget = await prepareReportTarget(arguments_.reportPath);
  const report = await runTavernReleaseLiveOrchestrator({ profile: arguments_.profile });
  await writeReport(reportTarget, report);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 2;
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
