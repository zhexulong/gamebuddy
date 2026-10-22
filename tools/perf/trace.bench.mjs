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

for (const { size, spans } of SIZES) {
  test(`${CASE} ${size}`, async () => {
    const directory = await tempDirectory();
    try {
      const recorded = spansFor(spans);
      const file = join(directory, "run-trace.json");
      const exportBytes = Buffer.byteLength(`${JSON.stringify(toChromeTrace(recorded), null, 2)}\n`, "utf8");
      const result = await measure({
        id: CASE,
        size,
        run: () => writeRunTrace(file, recorded),
      });
      report({ ...result, detail: { spans: recorded.length, exportBytes } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
