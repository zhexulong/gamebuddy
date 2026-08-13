import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkDependencyRisk, LOCKFILE_PATHS } from "./check-dependency-risk.mjs";

const bytes = Object.fromEntries(LOCKFILE_PATHS.map((path) => [path, `fixture:${path}`]));
const hashes = Object.fromEntries(
  LOCKFILE_PATHS.map((path) => [path, createHash("sha256").update(bytes[path]).digest("hex")]),
);
const read = async (path) => {
  const relative = path.replaceAll("\\", "/").split("/").slice(-3).join("/");
  const key = LOCKFILE_PATHS.find((candidate) => relative.endsWith(candidate));
  if (!key) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  return Buffer.from(bytes[key]);
};
function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactKind: "dependency_advisory_snapshot",
    snapshotId: "fixture-v1",
    generatedAt: "2025-01-01T00:00:00Z",
    scanner: { identity: "fixture-scanner", version: "1", status: "complete", command: "fixture" },
    lockfiles: Object.fromEntries(LOCKFILE_PATHS.map((path) => [path, { present: true, sha256: hashes[path] }])),
    advisories: [],
    ...overrides,
  };
}
function acceptances(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactKind: "dependency_risk_acceptances",
    snapshotId: "fixture-v1",
    lockfileHashes: hashes,
    records: [],
    ...overrides,
  };
}
async function check(s = snapshot(), a = acceptances()) {
  return checkDependencyRisk({ root: ".", snapshot: s, acceptances: a, read, now: new Date("2025-01-10T00:00:00Z") });
}
function has(report, code) {
  return report.issues.some((item) => item.code === code);
}

test("passes a complete, hash-bound snapshot with no unresolved advisories", async () => {
  const report = await check();
  assert.equal(report.verdict, "passed");
  assert.equal(report.exitCode, 0);
});

test("scanner absence or unknown status is blocking", async () => {
  for (const status of ["unavailable", "unknown_blocking"]) {
    const report = await check(snapshot({ scanner: { ...snapshot().scanner, status } }));
    assert.equal(report.exitCode, 1);
    assert.ok(has(report, "scanner_unavailable_or_unknown"));
  }
});

test("missing, expired, or mismatched lock identity is blocking", async () => {
  const missing = snapshot({
    lockfiles: { ...snapshot().lockfiles, "pnpm-lock.yaml": { present: true, sha256: null } },
  });
  assert.ok(has(await check(missing), "missing_lock_hash"));
  const mismatched = acceptances({ lockfileHashes: { ...hashes, "pnpm-lock.yaml": "0".repeat(64) } });
  assert.ok(has(await check(snapshot(), mismatched), "mismatched_lock_identity"));
  const expired = {
    advisoryId: "GHSA-fixture",
    package: "fixture",
    purl: "pkg:npm/fixture@1.0.0",
    affectedVersion: "1.0.0",
    resolvedVersion: "1.0.0",
    severity: "high",
    scope: "runtime",
    dependencyPath: ["fixture"],
    scannerIdentity: "fixture-scanner",
    lockfileHashes: hashes,
    status: "proposed_acceptance",
    owner: "security",
    approvalAuthority: "none",
    approvalEvidence: "proposal only",
    rationale: "fixture",
    mitigation: "fixture",
    verificationCommand: "fixture",
    createdAt: "2025-01-01T00:00:00Z",
    expiresAt: "2025-01-02T00:00:00Z",
    reviewBy: "2025-01-02T00:00:00Z",
  };
  const report = await check(
    snapshot({ advisories: [{ ...advisoryFixture(), status: "proposed_acceptance" }] }),
    acceptances({ records: [expired] }),
  );
  assert.ok(has(report, "expired_acceptance"));
});
function advisoryFixture(overrides = {}) {
  return {
    advisoryId: "GHSA-fixture",
    ecosystem: "npm",
    package: "fixture",
    purl: "pkg:npm/fixture@1.0.0",
    affectedVersion: "1.0.0",
    severity: "high",
    fixedVersion: null,
    scope: "runtime",
    dependencyPath: ["fixture"],
    reachabilityEvidence: ["fixture evidence"],
    lockfileHashes: hashes,
    scannerIdentity: "fixture-scanner",
    status: "proposed_acceptance",
    ...overrides,
  };
}
function acceptanceFixture(advisory = advisoryFixture(), overrides = {}) {
  return {
    advisoryId: advisory.advisoryId,
    package: advisory.package,
    purl: advisory.purl,
    affectedVersion: advisory.affectedVersion,
    resolvedVersion: advisory.affectedVersion,
    severity: advisory.severity,
    scope: advisory.scope,
    dependencyPath: advisory.dependencyPath,
    scannerIdentity: advisory.scannerIdentity,
    lockfileHashes: hashes,
    status: "proposed_acceptance",
    owner: "security",
    approvalAuthority: "pending",
    approvalEvidence: "proposal",
    rationale: "fixture",
    mitigation: "fixture",
    verificationCommand: "fixture",
    createdAt: "2025-01-01T00:00:00Z",
    expiresAt: "2025-01-20T00:00:00Z",
    reviewBy: "2025-01-15T00:00:00Z",
    ...overrides,
  };
}

