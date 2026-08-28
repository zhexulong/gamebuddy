/**
 * Production static authority slice of the package-owned static verifier.
 *
 * This module freezes the versioned target-publication manifest and the
 * production verification report. The manifest is the explicit, versioned
 * producer handoff: it names the exact artifact root and the paired
 * GameBuddy.Stardew.dll / GameBuddy.Stardew.Core.dll and both compiled
 * projection contracts (plus runtime configurations) with expected
 * SHA-256 digests, assembly/contract identity fields, and same-build
 * provenance. The report records what the production boundary verified and
 * never claims live or release evidence.
 *
 * The committed manifests under `production/manifests/` are package-owned
 * self-test fixtures only; production manifests are published by the
 * target-version build gate (see `production/README.md`).
 */

export const TARGET_PUBLICATION_MANIFEST_SCHEMA = "gamebuddy-stardew-target-publication-manifest/v1";
export const PRODUCTION_REPORT_SCHEMA = "gamebuddy-stardew-static-verifier-production-report/v1";
export const PRODUCTION_VERIFIER_ID = "gamebuddy.stardew.action-development.static-verifier.production@v1";
export const TARGET_PUBLICATION_SCOPE = "target-publication";

export const BLOCKED_MISSING_TARGET_PUBLICATION_MANIFEST = "blocked_missing_target_publication_manifest";
export const BLOCKED_MISSING_TARGET_PUBLICATION_ARTIFACTS = "blocked_missing_target_publication_artifacts";
export const FAILED_TARGET_PUBLICATION_MANIFEST_MALFORMED = "failed_target_publication_manifest_malformed";
export const FAILED_TARGET_PUBLICATION_MANIFEST_SCHEMA = "failed_target_publication_manifest_schema";
export const FAILED_TARGET_PUBLICATION_ARTIFACT_MISSING_PARTIAL = "failed_target_publication_artifact_missing_partial";
export const FAILED_TARGET_PUBLICATION_ARTIFACT_UNUSABLE = "failed_target_publication_artifact_unusable";
export const FAILED_TARGET_PUBLICATION_NON_SIBLING = "failed_target_publication_non_sibling";
export const FAILED_TARGET_PUBLICATION_DIGEST_MISMATCH = "failed_target_publication_digest_mismatch";
export const FAILED_TARGET_PUBLICATION_DIGEST_UNREADABLE = "failed_target_publication_digest_unreadable";
export const FAILED_TARGET_PUBLICATION_IDENTITY_MISMATCH = "failed_target_publication_identity_mismatch";
export const FAILED_TARGET_PUBLICATION_PROVENANCE_MISMATCH = "failed_target_publication_provenance_mismatch";
export const FAILED_TARGET_PUBLICATION_CONTRACT_SPAWN = "failed_target_publication_contract_spawn";
export const FAILED_TARGET_PUBLICATION_CONTRACT_NONZERO = "failed_target_publication_contract_nonzero";
export const FAILED_TARGET_PUBLICATION_CONTRACT_OUTPUT = "failed_target_publication_contract_output";
export const FAILED_TARGET_PUBLICATION_CONTRACT_TIMEOUT = "failed_target_publication_contract_timeout";
export const TARGET_PUBLICATION_STATIC_VERIFIED = "target_publication_static_verified";

/**
 * Exact paired target-publication identity: Mod, Core, and the compiled
 * capability-publication contract are one frozen three-file closure.
 *
 * The assembly/contract identity values mirror the compiled contract
 * entrypoint exactly: `FarmhandCapabilityPublicationProjectionMetadata.cs`
 * declares `ModAssemblyName = "GameBuddy.Stardew"` and
 * `CoreAssemblyName = "GameBuddy.Stardew.Core"`, and
 * `FarmhandCapabilityPublicationProjection.Contract.csproj` declares the
 * contract `AssemblyName = "FarmhandCapabilityPublicationProjection.Contract"`.
 *
 * The verifier never discovers assemblies, infers a game installation, reads
 * project/source files, or accepts an independently supplied alternate Core
 * path. The three assemblies plus the contract runtime configuration are an
 * exact same-directory sibling closure under one artifact root; a partial,
 * replaced, or non-sibling closure is a failed
 * closure, not a pass.
 */
