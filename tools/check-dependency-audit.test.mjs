/**
 * The audit gate separates "we are not affected" from "nobody looked".
 *
 * Every case runs the real script over a saved `pnpm audit --json` report, so nothing here
 * re-implements the classifier: a fixture that re-derives the rule can disagree with it, and then
 * it is worse than no fixture. The report shapes are the ones pnpm actually emits, copied from a
 * live run - `dev: true` when every path is through `devDependencies`, `dev: false` when a path
 * reaches `dependencies`, and the registry failure as `{"error":{"code":"pnpm",...}}`.
 *
 * Each case owns its assessment file, so the verdict is a property of the case rather than of the
 * repository's current alert.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyReport, judge, readAssessments } from "./check-dependency-audit.mjs";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "check-dependency-audit.mjs");

const LONG_REASON =
  "development-only: every path reaches it through dependency-cruiser's own parser, which no shipped artifact imports";

/** One advisory in the shape `pnpm audit --json` reports. */
function advisory({ ghsa, pkg, severity, dev, paths }) {
  return {
    findings: [{ version: "1.2.3", paths, dev, optional: false, bundled: false }],
    id: Number(ghsa.replace(/\D/gu, "")),
    title: `${pkg} advisory`,
    module_name: pkg,
    vulnerable_versions: "<1.2.4",
    patched_versions: ">=1.2.4",
    severity,
    cwe: "CWE-000",
    github_advisory_id: ghsa,
    url: `https://github.com/advisories/${ghsa}`,
  };
}

const RUNTIME = advisory({
  ghsa: "GHSA-aaaa-bbbb-cccc",
  pkg: "shipped-thing",
  severity: "high",
  dev: false,
  paths: ["host>shipped-thing"],
});
const DEVELOPMENT = advisory({
  ghsa: "GHSA-dddd-eeee-ffff",
  pkg: "tooling-thing",
  severity: "moderate",
  dev: true,
  paths: [".>linter>tooling-thing"],
});
/** The same package reached both ways: the runtime path is what decides its class. */
const BOTH_WAYS = advisory({
  ghsa: "GHSA-gggg-hhhh-iiii",
  pkg: "both-ways",
  severity: "critical",
  dev: false,
  paths: ["host>both-ways"],
});
const BOTH_WAYS_DEV = advisory({
  ghsa: "GHSA-jjjj-kkkk-llll",
  pkg: "both-ways",
  severity: "critical",
  dev: true,
  paths: [".>knip>both-ways"],
});

const FULL_REPORT = { advisories: { 1111: RUNTIME, 2222: DEVELOPMENT, 3333: BOTH_WAYS, 4444: BOTH_WAYS_DEV } };

/** A fixture root: its own assessment file and one saved report per named case. */
function fixture({ assessments = [], reports = {} }) {
  const root = mkdtempSync(join(tmpdir(), "dependency-audit-"));
  mkdirSync(join(root, "security"), { recursive: true });
  writeFileSync(
    join(root, "security", "dependency-audit-assessments.json"),
    `${JSON.stringify({ assessments }, null, 2)}\n`,
  );
  writeFileSync(join(root, "full.json"), `${JSON.stringify(FULL_REPORT)}\n`);
  for (const [name, report] of Object.entries(reports))
    writeFileSync(join(root, `${name}.json`), `${JSON.stringify(report)}\n`);
  return root;
}

/** Runs the real gate as a process; a non-zero verdict is a result, not a harness failure. */
function gate({ root, report = "full" }) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, "--root", root, "--audit", join(root, `${report}.json`)], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

const ASSESS_RUNTIME = { ghsa: RUNTIME.github_advisory_id, severity: "high", reason: LONG_REASON };
const ASSESS_BOTH = { ghsa: BOTH_WAYS.github_advisory_id, severity: "critical", reason: LONG_REASON };

test("audit.1: a runtime advisory with no assessment fails, and the violation names it", () => {
  const result = gate({ root: fixture({ assessments: [] }) });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^dependency_audit failed runtime=2 development=2 critical=2 high=1 /mu);
  assert.match(result.stderr, /unassessed_runtime_advisory: GHSA-aaaa-bbbb-cccc shipped-thing high/u);
  assert.match(result.stderr, /unassessed_runtime_advisory: GHSA-gggg-hhhh-iiii both-ways critical/u);
  // The development advisory is counted, never listed as a violation.
  assert.doesNotMatch(result.stderr, /GHSA-dddd-eeee-ffff/u);
});

