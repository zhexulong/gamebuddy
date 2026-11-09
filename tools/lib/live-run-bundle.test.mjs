import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assessResultFreshness, assertResultLabel, planResultFile, supersededResultName } from "./live-run-bundle.mjs";

const repo = path.resolve("E:/projects/ai-game-companion");

test("a label that would escape tools/ is refused before anything is launched", () => {
  // The defect this replaces: the label was taken from argv verbatim, so `--label ../../x` named a file two
  // directories above `tools/`. A cleanup that had deleted it would have deleted a file nobody meant to touch.
  for (const label of ["../../x", "..", "a/b", "", "-leading-dash", "a b"]) {
    assert.throws(() => assertResultLabel(label), /invalid label/u, `label ${JSON.stringify(label)} must be refused`);
  }
  assert.equal(assertResultLabel("round40"), "round40");
  assert.equal(assertResultLabel("round-40.attempt_2"), "round-40.attempt_2");
});

test("the planned result file lives in tools/ and nowhere else", () => {
  const file = planResultFile({ repo, scenario: "multiday_routine", label: "round40" });
  assert.equal(path.dirname(file), path.join(repo, "tools"));
  assert.equal(path.basename(file), "_multiday_routine-round40.result.json");
});

test("a bundle written before this attempt started is stale, and one written after is not", () => {
  // Round40 attempt 2 ran 34 minutes and crossed both nights; the launcher printed attempt 1's `crossings 0 of 2`
  // because attempt 1's bundle was still there. This is that comparison, as a function.
  const launchedAtMs = 1_000_000;
  assert.equal(assessResultFreshness({ mtimeMs: launchedAtMs + 60_000, launchedAtMs }).fresh, true);
  assert.equal(assessResultFreshness({ mtimeMs: launchedAtMs - 2_000, launchedAtMs }).fresh, true);

  const stale = assessResultFreshness({ mtimeMs: launchedAtMs - 20 * 60_000, launchedAtMs });
  assert.equal(stale.fresh, false);
  assert.equal(stale.behindMs, 20 * 60_000);
});

test("a superseded bundle keeps the evidence under a name that says what it is", () => {
  const aside = supersededResultName("/repo/tools/_multiday_routine-round40.result.json", 1794224103914);
  assert.equal(aside, "/repo/tools/_multiday_routine-round40.result.superseded-1794224103914.json");
  assert.throws(() => supersededResultName("/repo/tools/run.json", 1), /not a result bundle name/u);
});
