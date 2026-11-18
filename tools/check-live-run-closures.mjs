#!/usr/bin/env node
/**
 * THE GATE FOR "A RUN THAT DIED HAD TO LEAVE A RECORD", as a POPULATION question over every run directory in a root.
 *
 * <p>
 * WHY (measured 2026-11-17): eight of the ten most recent ladder runs wrote no `result.json`, so a dead run and a clean run
 * reached every downstream gate as the same absence - and round67's directory held `launch.json` and nothing else at all. A
 * run that ended badly could not be told apart from one that ended well without a human reading mtimes, which is not a
 * reading a gate can make. The record is now written by the process that survives (`tools/live-run/core/run-closure.mjs`);
 * this gate asks the question that turns its absence into a failure: does every armed run directory have a closure?
 * </p>
 * <p>
 * THE THREE ZEROES ARE TOLD APART, because one total hides exactly the case the gate exists for:
 * </p>
 * <ul>
 *   <li>`not measured` - a run directory with no launch receipt. Nothing armed it, so nothing can be asked of it. NAMED.</li>
 *   <li>`silent` (BLOCKED) - a launch receipt with no closure: a process went away without saying how it ended. NAMED per
 *       run, as `a_run_that_died_leaves_a_record:<run>`, and the gate is red.</li>
 *   <li>`closed` / `recorded-died` - a closure exists. `closed` means the run finished its own unwind; `recorded-died` is
 *       the ending it recorded, which is not a pass but is not silence either.</li>
 * </ul>
 * <p>
 * An empty population is `not_measured` with exit 2, never green: `0 silent` out of `0 examined` agrees with itself. A tree
 * with no run directories needs `--allow-empty "<reason>"`, which prints that reason beside the count.
 * </p>
 *
 * Usage:
 *   node tools/check-live-run-closures.mjs                       # every run directory under .live-runs
 *   node tools/check-live-run-closures.mjs --root DIR            # ... or under DIR
 *   node tools/check-live-run-closures.mjs --root DIR --allow-empty "no live run has happened in this clone"
 *   node tools/check-live-run-closures.mjs --root DIR --json
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { auditRunClosures, renderClosureAudit } from "./live-run/core/run-closure.mjs";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const USAGE =
  "usage: node tools/check-live-run-closures.mjs [--root DIR] [--allow-empty <reason>] [--json]   (default root .live-runs)";

function optionValue(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : null;
}

/**
 * Which of the three readings this population gives. `blocked` and `not_measured` are different answers and neither is a
 * pass; only `passed` is exit 0.
 */
export function statusOf({ audit, allowEmpty }) {
  if (audit.examined === 0) return allowEmpty === null ? "not_measured" : "passed";
  if (audit.silent > 0) return "blocked";
  return "passed";
}

export function readingOf({ audit, allowEmpty }) {
  return {
    gate: "live-run-closures",
    root: audit.root,
    examined: audit.examined,
    closed: audit.closed,
    recordedDied: audit.recordedDied,
    bundleOnly: audit.bundleOnly,
    silent: audit.silent,
    notMeasured: audit.notMeasured,
    blockedRuns: audit.blockedRuns,
    bundleOnlyRuns: audit.bundleOnlyRuns,
    notMeasuredRuns: audit.notMeasuredRuns,
    allowEmpty,
    status: statusOf({ audit, allowEmpty }),
  };
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const root = resolve(optionValue(argv, "root") ?? resolve(REPOSITORY_ROOT, ".live-runs"));
  const allowEmpty = optionValue(argv, "allow-empty");
  const json = argv.includes("--json");
  const audit = auditRunClosures({ root });
  const reading = readingOf({ audit, allowEmpty });

  if (json) process.stdout.write(`${JSON.stringify(reading)}\n`);
  else {
    process.stdout.write(`${renderClosureAudit(audit)}   (${root})\n`);
    // THE DEATHS THAT WERE RECORDED, printed with their reason: "recorded-died 3" is a count, and a count of three deaths
    // with no names beside it is the kind of number this whole instrument exists to replace.
    for (const run of audit.runs.filter((entry) => entry.reading === "recorded" && entry.state !== "closed"))
      process.stdout.write(`  recorded-died ${run.run}: ${String(run.state)} (${String(run.reasonCode)})\n`);
    for (const run of audit.runs.filter((entry) => entry.reading === "silent"))
      process.stdout.write(`  silent        ${run.run}: a launch receipt with no closure and no result\n`);
    for (const run of audit.runs.filter((entry) => entry.reading === "ended_bundle_only"))
      process.stdout.write(`  bundle-only   ${run.run}: no closure, but its own result.json records the ending\n`);
    for (const run of audit.runs.filter((entry) => entry.reading === "not_measured"))
      process.stdout.write(`  not measured  ${run.run}: no launch receipt\n`);
  }

  for (const line of audit.reading.blocked) process.stderr.write(`${line}\n`);
  if (reading.status === "not_measured") {
    process.stderr.write(
      `run_closures_not_measured: no run directory under ${root} carries a launch receipt, so this gate examined nothing` +
        ` - a green run reads examined>=1 (pass --allow-empty "<reason>" if there is genuinely no live run in this tree)\n`,
    );
  }
  process.exitCode = reading.status === "passed" ? 0 : reading.status === "blocked" ? 1 : 2;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
