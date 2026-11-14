/*
 * The RUNTIME line counts the marks in THIS driver's window, not the page's whole buffer.
 *
 * Measured 2026-11-15 (`shots` run, driver `n-message-edit`): `RUNTIME n: domNodes=… marks=124` sat
 * beside `TIMINGS n: unobserved:no-turn-marks (0 mark(s) present)` - the same page described two
 * opposite ways, because `marks` counted `performance.getEntriesByType("mark").length` while every
 * other reading honoured the driver's `sinceMs` baseline. The drivers share one page, so the buffer
 * holds every earlier driver's turn and switch; on a run where a driver marked nothing, `marks=`
 * still read as though it had measured plenty.
 *
 * `observe` is driven here for real - the page double evaluates the function the product's reader
 * passes it - so this holds the LINE, not a re-implementation of the reader: the fake page's buffer
 * holds 124 marks that all predate the driver's baseline, and the line must read 0.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { observe } from "./observation.cjs";

/** A page whose `evaluate` runs the reader's own function against a fake timeline. */
function pageWith(marks, { sinceMs }) {
  const performance = {
    memory: { usedJSHeapSize: 1024 * 1024, totalJSHeapSize: 2 * 1024 * 1024 },
    getEntriesByType: (type) => (type === "mark" ? marks : []),
    now: () => sinceMs,
  };
  const document = { getElementsByTagName: () => new Array(237).fill(null) };
  return {
    evaluate: async (fn, arg) => {
      globalThis.performance = performance;
      globalThis.document = document;
      return await fn(arg);
    },
  };
}

const earlier = (count) =>
  Array.from({ length: count }, (_, index) => ({ name: "gamebuddy:turn:settled", startTime: index, detail: {} }));

const runtimeLine = (lines) => lines.find((line) => line.startsWith("RUNTIME"));

test("a driver that marked nothing reports marks=0, whatever the page holds", async () => {
  const said = [];
  const page = pageWith(earlier(124), { sinceMs: 900_000 });
  const observed = await observe(page, (...parts) => said.push(parts.join(" ")), "n", { sinceMs: 900_000 });
  assert.equal(
    observed.runtime.markCount,
    0,
    "the window is the reading; 124 marks before this driver are not its own",
  );
  assert.match(runtimeLine(said), /marks=0$/u, `the line says what the reading holds: ${runtimeLine(said)}`);
  assert.match(said.join("\n"), /TIMINGS n: unobserved:no-turn-marks \(0 mark\(s\) present\)/u);
});

test("marks this driver's window does hold are counted, and only those", async () => {
  const said = [];
  const marks = [...earlier(124), { name: "gamebuddy:switch:chat:done", startTime: 900_100, detail: {} }];
  const observed = await observe(pageWith(marks, { sinceMs: 900_000 }), (...parts) => said.push(parts.join(" ")), "n", {
    sinceMs: 900_000,
  });
  assert.equal(observed.runtime.markCount, 1, "one mark arrived after the baseline");
  assert.match(runtimeLine(said), /marks=1$/u);
});

test("no Performance API is null, not zero", async () => {
  const lines = [];
  const page = {
    evaluate: async (fn, arg) => {
      globalThis.document = { getElementsByTagName: () => [] };
      delete globalThis.performance;
      return await fn(arg);
    },
  };
  const observed = await observe(page, (...parts) => lines.push(parts.join(" ")), "n", { sinceMs: 10 });
  assert.equal(observed.runtime.markCount, null, "an unmeasured count is absent, never a zero that agrees with itself");
  assert.match(runtimeLine(lines), /marks=null$/u);
});
