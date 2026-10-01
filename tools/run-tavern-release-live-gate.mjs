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
import {
  MOUNTED_TAVERN_MANAGEMENT_OPERATION_IDS,
  readMountedTavernManagementProfile,
} from "./lib/tavern-mounted-operation-vocabulary.mjs";

export { CHAT_TAVERN_LIVE_PROFILE, DEFAULT_TAVERN_RELEASE_PROFILE };

const TAVERN_LIVE_GATE = "tavern_release_live_gate/v1";
const ORCHESTRATOR_SCHEMA = "tavern_release_live_orchestrator/v1";
const ORCHESTRATOR_USAGE =
  "usage: node tools/run-tavern-release-live-gate.mjs --orchestrate [--profile <profile>] [--report <path>] [--mounted-profile <profile.json>] [--operation-evidence-mapping <mapping.json>]";

// Hex-only tokens deliberately make this evidence incapable of carrying dialogue or labels.
const OPAQUE_ID = /^[a-f0-9]{16,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const NARRATIVE_RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), "run-tavern-narrative-gate.mjs");
export const NARRATIVE_RUN_PLAN = Object.freeze(["main", "failure", "recovery"]);
export const MOUNTED_PROFILE_MAPPING_BLOCKER = Object.freeze({
  id: "mounted_profile_operation_evidence",
  status: "blocked",
  detail: "mounted_composed_tavern_profile_operation_to_evidence_mapping_missing_or_invalid",
});
export const MOUNTED_PROFILE_OPERATION_EVIDENCE_SCHEMA_VERSION = 1;
/**
 * Release-scope claims this gate deliberately never mints. It drives one real
 * Chat turn per planned run and maps mounted management operations; it executes
 * no release-profile `must` flow and verifies no Windows production artifact,
 * security or bundled-runtime prerequisite. A `passed` verdict is therefore a
 * Chat/Tavern live claim only and must never widen into these claims.
 */
const RELEASE_SCOPE_CLAIMS = Object.freeze({ requiredMustFlowsExecuted: false, fullReleaseClaim: false });
// Release tiers that claim the mounted Tavern management surface, and therefore
// must declare every operation that surface serves.
const MOUNTED_TIER_RELEASE_TIERS = new Set(["tavern_management"]);
// A planned run is genuine live evidence only when the runner reported its own
// pass together with the production artifact identity and every assertion that
// pass is derived from. A bare `state: "passed"` is not evidence.
const RUN_EVIDENCE_ASSERTIONS = Object.freeze([
  "authenticatedReferenceChatApi",
  "realDialogueTurnAttempted",
  "providerRuntimeSessionBound",
  "providerPreSendSerialized",
  "realTurnOutcomeObserved",
]);
// The runner also reports an honest negative; it is NOT a pass-gating assertion, but
// dropping it presented a perfect 5/5 and hid the runner's own statement that
// provider acceptance / a semantic answer was not proven. `false` is carried, not
// filtered.
const RUN_DISCLOSURE_ASSERTIONS = Object.freeze(["providerAcceptedOrSemanticAnswer"]);

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
  // Every settings surface the mounted tavern management profile declares is
  // served through the route of the same id. The connection surface and its
  // siblings are listed explicitly so a profile that declares a settings
  // operation the gate does not know still fails membership rather than
  // passing unnoticed.
  "settings.voice.read": "settings.voice.read",
  "settings.voice.consent": "settings.voice.consent",
  "settings.voice.devices": "settings.voice.devices",
  ...Object.fromEntries(
    MOUNTED_TAVERN_MANAGEMENT_OPERATION_IDS.filter((id) => id.startsWith("settings.")).map((id) => [id, id]),
  ),
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
  // The settings surfaces are part of the mounted tavern management profile
  // (host/src/tavern/browser-contract/index.ts). Without them here the gate
  // rejected the real production profile it is meant to validate.
  "settings.voice.read",
  "settings.voice.consent",
  "settings.voice.devices",
  ...MOUNTED_TAVERN_MANAGEMENT_OPERATION_IDS.filter((id) => id.startsWith("settings.")),
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
// The only optional key the mapping may carry. `tools/record-tavern-ui-operation-evidence.mjs`
// stamps it on the mapping it exports, and its value is fixed: it labels the
// provenance of the evidence and never adds capability.
const AUTOMATION_EVIDENCE_KIND = "automation_evidence";

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

