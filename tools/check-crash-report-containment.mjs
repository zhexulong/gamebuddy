#!/usr/bin/env node
/**
 * No Node crash report may sit inside this repository, and none may carry a credential.
 *
 * WHY. `NODE_OPTIONS` on this machine carries `--report-on-fatalerror`, so every Node process that dies writes
 * `report.<date>.<time>.<pid>.<n>.<n>.json` into its own cwd, and each report carries the environment of the process
 * that died. Measured 2026-11-12 before this gate existed: 787 files in the repository root, 238 of them holding a
 * plaintext `GITHUB_PERSONAL_ACCESS_TOKEN` / `CPA_OAI_API_KEY` / `CONTEXT7_API_KEY` / `TAVILY_API_KEY` assignment. None
 * was tracked - so no key had to be rotated - but the tree was one `git add -A` away from committing them, and
 * `.gitignore` only ignored the directory the reports happened to be in, not the ones they were about to appear in.
 *
 * A `.gitignore` entry is not containment: it decides what a commit carries, not what lands on disk, and the entry it
 * had covered the repository root alone (measured: `/report.*.json`, with `dialogue-web/report.*.json` bolted on after
 * a crashed child whose cwd was `dialogue-web/`). So this gate measures the DISK, and names both facts separately: a
 * report inside the tree at all, and a report that holds a credential.
 *
 * POPULATION, derived from the filesystem on every run (`examined N files` is printed, never assumed):
 *   every `report.*.json` at any depth below the repository root.
 * Two directories are pruned, and both are pruned by a derivation rather than a list:
 *   - `node_modules`, a dependency install no commit takes a file from and no child of ours runs inside;
 *   - any directory that carries its own `.git` entry, i.e. another checkout - `.worktrees/` holds fifteen stale
 *     copies of this tree, and a walk that descends into them costs minutes and answers about the wrong tree.
 * The prune counts are printed, so a scan that skipped more than its author expected is a line of output rather than
 * a silence.
 *
 * A SECRET IS NAMED, NEVER QUOTED. The finding carries the variable's name and the file's path, so the gate can fail
 * on a leaked credential without the credential appearing in a terminal, a log or a pasted report.
 *
 * `examined 0` is BLOCKED, not green: a scan that read nothing agrees with itself, and so does one whose root could
 * not be listed. Both exit 2. `0 crash reports` over a measured population exits 0.
 *
 * Usage:
 *   node tools/check-crash-report-containment.mjs               # this checkout
 *   node tools/check-crash-report-containment.mjs --root <dir>  # another tree (the falsifier's own)
 *
 * red-proof: inject  a `report.1.json` carrying `API_KEY=deadbeef` planted at the root of a copy of the tree ->
 *                    `crash_report_inside_repo:report.1.json` and
 *                    `crash_report_carries_a_secret:report.1.json:API_KEY`, exit 1, and the planted value never
 *                    printed (tools/check-crash-report-containment.test.mjs)
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** What Node names a crash report: `report.<date>.<time>.<pid>.<n>.<n>.json`. */
const CRASH_REPORT_NAME = /^report\..*\.json$/u;

/**
 * A credential-shaped assignment: an upper-case variable whose name ends in one of the five words a secret is named
 * with, followed by `:` or `=` and a value. A crash report spells the environment as JSON (`"NAME": "value"`) and a
 * command line spells it as an argument (`--NAME=value`), so both separators are read.
 *
 * The shape, not a list of the four names that were found: the next leaked variable is one nobody has typed yet, and a
 * list of names can only catch what its author remembered. `{8,}` on the value keeps `"API_KEY": "none"` and
 * `"TOKEN": ""` out - a report that names a credential variable without a value is not a leaked credential.
 */
const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)"?\s*[:=]\s*"?[^\s"',}]{8,}`,
  "gu",
);

/** Directories a walk never enters, each for a stated reason; the counts are printed on every run. */
const PRUNED_DIRECTORY_NAME = "node_modules";

/**
 * How many directory listings are in flight at once. The walk is latency-bound on a slow disk, not CPU-bound: 20,647
 * directories read one after another measured 69 s on this machine, which is too much for a rung that runs before
 * every live run. A small bound overlaps the waiting without turning a 70,000-file tree into 70,000 open handles.
 */
const READDIR_CONCURRENCY = 16;

