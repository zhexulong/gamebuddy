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
 *
 * <h2>What this gate could and could not SEE</h2>
 * <p>
 * Measured 2026-11-09 (`round41`): six `day_started` facts for three nights, the openings in pairs 8.9 s / 12.7 s / 6.5 s
 * apart, and this gate reported `violations: []`. Its population was NOT empty - it examined all six - but the three
 * mornings that produced no clock fact lasted less than a single game turn, and the old "a day that ended has proved the
 * clock moved" exemption waved every one of them through. A clean violation list that a reader takes to mean "the
 * mornings were fine" was really saying "nobody looked", which is the vacuum this gate exists to refuse.
 * </p>
 * <p>
 * Two rules replace it, and neither invents a threshold in seconds:
 * </p>
 * <ul>
 *   <li><b>Zero population is `not_measured`.</b> No `day_started` fact means the gate could not look, never that the
 *       mornings passed.</li>
 *   <li><b>A window is observable only if a turn could have run inside it</b>, derived from the run's own turn durations
 *       (`turnDurationsMs`, the median). Shorter than that - or unknown, when the caller supplies no durations - the
 *       morning is reported as `not_measured`, because "the clock was fine" and "we never had a chance to look" are
 *       different answers and only one of them is a pass.</li>
 * </ul>
 *
 * <h2>A morning that was never a morning</h2>
 * <p>
 * Measured 2026-11-20 (`round82`): four `day_started` facts for what the run had been asked to cross twice, and two of
 * the days were opened 4.5 s apart - a second `sleep` accepted on a day that had just begun. This gate still answered
 * `state: measured, violations: []`, because each of the four days had a witness and a witness was the only question it
 * asked. Day 6 is the one that says so: it was opened at `…957027`, closed by day 7 at `…961527` (4,500 ms), and its
 * only witness was the `0600` milestone of its own day, emitted 9,085 ms BEFORE the day was announced. Both halves are
 * findings now, and neither is a pass - see `a_morning_that_ended_before_it_started` and
 * `a_morning_shorter_than_a_turn` below. `round41` had the same shape three times over (pairs of openings 8.9 s /
 * 12.7 s / 6.5 s apart) and the ordering rule names two of those mornings, which is the reading that run never got.
 * </p>
 */

import { dayStartedDayOf } from "./multiday-baseline.mjs";

/**
 * How far BEFORE `day_started` a `time_milestone` may still witness that morning.
 *
 * This is ATTRIBUTION, not observability: the Mod emits the 06:00 clock fact while the night's settlement menu is still
 * closing, so the milestone arrives BEFORE the day it belongs to is announced (measured 2026-11-03, `round26`: 42 s
 * earlier). It says which morning a fact answers for; how long that morning lasted is the separate question the
 * observability rule answers.
 */
export const MORNING_CLOCK_GRACE_MS = 120_000;

/**
 * A morning whose witness stands outside it: the clock it answers with had finished ringing before the day began.
 *
 * <p>
 * NOT AN ORDERING TEST IN SECONDS, and deliberately not "a witness may never precede its day". It may: the Mod emits
 * `time_milestone` on `Game1.TimeChanged`, while `day_started` is SMAPI's `DayStarted`, which arrives after the save -
 * measured 4.5 s late on `round82` day 5, 42 s on `round26`, 96 s on `round41`. What is impossible is a witness that
 * stands FURTHER OUTSIDE the morning than the morning is long: then the clock it reports had already finished ringing
 * before this morning existed, and "the clock moved" is an answer about some other day. Both numbers are the record's
 * own, so the rule carries no threshold anyone can tune - lengthening it is not available, because it is not a constant.
 * </p>
 */
export const A_MORNING_THAT_ENDED_BEFORE_IT_STARTED = "a_morning_that_ended_before_it_started";

/**
 * A morning that ended in less time than one of the run's own turns took.
 *
 * <p>
 * The reference is `turnDurationsMs`'s median - "the time it takes to ask for something" - and never a constant: the
 * measured morning is 4,500 ms, which is not near any boundary a threshold could be argued about. When the caller
 * supplies no cadence the rule cannot answer and says `too-short not_measured` instead of passing.
 * </p>
 */
export const A_MORNING_SHORTER_THAN_A_TURN = "a_morning_shorter_than_a_turn";

/** The identity the Mod mints for a clock fact: `time_milestone_day_<TotalDays>_<HHmm>` (`Sensory/ISalientEventFilter.cs`). */
const MILESTONE_EVENT_ID = /^time_milestone_day_\d+_(\d{4})$/u;

const kindOf = (fact) => fact?.worldFactKind ?? fact?.worldFactPayload?.kind ?? fact?.kind ?? "";

