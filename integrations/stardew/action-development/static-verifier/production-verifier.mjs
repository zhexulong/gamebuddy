/**
 * Production static authority verification for the package-owned verifier.
 *
 * The verification boundary accepts an already-admitted, versioned
 * target-publication manifest and runs five gated stages:
 *
 *   1. manifestation admission is performed by the caller (CLI or harness);
 *   2. artifact closure: exact regular non-empty files, same-directory
 *      sibling pair (Mod/Core/contract);
 *   3. SHA-256 digests against the manifest's expected values;
 *   4. assembly/contract identity fields and same-build provenance;
 *   5. execution of the compiled
 *      `FarmhandCapabilityPublicationProjection.Contract.dll` with the exact
 *      `--expected-mod-sha256` / `--expected-core-sha256` flags and absolute
 *      paired paths, using `shell: false`.
 *
 * Missing manifest/artifacts is a named `blocked` result; malformed,
 * partial, non-sibling, digest-mismatched, identity/provenance-mismatched,
 * or contract-failing closures are named `failed` results. No target build
 * is requested or performed here, and the report never claims live
 * evidence.
 */
import { createHash } from "node:crypto";
import { spawn as spawnDefault } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  BLOCKED_MISSING_TARGET_PUBLICATION_ARTIFACTS,
  BLOCKED_MISSING_TARGET_PUBLICATION_MANIFEST,
  DIGEST_REQUIREMENTS,
  FAILED_TARGET_PUBLICATION_ARTIFACT_MISSING_PARTIAL,
  FAILED_TARGET_PUBLICATION_ARTIFACT_UNUSABLE,
  FAILED_TARGET_PUBLICATION_CONTRACT_NONZERO,
  FAILED_TARGET_PUBLICATION_CONTRACT_OUTPUT,
  FAILED_TARGET_PUBLICATION_CONTRACT_SPAWN,
  FAILED_TARGET_PUBLICATION_CONTRACT_TIMEOUT,
  FAILED_TARGET_PUBLICATION_DIGEST_MISMATCH,
  FAILED_TARGET_PUBLICATION_DIGEST_UNREADABLE,
  FAILED_TARGET_PUBLICATION_IDENTITY_MISMATCH,
  FAILED_TARGET_PUBLICATION_NON_SIBLING,
  FAILED_TARGET_PUBLICATION_PROVENANCE_MISMATCH,
  IDENTITY_REQUIREMENTS,
  PRODUCTION_CHECKS,
  PRODUCTION_INTEGRATION_REQUIREMENTS,
  PRODUCTION_REPORT_SCHEMA,
  PRODUCTION_VERIFIER_ID,
  PUBLICATION_ARTIFACTS,
  TARGET_PUBLICATION_SCOPE,
  TARGET_PUBLICATION_STATIC_VERIFIED,
  validateProductionReport,
} from "./production-schema.mjs";

const DEFAULT_CONTRACT_TIMEOUT_MS = 120000;
const MAX_CONTRACT_OUTPUT_BYTES = 65536;
const CONTRACTS = Object.freeze([
  Object.freeze({
    id: "capability-publication-contract",
    successReceipt: "Farmhand capability publication identity/path/digest contract passed.",
  }),
  Object.freeze({
    id: "portfolio-mine-elevator-projection-contract",
    successReceipt: "Portfolio mine projection and direct ladder structural contract passed.",
  }),
]);
const CONTRACT_FLAG_MOD_SHA256 = "--expected-mod-sha256";
const CONTRACT_FLAG_CORE_SHA256 = "--expected-core-sha256";
const SHA256 = /^[a-f0-9]{64}$/;

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

function defaultHashFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function normalizeHashFile(hashFile) {
  if (typeof hashFile !== "function") throw new TypeError("stardew_static_verifier_invalid_hash_file");
  return hashFile;
}

function normalizeSpawnCommand(spawnCommand) {
  if (typeof spawnCommand !== "function") throw new TypeError("stardew_static_verifier_invalid_spawn");
  return spawnCommand;
}

function normalizeDotnetCommand(dotnetCommand) {
  if (typeof dotnetCommand !== "string" || dotnetCommand.length === 0 || dotnetCommand.includes("\0")) {
    throw new TypeError("stardew_static_verifier_invalid_dotnet_command");
  }
  return dotnetCommand;
}

function normalizeTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("stardew_static_verifier_invalid_timeout");
  return timeoutMs;
}