/** Run at most `max` tasks at once, each task awaited in turn; the smallest shape that bounds a recursive walk. */
function createLimiter(max) {
  let active = 0;
  const waiting = [];
  return async (task) => {
    if (active >= max) await new Promise((resume) => waiting.push(resume));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function toReportPath(root, absolute) {
  return relative(root, absolute).split(sep).join("/");
}

/**
 * Every crash report below `root`, with the size of the population the answer is drawn from. `unreadable` holds every
 * directory the scan could not list, because a walk that silently skipped one has not measured the tree it claims to.
 */
export async function scanForCrashReports(root, { list = readdir } = {}) {
  const examined = { files: 0 };
  const reports = [];
  const unreadable = [];
  const pruned = { nestedCheckouts: 0, dependencyTrees: 0 };
  const limit = createLimiter(READDIR_CONCURRENCY);

  const walk = async (directory, isRoot) => {
    let entries;
    try {
      entries = await limit(() => list(directory, { withFileTypes: true }));
    } catch (error) {
      unreadable.push(`${toReportPath(root, directory)}: ${error.code ?? error.message}`);
      return;
    }
    if (!isRoot && entries.some((entry) => entry.name === ".git")) {
      pruned.nestedCheckouts += 1;
      return;
    }
    const descents = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === PRUNED_DIRECTORY_NAME) pruned.dependencyTrees += 1;
        else descents.push(walk(path, false));
        continue;
      }
      if (!entry.isFile()) continue;
      examined.files += 1;
      if (CRASH_REPORT_NAME.test(entry.name)) reports.push(path);
    }
    await Promise.all(descents);
  };

  await walk(resolve(root), true);
  return { examined: examined.files, reports: reports.map((path) => toReportPath(root, path)), pruned, unreadable };
}

/** The credential variable names a report holds. The values are never returned, stored or printed. */
export function credentialNamesIn(text) {
  return [...new Set([...String(text).matchAll(CREDENTIAL_ASSIGNMENT)].map((match) => match[1]))].sort();
}

/** The verdict: one finding per report, one more per credential it holds, and blocked when nothing was measured. */
export function judgeScan({ examined, reports, unreadable }, { readFile = (path) => readFileSync(path, "utf8") } = {}) {
  if (unreadable.length > 0) return { status: "blocked", examined, findings: [], unreadable };
  if (examined === 0) return { status: "blocked", examined, findings: [], unreadable };
  const findings = [];
  for (const report of reports) {
    findings.push(`crash_report_inside_repo:${report}`);
    let text;
    try {
      text = readFile(report);
    } catch {
      findings.push(`crash_report_unreadable:${report}`);
      continue;
    }
    for (const name of credentialNamesIn(text)) findings.push(`crash_report_carries_a_secret:${report}:${name}`);
  }
  return { status: findings.length === 0 ? "passed" : "failed", examined, findings, unreadable };
}

function main(argv) {
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag < 0 ? REPOSITORY_ROOT : resolve(argv[rootFlag + 1] ?? "");
  return scanForCrashReports(root).then((scan) => report(root, scan));
}

function report(root, scan) {
  const verdict = judgeScan(scan, {
    readFile: (path) => readFileSync(join(root, path), "utf8"),
  });
  const pruned = `pruned ${scan.pruned.nestedCheckouts} nested checkout(s), ${scan.pruned.dependencyTrees} dependency tree(s)`;
  console.log(`examined ${verdict.examined} files, ${scan.reports.length} crash reports · ${pruned}`);
  for (const finding of verdict.findings) console.log(finding);
  for (const entry of verdict.unreadable) console.log(`crash_report_scan_unreadable:${entry}`);
  if (verdict.status === "blocked")
    console.log(`crash_report_scan_blocked:examined=${verdict.examined}:unreadable=${verdict.unreadable.length}`);
  // The machine-readable half, last: a report is the population and one entry per rule it can go red on.
  console.log(
    JSON.stringify({
      gate: "crash-report-containment",
      status: verdict.status,
      examined: verdict.examined,
      crashReports: scan.reports.length,
      checks: [
        { id: "no_report_inside_repo", status: scan.reports.length === 0 ? "passed" : "failed" },
        {
          id: "no_report_carries_a_secret",
          status: verdict.findings.some((finding) => finding.startsWith("crash_report_carries_a_secret:"))
            ? "failed"
            : "passed",
        },
      ],
    }),
  );
  if (verdict.status === "blocked") return 2;
  return verdict.status === "passed" ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
