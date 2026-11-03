/**
 * 性能形状门：同一个操作在两个输入规模上各测一次，断言两者的比值，而不是绝对微秒。
 *
 * WHY THIS INSTRUMENT EXISTS (measured 2026-11-03). `tools/check-perf-budget.mjs` compares a case's
 * per-op cost against a number recorded on one machine, with a 50% tolerance, and `tools/perf/baseline.json`
 * was re-recorded on every commit that touched it - four times, none of which caught a regression. The
 * numbers it compares are facts about the box: its clock, the builds sharing its cores, which V8
 * generation warmed the process, and this machine's own per-case spread is 15-40%. A gate that has to
 * re-record itself to stay green is measuring the machine.
 *
 * WHAT IS MACHINE-INDEPENDENT: the RATIO between the same operation at two input sizes, measured in one
 * process. A slower machine scales both sides, a busy machine delays both sides, warmup applies to the
 * same functions on both sides, and the runner's own overhead is in both windows. What is left is how
 * the cost follows the input - the one property that belongs to the code. So this gate asserts a band
 * per case and no absolute value anywhere. The idle-vs-loaded proof is in the task that introduced it
 * and in the case comments: absolute µs move by tens of percent under load and the ratios do not.
 *
 * WHAT A BAND MEANS, AND BOTH NUMBERS. Each case declares `{ min, max, reason }` beside its own sizes
 * (`tools/perf/*.bench.mjs`). `max` is the regression ceiling: how far the cost may grow when the input
 * grows, e.g. "doubling the bound arguments must cost less than 3.2x the per-op time". `min` is the
 * floor that separates "this case still reads its input" from "this case stopped reading it" (~1.0), and
 * a sub-linear case whose fixed setup dominates may claim a ceiling only (min 0) with its reason saying
 * so. Each `reason` states the measured ratio, the headroom the band has over it, and what a quadratic
 * on that axis would read - so the band's meaning is a checkable claim rather than a number that fitted.
 *
 * THE POPULATION IS THE SUITE, NOT A LIST: every `tools/perf/*.bench.mjs` file is run in scaling mode,
 * and a file that reports no pair is a finding. A bench cannot quietly leave the instrument by deleting
 * its declaration, and a new bench joins it by existing.
 *
 * THE PAIR MUST DIFFER ON ONE AXIS. The measurement refuses a pair that differs on two input fields
 * (`measureRatio`), because a ratio across two simultaneous changes is not a complexity measure of
 * either. Where that forced a size that the product does not accept - `admission.action`'s protocol
 * ceilings - the case anchors its pair on the ceiling and says so in its own comment.
 *
 * WHAT IT DOES NOT DO: it does not measure one-off absolute cost (that is the budget gate's job), it
 * does not replace `tools/check-perf-budget.mjs`, and it needs no quiet machine.
 *
 * Usage:
 *   node tools/check-perf-scaling.mjs     # run every bench file as a pair and check its band
 *   node tools/check-perf-scaling.mjs --json
 *
 * red-proof: inject  an O(n^2) nested loop over the log's records inside the emitted replay path ->
 *                    `perf_scaling_failed out_of_band=1` names `journal.open-replay` with its measured
 *                    ratio outside [2, 13]; restoring the emitted file returns `perf_scaling_ok`
 *                    (tools/check-perf-scaling.test.mjs)
 */
import { execFileSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PERF_SCALING_ENV } from "./perf/harness.mjs";
import { benchFiles, caseResults } from "./perf/run-benchmarks.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** One bench file's default: how long a whole gate run may take before it is reported as hung. */
const BENCH_TIMEOUT_MS = 10 * 60_000;

/**
 * Every finding a set of runs produces: a reading outside its declared band, a reading with no band,
 * and a bench file that reported no pair at all.
 *
 * Pure, so the falsifier can drive it with readings it constructs and with the readings a real
 * measurement produced - a gate whose decider cannot be called is a gate nobody can test.
 */