test("invalid scope and status fail closed", async () => {
  const report = await check(snapshot({ advisories: [advisoryFixture({ scope: "unknown" })] }));
  assert.equal(report.exitCode, 1);
  assert.ok(has(report, "invalid_scope"));
  const badStatus = await check(snapshot({ advisories: [advisoryFixture({ status: "bogus" })] }));
  assert.ok(has(badStatus, "invalid_status"));
});

test("purls and dependency evidence arrays enforce their schema element constraints", async () => {
  for (const purl of ["npm:fixture@1.0.0", "pkg:npm/fixture 1.0.0", "pkg:npm/fixture@1.0.0\n"]) {
    const report = await check(snapshot({ advisories: [advisoryFixture({ purl })] }));
    assert.ok(has(report, "invalid_purl"), `expected invalid purl for ${JSON.stringify(purl)}`);
  }
  const malformedAdvisory = advisoryFixture({ dependencyPath: ["fixture", 42], reachabilityEvidence: [null] });
  const report = await check(snapshot({ advisories: [malformedAdvisory] }));
  assert.ok(report.issues.some(({ code, detail }) => code === "invalid_field" && detail.includes("dependencyPath[1]")));
  assert.ok(
    report.issues.some(({ code, detail }) => code === "invalid_field" && detail.includes("reachabilityEvidence[0]")),
  );
  const malformedAcceptance = acceptanceFixture(advisoryFixture(), {
    purl: "pkg:npm/fixture@1.0.0\t",
    dependencyPath: ["fixture", {}],
  });
  const acceptanceReport = await check(
    snapshot({ advisories: [advisoryFixture()] }),
    acceptances({ records: [malformedAcceptance] }),
  );
  assert.ok(has(acceptanceReport, "invalid_purl"));
  assert.ok(
    acceptanceReport.issues.some(
      ({ code, detail }) => code === "invalid_field" && detail.includes("dependencyPath[1]"),
    ),
  );
});

test("date-time validation is strict and rejects Date.parse-only values", async () => {
  const invalid = ["2025-01-01", "2025-02-29T00:00:00Z", "2025-01-01T24:00:00Z", "2025-01-01T00:00:00+24:00"];
  for (const createdAt of invalid) {
    const record = acceptanceFixture(advisoryFixture(), { createdAt });
    const report = await check(snapshot({ advisories: [advisoryFixture()] }), acceptances({ records: [record] }));
    assert.ok(has(report, "invalid_date"), `expected invalid date for ${createdAt}`);
  }
  const valid = acceptanceFixture(advisoryFixture(), { createdAt: "2024-02-29T23:59:59.123+05:30" });
  const report = await check(snapshot({ advisories: [advisoryFixture()] }), acceptances({ records: [valid] }));
  assert.ok(!report.issues.some(({ code, detail }) => code === "invalid_date" && detail.endsWith("createdAt")));
});

test("every disposition other than proposed_acceptance is an explicit blocking status", async () => {
  for (const status of ["fixed", "not_affected", "mitigated", "accepted"]) {
    const report = await check(snapshot({ advisories: [advisoryFixture({ status })] }));
    assert.equal(report.exitCode, 1);
    assert.ok(
      report.issues.some(
        ({ code, detail }) => code === "unverified_disposition_status" && detail.includes(`:${status};`),
      ),
    );
  }
});

test("each advisory lock hash binds to both the snapshot identity and current bytes", async () => {
  const advisory = advisoryFixture({ lockfileHashes: { ...hashes, "pnpm-lock.yaml": "0".repeat(64) } });
  const report = await check(snapshot({ advisories: [advisory] }));
  assert.ok(has(report, "advisory_lockfile_mismatch"));
});