function payloadOf(fact) {
  const raw = fact?.worldFactPayload?.payloadJson;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The clock the fact reports - `0600`, `1200` - read from the identity the Mod mints, with its published payload as the
 * second reading. The day number is read from the same identities by `dayStartedDayOf`; a label this module invented
 * from a field the Mod does not publish is how `days[].day` came back `null` on every entry of `round41`.
 */
function milestoneOf(fact) {
  if (kindOf(fact) !== "time_milestone") return null;
  const eventId = fact?.eventId ?? fact?.worldFactPayload?.eventId ?? "";
  const match = MILESTONE_EVENT_ID.exec(typeof eventId === "string" ? eventId : "");
  if (match !== null) return match[1];
  const milestone = payloadOf(fact)?.milestone;
  return typeof milestone === "string" ? milestone : null;
}

function median(values) {
  const sorted = (Array.isArray(values) ? values : [])
    .filter((value) => Number.isFinite(value))
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Assess whether each day a run opened became playable.
 *
 * @param {object} input
 * @param {readonly object[]} input.facts  the run's fact log (`timeline.jsonl` rows), in order
 * @param {number} input.endedAtMs         when the run stopped, for the last day's window
 * @param {readonly number[]|null} [input.turnDurationsMs]  the run's own measured turn durations; their median is the
 *        shortest morning a turn could have observed, and the length a whole morning has to beat
 * @returns {{state: string, examined: number, medianTurnMs: number|null, violations: readonly string[],
 *            notMeasured: readonly string[], days: readonly object[], morningDays: object}}
 */
export function assessMorningLiveness({ facts, endedAtMs, turnDurationsMs = null } = {}) {
  const starts = [];
  const milestones = [];
  const notMeasured = [];
  for (const fact of facts ?? []) {
    const atMs = typeof fact?.atMs === "number" ? fact.atMs : null;
    const day = dayStartedDayOf(fact);
    if (day !== null) {
      if (atMs === null) notMeasured.push(`day_started_fact_without_a_timestamp;day=${day}`);
      else starts.push({ atMs, day });
      continue;
    }
    if (kindOf(fact) === "day_started") {
      // A `day_started` this module cannot read a day from is NOT silently dropped: the population would shrink and the
      // gate would pass on what it failed to parse.
      notMeasured.push("day_started_fact_without_a_day");
      continue;
    }
    const milestone = milestoneOf(fact);
    if (milestone !== null && atMs !== null) milestones.push({ atMs, label: milestone });
  }
  const medianTurnMs = median(turnDurationsMs);
  const runEndedAtMs = Number.isFinite(endedAtMs) ? endedAtMs : null;
  if (starts.length === 0) notMeasured.push("no_day_started_facts");

  const days = [];
  const violations = [];
  // THE POPULATION OF THE TWO RULES BELOW IS A MORNING THAT REALLY ENDED, printed as `days D · ordered O · too-short S`.
  // A day the run stopped inside has an end too - the run's - and its span is only a LOWER BOUND, so a witness standing
  // 5 s outside a morning the run abandoned 1 s into it says nothing about the morning. `endedBy` is published per day so
  // the two are never confused, and `D-O>0` and `S>0` are each exactly the number of violations pushed for them.
  let orderedMornings = 0;
  let tooShortMornings = 0;
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const nextStart = starts[index + 1]?.atMs ?? Number.POSITIVE_INFINITY;
    const reading = measureMorning({ start, nextStart, runEndedAtMs, milestones, medianTurnMs });
    days.push(Object.freeze(reading.day));

    // A MORNING SHORTER THAN A TURN IS NOT A MORNING, and it is stated before any witness is weighed: 4,500 ms is not a
    // threshold to argue about, it is a day the world crossed again before one turn could be run inside it.
    const tooShort = reading.day.endedBy === "next_day" && medianTurnMs !== null && reading.day.spanMs < medianTurnMs;
    if (tooShort) {
      tooShortMornings += 1;
      violations.push(`${A_MORNING_SHORTER_THAN_A_TURN}:${start.day}:${reading.day.spanMs}`);
    }
    if (reading.day.endedBy === "next_day" && !reading.witnessOutsideTheMorning) orderedMornings += 1;
    // A WITNESS THAT PRECEDES ITS OWN START IS NOT A WITNESS, and the day is named rather than passed.
    if (reading.witnessOutsideTheMorning) {
      violations.push(`${A_MORNING_THAT_ENDED_BEFORE_IT_STARTED}:${start.day}`);
      continue;
    }
    // The clock moved inside the day: the invariant is measured and it held, whatever the window.
    if (reading.witness !== null) continue;
    // A day that ENDED has proved the clock moved - measured, when a turn could have been inside the window to see it
    // stay still. Measured 2026-11-03 (`round26`): the companion finished by noon and put herself to bed, so the day
    // closed without ever reaching 12:00 and a gate that demanded a milestone called 263 finished seconds "frozen".
    if (reading.dayEnded && reading.day.turnCouldRun === true) continue;
    if (reading.day.turnCouldRun === null) {
      notMeasured.push(`turn_cadence_unknown;day=${start.day};window_ms=${reading.day.observedForMs}`);
      continue;
    }
    if (reading.day.turnCouldRun === false) {
      // The same fact the rule above already stated as a finding: a morning that ended inside one turn is too short, and
      // it does not get a second spelling as "nobody could have looked".
      if (tooShort) continue;
      notMeasured.push(
        `day_window_too_short_to_observe;day=${start.day};window_ms=${reading.day.observedForMs};median_turn_ms=${medianTurnMs}`,
      );
      continue;
    }
    // An OPEN morning nobody could see the clock in is the defect this gate exists for.
    violations.push(`morning_clock_frozen:day=${start.day}`);
  }

  const examinedMornings = days.filter((entry) => entry.endedBy === "next_day").length;
  const morningDays = Object.freeze({
    examined: examinedMornings,
    ordered: orderedMornings,
    // `null` is NOT MEASURED: without the run's own turn cadence no morning can be called too short, and a `0` there
    // would be the empty population agreeing with itself.
    tooShort: medianTurnMs === null ? null : tooShortMornings,
  });
  return Object.freeze({
    state: notMeasured.length === 0 ? "measured" : "not_measured",
    examined: starts.length,
    medianTurnMs,
    violations: Object.freeze(violations),
    notMeasured: Object.freeze(notMeasured),
    days: Object.freeze(days),
    morningDays,
    morningDaysLine: morningDaysLine(morningDays),
  });
}

/**
 * ONE MORNING, MEASURED: its witness, how long it lived, and whether that witness can answer for it.
 *
 * <p>
 * Every number here is read once from the run's own facts and published on `day`, so the rules below and a reader of
 * `result.json` are looking at the same arithmetic.
 * </p>
 */
function measureMorning({ start, nextStart, runEndedAtMs, milestones, medianTurnMs }) {
  // The first milestone inside this day's own span. A later day's milestone does not witness this one: if the clock
  // only moved after the NEXT rollover, this morning was frozen for exactly as long as the rollover was pending.
  const witness =
    milestones.find((entry) => entry.atMs > start.atMs && entry.atMs < nextStart) ??
    milestones.find((entry) => entry.atMs <= start.atMs && start.atMs - entry.atMs <= MORNING_CLOCK_GRACE_MS) ??
    null;
  const dayEnded = nextStart !== Number.POSITIVE_INFINITY;
  const observedUntil = Math.min(nextStart, runEndedAtMs ?? Number.POSITIVE_INFINITY);
  const observedForMs = Math.max(0, observedUntil - start.atMs);
  // THE MORNING'S OWN LENGTH, which is not the observed window: a day the next morning closed is as long as the gap
  // between the two, whatever the run was still watching afterwards.
  let endedBy = null;
  if (dayEnded) endedBy = "next_day";
  else if (runEndedAtMs !== null) endedBy = "run_end";
  const morningEndedAtMs = dayEnded ? nextStart : runEndedAtMs;
  const spanMs = morningEndedAtMs === null ? observedForMs : Math.max(0, morningEndedAtMs - start.atMs);
  // OBSERVABILITY, not a threshold in seconds: could a turn have run inside this morning at all?
  const turnCouldRun = medianTurnMs === null ? null : observedForMs >= medianTurnMs;
  // A WITNESS THAT STANDS OUTSIDE THE MORNING. Both numbers are the record's own: how far before its start the witness
  // was published, and how long the morning then lived. `>=` because a witness exactly as far out as the morning was
  // long answers for a clock that had already finished before this day began.
  const witnessPrecedesByMs = witness === null ? null : start.atMs - witness.atMs;
  const witnessOutsideTheMorning =
    endedBy === "next_day" && witnessPrecedesByMs !== null && witnessPrecedesByMs >= spanMs;
  return {
    witness,
    dayEnded,
    witnessOutsideTheMorning,
    day: {
      day: start.day,
      startedAtMs: start.atMs,
      witnessedAtMs: witness?.atMs ?? null,
      milestone: witness?.label ?? null,
      // How far before this morning's start its witness was published, or `null` when it has none.
      witnessPrecedesByMs,
      observedForMs,
      spanMs,
      endedBy,
      turnCouldRun,
    },
  };
}

/**
 * The one line the two morning rules are read off: `days D · ordered O · too-short S`.
 *
 * <p>
 * Both counts are FAILURES and each is exactly the number of violations pushed for it: `D-O>0` names the mornings whose
 * witness stood outside them, `S>0` the mornings shorter than one turn. `S` prints `not_measured` when the caller
 * supplied no turn cadence, because `0` there would say "no morning was too short" about a question nobody answered.
 * </p>
 */
export function morningDaysLine(morningDays) {
  const count = (value) => (value === null || value === undefined ? "not_measured" : String(value));
  return `days ${count(morningDays?.examined)} · ordered ${count(morningDays?.ordered)} · too-short ${count(morningDays?.tooShort)}`;
}
