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

import { loadHostModule, measure, report } from "./harness.mjs";

const CASE = "trace.export";

const { createRunTrace, toChromeTrace, writeRunTrace } = await loadHostModule("run-trace.js");

/** A short action family's trace, and a long multi-day run's. */
const SIZES = Object.freeze([
  Object.freeze({ size: "small", spans: 25 }),
  Object.freeze({ size: "large", spans: 2000 }),
]);

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
 * One case's measurement, at module scope rather than inside the `test()` that reports it:
 * `writeRunTrace` awaits its file handle per op, and `node:test` instruments the async work a test
 * body awaits, so a body that ran these windows would charge the runner to the export. See
 * `measure`'s contract.
 */
async function measureCase({ size, spans }) {
  const directory = await tempDirectory();
  try {
    const recorded = spansFor(spans);
    const file = join(directory, "run-trace.json");
    const exportBytes = Buffer.byteLength(`${JSON.stringify(toChromeTrace(recorded), null, 2)}\n`, "utf8");
    const measured = await measure({
      id: CASE,
      size,
      run: () => writeRunTrace(file, recorded),
    });
    return { measured, spans: recorded.length, exportBytes };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

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
