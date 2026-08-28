export const INPUT_SCHEMA = "gamebuddy-stardew-static-verifier-input/v1";
export const REPORT_SCHEMA = "gamebuddy-stardew-static-verifier-report/v1";
export const VERIFIER_ID = "gamebuddy.stardew.action-development.static-verifier@v1";
export const PACKAGE_FIXTURE_SCOPE = "package-owned-fixture";

export const BLOCKED_MISSING_TARGET_ASSEMBLIES = "blocked_missing_target_assemblies";
export const FAILED_TARGET_ASSEMBLY = "failed_target_assembly_unreadable";
export const FAILED_TARGET_CLOSURE_PARTIAL = "failed_target_closure_partial";
export const FAILED_CONTRACT_OUTPUT_MISSING = "failed_contract_output_missing";
export const TARGET_ASSEMBLIES_AVAILABLE = "target_assemblies_available";

/**
 * Exact Mod/Core sibling target identity: the frozen production closure.
 *
 * The verifier never discovers assemblies, infers a game installation, reads
 * project/source files, or accepts an independently supplied alternate Core
 * path. The Mod and Core artifacts are one exact sibling pair at the same
 * artifact root; a partial or replaced pair is a failed closure, not a pass.
 */
export const TARGET_ASSEMBLIES = Object.freeze([
  Object.freeze({
    id: "gamebuddy-stardew-mod",
    role: "mod",
    relativePath: "GameBuddy.Stardew.dll",
    required: true,
    siblingOf: "gamebuddy-stardew-core",
  }),
  Object.freeze({
    id: "gamebuddy-stardew-core",
    role: "core",
    relativePath: "GameBuddy.Stardew.Core.dll",
    required: true,
    siblingOf: "gamebuddy-stardew-mod",
  }),
]);

/**
 * Exact compiled contract outputs of the production closure. A missing output
 * is a build/contract failure: the verifier reports failed and never treats
 * the closure as passed.
 */
export const CONTRACT_OUTPUTS = Object.freeze([
  Object.freeze({
    id: "capability-publication-contract",
    relativePath: "FarmhandCapabilityPublicationProjection.Contract.dll",
    required: true,
  }),
]);

export const INTEGRATION_REQUIREMENTS = Object.freeze([
  "wire the package verifier into the package portfolio without changing the existing manifest in this migration slice",
  "supply the independently published target assembly artifact root and preserve its provenance at integration time",
  "add the later package workflow/CI invocation only after package parity review",
]);

export const STATIC_CHECKS = Object.freeze([
  Object.freeze({ id: "target-assembly-availability", kind: "target_assembly_availability", required: true }),
]);

const REASON_CODES_BY_STATE = Object.freeze({
  passed: Object.freeze([TARGET_ASSEMBLIES_AVAILABLE]),
  blocked: Object.freeze([BLOCKED_MISSING_TARGET_ASSEMBLIES]),
  failed: Object.freeze([FAILED_TARGET_ASSEMBLY, FAILED_TARGET_CLOSURE_PARTIAL, FAILED_CONTRACT_OUTPUT_MISSING]),
});

const INPUT_KEYS = new Set([
  "schema",
  "verifierId",
  "inputId",
  "scope",
  "artifactRoot",
  "targetAssemblies",
  "contractOutputs",
  "staticChecks",
]);
const ASSEMBLY_KEYS = new Set(["id", "role", "relativePath", "required", "siblingOf"]);
const CONTRACT_OUTPUT_KEYS = new Set(["id", "relativePath", "required"]);
const CHECK_KEYS = new Set(["id", "kind", "required"]);
const REPORT_KEYS = new Set([
  "schema",
  "verifierId",
  "inputId",
  "scope",
  "state",
  "reasonCode",
  "summary",
  "targetAssemblies",
  "contractOutputs",
  "checks",
  "integration",
]);
const REPORT_SUMMARY_KEYS = new Set(["passed", "failed", "blocked", "passDenominator"]);
const REPORT_TARGET_KEYS = new Set(["required", "present", "missing", "unusable"]);
const REPORT_CONTRACT_KEYS = new Set(["required", "present", "missing"]);
const REPORT_ENTRY_KEYS = new Set(["id", "relativePath"]);
const REPORT_UNUSABLE_KEYS = new Set(["id", "relativePath", "reason"]);
const REPORT_CHECK_KEYS = new Set(["id", "kind", "state", "reasonCode"]);
const REPORT_INTEGRATION_KEYS = new Set(["status", "required"]);
const ID = /^[a-z][a-z0-9-]{1,63}$/;
const INPUT_ID = /^[a-z][a-z0-9-]{1,127}$/;
const MAX_RELATIVE_PATH_LENGTH = 512;

