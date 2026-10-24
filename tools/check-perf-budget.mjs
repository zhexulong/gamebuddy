/**
 * 性能预算棘轮：每条已测量的路径只许保持或变快，不许变慢。
 *
 * WHY A RATCHET AND NOT AN ABSOLUTE TARGET: ops/sec is a fact about the machine that ran the
 * measurement, not about the code alone. A committed absolute target would be red on every
 * developer box that is not the one it was written on, and a gate that is always red is a gate
 * nobody reads. So `tools/perf/baseline.json` records what each case measured when it was
 * recorded, and this gate only asks "did this path get slower than it was". It is a regression
 * detector for the machine it runs on, which is what a lane needs before it lands a change.
 *
 * WHAT IT COMPARES: per-op cost, because that is the number a regression moves. A case may cost up
 * to `BUDGET_TOLERANCE` (50%) more than it recorded before this gate fails - deliberately loose
 * against scheduler noise, still far short of the regressions this suite exists to catch (a
 * per-transition append becoming a whole-journal rewrite is 2 orders of magnitude, and an O(n)
 * serialisation on a 2000-span trace is tens of times).
 *
 * THE OTHER DIRECTION IS GATED TOO: a case that is measured but not recorded fails (a new path
 * cannot be added without a budget), and a recorded case that is no longer measured fails (a
 * deleted or renamed benchmark cannot silently leave the gate). Both fail loudly instead of
 * passing a gate that checked less than it claims.
 *
 * Usage:
 *   node tools/check-perf-budget.mjs                        # re-measure the suite and ratchet
 *   node tools/check-perf-budget.mjs --update                # re-record, in its own commit
 *   node tools/check-perf-budget.mjs --results <file>        # compare a saved suite output
 *   node tools/check-perf-budget.mjs --root <dir>            # the gate's own fixture
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { caseResults, runSuite } from "./perf/run-benchmarks.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** How much more a path may cost than it recorded, before the difference is a regression. */
export const BUDGET_TOLERANCE = 0.5;

const baselineFor = (root) => join(root, "tools", "perf", "baseline.json");

/** What one case may cost per op: its recorded cost plus the tolerance. */
export function budgetMicros(recorded) {
  return recorded.perOpMicros * (1 + BUDGET_TOLERANCE);
}

/**
 * The cases that cost more than their budget, the measured cases no baseline records, the recorded
 * cases nothing measured any more, and any case measured twice.
 */
export function compare({ baselineCases, results }) {
  const slow = [];
  const unrecorded = [];
  const duplicates = [];
  const measured = new Map();
  for (const result of results) {
    const key = `${result.id}/${result.size}`;
    if (measured.has(key)) duplicates.push(key);
    measured.set(key, result);
  }
  for (const [key, result] of measured) {
    const recorded = baselineCases[key];
    if (recorded === undefined) {
      unrecorded.push(key);
      continue;
    }
    const budget = budgetMicros(recorded);
    if (result.perOpMicros > budget) slow.push({ key, result, recorded, budget });
  }
  const missing = Object.keys(baselineCases).filter((key) => !measured.has(key));
  return { slow, unrecorded, duplicates, missing };
}

const valueOf = (argv, name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};

/** The suite's case results: re-measured, or read from a saved output. */
function measureCases(argv) {
  const resultsPath = valueOf(argv, "--results");
  if (resultsPath !== undefined) return caseResults(readFileSync(resolve(resultsPath), "utf8"));
  const runs = runSuite();
  const stdout = runs.map((run) => run.stdout).join("\n");
  const failed = runs.filter((run) => run.status !== 0);
  if (failed.length > 0) {
    // A failing benchmark is a failing gate: it means the suite itself could not produce numbers.
    throw new Error(
      `perf_suite_failed:exits=${failed.map((run) => run.status).join(",")}\n${failed
        .map((run) => `${run.stdout}${run.stderr}`)
        .join("\n")}`,
    );
  }
  return caseResults(stdout);
}

