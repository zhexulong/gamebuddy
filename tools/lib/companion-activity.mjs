/**
 * The run's activity points: what the companion was doing, from the Host's own log.
 *
 * <p>
 * `host/src/companion-activity.ts` prints one `COMPANION_ACTIVITY` line per transition on the same channel as the
 * per-turn delivery account: the state (`thinking`, `speaking`, `working`, `busy`, `idle`) and the wall-clock
 * millisecond it was entered. The run bundle carries them so a post-run reader can answer the question the `round39`
 * audit could not: a silent stretch was a companion choosing not to speak, or a pipeline with nothing waking her?
 * </p>
 * <p>
 * MEASURED 2026-11-06 (`round39`): the first visible text arrived 902 s after the run started and one stretch inside it
 * put nothing in front of the player for 709 s. Every bundle from every run before this one answers `not established`
 * for both, because no layer recorded the state at all.
 * </p>
 */

/** The Host's line name, verbatim (`COMPANION_ACTIVITY_LINE`). A test asserts the two spellings agree. */
export const ACTIVITY_LINE_PREFIX = "COMPANION_ACTIVITY ";

/**
 * How many points the bundle carries.
 *
 * Sized from the channel's own traffic, not from taste: a transition is published per turn, per assistant message and
 * per tool call, so a measured 48-minute run's ~75 turns and ~60 paragraphs stay inside one bound. The FIRST points are
 * kept and the remainder is counted, because the stretch a silence audit reads is the run's opening - a time-to-first-
 * bubble of 902 s is a fact about the beginning, and no later point can reconstruct it.
 */
export const ACTIVITY_POINT_LIMIT = 512;

/**
 * Every activity point in a run's own log text.
 *
 * A line that does not parse is COUNTED rather than dropped: points this module could not read are not a run that was
 * never idle, and the caller has to be able to see the difference.
 */
export function readActivityPoints(logText) {
  const records = [];
  let unparsable = 0;
  for (const line of String(logText ?? "").split("\n")) {
    if (!line.startsWith(ACTIVITY_LINE_PREFIX)) continue;
    try {
      const record = JSON.parse(line.slice(ACTIVITY_LINE_PREFIX.length));
      if (record === null || typeof record !== "object" || Array.isArray(record)) throw new Error("not_an_object");
      if (typeof record.state !== "string" || !Number.isFinite(record.atMs)) throw new Error("not_a_point");
      records.push(Object.freeze({ state: record.state, atMs: record.atMs }));
    } catch {
      unparsable += 1;
    }
  }
  return Object.freeze({ records: Object.freeze(records), unparsable });
}

/**
 * The bundle field, or the word `not_measured`.
 *
 * <p>
 * `not_measured` is the reason this function exists rather than the runner writing `records` straight through: an empty
 * array in a bundle reads as "she was never idle and never thinking", which is a claim about a run - and it is the same
 * array a run whose channel never wrote a line would carry. A run that published nothing says so.
 * </p>
 * <p>
 * Bounded here rather than in the Host, because the Host retains nothing: every point it publishes is written once and
 * forgotten, so no buffer there needs a drain. `omitted` is how many later points the bundle did not carry, and
 * `points.length + omitted` is the number the run actually published.
 * </p>
 */
export function summarizeActivity({ records, unparsable = 0, limit = ACTIVITY_POINT_LIMIT }) {
  const all = records ?? [];
  if (all.length === 0 && unparsable === 0) return "not_measured";
  const kept = all.slice(0, limit);
  return Object.freeze({
    points: Object.freeze(kept.map((point) => Object.freeze({ state: point.state, atMs: point.atMs }))),
    omitted: all.length - kept.length,
    unreadable: unparsable,
  });
}
