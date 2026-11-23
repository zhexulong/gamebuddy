/**
 * The boundary between a clause's MEASUREMENT and the run's RECORD.
 *
 * WHY THIS EXISTS. Measured 2026-11-23 (`round98`): fifteen minutes of a real world - 261 bridge facts, 188 weeds cut,
 * 76 rocks broken - and the run published nothing. `RECLAMATION_NOT_STAMPED { reasonCode:
 * run_reclamation_not_stamped:no_result_artifact }`, and the artifact that was written said `state blocked · reason
 * (none) · crossings (none) · tasks (not published) · submissions 0`.
 *
 * The run had not failed. It had FINISHED, and while it was assembling its record the action-breadth reader threw
 * (`action_breadth_baseline_coverage_floor_invalid:multiday_routine`: the baseline file was re-recorded at 17:36 while
 * the process that had loaded the previous reader at 17:28 was still running). The throw escaped `buildRunResult`, the
 * last-resort dump wrote its stub, and the world's only record was replaced by the stack trace of a reader.
 *
 * A reader answers a question ABOUT the run. It is not the run. So a reader that throws is a measurement this tree could
 * not take - a state an artifact can state - and `measureOrNotMeasured` is the ONE place that turns it into one:
 *
 *   not_measured:<clause>:<reason>
 *
 * It is placed where each clause is MEASURED, beside the clause it decides, and never inside a reader: a reader that
 * caught its own failure could return a number that looks measured (an empty population, a zero, a default), and this
 * tree has already paid for that shape - `not_measured` folded into `rich` reads as a pass nobody made.
 *
 * THE FAILURE IS LOUD IN TWO PLACES, because the artifact and the log are read by different people at different times:
 * the result publishes the code above (a `not_measured` with no reason is refused by the gate that reads the runner's
 * own call sites), and the log prints `MEASUREMENT_NOT_MEASURED` with the class, the message and the stack of the reader
 * that threw. A gap nobody can see is indistinguishable from a reading nobody took.
 */

/** The prefix every unmeasurable clause's verdict starts with: its own state, never folded into a pass or a failure. */
export const NOT_MEASURED = "not_measured";

/**
 * What a reader that threw is called in a code: its own message, on one line, or - when it carried none, which `new
 * Error()` does - the class that threw and the fact that it said nothing.
 *
 * A blank reason is not a smaller reason. `not_measured:<clause>:` with nothing after it is a code that names a gap
 * without naming why, which is the one thing a reader of the artifact cannot work around.
 */
function measurementReason(thrown) {
  let text = "";
  if (thrown instanceof Error) text = thrown.message;
  else if (typeof thrown === "string") text = thrown;
  else if (typeof thrown?.message === "string") text = thrown.message;
  const oneLine = String(text ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  if (oneLine.length > 0) return oneLine;
  const name = thrown instanceof Error && thrown.name ? thrown.name : typeof thrown;
  return `thrown_without_a_reason:${name}`;
}

/** `not_measured:<clause>:<reason>` - the ONE spelling of a measurement this tree could not take. */
export function notMeasuredCode(clause, thrown) {
  return `${NOT_MEASURED}:${clause}:${measurementReason(thrown)}`;
}

/**
 * The log line a gap earns: which clause, its code, the class and message of the throw, and the stack - one line, so a
 * log tail can carry it and a reader can open the frame that failed.
 */
export function measurementGapLine(clause, thrown) {
  const asText = thrown instanceof Error || typeof thrown === "string" ? thrown : null;
  return `MEASUREMENT_NOT_MEASURED ${JSON.stringify({
    clause,
    reasonCode: notMeasuredCode(clause, thrown),
    errorClass: thrown instanceof Error ? thrown.name : typeof thrown,
    errorMessage: asText instanceof Error ? asText.message : asText,
    stack: thrown instanceof Error ? (thrown.stack ?? null) : null,
  })}`;
}

/**
 * Run one clause's measurement, and answer with its value or with the named gap - never with a throw.
 *
 * A reader that RESOLVES to nothing is the same gap as one that throws: `undefined` is not a reading, and publishing it
 * as one would let the result carry a field that says `undefined` where a number was promised.
 */
export async function measureOrNotMeasured(clause, read) {
  let value;
  try {
    value = await read();
  } catch (thrown) {
    const notMeasured = notMeasuredCode(clause, thrown);
    console.error(measurementGapLine(clause, thrown));
    return Object.freeze({ value: null, notMeasured });
  }
  if (value === undefined) {
    const notMeasured = notMeasuredCode(clause, "reader_returned_no_value");
    console.error(measurementGapLine(clause, "reader_returned_no_value"));
    return Object.freeze({ value: null, notMeasured });
  }
  return Object.freeze({ value, notMeasured: null });
}

/**
 * A clause for a measurement that could not be taken, in the shape every clause in the verdict has.
 *
 * `passed` is the CALLER's decision, because a gap means different things to different clauses and the clause is where
 * that is decided: a breadth reading nobody could take must not fail the run it was handed, while the run's own clock
 * and execution record are the two questions a gap cannot answer for it.
 */
export function gapClause(clause, notMeasured, { passed }) {
  return Object.freeze({ id: clause, passed, reasonCode: notMeasured });
}