export const PUBLICATION_ARTIFACTS = Object.freeze([
  Object.freeze({
    id: "gamebuddy-stardew-mod",
    role: "mod",
    relativePath: "GameBuddy.Stardew.dll",
    assemblyIdentity: "GameBuddy.Stardew",
    required: true,
  }),
  Object.freeze({
    id: "gamebuddy-stardew-core",
    role: "core",
    relativePath: "GameBuddy.Stardew.Core.dll",
    assemblyIdentity: "GameBuddy.Stardew.Core",
    required: true,
  }),
  Object.freeze({
    id: "capability-publication-contract",
    role: "contract",
    relativePath: "FarmhandCapabilityPublicationProjection.Contract.dll",
    assemblyIdentity: "FarmhandCapabilityPublicationProjection.Contract",
    required: true,
  }),
  Object.freeze({
    id: "capability-publication-contract-runtime",
    role: "support",
    relativePath: "FarmhandCapabilityPublicationProjection.Contract.runtimeconfig.json",
    assemblyIdentity: "Microsoft.NETCore.App@6.0.0",
    required: true,
  }),
  Object.freeze({
    id: "portfolio-mine-elevator-projection-contract",
    role: "contract",
    relativePath: "PortfolioMineElevatorProjection.Contract.dll",
    assemblyIdentity: "PortfolioMineElevatorProjection.Contract",
    required: true,
  }),
  Object.freeze({
    id: "portfolio-mine-elevator-projection-contract-runtime",
    role: "support",
    relativePath: "PortfolioMineElevatorProjection.Contract.runtimeconfig.json",
    assemblyIdentity: "Microsoft.NETCore.App@6.0.0",
    required: true,
  }),
]);

export const DIGEST_REQUIREMENTS = Object.freeze(
  PUBLICATION_ARTIFACTS.map((artifact) => Object.freeze({ id: artifact.id, relativePath: artifact.relativePath })),
);

export const IDENTITY_REQUIREMENTS = Object.freeze(
  PUBLICATION_ARTIFACTS.map((artifact) =>
    Object.freeze({ id: artifact.id, role: artifact.role, assemblyIdentity: artifact.assemblyIdentity }),
  ),
);

export const PRODUCTION_CHECKS = Object.freeze([
  Object.freeze({ id: "target-publication-manifest", kind: "target_publication_manifest_admission", required: true }),
  Object.freeze({ id: "target-publication-artifact-closure", kind: "target_publication_artifact_closure", required: true }),
  Object.freeze({ id: "target-publication-digest", kind: "target_publication_artifact_digest", required: true }),
  Object.freeze({ id: "target-publication-identity", kind: "target_publication_identity_provenance", required: true }),
  Object.freeze({ id: "target-publication-contract", kind: "target_publication_contract_execution", required: true }),
]);

export const PRODUCTION_INTEGRATION_REQUIREMENTS = Object.freeze([
  "the package portfolio consumes production admission while preserving passed, failed, and named blocked evidence",
  "supply the independently published target-publication manifest and artifact closure from the target-version build gate with preserved provenance",
  "the production report is static authority evidence only and never claims live or release evidence",
]);