test("audit.2: assessing every runtime advisory passes and names the development one", () => {
  const result = gate({ root: fixture({ assessments: [ASSESS_RUNTIME, ASSESS_BOTH] }) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^dependency_audit passed runtime=2 development=2 /mu);
  assert.match(result.stdout, /assessed=2 unassessed=0/u);
  assert.match(result.stdout, /development_only GHSA-dddd-eeee-ffff tooling-thing moderate/u);
});

test("audit.3: a report holding only development advisories passes with no assessment at all", () => {
  const result = gate({
    root: fixture({ assessments: [], reports: { dev: { advisories: { 2222: DEVELOPMENT, 4444: BOTH_WAYS_DEV } } } }),
    report: "dev",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^dependency_audit passed runtime=0 development=2 /mu);
  assert.match(result.stdout, /development_only GHSA-jjjj-kkkk-llll both-ways critical/u);
});

test("audit.4: a stale assessment fails, so an entry cannot outlive its advisory", () => {
  const result = gate({
    root: fixture({
      assessments: [ASSESS_RUNTIME, ASSESS_BOTH, { ghsa: "GHSA-zzzz-yyyy-xxxx", severity: "low", reason: LONG_REASON }],
    }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stale_assessment: GHSA-zzzz-yyyy-xxxx no advisory in the audit carries this id/u);
});

test("audit.5: an assessment naming the wrong severity cannot discharge the advisory", () => {
  const result = gate({
    root: fixture({ assessments: [{ ...ASSESS_RUNTIME, severity: "low" }, ASSESS_BOTH] }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /assessment_severity_mismatch: GHSA-aaaa-bbbb-cccc recorded=low audited=high/u);
});

test("audit.6: a shrug is not a reason, and neither is an empty field", () => {
  for (const reason of [
    "accepted risk",
    "n/a",
    "known issue, accepted risk for now, revisit never",
    "accepted risk because it is a development-only dependency of the linter",
    "safe",
    "",
  ]) {
    const { problems } = readAssessments({
      assessments: [{ ghsa: "GHSA-aaaa-bbbb-cccc", severity: "high", reason }],
    });
    assert.deepEqual(
      problems.map((problem) => problem.code),
      ["assessment_unexplained"],
      reason,
    );
  }
  assert.deepEqual(readAssessments({ assessments: [ASSESS_RUNTIME] }).problems, []);
});

test("audit.7: a duplicate id and an unknown severity are both violations", () => {
  const { problems } = readAssessments({
    assessments: [
      ASSESS_RUNTIME,
      ASSESS_RUNTIME,
      { ghsa: "GHSA-dddd-eeee-ffff", severity: "severe", reason: LONG_REASON },
    ],
  });
  assert.deepEqual(
    problems.map((problem) => problem.code),
    ["assessment_duplicate", "assessment_malformed"],
  );
});

test("audit.8: a report with no advisories object is a run failure, not an empty clean scan", () => {
  assert.throws(
    () => classifyReport({ error: { code: "pnpm", message: "fetch failed" } }),
    /the audit report has no `advisories` object; the scan did not run/u,
  );
});

test("audit.9: one package reached both ways is classified by its runtime path", () => {
  const advisories = classifyReport(FULL_REPORT);
  const runtime = advisories.find((candidate) => candidate.ghsa === BOTH_WAYS.github_advisory_id);
  assert.equal(runtime.runtime, true);
  assert.deepEqual(runtime.paths, ["host>both-ways"]);
  assert.equal(advisories.find((candidate) => candidate.ghsa === DEVELOPMENT.github_advisory_id).runtime, false);
});

test("audit.10: the summary counts every severity, worst first", () => {
  const result = gate({ root: fixture({ assessments: [ASSESS_RUNTIME, ASSESS_BOTH] }) });
  assert.match(result.stdout, /critical=2 high=1 moderate=1 low=0 info=0 assessed=2 unassessed=0/u);
});

test("audit.11: an unassessed advisory prints the patched version a reader needs", () => {
  const result = gate({ root: fixture({ assessments: [] }) });
  assert.match(result.stderr, /versions=1\.2\.3 vulnerable=<1\.2\.4 patched=>=1\.2\.4/u);
  assert.match(result.stderr, /via host>shipped-thing/u);
});

test("audit.12: judge on an empty population with no assessments is a pass", () => {
  const verdict = judge({ advisories: [], assessments: [] });
  assert.equal(verdict.verdict, "passed");
  assert.equal(verdict.runtime, 0);
  assert.equal(verdict.unassessed, 0);
});
