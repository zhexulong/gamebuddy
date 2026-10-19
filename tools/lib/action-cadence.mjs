/**
 * Where a run's wall-clock actually goes, per action.
 *
 * WHY THIS EXISTS: a review of the multi-day runs asked why the companion "feels laggy", and the honest answer had
 * to be "we do not know" - the data could only offer one number. That number was ALSO wrong in a way nobody could
 * see: the trace stamped `dispatchedAtMs` when the RECEIPT came back, so "the gap between two actions" silently
 * contained the next action's execution and the field name said otherwise. Three questions need three numbers:
 *
 *   execMs   dispatch -> its own terminal receipt   (the game doing the work)
 *   thinkMs  terminal -> the next dispatch          (the agent deciding, the harness waiting)
 *   idleMs   dispatch -> the next dispatch          (what the old single number measured)
 *
 * Pure, so the arithmetic is testable without a game: entries whose terminal timestamp is missing are COUNTED and
 * EXCLUDED rather than treated as zero, because a zero would look like an impossibly good cadence.
 */

/** Median of a numeric list; `null` for an empty list (an unknown median is not zero). */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * The cadence of one run's action trace.
 *
 * `entries` is the runner's own trace: each entry carries `action`, `dispatchedAtMs` (when the dispatch was sent)
 * and, once the fix that made this module possible is in place, `settledAtMs` (when its terminal arrived).
 */
export function summarizeActionCadence(entries) {
  if (!Array.isArray(entries)) {
    return Object.freeze({ actions: 0, measured: 0, unmeasured: 0, execMs: null, thinkMs: null, idleMs: null });
  }
  const ordered = entries
    .filter((entry) => typeof entry?.dispatchedAtMs === "number")
    .sort((left, right) => left.dispatchedAtMs - right.dispatchedAtMs);
  const exec = [];
  const think = [];
  const idle = [];
  let unmeasured = 0;
  for (const [index, entry] of ordered.entries()) {
    const settled = typeof entry.settledAtMs === "number" ? entry.settledAtMs : null;
    if (settled === null || settled < entry.dispatchedAtMs) {
      unmeasured += 1;
    } else {
      exec.push(settled - entry.dispatchedAtMs);
    }
    const next = ordered[index + 1];
    if (next === undefined) continue;
    idle.push(next.dispatchedAtMs - entry.dispatchedAtMs);
    // Only measurable when THIS action's terminal is known: otherwise the "thinking" span would swallow the
    // previous action's execution and the number would mean nothing.
    if (settled !== null && next.dispatchedAtMs >= settled) think.push(next.dispatchedAtMs - settled);
  }
  // `sum` alongside `median`/`max` because the pre-registered question ("how much of the run was the model thinking?")
  // is a SUM over the run divided by the wall clock, and a median cannot be turned into that sum without inventing
  // the distribution. Published here so the metric is computable from any run's own artifacts, with no trace file to
  // find and no estimator to argue about.
  const span = (values) =>
    Object.freeze({
      median: median(values),
      max: values.length === 0 ? null : Math.max(...values),
      sum: values.reduce((total, value) => total + value, 0),
    });
  return Object.freeze({
    actions: ordered.length,
    measured: exec.length,
    unmeasured,
    execMs: span(exec),
    thinkMs: span(think),
    idleMs: span(idle),
  });
}
