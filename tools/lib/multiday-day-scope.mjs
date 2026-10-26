/**
 * "Has the night been crossed?" — answered for ONE day, not for the whole run.
 *
 * The predicate this replaces asked two questions, and neither of them knew what a day was:
 *
 *   if (actionTrace.some((e) => e.action === "advance_day" && e.settledAtMs !== null)) return true;
 *   return !clock.unknown && clock.timeOfDay !== null && clock.timeOfDay <= 620;
 *
 * `actionTrace` is one array for the entire run, so after day 1 dispatched `advance_day` the first
 * clause answered `true` for every later day, and the day loop (`while (!nightCrossed())`) never ran
 * a turn again — day 2 produced no farm work, and the baseline gate named it
 * `next_day_produced_no_farm_work`. The second clause compared against an absolute morning hour, and
 * the multi-day fixture resets `Game1.timeOfDay = 600` every morning
 * (`ModEntry.Fixtures.MultiDay.cs:184`), so a brand-new day satisfied "the night has been crossed"
 * before the companion had done anything.
 *
 * Both bugs came from the same mistake: a fact about the RUN used as a fact about the DAY. So the
 * scope is now an explicit value captured when the day starts, and every clause is relative to it.
 *
 * A night counts as crossed inside a scope when any of these is observed:
 *
 *   1. an `advance_day` dispatch appeared in this day's own trace slice and settled;
 *   2. the calendar moved (`dayOfMonth` differs from the day's starting day);
 *   3. the clock moved BACKWARDS relative to the day's start (`2600` -> `600` is a rollover).
 *
 * Never: "it is past some hour". Reaching 22:00 is not crossing the night — measured 2026-10-26, a
 * turn ended at 22:00 with the companion saying "Time to sleep ... Let me observe first then
 * advance_day" and the loop stopped one round short of the dispatch it had announced.
 */

/** The `timeOfDay`-shaped hours the engine uses: `600` is 06:00, `2600` is 26:00. */
function clockOrder(timeOfDay) {
  if (!Number.isInteger(timeOfDay) || timeOfDay <= 0) return null;
  return Math.floor(timeOfDay / 100) * 60 + (timeOfDay % 100);
}

/**
 * Capture what "the start of this day" means, so later answers are relative rather than absolute.
 *
 * `dayOfMonth` and `timeOfDay` may be null when the projection has not arrived yet — a fact that
 * cannot be read is recorded as absent instead of being defaulted into a value that would answer
 * for the world. `traceIndex` is always known: it is the length of the run's trace now.
 */
export function createDayScope({ dayOfMonth = null, timeOfDay = null, traceIndex = 0 } = {}) {
  return Object.freeze({
    dayOfMonth: Number.isInteger(dayOfMonth) ? dayOfMonth : null,
    timeOfDay: Number.isInteger(timeOfDay) && timeOfDay > 0 ? timeOfDay : null,
    traceIndex: Number.isInteger(traceIndex) && traceIndex >= 0 ? traceIndex : 0,
  });
}

/**
 * Has the night been crossed since `scope` began?
 *
 * @param scope   the value returned by {@link createDayScope} when this day started
 * @param trace   the run's whole action trace (this function slices it by `scope.traceIndex`)
 * @param clock   `{ timeOfDay, unknown }` as the runner's `readWorldClock()` reports it
 * @param dayOfMonth the calendar day the world reports now, or null when unreadable
 */
export function nightCrossedInScope({ scope, trace = [], clock = null, dayOfMonth = null } = {}) {
  const start = scope ?? createDayScope();
  const slice = Array.isArray(trace) ? trace.slice(start.traceIndex) : [];

  // 1. This day's OWN night dispatch. Not a dispatch from an earlier day: that is the bug.
  if (slice.some((entry) => entry?.action === "advance_day" && entry?.settledAtMs !== null)) return true;

  // 2. The calendar moved past the day this scope began on.
  if (start.dayOfMonth !== null && Number.isInteger(dayOfMonth) && dayOfMonth !== start.dayOfMonth) return true;

  // 3. The clock went backwards — a rollover put the world back to morning. An unreadable clock is
  //    not a rollover, and neither is a clock that has not moved.
  const now = clock === null || clock?.unknown === true ? null : clockOrder(clock?.timeOfDay);
  const began = clockOrder(start.timeOfDay);
  if (now !== null && began !== null && now < began) return true;

  return false;
}

/**
 * The day-start facts a caller captures from one observation, in the shape `createDayScope` takes.
 *
 * Kept here so the runner cannot invent a second reading of "the world clock": it passes exactly
 * what `readWorldClock()` and the snapshot already say.
 */
export function dayScopeFrom({ clock = null, dayOfMonth = null, traceIndex = 0 } = {}) {
  return createDayScope({
    dayOfMonth,
    timeOfDay: clock === null || clock?.unknown === true ? null : clock?.timeOfDay,
    traceIndex,
  });
}