const REASON_CODES_BY_STATE = Object.freeze({
  passed: Object.freeze([TARGET_PUBLICATION_STATIC_VERIFIED]),
  blocked: Object.freeze([BLOCKED_MISSING_TARGET_PUBLICATION_MANIFEST, BLOCKED_MISSING_TARGET_PUBLICATION_ARTIFACTS]),
  failed: Object.freeze([
    FAILED_TARGET_PUBLICATION_MANIFEST_MALFORMED,
    FAILED_TARGET_PUBLICATION_MANIFEST_SCHEMA,
    FAILED_TARGET_PUBLICATION_ARTIFACT_MISSING_PARTIAL,
    FAILED_TARGET_PUBLICATION_ARTIFACT_UNUSABLE,
    FAILED_TARGET_PUBLICATION_NON_SIBLING,
    FAILED_TARGET_PUBLICATION_DIGEST_MISMATCH,
    FAILED_TARGET_PUBLICATION_DIGEST_UNREADABLE,
    FAILED_TARGET_PUBLICATION_IDENTITY_MISMATCH,
    FAILED_TARGET_PUBLICATION_PROVENANCE_MISMATCH,
    FAILED_TARGET_PUBLICATION_CONTRACT_SPAWN,
  FAILED_TARGET_PUBLICATION_CONTRACT_NONZERO,
  FAILED_TARGET_PUBLICATION_CONTRACT_OUTPUT,
  FAILED_TARGET_PUBLICATION_CONTRACT_TIMEOUT,
  ]),
});

const REASON_CODES_BY_CHECK = Object.freeze({
  "target-publication-manifest": Object.freeze({
    passed: null,
    blocked: BLOCKED_MISSING_TARGET_PUBLICATION_MANIFEST,
    failed: Object.freeze([FAILED_TARGET_PUBLICATION_MANIFEST_MALFORMED, FAILED_TARGET_PUBLICATION_MANIFEST_SCHEMA]),
  }),
  "target-publication-artifact-closure": Object.freeze({
    passed: null,
    blocked: BLOCKED_MISSING_TARGET_PUBLICATION_ARTIFACTS,
    failed: Object.freeze([
      FAILED_TARGET_PUBLICATION_ARTIFACT_MISSING_PARTIAL,
      FAILED_TARGET_PUBLICATION_ARTIFACT_UNUSABLE,
      FAILED_TARGET_PUBLICATION_NON_SIBLING,
    ]),
  }),
  "target-publication-digest": Object.freeze({
    passed: null,
    failed: Object.freeze([FAILED_TARGET_PUBLICATION_DIGEST_MISMATCH, FAILED_TARGET_PUBLICATION_DIGEST_UNREADABLE]),
  }),
  "target-publication-identity": Object.freeze({
    passed: null,
    failed: Object.freeze([FAILED_TARGET_PUBLICATION_IDENTITY_MISMATCH, FAILED_TARGET_PUBLICATION_PROVENANCE_MISMATCH]),
  }),
  "target-publication-contract": Object.freeze({
    passed: null,
    failed: Object.freeze([
      FAILED_TARGET_PUBLICATION_CONTRACT_SPAWN,
  FAILED_TARGET_PUBLICATION_CONTRACT_NONZERO,
  FAILED_TARGET_PUBLICATION_CONTRACT_OUTPUT,
  FAILED_TARGET_PUBLICATION_CONTRACT_TIMEOUT,
    ]),
  }),
});

const MANIFEST_KEYS = new Set(["schema", "verifierId", "scope", "publicationId", "artifactRoot", "provenance", "artifacts"]);
const PROVENANCE_KEYS = new Set(["buildId"]);
const ARTIFACT_KEYS = new Set(["id", "role", "relativePath", "assemblyIdentity", "buildId", "sha256"]);
const REPORT_KEYS = new Set([
  "schema",
  "verifierId",
  "inputId",
  "publicationId",
  "scope",
  "artifactRoot",
  "state",
  "reasonCode",
  "summary",
  "artifacts",
  "digests",
  "identity",
  "contract",
  "checks",
  "integration",
]);
const REPORT_SUMMARY_KEYS = new Set(["passed", "failed", "blocked", "passDenominator"]);
const REPORT_ARTIFACT_SECTION_KEYS = new Set(["required", "present", "missing", "unusable"]);
const REPORT_DIGEST_SECTION_KEYS = new Set(["required", "verified", "mismatched", "unreadable"]);
const REPORT_IDENTITY_SECTION_KEYS = new Set(["required", "verified", "mismatched"]);
const REPORT_CONTRACT_KEYS = new Set(["executions"]);
const REPORT_CONTRACT_EXECUTION_KEYS = new Set(["id", "executed", "executable", "shell", "exitCode", "signal", "timeout", "args", "stderr", "successReceipt"]);
const REPORT_CHECK_KEYS = new Set(["id", "kind", "state", "reasonCode"]);
const REPORT_INTEGRATION_KEYS = new Set(["status", "required"]);
const REPORT_ARTIFACT_REQUIREMENT_KEYS = new Set(["id", "role", "relativePath", "assemblyIdentity", "required"]);
const REPORT_ENTRY_KEYS = new Set(["id", "relativePath"]);
const REPORT_UNUSABLE_KEYS = new Set(["id", "relativePath", "reason"]);
const REPORT_MISMATCHED_DIGEST_KEYS = new Set(["id", "relativePath", "expectedSha256", "computedSha256"]);
const REPORT_UNREADABLE_DIGEST_KEYS = new Set(["id", "relativePath"]);
const REPORT_VERIFIED_IDENTITY_KEYS = new Set(["id"]);
const REPORT_MISMATCHED_IDENTITY_KEYS = new Set(["id", "reason"]);

