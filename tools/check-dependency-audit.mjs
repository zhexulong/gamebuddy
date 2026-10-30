#!/usr/bin/env node
/**
 * The audit gate: an advisory in a package the product ships is a decision, not a surprise.
 *
 * `pnpm audit` prints a wall of text. Nobody reads it, so nothing in this repository ever said
 * which of its advisories had been looked at and which had not - "we are not affected" and
 * "nobody looked" read identically. This gate separates them by one rule:
 *
 *   a finding is RUNTIME when at least one of its dependency paths does not cross a
 *   `devDependencies` edge (`findings[].dev === false`), and DEVELOPMENT when every path does.
 *
 * An unassessed RUNTIME advisory fails the gate. A development advisory is counted and printed,
 * never gated: it cannot reach a player, and failing on it would train the reader to ignore the
 * line that matters. The boundary is per-finding, not per-package, because one package is
 * routinely reached both ways - `zod` arrives in the shipped Host through
 * `@cortexkit/pi-magic-context` and in the tooling through `knip`, and only the first is a
 * runtime fact. A package-level rule would have to call that either "safe" or "shipped".
 *
 * What discharges an advisory is `security/dependency-audit-assessments.json`: one entry per
 * GitHub advisory id, with a `reason` that names something a reader can go and check. Three
 * rules keep a written reason from quietly rotting:
 *
 *   unassessed   a RUNTIME advisory with no entry fails.
 *   stale        an entry whose advisory no longer appears in the audit fails. A check that
 *                stays green because the thing it watched disappeared is a check that stopped
 *                working, and this is the shape an advisory "fix" takes: the version moves, the
 *                advisory vanishes, and the paragraph explaining it stays behind as evidence of
 *                a decision nobody needs to make any more.
 *   mismatched   an entry whose recorded `severity` is not the audit's severity fails, so an
 *                entry cannot describe a different advisory than the one it discharges.
 *
 * Whether a sentence is *informative* cannot be decided mechanically without rejecting honest
 * short reasons, so that is a floor plus a blocklist: a reason must be long enough to carry a
 * fact and must not be one of the shrugs ("accepted risk", "n/a", "known", "todo"). Everything
 * that passes is not thereby true; it is only not vacuous.
 *
 * Relationship to `check:dependency-risk`: that gate validates a FROZEN snapshot
 * (`security/dependency-advisories.json`) against recorded lockfile hashes, and its population is
 * whatever the snapshot says. It cannot answer "is the advisory that arrived this morning
 * assessed?" without re-snapshotting the tree. This gate answers that question and only that
 * question: it holds no snapshot and no hashes, and reads the live audit every run.
 *
 * The audit needs the registry. When it cannot be reached this gate exits 2 under its own name
 * rather than passing, because a green line from a run that could not look is the exact state
 * this gate exists to make impossible. That adds no new CI failure mode: the `gates` job that
 * runs this already resolves the whole workspace from the same registry before any gate starts,
 * so a registry outage has already failed the job by then.
 *
 * Usage:
 *   node tools/check-dependency-audit.mjs                  # the verdict; exit 1 on a violation
 *   node tools/check-dependency-audit.mjs --audit <file>   # judge a saved `pnpm audit --json` report
 *   node tools/check-dependency-audit.mjs --root <dir>     # the gate's own fixture
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSESSMENTS = "security/dependency-audit-assessments.json";

/** The severities the advisory database uses, ordered worst first so the summary reads that way. */
const SEVERITIES = ["critical", "high", "moderate", "low", "info"];

/** A reason shorter than this cannot carry a fact; it is a shrug with punctuation. */
const MIN_REASON_LENGTH = 40;

/** Openers that state a disposition instead of a fact. */
const SHUGHS = /^(?:accepted|accept|n\/?a|ok|fine|known|todo|tbd|low[- ]risk|ignore[ds]?|wontfix)(?:\W|$)/iu;

