/**
 * The single-player multi-day baseline: what a run must show before a co-op multi-day run can be
 * attributed at all.
 *
 * Crossing days inside one run exercises a batch of single-game engine changes - cross-day
 * re-anchoring, the day-end settlement menu, level-up menus, mail, stamina reset - and the co-op
 * topology adds a second machine's sleep handshake on top of them. When a co-op multi-day run stalls
 * there is no way to tell those apart unless the single-player half is already known to work, which
 * is the whole reason this baseline exists (design 1432: the ladder is a staged instrument, and an
 * outage must be attributable).
 *
 * The rules are read off RECEIPTS and OBSERVATIONS, never off the runner's prose:
 *   - every night's own `advance_day` terminal, and the Mod's own `saving_observed` /
 *     `saved_observed` / `day_started_observed` facts, cross-checked against the world the runner
 *     observed afterwards (a receipt claiming `day_advanced` while the calendar disagrees is a
 *     blocked result, never a pass);
 *   - the first night's `ShippingMenu` must be CLOSED by the product, with its own receipt: the
 *     menu is what holds the actor when a night ends, so a run that never closed it did not cross
 *     the day, whatever else it reports;
 *   - the day after a night must still produce the companion's own farm work, which is what makes
 *     this a loop rather than one rollover;
 *   - a night the ENGINE ended by passing the actor out is INSIDE that scope and is recorded by its cause.
 *     The 2:00 AM pass-out is normal play: `Game1.PassOutNewDay()` calls `NewDay(0f)` itself and the player
 *     wakes in bed on the next day, so the calendar crosses exactly as it does after a sleep. It is reported
 *     (`passOutNights`) rather than judged, because it is how the day ended and not whether it did.
 *   - a night the COMPANION ended by going to her own bed is the same: recorded by its cause, judged on whether the
 *     night crossed. Her `sleep` receipt can end without carrying the crossing (`NIGHT_CAUSE_SLEEP_UNSETTLED`) while
 *     the calendar crosses it, and the receipt she did mint travels on the record so that verdict is checkable.
 */

/** The season index the world reported after this night, whichever of the two shapes carried it. */
function seasonIndexFor(after) {
  if (typeof after?.seasonIndex === "number") return after.seasonIndex;
  return typeof after?.season === "string" ? SEASON_NAMES.indexOf(after.season) : SEASON_NAMES.length;
}

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** The engine's own season order, and the days each season holds a festival on. */
const SEASON_NAMES = Object.freeze(["spring", "summer", "fall", "winter"]);
const DAYS_PER_SEASON = 28;

/** The bounded window this corpus is willing to call a baseline. */
export const MINIMUM_BASELINE_DAYS = 2;
export const MAXIMUM_BASELINE_DAYS = 3;

/**
 * What this baseline does NOT cover, published with its verdict instead of living only in the fixture's source.
 *
 * The reviewer's point stands: a verdict whose scope is unstated reads as wider than it is. A real 3-7 day
 * companion will meet a festival (spring 13), a season boundary (spring 28 -> summer 1) and a profession
 * milestone; those days take different code paths in the game's own day pipeline, so a pass here must not be read
 * as covering them. The rules below make that a BLOCKED result if a run ever widens into one, rather than a silent
 * pass, and the gate's own output carries this list.
 */
export const BASELINE_SCOPE_NOTES = Object.freeze([
  "consecutive days inside ONE season: a rollover that crosses the season boundary (day 28 -> day 1) is out of scope",
  "no festival days: a night landing on a festival day is out of scope",
  "single-player topology: a shared-world ready barrier is not exercised here",
  "no profession milestones: levels 5 and 10 are a choice, and the fixture pins the five skills so none can arise",
]);

/** The days the engine runs a world-state change on, in the season order this module already knows. */
/**
 * The days each season runs a world-state change on.
 *
 * A night that lands on one of these takes a different path in the game's own day pipeline, which is why the
 * baseline names it out of scope rather than passing it (see `BASELINE_SCOPE_NOTES`).
 */
const FESTIVAL_DAYS_BY_SEASON = Object.freeze({
  spring: Object.freeze([13, 24]),
  summer: Object.freeze([11, 28]),
  fall: Object.freeze([16, 27]),
  winter: Object.freeze([8, 25]),
});

/** Menus the product's own `dismiss_modal` closes as a pure cancel (`ShippingMenu` is the one a rollover raises). */
export const DISMISSIBLE_ROLLOVER_MENUS = Object.freeze(["ShippingMenu"]);

/**
 * The one rollover menu with NO pure-cancel path: an active `LevelUpMenu` grants its perk when it closes
 * (`LevelUpMenu.cs:629-635`), so it is settled by `respond_level_up`, never by `dismiss_modal`.
 */
export const LEVEL_UP_MENU = "LevelUpMenu";

/** Menus a rollover can legitimately raise and that must be waited for, not closed. */
export const WAIT_ROLLOVER_MENUS = Object.freeze(["SaveGameMenu", "DialogueBox", "ReadyCheckDialog"]);

const violation = (code, where) => Object.freeze({ code, where });