const ID = /^[a-z][a-z0-9-]{1,63}$/;
const INPUT_ID = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const PUBLICATION_ID = /^[a-z][a-z0-9-]{1,127}$/;
const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RELATIVE_PATH_LENGTH = 512;

export class TargetPublicationSchemaError extends Error {
  constructor(code) {
    super(`stardew_target_publication_${code}`);
    this.name = "TargetPublicationSchemaError";
    this.code = code;
  }
}

function fail(code) {
  throw new TargetPublicationSchemaError(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, code) {
  if (!isRecord(value) || Object.keys(value).length !== keys.size || Object.keys(value).some((key) => !keys.has(key))) {
    fail(code);
  }
}

/**
 * Package-anchored relative path or an absolute path. The relative form may
 * not escape its package tree (no `..`, no backslashes, no drive prefix);
 * the absolute form is accepted as-is because production artifact roots are
 * published outside this tree.
 */
function validateArtifactRoot(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RELATIVE_PATH_LENGTH || value.includes("\0")) {
    fail(code);
  }
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\")) return value;
  if (value.includes("\\")) fail(code);
  if (
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    value.split("/").some((segment) => !/^[A-Za-z0-9._ -]+$/.test(segment))
  ) {
    fail(code);
  }
  return value;
}

function validateRelativePath(value, code) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_RELATIVE_PATH_LENGTH ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    value.split("/").some((segment) => !/^[A-Za-z0-9._ -]+$/.test(segment))
  ) {
    fail(code);
  }
  return value;
}

function validateBuildId(value, code) {
  if (typeof value !== "string" || !BUILD_ID.test(value)) fail(code);
  return value;
}

function validateSha256(value, code) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function freeze(value) {
  return Object.freeze(value);
}

