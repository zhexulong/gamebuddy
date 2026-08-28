import { existsSync } from "node:fs";
import path from "node:path";
import {
  BLOCKED_MISSING_TARGET_ASSEMBLIES,
  FAILED_TARGET_ASSEMBLY,
  REPORT_SCHEMA,
  TARGET_ASSEMBLIES,
  validateInput,
  validateReport,
} from "./schema.mjs";

const INTEGRATION_REQUIREMENTS = Object.freeze([
  "wire the package verifier into the package portfolio without changing the existing manifest in this migration slice",
  "supply the independently published target assembly artifact root and preserve its provenance at integration time",
  "add the later package workflow/CI invocation only after package parity review",
]);

function freeze(value) {
  return Object.freeze(value);
}

function targetAssemblyPath(artifactRoot, relativePath) {
  return path.resolve(artifactRoot, ...relativePath.split("/"));
}

function normalizeExists(exists) {
  if (typeof exists !== "function") throw new TypeError("stardew_static_verifier_invalid_exists");
  return exists;
}

/**
 * Check only the artifact paths named by the validated package input.
 *
 * No repository root, source tree, project file, package manifest, game
 * process, or target build is consulted by this function.
 */
export function checkTargetAssemblyAvailability(input, { exists = existsSync } = {}) {
  const validated = validateInput(input);
  const checkExists = normalizeExists(exists);
  const required = validated.targetAssemblies.filter((assembly) => assembly.required);
  const present = [];
  const missing = [];
  for (const assembly of required) {
    const absolutePath = targetAssemblyPath(validated.artifactRoot, assembly.relativePath);
    let available;
    try {
      available = checkExists(absolutePath);
    } catch {
      available = false;
    }
    const entry = freeze({ id: assembly.id, relativePath: assembly.relativePath });
    (available ? present : missing).push(entry);
  }
  return freeze({
    available: missing.length === 0,
    required: freeze(required.map(({ id, relativePath }) => freeze({ id, relativePath }))),
    present: freeze(present),
    missing: freeze(missing),
  });
}

function reportFor(input, availability) {
  const blocked = !availability.available;
  const checkState = blocked ? "blocked" : "passed";
  const reasonCode = blocked ? BLOCKED_MISSING_TARGET_ASSEMBLIES : "target_assemblies_available";
  const report = {
    schema: REPORT_SCHEMA,
    verifierId: input.verifierId,
    inputId: input.inputId,
    scope: input.scope,
    state: blocked ? "blocked" : "passed",
    reasonCode,
    summary: {
      passed: blocked ? 0 : 1,
      failed: 0,
      blocked: blocked ? 1 : 0,
      passDenominator: blocked ? 0 : 1,
    },
    targetAssemblies: {
      required: availability.required,
      present: availability.present,
      missing: availability.missing,
    },
    checks: [
      {
        id: "target-assembly-availability",
        kind: "target_assembly_availability",
        state: checkState,
        reasonCode,
      },
    ],
    integration: {
      status: "not-integrated",
      required: INTEGRATION_REQUIREMENTS,
    },
  };
  return validateReport(report);
}

/**
 * Run the deterministic package-owned self-test. Missing artifacts are a
 * named blocked result, not a successful no-op and not a target-build request.
 */
export function verifyStaticInput(input, options = {}) {
  const validated = validateInput(input);
  const availability = checkTargetAssemblyAvailability(validated, options);
  return reportFor(validated, availability);
}

export function createMissingTargetFixture(input) {
  const validated = validateInput(input);
  return freeze({
    ...validated,
    artifactRoot: validated.artifactRoot,
    targetAssemblies: freeze(validated.targetAssemblies.map((assembly) => freeze({ ...assembly }))),
  });
}

export { FAILED_TARGET_ASSEMBLY, TARGET_ASSEMBLIES };
