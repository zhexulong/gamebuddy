/**
 * Runs the perf suite: `tools/perf/*.bench.mjs`, one `node:test` process per file.
 *
 * `pnpm bench:perf`        measure every case and print ops/sec + per-op cost per case
 * `pnpm bench:perf:flame`  write one `.cpuprofile` per bench file under `.tmp/perf/`
 *
 * The flamegraph is a separate switch on purpose: `--cpu-prof` samples the process it runs in, so
 * profiling the measuring run would charge the sampler's overhead to the number the budget gate
 * compares. A profile is for reading the code, a measurement is for holding it to a budget.
 *
 * The `.cpuprofile` files need no conversion: they are the format Chrome DevTools
 * (Performance -> Load profile) and Perfetto (Open trace file) read directly, the same standard
 * artifact family as a run's `run-trace.json`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runWhenEntry } from "../scripts/cli-entry.mjs";
import { PERF_RESULT_MARKER } from "./harness.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const suiteDirectory = resolve(repositoryRoot, "tools", "perf");
const profileDirectory = resolve(repositoryRoot, ".tmp", "perf");

/** Every benchmark in the suite, sorted, so adding one adds it to the run and to the baseline. */
export function benchFiles(directory = suiteDirectory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".bench.mjs"))
    .sort()
    .map((name) => resolve(directory, name));
}

function runNode(args) {
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 128 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    // A non-zero exit is a failing benchmark, not a failure to run one; only a missing status is.
    if (typeof error.status !== "number") throw new Error(`perf_suite_not_run: ${error.message}`);
    return { status: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

/**
 * Runs the suite.
 *
 * `node --test` gives each bench file its own process, which keeps one file's warmed heap and its
 * leftover state out of another file's numbers - but separate processes do not keep them out of each
 * other's WAY. Six benches measuring at once contend for the same cores, and that contention lands
 * inside the measurement, so the suite is run with `--test-concurrency=1`.
 *
 * Measured, not preferred: five interleaved rounds of the whole suite each way, on
 * `admission.action/small` 19.57 µs/op median with the files concurrent against 13.26 serialised
 * (-32%), and on `presentation.commit/small` 0.69 against 0.59 (-14%), with that case's spread falling
 * from +34.4% to +6.9% (max/min over the five runs). Every case moved the same way. The price is the
 * wall-clock sum of the files rather than the slowest one.
 *
 * The profile path already runs one file per process, one at a time, so it pays nothing for this.
 */
export function runSuite({ files = benchFiles(), profile = false } = {}) {
  if (files.length === 0) throw new Error("perf_suite_empty:no_bench_files");
  if (!profile) return [runNode(["--test", "--test-concurrency=1", ...files])];
  mkdirSync(profileDirectory, { recursive: true });
  return files.map((file) => {
    const name = `${basename(file, ".mjs")}.cpuprofile`;
    const run = runNode(["--cpu-prof", `--cpu-prof-dir=${profileDirectory}`, `--cpu-prof-name=${name}`, file]);
    return { ...run, profile: resolve(profileDirectory, name) };
  });
}

/**
 * The case results an output carries. The marker is searched inside a line rather than anchored to
 * it, because a reporter may decorate the line a test wrote. `marker` selects which contract the
 * output is read as: a case's cost (`PERF_RESULT`) or a pair's ratio (`PERF_SCALING_RESULT`).
 */
export function caseResults(stdout, marker = PERF_RESULT_MARKER) {
  const at0 = `${marker} `;
  const results = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const at = line.indexOf(at0);
    if (at < 0) continue;
    results.push(JSON.parse(line.slice(at + at0.length)));
  }
  return results;
}

function main(argv) {
  const profile = argv.includes("--profile");
  const runs = runSuite({ profile });
  let failed = 0;
  for (const run of runs) {
    process.stdout.write(run.stdout);
    if (run.stderr) process.stderr.write(run.stderr);
    if (run.status !== 0) failed += 1;
    if (run.profile !== undefined) {
      const size = statSync(run.profile, { throwIfNoEntry: false })?.size;
      if (size === undefined) process.stdout.write(`perf_profile_missing ${run.profile}\n`);
      else process.stdout.write(`perf_profile path=${run.profile} bytes=${size}\n`);
    }
  }
  return failed === 0 ? 0 : 1;
}

await runWhenEntry(import.meta.url, main);