function violation(code, detail, advisory) {
  return { code, detail, advisory };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The key an assessment and an advisory meet on. Most carry a GHSA id; a few only a numeric one. */
function advisoryKey(advisory) {
  return typeof advisory.github_advisory_id === "string" && advisory.github_advisory_id !== ""
    ? advisory.github_advisory_id
    : `npm-${advisory.id}`;
}

/**
 * One classified advisory. `runtime` is true when a single non-development path reaches it; the
 * paths travel with the verdict so the reader can check the claim without re-running the audit.
 */
function classify(advisory) {
  const findings = Array.isArray(advisory.findings) ? advisory.findings : [];
  const development = findings.length > 0 && findings.every((finding) => finding.dev === true);
  return {
    ghsa: advisoryKey(advisory),
    package: advisory.module_name,
    severity: advisory.severity,
    runtime: !development,
    versions: [...new Set(findings.map((finding) => finding.version).filter((v) => typeof v === "string"))],
    vulnerable: advisory.vulnerable_versions,
    patched: advisory.patched_versions,
    paths: [...new Set(findings.flatMap((finding) => (Array.isArray(finding.paths) ? finding.paths : [])))].sort(),
  };
}

/** Every advisory in a `pnpm audit --json` report, classified, worst severity first. */
export function classifyReport(report) {
  if (!(isObject(report) && isObject(report.advisories)))
    throw new Error("the audit report has no `advisories` object; the scan did not run");
  const rank = (severity) => {
    const index = SEVERITIES.indexOf(severity);
    return index < 0 ? SEVERITIES.length : index;
  };
  return Object.values(report.advisories)
    .map(classify)
    .sort(
      (left, right) =>
        rank(left.severity) - rank(right.severity) ||
        String(left.package).localeCompare(String(right.package)) ||
        left.ghsa.localeCompare(right.ghsa),
    );
}

/**
 * The assessment file, validated as its own artifact: a malformed entry is a violation even when
 * it would not have discharged anything, because the next reader cannot tell a typo from a claim.
 */
export function readAssessments(document) {
  if (!(isObject(document) && Array.isArray(document.assessments)))
    return {
      assessments: [],
      problems: [violation("assessments_malformed", `${ASSESSMENTS} has no \`assessments\` array`)],
    };
  const problems = [];
  const assessments = [];
  const seen = new Set();
  for (const [index, entry] of document.assessments.entries()) {
    const field = `assessments[${index}]`;
    if (!isObject(entry)) {
      problems.push(violation("assessment_malformed", `${field} is not an object`));
      continue;
    }
    const { ghsa, severity, reason } = entry;
    if (typeof ghsa !== "string" || ghsa.trim() === "") {
      problems.push(violation("assessment_malformed", `${field}.ghsa must be a non-empty string`));
      continue;
    }
    if (seen.has(ghsa)) problems.push(violation("assessment_duplicate", `${field}.ghsa:${ghsa} appears twice`));
    seen.add(ghsa);
    if (!SEVERITIES.includes(severity))
      problems.push(
        violation("assessment_malformed", `${field}.severity:${severity} must be one of ${SEVERITIES.join("|")}`),
      );
    if (typeof reason !== "string" || reason.trim().length < MIN_REASON_LENGTH)
      problems.push(
        violation(
          "assessment_unexplained",
          `${field}.reason:${ghsa} must be a sentence of at least ${MIN_REASON_LENGTH} characters`,
        ),
      );
    else if (SHUGHS.test(reason.trim()))
      problems.push(violation("assessment_unexplained", `${field}.reason:${ghsa} states a disposition without a fact`));
    assessments.push({ ghsa, severity, reason: typeof reason === "string" ? reason : "" });
  }
  return { assessments, problems };
}

/**
 * The verdict. An assessment discharges a RUNTIME advisory by id; a development advisory needs no
 * entry, and an entry that no longer matches anything is a violation rather than a leftover.
 */
export function judge({ advisories, assessments, problems = [] }) {
  const byGhsa = new Map(assessments.map((entry) => [entry.ghsa, entry]));
  const issues = [...problems];
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  let runtime = 0;
  let assessed = 0;
  for (const advisory of advisories) {
    if (advisory.severity in counts) counts[advisory.severity] += 1;
    if (!advisory.runtime) continue;
    runtime += 1;
    const assessment = byGhsa.get(advisory.ghsa);
    if (assessment === undefined) {
      issues.push(
        violation("unassessed_runtime_advisory", `${advisory.ghsa} ${advisory.package} ${advisory.severity}`, advisory),
      );
      continue;
    }
    assessed += 1;
    if (assessment.severity !== advisory.severity)
      issues.push(
        violation(
          "assessment_severity_mismatch",
          `${advisory.ghsa} recorded=${assessment.severity} audited=${advisory.severity}`,
          advisory,
        ),
      );
  }
  const present = new Set(advisories.map((advisory) => advisory.ghsa));
  for (const entry of assessments)
    if (!present.has(entry.ghsa))
      issues.push(violation("stale_assessment", `${entry.ghsa} no advisory in the audit carries this id`));
  return {
    verdict: issues.length === 0 ? "passed" : "failed",
    counts,
    runtime,
    development: advisories.length - runtime,
    assessed,
    unassessed: runtime - assessed,
    issues,
    advisories,
  };
}

/**
 * Runs the live audit in `root`; a non-zero exit is a finding, so only a missing status is fatal.
 * `pnpm` on Windows is a `.cmd` shim that `spawnSync` cannot execute directly (measured: ENOENT
 * for `pnpm`, EINVAL for `pnpm.cmd`), so the command goes through the shell there - the same
 * thing `tools/generate-sbom.mjs` does for its `pnpm licenses list` call.
 */
export function scan({ root = REPOSITORY_ROOT } = {}) {
  const result =
    process.platform === "win32"
      ? spawnSync("pnpm audit --json", {
          cwd: root,
          shell: true,
          encoding: "utf8",
          maxBuffer: 128 * 1024 * 1024,
          windowsHide: true,
        })
      : spawnSync("pnpm", ["audit", "--json"], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 128 * 1024 * 1024,
          windowsHide: true,
        });
  if (typeof result.status !== "number")
    throw new Error(`could not run \`pnpm audit\` in ${root}: ${result.error?.message ?? "no exit status"}`);
  const raw = `${result.stdout ?? ""}`;
  const start = raw.indexOf("{");
  if (start < 0)
    throw new Error(`\`pnpm audit\` wrote no JSON report (exit ${result.status}): ${raw.trim().slice(0, 400)}`);
  const report = JSON.parse(raw.slice(start));
  // An unreachable registry comes back as `{"error":{"code":"pnpm","message":"fetch failed"}}` with
  // no advisories at all. That is "we did not look", which is not the same as "nothing found".
  if (isObject(report.error)) throw new Error(`\`pnpm audit\` could not scan: ${report.error.message ?? "unknown"}`);
  return report;
}

