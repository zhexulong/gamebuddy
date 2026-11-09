/**
 * The run's own memory instrument, projected into the artifact an auditor reads.
 *
 * WHY this is a module and not three lines at the call site: measured 2026-11-09 (`round40`, a 34-minute multi-day run),
 * the runner wrote 46 `HOST_MEMORY_TURN` lines to its terminal log - first rss 316 MB, last 545 MB, max 632 MB - and the
 * bundle carried no memory field at all. "Was this one allocation spread or a leak" could only be answered by grepping a
 * log that is not the artifact, and the audit had to answer `not_measured` for memory on a run that had measured it 46
 * times. The instrument existed; the artifact could not read it.
 *
 * Two projections, both bounded:
 *
 *   - per turn, `{turn, rssMb, heapUsedMb, sessionBytes}` - the SHAPE, which the extremes cannot reconstruct: a run that
 *     climbs with turns and a run that jumps once on the first provider request have the same peak and opposite fixes;
 *   - the whole run's extremes (`startRssMb`, `minRssMb`, `maxRssMb`, `minFreeMb`), which survive any truncation.
 *
 * The cap drops the OLDEST points, because the question these answer is asked at the end of the run: the death is at the
 * tail, and `startRssMb` already keeps the start. What was dropped is counted (`omitted`), never silently gone.
 *
 * A run that took no turn sample publishes `state: "not_measured:no_turn_samples"` - a named reason, never a null and
 * never a zero that reads as "the host used no memory".
 */

/** How many per-turn points an artifact carries. A four-hour run makes far more turns than a reader will read. */
export const HOST_MEMORY_TURN_CAP = 60;

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** One turn's memory, keyed by the turn it was taken at. */
export function turnMemoryPoint({ turn, rssMb, heapUsedMb, sessionBytes = null }) {
  if (!Number.isInteger(turn)) throw new Error(`a turn memory point needs its turn number: ${String(turn)}`);
  if (!isFiniteNumber(rssMb)) throw new Error(`a turn memory point needs an rss reading: ${String(rssMb)}`);
  return Object.freeze({
    turn,
    rssMb,
    heapUsedMb: isFiniteNumber(heapUsedMb) ? heapUsedMb : null,
    // The retained-transcript proxy (Pi holds the session twice in RAM). Null when the record could not be stat'ed, so
    // "unreadable" never reads as "zero bytes".
    sessionBytes: isFiniteNumber(sessionBytes) ? sessionBytes : null,
  });
}

/**
 * Append one point to the bounded series, returning the new series and the running count of what the cap dropped.
 * Pure: the sampler owns the mutable object, so the projection can be asserted without a clock or a run. `omitted` is
 * carried IN because a drop that happened last turn is still a dropped point this turn.
 */
export function appendTurnMemory({ series, point, omitted = 0, cap = HOST_MEMORY_TURN_CAP }) {
  if (!Array.isArray(series)) throw new Error("appendTurnMemory needs the series so far");
  const appended = [...series, point];
  if (appended.length <= cap) return Object.freeze({ turns: Object.freeze(appended), omitted });
  const dropped = appended.length - cap;
  return Object.freeze({ turns: Object.freeze(appended.slice(dropped)), omitted: omitted + dropped });
}

/**
 * What the bundle publishes. `state` is a closed pair: `measured`, or the reason it is not - because a field that is
 * absent and a field that is zero are the two readings this exists to keep apart.
 */
export function summarizeHostMemory({ samples, startRssMb, minRssMb, maxRssMb, minFreeMb, turns, omitted }) {
  const series = Array.isArray(turns) ? turns : [];
  const dropped = Number.isInteger(omitted) ? omitted : 0;
  return Object.freeze({
    state: series.length === 0 ? "not_measured:no_turn_samples" : "measured",
    samples: Number.isInteger(samples) ? samples : 0,
    startRssMb: isFiniteNumber(startRssMb) ? startRssMb : null,
    minRssMb: isFiniteNumber(minRssMb) ? minRssMb : null,
    maxRssMb: isFiniteNumber(maxRssMb) ? maxRssMb : null,
    minFreeMb: isFiniteNumber(minFreeMb) ? minFreeMb : null,
    turns: Object.freeze([...series]),
    omitted: dropped,
  });
}