function main(argv) {
  const root = resolve(valueOf(argv, "--root") ?? repositoryRoot);
  const update = argv.includes("--update");
  const results = measureCases(argv).sort((left, right) =>
    `${left.id}/${left.size}`.localeCompare(`${right.id}/${right.size}`, "en"),
  );
  if (results.length === 0) throw new Error("perf_suite_measured_no_cases");

  if (update) {
    const cases = Object.fromEntries(
      results.map((result) => [
        `${result.id}/${result.size}`,
        {
          opsPerSecond: result.opsPerSecond,
          perOpMicros: result.perOpMicros,
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        },
      ]),
    );
    const baseline = {
      note: "Per-case perf measurements recorded from this machine, in ops/sec and microseconds per op, at the revision below. tools/check-perf-budget.mjs re-measures and fails when a case costs more than its recorded per-op cost plus BUDGET_TOLERANCE, or when the set of measured cases no longer matches this file. Re-record deliberately, in its own commit, when a change makes a path faster; never to silence a regression.",
      revision: execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      tolerance: BUDGET_TOLERANCE,
      cases,
    };
    writeFileSync(baselineFor(root), `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(`perf_budget_recorded cases=${results.length} revision=${baseline.revision}\n`);
    for (const [key, value] of Object.entries(cases)) {
      process.stdout.write(`  ${key} ${value.opsPerSecond} ops/s ${value.perOpMicros} µs/op\n`);
    }
    return 0;
  }

  const baseline = JSON.parse(readFileSync(baselineFor(root), "utf8"));
  const { slow, unrecorded, duplicates, missing } = compare({ baselineCases: baseline.cases, results });
  const measuredByKey = new Map(results.map((result) => [`${result.id}/${result.size}`, result]));
  const keys = [...new Set([...Object.keys(baseline.cases), ...measuredByKey.keys()])].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  for (const key of keys) {
    const recorded = baseline.cases[key];
    const measured = measuredByKey.get(key);
    const budget = recorded === undefined ? undefined : budgetMicros(recorded);
    const failed =
      measured === undefined || budget === undefined || measured.perOpMicros > budget || duplicates.includes(key);
    const cost =
      measured === undefined ? "not measured" : `${measured.opsPerSecond} ops/s ${measured.perOpMicros} µs/op`;
    const target = budget === undefined ? "no budget" : `budget ${budget.toFixed(2)} µs/op`;
    process.stdout.write(`${failed ? "✖" : "✓"} ${key}: ${cost} (${target})\n`);
  }

  const debt = `cases=${keys.length} recorded=${Object.keys(baseline.cases).length} revision=${baseline.revision}`;
  if (slow.length === 0 && unrecorded.length === 0 && missing.length === 0 && duplicates.length === 0) {
    const slowest = [...measuredByKey.entries()].sort((left, right) => right[1].perOpMicros - left[1].perOpMicros)[0];
    process.stdout.write(`perf_budget_ok slowest=${slowest[0]} ${slowest[1].perOpMicros} µs/op debt: ${debt}\n`);
    return 0;
  }

  process.stdout.write(
    `perf_budget_failed slow=${slow.length} unrecorded=${unrecorded.length} missing=${missing.length} debt: ${debt}\n`,
  );
  for (const { key, result, recorded, budget } of slow) {
    const growth = ((result.perOpMicros / recorded.perOpMicros - 1) * 100).toFixed(1);
    process.stdout.write(
      `  ${key} measured ${result.opsPerSecond} ops/s ${result.perOpMicros} µs/op, budget ${budget.toFixed(2)} µs/op ` +
        `(recorded ${recorded.opsPerSecond} ops/s ${recorded.perOpMicros} µs/op, +${growth}%)\n`,
    );
  }
  for (const key of unrecorded) process.stdout.write(`  ${key} is measured but has no budget\n`);
  for (const key of missing) process.stdout.write(`  ${key} is recorded but was not measured\n`);
  for (const key of duplicates) process.stdout.write(`  ${key} was measured twice\n`);
  process.stdout.write(
    "fix the regression, or if the slower number is the new truth, re-record deliberately with: node tools/check-perf-budget.mjs --update\n",
  );
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
