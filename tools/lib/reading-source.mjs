/**
 * WHICH FILE A READING WAS READ FROM, said on every reading and counted at the end of the tool.
 *
 * WHY. A run publishes `result.json` only when it ENDS, so every reading taken before that has to come from the runner's
 * log instead - and the two files cannot agree on a run that is still going: the log holds what had happened when it was
 * last written, the bundle holds the run's final account. Measured 2026-11-19 (`round77`, complete): the bundle names 476
 * executions in 24 actions, its log holds 469 executions in 24 - the seven absent ones are executions that settled
 * without a receipt, and the difference is a FACT to print rather than a number to reconcile. A reading that does not say
 * which of the two it came from is a reading a reader has to guess about, which is how "this run is doing fine" gets
 * printed over a partial run.
 *
 * THE RULE IS READ OFF THE PRINTED TEXT, not off a caller's intention. A value that starts with `not_measured` is not a
 * reading: it is the statement that no source answers this, and it belongs to the artifact that is missing. A value is a
 * reading, and every reading names its source or the gate fails - `a_reading_names_the_source_it_read:<reading>`. So the
 * one thing a caller cannot do is print a number and stay silent about where it came from, and the ledger never has to
 * trust a flag: `say(label, value, source)` is all a tool writes, and the ledger decides from the same text the reader
 * sees.
 *
 * THE THREE ZEROES ARE TOLD APART. No readings at all is BLOCKED, naming the gate - a tool that printed nothing has
 * measured nothing, and `0 unmeasured` out of `0 examined` agrees with itself. A reading with no source fails. A
 * `not_measured` value is neither, and is counted as absent rather than folded into either.
 */

/** The run's own final account, written when it ends. */
export const FROM_RESULT = "result.json";

/** The runner's own log, written as the run happens. */
export const FROM_RUNNER_LOG = "live-runner.log";

export const SOURCE_GATE = "a_reading_names_the_source_it_read";

const NOT_MEASURED = "not_measured";

function textOf(value) {
  return typeof value === "string" ? value : String(value ?? "");
}

/**
 * A ledger of the readings one tool printed, each with the file it was read from.
 *
 * `source` is `FROM_RESULT`, `FROM_RUNNER_LOG`, or `null` for a value printed with no file behind it - which is the
 * state the gate fails on. A fourth state, `absent`, is a `not_measured` value and is not a reading.
 *
 * `requireReadings` says whether the readings ARE the tool's answer (`action-breadth`, `airp-scorecard`: a tool that
 * printed no reading measured nothing) or are one block beside other rows (`round-verdict`: a run with no log at all has
 * no reading of it to take, and that absence is printed by the block itself). Only the first kind fails on a population
 * of zero.
 */
export function createReadingLedger({ requireReadings = true } = {}) {
  const entries = [];
  const note = (reading, value, source) => {
    if (typeof reading !== "string" || reading.trim().length === 0)
      throw new Error("reading_source_unnamed_reading: every reading needs a name a failure can point at");
    const absent = textOf(value).trimStart().startsWith(NOT_MEASURED);
    entries.push(Object.freeze({ reading, absent, source: absent ? null : source }));
    return value;
  };
  const readings = () => entries.filter((entry) => !entry.absent);
  return Object.freeze({
    /** A reading whose value came from the run's own bundle. */
    fromResult: (reading, value) => note(reading, value, FROM_RESULT),
    /** A reading whose value came from the runner's log: the only record a run still has before it ends. */
    fromLog: (reading, value) => note(reading, value, FROM_RUNNER_LOG),
    /** A value printed with no file behind it. This is the failure the gate names, and the only way to reach it. */
    unsourced: (reading, value) => note(reading, value, null),
    /** The readings taken, in the order they were printed. */
    readings,
    /** The `not_measured` values: stated absences, never readings. */
    absences: () => entries.filter((entry) => entry.absent).map((entry) => entry.reading),
    /** Whether this ledger fails the gate: a reading with no source, or no readings at all when they are the answer. */
    failed() {
      const examined = readings();
      return examined.some((entry) => entry.source === null) || (requireReadings && examined.length === 0);
    },
    /** The gate's lines: one per unsourced reading, then the summary. */
    lines() {
      const examined = readings();
      const fromResult = examined.filter((entry) => entry.source === FROM_RESULT).length;
      const fromLog = examined.filter((entry) => entry.source === FROM_RUNNER_LOG).length;
      const unmeasured = examined.filter((entry) => entry.source !== FROM_RESULT && entry.source !== FROM_RUNNER_LOG);
      const lines = unmeasured.map(
        (entry) =>
          `${SOURCE_GATE}:${entry.reading} - printed a value and named no file it was read from; a reading is read from ${FROM_RESULT} or from ${FROM_RUNNER_LOG}, and saying which is what makes a partial run's number readable`,
      );
      if (examined.length === 0 && requireReadings)
        lines.push(
          `${SOURCE_GATE}:blocked - readings examined 0 · from-result 0 · from-log 0 · unmeasured 0 · this tool printed no reading any artifact answers, so it measured nothing and its clean exit would agree with itself`,
        );
      lines.push(
        `${SOURCE_GATE} readings examined ${String(examined.length)} · from-result ${String(fromResult)} · from-log ${String(fromLog)} · unmeasured ${String(unmeasured.length)}`,
      );
      return lines;
    },
  });
}
