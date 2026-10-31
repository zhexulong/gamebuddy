/**
 * A morning must become playable.
 *
 * <p>
 * Four separate commits have tried to fix the same deadlock - `1b70f08e`, `541775c2`, `4357a95b`, `76c51da4` - each
 * addressing a different way the settlement sheet could be left standing after a rollover. On 2026-10-31 it happened
 * again: the day advanced (clock 600, day 6), `menu=ShippingMenu`, and the clock did not move for the rest of the run.
 * </p>
 * <p>
 * The reason four patches did not settle it is that every one of them asserted something about a PATH - which owner may
 * commit, which phase, which tick. The invariant they were all approximating is about the OUTCOME, and it can be
 * asserted directly: <b>after the engine opens a day, the clock must move.</b> A frozen clock is the defect regardless of
 * who failed to prevent it, and it is observable from the facts a run already publishes.
 * </p>
 * <p>
 * The instrument is `time_milestone`, which the Mod emits on `Game1.TimeChanged` at 06:00/12:00/18:00/22:00. A clock held
 * by `shouldTimePass()` returning false - the mechanism behind every one of those four deadlocks - emits none of them.
 * So a `day_started` followed by no milestone while the run continues IS the deadlock, named without guessing at its
 * cause.
 * </p>
 */

/** How long a run may continue after a day starts before its silence about the clock becomes a failure. */
export const MORNING_CLOCK_GRACE_MS = 120_000;

/**
 * Assess whether each day a run opened became playable.
 *
 * @param {object} input
 * @param {readonly object[]} input.facts  the run's fact log (`timeline.jsonl` rows), in order
 * @param {number} input.endedAtMs         when the run stopped, for the last day's grace window
 * @returns {{violations: readonly string[], days: readonly object[]}}
 */
export function assessMorningLiveness({ facts, endedAtMs }) {
  const starts = [];
  const milestones = [];
  for (const fact of facts ?? []) {
    const kind = fact?.worldFactPayload?.kind ?? fact?.worldFactKind ?? fact?.kind ?? "";
    const atMs = typeof fact?.atMs === "number" ? fact.atMs : null;
    if (atMs === null) continue;
    if (kind === "day_started") starts.push({ atMs, label: fact?.worldFactPayload?.day ?? fact?.revision ?? null });
    else if (kind === "time_milestone") milestones.push({ atMs, label: fact?.worldFactPayload?.formattedTime ?? null });
  }

  const days = [];
  const violations = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const nextStart = starts[index + 1]?.atMs ?? Number.POSITIVE_INFINITY;
    // The first milestone inside this day's own span. A later day's milestone does not witness this one: if the clock
    // only moved after the NEXT rollover, this morning was frozen for exactly as long as the rollover was pending.
    const witness = milestones.find((entry) => entry.atMs > start.atMs && entry.atMs < nextStart) ?? null;
    const observedUntil = Math.min(nextStart, endedAtMs ?? Number.POSITIVE_INFINITY);
    const ranLongEnough = observedUntil - start.atMs >= MORNING_CLOCK_GRACE_MS;

    days.push(
      Object.freeze({
        day: start.label,
        startedAtMs: start.atMs,
        witnessedAtMs: witness?.atMs ?? null,
        milestone: witness?.label ?? null,
        observedForMs: Math.max(0, observedUntil - start.atMs),
      }),
    );

    // A day the run barely entered is not evidence of a frozen clock - there was no time to see one. This is the one
    // exemption, and it is about OBSERVATION, not about excusing the product: a run that ends 20 s into a morning has
    // not tested that morning either way.
    if (witness === null && ranLongEnough) violations.push(`morning_clock_frozen:day=${start.label ?? index}`);
  }

  return Object.freeze({
    violations: Object.freeze(violations),
    days: Object.freeze(days),
    observed: starts.length > 0,
  });
}
