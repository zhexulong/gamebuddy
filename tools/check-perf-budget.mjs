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
 * WHAT `--update` RECORDS: each case's worst reading across `RECORDING_PROCESSES` independent
 * benchmark processes, not the best window of one. The jitter that flips a case red is BETWEEN
 * processes, not inside one - two runs of the same code differed by up to +86.9% on a single case,
 * while sustained CPU load moved one run's own best by only ±10% on 12 of 14 cases - so a number
 * recorded from one process leaves the budget to whichever process a later run happens to get. A
 * worst-of-K recording is what makes the relationship `best <= 1.5 x worst`: a later run has to beat
 * the worst of K readings by half again before it fails, so the noise must be large AND land outside
 * the recorded sample, while a real regression (an O(n) change, an order of magnitude) still crosses it.
 *
 * THE BASELINE BELONGS TO THE MACHINE THAT RECORDED IT: the tolerance is 50%, and two boxes differ
 * by more than that on the same code (measured 2026-10-22: every large case 57-126% over a baseline
 * recorded elsewhere, with nothing changed). So the baseline records `os.platform()`, `os.arch()`,
 * the processor count and the CPU model, and a run on a different machine states
 * `perf_budget_skipped: baseline recorded on <recorded>, measured on <current>` and passes - named,
 * with both identities, so a green check there reads as a skip and not as a measurement. On the
 * recording machine nothing changes, and a baseline written before this field existed is a skip too:
 * its machine is unknown, so it cannot be compared against.
 *
 * THE OTHER DIRECTION IS GATED TOO: a case that is measured but not recorded fails (a new path
 * cannot be added without a budget), and a recorded case that is no longer measured fails (a
 * deleted or renamed benchmark cannot silently leave the gate). Both fail loudly instead of
 * passing a gate that checked less than it claims.
 *
 * THE BASELINE LAGS BY DESIGN, AND THE GATE SAYS BY HOW MUCH: the recorded numbers belong to the
 * revision they were recorded at, and no commit that makes a path faster re-records them - which is
 * exactly why they drift. A run states the distance from that revision to HEAD and what it means: the
 * headroom printed in front of each case belongs to that older code, not to this revision. It is a
 * report and not a verdict - a lagging baseline is the normal state of a ratchet, so the distance
 * never changes the exit code - and a revision this clone does not know (a shallow checkout, a
 * baseline from a branch since squashed away) is a named line rather than a crash or silence.
 *
 * Usage:
 *   node tools/check-perf-budget.mjs                        # re-measure the suite and ratchet
 *   node tools/check-perf-budget.mjs --update                # re-record the worst of K processes
 *   node tools/check-perf-budget.mjs --results <file>        # compare a saved suite output
 *   node tools/check-perf-budget.mjs --root <dir>            # the gate's own fixture
 *
 * red-proof: fixture  a saved suite reading with `admission.action/large` at 215.72 µs/op against the recorded 107.86
 *                     -> `perf_budget_failed slow=1 ... +100.0%`, exit 1 (tools/perf/budget.test.mjs)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { caseResults, runSuite } from "./perf/run-benchmarks.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** How much more a path may cost than it recorded, before the difference is a regression. */
export const BUDGET_TOLERANCE = 0.5;

/**
 * How many independent benchmark processes `--update` takes the worst of.
 *
 * One is not enough: a best-of-5 inside one process still carries that process's own scheduling
 * luck, and that is the luck a later run cannot reproduce. Three bounds the cost of a re-record
 * (one suite run is about 5 seconds here) while making the recorded number a worst rather than a
 * best; see the header for why the spread lives between processes.
 */
const RECORDING_PROCESSES = 3;

const baselineFor = (root) => join(root, "tools", "perf", "baseline.json");

/** What one case may cost per op: its recorded cost plus the tolerance. */
export function budgetMicros(recorded) {
  return recorded.perOpMicros * (1 + BUDGET_TOLERANCE);
}

/** The machine this run measures on, in the fields a baseline records so a later run can tell. */
export function machineIdentity() {
  const processors = cpus();
  return {
    platform: platform(),
    arch: arch(),
    processors: processors.length,
    // Windows pads the model string with spaces; the padding is not part of the identity.
    cpuModel: (processors[0]?.model ?? "unknown").trim(),
  };
}

