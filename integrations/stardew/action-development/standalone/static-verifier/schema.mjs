export const INPUT_SCHEMA = "gamebuddy-stardew-static-verifier-input/v1";
export const REPORT_SCHEMA = "gamebuddy-stardew-static-verifier-report/v1";
export const VERIFIER_ID = "gamebuddy.stardew.action-development.static-verifier@v1";
export const PACKAGE_FIXTURE_SCOPE = "package-owned-fixture";
export const BLOCKED_MISSING_TARGET_ASSEMBLIES = "blocked_missing_target_assemblies";
export const FAILED_TARGET_ASSEMBLY = "failed_target_assembly_unreadable";

export const TARGET_ASSEMBLIES = Object.freeze([
  Object.freeze({ id: "stardew-valley", relativePath: "Stardew Valley.dll", required: true }),
  Object.freeze({ id: "smapi", relativePath: "StardewModdingAPI.dll", required: true }),
  Object.freeze({ id: "monogame", relativePath: "MonoGame.Framework.dll", required: true }),
  Object.freeze({ id: "smapi-toolkit-core-interfaces", relativePath: "SMAPI.Toolkit.CoreInterfaces.dll", required: true }),
  Object.freeze({ id: "newtonsoft-json", relativePath: "smapi-internal/Newtonsoft.Json.dll", required: true }),
]);

export const STATIC_CHECKS = Object.freeze([
  Object.freeze({ id: "target-assembly-availability", kind: "target_assembly_availability", required: true }),
]);

const INPUT_KEYS = new Set([
  "schema",
  "verifierId",
  "inputId",
  "scope",
  "artifactRoot",
  "targetAssemblies",
  "staticChecks",
]);
const ASSEMBLY_KEYS = new Set(["id", "relativePath", "required"]);
const CHECK_KEYS = new Set(["id", "kind", "required"]);
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
  return Object.freeze({ id: value.id, relativePath: value.relativePath, required: value.required });
}

function cloneCheck(value) {
  return Object.freeze({ id: value.id, kind: value.kind, required: value.required });
}

/**
 * Validate and normalize the package-owned, versioned verifier input.
 *
 * The target set is intentionally explicit and immutable. The verifier does
 * not discover assemblies, infer a game installation, or read project/source
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
      assembly.relativePath !== expected.relativePath ||
      assembly.required !== true ||
      !ID.test(assembly.id)
    ) {
      fail("target_assembly_definition");
    }
    validateRelativePath(assembly.relativePath, "target_assembly_path");
    return cloneAssembly(assembly);
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
    staticChecks: Object.freeze(staticChecks),
  });
}

export function validateReport(report) {
  if (!isRecord(report) || report.schema !== REPORT_SCHEMA) fail("report_schema");
  if (report.verifierId !== VERIFIER_ID || report.scope !== PACKAGE_FIXTURE_SCOPE) fail("report_identity");
  if (typeof report.inputId !== "string" || !INPUT_ID.test(report.inputId)) fail("report_input_id");
  if (!new Set(["passed", "blocked", "failed"]).has(report.state)) fail("report_state");
  if (typeof report.reasonCode !== "string" || report.reasonCode.length === 0) fail("report_reason");
  if (!isRecord(report.summary)) fail("report_summary");
  for (const key of ["passed", "failed", "blocked", "passDenominator"]) {
    if (!Number.isSafeInteger(report.summary[key]) || report.summary[key] < 0) fail("report_summary_value");
  }
  if (!isRecord(report.targetAssemblies) || !Array.isArray(report.targetAssemblies.required)) fail("report_target");
  if (!Array.isArray(report.checks) || report.checks.length !== STATIC_CHECKS.length) fail("report_checks");
  if (!isRecord(report.integration) || report.integration.status !== "not-integrated" || !Array.isArray(report.integration.required)) {
    fail("report_integration");
  }
  return report;
}