function omitEvidenceKind(mapping) {
  return Object.fromEntries(Object.entries(mapping).filter(([key]) => key !== "evidence_kind"));
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

/**
 * Fingerprint the operation-evidence mapping so a verdict can name the exact input
 * it was decided on.
 *
 * The audit of run-01..run-04 found the `passed` verdict could not be re-derived
 * from the artifact set: the mapping file is a caller-supplied input and was NOT in
 * the recorded data, so a reader could only take `mappedOperationIds` on trust. The
 * digest binds the report to the input without copying it, and it is recorded for
 * every verdict (not only `passed`) so a later re-run can be compared against the
 * exact bytes that produced the earlier decision.
 *
 * Key order is normalised: JSON.stringify preserves insertion order, and a mapping
 * that differs only in key order is the same mapping. Array order is preserved - it
 * is part of the caller's declaration.
 */
function canonicalMappingDigest(mapping) {
  if (!plainRecord(mapping)) return undefined;
  const sortedEntries = Reflect.ownKeys(mapping)
    .sort()
    .map((key) => [key, mapping[key]]);
  return createHash("sha256").update(JSON.stringify(sortedEntries), "utf8").digest("hex");
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
 * The mounted operation evidence carries a redacted projection of the exact
 * mounted profile and an independently supplied operation-to-evidence map.
 * Evidence is opaque by construction: this contract never accepts operation
 * labels, UI text, URLs, prompts, or any other content as evidence.
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

  const evidenceKindValid =
    operationEvidenceMapping.evidence_kind === undefined ||
    operationEvidenceMapping.evidence_kind === AUTOMATION_EVIDENCE_KIND;
  check(
    evidenceKindValid,
    "mounted_profile_operation_evidence_kind",
    "mounted_composed_tavern_profile_operation_to_evidence_mapping_evidence_kind_invalid",
    checks,
  );
  const mapping = evidenceKindValid ? omitEvidenceKind(operationEvidenceMapping) : operationEvidenceMapping;

  check(
    mapping.schema_version === MOUNTED_PROFILE_OPERATION_EVIDENCE_SCHEMA_VERSION,
    "mounted_profile_operation_evidence_schema",
    "mounted_composed_tavern_profile_operation_to_evidence_mapping_schema_invalid",
    checks,
  );
  const exactIdentity = Object.hasOwn(mapping, "profile");
  const hashIdentity = Object.hasOwn(mapping, "profile_hash");
  const idIdentity = Object.hasOwn(mapping, "profile_id");
  // The identity is carried either by the exact profile object or by the
  // canonical hash pair. `profile_id` is part of the hash pair, not a third
  // alternative, so it may not stand alone.
  check(
    (exactIdentity ? 1 : 0) + (hashIdentity ? 1 : 0) === 1 && !(idIdentity && !hashIdentity),
    "mounted_profile_operation_evidence_identity_shape",
    "mounted_composed_tavern_profile_operation_to_evidence_mapping_identity_invalid",
    checks,
  );
  if (exactIdentity) {
    check(
      exactKeys(mapping, PROFILE_IDENTITY_MAPPING_KEYS) && mapping.profile === mountedProfile,
      "mounted_profile_operation_evidence_profile",
      "mounted_composed_tavern_profile_operation_to_evidence_mapping_profile_mismatch",
      checks,
    );
  } else if (hashIdentity) {
    check(
      (idIdentity &&
        (exactKeys(mapping, PROFILE_ID_HASH_MAPPING_KEYS) ||
          exactKeys(mapping, PROFILE_ID_HASH_WITHOUT_TIER_MAPPING_KEYS)) &&
        typeof mapping.profile_id === "string" &&
        typeof mapping.profile_hash === "string" &&
        HASH.test(mapping.profile_hash) &&
        profileValid &&
        mapping.profile_id === mountedProfile?.profileId &&
        (mapping.release_tier === undefined || mapping.release_tier === mountedProfile?.releaseTier) &&
        mapping.profile_hash === canonicalProfileHash(mountedProfile)),
      "mounted_profile_operation_evidence_profile",
      "mounted_composed_tavern_profile_operation_to_evidence_mapping_profile_mismatch",
      checks,
    );
  }

  const operations = mapping.operations;
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
  // Completeness: every operation the mounted profile declares must carry its
  // own evidence entry. The mapping is the proof that the whole mounted surface
  // was exercised for real, so a mapping that covers a subset of the profile is
  // not a weaker verdict - it is a false one. run-01..run-05 all passed this
  // gate against a mapping of five operations while the profile declared more;
  // the unreported operations could have been anything, including nothing.
  for (const operationId of declaredOperations) {
    check(
      Object.hasOwn(operations, operationId),
      "mounted_profile_operation_evidence_completeness",
      "mounted_composed_tavern_profile_operation_to_evidence_mapping_incomplete",
      checks,
    );
  }
  // The other half of the same constraint, and deliberately an EQUALITY rather
  // than another local property check.
  //
  // Completeness above proves the mapping covers the profile it was handed, but
  // the caller supplies both sides of that comparison. Two shapes therefore
  // passed with `verdict: passed`:
  //   - a tavern_management profile declaring one operation with a one-operation
  //     mapping (the run-05 false green, by shrinking the profile);
  //   - a profile with the right tier and the right operation COUNT but a forged
  //     identity - a profileId the Host never declares, no bootstrap/state.read/
  //     draft.read routes, no memory navigation item (round-2 audit).
  // Charging the tier, the count or the route set would just move the forgery to
  // whichever property was not yet checked. The authority is the profile the
  // composition owner actually mounts, which
  // `readMountedTavernManagementProfile()` derives from that source, so the
  // supplied profile must EQUAL it. A chat_core profile legitimately describes a
  // different (smaller) surface and is exempt.
  if (MOUNTED_TIER_RELEASE_TIERS.has(mountedProfile?.releaseTier)) {
    const mounted = readMountedTavernManagementProfile();
    for (const field of ["profileId", "releaseTier", "routeIds", "operationIds", "navigationItemIds"]) {
      const supplied = mountedProfile?.[field];
      const authority = mounted[field];
      check(
        Array.isArray(authority)
          ? Array.isArray(supplied) && supplied.length === authority.length && authority.every((id, i) => supplied[i] === id)
          : supplied === authority,
        "mounted_profile_operation_evidence_mounted_surface",
        "mounted_composed_tavern_profile_operation_to_evidence_mapping_profile_not_the_mounted_profile",
        checks,
      );
    }
  }

  return {
    valid: profileValid && checks.length === 0,
    checks,
    // The keys of a caller-supplied mapping are untrusted until every one has
    // passed membership validation. This report is written to disk and printed,
    // and its content guard only screens eight fixed phrases, so an unvalidated
    // key could smuggle arbitrary text into the evidence file. Project them only
    // once the mapping is valid; otherwise report none.
    mappedOperationIds: profileValid && checks.length === 0 ? mappedOperationIds : [],
    // The mapping's identity and fingerprint, so a verdict names the exact input it
    // was decided on. The audit of run-01..run-04 found the `passed` verdict could not
    // be re-derived from the recorded artifacts, because the mapping is a
    // caller-supplied file that was not among them - a reader could only take
    // `mappedOperationIds` on trust. `profileHash` is recomputed from the mounted
    // profile (checkable without the mapping file); `mappingDigest` binds the whole
    // mapping without copying it. Both are content-free.
    identity:
      profileValid && checks.length === 0
        ? Object.freeze({
            profileId: mountedProfile?.profileId,
            releaseTier: mountedProfile?.releaseTier,
            profileHash: canonicalProfileHash(mountedProfile),
            mappingSchemaVersion: mapping.schema_version,
            mappingDigest: canonicalMappingDigest(operationEvidenceMapping),
          })
        : undefined,
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
  // Idempotent: an already-normalized run summary keeps its runner run ID.
  const runId = typeof value.runId === "string" ? value.runId : value.runnerRunId;
  if (typeof runId === "string" && OPAQUE_ID.test(runId)) summary.runnerRunId = runId;
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
    summary.assertions = Object.fromEntries(
      RUN_EVIDENCE_ASSERTIONS.filter((key) => typeof value.assertions[key] === "boolean").map((key) => [
        key,
        value.assertions[key],
      ]),
    );
  }
  // The runner's non-passing disclosures ride along so a reader sees them. They
  // never gate the verdict - only RUN_EVIDENCE_ASSERTIONS do that - but a report
  // that showed only the passing half was misrepresenting its own evidence.
  //
  // Read them from either spelling. The real orchestrator normalizes twice -
  // `runNarrativeProcess` returns an already-normalized summary and the
  // orchestrator normalizes that value again - and the first pass stores these
  // under `disclosures`, not under `assertions`. Reading only `assertions`
  // silently emptied `disclosures` on the second pass, which is how run-03..
  // run-06 came to show a clean five-of-five while the runner had reported
  // `providerAcceptedOrSemanticAnswer: false` (audit finding on run-06).
  const disclosureSource =
    value.disclosures && typeof value.disclosures === "object" && !Array.isArray(value.disclosures)
      ? value.disclosures
      : value.assertions;
  if (disclosureSource && typeof disclosureSource === "object" && !Array.isArray(disclosureSource)) {
    summary.disclosures = Object.fromEntries(
      RUN_DISCLOSURE_ASSERTIONS.filter((key) => typeof disclosureSource[key] === "boolean").map((key) => [
        key,
        disclosureSource[key],
      ]),
    );
  }
  // Same idempotence rule for the turn status: the normalized spelling is
  // `turn`, the runner's raw spelling is `statuses.turn`.
  const turn =
    typeof value.turn === "string"
      ? value.turn
      : value.statuses && typeof value.statuses === "object" && typeof value.statuses.turn === "string"
        ? value.statuses.turn
        : undefined;
  if (turn !== undefined) summary.turn = safeCode(turn, "unavailable");
  return summary;
}

function genuineRunEvidence(summary) {
  return (
    summary?.state === "passed" &&
    summary.artifact?.generation !== undefined &&
    summary.artifact?.inventoryDigest !== undefined &&
    RUN_EVIDENCE_ASSERTIONS.every((key) => summary.assertions?.[key] === true)
  );
}

async function runNarrativeProcess({ role, reportPath, spawnProcess = spawn } = {}) {
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
        env: { ...process.env },
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
 * The single Chat/Tavern release verdict, derived from evidence and never
 * asserted. A `passed` verdict requires all three of:
 *
 * - the automated prerequisites genuinely pass for this profile;
 * - every planned real narrative run carries its own production artifact
 *   identity and an observed real embedded provider turn;
 * - the mounted ComposedTavernProfile operation-to-evidence mapping validates.
 *
 * No operator record participates. A caller-supplied record or observation list
 * is ignored, and no field of this report can carry dialogue, prompts,
 * credentials, UI text or paths: evidence is opaque by construction.
 */
export async function runTavernReleaseLiveGate({
  profile = DEFAULT_TAVERN_RELEASE_PROFILE,
  mountedProfile,
  operationEvidenceMapping,
  runs,
  prerequisites = checkTavernReleasePrerequisites,
} = {}) {
  const checks = [];
  const mapping = validateMountedProfileOperationEvidence({ mountedProfile, operationEvidenceMapping });
  if (!mapping.valid) checks.push(...mapping.checks, MOUNTED_PROFILE_MAPPING_BLOCKER);

  let prerequisiteReport;
  try {
    prerequisiteReport = await prerequisites({ profile });
  } catch {
    prerequisiteReport = undefined;
  }
  const prerequisitesPassed = prerequisiteReport?.verdict === "passed";
  if (!prerequisitesPassed) {
    checks.push({
      id: "prerequisite_verdict",
      status: "blocked",
      detail:
        prerequisiteReport === undefined ? "automated_prerequisite_unavailable" : "automated_prerequisite_not_passed",
    });
  }

  const runEvidence = NARRATIVE_RUN_PLAN.map((role) => {
    const supplied = Array.isArray(runs) ? runs.find((run) => run?.role === role) : undefined;
    return supplied === undefined
      ? { role, state: "blocked", reasonCode: "narrative_run_not_executed" }
      : contentFreeNarrativeSummary(role, supplied);
  });
  const runsComplete = runEvidence.every(genuineRunEvidence);
  // When the prerequisites already fail, that blocker is the whole reason: no
  // run was supposed to have been attempted, and reporting a run blocker would
  // misattribute the cause.
  if (prerequisitesPassed && !runsComplete) {
    checks.push({ id: "narrative_runs", status: "blocked", detail: "narrative_run_evidence_incomplete" });
  }

  const verdict = !prerequisitesPassed ? "blocked" : runsComplete && mapping.valid ? "passed" : "inconclusive";

  return {
    gate: TAVERN_LIVE_GATE,
    profile,
    verdict,
    ...(verdict === "passed"
      ? {}
      : {
          reasonCode: !prerequisitesPassed
            ? checks.find((check) => check.id === "prerequisite_verdict").detail
            : !runsComplete
              ? "narrative_run_evidence_incomplete"
              : "mounted_profile_operation_evidence_unavailable",
        }),
    claims: RELEASE_SCOPE_CLAIMS,
    checks,
    prerequisite: prerequisiteReport?.verdict ?? "unavailable",
    // Recorded for EVERY verdict, not only `passed`: a reader must be able to bind any
    // decision to the exact inputs behind it. `undefined` means the mapping never
    // reached a valid state, which is itself information.
    ...(mapping.identity === undefined ? {} : { operationEvidence: mapping.identity }),
    mappedOperationIds: mapping.mappedOperationIds,
    runEvidence,
    blockerIds: [...new Set(checks.map((check) => check.id))],
  };
}

/**
 * Drives the planned real-run evidence slice and delegates the verdict to the
 * single release gate above. The run labels describe attempts only; they never
 * assert that a failure occurred or that recovery resumed a thread. No narrative
 * work runs once an automated prerequisite is failing: `blocked` is never
 * papered over with attempts.
 */
export async function runTavernReleaseLiveOrchestrator({
  profile = DEFAULT_TAVERN_RELEASE_PROFILE,
  mountedProfile,
  operationEvidenceMapping,
  prerequisites = checkTavernReleasePrerequisites,
  runNarrative = runNarrativeProcess,
  temporaryReportPath,
} = {}) {
  // Verdict-critical INPUTS are validated before any live run. The mapping check is a
  // pure function over two caller-supplied files with zero product interaction, and
  // with `mapping.valid === false` a `passed` verdict is unreachable at :496 - so
  // launching three production-grade live sessions to discover a missing input file
  // burns real turns for a fact that was knowable at invocation time. Measured on the
  // audited artifacts: 9 of 12 live turns belonged to attempts whose verdict was
  // already impossible when they started.
  const inputChecks = validateMountedProfileOperationEvidence({ mountedProfile, operationEvidenceMapping });
  if (inputChecks.checks.length > 0) {
    return {
      gate: ORCHESTRATOR_SCHEMA,
      profile,
      plannedRunKinds: [...NARRATIVE_RUN_PLAN],
      runKindSemantics: "attempt_labels_not_exercised_distinctions",
      prerequisite: { verdict: "not_attempted", checks: [{ id: "verdict_inputs", status: "blocked" }] },
      runs: [],
      mappedOperationIds: [],
      verdict: "blocked",
      reasonCode: "verdict_inputs_incomplete",
      blockerIds: inputChecks.checks.map((check) => check.id),
      claims: RELEASE_SCOPE_CLAIMS,
    };
  }

  let prerequisiteReport;
  try {
    prerequisiteReport = await prerequisites({ profile });
  } catch {
    prerequisiteReport = undefined;
  }
  const prerequisite =
    prerequisiteReport === undefined
      ? { verdict: "blocked", checks: [{ id: "checker_execution", status: "blocked" }] }
      : prerequisiteSummary(prerequisiteReport);

  const runs = [];
  let temporaryRoot;
  let reportRoot = temporaryReportPath;
  try {
    if (prerequisite.verdict === "passed") {
      if (reportRoot === undefined) {
        temporaryRoot = await mkdtemp(join(tmpdir(), "gamebuddy-tavern-release-live-"));
        reportRoot = (role) => join(temporaryRoot, `${role}.json`);
      }
      for (const role of NARRATIVE_RUN_PLAN) {
        try {
          runs.push(contentFreeNarrativeSummary(role, await runNarrative({ role, profile, reportPath: reportRoot(role) })));
        } catch {
          runs.push({ role, state: "blocked", reasonCode: "narrative_runner_internal_error" });
        }
      }
    }
  } finally {
    if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
  }

  const gate = await runTavernReleaseLiveGate({
    profile,
    mountedProfile,
    operationEvidenceMapping,
    runs,
    // This invocation's prerequisite report is already authoritative. The gate
    // must not re-execute it: the checker builds and runs real test suites.
    prerequisites: async () => prerequisiteReport,
  });

  // A narrative run never receives its role: `runNarrativeProcess` spawns
  // [script, "--report", path] and the child accepts only `--report`. So `main`,
  // `failure` and `recovery` are three repetitions of the SAME happy path, and the
  // artifact must not imply otherwise. The planned kinds are recorded as unexercised
  // distinctions rather than as evidence that failure/recovery behaviour occurred.
  return {
    gate: ORCHESTRATOR_SCHEMA,
    profile,
    plannedRunKinds: [...NARRATIVE_RUN_PLAN],
    // Stated in the artifact, not only in a code comment, because the artifact is
    // what a reader has.
    runKindSemantics: "attempt_labels_not_exercised_distinctions",
    prerequisite,
    runs,
    // The exact mapping this decision rests on, carried through from the gate so the
    // artifact alone can name it. Without this the recorded `passed` verdict could not
    // be tied to any input (audit finding on run-04).
    ...(gate.operationEvidence === undefined ? {} : { operationEvidence: gate.operationEvidence }),
    mappedOperationIds: gate.mappedOperationIds,
    verdict: gate.verdict,
    blockerIds: gate.blockerIds,
    ...(gate.reasonCode === undefined ? {} : { reasonCode: gate.reasonCode }),
    claims: gate.claims,
  };
}

export function parseArguments(input) {
  if (input[0] !== "--orchestrate") throw new Error(ORCHESTRATOR_USAGE);
  let profile = DEFAULT_TAVERN_RELEASE_PROFILE;
  let reportPath;
  let mountedProfilePath;
  let operationEvidenceMappingPath;
  const seen = new Set(["--orchestrate"]);
  for (let index = 1; index < input.length; index += 2) {
    const flag = input[index];
    const value = input[index + 1];
    if (
      !["--profile", "--report", "--mounted-profile", "--operation-evidence-mapping"].includes(flag) ||
      typeof value !== "string" ||
      value.length === 0
    ) {
      throw new Error(ORCHESTRATOR_USAGE);
    }
    if (seen.has(flag)) throw new Error(`duplicate_${flag.slice(2).replaceAll("-", "_")}`);
    seen.add(flag);
    if (flag === "--profile") profile = value;
    else if (flag === "--report") reportPath = resolve(value);
    else if (flag === "--mounted-profile") mountedProfilePath = resolve(value);
    else operationEvidenceMappingPath = resolve(value);
  }
  return Object.freeze({ profile, reportPath, mountedProfilePath, operationEvidenceMappingPath });
}

async function readOptionalJson(path) {
  return path === undefined ? undefined : JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const reportTarget = await prepareReportTarget(arguments_.reportPath);
  const mountedProfile = await readOptionalJson(arguments_.mountedProfilePath);
  const operationEvidenceMapping = await readOptionalJson(arguments_.operationEvidenceMappingPath);
  const report = await runTavernReleaseLiveOrchestrator({
    profile: arguments_.profile,
    mountedProfile,
    operationEvidenceMapping,
  });
  await writeReport(reportTarget, report);
  console.log(JSON.stringify(report, null, 2));
  if (report.verdict !== "passed") process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // A parse or read failure message can echo file content or an absolute
    // path, so only a bounded reason code ever reaches the console.
    console.log(
      JSON.stringify(
        {
          gate: TAVERN_LIVE_GATE,
          verdict: "inconclusive",
          reasonCode: safeCode(
            error instanceof Error ? error.message : error,
            "tavern_release_live_gate_runner_failed",
          ),
          checks: [{ id: "runner_execution", status: "blocked", detail: "tavern_release_live_gate_runner_failed" }],
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
  });
}
