import assert from "node:assert/strict";
import test from "node:test";
import { gapClause, measurementGapLine, measureOrNotMeasured, notMeasuredCode } from "./measurement-boundary.mjs";

test("a reader that throws becomes not_measured:<clause>:<reason>, never a throw of its own", async () => {
  // MEASURED 2026-11-23 (`round98`): the action-breadth baseline reader threw while a finished run was assembling its
  // record, the throw escaped `buildRunResult`, and fifteen minutes of real world work (261 facts, 188 weeds, 76 rocks)
  // was replaced by the reader's stack trace.
  const reading = await measureOrNotMeasured("action_breadth", () => {
    throw new Error("action_breadth_baseline_coverage_floor_invalid:multiday_routine");
  });
  assert.equal(reading.value, null, "a measurement that threw has no value to publish");
  assert.equal(
    reading.notMeasured,
    "not_measured:action_breadth:action_breadth_baseline_coverage_floor_invalid:multiday_routine",
    "the code carries the clause AND the reader's own reason, so a reader of the artifact can act on it",
  );
  // The successful side, unchanged: a value is a value, and nothing is invented around it.
  const measured = await measureOrNotMeasured("action_breadth", async () => ({ verdict: "rich" }));
  assert.deepEqual(measured, { value: { verdict: "rich" }, notMeasured: null });
});

test("a measurement gap always names a reason, whatever the reader threw", async () => {
  // THE GATE: `not_measured:<clause>:` with nothing after it is a code that names a gap without naming why, which is the
  // one thing a reader of the artifact cannot work around. Every shape a throw can take is one member of this population.
  const thrown = [
    new Error("action_breadth_baseline_unreadable"),
    // `new Error()` carries an EMPTY message: the shape that would mint a reason nobody could read.
    new Error(),
    "the journal could not be read",
    "",
    null,
    undefined,
    42,
    { reasonCode: "snapshot_unreadable" },
  ];
  for (const one of thrown) {
    const code = notMeasuredCode("game_clock", one);
    assert.match(
      code,
      /^not_measured:game_clock:.+$/u,
      `a throw of ${typeof one} ${one instanceof Error ? `(${JSON.stringify(one.message)})` : `(${String(one)})`} must still name a reason, got ${code}`,
    );
  }
  // A message that spans lines does not become a code that spans lines.
  assert.equal(
    notMeasuredCode("action_breadth", new Error("two\nlines\there")),
    "not_measured:action_breadth:two lines here",
  );
  // The message an object carries is the message, not `[object Object]`.
  assert.equal(
    notMeasuredCode("execution_trace", { message: "journal_unreadable" }),
    "not_measured:execution_trace:journal_unreadable",
  );
  // A reader that resolves to NOTHING is the same gap: `undefined` is not a reading.
  const nothing = await measureOrNotMeasured("delivery_account", async () => undefined);
  assert.equal(nothing.value, null);
  assert.equal(nothing.notMeasured, "not_measured:delivery_account:reader_returned_no_value");
});

test("the gap is printed with the reader that threw and its stack, so the log says which frame failed", async () => {
  const line = measurementGapLine("action_breadth", new Error("action_breadth_baseline_coverage_floor_invalid"));
  const parsed = JSON.parse(line.slice(line.indexOf(" ") + 1));
  assert.equal(line.startsWith("MEASUREMENT_NOT_MEASURED "), true, "one greppable token introduces the line");
  assert.equal(parsed.clause, "action_breadth");
  assert.equal(parsed.reasonCode, "not_measured:action_breadth:action_breadth_baseline_coverage_floor_invalid");
  assert.equal(parsed.errorClass, "Error");
  assert.equal(parsed.errorMessage, "action_breadth_baseline_coverage_floor_invalid");
  assert.match(parsed.stack, /^Error: action_breadth_baseline_coverage_floor_invalid\n\s+at /u, "the stack travels");
  // The same line is what the boundary writes, so a gap is never silent: the artifact and the log are read by different
  // people at different times.
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    await measureOrNotMeasured("game_clock", () => {
      throw new Error("clock_unreadable");
    });
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.match(
    logged[0],
    /^MEASUREMENT_NOT_MEASURED \{.*"clause":"game_clock".*"reasonCode":"not_measured:game_clock:clock_unreadable"/u,
  );
});

test("a gap is a clause in the verdict's own shape, with the clause deciding whether it passes", () => {
  // The caller decides, because a gap means different things to different clauses: a breadth reading nobody could take
  // must not fail the run it was handed, while the run's own clock is the question a gap cannot answer for it.
  const passed = gapClause("action_breadth", "not_measured:action_breadth:x", { passed: true });
  const blocked = gapClause("game_clock", "not_measured:game_clock:x", { passed: false });
  assert.deepEqual(passed, { id: "action_breadth", passed: true, reasonCode: "not_measured:action_breadth:x" });
  assert.deepEqual(blocked, { id: "game_clock", passed: false, reasonCode: "not_measured:game_clock:x" });
});