/** The Mod's own `key=value;...` evidence projection, read by key (the shape every action receipt uses). */
export function parseReceiptEvidence(evidence) {
  const detail = typeof evidence === "string" ? evidence : typeof evidence?.detail === "string" ? evidence.detail : "";
  const facts = {};
  for (const pair of detail.split(";")) {
    const index = pair.indexOf("=");
    if (index > 0) facts[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return facts;
}

/**
 * The calendar day a total-days count lands on. `advance_day` reports `days_after` (the engine's own
 * `Game1.stats.DaysPlayed`) and `day_after` (`Game1.Date.TotalDays`); the world's `dayOfMonth` must be
 * the day those totals imply, which is why this is computed rather than read back from the receipt.
 */
export function dayOfMonthForTotalDays(totalDays) {
  if (!isFiniteNumber(totalDays) || totalDays < 0) return null;
  return (Math.trunc(totalDays) % DAYS_PER_SEASON) + 1;
}

/** The ENGINE took the night: `Game1.PassOutNewDay()` calls `NewDay(0f)` itself. */
export const NIGHT_CAUSE_PASS_OUT = "pass_out";

/** Her own `sleep` crossed the night, and that is the receipt's own claim: `succeeded/day_advanced`. */
export const NIGHT_CAUSE_SLEEP = "sleep";

/**
 * Her own `sleep` started the night and the CALENDAR carried the crossing.
 *
 * The distinction from `sleep` is not a weaker version of it - it is which witness reported the crossing. Her
 * lifecycle receipt ends without `day_advanced` (it can be `blocked/lifecycle_deadline_exceeded` while the day it was
 * waiting for has already begun), so the calendar is the night's crossing witness, and the receipt is the report of
 * HOW the night started. Measured 2026-11-05 (`2026-11-05T15-02-34-974Z-multiday_routine`, night 1): accepted
 * `target=own_bed` at 23:14:37, `WalkingToBed` -> `answered the native Sleep prompt`, day 5 -> 6 at 23:15:49 while
 * the lifecycle still waited for a `day_started` it never observed, terminal `blocked/lifecycle_deadline_exceeded`
 * with `entered_via=native_sleep_prompt`. The record said `engine` - "the day moved and nobody saw how" - for the one
 * night of that run that ended exactly as intended, and the baseline called it `night_mechanism_unobserved`.
 */
export const NIGHT_CAUSE_SLEEP_UNSETTLED = "sleep_unsettled";

/** The night was taken and no receipt says how: the crossing is a fact and its attribution is not. */
export const NIGHT_CAUSE_ENGINE = "engine";

/**
 * HOW a night ended, from the witnesses that can actually answer it. A night that crossed always gets an answer.
 *
 * The attributions are not interchangeable, and only one of them can be faked:
 *   - `pass_out` means the ENGINE took the night, and `Game1.PassOutNewDay()` calls `NewDay(0f)` itself. Two things
 *     witness it - the Mod's `entered_via=native_pass_out` on a receipt, or the runner's own watch seeing the actor
 *     held - and either alone is enough.
 *   - `sleep` means the COMPANION's own `advance_day` crossed it, and ONLY the lifecycle receipt's
 *     `entered_via=native_sleep_prompt` shows that. There is no observation that substitutes: `advance_day` is the
 *     only thing that starts a lifecycle, so no receipt means no sleep.
 *   - `sleep_unsettled` means that same lifecycle receipt exists and did NOT carry the crossing, which the calendar
 *     did. `sleepEnteredVia` is read from the record's own published `sleepReceipt`, so "she ended the day herself"
 *     is checkable from the artifact rather than asserted by a word.
 *   - `engine` is what is left when the night WAS taken and nobody saw how.
 *
 * Measured 2026-10-30: the record's cause was `passOutObserved ? "pass_out" : "sleep"`, and both of that run's nights
 * were the engine's 2:00 pass-out while the record said `sleep`. The false branch of that ternary reads as "the
 * companion slept" but means only "no pass-out was observed" - a fact about the watch, not about the night, and on
 * that run neither value had been observed at all. Zero `advance_day` dispatches existed to be the sleep.
 *
 * `engine` is NOT `null`. Null would say nothing is known about the night, which is false - the calendar moved, the
 * save ran, the day started. `engine` says the crossing is a fact and its attribution is not, which is what a reader
 * needs in order to distrust the attribution rather than the crossing. A night with no witness to the CROSSING never
 * reaches this function: `classifyNight` has already refused it as `night_terminal_missing`.
 *
 * PRECEDENCE, and why the new witness is last: a receipt that CLAIMS the crossing outranks everything, and a
 * pass-out the Mod published outranks a sleep receipt that did not - if the clock reached 26:00 the engine's pass-out
 * is how the day actually ended, whatever her lifecycle had been waiting for. `entered_via` is the crossing
 * receipt's, `sleepEnteredVia` is the night's own sleep receipt's.
 *
 * `recorded` is the word the record already carried, and it is trusted ONLY for the three answers that existed before
 * `sleep_unsettled`: that claim needs a receipt, so it is never read back off the record - a record naming it without
 * one re-derives as `engine` and is judged `night_mechanism_unobserved`, which is the rule's force.
 */
export function nightCause({
  enteredVia = null,
  sleepEnteredVia = null,
  passOutObserved = false,
  recorded = null,
} = {}) {
  if (enteredVia === "native_pass_out") return NIGHT_CAUSE_PASS_OUT;
  if (enteredVia === "native_sleep_prompt") return NIGHT_CAUSE_SLEEP;
  if (passOutObserved === true) return NIGHT_CAUSE_PASS_OUT;
  if (sleepEnteredVia === "native_sleep_prompt") return NIGHT_CAUSE_SLEEP_UNSETTLED;
  if (recorded === NIGHT_CAUSE_SLEEP || recorded === NIGHT_CAUSE_PASS_OUT || recorded === NIGHT_CAUSE_ENGINE)
    return recorded;
  return NIGHT_CAUSE_ENGINE;
}

/**
 * THE LIFECYCLE'S OWN OUTCOME, NAMED WHEN THE WORLD SAYS THE NIGHT CROSSED ANYWAY.
 *
 * `<reading>:<lifecycle reason>:<world word>`. Measured 2026-11-05 (`2026-11-05T15-02-34-974Z-multiday_routine`, night 1):
 * her `sleep` was accepted at 23:14:37, the lifecycle walked her to bed and answered the native Sleep prompt, the day
 * crossed 5 -> 6 at 23:15:49, and its terminal arrived `state=blocked;reason=lifecycle_deadline_exceeded` -
 * `wait_frames=31988/32400` without the `day_started` edge it was waiting for - while the same evidence carried
 * `day_before=4;days_before=5;day_after=5;days_after=6`. Both halves of that receipt describe a crossed night, and its
 * outcome code describes a failed wait; only one of them can be reported as the night's own answer.
 */
export const LIFECYCLE_DISAGREES_WITH_WORLD = "lifecycle_disagrees_with_world";

/** The Mod's own word for a lifecycle that carried its night across (`succeeded/day_advanced`). */
const CROSSING_OUTCOME = Object.freeze({ state: "succeeded", reasonCode: "day_advanced" });

/** The calendar's answer to "did this night cross": the day it started on versus the day watched afterwards. */
function calendarCrossed(after) {
  const observed = after?.dayOfMonth;
  const before = after?.dayBefore;
  if (!isFiniteNumber(observed) || !isFiniteNumber(before)) return null;
  return observed !== before;
}

/**
 * The named disagreement between a lifecycle's own outcome and the world's, or `null` when there is none.
 *
 * <p>
 * `worldCrossed` is the world's answer for the SAME night, and it is asked only where the world attributed the crossing
 * to her own sleep: a lifecycle that waited for a shared-world partner, or one the engine superseded at 26:00, reports a
 * failure that is true and not a disagreement. `null` is "both agree", never "nobody could tell" - a night whose
 * crossing nobody measured reaches `classifyNight`'s other answers and never this one.
 * </p>
 */
export function lifecycleDisagreement({ lifecycle, worldCrossed } = {}) {
  if (!isPlainObject(lifecycle) || worldCrossed !== true) return null;
  if (lifecycle.state === CROSSING_OUTCOME.state && lifecycle.reasonCode === CROSSING_OUTCOME.reasonCode) return null;
  if (typeof lifecycle.state !== "string" || typeof lifecycle.reasonCode !== "string") return null;
  return `${LIFECYCLE_DISAGREES_WITH_WORLD}:${lifecycle.reasonCode}:${CROSSING_OUTCOME.reasonCode}`;
}

/**
 * Did this night cross, and what says so?
 *
 * TWO witnesses, and the receipt is not always available. `actionTrace` records only FLAT dispatches, so a night
 * the companion crossed through Body Program produces no `terminal` here at all - measured 2026-10-28 (`round5`):
 * `dismiss_modal` succeeded at 00:27:59 and SMAPI logged "after save, starting spring 6 Y1" at 00:28:04, while every
 * one of that run's 42 dispatches went through a program and the trace was empty.
 *
 * The world's own calendar is the witness that cannot be hidden by a dispatch path: the runner records the day the
 * watch began on and the day observed afterwards, and a different `dayOfMonth` IS the crossing. The receipt, when it
 * exists, is the STRONGER witness - it carries the engine's own totals - so it is still preferred and still
 * cross-checked. Absent a receipt, the calendar alone is enough, and `witness` says which one answered.
 *
 * ANY WORLD-OBSERVED CROSSING SETTLES THE LIFECYCLE. A receipt whose outcome is a failure is a statement about its own
 * WAIT, and the deadline it names only means something while the night's outcome is unobserved. The measured night above
 * is the shape: `blocked/lifecycle_deadline_exceeded` beside a calendar that moved 5 -> 6. Answering
 * `night_not_advanced` there declares the night uncrossed on the word of the one witness that had already lost the
 * event, so the crossing is kept - with the lifecycle's word published beside it as `lifecycleDisagreement` - and the
 * failure stays the night's answer only when the calendar agrees that nothing crossed.
 */
export function classifyNight({ terminal, after }) {
  const crossed = calendarCrossed(after);
  if (!isPlainObject(terminal)) {
    if (crossed === true) {
      return Object.freeze({
        advanced: true,
        witness: "calendar",
        reasonCode: null,
        facts: Object.freeze({ day_before: String(after.dayBefore), day_of_month: String(after.dayOfMonth) }),
      });
    }
    return Object.freeze({ advanced: false, reasonCode: "night_terminal_missing", facts: Object.freeze({}) });
  }
  if (terminal.state !== CROSSING_OUTCOME.state || terminal.reasonCode !== CROSSING_OUTCOME.reasonCode) {
    if (crossed === true) {
      return Object.freeze({
        advanced: true,
        witness: "calendar",
        reasonCode: null,
        lifecycle: Object.freeze({ state: terminal.state, reasonCode: terminal.reasonCode }),
        disagreement: lifecycleDisagreement({ lifecycle: terminal, worldCrossed: true }),
        facts: Object.freeze({ day_before: String(after.dayBefore), day_of_month: String(after.dayOfMonth) }),
      });
    }
    return Object.freeze({
      advanced: false,
      reasonCode: `night_not_advanced:${String(terminal.state)}/${String(terminal.reasonCode)}`,
      facts: Object.freeze({}),
    });
  }
  const facts = parseReceiptEvidence(terminal.evidence);
  const dayBefore = Number.parseInt(facts.day_before ?? "", 10);
  const dayAfter = Number.parseInt(facts.day_after ?? "", 10);
  const daysBefore = Number.parseInt(facts.days_before ?? "", 10);
  const daysAfter = Number.parseInt(facts.days_after ?? "", 10);
  if (![dayBefore, dayAfter, daysBefore, daysAfter].every(Number.isFinite)) {
    return Object.freeze({ advanced: false, reasonCode: "night_totals_missing", facts: Object.freeze(facts) });
  }
  if (dayAfter !== dayBefore + 1 || daysAfter !== daysBefore + 1) {
    return Object.freeze({
      advanced: false,
      reasonCode: `night_totals_did_not_advance:${dayBefore}->${dayAfter}:${daysBefore}->${daysAfter}`,
      facts: Object.freeze(facts),
    });
  }
  // The world's own calendar is the independent half: it must agree with the totals, not restate them.
  const observedDayOfMonth = after?.dayOfMonth;
  if (!isFiniteNumber(observedDayOfMonth)) {
    return Object.freeze({
      advanced: false,
      reasonCode: "night_world_calendar_unobserved",
      facts: Object.freeze(facts),
    });
  }
  const expectedDayOfMonth = dayOfMonthForTotalDays(dayAfter);
  if (observedDayOfMonth !== expectedDayOfMonth) {
    return Object.freeze({
      advanced: false,
      reasonCode: `night_world_calendar_mismatch:${observedDayOfMonth}:expected=${expectedDayOfMonth}`,
      facts: Object.freeze(facts),
    });
  }
  return Object.freeze({
    advanced: true,
    reasonCode: null,
    facts: Object.freeze(facts),
    expectedDayOfMonth,
    dayBefore,
    dayAfter,
  });
}

/**
 * A night that left the scope this corpus covers, or null when it stayed inside.
 *
 * The scope is named in `BASELINE_SCOPE_NOTES`; this is the half that makes it enforceable. Both cases are real
 * days a longer companion meets - the season-boundary rollover and a festival - and both take different paths in
 * the game's own day pipeline, so a pass must not be read as covering them.
 */
function nightOutsideBaselineScope(classified) {
  if (classified === null || classified === undefined) return null;
  if (!classified.advanced) return null;
  // A season rollover is the night that ends on day 1: only the 28 -> 1 wrap can produce it, so it needs no
  // day-of-month history (the receipt's own totals increase monotonically and do not wrap).
  if (classified.expectedDayOfMonth === 1) {
    return "night_crossed_a_season_boundary:expected_day=1";
  }
  const season = SEASON_NAMES[classified.seasonIndex];
  const festivals = FESTIVAL_DAYS_BY_SEASON[season];
  if (festivals !== undefined && festivals.includes(classified.expectedDayOfMonth)) {
    return `night_landed_on_a_festival_day:${String(season)}:${String(classified.expectedDayOfMonth)}`;
  }
  return null;
}

/**
 * THE DAY A `day_started` FACT NAMES, or null when it names none.
 *
 * One reading for two questions: `worldDayStartsFromFacts` counts DISTINCT days, and `morning-liveness.mjs` labels the
 * day a morning belongs to. Both parse the identity the Mod mints (`Sensory/ISalientEventFilter.cs:74`:
 * `day_started_day_<TotalDays>`), because that is the only place the day is stated - `round41`'s
 * `morningLiveness.days[]` came back `day: null` for all six entries while it read a `worldFactPayload.day` field the Mod
 * has never published.
 */
export function dayStartedDayOf(fact) {
  if (!isPlainObject(fact)) return null;
  const kind = fact.worldFactKind ?? fact.kind ?? fact.payload?.kind;
  if (kind !== "day_started") return null;
  const eventId = fact.eventId ?? fact.worldFactPayload?.eventId ?? "";
  const match = /^day_started_day_(\d+)$/u.exec(typeof eventId === "string" ? eventId : "");
  if (match === null) return null;
  const day = Number.parseInt(match[1], 10);
  return Number.isInteger(day) ? day : null;
}

/**
 * THE WORLD'S OWN DAY STARTS, read off the Mod's `day_started` world facts.
 *
 * The one thing in a run that is the world's calendar rather than the runner's loop count. The Mod mints
 * `day_started_day_<TotalDays>` (`Sensory/ISalientEventFilter.cs:74`), and the runner records the fact verbatim as
 * `{ worldFactKind: "day_started", eventId: "day_started_day_N", ... }`.
 *
 * DISTINCT days, in arrival order: a redelivered fact is the same day beginning, not a second one. A fact whose id is
 * not the minted shape is skipped rather than counted, because a day number it does not carry cannot be compared.
 */
export function worldDayStartsFromFacts(facts) {
  const days = [];
  for (const fact of Array.isArray(facts) ? facts : []) {
    const day = dayStartedDayOf(fact);
    if (day === null) continue;
    if (!days.includes(day)) days.push(day);
  }
  return days;
}

/**
 * THE WORLD'S OWN NIGHT ENDINGS, read off the Mod's `night_ended_*` world facts.
 *
 * The Mod mints the fact that says HOW a night ended, because nothing else can: the engine's 2:00 pass-out is not an
 * event (`Farmer.cs:3408` checks `timeOfDay >= 2600` and calls `Game1.PassOutNewDay()`, which resets `passedOut`
 * BEFORE `DayStarted` runs), so a reader of the morning cannot tell a night the engine took from one the companion
 * slept. `StardewSalientEventHooks.TryEmitNightEndedPassOut` publishes `night_ended_pass_out_day_<N>` while the clock
 * is still at 26:00, and the runner records the fact verbatim as
 * `{ worldFactKind: "night_ended_pass_out", worldFactPayload: { eventId: "night_ended_pass_out_day_6", ... } }`.
 *
 * WHAT `N` IS. The day the night ENDED (`StardewSalientEventHooks.cs:89`: "the actor collapsed on `totalDays` and wakes
 * on `totalDays + 1`"), in the same `Game1.Date.TotalDays` the `day_started_day_<n>` facts use. So this night ended
 * day `N` and opened day `N + 1` - which is how a pass-out is also a CROSSING, and why a run whose `day_started` fact
 * for `N + 1` was never delivered (measured 2026-11-07, `round39`: no `day_started_day_7` exists, only the pass-out)
 * still has a witness that the world moved on.
 *
 * Deduplicated by (day, cause): a redelivered fact is the same night. A fact whose minted id does not carry the day is
 * skipped rather than guessed, exactly as `worldDayStartsFromFacts` refuses one whose id is not the minted shape.
 */
export function worldNightEndingsFromFacts(facts) {
  const endings = [];
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (!isPlainObject(fact)) continue;
    const kind = fact.worldFactKind ?? fact.kind ?? fact.payload?.kind;
    if (typeof kind !== "string" || !kind.startsWith("night_ended_")) continue;
    const eventId = fact.eventId ?? fact.worldFactPayload?.eventId ?? "";
    const match = /^night_ended_([a-z_]+)_day_(\d+)$/u.exec(typeof eventId === "string" ? eventId : "");
    if (match === null) continue;
    const cause = match[1];
    const day = Number.parseInt(match[2], 10);
    if (!Number.isInteger(day)) continue;
    if (endings.some((entry) => entry.day === day && entry.cause === cause)) continue;
    endings.push(Object.freeze({ day, cause }));
  }
  return endings;
}

/**
 * The calendar day (1..28) the night ENDED on, from whichever witness carried the crossing.
 *
 * Two shapes, one question. A receipt-witnessed night carries the engine's own totals, so its `dayBefore` is a
 * `TotalDays`; a calendar-witnessed night carries the runner's `after.dayBefore`, which is a `dayOfMonth`. Both are
 * "the day the night started on", which is the day it ended. `null` when neither was published: a night whose ending
 * day nobody recorded cannot be matched against the world's facts, and guessing would attribute a pass-out to the
 * wrong night - which is worse than saying nothing.
 */
function nightEndedDayOfMonth(night, record) {
  if (isFiniteNumber(night?.dayBefore)) return dayOfMonthForTotalDays(night.dayBefore);
  const dayBefore = record?.after?.dayBefore;
  return isFiniteNumber(dayBefore) ? dayBefore : null;
}

/**
 * Judge one run's day records against the baseline's rules. Every rule can fail on its own and names
 * itself, so a red result says which single-game fact was missing instead of "multi-day timed out".
 */
export function assessMultiDayBaseline({
  dayRecords,
  daysRequested = null,
  worldDayStarts = null,
  worldNightEndings = null,
} = {}) {
  const violations = [];
  if (!Array.isArray(dayRecords)) {
    return Object.freeze({
      ok: false,
      state: "blocked",
      daysCrossed: 0,
      violations: Object.freeze([violation("day_records_missing", "dayRecords")]),
      checkedRules: CHECKED_RULES,
    });
  }

  const requested = isFiniteNumber(daysRequested) ? Math.trunc(daysRequested) : dayRecords.length;
  if (requested < MINIMUM_BASELINE_DAYS || requested > MAXIMUM_BASELINE_DAYS) {
    violations.push(violation(`baseline_window_out_of_range:${String(requested)}`, "daysRequested"));
  }

  // THE WORLD'S OWN NIGHT ENDINGS, when the caller could read them. `null` means nobody supplied the facts - NOT "the
  // world said nothing", which is an empty list and is judged as such - and the record's own witnesses answer instead.
  const worldEndings =
    worldNightEndings === null || worldNightEndings === undefined
      ? null
      : (Array.isArray(worldNightEndings) ? worldNightEndings : []).filter(
          (entry) => isPlainObject(entry) && Number.isInteger(entry.day) && typeof entry.cause === "string",
        );
  // The days (in `dayOfMonth` terms) a record's own night ended on, so a world fact is matched to the night it names
  // and never to the night beside it.
  const recordedEndedDays = new Set();

  let daysCrossed = 0;
  let shoppingMenuDismissals = 0;
  // Nights the engine ended with a pass-out: reported next to the verdict, because it is how the day was
  // crossed rather than whether it was, and a run whose nights were all pass-outs must be readable as such.
  let passOutNights = 0;
  // Nights whose MECHANISM nobody recorded. Distinct from `passOutNights`, which is a description of a night that was
  // observed. This one is a verdict: a calendar witness says the day changed and cannot say how, and "nobody knows how"
  // must not read as a pass.
  let unobservedNights = 0;
  // Nights whose lifecycle word contradicts the world's: REPORTED beside the verdict, never instead of it. A night the
  // world crossed is a crossed night, and the failure its lifecycle reported is a finding about that lifecycle's own
  // observation - not about the night. Collected here so a reader sees both halves at once.
  const lifecycleDisagreements = [];
  for (const [index, record] of dayRecords.entries()) {
    const where = `dayRecords[${String(index)}]`;
    if (!isPlainObject(record)) {
      violations.push(violation("day_record_not_object", where));
      continue;
    }
    const night = classifyNight({ terminal: record.terminal, after: record.after });
    if (!night.advanced) {
      // `where` NAMES A FIELD THE RECORD ACTUALLY HAS.
      //
      // It used to say `${where}.night`, and no day record has ever carried a `night` field - `runMultiDayLoop`
      // writes `{ day, terminal, after, menus, nextDayAccomplishedActionIds }` and `onDay` adds `cause`, `bedTime`,
      // `passedOut`, `nightVerdict` and `sleepReceipt` (`multiday-loop.mjs:313-320`). Measured 2026-11-01: all three of
      // round18/19/20's `result.json` files were read
      // as reporting `dayRecords[N].night.terminal = null`, and a reader who went looking for that field found it
      // absent in every run - the verdict was pointing at a path that does not exist. A violation a reader cannot
      // navigate to is a violation that gets argued with instead of fixed.
      violations.push(violation(night.reasonCode ?? "night_not_advanced", `${where}.terminal`));
      continue;
    }
    daysCrossed += 1;
    // HOW the night ended: the product's own receipt first (`entered_via=native_sleep_prompt` / `native_pass_out` are
    // what the Mod mints), the runner's observation second. Published so a run whose nights were pass-outs is readable
    // as such - and it is a description, never a verdict about the night.
    //
    // THE NIGHT'S OWN SLEEP RECEIPT is the second witness, and it is read from the RECORD rather than inferred here:
    // a night her own sleep ended can cross through the CALENDAR while her lifecycle receipt ends without the crossing
    // (`NIGHT_CAUSE_SLEEP_UNSETTLED`), and then the receipt is the only thing that says how it began. It travels on the
    // day record as `sleepReceipt` in the shape `night-verdict.mjs` publishes, so this judgement and the gate that
    // re-judges a run from its artifact (`check-live-run-multiday-baseline.mjs --run-dir`) see the same facts.
    const enteredVia = typeof night.facts.entered_via === "string" ? night.facts.entered_via : null;
    const sleepReceipt = isPlainObject(record.sleepReceipt) ? record.sleepReceipt : null;
    const sleepEnteredVia = sleepReceipt === null ? null : parseReceiptEvidence(sleepReceipt.evidence).entered_via;
    // WHAT THE RECORD'S OWN WITNESSES SAY, from the crossing receipt and the night's own sleep receipt.
    const claimed = nightCause({
      enteredVia,
      sleepEnteredVia: typeof sleepEnteredVia === "string" ? sleepEnteredVia : null,
      recorded: record.cause ?? null,
    });
    // WHAT THE WORLD SAYS, from the Mod's own `night_ended_*` fact for THIS night - matched by the calendar day the
    // night ended on, because the fact names the day the actor collapsed on and the record names the day it started.
    //
    // This is the authority, and it is the same one `dayCountWitness` already reads: measured 2026-11-07 (`round39`),
    // the world published `night_ended_pass_out_day_6` at 26:00 with `gameTime=2600`, and the assessment answered
    // `passOutNights: 0` with `night_mechanism_unobserved` - it counted its own bookkeeping and never opened the fact
    // that said how the night ended. `engine` stays the answer only when NOBODY says: no receipt and no world fact.
    const endedDayOfMonth = nightEndedDayOfMonth(night, record);
    const worldEnding =
      worldEndings === null || endedDayOfMonth === null
        ? undefined
        : worldEndings.find((entry) => dayOfMonthForTotalDays(entry.day) === endedDayOfMonth);
    if (worldEnding !== undefined) recordedEndedDays.add(dayOfMonthForTotalDays(worldEnding.day));
    const cause = worldEnding === undefined ? claimed : worldEnding.cause;
    // A DISAGREEMENT IS NAMED, NEVER SILENCED. A record whose receipt says her sleep crossed the night, beside a world
    // fact saying the engine passed her out on it, is one of the two being wrong - and a verdict that silently prefers
    // either one hides it. `engine` is not a disagreement: it is the record saying it does not know, which is exactly
    // what the world fact answers.
    if (worldEnding !== undefined && claimed !== NIGHT_CAUSE_ENGINE && claimed !== worldEnding.cause) {
      violations.push(
        violation(`night_cause_disagrees_with_the_world:${claimed}:${worldEnding.cause}`, `${where}.cause`),
      );
    }
    // THE LIFECYCLE'S OUTCOME AND THE WORLD'S CROSSING, when they contradict each other.
    //
    // TWO carriers, one reading. The record's own `terminal` carries it when the record published the failed lifecycle
    // AS the night's terminal (`classifyNight` names it in `disagreement`), and the record's `sleepReceipt` carries it in
    // the shape the runner actually writes - where a night her own sleep ended has `terminal: null` and her blocked
    // receipt travels beside it. `NIGHT_CAUSE_SLEEP_UNSETTLED` is the only cause under which the block IS a
    // contradiction: it is derived from that receipt plus a calendar that crossed, so SHE ended the night and her own
    // lifecycle says it could not. A pass-out the engine took is not this disagreement, and neither is a shared-world
    // wait.
    const disagreement =
      night.disagreement ??
      (cause === NIGHT_CAUSE_SLEEP_UNSETTLED
        ? lifecycleDisagreement({ lifecycle: sleepReceipt, worldCrossed: true })
        : null);
    if (disagreement !== null) {
      lifecycleDisagreements.push(
        Object.freeze({ night: index + 1, day: Number.isInteger(record.day) ? record.day : null, code: disagreement }),
      );
    }
    if (cause === NIGHT_CAUSE_PASS_OUT) passOutNights += 1;
    // `sleep` is a claim that the COMPANION's own `advance_day` crossed the night, and only the lifecycle receipt that
    // `advance_day` starts can show it. A record claiming one while the ONLY witness is the calendar (no receipt at all,
    // so no lifecycle existed) is stating an event nobody observed - which is exactly the shape that read as "the
    // companion slept" for two nights the engine had taken (measured 2026-10-30). `pass_out` needs no such proof: the
    // runner's own observation of the hold is a witness, and the engine taking the night needs none, as recorded.
    //
    // `sleep_unsettled` is NOT this claim: it is derived from a receipt, so reaching it means the receipt is in hand.
    if (cause === NIGHT_CAUSE_SLEEP && night.witness === "calendar") {
      violations.push(violation("night_cause_claims_a_sleep_without_a_receipt", `${where}.cause`));
    }
    // A CALENDAR WITNESS SAYS THE DAY CHANGED. IT CANNOT SAY HOW, AND "nobody recorded how" IS NOT A PASS.
    //
    // Measured 2026-10-31 (round17): two nights crossed, both with `night` null because neither went through a lifecycle.
    // The first was a real `advance_day`; the second was the engine passing the actor out at 02:00 (`game_time=2600`, forced
    // warp to FarmHouse, forced NewDay). `nightCause` returned "engine" for both, no rule applied to "engine", and the
    // assessment read `passed` with `passOutNights: 0`. The run was honest about what it knew and the verdict turned that
    // honesty into a pass.
    //
    // The fix is not to infer "engine therefore pass-out" - that is the guess `b27f75ca` removed. It is to say that a night
    // whose mechanism nobody observed did not pass verification.
    //
    // "NOBODY OBSERVED" NOW MEANS NOBODY, INCLUDING HER OWN RECEIPT: a night her sleep ended is attributed from that
    // receipt when the record carries it, and stays red when it does not. The rule therefore still fails on a night
    // nothing explains - which is the fixture below, and was the measured shape of round17.
    if (cause === NIGHT_CAUSE_ENGINE && night.witness === "calendar") {
      unobservedNights += 1;
      violations.push(violation("night_mechanism_unobserved", `${where}.cause`));
    }

    // Scope, enforced rather than assumed: this corpus proves consecutive days inside one season, with no
    // festival and no profession milestone. A night that left that window is a BLOCKED result, because the
    // verdict would otherwise read as covering a day the run never actually held.
    const outsideScope = nightOutsideBaselineScope(
      night.dayBefore === undefined ? night : { ...night, seasonIndex: seasonIndexFor(record.after) },
    );
    if (outsideScope !== null) violations.push(violation(outsideScope, `${where}.terminal`));

    // The Mod's own night facts. `saving_observed` is not required (a dismissed menu skips the
    // menu-owned save), but the two edges that DECIDE the terminal are.
    //
    // UNLESS the night has no lifecycle to publish them. `classifyNight`'s calendar branch produces exactly
    // `{ day_before, day_of_month }` - it can never produce `saved_observed` or `day_started_observed`, because no
    // lifecycle ran. Requiring them there is a gate that cannot go green: measured 2026-10-30 (`round8`), both nights
    // were the engine's 02:00 pass-out (ZERO `advance_day` receipts in the whole run), the calendar moved, and these
    // two fired on both - while the run's own timeline carried `lifecycle saving` twice and `day_started_day_5` /
    // `day_started_day_6` as world facts. The edges EXISTED; the witness simply does not read them.
    //
    // What a calendar night must prove instead is what the calendar can prove: that the day actually advanced, which
    // `classifyNight` already decided (`advanced: true`) before this code runs. `night_terminal_missing` remains the
    // violation for a night nobody witnessed at all.
    const witnessedByCalendar = night.witness === "calendar";
    if (!witnessedByCalendar && night.facts.saved_observed !== "true") {
      violations.push(violation("night_saved_edge_not_observed", `${where}.terminal.evidence.saved_observed`));
    }
    if (!witnessedByCalendar && night.facts.day_started_observed !== "true") {
      violations.push(
        violation("night_day_started_edge_not_observed", `${where}.terminal.evidence.day_started_observed`),
      );
    }
    // A SAVE THAT ARRIVED AFTER THE BOUNDARY POLL EXPIRED IS NOT A CLAIM WITHOUT A BOUNDARY.
    //
    // A rule used to fire here when `save_boundary_not_observed=true` met `saved_observed=true`, on the premise that
    // a save is only believable if `IsSaving` was ever polled true. Measured 2026-11-01 (`round19`,
    // `2026-11-01T04-56-14-966Z-multiday_routine`), that premise is false, and the rule reds a night the Mod crossed
    // correctly. The run's own log, for the night the rule fired on:
    //
    //   13:08:49  AwaitingSettlement -> AwaitingSave              the save boundary WAS entered
    //   13:08:54  AwaitingSave -> AwaitingDayStart               on the 300-frame budget, not on a save
    //   13:09:50  Context: before save / SaveGame.Save() completed without exceptions
    //   13:09:52  after save, starting spring 6 Y1               the save the receipt reports
    //
    // The engine saves SYNCHRONOUSLY, so `Game1.IsSaving` is true only while the update loop is blocked and a
    // per-frame poll can never see it - which is why `saving_observed` reads false on a night that really saved.
    // `saved_observed` is SMAPI's own `Saved` edge, the engine's authority for "a save completed". So
    // `save_boundary_not_observed` records a SEQUENCE - the transition was taken before the save began - and not a
    // contradiction: both facts are true, and the pair is the ordinary shape of a night whose settlement summary was
    // committed after the `AwaitingSave` window had already closed.
    //
    // Nothing in the receipt distinguishes that honest sequence from a false save claim, so a rule built on their
    // conjunction can only red honest nights. The claim itself stays protected by `night_saved_edge_not_observed`
    // above, which demands the save witness rather than an inference from a poll. `save_boundary_not_observed` stays
    // published because it is the one fact that says the transition was taken on the budget.

    // The menu that decides whether a rollover stalls: it must have been closed by the product, and
    // the closure must be a receipted fact rather than an inference.
    const menus = Array.isArray(record.menus) ? record.menus : [];
    const dismissible = menus.filter((menu) => DISMISSIBLE_ROLLOVER_MENUS.includes(menu?.menuType));
    for (const menu of menus) {
      if (menu?.menuType === LEVEL_UP_MENU) {
        // A rollover CAN raise a level-up menu, and it is settled by `respond_level_up` rather than by a
        // dismiss: the menu has no pure-cancel path. An ordinary level is resolved with the one legal value
        // (`confirm`), and a MILESTONE must not be resolved by anyone but the companion - so a record that
        // carries one without a receipt is red, and a receipted `confirm` is only acceptable when the receipt
        // itself says the menu was ordinary.
        const receipt = menu.respondReceipt ?? null;
        if (receipt?.reasonCode !== "level_up_resolved" || receipt?.state !== "succeeded") {
          violations.push(
            violation(`level_up_menu_not_resolved:${String(menu.respondReasonCode ?? "no_receipt")}`, `${where}.menus`),
          );
          continue;
        }
        if (menu.respondChoice !== "confirm") {
          // A branch chosen by the harness is the harness deciding the companion's growth path.
          violations.push(
            violation(`level_up_branch_chosen_by_harness:${String(menu.respondChoice)}`, `${where}.menus`),
          );
        }
        continue;
      }
      if (!(DISMISSIBLE_ROLLOVER_MENUS.includes(menu?.menuType) || WAIT_ROLLOVER_MENUS.includes(menu?.menuType))) {
        // A menu the product must not close (one with no audited handling) stops the night; the baseline
        // cannot claim a cross-day loop while one was raised.
        violations.push(violation(`night_raised_unclosable_menu:${String(menu?.menuType)}`, `${where}.menus`));
      }
    }
    for (const menu of dismissible) {
      // Either the published action dismissed it (the old shape) or it was HELD and then went away (the current one:
      // `SleepAndAdvanceDayLifecycle` commits it, so the loop never clicks and can have no receipt). The baseline asks
      // whether the summary was cleared, not which component typed the receipt - insisting on the former made every run
      // red the moment the ownership moved, and would have called a correctly-cleared menu a failure.
      const dismissedByAction =
        menu.dismissReceipt?.reasonCode === "modal_dismissed" && menu.dismissReceipt?.state === "succeeded";
      const committedByLifecycle = menu.decision === "wait" && menu.clearedAt !== undefined;
      if (!dismissedByAction && !committedByLifecycle) {
        violations.push(
          violation(`shipping_menu_not_dismissed:${String(menu.dismissReasonCode ?? "no_receipt")}`, `${where}.menus`),
        );
      } else {
        shoppingMenuDismissals += 1;
      }
    }

    // The day AFTER this night must still produce the companion's own work: that is what makes this
    // a loop. The final night has no following day inside the record, so it is not asserted.
    const isLast = index === dayRecords.length - 1;
    if (!isLast) {
      const accomplished = Array.isArray(record.nextDayAccomplishedActionIds)
        ? record.nextDayAccomplishedActionIds
        : [];
      if (accomplished.length === 0) {
        violations.push(violation("next_day_produced_no_farm_work", `${where}.nextDayAccomplishedActionIds`));
      }
    }
  }

  if (daysCrossed < MINIMUM_BASELINE_DAYS) {
    violations.push(violation(`baseline_days_crossed_below_minimum:${String(daysCrossed)}`, "daysCrossed"));
  }
  // A NIGHT THE WORLD ATTRIBUTED THAT NO RECORD COVERS IS A FINDING, NOT SILENCE.
  //
  // The records are the loop's own iterations, so a night the run lived through after its last iteration is invisible
  // to every rule above. Measured 2026-11-07 (`round39`): the world published `night_ended_pass_out_day_6` at 26:00 and
  // opened the next day, while the two day records covered the nights that had already crossed - so the pass-out night
  // belonged to no record, `passOutNights` read 0, and nothing in the assessment mentioned it. Its cause still counts
  // toward `passOutNights` here, because the count is a statement about the WORLD and not about the records.
  for (const ending of worldEndings ?? []) {
    if (recordedEndedDays.has(dayOfMonthForTotalDays(ending.day))) continue;
    if (ending.cause === NIGHT_CAUSE_PASS_OUT) passOutNights += 1;
    violations.push(violation(`world_night_not_recorded:${String(ending.day)}:${ending.cause}`, "worldNightEndings"));
  }
  // THE POPULATION COMES FROM THE AUTHORITY, NOT FROM THE ASSESSOR'S OWN LOOP COUNT.
  //
  // `daysCrossed` counts the records THIS function was handed, and those records are the loop's own iterations. Measured
  // 2026-11-06 (`round38`, `18-41-39-799Z-multiday_routine`): both records classified as advanced nights and the result
  // read `crossings: 2`, while the world had published `day_started_day_5` ... `day_started_day_9` - five day changes,
  // three of them in 8.7 s, none of them watched. Every rule above was green because every number it read came from the
  // same bookkeeping. The world's own `day_started` facts are the population, and a disagreement is a NAMED finding
  // carrying both numbers rather than a silent two.
  //
  // A PASS-OUT IS A CROSSING TOO. `Game1.PassOutNewDay()` calls `NewDay` itself, so the day after a pass-out REALLY
  // starts; measured 2026-11-07 (`round39`), its `day_started_day_7` was never delivered and the pass-out fact was the
  // only witness that the world had moved on. Reading only `day_started` made the population agree with the records
  // (2 == 2) while the world had in fact opened a third day.
  //
  // The witness is published either way: a caller that supplied no world facts gets `dayCountWitness: "assessor"`,
  // which says the count nobody reconciled is exactly that, instead of letting it read as measured.
  const worldDaysCrossed = Array.isArray(worldDayStarts)
    ? [...new Set([...worldDayStarts.filter(isFiniteNumber), ...(worldEndings ?? []).map((ending) => ending.day + 1)])]
        .length
    : null;
  const dayCountWitness = worldDaysCrossed === null ? "assessor" : "world";
  if (worldDaysCrossed !== null && worldDaysCrossed !== daysCrossed) {
    violations.push(
      violation(
        `day_count_disagrees_with_the_world:${String(daysCrossed)} != ${String(worldDaysCrossed)}`,
        "worldDayStarts",
      ),
    );
  }
  // The first night is the one the fixture arms with a single shippable object, so it is the one that
  // MUST have raised the menu. Zero dismissals across the whole run means the settlement never
  // happened, which would make the "a rollover does not stall" claim vacuous.
  if (daysCrossed > 0 && shoppingMenuDismissals === 0) {
    violations.push(violation("first_night_shipping_menu_never_dismissed", "menus"));
  }

  return Object.freeze({
    ok: violations.length === 0,
    state: violations.length === 0 ? "passed" : "blocked",
    daysCrossed,
    shoppingMenuDismissals,
    passOutNights,
    unobservedNights,
    // The nights whose lifecycle reported a failure while the world crossed them. A reading, not a violation: the night
    // crossed, and naming it red would say the opposite. `[]` means every lifecycle agreed with the world.
    lifecycleDisagreements: Object.freeze(lifecycleDisagreements),
    worldDaysCrossed,
    dayCountWitness,
    // The attribution the judgement actually used, per night: the world's own endings when the caller could read them,
    // `null` when nobody supplied the facts (which is not "the world said nothing"). A reader must be able to see WHICH
    // night was called a pass-out, and `nightWitness` says whose answer that was.
    worldNightEndings: worldEndings === null ? null : Object.freeze([...worldEndings]),
    nightWitness: worldEndings === null ? "assessor" : "world",
    violations: Object.freeze(violations),
    checkedRules: CHECKED_RULES,
  });
}

/**
 * Every rule this assessment can report a run BLOCKED for, by name.
 *
 * The population is the violation codes, so a rule that fails a run appears here or nowhere. The lifecycle disagreement
 * (`LIFECYCLE_DISAGREES_WITH_WORLD`) is deliberately NOT in it: it reports the nights a lifecycle lost its own crossing
 * while the world kept it, which does not un-cross a night and so is published as a reading (`lifecycleDisagreements`)
 * rather than as a reason to fail the run.
 */
const CHECKED_RULES = Object.freeze([
  "day_records_missing",
  "baseline_window_out_of_range",
  "day_record_not_object",
  "night_terminal_missing",
  "night_not_advanced",
  "night_totals_missing",
  "night_totals_did_not_advance",
  "night_world_calendar_unobserved",
  "night_world_calendar_mismatch",
  "night_saved_edge_not_observed",
  "night_day_started_edge_not_observed",
  "night_cause_claims_a_sleep_without_a_receipt",
  "night_mechanism_unobserved",
  "night_raised_unclosable_menu",
  "level_up_menu_not_resolved",
  "level_up_branch_chosen_by_harness",
  "shipping_menu_not_dismissed",
  "next_day_produced_no_farm_work",
  "baseline_days_crossed_below_minimum",
  "day_count_disagrees_with_the_world",
  "night_cause_disagrees_with_the_world",
  "world_night_not_recorded",
  "first_night_shipping_menu_never_dismissed",
]);
