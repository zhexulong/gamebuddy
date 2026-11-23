/**
 * A gate's default run, executed for real: the artifact `tools/lib/harness-conformance.mjs` reads is what the gate
 * PRINTS, so the sweep spawns a process per gate and reads its stdout - never its source text.
 *
 * THE SHAPE IS BOUNDED CONCURRENCY (measured 2026-11-23 on this checkout). The suite executes 55 gates, and one
 * `spawnSync` at a time cost 104.7 s of a 106.8 s run: 58.7 s of it is one gate walking the 549,478 files `.live-runs`
 * holds here, and the other 54 are 52 ms - 5.5 s each, most of it Node's own startup. That is waiting, not computing, so
 * eight workers run alongside each other instead of a smaller budget being shaved: the slowest gate that PRINTS a report
 * needs 58.7 s, which a budget under a minute would turn into `not_measured`.
 *
 * The RUNS are out of order and the READING is not: the result map is seeded in the order of the paths it is given, so
 * two sweeps of one tree differ in their timing and in nothing a reader can see. Judging stays with the caller, which
 * walks its population in its own order and looks each gate's result up here.
 */
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import process from "node:process";

/** How long one gate's default run may take before it is reported as having printed nothing. */
const GATE_RUN_TIMEOUT_MS = 120_000;

/** How many gate default runs may be in flight at once. */
const GATE_RUN_CONCURRENCY = 8;

/**
 * How long a killed gate may take to be gone before its run is reported on anyway.
 *
 * A run is reported when the child has EXITED, so a gate counted as `not_measured` is not still running beside whatever
 * the ladder starts next - the sweep is one member of a rung. The grace is the floor under a child that does not answer
 * the signal at all: the reading stops waiting for it, and the report says what it printed.
 */
const GATE_KILL_GRACE_MS = 10_000;

/**
 * Run one gate the way an operator does - its own default, no-argument, offline invocation - and resolve with what it
 * printed.
 *
 * `timeoutMs` travels in the result because the finding for a run that outlived it has to name the budget that run was
 * actually given; a reader who changes the budget then sees the new number in the report rather than an old one.
 */
function runGateDefault(path, { timeoutMs = GATE_RUN_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path], {
      cwd: dirname(path),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timer;
    let killed = false;
    const settle = (status) => {
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ timedOut: killed, timeoutMs, status, stdout, stderr });
    };
    timer = setTimeout(() => {
      killed = true;
      child.kill();
      // Settled on the child's own exit, not on the kill: `close` is the end of a gate that gave up its work, and the
      // grace timer is the only way a report is written while it is still alive.
      timer = setTimeout(() => settle(null), GATE_KILL_GRACE_MS);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += `${stderr.length === 0 ? "" : "\n"}${String(error?.message ?? error)}`;
      settle(null);
    });
    child.on("close", (status) => settle(status));
  });
}

/**
 * Every path's default run, bounded and out of order, keyed by the gate's own file path.
 *
 * `paths` is the caller's: which population members are executed is one derivation in
 * `tools/lib/harness-conformance.mjs`, so a gate cannot be run without being judged or judged without having been run.
 */
export async function runGateDefaults({
  paths,
  concurrency = GATE_RUN_CONCURRENCY,
  timeoutMs = GATE_RUN_TIMEOUT_MS,
} = {}) {
  // Seeded in the caller's order and filled as runs finish, so the key order is the population's and not the
  // scheduler's.
  const runs = new Map(paths.map((path) => [path, undefined]));
  let claimed = 0;
  const worker = async () => {
    while (claimed < paths.length) {
      const path = paths[claimed];
      claimed += 1;
      runs.set(path, await runGateDefault(path, { timeoutMs }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, () => worker()));
  return runs;
}