function normalizeOptions(options = {}) {
  return freeze({
    exists: typeof options.exists === "function" ? options.exists : existsSync,
    stat: typeof options.stat === "function" ? options.stat : statSync,
    hashFile: normalizeHashFile(options.hashFile ?? defaultHashFile),
    spawnCommand: normalizeSpawnCommand(options.spawnCommand ?? spawnDefault),
    dotnetCommand: normalizeDotnetCommand(options.dotnetCommand ?? "dotnet"),
    timeoutMs: normalizeTimeout(options.timeoutMs ?? DEFAULT_CONTRACT_TIMEOUT_MS),
    maxOutputBytes: Number.isSafeInteger(options.maxOutputBytes) && options.maxOutputBytes > 0
      ? options.maxOutputBytes
      : MAX_CONTRACT_OUTPUT_BYTES,
  });
}

function resolveArtifactPath(artifactRoot, relativePath) {
  return path.resolve(artifactRoot, ...relativePath.split("/"));
}

function artifactEntries(artifacts) {
  return artifacts.map((artifact) => freeze({ id: artifact.id, relativePath: artifact.relativePath }));
}

function checkArtifactClosure(manifest, options) {
  const present = [];
  const missing = [];
  const unusable = [];
  for (const artifact of manifest.artifacts) {
    const absolutePath = resolveArtifactPath(manifest.artifactRoot, artifact.relativePath);
    let available;
    try {
      available = options.exists(absolutePath);
    } catch {
      available = false;
    }
    if (!available) {
      missing.push(freeze({ id: artifact.id, relativePath: artifact.relativePath }));
      continue;
    }
    let usable = false;
    try {
      const info = options.stat(absolutePath);
      usable = info.isFile() && info.size > 0;
    } catch {
      usable = false;
    }
    (usable ? present : unusable).push(
      usable
        ? freeze({ id: artifact.id, relativePath: artifact.relativePath })
        : freeze({ id: artifact.id, relativePath: artifact.relativePath, reason: "not_a_readable_nonempty_file" }),
    );
  }

  const directories = manifest.artifacts.map((artifact) => path.posix.dirname(artifact.relativePath));
  const siblings = directories.every((directory) => directory === directories[0]);

  let state = "passed";
  let reasonCode = null;
  if (missing.length === manifest.artifacts.length) {
    state = "blocked";
    reasonCode = BLOCKED_MISSING_TARGET_PUBLICATION_ARTIFACTS;
  } else if (!siblings) {
    state = "failed";
    reasonCode = FAILED_TARGET_PUBLICATION_NON_SIBLING;
  } else if (unusable.length > 0) {
    state = "failed";
    reasonCode = FAILED_TARGET_PUBLICATION_ARTIFACT_UNUSABLE;
  } else if (missing.length > 0) {
    state = "failed";
    reasonCode = FAILED_TARGET_PUBLICATION_ARTIFACT_MISSING_PARTIAL;
  }
  return {
    state,
    reasonCode,
    check: freeze({
      id: PRODUCTION_CHECKS[1].id,
      kind: PRODUCTION_CHECKS[1].kind,
      state,
      reasonCode,
    }),
    section: freeze({
      required: PUBLICATION_ARTIFACTS,
      present: freezeEntries(present),
      missing: freezeEntries(missing),
      unusable: freezeEntries(unusable),
    }),
  };
}

function checkArtifactDigests(manifest, options) {
  const verified = [];
  const mismatched = [];
  const unreadable = [];
  for (const artifact of manifest.artifacts) {
    const absolutePath = resolveArtifactPath(manifest.artifactRoot, artifact.relativePath);
    let computed;
    try {
      computed = options.hashFile(absolutePath);
    } catch {
      unreadable.push(freeze({ id: artifact.id, relativePath: artifact.relativePath }));
      continue;
    }
    if (typeof computed !== "string" || !SHA256.test(computed)) {
      unreadable.push(freeze({ id: artifact.id, relativePath: artifact.relativePath }));
      continue;
    }
    if (computed === artifact.sha256) {
      verified.push(freeze({ id: artifact.id, relativePath: artifact.relativePath }));
    } else {
      mismatched.push(
        freeze({
          id: artifact.id,
          relativePath: artifact.relativePath,
          expectedSha256: artifact.sha256,
          computedSha256: computed,
        }),
      );
    }
  }
  let state = "passed";
  let reasonCode = null;
  if (mismatched.length > 0) {
    state = "failed";
    reasonCode = FAILED_TARGET_PUBLICATION_DIGEST_MISMATCH;
  } else if (unreadable.length > 0) {
    state = "failed";
    reasonCode = FAILED_TARGET_PUBLICATION_DIGEST_UNREADABLE;
  }
  return {
    state,
    reasonCode,
    check: freeze({
      id: PRODUCTION_CHECKS[2].id,
      kind: PRODUCTION_CHECKS[2].kind,
      state,
      reasonCode,
    }),
    section: freeze({
      required: DIGEST_REQUIREMENTS,
      verified: freezeEntries(verified),
      mismatched: freezeEntries(mismatched),
      unreadable: freezeEntries(unreadable),
    }),
  };
}