test("duplicate advisory IDs and duplicate acceptance IDs are rejected", async () => {
  const advisory = advisoryFixture();
  const duplicateSnapshot = await check(snapshot({ advisories: [advisory, { ...advisory }] }));
  assert.equal(duplicateSnapshot.exitCode, 1);
  assert.ok(has(duplicateSnapshot, "duplicate_advisory_id"));

  const record = acceptanceFixture(advisory);
  const duplicateAcceptances = await check(
    snapshot({ advisories: [advisory] }),
    acceptances({ records: [record, { ...record }] }),
  );
  assert.equal(duplicateAcceptances.exitCode, 1);
  assert.ok(has(duplicateAcceptances, "duplicate_acceptance_advisory_id"));
});

test("acceptance records must bind one-to-one to a proposed snapshot advisory", async () => {
  const advisory = advisoryFixture();
  const missing = await check(
    snapshot({ advisories: [advisory] }),
    acceptances({ records: [acceptanceFixture(advisory, { advisoryId: "GHSA-not-in-snapshot" })] }),
  );
  assert.equal(missing.exitCode, 1);
  assert.ok(has(missing, "acceptance_advisory_missing"));

  const fixed = { ...advisory, status: "fixed" };
  const statusMismatch = await check(
    snapshot({ advisories: [fixed] }),
    acceptances({ records: [acceptanceFixture(fixed)] }),
  );
  assert.equal(statusMismatch.exitCode, 1);
  assert.ok(has(statusMismatch, "acceptance_binding_mismatch"));
});

test("accepted records are rejected because no external approval authority exists", async () => {
  const advisory = advisoryFixture({ status: "accepted" });
  const report = await check(
    snapshot({ advisories: [advisory] }),
    acceptances({
      records: [
        {
          advisoryId: advisory.advisoryId,
          package: advisory.package,
          purl: advisory.purl,
          affectedVersion: advisory.affectedVersion,
          resolvedVersion: "1.0.0",
          severity: advisory.severity,
          scope: advisory.scope,
          dependencyPath: advisory.dependencyPath,
          scannerIdentity: advisory.scannerIdentity,
          lockfileHashes: hashes,
          status: "accepted",
          owner: "security",
          approvalAuthority: "not-implemented",
          approvalEvidence: "none",
          rationale: "fixture",
          mitigation: "fixture",
          verificationCommand: "fixture",
          createdAt: "2025-01-01T00:00:00Z",
          expiresAt: "2025-01-20T00:00:00Z",
          reviewBy: "2025-01-15T00:00:00Z",
        },
      ],
    }),
  );
  assert.equal(report.exitCode, 1);
  assert.ok(has(report, "accepted_status_rejected"));
});

test("proposed acceptance remains blocking and must bind to the advisory", async () => {
  const advisory = advisoryFixture();
  const record = {
    advisoryId: advisory.advisoryId,
    package: advisory.package,
    purl: advisory.purl,
    affectedVersion: advisory.affectedVersion,
    resolvedVersion: "1.0.0",
    severity: advisory.severity,
    scope: advisory.scope,
    dependencyPath: advisory.dependencyPath,
    scannerIdentity: advisory.scannerIdentity,
    lockfileHashes: hashes,
    status: "proposed_acceptance",
    owner: "security",
    approvalAuthority: "pending",
    approvalEvidence: "proposal",
    rationale: "fixture",
    mitigation: "fixture",
    verificationCommand: "fixture",
    createdAt: "2025-01-01T00:00:00Z",
    expiresAt: "2025-01-20T00:00:00Z",
    reviewBy: "2025-01-15T00:00:00Z",
  };
  const report = await check(snapshot({ advisories: [advisory] }), acceptances({ records: [record] }));
  assert.equal(report.exitCode, 1);
  assert.ok(has(report, "proposed_acceptance_blocking"));
  assert.ok(!has(report, "acceptance_binding_mismatch"));
});

test("published reachability evidence uses the advisory's npm finding ID", async () => {
  const expectedFindingIds = {
    "GHSA-xcpc-8h2w-3j85": "1123686",
    "GHSA-f88m-g3jw-g9cj": "1124066",
  };
  const snapshot = JSON.parse(
    await readFile(new URL("../security/dependency-advisories.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(
    Object.fromEntries(
      snapshot.advisories.map(({ advisoryId, reachabilityEvidence }) => [
        advisoryId,
        [...new Set(reachabilityEvidence.map((evidence) => evidence.match(/npm advisory id (\d+)/)?.[1]))],
      ]),
    ),
    Object.fromEntries(Object.entries(expectedFindingIds).map(([advisoryId, findingId]) => [advisoryId, [findingId]])),
  );
});
