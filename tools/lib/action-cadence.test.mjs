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
  // The SUM is what the pre-registered metric divides by the wall clock, and a median cannot stand in for it.
  assert.equal(cadence.execMs.sum, 800, "the fixture executes 300 + 400 + 100 milliseconds of game work");
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

/**
 * A execution the Mod ran natively: `atMs` is the moment it dispatched, `settledAtMs` the moment the action's terminal
 * landed - both on the game's monotonic clock (`BodyProgramJournalClock`), neither taken by this evaluator.
 */
const programExecution = (atMs, settledAtMs) => ({ atMs, settledAtMs });

test("a run whose work all went through programs gets a real execMs from the game's own stamps", () => {
  // Measured on a finished run: `executions 379, of which timed 0`, so `execMs.median` was null on a run that executed
  // 379 times. The stamps are the journal's, the durations are the game's work, and the median is over REAL executions.
  const cadence = summarizeActionCadence(
    [],
    [programExecution(1000, 1300), programExecution(5000, 5400), programExecution(6000, 6150)],
  );
  assert.equal(cadence.actions, 3);
  assert.equal(cadence.measured, 3);
  assert.equal(cadence.unmeasured, 0);
  assert.equal(cadence.flat, 0, "a program-path run has no flat request frame at all");
  assert.equal(cadence.program, 3);
  assert.equal(cadence.execMs.median, 300);
  assert.equal(cadence.execMs.max, 400);
  assert.equal(cadence.execMs.sum, 850);
  // A game clock cannot measure the agent's thinking, and mixing the two clocks for a gap would be meaningless: the
  // fields stay null rather than borrowing the flat channel's numbers.
  assert.equal(cadence.thinkMs.median, null);
  assert.equal(cadence.idleMs.median, null);
});

test("an unsettled or untimed program execution is COUNTED and excluded, never read as instant", () => {
  const cadence = summarizeActionCadence(
    [],
    [
      programExecution(1000, 1300),
      programExecution(5000, null),
      programExecution(null, 9000),
      programExecution(9000, 8000),
    ],
  );
  assert.equal(cadence.actions, 4);
  assert.equal(cadence.measured, 1, "only the executed-and-settled one is a duration");
  assert.equal(cadence.unmeasured, 3, "a never-settled, a never-timed and a backwards one are all unmeasured");
  assert.equal(cadence.execMs.median, 300);
  assert.equal(cadence.execMs.sum, 300);
});

test("both channels share execMs, while thinkMs and idleMs stay on the flat clock that can measure them", () => {
  // A duration is a difference of two readings of ONE clock, so a game-clock execution and a runner-clock dispatch can
  // sit in the same execMs columns. The gaps between them cannot: subtracting a game-clock reading from a runner-clock
  // one produces a number with no meaning, so only the flat channel feeds thinkMs/idleMs.
  const cadence = summarizeActionCadence(
    [entry(1000, 1200), entry(5000, 5900)],
    [programExecution(100, 500), programExecution(2000, 2200)],
  );
  assert.equal(cadence.actions, 4);
  assert.equal(cadence.flat, 2);
  assert.equal(cadence.program, 2);
  assert.equal(cadence.measured, 4);
  assert.deepEqual(
    [cadence.execMs.sum, cadence.execMs.max],
    [200 + 900 + 400 + 200, 900],
    "the sum and max are over both channels' real durations",
  );
  assert.equal(cadence.thinkMs.median, 3800, "the one flat gap (5000 - 1200), and the program rows are not in it");
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
