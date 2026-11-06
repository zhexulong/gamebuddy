/**
 * The run trace export: one run's spans turned into the Chrome-trace file a viewer opens.
 *
 * Every run's evidence is this artifact - the same shape `chrome://tracing`, Chrome DevTools and
 * Perfetto read with no conversion - so it is written once per run over however many spans that
 * run recorded. The op is the whole export (`toChromeTrace` plus the write), because that is what
 * a run pays; the span count is the input that scales, and a serialisation that walks every span
 * for every span would only show up at the large size.
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadHostModule, measure, measureRatio, report, reportScaling, scalingRequested } from "./harness.mjs";

const CASE = "trace.export";

const { createRunTrace, toChromeTrace, writeRunTrace } = await loadHostModule("run-trace.js");

/** A short action family's trace, and a long multi-day run's. */
const SIZES = Object.freeze([
  Object.freeze({ size: "small", spans: 25 }),
  Object.freeze({ size: "large", spans: 2000 }),
]);

/**
 * What an export's cost may do with the spans it carries, and why.
 *
 * The export walks every span once to build the document and stringifies the whole array, so 80x the
 * spans must cost about 80x - this is the case where the input genuinely reaches the work. Measured on
 * this machine the pair (25 -> 2 000 spans, 80x) read 530.32 -> 1 984.91 µs/op, ratio 3.74, and
 * 538.79 -> 1 798.17, ratio 3.34, on a later run: the write's own fixed cost is ~511 µs, which the short
 * trace pays in full and the long one amortises. A serialisation that walked every span for every span
 * would grow the span part 80x over again and read ~220.
 *
 * WHY THIS BAND CLAIMS A CEILING ONLY: the small op is 95% file write, so a load that inflates that
 * write on both sides damps the ratio TOWARD 1 - measured 1.24 under a machine that was rebuilding a
 * neighbouring artifact while 40 processes competed. A floor would then red on contention while red-ing
 * on no defect, and a floor low enough to survive that (~1.1) could not tell a damped measurement from
 * an export that emitted no spans. So this case says what it can actually prove: the span cost must not
 * grow super-linearly. The export's content is the budget gate's and the run-evidence gates' subject.
 *
 * WHY THE CEILING IS 12 RATHER THAN 6: the readings below are all damped by that fixed write, and the
 * damping is a property of the machine, not of the code. This machine reads 3.34-4.32; the CI runner
 * (Linux) read 6.28 on the same commit, because its write is relatively cheaper, so less of the span cost
 * is hidden. A ceiling of 6 was therefore calibrated against a measurement the machine had already
 * softened, and it red-ed on a runner where the same linear export simply showed more of itself. The
 * signal this band exists to catch is two orders of magnitude away: a serialisation that walked every span
 * for every span reads ~220, so 12 still separates "linear" from "quadratic" with room for every damping
 * factor observed so far (1.24 damped, 6.28 least-damped).
 */
const SCALING_BAND = Object.freeze({
  min: 0,
  max: 12,
  reason:
    "80x the spans measured 3.34-4.32 here and 6.28 on the Linux CI runner (every span serialised once, " +
    "behind a fixed file write whose cost - and so whose damping - differs per machine); a serialisation " +
    "that walked every span for every span reads ~220, so the ceiling is what this band claims",
});

/** `count` closed action spans on a monotonic fake clock, so an export is a pure function of them. */
function spansFor(count) {
  let now = 0;
  const trace = createRunTrace("bench-trace", { now: () => (now += 1) });
  for (let index = 1; index <= count; index += 1) {
    const span = trace.begin("action", { actionIndex: index });
    span.end({ outcome: "settled" });
  }
  return trace.spans();
}

async function tempDirectory() {
  return mkdtemp(join(await realpath(tmpdir()), "gamebuddy-perf-trace-"));
}

/**
 * One span count's op: the trace it exports, the file it writes, and the bytes that come out. Both
 * branches of this file build the export here, so the ratio and the budget reading are the same work.
 */
async function caseFor({ spans }) {
  const directory = await tempDirectory();
  try {
    const recorded = spansFor(spans);
    const file = join(directory, "run-trace.json");
    return {
      exportBytes: Buffer.byteLength(`${JSON.stringify(toChromeTrace(recorded), null, 2)}\n`, "utf8"),
      spans: recorded.length,
      input: Object.freeze({ spans }),
      run: () => writeRunTrace(file, recorded),
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * One case's measurement, at module scope rather than inside the `test()` that reports it:
 * `writeRunTrace` awaits its file handle per op, and `node:test` instruments the async work a test
 * body awaits, so a body that ran these windows would charge the runner to the export. See
 * `measure`'s contract.
 */
async function measureCase(size) {
  const point = await caseFor(size);
  try {
    return {
      measured: await measure({ id: CASE, size: size.size, run: point.run }),
      spans: point.spans,
      exportBytes: point.exportBytes,
    };
  } finally {
    await point.close();
  }
}

if (scalingRequested()) {
  const points = [];
  try {
    for (const size of SIZES) points.push({ size: size.size, ...(await caseFor(size)) });
    const ratio = await measureRatio({ id: CASE, axis: "spans", points });
    test(`${CASE} scaling`, () => reportScaling(ratio, SCALING_BAND));
  } finally {
    for (const point of points) await point.close();
  }
} else {
  const outcomes = new Map();
  for (const size of SIZES) {
    try {
      outcomes.set(size.size, await measureCase(size));
    } catch (error) {
      // The case that could not be measured fails its own test below, instead of taking the other
      // size's finished measurement down with the file's module load.
      outcomes.set(size.size, { error });
    }
  }

  for (const { size } of SIZES) {
    test(`${CASE} ${size}`, () => {
      const outcome = outcomes.get(size);
      if (outcome.error !== undefined) throw outcome.error;
      report({ ...outcome.measured, detail: { spans: outcome.spans, exportBytes: outcome.exportBytes } });
    });
  }
}
