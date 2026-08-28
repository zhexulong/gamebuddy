import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  BLOCKED_MISSING_TARGET_ASSEMBLIES,
  FAILED_CONTRACT_OUTPUT_MISSING,
  FAILED_TARGET_ASSEMBLY,
  FAILED_TARGET_CLOSURE_PARTIAL,
  INTEGRATION_REQUIREMENTS,
  REPORT_SCHEMA,
  TARGET_ASSEMBLIES,
  TARGET_ASSEMBLIES_AVAILABLE,
  validateInput,
  validateReport,
} from "./schema.mjs";

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

function targetAssemblyPath(artifactRoot, relativePath) {
  return path.resolve(artifactRoot, ...relativePath.split("/"));
}

function normalizeExists(exists) {
  if (typeof exists !== "function") throw new TypeError("stardew_static_verifier_invalid_exists");
  return exists;
}

function normalizeStat(stat) {
  if (typeof stat !== "function") throw new TypeError("stardew_static_verifier_invalid_stat");
  return stat;
}

/**
 * Check only the artifact paths named by the validated package input.
 *
 * No repository root, source tree, project file, package manifest, game
 * process, or target build is consulted by this function. Each required
 * artifact must be an existing, regular, non-empty file; a directory, empty
 * file, or unreadable path is reported as unusable (a malformed target), not
 * as present.
 */
export function checkTargetAssemblyAvailability(input, { exists = existsSync, stat = statSync } = {}) {
  const validated = validateInput(input);
  const checkExists = normalizeExists(exists);
  const checkStat = normalizeStat(stat);
  const required = validated.targetAssemblies.filter((assembly) => assembly.required);
  const present = [];
  const missing = [];
  const unusable = [];
  for (const assembly of required) {
    const absolutePath = targetAssemblyPath(validated.artifactRoot, assembly.relativePath);
    let available;
    try {
      available = checkExists(absolutePath);
    } catch {
      available = false;
    }
    if (!available) {
      missing.push(freeze({ id: assembly.id, relativePath: assembly.relativePath }));
      continue;
    }
    let usable = false;
    try {
      const info = checkStat(absolutePath);
      usable = info.isFile() && info.size > 0;
    } catch {
      usable = false;
    }
    (usable ? present : unusable).push(
      usable
        ? freeze({ id: assembly.id, relativePath: assembly.relativePath })
        : freeze({ id: assembly.id, relativePath: assembly.relativePath, reason: "not_a_readable_nonempty_file" }),
    );
  }
  return freeze({
    available: present.length === required.length,
    required: freeze(required.map(({ id, role, relativePath, required, siblingOf }) => freeze({ id, role, relativePath, required, siblingOf }))),
    present: freeze(present),
    missing: freeze(missing),
    unusable: freeze(unusable),
  });
}

/**
 * Check only the frozen contract outputs of the production closure. A missing
 * output means the build/contract step did not publish its exact artifact.
 */
export function checkContractOutputAvailability(input, { exists = existsSync } = {}) {
  const validated = validateInput(input);
  const checkExists = normalizeExists(exists);
  const required = validated.contractOutputs.filter((output) => output.required);
  const present = [];
  const missing = [];
  for (const output of required) {
    const absolutePath = targetAssemblyPath(validated.artifactRoot, output.relativePath);
    let available;
    try {
      available = checkExists(absolutePath);
    } catch {
      available = false;
    }
    (available ? present : missing).push(freeze({ id: output.id, relativePath: output.relativePath }));
  }
  return freeze({
    required: freeze(required.map(({ id, relativePath, required }) => freeze({ id, relativePath, required }))),
    present: freeze(present),
    missing: freeze(missing),
  });
}

function reportFor(input, availability, contract) {
  let state;
  let reasonCode;
  if (availability.missing.length === availability.required.length) {
    state = "blocked";
    reasonCode = BLOCKED_MISSING_TARGET_ASSEMBLIES;
  } else if (availability.unusable.length > 0) {
    state = "failed";
    reasonCode = FAILED_TARGET_ASSEMBLY;
  } else if (availability.missing.length > 0) {
    state = "failed";
    reasonCode = FAILED_TARGET_CLOSURE_PARTIAL;
  } else if (contract.missing.length > 0) {
    state = "failed";
    reasonCode = FAILED_CONTRACT_OUTPUT_MISSING;
  } else {
    state = "passed";
    reasonCode = TARGET_ASSEMBLIES_AVAILABLE;
  }
  const report = {
    schema: REPORT_SCHEMA,
    verifierId: input.verifierId,
    inputId: input.inputId,
    scope: input.scope,
    state,
    reasonCode,
    summary: {
      passed: state === "passed" ? 1 : 0,
      failed: state === "failed" ? 1 : 0,
      blocked: state === "blocked" ? 1 : 0,
      passDenominator: state === "blocked" ? 0 : 1,
    },
    targetAssemblies: {
      required: availability.required,
      present: availability.present,
      missing: availability.missing,
      unusable: availability.unusable,
    },
    contractOutputs: {
      required: contract.required,
      present: contract.present,
      missing: contract.missing,
    },
    checks: [
      {
        id: "target-assembly-availability",
        kind: "target_assembly_availability",
        state,
        reasonCode,
      },
    ],
    integration: {
      status: "not-integrated",
      required: freeze([...INTEGRATION_REQUIREMENTS]),
    },
  };
  return deepFreeze(validateReport(report));
}

/**
 * Run the deterministic package-owned self-test over one exact Mod/Core
 * sibling production closure. No target artifacts at all is a named blocked
 * result; a partial, malformed, or contract-incomplete closure is a named
 * failed result. Neither is a successful no-op and neither requests a target
 * build.
 */
export function verifyStaticInput(input, options = {}) {
  const validated = validateInput(input);
  const availability = checkTargetAssemblyAvailability(validated, options);
  const contract = checkContractOutputAvailability(validated, options);
  return reportFor(validated, availability, contract);
}

export function createMissingTargetFixture(input) {
  const validated = validateInput(input);
  return freeze({
    ...validated,
    targetAssemblies: freeze(validated.targetAssemblies.map((assembly) => freeze({ ...assembly }))),
  });
}

export { FAILED_TARGET_ASSEMBLY, TARGET_ASSEMBLIES };