export function evaluateScaling(runs) {
  const findings = [];
  for (const run of runs) {
    if (run.readings.length === 0) {
      findings.push({
        code: "scaling_absent",
        detail:
          `${run.file} reported no PERF_SCALING_RESULT: every bench file in the suite must declare the ` +
          "size axis it scales along, so a case cannot leave this instrument by deleting its pair",
      });
      continue;
    }
    for (const reading of run.readings) {
      const where = `${reading.id} in ${run.file}`;
      const band = reading.band;
      if (band === undefined || !Number.isFinite(band.min) || !Number.isFinite(band.max) || !(band.min < band.max)) {
        findings.push({
          code: "band_not_declared",
          case: reading.id,
          detail: `${where} carries no readable band ({ min, max, reason } with min < max)`,
        });
        continue;
      }
      if (!(reading.multiple > 1)) {
        findings.push({
          code: "axis_not_growing",
          case: reading.id,
          detail: `${where} declares axis ${String(reading.axis)} but its input does not grow (x${reading.multiple})`,
        });
        continue;
      }
      if (reading.ratio < band.min || reading.ratio > band.max) {
        findings.push({
          code: "ratio_out_of_band",
          case: reading.id,
          detail:
            `${where}: ${reading.multiple}x ${reading.axis} cost ${reading.ratio}x the per-op time, ` +
            `outside the declared band [${band.min}, ${band.max}] (${band.reason})`,
        });
      }
    }
  }
  return findings;
}

/** One bench file's process: its scaling readings, or the reason it produced none. */
function runBenchFile(file) {
  const args = ["--test", relative(REPOSITORY_ROOT, file)];
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 128 * 1024 * 1024,
      timeout: BENCH_TIMEOUT_MS,
      env: { ...process.env, [PERF_SCALING_ENV]: "1" },
    });
    return { file: relative(REPOSITORY_ROOT, file), status: 0, readings: caseResults(stdout, "PERF_SCALING_RESULT") };
  } catch (error) {
    // A bench that could not run its windows is a failure of this gate, not a missing case: the
    // measurement did not happen, and saying "no readings" would hide why.
    if (typeof error.status !== "number" && error.code !== "ETIMEDOUT")
      throw new Error(`perf_scaling_bench_not_run:${relative(REPOSITORY_ROOT, file)}:${error.message}`);
    return {
      file: relative(REPOSITORY_ROOT, file),
      status: typeof error.status === "number" ? error.status : "timeout",
      readings: caseResults(String(error.stdout ?? ""), "PERF_SCALING_RESULT"),
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

/**
 * The first line a failing bench printed about WHY. `node --test` reports a failing test on stdout, so
 * reading only stderr turns every failure into `exited 1:` and sends the next reader to run the bench by
 * hand - which is how a stale artifact and a real regression would look the same.
 */
function failureDetail(run) {
  const lines = `${run.stderr ?? ""}\n${run.stdout ?? ""}`.split(/\r?\n/u).map((line) => line.trim());
  const named = lines.find((line) => /^(?:Error|TypeError|AssertionError)\b|live_run_artifact_|✖ /u.test(line));
  return named ?? lines.find((line) => line.length > 0) ?? "the bench printed nothing";
}

/** The per-case line a reader needs: which axis, both sizes, the ratio, and the band it had to clear. */
function readingLine(reading) {
  const [from, to] = reading.points;
  const verdict = reading.ratio >= reading.band.min && reading.ratio <= reading.band.max ? "✓" : "✖";
  return (
    `${verdict} ${reading.id}: ${reading.multiple}x ${reading.axis} ` +
    `(${from.value} -> ${to.value}) cost ${reading.ratio}x ` +
    `(${from.perOpMicros} -> ${to.perOpMicros} µs/op), band [${reading.band.min}, ${reading.band.max}]`
  );
}

function main(argv) {
  const runs = benchFiles().map(runBenchFile);
  const failed = runs.filter((run) => run.status !== 0);
  const findings = [
    ...failed.map((run) => ({
      code: "bench_failed",
      detail: `${run.file} exited ${String(run.status)}: ${failureDetail(run)}`,
    })),
    ...evaluateScaling(runs.filter((run) => run.status === 0)),
  ];
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ runs, findings }, null, 2)}\n`);
    return findings.length === 0 ? 0 : 1;
  }
  for (const run of runs) for (const reading of run.readings) process.stdout.write(`${readingLine(reading)}\n`);
  const pairs = runs.reduce((total, run) => total + run.readings.length, 0);
  const axes = [...new Set(runs.flatMap((run) => run.readings.map((reading) => reading.axis)))].sort().join(",");
  if (findings.length === 0) {
    process.stdout.write(`perf_scaling_ok files=${runs.length} pairs=${pairs} axes=${axes}\n`);
    return 0;
  }
  process.stdout.write(`perf_scaling_failed findings=${findings.length} files=${runs.length} pairs=${pairs}\n`);
  for (const finding of findings)
    process.stderr.write(`perf_scaling_${finding.code}:${finding.case ?? ""} ${finding.detail}\n`);
  process.stderr.write(
    "fix: a band is a claim about the shape of the operation at two sizes. Widening one without a measurement\n" +
      "     records the wrong shape; re-measure the pair, state the new ratio and what a quadratic reads, and\n" +
      "     put both numbers in the case's reason.\n",
  );
  return 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