function checkIdentityProvenance(manifest) {
  const verified = [];
  const mismatched = [];
  for (const artifact of manifest.artifacts) {
    const expected = PUBLICATION_ARTIFACTS.find((entry) => entry.id === artifact.id);
    if (expected === undefined || artifact.assemblyIdentity !== expected.assemblyIdentity) {
      mismatched.push(freeze({ id: artifact.id, reason: "assembly_identity" }));
    } else if (artifact.buildId !== manifest.provenance.buildId) {
      mismatched.push(freeze({ id: artifact.id, reason: "build_provenance" }));
    } else {
      verified.push(freeze({ id: artifact.id }));
    }
  }
  let state = "passed";
  let reasonCode = null;
  if (mismatched.length > 0) {
    state = "failed";
    reasonCode = mismatched.some((entry) => entry.reason === "assembly_identity")
      ? FAILED_TARGET_PUBLICATION_IDENTITY_MISMATCH
      : FAILED_TARGET_PUBLICATION_PROVENANCE_MISMATCH;
  }
  return {
    state,
    reasonCode,
    check: freeze({
      id: PRODUCTION_CHECKS[3].id,
      kind: PRODUCTION_CHECKS[3].kind,
      state,
      reasonCode,
    }),
    section: freeze({
      required: IDENTITY_REQUIREMENTS,
      verified: freezeEntries(verified),
      mismatched: freezeEntries(mismatched),
    }),
  };
}

function contractArguments(manifest, contractId) {
  const byId = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  const mod = byId.get("gamebuddy-stardew-mod");
  const core = byId.get("gamebuddy-stardew-core");
  const contract = byId.get(contractId);
  if (contractId === "portfolio-mine-elevator-projection-contract") {
    return freeze([
      resolveArtifactPath(manifest.artifactRoot, contract.relativePath),
      "--expected-sha256",
      mod.sha256,
      resolveArtifactPath(manifest.artifactRoot, mod.relativePath),
    ]);
  }
  return freeze([
    resolveArtifactPath(manifest.artifactRoot, contract.relativePath),
    CONTRACT_FLAG_MOD_SHA256,
    mod.sha256,
    CONTRACT_FLAG_CORE_SHA256,
    core.sha256,
    resolveArtifactPath(manifest.artifactRoot, mod.relativePath),
    resolveArtifactPath(manifest.artifactRoot, core.relativePath),
  ]);
}

/**
 * Execute the compiled contract as a bounded child process with `shell:
 * false`. The executable and the exact arguments are deterministic; output
 * is capped and a wall-clock timeout fail-closes a hung contract.
 */
function runContractProcess(manifest, contractDefinition, options) {
  const args = contractArguments(manifest, contractDefinition.id);
  return new Promise((resolve) => {
    let child;
    try {
      child = options.spawnCommand(options.dotnetCommand, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        executed: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        spawnError: error instanceof Error ? error.message : "spawn_error",
      });
      return;
    }
    let settled = false;
    let stdout = "";
    let stderr = "";
    const append = (chunk, sink) => {
      if (sink.length < options.maxOutputBytes) {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        return text.slice(0, options.maxOutputBytes - sink.length);
      }
      return sink;
    };
    if (child.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", (chunk) => { stdout = append(chunk, stdout); });
    }
    if (child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => { stderr = append(chunk, stderr); });
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { if (typeof child.kill === "function") child.kill(); } catch { /* best-effort */ }
      resolve({
        executed: false,
        exitCode: null,
        signal: null,
        timedOut: true,
        stdout,
        stderr,
        spawnError: null,
      });
    }, options.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    const onError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        executed: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout,
        stderr,
        spawnError: error instanceof Error ? error.message : "spawn_error",
      });
    };
    const onClose = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        executed: true,
        exitCode,
        signal,
        timedOut: false,
        stdout,
        stderr,
        spawnError: null,
      });
    };
    if (typeof child.once === "function") {
      child.once("error", onError);
      child.once("close", onClose);
    } else {
      // A non-conforming spawn seam still settles deterministically.
      queueMicrotask(() => onClose(0, null));
    }
  });
}

