// A run must read its OWN result, and a bundle it did not write must be named rather than printed as a pass.
//
// The launcher and the iteration loop both name a bundle after the run, not the attempt, so a crashed attempt leaves the
// previous attempt's file where the report looks. The two decisions are asserted here against real files and real
// mtimes - a stub that returned `stale` would prove only that the stub returns `stale`.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { judgeResultFreshness, STALE_RESULT_PRECEDES_LAUNCH, supersedePreviousResult } from "./result-freshness.mjs";

/** A result bundle written `ageSeconds` ago, named the way both callers name it. */
function bundleAged(root, ageSeconds) {
  const path = join(root, "_morning_routine.result.json");
  writeFileSync(path, JSON.stringify({ state: "passed", attemptedActionIds: ["till_soil"] }), "utf8");
  const when = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(path, when, when);
  return path;
}

test("a bundle already at the path is moved aside and kept, never deleted", () => {
  const root = mkdtempSync(join(tmpdir(), "result-freshness-"));
  try {
    const resultPath = bundleAged(root, 600);
    const aside = supersedePreviousResult({ resultPath });

    assert.notEqual(aside, null);
    assert.match(aside, /_morning_routine\.result\.superseded-\d+\.json$/u);
    assert.equal(readFileSync(aside, "utf8"), JSON.stringify({ state: "passed", attemptedActionIds: ["till_soil"] }));
    assert.equal(judgeResultFreshness({ resultPath, launchedAtMs: Date.now() }).state, "absent");

    // Nothing to move is not a failure, and a second attempt must not invent one.
    assert.equal(supersedePreviousResult({ resultPath }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bundle that is not a regular file is refused rather than moved", () => {
  const root = mkdtempSync(join(tmpdir(), "result-freshness-link-"));
  try {
    const target = join(root, "_morning_routine.result.json");
    const link = join(root, "link.result.json");
    writeFileSync(target, "{}", "utf8");
    symlinkSync(target, link);
    assert.throws(() => supersedePreviousResult({ resultPath: link }), /refusing to move a non-regular result aside/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bundle written before the launch is named stale, never read as this attempt's", () => {
  const root = mkdtempSync(join(tmpdir(), "result-freshness-stale-"));
  try {
    const resultPath = bundleAged(root, 600);
    const launchedAtMs = Date.now();
    const freshness = judgeResultFreshness({ resultPath, launchedAtMs });

    assert.equal(freshness.state, "stale");
    assert.ok(freshness.behindMs >= 599_000, `the reading must say how far behind it was, got ${freshness.behindMs}`);
    assert.equal(
      freshness.reading,
      `${STALE_RESULT_PRECEDES_LAUNCH}: _morning_routine.result.json was written 600s before this attempt started`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bundle this launch wrote is fresh, and a missing one is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "result-freshness-fresh-"));
  try {
    const launchedAtMs = Date.now();
    const resultPath = bundleAged(root, 0);
    assert.deepEqual(judgeResultFreshness({ resultPath, launchedAtMs }), {
      state: "fresh",
      behindMs: 0,
      reading: null,
    });

    const missing = join(root, "_memory_covenant.result.json");
    assert.deepEqual(judgeResultFreshness({ resultPath: missing, launchedAtMs }), {
      state: "absent",
      behindMs: 0,
      reading: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Two seconds of tolerance, from `tools/lib/live-run-bundle.mjs`: a file system clock may lead the process clock by a
// tick, and a bundle written in the same second as the launch is still this launch's.
test("a bundle within the clock tolerance counts as this launch's", () => {
  const root = mkdtempSync(join(tmpdir(), "result-freshness-tolerance-"));
  try {
    const resultPath = bundleAged(root, 1);
    assert.equal(judgeResultFreshness({ resultPath, launchedAtMs: Date.now() }).state, "fresh");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