function freezeEntries(entries) {
  return freeze(entries.map((entry) => freeze({ ...entry })));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function partitionRequiredIds(present, missing, unusable, requiredIds, code) {
  const seen = new Set();
  for (const entries of [present, missing, unusable]) {
    for (const entry of entries) {
      if (!requiredIds.has(entry.id) || seen.has(entry.id)) fail(code);
      seen.add(entry.id);
    }
  }
  if (seen.size !== requiredIds.size) fail(code);
}

function validateIdentityEntries(entries, expected, keys, code) {
  if (!Array.isArray(entries) || entries.length !== expected.length) fail(code);
  for (let index = 0; index < expected.length; index++) {
    exactKeys(entries[index], keys, code);
    const entry = entries[index];
    const target = expected[index];
    for (const key of keys) {
      if (entry[key] !== target[key]) fail(code);
    }
  }
}

/**
 * Validate and normalize the versioned target-publication manifest.
 *
 * The artifact set is intentionally explicit and immutable: the exact Mod,
 * Core, and contract sibling closure. The manifest declares the expected
 * SHA-256 digests, assembly/contract identity, and same-build provenance;
 * the verifier checks those fields against the frozen identity table and
 * across artifacts, then executes the compiled contract.
 */
export function validateTargetPublicationManifest(input) {
  exactKeys(input, MANIFEST_KEYS, "manifest_shape");
  if (input.schema !== TARGET_PUBLICATION_MANIFEST_SCHEMA) fail("manifest_schema");
  if (input.verifierId !== PRODUCTION_VERIFIER_ID) fail("manifest_verifier");
  if (input.scope !== TARGET_PUBLICATION_SCOPE) fail("manifest_scope");
  if (typeof input.publicationId !== "string" || !PUBLICATION_ID.test(input.publicationId)) fail("manifest_publication_id");
  validateArtifactRoot(input.artifactRoot, "manifest_artifact_root");

  exactKeys(input.provenance, PROVENANCE_KEYS, "manifest_provenance_shape");
  validateBuildId(input.provenance.buildId, "manifest_provenance_build_id");

  if (!Array.isArray(input.artifacts) || input.artifacts.length !== PUBLICATION_ARTIFACTS.length) {
    fail("manifest_artifact_count");
  }
  const artifacts = input.artifacts.map((artifact, index) => {
    exactKeys(artifact, ARTIFACT_KEYS, "manifest_artifact_shape");
    const expected = PUBLICATION_ARTIFACTS[index];
    if (
      artifact.id !== expected.id ||
      artifact.role !== expected.role ||
      artifact.relativePath !== expected.relativePath ||
      artifact.required !== undefined ||
      !ID.test(artifact.id)
    ) {
      fail("manifest_artifact_definition");
    }
    if (
      typeof artifact.assemblyIdentity !== "string" ||
      artifact.assemblyIdentity.length === 0 ||
      artifact.assemblyIdentity.includes("\0")
    ) {
      fail("manifest_artifact_identity");
    }
    validateRelativePath(artifact.relativePath, "manifest_artifact_path");
    validateSha256(artifact.sha256, "manifest_artifact_sha256");
    validateBuildId(artifact.buildId, "manifest_artifact_build_id");
    return freeze({ ...artifact });
  });

  return deepFreeze({
    schema: TARGET_PUBLICATION_MANIFEST_SCHEMA,
    verifierId: PRODUCTION_VERIFIER_ID,
    scope: TARGET_PUBLICATION_SCOPE,
    publicationId: input.publicationId,
    artifactRoot: input.artifactRoot,
    provenance: freeze({ buildId: input.provenance.buildId }),
    artifacts: freezeEntries(artifacts),
  });
}

function validateSummary(report) {
  exactKeys(report.summary, REPORT_SUMMARY_KEYS, "report_summary_shape");
  for (const key of ["passed", "failed", "blocked", "passDenominator"]) {
    if (!Number.isSafeInteger(report.summary[key]) || report.summary[key] < 0) fail("report_summary_value");
  }
  const expectedSummary = {
    passed: report.state === "passed" ? 1 : 0,
    failed: report.state === "failed" ? 1 : 0,
    blocked: report.state === "blocked" ? 1 : 0,
  };
  if (
    report.summary.passed !== expectedSummary.passed
    || report.summary.failed !== expectedSummary.failed
    || report.summary.blocked !== expectedSummary.blocked
  ) fail("report_summary_state");
  const expectedDenominator = report.state === "blocked" ? 0 : 1;
  if (report.summary.passDenominator !== expectedDenominator) fail("report_summary_denominator");
}

function validateChecks(report) {
  if (!Array.isArray(report.checks) || report.checks.length !== PRODUCTION_CHECKS.length) fail("report_checks");
  let firstNonPassedIndex = -1;
  const seenStates = new Set(["passed", "failed", "blocked", "not_run"]);
  for (let index = 0; index < PRODUCTION_CHECKS.length; index++) {
    exactKeys(report.checks[index], REPORT_CHECK_KEYS, "report_check_shape");
    const check = report.checks[index];
    if (check.id !== PRODUCTION_CHECKS[index].id || check.kind !== PRODUCTION_CHECKS[index].kind) fail("report_check_identity");
    if (!seenStates.has(check.state)) fail("report_check_state");
    if (firstNonPassedIndex >= 0 && check.state !== "not_run") fail("report_check_gate_order");
    if (firstNonPassedIndex < 0 && check.state !== "passed") firstNonPassedIndex = index;
    const allowed = REASON_CODES_BY_CHECK[check.id];
    if (check.state === "passed" || check.state === "not_run") {
      if (check.reasonCode !== null) fail("report_check_reason");
    } else if (check.state === "blocked") {
      if (check.reasonCode !== allowed.blocked) fail("report_check_reason");
    } else if (!allowed.failed.includes(check.reasonCode)) {
      fail("report_check_reason");
    }
  }
  if (firstNonPassedIndex >= 0) {
    const failing = report.checks[firstNonPassedIndex];
    if (report.state !== failing.state || report.reasonCode !== failing.reasonCode) fail("report_state_reason");
  } else if (report.state !== "passed" || report.reasonCode !== TARGET_PUBLICATION_STATIC_VERIFIED) {
    fail("report_state_reason");
  }
  return firstNonPassedIndex;
}

function validateArtifactSection(report, firstNonPassedIndex) {
  exactKeys(report.artifacts, REPORT_ARTIFACT_SECTION_KEYS, "report_artifacts_shape");
  validateIdentityEntries(report.artifacts.required, PUBLICATION_ARTIFACTS, REPORT_ARTIFACT_REQUIREMENT_KEYS, "report_artifacts_identity");
  const requiredIds = new Set(PUBLICATION_ARTIFACTS.map((entry) => entry.id));
  for (const entry of [...report.artifacts.present, ...report.artifacts.missing]) {
    exactKeys(entry, REPORT_ENTRY_KEYS, "report_artifacts_entry_shape");
    validateRelativePath(entry.relativePath, "report_artifacts_entry_path");
  }
  for (const entry of report.artifacts.unusable) {
    exactKeys(entry, REPORT_UNUSABLE_KEYS, "report_artifacts_unusable_shape");
    validateRelativePath(entry.relativePath, "report_artifacts_entry_path");
    if (typeof entry.reason !== "string" || entry.reason.length === 0) fail("report_artifacts_unusable_reason");
  }
  const closureCheck = report.checks[1];
  if (closureCheck.state === "passed") {
    if (report.artifacts.present.length !== PUBLICATION_ARTIFACTS.length || report.artifacts.missing.length !== 0 || report.artifacts.unusable.length !== 0) {
      fail("report_artifacts_state");
    }
  } else if (closureCheck.state === "blocked") {
    if (report.artifacts.missing.length !== PUBLICATION_ARTIFACTS.length || report.artifacts.present.length !== 0 || report.artifacts.unusable.length !== 0) {
      fail("report_artifacts_state");
    }
  } else if (closureCheck.state === "not_run") {
    if (report.artifacts.present.length !== 0 || report.artifacts.missing.length !== 0 || report.artifacts.unusable.length !== 0) {
      fail("report_artifacts_state");
    }
  } else {
    partitionRequiredIds(report.artifacts.present, report.artifacts.missing, report.artifacts.unusable, requiredIds, "report_artifacts_partition");
    if (closureCheck.reasonCode === FAILED_TARGET_PUBLICATION_ARTIFACT_MISSING_PARTIAL && report.artifacts.missing.length === 0) {
      fail("report_artifacts_state");
    }
    if (closureCheck.reasonCode === FAILED_TARGET_PUBLICATION_ARTIFACT_UNUSABLE && report.artifacts.unusable.length === 0) {
      fail("report_artifacts_state");
    }
  }
  if (firstNonPassedIndex === 0) {
    // Manifest never admitted: it declares no artifact facts.
    if (report.artifacts.present.length !== 0 || report.artifacts.missing.length !== 0 || report.artifacts.unusable.length !== 0) {
      fail("report_artifacts_state");
    }
  }
}

function validateDigestSection(report) {
  exactKeys(report.digests, REPORT_DIGEST_SECTION_KEYS, "report_digests_shape");
  validateIdentityEntries(report.digests.required, DIGEST_REQUIREMENTS, REPORT_ENTRY_KEYS, "report_digests_identity");
  const requiredIds = new Set(DIGEST_REQUIREMENTS.map((entry) => entry.id));
  for (const entry of [...report.digests.verified, ...report.digests.unreadable]) {
    exactKeys(entry, REPORT_ENTRY_KEYS, "report_digests_entry_shape");
    validateRelativePath(entry.relativePath, "report_digests_entry_path");
  }
  for (const entry of report.digests.mismatched) {
    exactKeys(entry, REPORT_MISMATCHED_DIGEST_KEYS, "report_digests_mismatch_shape");
    validateRelativePath(entry.relativePath, "report_digests_entry_path");
    validateSha256(entry.expectedSha256, "report_digests_expected_sha256");
    validateSha256(entry.computedSha256, "report_digests_computed_sha256");
  }
  const digestCheck = report.checks[2];
  if (digestCheck.state === "passed") {
    if (report.digests.verified.length !== DIGEST_REQUIREMENTS.length || report.digests.mismatched.length !== 0 || report.digests.unreadable.length !== 0) {
      fail("report_digests_state");
    }
  } else if (digestCheck.state === "not_run") {
    if (report.digests.verified.length !== 0 || report.digests.mismatched.length !== 0 || report.digests.unreadable.length !== 0) {
      fail("report_digests_state");
    }
  } else {
    const nonVerified = [...report.digests.mismatched, ...report.digests.unreadable];
    partitionRequiredIds(report.digests.verified, nonVerified, [], requiredIds, "report_digests_partition");
    if (digestCheck.reasonCode === FAILED_TARGET_PUBLICATION_DIGEST_MISMATCH && report.digests.mismatched.length === 0) {
      fail("report_digests_state");
    }
    if (digestCheck.reasonCode === FAILED_TARGET_PUBLICATION_DIGEST_UNREADABLE && report.digests.unreadable.length === 0) {
      fail("report_digests_state");
    }
  }
}

function validateIdentitySection(report) {
  exactKeys(report.identity, REPORT_IDENTITY_SECTION_KEYS, "report_identity_shape");
  validateIdentityEntries(
    report.identity.required,
    IDENTITY_REQUIREMENTS,
    new Set(["id", "role", "assemblyIdentity"]),
    "report_identity_identity",
  );
  const requiredIds = new Set(IDENTITY_REQUIREMENTS.map((entry) => entry.id));
  for (const entry of report.identity.verified) {
    exactKeys(entry, REPORT_VERIFIED_IDENTITY_KEYS, "report_identity_verified_shape");
  }
  for (const entry of report.identity.mismatched) {
    exactKeys(entry, REPORT_MISMATCHED_IDENTITY_KEYS, "report_identity_mismatch_shape");
    if (entry.reason !== "assembly_identity" && entry.reason !== "build_provenance") fail("report_identity_mismatch_reason");
  }
  const identityCheck = report.checks[3];
  if (identityCheck.state === "passed") {
    if (report.identity.verified.length !== IDENTITY_REQUIREMENTS.length || report.identity.mismatched.length !== 0) {
      fail("report_identity_state");
    }
  } else if (identityCheck.state === "not_run") {
    if (report.identity.verified.length !== 0 || report.identity.mismatched.length !== 0) fail("report_identity_state");
  } else {
    partitionRequiredIds(report.identity.verified, report.identity.mismatched, [], requiredIds, "report_identity_partition");
    if (report.identity.mismatched.length === 0) fail("report_identity_state");
    if (identityCheck.reasonCode === FAILED_TARGET_PUBLICATION_IDENTITY_MISMATCH
      && !report.identity.mismatched.some((entry) => entry.reason === "assembly_identity")) {
      fail("report_identity_state");
    }
    if (identityCheck.reasonCode === FAILED_TARGET_PUBLICATION_PROVENANCE_MISMATCH && report.identity.mismatched.length === 0) {
      fail("report_identity_state");
    }
  }
}

function validateContractSection(report) {
  exactKeys(report.contract, REPORT_CONTRACT_KEYS, "report_contract_shape");
  if (!Array.isArray(report.contract.executions)) fail("report_contract_shape");
  const contractCheck = report.checks[4];
  if (contractCheck.state === "not_run") {
    if (report.contract.executions.length !== 0) fail("report_contract_state");
    return;
  }
  const expectedIds = ["capability-publication-contract", "portfolio-mine-elevator-projection-contract"];
  if (report.contract.executions.length < 1 || report.contract.executions.length > expectedIds.length) fail("report_contract_state");
  for (let index = 0; index < report.contract.executions.length; index++) {
    const contract = report.contract.executions[index];
    exactKeys(contract, REPORT_CONTRACT_EXECUTION_KEYS, "report_contract_shape");
    if (contract.id !== expectedIds[index] || typeof contract.executed !== "boolean") fail("report_contract_state");
    if (typeof contract.executable !== "string" || contract.executable.length === 0 || contract.shell !== false) fail("report_contract_state");
    if (contract.exitCode !== null && !Number.isSafeInteger(contract.exitCode)) fail("report_contract_state");
    if (contract.signal !== null && typeof contract.signal !== "string") fail("report_contract_state");
    if (typeof contract.timeout !== "boolean" || typeof contract.stderr !== "string" || typeof contract.successReceipt !== "string") fail("report_contract_state");
    if (!Array.isArray(contract.args) || contract.args.some((arg) => typeof arg !== "string")) fail("report_contract_state");
  }
  if (contractCheck.state === "passed") {
    if (report.contract.executions.length !== expectedIds.length || report.contract.executions.some((entry) => !entry.executed || entry.exitCode !== 0 || entry.timeout || entry.successReceipt.length === 0)) fail("report_contract_state");
  }
}

export function validateProductionReport(report) {
  exactKeys(report, REPORT_KEYS, "report_shape");
  if (report.schema !== PRODUCTION_REPORT_SCHEMA) fail("report_schema");
  if (report.verifierId !== PRODUCTION_VERIFIER_ID || report.scope !== TARGET_PUBLICATION_SCOPE) fail("report_identity");
  if (typeof report.inputId !== "string" || !INPUT_ID.test(report.inputId)) fail("report_input_id");
  if (report.publicationId !== null && (typeof report.publicationId !== "string" || !PUBLICATION_ID.test(report.publicationId))) {
    fail("report_publication_id");
  }
  if (!REASON_CODES_BY_STATE[report.state] || !REASON_CODES_BY_STATE[report.state].includes(report.reasonCode)) {
    fail("report_state_reason");
  }
  if (report.artifactRoot !== "") validateArtifactRoot(report.artifactRoot, "report_artifact_root");
  validateSummary(report);
  const firstNonPassedIndex = validateChecks(report);
  if ((report.publicationId === null) !== (report.checks[0].state !== "passed")) fail("report_publication_id");
  if ((report.artifactRoot === "") !== (report.checks[0].state !== "passed")) fail("report_artifact_root");
  validateArtifactSection(report, firstNonPassedIndex);
  validateDigestSection(report);
  validateIdentitySection(report);
  validateContractSection(report);

  exactKeys(report.integration, REPORT_INTEGRATION_KEYS, "report_integration_shape");
  if (report.integration.status !== "package-admission-integrated") fail("report_integration_status");
  if (!Array.isArray(report.integration.required) || report.integration.required.length !== PRODUCTION_INTEGRATION_REQUIREMENTS.length) {
    fail("report_integration_required");
  }
  for (let index = 0; index < PRODUCTION_INTEGRATION_REQUIREMENTS.length; index++) {
    if (report.integration.required[index] !== PRODUCTION_INTEGRATION_REQUIREMENTS[index]) fail("report_integration_required");
  }
  return report;
}