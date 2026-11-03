/**
 * The measurement harness every benchmark file in this suite shares.
 *
 * WHY IT EXISTS: the repository had no benchmark tooling at all, and the numbers a run review
 * argued about were the ones a live run happened to print. Node already ships everything a
 * benchmark needs - `node:perf_hooks` for the clock, `node:test` as the runner, and `--cpu-prof`
 * for the flamegraph - so this file adds no dependency and no runner of its own.
 *
 * What a case is: one repeatable unit of work, measured as best-of-N fixed-duration windows.
 * `opsPerSecond` and `perOpMicros` come from the fastest window, which is the least noisy reading of the
 * same code; `durationMs` is how long that window actually took, against the `windowMs` it was allowed,
 * and `ops` is what the measured windows ran, so both numbers in front of a reader are measured. A case
 * that reads one invariant counter (journal appends, compactions, frames) around the whole call compares
 * it against `ops + warmupOps`: warmup runs the same op and is reported apart from `ops` because it is a
 * cost the case paid and not a window the case timed.
 *
 * What a case is not: a threshold. Nothing here decides "too slow". The budgets live in
 * `tools/perf/baseline.json` and are enforced by `tools/check-perf-budget.mjs`; the size axis a case
 * scales along, and the band its ratio must stay in, are enforced by `tools/check-perf-scaling.mjs`.
 * Both read the same measured windows and neither one is a copy of the other's numbers.
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
const DEFAULT_WINDOW_MS = 200;
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
 * CALL IT OUTSIDE A `test()` BODY. `node:test` enables async_hooks to track the resources a test
 * awaits, and a promise-heavy op then pays for that tracking: the same admission op read 21.11 and
 * 21.39 µs/op inside a test body against 11.43 and 13.11 µs/op at module scope, in one process. A
 * test may still assert on the returned result and print it; what it must not do is run the windows.
 *
 * `maxOps` bounds a case that grows a bounded resource, so it measures that resource's cost rather
 * than running into its cap: the windows then end by op count instead of by the clock. It is the
 * budget for the WHOLE case, split evenly across `rounds`, so a bounded case still runs every round
 * and its total spend on the resource is what it always was. It used to be a cap on the running
 * total instead, which truncated the last round and stopped the loop: `admission.action/small` spent
 * its 4000 ops inside ONE 200 ms window and still reported `rounds: 5`, so the number was a
 * best-of-one presented as a best-of-five.
 *
 * `windowMs` is what the case ASKS a round for, and `durationMs` is what the reported round took. The two
 * differ whenever the op cap binds: `admission.action` at both sizes never reaches its 200 ms (800 ops a
 * round took 8.4 ms at `small` and 79.9 ms at `large` on the run this was measured on), and `journal.write`
 * binds too on a box fast enough to reach its 300-op rounds inside the window (113.6 of 200 ms there).
 * Without the measured value, every one of those cases reported the 200 it asked for.
 */
