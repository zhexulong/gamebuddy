/**
 * The measurement harness every benchmark file in this suite shares.
 *
 * WHY IT EXISTS: the repository had no benchmark tooling at all, and the numbers a run review
 * argued about were the ones a live run happened to print. Node already ships everything a
 * benchmark needs - `node:perf_hooks` for the clock, `node:test` as the runner, and `--cpu-prof`
 * for the flamegraph - so this file adds no dependency and no runner of its own.
 *
 * What a case is: one repeatable unit of work, measured as best-of-N fixed-duration windows.
 * `ops` counts EVERY op the case ran, warmup included, so a case can read one invariant counter
 * (journal appends, compactions, frames) around the whole call and compare it against what was
 * actually executed; `opsPerSecond` and `perOpMicros` come from the fastest window, which is the
 * least noisy reading of the same code.
 *
 * What a case is not: a threshold. Nothing here decides "too slow". The budgets live in
 * `tools/perf/baseline.json` and are enforced by `tools/check-perf-budget.mjs`.
 *
 * Benchmarks execute the Host's compiled test artifact through `tools/lib/host-test-module.mjs`, the
 * seam every harness that runs emitted Host modules already passes through. That seam also refuses a
 * stale artifact (`live_run_artifact_stale`), which matters more here than anywhere: a benchmark of an
 * artifact older than its sources reports a cost for code that is not the code under review.
 */
import { performance } from "node:perf_hooks";

import { loadHostTestModule } from "../lib/host-test-module.mjs";

/** One emitted Host module, path relative to the artifact root (`"run-trace.js"`). */
export async function loadHostModule(module) {
  return await loadHostTestModule(module);
}

/** The window a single round measures, and how many rounds a case runs. */
const DEFAULT_DURATION_MS = 200;
/** Best of five: this machine is shared with other lanes' builds, and the fastest window is the one
 * least contaminated by them. Measured spread across two consecutive three-round runs was up to
 * 31% (pipe.frame/large), which is why the gate's own tolerance is 50%. */
const DEFAULT_ROUNDS = 5;
const DEFAULT_WARMUP_MS = 50;

async function runWindow(run, deadlineMs, limit) {
  let ops = 0;
  while (ops < limit && performance.now() < deadlineMs) {
    const pending = run();
    // A synchronous op must not pay a microtask turn it never asked for; an async op is awaited.
    if (typeof pending?.then === "function") await pending;
    ops += 1;
  }
  return ops;
}

/**
 * Measures one case at one size.
 *
 * `run` is one op: it returns synchronously for CPU-bound work, or a promise for I/O work (a pipe
 * round trip, a durable append). The caller attaches what the op's input was to the reported
 * result, so a number carries the size it was measured at instead of being a number about nothing.
 *
 * `maxOps` bounds a case that grows a bounded resource, so it measures that resource's cost rather
 * than running into its cap: the windows then end by op count instead of by the clock.
 */
export async function measure({
  id,
  size,
  run,
  durationMs = DEFAULT_DURATION_MS,
  rounds = DEFAULT_ROUNDS,
  warmupMs = DEFAULT_WARMUP_MS,
  maxOps = Number.POSITIVE_INFINITY,
}) {
  // Warmup is bounded by the clock only: it exists to reach steady state, not to be counted against
  // the budget, and a case whose op is fast would otherwise spend its whole op cap before measuring.
  let ops = await runWindow(run, performance.now() + warmupMs, Number.POSITIVE_INFINITY);
  let measured = 0;
  let best;
  for (let round = 1; round <= rounds && measured < maxOps; round += 1) {
    const startedAt = performance.now();
    const roundOps = await runWindow(run, startedAt + durationMs, maxOps - measured);
    const elapsedMs = performance.now() - startedAt;
    measured += roundOps;
    ops += roundOps;
    const opsPerSecond = (roundOps / elapsedMs) * 1000;
    if (best === undefined || opsPerSecond > best.opsPerSecond) best = { roundOps, elapsedMs, opsPerSecond };
  }
  if (best === undefined) throw new Error(`perf_case_measured_no_ops:${id}:${size}`);
  return Object.freeze({
    id,
    size,
    ops,
    // Two decimals: a bench reports a measurement, not precision it does not have.
    opsPerSecond: round(best.opsPerSecond),
    perOpMicros: round((best.elapsedMs * 1000) / best.roundOps),
    rounds,
    durationMs,
  });
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * One machine-readable line per measured case. The line is the contract between a bench file and
 * `tools/check-perf-budget.mjs`: anything that prints it can be gated, and the reporter a run
 * chooses (spec, TAP, dot) only decides whether it is decorated around the marker.
 */
export const PERF_RESULT_MARKER = "PERF_RESULT";

export function report(result) {
  process.stdout.write(`${PERF_RESULT_MARKER} ${JSON.stringify(result)}\n`);
  return result;
}