/** One line naming a machine, for the skip message and for what `--update` prints. */
export function machineLabel(machine) {
  return `${machine.platform}/${machine.arch}/${machine.processors} cpus/${machine.cpuModel}`;
}

/**
 * The line that says why this run does not compare, or undefined when it does.
 *
 * A missing identity is the older baseline, which recorded nothing about its machine: unknown is not
 * the current one, so it cannot be compared either, and saying that is what lets this field be added
 * without pretending the numbers were portable all along.
 */
export function machineSkipLine(recorded, current) {
  if (recorded === undefined) {
    return `perf_budget_skipped: baseline predates the machine identity, measured on ${machineLabel(current)}`;
  }
  const same =
    recorded.platform === current.platform &&
    recorded.arch === current.arch &&
    recorded.processors === current.processors &&
    recorded.cpuModel === current.cpuModel;
  if (same) return undefined;
  return `perf_budget_skipped: baseline recorded on ${machineLabel(recorded)}, measured on ${machineLabel(current)}`;
}

/**
 * The line that says what produced the numbers a budget is measured from: a worst-of-K recording is
 * a different statistic from the single best-of-5 an older baseline holds, and a reader comparing a
 * budget against a measurement needs to know which one is in front of them.
 */
export function recordingLine(recording) {
  if (recording === undefined) {
    return "perf_budget_baseline_recording: none, so each budget is 1.5x a single best-of-5 reading rather than a worst";
  }
  return `perf_budget_baseline_recording: each budget is 1.5x the ${recording.statistic} of ${recording.processes} independent benchmark processes`;
}