const valueOf = (argv, name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};

function print(verdict, out = process.stdout, err = process.stderr) {
  const severity = SEVERITIES.map((name) => `${name}=${verdict.counts[name] ?? 0}`).join(" ");
  out.write(
    `dependency_audit ${verdict.verdict} runtime=${verdict.runtime} development=${verdict.development} ` +
      `${severity} assessed=${verdict.assessed} unassessed=${verdict.unassessed}\n`,
  );
  if (verdict.verdict === "passed") {
    for (const advisory of verdict.advisories.filter((candidate) => !candidate.runtime))
      out.write(`  development_only ${advisory.ghsa} ${advisory.package} ${advisory.severity}\n`);
    return;
  }
  for (const issue of verdict.issues) {
    err.write(`  ${issue.code}: ${issue.detail}\n`);
    if (issue.advisory === undefined) continue;
    err.write(
      `    versions=${issue.advisory.versions.join(",") || "?"} ` +
        `vulnerable=${issue.advisory.vulnerable} patched=${issue.advisory.patched}\n`,
    );
    for (const path of issue.advisory.paths.slice(0, 3)) err.write(`    via ${path}\n`);
  }
  if (verdict.unassessed > 0)
    err.write(`  a shipped advisory needs a decision in ${ASSESSMENTS}, or a version that no longer carries it\n`);
}

function main(argv) {
  const root = resolve(valueOf(argv, "--root") ?? REPOSITORY_ROOT);
  const saved = valueOf(argv, "--audit");
  const { assessments, problems } = readAssessments(JSON.parse(readFileSync(resolve(root, ASSESSMENTS), "utf8")));
  // A saved report is for the gate's own fixtures; the live audit is the gate.
  const advisories = classifyReport(
    saved === undefined ? scan({ root }) : JSON.parse(readFileSync(resolve(saved), "utf8")),
  );
  const verdict = judge({ advisories, assessments, problems });
  print(verdict);
  return verdict.verdict === "passed" ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`dependency_audit_unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