function notRunCheck(index) {
  return freeze({
    id: PRODUCTION_CHECKS[index].id,
    kind: PRODUCTION_CHECKS[index].kind,
    state: "not_run",
    reasonCode: null,
  });
}

function manifestCheck() {
  return freeze({
    id: PRODUCTION_CHECKS[0].id,
    kind: PRODUCTION_CHECKS[0].kind,
    state: "passed",
    reasonCode: null,
  });
}

function contractCheck(contract) {
  let state = "passed";
  let reasonCode = null;
  if (contract.spawnError !== null) {
    state = "failed";
    reasonCode = FAILED_TARGET_PUBLICATION_CONTRACT_SPAWN;
  } else if (contract.timedOut) {
    state = "failed";
    reasonCode = FAILED_TARGET_PUBLICATION_CONTRACT_TIMEOUT;
  } else if (contract.executed && (contract.exitCode !== 0 || contract.signal !== null)) {
    state = "failed";
    reasonCode = FAILED_TARGET_PUBLICATION_CONTRACT_NONZERO;
  } else if (contract.executed && (contract.stderr.length > 0 || contract.stdout !== contract.expectedSuccessReceipt)) {
    state = "failed";
    reasonCode = FAILED_TARGET_PUBLICATION_CONTRACT_OUTPUT;
  }
  return freeze({
    id: PRODUCTION_CHECKS[4].id,
    kind: PRODUCTION_CHECKS[4].kind,
    state,
    reasonCode,
  });
}

function emptyDigestSection() {
  return freeze({ required: DIGEST_REQUIREMENTS, verified: [], mismatched: [], unreadable: [] });
}

function emptyIdentitySection() {
  return freeze({ required: IDENTITY_REQUIREMENTS, verified: [], mismatched: [] });
}

function emptyContractSection() {
  return freeze({ executions: [] });
}

function composeReport(manifest, inputId, checks, sections, executable) {
  const checksList = freeze([...checks]);
  const failing = checksList.find((check) => check.state !== "passed");
  const state = failing ? failing.state : "passed";
  const reasonCode = failing ? failing.reasonCode : TARGET_PUBLICATION_STATIC_VERIFIED;
  const report = {
    schema: PRODUCTION_REPORT_SCHEMA,
    verifierId: PRODUCTION_VERIFIER_ID,
    inputId,
    publicationId: manifest.publicationId,
    scope: TARGET_PUBLICATION_SCOPE,
    artifactRoot: manifest.artifactRoot,
    state,
    reasonCode,
    summary: {
      passed: state === "passed" ? 1 : 0,
      failed: state === "failed" ? 1 : 0,
      blocked: state === "blocked" ? 1 : 0,
      passDenominator: state === "blocked" ? 0 : 1,
    },
    artifacts: sections.artifacts,
    digests: sections.digests,
    identity: sections.identity,
    contract: deepFreeze({ ...sections.contract }),
    checks: checksList,
    integration: freeze({
      status: "package-admission-integrated",
      required: PRODUCTION_INTEGRATION_REQUIREMENTS,
    }),
  };
  return deepFreeze(validateProductionReport(report));
}

/**
 * Run the full production static verification over an admitted manifest.
 *
 * `options` seams: `exists`, `stat`, `hashFile`, `spawnCommand`,
 * `dotnetCommand`, `timeoutMs`, `inputId`. The default spawn seam is
 * `node:child_process` `spawn` with `shell: false`.
 */
