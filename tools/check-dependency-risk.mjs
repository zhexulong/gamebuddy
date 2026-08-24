#!/usr/bin/env node
/**
 * P3.4 dependency advisory/disposition gate. This checker is deliberately
 * conservative: it validates the frozen snapshot, recomputes lock hashes, and
 * never treats a proposal as an approval. No scanner cache or secret is read.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const LOCKFILE_PATHS = Object.freeze([
  "pnpm-lock.yaml",
  "vendor/magic-context/bun.lock",
  "integrations/stardew/packages.lock.json",
]);
export const VALID_SCOPES = Object.freeze(["runtime", "build", "test", "external-not-distributed"]);
export const VALID_STATUSES = Object.freeze(["fixed", "not_affected", "mitigated", "proposed_acceptance", "accepted"]);
export const BLOCKING_STATUSES = Object.freeze([
  "proposed_acceptance",
  "fixed",
  "not_affected",
  "mitigated",
  "accepted",
]);
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const PURL_RE = /^pkg:[^\s]+$/;
// JSON Schema's date-time format is RFC 3339. Date.parse accepts many values
// outside that grammar (for example, date-only strings), so validate both the
// lexical form and the calendar/time ranges here instead of relying on a
// schema validator's optional format implementation.
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;
const ECOSYSTEMS = new Set(["npm", "bun", "nuget", "other"]);
const SEVERITIES = new Set(["critical", "high", "moderate", "low", "unknown"]);

const rootFromModule = resolve(import.meta.dirname, "..");
const _absentLockHash = Object.fromEntries(LOCKFILE_PATHS.map((path) => [path, null]));

function issue(code, detail) {
  return { code, detail };
}
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function string(value, field, issues, { max = 4096 } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    issues.push(issue("invalid_field", `${field} must be a non-empty string`));
    return false;
  }
  return true;
}
function exactKeys(value, keys, field, issues) {
  if (!isObject(value)) {
    issues.push(issue("invalid_field", `${field} must be an object`));
    return false;
  }
  const expected = new Set(keys);
  for (const key of Object.keys(value)) if (!expected.has(key)) issues.push(issue("unknown_field", `${field}.${key}`));
  for (const key of keys) if (!Object.hasOwn(value, key)) issues.push(issue("missing_field", `${field}.${key}`));
  return true;
}
function validDate(value, field, issues) {
  // The schemas specify only format: date-time, with no maxLength.
  if (typeof value !== "string" || value.length === 0) {
    issues.push(issue("invalid_date", field));
    return;
  }
  const match = DATE_TIME_RE.exec(value);
  if (!match) {
    issues.push(issue("invalid_date", field));
    return;
  }
  const [, year, month, day, hour, minute, second, , offsetSign, offsetHour, offsetMinute] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const daysInMonth =
    monthNumber === 2
      ? Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0)
        ? 29
        : 28
      : [4, 6, 9, 11].includes(monthNumber)
        ? 30
        : 31;
  const validCalendar = monthNumber >= 1 && monthNumber <= 12 && dayNumber >= 1 && dayNumber <= daysInMonth;
  const validClock = Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59;
  const validOffset = !offsetSign || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59);
  if (!validCalendar || !validClock || !validOffset) issues.push(issue("invalid_date", field));
}
function validatePurl(value, field, issues) {
  // The schemas constrain purls by pattern, but intentionally do not impose a
  // separate maxLength; retain that exact contract here.
  if (typeof value !== "string" || value.length === 0 || !PURL_RE.test(value))
    issues.push(issue("invalid_purl", field));
}
function validateStringArray(value, field, issues, { max }) {
  if (!Array.isArray(value) || value.length < 1) {
    issues.push(issue("invalid_array", `${field} must contain at least one item`));
    return false;
  }
  value.forEach((item, index) => string(item, `${field}[${index}]`, issues, { max }));
  return true;
}
function validateHashes(value, field, issues) {
  if (!exactKeys(value, LOCKFILE_PATHS, field, issues)) return false;
  for (const path of LOCKFILE_PATHS) {
    const hash = value[path];
    if (hash !== null && (typeof hash !== "string" || !HASH_RE.test(hash)))
      issues.push(issue("invalid_lock_hash", `${field}.${path}`));
  }
  return true;
}
function validateUniqueAdvisoryIds(items, field, duplicateCode, issues) {
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    if (!isObject(item) || typeof item.advisoryId !== "string") continue;
    if (seen.has(item.advisoryId))
      issues.push(issue(duplicateCode, `${field}[${index}].advisoryId:${item.advisoryId}`));
    seen.add(item.advisoryId);
  }
}

export function validateSnapshot(snapshot) {
  const issues = [];
  if (
    !exactKeys(
      snapshot,
      ["schemaVersion", "artifactKind", "snapshotId", "generatedAt", "scanner", "lockfiles", "advisories"],
      "snapshot",
      issues,
    )
  )
    return issues;
  if (snapshot.schemaVersion !== 1) issues.push(issue("unsupported_schema", "snapshot.schemaVersion"));
  if (snapshot.artifactKind !== "dependency_advisory_snapshot")
    issues.push(issue("invalid_artifact_kind", "snapshot.artifactKind"));
  if (typeof snapshot.snapshotId !== "string" || !ID_RE.test(snapshot.snapshotId))
    issues.push(issue("invalid_snapshot_id", "snapshot.snapshotId"));
  validDate(snapshot.generatedAt, "snapshot.generatedAt", issues);
  if (!exactKeys(snapshot.scanner, ["identity", "version", "status", "command"], "snapshot.scanner", issues))
    return issues;
  string(snapshot.scanner.identity, "snapshot.scanner.identity", issues, { max: 128 });
  string(snapshot.scanner.version, "snapshot.scanner.version", issues, { max: 64 });
  string(snapshot.scanner.command, "snapshot.scanner.command", issues, { max: 256 });
  if (!["complete", "unavailable", "unknown_blocking"].includes(snapshot.scanner.status))
    issues.push(issue("invalid_scanner_status", "snapshot.scanner.status"));
  if (!exactKeys(snapshot.lockfiles, LOCKFILE_PATHS, "snapshot.lockfiles", issues)) return issues;
  for (const path of LOCKFILE_PATHS) {
    const identity = snapshot.lockfiles[path];
    if (!exactKeys(identity, ["present", "sha256"], `snapshot.lockfiles.${path}`, issues)) continue;
    if (typeof identity.present !== "boolean")
      issues.push(issue("invalid_field", `snapshot.lockfiles.${path}.present`));
    if (identity.sha256 !== null && (typeof identity.sha256 !== "string" || !HASH_RE.test(identity.sha256)))
      issues.push(issue("invalid_lock_hash", `snapshot.lockfiles.${path}.sha256`));
    if (identity.present && identity.sha256 === null) issues.push(issue("missing_lock_hash", path));
    if (!identity.present && identity.sha256 !== null) issues.push(issue("mismatched_lock_identity", path));
  }
  if (!Array.isArray(snapshot.advisories)) issues.push(issue("invalid_field", "snapshot.advisories"));
  else {
    snapshot.advisories.forEach((advisory, index) =>
      validateAdvisory(advisory, `snapshot.advisories[${index}]`, issues),
    );
    validateUniqueAdvisoryIds(snapshot.advisories, "snapshot.advisories", "duplicate_advisory_id", issues);
  }
  return issues;
}

function validateAdvisory(advisory, field, issues) {
  const fields = [
    "advisoryId",
    "ecosystem",
    "package",
    "purl",
    "affectedVersion",
    "severity",
    "fixedVersion",
    "scope",
    "dependencyPath",
    "reachabilityEvidence",
    "lockfileHashes",
    "scannerIdentity",
    "status",
  ];
  if (!exactKeys(advisory, fields, field, issues)) return issues;
  for (const name of ["advisoryId", "package", "affectedVersion", "scannerIdentity"])
    string(advisory[name], `${field}.${name}`, issues, {
      max: name === "scannerIdentity" ? 128 : name === "affectedVersion" ? 128 : 256,
    });
  validatePurl(advisory.purl, `${field}.purl`, issues);
  if (!ECOSYSTEMS.has(advisory.ecosystem)) issues.push(issue("invalid_ecosystem", `${field}.ecosystem`));
  if (!SEVERITIES.has(advisory.severity)) issues.push(issue("invalid_severity", `${field}.severity`));
  if (advisory.fixedVersion !== null) string(advisory.fixedVersion, `${field}.fixedVersion`, issues, { max: 128 });
  if (!VALID_SCOPES.includes(advisory.scope)) issues.push(issue("invalid_scope", `${field}.scope`));
  validateStringArray(advisory.dependencyPath, `${field}.dependencyPath`, issues, { max: 256 });
  if (!validateStringArray(advisory.reachabilityEvidence, `${field}.reachabilityEvidence`, issues, { max: 1024 })) {
    issues.push(issue("missing_reachability_evidence", field));
  }
  validateHashes(advisory.lockfileHashes, `${field}.lockfileHashes`, issues);
  if (!VALID_STATUSES.includes(advisory.status)) issues.push(issue("invalid_status", `${field}.status`));
  return issues;
}

function validateAcceptances(acceptances) {
  const issues = [];
  if (
    !exactKeys(
      acceptances,
      ["schemaVersion", "artifactKind", "snapshotId", "lockfileHashes", "records"],
      "acceptances",
      issues,
    )
  )
    return issues;
  if (acceptances.schemaVersion !== 1) issues.push(issue("unsupported_schema", "acceptances.schemaVersion"));
  if (acceptances.artifactKind !== "dependency_risk_acceptances")
    issues.push(issue("invalid_artifact_kind", "acceptances.artifactKind"));
  if (typeof acceptances.snapshotId !== "string" || !ID_RE.test(acceptances.snapshotId))
    issues.push(issue("invalid_snapshot_id", "acceptances.snapshotId"));
  validateHashes(acceptances.lockfileHashes, "acceptances.lockfileHashes", issues);
  if (!Array.isArray(acceptances.records)) issues.push(issue("invalid_field", "acceptances.records"));
  else {
    acceptances.records.forEach((record, index) => validateAcceptance(record, `acceptances.records[${index}]`, issues));
    validateUniqueAdvisoryIds(acceptances.records, "acceptances.records", "duplicate_acceptance_advisory_id", issues);
  }
  return issues;
}

function validateAcceptance(record, field, issues) {
  const fields = [
    "advisoryId",
    "package",
    "purl",
    "affectedVersion",
    "resolvedVersion",
    "severity",
    "scope",
    "dependencyPath",
    "scannerIdentity",
    "lockfileHashes",
    "status",
    "owner",
    "approvalAuthority",
    "approvalEvidence",
    "rationale",
    "mitigation",
    "verificationCommand",
    "createdAt",
    "expiresAt",
    "reviewBy",
  ];
  if (!exactKeys(record, fields, field, issues)) return issues;
  for (const name of [
    "advisoryId",
    "package",
    "affectedVersion",
    "resolvedVersion",
    "scannerIdentity",
    "owner",
    "approvalAuthority",
    "approvalEvidence",
    "rationale",
    "mitigation",
    "verificationCommand",
  ]) {
    const max =
      name === "advisoryId" || name === "package"
        ? 256
        : name === "affectedVersion" || name === "resolvedVersion"
          ? 128
          : name === "scannerIdentity" || name === "owner" || name === "approvalAuthority"
            ? 256
            : name === "approvalEvidence"
              ? 1024
              : name === "verificationCommand"
                ? 512
                : 4096;
    string(record[name], `${field}.${name}`, issues, { max });
  }
  validatePurl(record.purl, `${field}.purl`, issues);
  if (!SEVERITIES.has(record.severity)) issues.push(issue("invalid_severity", `${field}.severity`));
  if (!VALID_SCOPES.includes(record.scope)) issues.push(issue("invalid_scope", `${field}.scope`));
  validateStringArray(record.dependencyPath, `${field}.dependencyPath`, issues, { max: 256 });
  validateHashes(record.lockfileHashes, `${field}.lockfileHashes`, issues);
  if (record.status !== "proposed_acceptance")
    issues.push(issue("accepted_status_rejected", `${field}.status; external approval authority is not implemented`));
  for (const name of ["createdAt", "expiresAt", "reviewBy"]) validDate(record[name], `${field}.${name}`, issues);
  return issues;
}

async function hashLocks(root, read = readFile) {
  const hashes = {};
  for (const relative of LOCKFILE_PATHS) {
    try {
      const content = await read(resolve(root, relative));
      hashes[relative] = createHash("sha256").update(content).digest("hex");
    } catch (error) {
      if (error?.code === "ENOENT") hashes[relative] = null;
      else throw error;
    }
  }
  return hashes;
}
function sameHashes(actual, declared) {
  return LOCKFILE_PATHS.every((path) => actual[path] === declared[path]);
}

export async function checkDependencyRisk({
  root = rootFromModule,
  snapshot,
  acceptances,
  read = readFile,
  now = new Date(),
} = {}) {
  const issues = [...validateSnapshot(snapshot), ...validateAcceptances(acceptances)];
  if (issues.length) return { verdict: "blocked", exitCode: 1, issues };
  if (snapshot.snapshotId !== acceptances.snapshotId) issues.push(issue("snapshot_identity_mismatch", "snapshotId"));
  const actualHashes = await hashLocks(root, read);
  if (
    !sameHashes(actualHashes, Object.fromEntries(LOCKFILE_PATHS.map((path) => [path, snapshot.lockfiles[path].sha256])))
  )
    issues.push(issue("mismatched_lock_identity", "snapshot.lockfiles"));
  if (!sameHashes(actualHashes, acceptances.lockfileHashes))
    issues.push(issue("mismatched_lock_identity", "acceptances.lockfileHashes"));
  if (snapshot.scanner.status !== "complete")
    issues.push(issue("scanner_unavailable_or_unknown", snapshot.scanner.status));
  const advisoryById = new Map(snapshot.advisories.map((advisory) => [advisory.advisoryId, advisory]));
  for (const advisory of snapshot.advisories) {
    if (advisory.scannerIdentity !== snapshot.scanner.identity)
      issues.push(issue("scanner_identity_mismatch", advisory.advisoryId));
    if (BLOCKING_STATUSES.includes(advisory.status)) {
      const code = advisory.status === "proposed_acceptance" ? "unresolved_advisory" : "unverified_disposition_status";
      issues.push(
        issue(code, `${advisory.advisoryId}:${advisory.status}; no signed/verified disposition evidence exists`),
      );
    }
    if (
      !sameHashes(
        advisory.lockfileHashes,
        Object.fromEntries(LOCKFILE_PATHS.map((path) => [path, snapshot.lockfiles[path].sha256])),
      ) ||
      !sameHashes(advisory.lockfileHashes, actualHashes)
    ) {
      issues.push(issue("advisory_lockfile_mismatch", advisory.advisoryId));
    }
  }
  for (const record of acceptances.records) {
    const advisory = advisoryById.get(record.advisoryId);
    if (!advisory) issues.push(issue("acceptance_advisory_missing", record.advisoryId));
    else {
      for (const field of ["package", "purl", "affectedVersion", "severity", "scope", "scannerIdentity"])
        if (record[field] !== advisory[field])
          issues.push(issue("acceptance_binding_mismatch", `${record.advisoryId}.${field}`));
      if (advisory.status !== "proposed_acceptance")
        issues.push(issue("acceptance_binding_mismatch", `${record.advisoryId}.status`));
      if (JSON.stringify(record.dependencyPath) !== JSON.stringify(advisory.dependencyPath))
        issues.push(issue("acceptance_binding_mismatch", `${record.advisoryId}.dependencyPath`));
      if (
        !sameHashes(
          record.lockfileHashes,
          Object.fromEntries(LOCKFILE_PATHS.map((path) => [path, snapshot.lockfiles[path].sha256])),
        )
      )
        issues.push(issue("acceptance_binding_mismatch", `${record.advisoryId}.lockfileHashes`));
    }
    if (record.status === "proposed_acceptance") issues.push(issue("proposed_acceptance_blocking", record.advisoryId));
    if (record.status === "accepted") issues.push(issue("accepted_status_rejected", record.advisoryId));
    if (Date.parse(record.expiresAt) <= now.getTime() || Date.parse(record.reviewBy) <= now.getTime())
      issues.push(issue("expired_acceptance", record.advisoryId));
  }
  return {
    verdict: issues.length ? "blocked" : "passed",
    exitCode: issues.length ? 1 : 0,
    issues,
    lockfileHashes: actualHashes,
  };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const wrapped = new Error(`invalid JSON input: ${path}`);
    wrapped.code = "INPUT";
    wrapped.cause = error;
    throw wrapped;
  }
}
if (import.meta.main) {
  try {
    const snapshot = await readJson(resolve(rootFromModule, "security/dependency-advisories.json"));
    const acceptances = await readJson(resolve(rootFromModule, "security/dependency-risk-acceptances.json"));
    const report = await checkDependencyRisk({ snapshot, acceptances });
    console.log(JSON.stringify({ verdict: report.verdict, exitCode: report.exitCode, issues: report.issues }, null, 2));
    process.exitCode = report.exitCode;
  } catch (error) {
    console.error(
      JSON.stringify({ verdict: "blocked", exitCode: 2, issues: [{ code: "invalid_input", detail: error.message }] }),
    );
    process.exitCode = 2;
  }
}
