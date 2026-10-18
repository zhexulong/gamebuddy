import assert from "node:assert/strict";
import { test } from "node:test";

import { median, summarizeActionCadence } from "./action-cadence.mjs";

const entry = (dispatchedAtMs, settledAtMs, action = "move_to_tile") => ({
  action,
  dispatchedAtMs,
  ...(settledAtMs === null ? {} : { settledAtMs }),
});

test("the three spans are separated: execution, thinking, and the dispatch-to-dispatch gap", () => {
  // dispatch 1000 -> settled 1300 (exec 300) -> next dispatch 5000 (think 3700, idle 4000)
  const cadence = summarizeActionCadence([entry(1000, 1300), entry(5000, 5400), entry(6000, 6100)]);
  assert.equal(cadence.actions, 3);
  assert.equal(cadence.measured, 3);
  assert.equal(cadence.unmeasured, 0);
  assert.equal(cadence.execMs.median, 300);
  assert.equal(cadence.execMs.max, 400);
  assert.equal(cadence.thinkMs.median, Math.round((3700 + 600) / 2));
  assert.equal(cadence.idleMs.median, Math.round((4000 + 1000) / 2));
});

test("an action with no terminal timestamp is COUNTED and excluded, never treated as instant", () => {
  // The night's own failure shape: a dispatch whose receipt never arrived (the night stall). Counting it as zero
  // would report an excellent cadence for the run that had no cadence at all.
  const cadence = summarizeActionCadence([entry(1000, 1300), entry(5000, null)]);
  assert.equal(cadence.actions, 2);
  assert.equal(cadence.measured, 1);
  assert.equal(cadence.unmeasured, 1);
  assert.equal(cadence.execMs.median, 300);
  // The think span ACROSS the unmeasured action is still measurable (this action's terminal is known) - what is
  // impossible is measuring the unmeasured action's own execution, and that is what `unmeasured` reports.
  assert.equal(cadence.thinkMs.median, 3700);
  assert.equal(cadence.idleMs.median, 4000);
});

test("a settled timestamp before its dispatch is refused as unmeasured rather than yielding a negative span", () => {
  const cadence = summarizeActionCadence([entry(5000, 4000)]);
  assert.equal(cadence.unmeasured, 1);
  assert.equal(cadence.execMs.median, null);
});

test("the summary is ordered by dispatch time, not by trace order", () => {
  // A receipt-driven trace append can land out of order, and a summary that trusted the array order would produce
  // negative or absurd spans.
  const cadence = summarizeActionCadence([entry(5000, 5400), entry(1000, 1300)]);
  assert.equal(cadence.idleMs.median, 4000);
  assert.equal(cadence.thinkMs.median, 3700);
});

test("an empty or malformed trace answers with nulls instead of zeros", () => {
  // A well-formed but empty trace keeps its SHAPE (so a caller can read `.execMs.median` without a null guard),
  // while a malformed input has no shape to promise and answers flat nulls.
  const empty = summarizeActionCadence([]);
  assert.equal(empty.actions, 0);
  assert.equal(empty.execMs.median, null);
  assert.equal(empty.execMs.max, null);
  assert.equal(empty.idleMs.median, null);
  for (const input of [null, undefined, "nope"]) {
    const cadence = summarizeActionCadence(input);
    assert.equal(cadence.actions, 0);
    assert.equal(cadence.execMs, null);
    assert.equal(cadence.idleMs, null);
  }
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 3]), 2);
});