export async function measure({
  id,
  size,
  run,
  windowMs = DEFAULT_WINDOW_MS,
  rounds = DEFAULT_ROUNDS,
  warmupMs = DEFAULT_WARMUP_MS,
  maxOps = Number.POSITIVE_INFINITY,
}) {
  // Warmup is bounded by the clock only: it exists to reach steady state, not to be counted against
  // the budget, and a case whose op is fast would otherwise spend its whole op cap before measuring.
  const warmupOps = await runWindow(run, performance.now() + warmupMs, Number.POSITIVE_INFINITY);
  const perRoundLimit = maxOps === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Math.floor(maxOps / rounds);
  // A cap that cannot give every round an op would measure fewer windows than it reports; that is a
  // case whose budget is wrong, and it fails here rather than in a number nobody can reproduce.
  if (perRoundLimit < 1) throw new Error(`perf_case_op_cap_below_rounds:${id}:${size}:${maxOps}<${rounds}`);
  let best;
  let windows = 0;
  let ops = 0;
  for (let round = 1; round <= rounds; round += 1) {
    const startedAt = performance.now();
    const roundOps = await runWindow(run, startedAt + windowMs, perRoundLimit);
    const elapsedMs = performance.now() - startedAt;
    ops += roundOps;
    windows += 1;
    const opsPerSecond = (roundOps / elapsedMs) * 1000;
    if (best === undefined || opsPerSecond > best.opsPerSecond) best = { roundOps, elapsedMs, opsPerSecond };
  }
  if (best === undefined) throw new Error(`perf_case_measured_no_ops:${id}:${size}`);
  return Object.freeze({
    id,
    size,
    // What the MEASURED windows ran - the count the two rates below are about. Warmup is a separate,
    // named number: a case whose invariant counter wraps the whole call sums the two.
    ops,
    warmupOps,
    // Two decimals: a bench reports a measurement, not precision it does not have.
    opsPerSecond: round(best.opsPerSecond),
    perOpMicros: round((best.elapsedMs * 1000) / best.roundOps),
    // The windows that actually ran, never the configured count: a reader who sees 5 must have a
    // best-of-five in front of them.
    rounds: windows,
    // The window the round behind `opsPerSecond` and `perOpMicros` actually took, and the one it was
    // allowed. A round ends at `windowMs` or at its op cap, whichever comes first: a case whose cap
    // binds reports the milliseconds it ran rather than the 200 it asked for, and a round that ended on
    // the clock reports `windowMs` plus the one op that overran it.
    durationMs: round(best.elapsedMs),
    windowMs,
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

/**
 * The switch that turns the same bench file into a ratio measurement for `tools/check-perf-scaling.mjs`.
 *
 * WHY A SWITCH AND NOT A SECOND BENCH FILE: the fixtures that build the input (a journal on disk, an
 * echo server on a named pipe, a presentation port with its two admissions) are the expensive, and the
 * hard, part of a case. A scaling copy of each would be a second spelling of every one of them, and the
 * two spellings would drift - the ratio would then describe different work than the budget does. So the
 * bench asks for the pair instead of a budget reading, and builds its fixtures exactly the way it always
 * has. The default run is untouched: without the switch the file measures the sizes it always measured
 * and prints only `PERF_RESULT`, which is what `tools/check-perf-budget.mjs` reads.
 */
export const PERF_SCALING_ENV = "GAMEBUDDY_PERF_SCALING";

export function scalingRequested() {
  return process.env[PERF_SCALING_ENV] === "1";
}

/**
 * One machine-readable line per measured PAIR. The contract with `tools/check-perf-scaling.mjs`, and the
 * reason a measurement cannot be read as a bare number: the line carries the axis, both sizes, both
 * per-op costs, the ratio between them and the band the case declares.
 */
export const PERF_SCALING_MARKER = "PERF_SCALING_RESULT";

export function reportScaling(result, band) {
  process.stdout.write(`${PERF_SCALING_MARKER} ${JSON.stringify({ ...result, band })}\n`);
  return { ...result, band };
}

/** The input fields two points disagree on, so a ratio can never be read as a complexity measure of several at once. */
function differingInputFields([left, right]) {
  const fields = new Set([...Object.keys(left.input), ...Object.keys(right.input)]);
  return [...fields].filter((field) => left.input[field] !== right.input[field]).sort();
}

/**
 * Measures the same operation at two input sizes, ALTERNATING windows, and reports the ratio.
 *
 * WHY A RATIO AND NOT A COST: every absolute number in this suite is a fact about the machine - its
 * clock speed, how many other builds share its cores, which V8 generation warmed the process. A stored
 * absolute then has to be re-recorded whenever the box changes, which is why `tools/perf/baseline.json`
 * was re-recorded on every commit that touched it and caught nothing on the way. The ratio between two
 * sizes measured in one process has none of those dependencies: the machine scales both sides, the load
 * delays both sides, and warmup applies to the same functions on both sides. What is left is how the
 * cost follows the input, which is the one property of the code alone.
 *
 * WHY THE WINDOWS ALTERNATE, AND WHY THE RATIO IS THE MEDIAN OF THE PAIRS: measuring all of `from`
 * and then all of `to` charges any drift during the case - a neighbouring build starting, a GC settling
 * - to whichever side ran while it happened, and taking each side's FASTEST window is worse than that:
 * under a bursty load one side can find a clean window while the other never does, and the reported
 * ratio then describes the load's shape rather than the code's. Measured exactly that on this machine:
 * a flat append case read 7.35x under 40 competing processes with best-of-N per side, against 0.97x
 * idle. So each round measures both points, A then B, and the ratio is computed INSIDE the round, while
 * both sides share the same few hundred milliseconds of load; the reported number is the MEDIAN of the
 * round ratios, so a burst that hits one side of one round is an outlier rather than a reading. The
 * per-point numbers printed beside it are the median round's own windows, so the pair a reader sees
 * multiplies to the ratio they see.
 *
 * A ratio can still be damped TOWARD 1 by a load that adds the same delay to both sides (a fixed
 * setup, like a file write, inflates while the input-proportional part does not), which is why a
 * fixed-cost-dominated case declares a ceiling and not a floor: its own comment says so.
 *
 * THE PAIR MUST DIFFER ON ONE AXIS. Two simultaneous changes are not a complexity measure: the ratio
 * then belongs to the pair of changes, not to either axis. `differingInputFields` requires exactly the
 * declared field, so a bench that quietly varies a second one fails here instead of producing a number a
 * reader would have to distrust. `input[axis]` must also GROW: a ratio below 1 is a case measuring the
 * wrong direction.
 *
 * `maxOps` is a point's budget for the whole case, split across `rounds` like `measure`'s, so a case that
 * grows a bounded resource still runs every round; `windowMs` is the window a point asks for, and a
 * point may override it (the compaction case's folds are short, so it asks for shorter windows).
 */
export async function measureRatio({
  id,
  axis,
  points,
  rounds = DEFAULT_ROUNDS,
  warmupMs = DEFAULT_WARMUP_MS,
  windowMs = DEFAULT_WINDOW_MS,
}) {
  if (points.length !== 2) throw new Error(`scaling_pair_needs_two_points:${id}:${points.length}`);
  const [from, to] = points;
  if (axis === undefined || from.input?.[axis] === undefined || to.input?.[axis] === undefined)
    throw new Error(`scaling_pair_axis_not_an_input:${id}:${String(axis)}`);
  const differing = differingInputFields(points);
  if (differing.length !== 1 || differing[0] !== axis)
    throw new Error(`scaling_pair_not_single_axis:${id}:${differing.join("+") || "identical"}!=${axis}`);
  const multiple = to.input[axis] / from.input[axis];
  if (!(multiple > 1)) throw new Error(`scaling_pair_not_growing:${id}:${from.input[axis]}>=${to.input[axis]}`);
  const limits = points.map((point) => {
    const limit = point.maxOps === undefined ? Number.POSITIVE_INFINITY : Math.floor(point.maxOps / rounds);
    if (limit < 1) throw new Error(`perf_case_op_cap_below_rounds:${id}:${point.size}:${point.maxOps}<${rounds}`);
    return limit;
  });
  if (warmupMs > 0) {
    // A window each, not one shared deadline: the second point would otherwise warm up in whatever is
    // left of the first one's budget, which is nothing on a slow case.
    for (const point of points) await runWindow(point.run, performance.now() + warmupMs, Number.POSITIVE_INFINITY);
  }
  const perRound = [];
  const totals = points.map(() => 0);
  for (let round = 1; round <= rounds; round += 1) {
    const windows = [];
    for (const [index, point] of points.entries()) {
      const startedAt = performance.now();
      const windowOps = await runWindow(point.run, startedAt + (point.windowMs ?? windowMs), limits[index]);
      windows.push({ windowOps, elapsedMs: performance.now() - startedAt });
      totals[index] += windowOps;
    }
    // The ratio of THIS round's pair: both sides ran inside the same few hundred milliseconds.
    perRound.push({
      windows,
      ratio: windows[1].elapsedMs / windows[1].windowOps / (windows[0].elapsedMs / windows[0].windowOps),
    });
  }
  // Median by round ratio: with an odd round count that is a real round, so the pair reported below is
  // the one the number came from; with an even count it is the element above the midpoint.
  const byRatio = [...perRound].sort((left, right) => left.ratio - right.ratio);
  const median = byRatio[Math.floor(rounds / 2)];
  return Object.freeze({
    id,
    axis,
    // Both decimals as measured facts: the multiple is the input's own ratio, the ratio is the cost's.
    multiple: round(multiple),
    ratio: round(median.ratio),
    points: Object.freeze(
      points.map((point, index) =>
        Object.freeze({
          size: point.size,
          value: point.input[axis],
          // Every measured window's ops, warmup excluded: the count an invariant counter straddles.
          ops: totals[index],
          // The median round's own pair, so the numbers in front of a reader are one measurement and
          // their quotient is the reported ratio.
          perOpMicros: round((median.windows[index].elapsedMs * 1000) / median.windows[index].windowOps),
          durationMs: round(median.windows[index].elapsedMs),
        }),
      ),
    ),
    // Every round's ratio, so the spread the median was taken from is a reading and not a claim.
    ratios: Object.freeze(byRatio.map((entry) => round(entry.ratio))),
    rounds,
  });
}