/** One `git` call's trimmed stdout, or undefined when git cannot answer (unknown revision, no repo). */
function gitOutput(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

const commits = (count) => `${count} commit${count === 1 ? "" : "s"}`;

/**
 * How far the baseline's revision sits from HEAD: `behind` are HEAD's commits the baseline does not
 * have, `ahead` are the baseline's that HEAD does not have. Undefined when this clone does not know
 * the revision - a fact about the clone, not a defect in the baseline, so it is reported not raised.
 */
export function revisionDistance(revision, root) {
  const output = gitOutput(["rev-list", "--count", "--left-right", `${revision}...HEAD`], root);
  if (output === undefined) return undefined;
  const [ahead, behind] = output.split(/\s+/u).map(Number);
  return { ahead, behind };
}

/**
 * The line placing the baseline's revision against HEAD, and what a reader should conclude from the
 * numbers under it: a case's headroom is measured from the revision its budget was recorded at.
 */
export function revisionLine(revision, distance) {
  if (distance === undefined) {
    return `perf_budget_baseline_unknown: baseline revision ${revision} is not a commit in this clone, so the numbers below cannot be placed against HEAD; the headroom in front of each case is that baseline's, not this revision's`;
  }
  const { ahead, behind } = distance;
  if (ahead === 0 && behind === 0) {
    return `perf_budget_baseline_current: baseline revision ${revision} is HEAD; the numbers below were recorded at this revision`;
  }
  if (ahead === 0) {
    return `perf_budget_baseline_behind: baseline revision ${revision} is ${commits(behind)} behind HEAD; the numbers below describe that older code, so the headroom in front of each case is not this revision's headroom`;
  }
  if (behind === 0) {
    return `perf_budget_baseline_ahead: baseline revision ${revision} is ${commits(ahead)} ahead of HEAD; the numbers below describe code this checkout does not contain, so the headroom in front of each case is not this revision's headroom`;
  }
  return `perf_budget_baseline_diverged: baseline revision ${revision} is ${commits(behind)} behind and ${commits(ahead)} ahead of HEAD; the numbers below describe other code, so the headroom in front of each case is not this revision's headroom`;
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

/** The cases one suite run measured, keyed the way a baseline keys them. */
function byKey(results) {
  return new Map(results.map((result) => [`${result.id}/${result.size}`, result]));
}

const sortedKeys = (cases) => [...cases.keys()].sort((left, right) => left.localeCompare(right, "en"));

/**
 * What a recording holds: per case, the reading with the highest per-op cost across `readings`, one
 * entry per process. `opsPerSecond` and `detail` come from that same reading, so a recorded number
 * stays one measurement rather than a mixture of K.
 *
 * The processes must have measured the same cases. A bench file that only one of them loaded would
 * otherwise record a number for a case the others never ran, and the gate would compare a later run
 * against it.
 */
export function worstOfProcesses(readings) {
  const keys = sortedKeys(readings[0]);
  for (const reading of readings.slice(1)) {
    const seen = sortedKeys(reading);
    if (seen.join("\n") === keys.join("\n")) continue;
    const drift = seen.find((key) => !keys.includes(key)) ?? keys.find((key) => !seen.includes(key));
    throw new Error(`perf_suite_inconsistent_cases:${drift}`);
  }
  const cases = {};
  for (const key of keys) {
    const worst = readings
      .map((reading) => reading.get(key))
      .reduce((left, right) => (right.perOpMicros > left.perOpMicros ? right : left));
    cases[key] = {
      opsPerSecond: worst.opsPerSecond,
      perOpMicros: worst.perOpMicros,
      ...(worst.detail === undefined ? {} : { detail: worst.detail }),
    };
  }
  return cases;
}

/**
 * Records what `RECORDING_PROCESSES` independent benchmark processes measured, keeping each case's
 * worst reading, and prints every reading - so the number can be argued with later rather than
 * trusted, and so a worst-of-K is visibly not a single best-of-5.
 */
function recordWorst({ root, machine, argv }) {
  if (valueOf(argv, "--results") !== undefined) {
    // A recording states how many processes produced it; a saved output is one process's readings.
    throw new Error("perf_update_reads_no_saved_results: a recording is measured, never copied");
  }
  const readings = [];
  for (let process = 1; process <= RECORDING_PROCESSES; process += 1) readings.push(byKey(measureCases(argv)));
  if (readings[0].size === 0) throw new Error("perf_suite_measured_no_cases");
  const cases = worstOfProcesses(readings);
  const recorded = {
    note: `Per-case perf measurements recorded from this machine, in ops/sec and microseconds per op, at the revision below. Each case is the worst reading across the ${RECORDING_PROCESSES} independent benchmark processes named under \`recording\`, because the spread a budget has to absorb lives between processes rather than inside one. tools/check-perf-budget.mjs re-measures and fails when a case costs more than its recorded per-op cost plus BUDGET_TOLERANCE, or when the set of measured cases no longer matches this file. Re-record deliberately, in its own commit, when a change makes a path faster; never to silence a regression. These are the numbers of the machine under \`machine\`: a run on another machine states perf_budget_skipped instead of comparing, because per-op cost describes the box as much as the code.`,
    revision: execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
    machine,
    tolerance: BUDGET_TOLERANCE,
    recording: { statistic: "worst", processes: RECORDING_PROCESSES },
    cases,
  };
  writeFileSync(baselineFor(root), `${JSON.stringify(recorded, null, 2)}\n`);
  process.stdout.write(
    `perf_budget_recorded cases=${Object.keys(cases).length} statistic=worst processes=${RECORDING_PROCESSES} ` +
      `revision=${recorded.revision} machine=${machineLabel(machine)}\n`,
  );
  for (const [key, value] of Object.entries(cases)) {
    const each = readings.map((reading) => reading.get(key).perOpMicros).join(" ");
    process.stdout.write(
      `  ${key} worst ${value.perOpMicros} µs/op ${value.opsPerSecond} ops/s readings ${each} µs/op\n`,
    );
  }
}

function main(argv) {
  const root = resolve(valueOf(argv, "--root") ?? repositoryRoot);
  const update = argv.includes("--update");
  const machine = machineIdentity();
  const baseline = update ? undefined : JSON.parse(readFileSync(baselineFor(root), "utf8"));
  if (baseline !== undefined) {
    const skip = machineSkipLine(baseline.machine, machine);
    if (skip !== undefined) {
      // Not measured: this machine's numbers are not this baseline's numbers, and measuring them
      // would only produce a red that says "another box" in the shape of a regression.
      process.stdout.write(`${skip}\n`);
      return 0;
    }
    // Before the measurement, because it describes the numbers that follow rather than the verdict.
    process.stdout.write(`${revisionLine(baseline.revision, revisionDistance(baseline.revision, root))}\n`);
    process.stdout.write(`${recordingLine(baseline.recording)}\n`);
  }
  if (update) {
    recordWorst({ root, machine, argv });
    return 0;
  }

  const results = measureCases(argv).sort((left, right) =>
    `${left.id}/${left.size}`.localeCompare(`${right.id}/${right.size}`, "en"),
  );
  if (results.length === 0) throw new Error("perf_suite_measured_no_cases");

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
