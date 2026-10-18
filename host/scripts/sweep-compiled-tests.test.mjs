import assert from "node:assert/strict";
import test from "node:test";
import { summarizeChildOutput } from "./sweep-compiled-tests.mjs";

/**
 * The sweep's own reporting, because that is what broke first: a first hand-rolled version parsed the
 * suite log, kept the trailing `:remaining_ms=…` diagnostic as part of the last path, and reported
 * twelve files that do not exist as failures. The summary is now exercised against synthetic child
 * output rather than by running children.
 */

test("a passing child is summarized as passing, with its own tally", () => {
  const summary = summarizeChildOutput(
    ["✔ one (1ms)", "✔ two (2ms)", "ℹ tests 2", "ℹ pass 2", "ℹ fail 0"].join("\n"),
  );
  assert.deepEqual(summary.tally, { tests: 2, pass: 2, fail: 0 });
  assert.deepEqual(summary.names, []);
  assert.equal(summary.asserted, false);
  assert.equal(summary.environmental, false);
});

test("a failing test is named once, though node prints it twice", () => {
  const summary = summarizeChildOutput(
    [
      "✔ keeps working (1ms)",
      "✖ drops the bound (2ms)",
      "ℹ tests 2",
      "ℹ pass 1",
      "ℹ fail 1",
      "✖ failing tests:",
      "✖ drops the bound (2ms)",
      'AssertionError [ERR_ASSERTION]: expected the bound to hold',
    ].join("\n"),
  );
  assert.deepEqual(summary.names, ["drops the bound"]);
  assert.equal(summary.asserted, true);
  // A real assertion failure is never reclassified as the machine's fault.
  assert.equal(summary.environmental, false);
  assert.match(summary.cause, /AssertionError/u);
});

test("a transport failure with no assertion is environmental, not a defect", () => {
  const summary = summarizeChildOutput(
    [
      "✖ delegated handler keeps a bound (8ms)",
      "[TypeError: fetch failed] {",
      "  [cause]: Error: read ECONNRESET",
      "ℹ tests 1",
      "ℹ pass 0",
      "ℹ fail 1",
    ].join("\n"),
  );
  assert.equal(summary.environmental, true);
  assert.equal(summary.asserted, false);
});

test("the batch line's trailing diagnostic is not a path", () => {
  // The shape that produced twelve phantom failures: `paths=a.test.js,b.test.js:remaining_ms=1500000`.
  const line = "host_test_suite_batch_start:suite=compiled:batch=1/25:files=2:paths=a.test.js,b.test.js:remaining_ms=1500000";
  const paths = line
    .slice(line.indexOf("paths=") + "paths=".length)
    .split(",")
    .map((entry) => entry.trim().split(":")[0]);
  assert.deepEqual(paths, ["a.test.js", "b.test.js"]);
  for (const path of paths) assert.doesNotMatch(path, /remaining_ms/u);
});