export async function verifyTargetPublication(manifest, options = {}) {
  const resolved = normalizeOptions(options);
  const inputId = typeof resolved.inputId === "string" && resolved.inputId.length > 0
    ? resolved.inputId
    : manifest.publicationId;

  const closure = checkArtifactClosure(manifest, resolved);
  const checks = [manifestCheck()];
  if (closure.state !== "passed") {
    return composeReport(manifest, inputId, [
      ...checks,
      closure.check,
      notRunCheck(2),
      notRunCheck(3),
      notRunCheck(4),
    ], {
      artifacts: closure.section,
      digests: emptyDigestSection(),
      identity: emptyIdentitySection(),
      contract: emptyContractSection(),
    }, resolved.dotnetCommand);
  }
  checks.push(closure.check);

  const digests = checkArtifactDigests(manifest, resolved);
  if (digests.state !== "passed") {
    return composeReport(manifest, inputId, [
      ...checks,
      digests.check,
      notRunCheck(3),
      notRunCheck(4),
    ], {
      artifacts: closure.section,
      digests: digests.section,
      identity: emptyIdentitySection(),
      contract: emptyContractSection(),
    }, resolved.dotnetCommand);
  }
  checks.push(digests.check);

  const identity = checkIdentityProvenance(manifest);
  if (identity.state !== "passed") {
    return composeReport(manifest, inputId, [
      ...checks,
      identity.check,
      notRunCheck(4),
    ], {
      artifacts: closure.section,
      digests: digests.section,
      identity: identity.section,
      contract: emptyContractSection(),
    }, resolved.dotnetCommand);
  }
  checks.push(identity.check);

  const executions = [];
  let finalCheck;
  for (const definition of CONTRACTS) {
    const processResult = await runContractProcess(manifest, definition, resolved);
    const contract = { ...processResult, expectedSuccessReceipt: definition.successReceipt };
    executions.push(freeze({
      id: definition.id,
      executed: contract.executed,
      executable: resolved.dotnetCommand,
      shell: false,
      exitCode: contract.executed ? contract.exitCode : null,
      signal: contract.executed ? contract.signal : null,
      timeout: contract.timedOut,
      args: contract.executed || contract.spawnError !== null || contract.timedOut
        ? contractArguments(manifest, definition.id)
        : [],
      stderr: contract.stderr,
      successReceipt: contract.executed && contract.exitCode === 0 && contract.stderr.length === 0 && contract.stdout === definition.successReceipt
        ? definition.successReceipt
        : "",
    }));
    finalCheck = contractCheck(contract);
    if (finalCheck.state !== "passed") break;
  }
  const contractSection = freeze({ executions: freeze(executions) });
  return composeReport(manifest, inputId, [
    ...checks,
    finalCheck,
  ], {
    artifacts: closure.section,
    digests: digests.section,
    identity: identity.section,
    contract: contractSection,
  }, resolved.dotnetCommand);
}

function manifestFailureReport(inputId, reasonCode) {
  const check = freeze({
    id: PRODUCTION_CHECKS[0].id,
    kind: PRODUCTION_CHECKS[0].kind,
    state: reasonCode === BLOCKED_MISSING_TARGET_PUBLICATION_MANIFEST ? "blocked" : "failed",
    reasonCode,
  });
  const report = {
    schema: PRODUCTION_REPORT_SCHEMA,
    verifierId: PRODUCTION_VERIFIER_ID,
    inputId,
    publicationId: null,
    scope: TARGET_PUBLICATION_SCOPE,
    artifactRoot: "",
    state: check.state,
    reasonCode,
    summary: {
      passed: 0,
      failed: check.state === "failed" ? 1 : 0,
      blocked: check.state === "blocked" ? 1 : 0,
      passDenominator: 0,
    },
    artifacts: freeze({ required: PUBLICATION_ARTIFACTS, present: [], missing: [], unusable: [] }),
    digests: emptyDigestSection(),
    identity: emptyIdentitySection(),
    contract: emptyContractSection(),
    checks: freeze([check, notRunCheck(1), notRunCheck(2), notRunCheck(3), notRunCheck(4)]),
    integration: freeze({
      status: "package-admission-integrated",
      required: PRODUCTION_INTEGRATION_REQUIREMENTS,
    }),
  };
  return deepFreeze(validateProductionReport(report));
}

/**
 * Report for a manifest that could not be found at its declared location.
 * This is the named `blocked` evidence; it requests no target build.
 */
export function createBlockedManifestReport(inputId) {
  return manifestFailureReport(inputId, BLOCKED_MISSING_TARGET_PUBLICATION_MANIFEST);
}

/**
 * Report for a manifest that was found but failed JSON parsing or schema
 * admission. The caller passes the exact named reason code.
 */
export function createMalformedManifestReport(inputId, reasonCode) {
  if (reasonCode !== FAILED_TARGET_PUBLICATION_MANIFEST_MALFORMED && reasonCode !== FAILED_TARGET_PUBLICATION_MANIFEST_SCHEMA) {
    throw new TypeError("stardew_static_verifier_invalid_manifest_failure_reason");
  }
  return manifestFailureReport(inputId, reasonCode);
}