export class StaticVerifierSchemaError extends Error {
  constructor(code) {
    super(`stardew_static_verifier_schema_${code}`);
    this.name = "StaticVerifierSchemaError";
    this.code = code;
  }
}

function fail(code) {
  throw new StaticVerifierSchemaError(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, code) {
  if (!isRecord(value) || Object.keys(value).length !== keys.size || Object.keys(value).some((key) => !keys.has(key))) {
    fail(code);
  }
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

function cloneAssembly(value) {
  return Object.freeze({ id: value.id, role: value.role, relativePath: value.relativePath, required: value.required, siblingOf: value.siblingOf });
}

function cloneContractOutput(value) {
  return Object.freeze({ id: value.id, relativePath: value.relativePath, required: value.required });
}

function cloneCheck(value) {
  return Object.freeze({ id: value.id, kind: value.kind, required: value.required });
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
 * Validate and normalize the package-owned, versioned verifier input.
 *
 * The target set is intentionally explicit and immutable: the exact Mod/Core
 * sibling pair plus the frozen contract outputs. The verifier does not
 * discover assemblies, infer a game installation, or read project/source
 * files to expand this set.
 */
export function validateInput(input) {
  exactKeys(input, INPUT_KEYS, "input_shape");
  if (input.schema !== INPUT_SCHEMA) fail("input_schema");
  if (input.verifierId !== VERIFIER_ID) fail("verifier_identity");
  if (typeof input.inputId !== "string" || !INPUT_ID.test(input.inputId)) fail("input_id");
  if (input.scope !== PACKAGE_FIXTURE_SCOPE) fail("input_scope");
  const artifactRoot = validateRelativePath(input.artifactRoot, "artifact_root");

  if (!Array.isArray(input.targetAssemblies) || input.targetAssemblies.length !== TARGET_ASSEMBLIES.length) {
    fail("target_assembly_count");
  }
  const targetAssemblies = input.targetAssemblies.map((assembly, index) => {
    exactKeys(assembly, ASSEMBLY_KEYS, "target_assembly_shape");
    const expected = TARGET_ASSEMBLIES[index];
    if (
      assembly.id !== expected.id ||
      assembly.role !== expected.role ||
      assembly.relativePath !== expected.relativePath ||
      assembly.required !== true ||
      assembly.siblingOf !== expected.siblingOf ||
      !ID.test(assembly.id)
    ) {
      fail("target_assembly_definition");
    }
    validateRelativePath(assembly.relativePath, "target_assembly_path");
    return cloneAssembly(assembly);
  });

  if (!Array.isArray(input.contractOutputs) || input.contractOutputs.length !== CONTRACT_OUTPUTS.length) {
    fail("contract_output_count");
  }
  const contractOutputs = input.contractOutputs.map((output, index) => {
    exactKeys(output, CONTRACT_OUTPUT_KEYS, "contract_output_shape");
    const expected = CONTRACT_OUTPUTS[index];
    if (
      output.id !== expected.id ||
      output.relativePath !== expected.relativePath ||
      output.required !== true ||
      !ID.test(output.id)
    ) {
      fail("contract_output_definition");
    }
    validateRelativePath(output.relativePath, "contract_output_path");
    return cloneContractOutput(output);
  });

  if (!Array.isArray(input.staticChecks) || input.staticChecks.length !== STATIC_CHECKS.length) {
    fail("static_check_count");
  }
  const staticChecks = input.staticChecks.map((check, index) => {
    exactKeys(check, CHECK_KEYS, "static_check_shape");
    const expected = STATIC_CHECKS[index];
    if (check.id !== expected.id || check.kind !== expected.kind || check.required !== true || !ID.test(check.id)) {
      fail("static_check_definition");
    }
    return cloneCheck(check);
  });

  return Object.freeze({
    schema: INPUT_SCHEMA,
    verifierId: VERIFIER_ID,
    inputId: input.inputId,
    scope: PACKAGE_FIXTURE_SCOPE,
    artifactRoot,
    targetAssemblies: Object.freeze(targetAssemblies),
    contractOutputs: Object.freeze(contractOutputs),
    staticChecks: Object.freeze(staticChecks),
  });
}

export function validateReport(report) {
  exactKeys(report, REPORT_KEYS, "report_shape");
  if (report.schema !== REPORT_SCHEMA) fail("report_schema");
  if (report.verifierId !== VERIFIER_ID || report.scope !== PACKAGE_FIXTURE_SCOPE) fail("report_identity");
  if (typeof report.inputId !== "string" || !INPUT_ID.test(report.inputId)) fail("report_input_id");
  if (!REASON_CODES_BY_STATE[report.state] || !REASON_CODES_BY_STATE[report.state].includes(report.reasonCode)) {
    fail("report_state_reason");
  }

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

  exactKeys(report.targetAssemblies, REPORT_TARGET_KEYS, "report_target_shape");
  validateIdentityEntries(report.targetAssemblies.required, TARGET_ASSEMBLIES, ASSEMBLY_KEYS, "report_target_identity");
  const requiredAssemblyIds = new Set(report.targetAssemblies.required.map((entry) => entry.id));
  for (const entry of [...report.targetAssemblies.present, ...report.targetAssemblies.missing]) {
    exactKeys(entry, REPORT_ENTRY_KEYS, "report_target_entry_shape");
    validateRelativePath(entry.relativePath, "report_target_entry_path");
  }
  for (const entry of report.targetAssemblies.unusable) {
    exactKeys(entry, REPORT_UNUSABLE_KEYS, "report_target_unusable_shape");
    validateRelativePath(entry.relativePath, "report_target_entry_path");
    if (typeof entry.reason !== "string" || entry.reason.length === 0) fail("report_target_unusable_reason");
  }
  partitionRequiredIds(
    report.targetAssemblies.present,
    report.targetAssemblies.missing,
    report.targetAssemblies.unusable,
    requiredAssemblyIds,
    "report_target_partition",
  );

  exactKeys(report.contractOutputs, REPORT_CONTRACT_KEYS, "report_contract_shape");
  validateIdentityEntries(report.contractOutputs.required, CONTRACT_OUTPUTS, CONTRACT_OUTPUT_KEYS, "report_contract_identity");
  const requiredContractIds = new Set(report.contractOutputs.required.map((entry) => entry.id));
  partitionRequiredIds(
    report.contractOutputs.present,
    report.contractOutputs.missing,
    [],
    requiredContractIds,
    "report_contract_partition",
  );
  for (const entry of [...report.contractOutputs.present, ...report.contractOutputs.missing]) {
    exactKeys(entry, REPORT_ENTRY_KEYS, "report_contract_entry_shape");
    validateRelativePath(entry.relativePath, "report_contract_entry_path");
  }

  if (!Array.isArray(report.checks) || report.checks.length !== STATIC_CHECKS.length) fail("report_checks");
  for (let index = 0; index < STATIC_CHECKS.length; index++) {
    exactKeys(report.checks[index], REPORT_CHECK_KEYS, "report_check_shape");
    const check = report.checks[index];
    if (check.id !== STATIC_CHECKS[index].id || check.kind !== STATIC_CHECKS[index].kind) fail("report_check_identity");
    if (check.state !== report.state || check.reasonCode !== report.reasonCode) fail("report_check_state");
  }

  exactKeys(report.integration, REPORT_INTEGRATION_KEYS, "report_integration_shape");
  if (report.integration.status !== "not-integrated") fail("report_integration_status");
  if (!Array.isArray(report.integration.required) || report.integration.required.length !== INTEGRATION_REQUIREMENTS.length) {
    fail("report_integration_required");
  }
  for (let index = 0; index < INTEGRATION_REQUIREMENTS.length; index++) {
    if (report.integration.required[index] !== INTEGRATION_REQUIREMENTS[index]) fail("report_integration_required");
  }
  return report;
}