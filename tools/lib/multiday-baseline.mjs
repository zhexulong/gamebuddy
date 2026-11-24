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

/**
 * The day of the month BEFORE this one, in the same base.
 *
 * The other direction of `dayOfMonthForTotalDays`, and it is what turns a record's observed calendar into the night it
 * records: a record shows the day a night OPENED, and the night ended on the day before it. `1` goes back to `28`
 * because a season wraps, exactly as the engine's own calendar does.
 */
function dayOfMonthBefore(dayOfMonth) {
  if (!isFiniteNumber(dayOfMonth)) return null;
  const day = Math.trunc(dayOfMonth);
  if (day < 1 || day > DAYS_PER_SEASON) return null;
  return ((day + DAYS_PER_SEASON - 2) % DAYS_PER_SEASON) + 1;
}

/**
 * The day a `night_ended_*` fact names, in the ONE base this ledger uses.
 *
 * The Mod mints `night_ended_pass_out_day_<TotalDays>` (`Sensory/StardewSalientEventHooks.cs:64-75`), while every day a
 * `dayRecords` entry carries is a `dayOfMonth` (`after.dayBefore`). Converting at the point of comparison but printing
 * the raw `TotalDays` in the finding is how `world_night_not_recorded:6` came to name a day nobody could look up: 6 was
 * the engine's own count and the record it was missing was day 7 of the month. One number, one base, converted once.
 */
export function worldEndingDayOfMonth(ending) {
  return isPlainObject(ending) ? dayOfMonthForTotalDays(ending.day) : null;
}

/** The ENGINE took the night: `Game1.PassOutNewDay()` calls `NewDay(0f)` itself. */
export const NIGHT_CAUSE_PASS_OUT = "pass_out";

/** Her own `sleep` crossed the night, and that is the receipt's own claim: `succeeded/day_advanced`. */
export const NIGHT_CAUSE_SLEEP = "sleep";

/**
 * The action whose `day_advanced` receipt is HER crossing of a night.
 *
 * The cause and the action id are the same word by coincidence of naming, not by meaning: `sleep` is the published
 * action id (the one a plan's node carries) and `sleep` is what the night's cause is called. They are spelled apart so
 * that renaming the cause cannot silently stop the witness being read.
 */
const SLEEP_ACTION_ID = "sleep";

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
 * EVERY CAUSE A NIGHT RECORD CAN NAME, and the population of `nightCauseSupport`.
 *
 * A cause that is not in this list is one this ledger has not met: a record carrying it cannot be supported, because
 * nothing here knows what observation would support it. That is why the list is the authority the support gate reads
 * rather than a comment - a new cause has to be declared here before a night can claim it.
 */
export const NIGHT_CAUSES = Object.freeze([
  NIGHT_CAUSE_SLEEP,
  NIGHT_CAUSE_SLEEP_UNSETTLED,
  NIGHT_CAUSE_PASS_OUT,
  NIGHT_CAUSE_ENGINE,
]);

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
export function classifyNight({ terminal, after, worldEnding = null } = {}) {
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
    // A THIRD WITNESS: THE WORLD'S OWN SAYING THAT A NIGHT ENDED.
    //
    // The Mod mints `night_ended_<cause>_day_<n>` while the clock is still at 26:00
    // (`StardewSalientEventHooks.TryEmitNightEndedPassOut`), and `Game1.PassOutNewDay()` calls `NewDay` itself - so the
    // fact is the engine crossing a night, which is a crossing whether or not a watcher was standing. Measured
    // 2026-11-18 (`round76`): the pass-out happened inside the CLOSING day's turn, after the night watcher had stopped,
    // so the night had no record at all and the ledger read `crossings 2` beside three world days.
    //
    // It carries no lifecycle edges because there was no lifecycle to publish them - the same reason the calendar branch
    // above carries none, and why `advance` is `undefined` here rather than a zero.
    if (isPlainObject(worldEnding) && typeof worldEnding.cause === "string") {
      return Object.freeze({
        advanced: true,
        witness: "world",
        reasonCode: null,
        cause: worldEnding.cause,
        expectedDayOfMonth: dayOfMonthForTotalDays(worldEnding.day + 1),
        facts: Object.freeze({ day_of_month: String(worldEndingDayOfMonth(worldEnding)) }),
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
 * EVERY NIGHT THE RUN'S OWN RECORD SAYS ENDED, as `{ day, cause }` in ONE base.
 *
 * The Mod mints the fact that says HOW a night ended, because nothing else can: the engine's 2:00 pass-out is not an
 * event (`Farmer.cs:3408` checks `timeOfDay >= 2600` and calls `Game1.PassOutNewDay()`, which resets `passedOut`
 * BEFORE `DayStarted` runs), so a reader of the morning cannot tell a night the engine took from one the companion
 * slept. `StardewSalientEventHooks.TryEmitNightEndedPassOut` publishes `night_ended_pass_out_day_<N>` while the clock
 * is still at 26:00, and the runner records the fact verbatim as
 * `{ worldFactKind: "night_ended_pass_out", worldFactPayload: { eventId: "night_ended_pass_out_day_6", ... } }`.
 *
 * TWO SPELLINGS OF ONE NIGHT, READ HERE SO THEY CANNOT DIVERGE. A night she chose to end is witnessed by her `sleep`
 * action's own receipt (`reasonCode: "day_advanced"`), not by a `night_ended_*` fact - the Mod mints that fact only for
 * the engine's pass-out. Measured 2026-11-19 (`round77`): three `day_started` facts (`_5`, `_6`, `_7`) beside three
 * `sleep` receipts reaching `day_advanced` (`day_before=4`, `5`, `6`) and NOT ONE `night_ended_*` fact, and this reader
 * returned `[]` - so the third night, the one the closing day's turn ended, belonged to no record and the ledger read
 * `crossings: 2` while the world had opened three days. Both spellings are now endings with a cause, extracted together,
 * so nothing downstream has to know which channel a night came through.
 *
 * WHAT `N` IS. The day the night ENDED, as the engine's own `Game1.Date.TotalDays`: the `night_ended_pass_out_day_<N>`
 * fact names the day the actor collapsed on (`StardewSalientEventHooks.cs:89`: "the actor collapsed on `totalDays` and
 * wakes on `totalDays + 1`"), and a `sleep` receipt carries the same number as `day_before` beside the `day_after` it
 * crossed into. That is why a night is also a CROSSING (`ending.day + 1` is the day that opened) and why a run whose
 * `day_started` fact for `N + 1` was never delivered (measured 2026-11-07, `round39`: no `day_started_day_7` exists,
 * only the pass-out) still has a witness that the world moved on.
 *
 * Deduplicated by (day, cause): a redelivered fact, or the same receipt read twice, is the same night. A fact whose
 * minted id does not carry the day is skipped rather than guessed, exactly as `worldDayStartsFromFacts` refuses one
 * whose id is not the minted shape.
 */
export function worldNightEndingsFromFacts(facts) {
  const endings = [];
  for (const fact of Array.isArray(facts) ? facts : []) {
    const ending = nightEndingOf(fact);
    if (ending === null) continue;
    if (endings.some((entry) => entry.day === ending.day && entry.cause === ending.cause)) continue;
    endings.push(Object.freeze(ending));
  }
  return endings;
}

/**
 * HOW ONE ENTRY IN THE RUN'S FACT LOG SAYS A NIGHT ENDED, or `null` when it says nothing about a night.
 *
 * THE POPULATION OF THIS FUNCTION IS THE POPULATION OF THE GATE. "Every way a day can end" is not a list maintained
 * anywhere else: it is exactly the shapes read here, so a shape added to this switch is a shape the ledger accounts for
 * without a second edit - and one that is dropped here makes `a_night_the_world_had_is_not_missing_from_the_record`
 * red rather than silently unmeasured.
 */
function nightEndingOf(fact) {
  if (!isPlainObject(fact)) return null;
  const worldKind = fact.worldFactKind ?? fact.kind ?? fact.payload?.kind;
  if (typeof worldKind === "string" && worldKind.startsWith("night_ended_")) {
    const eventId = fact.eventId ?? fact.worldFactPayload?.eventId ?? "";
    const match = /^night_ended_([a-z_]+)_day_(\d+)$/u.exec(typeof eventId === "string" ? eventId : "");
    if (match === null) return null;
    const day = Number.parseInt(match[2], 10);
    return Number.isInteger(day) ? { day, cause: match[1], dayAfter: null } : null;
  }
  return sleepCrossingOf(fact);
}

/**
 * THE NIGHT HER OWN `sleep` ENDED, read off the receipt that carries the crossing.
 *
 * `reasonCode: "day_advanced"` IS the Mod saying a lifecycle crossed a night (`multiday-loop.mjs`'s `CROSSING_REASON`,
 * the same word `crossingsFromEvidence` filters by), and `sleep` is the one action that starts that lifecycle - the
 * action id other readers of this fact already name (`run-verdicts.mjs`, `multiday-day-scope.mjs`).
 *
 * `day_before` and not `dayBefore`: the engine's `day_of_month` and its `TotalDays` are two numbers that agree only by
 * coincidence in spring of year one, and this ledger compares endings by `TotalDays`. A receipt whose evidence carries
 * no `day_before` names no day and is skipped, so the night it crossed is reported missing rather than attributed to
 * whatever day happened to be current.
 */
function sleepCrossingOf(receipt) {
  if (receipt.reasonCode !== CROSSING_OUTCOME.reasonCode) return null;
  const payload = isPlainObject(receipt.worldFactPayload) ? receipt.worldFactPayload : {};
  const actionId = receipt.actionId ?? receipt.action ?? payload.actionId ?? null;
  if (actionId !== SLEEP_ACTION_ID) return null;
  const facts = parseReceiptEvidence(receipt.evidence ?? payload.evidence);
  const day = Number.parseInt(facts.day_before ?? "", 10);
  if (!Number.isInteger(day)) return null;
  // THE DAY IT OPENED, as the receipt itself states it. That is the number a day record's own calendar shows - a
  // record observes the day AFTER its night - so it is the identity a receipt is paired to a record by. `null` when the
  // receipt does not state it, which is a reading in its own right rather than a guess of `day + 1`.
  const dayAfter = Number.parseInt(facts.day_after ?? "", 10);
  return { day, cause: NIGHT_CAUSE_SLEEP, dayAfter: Number.isInteger(dayAfter) ? dayAfter : null };
}

/**
 * THE CROSSING RECEIPT A DAY RECORD CARRIES, with the days it names, or `null`.
 *
 * The runner puts it on `terminal` when the lifecycle's own terminal IS the crossing, and on `sleepReceipt` when the
 * record was crossed by the calendar and the receipt travelled beside it. Both are the same claim, so both are read
 * here - and only a receipt whose reason is the crossing counts: a blocked lifecycle receipt is how a night STARTED,
 * not a claim that it crossed.
 */
function crossingReceiptOf(record) {
  for (const candidate of [record?.terminal, record?.sleepReceipt]) {
    if (!isPlainObject(candidate) || candidate.reasonCode !== CROSSING_OUTCOME.reasonCode) continue;
    const facts = parseReceiptEvidence(candidate.evidence ?? candidate.worldFactPayload?.evidence);
    const dayBefore = Number.parseInt(facts.day_before ?? "", 10);
    if (!Number.isInteger(dayBefore)) continue;
    const dayAfter = Number.parseInt(facts.day_after ?? "", 10);
    return Object.freeze({ dayBefore, dayAfter: Number.isInteger(dayAfter) ? dayAfter : null });
  }
  return null;
}

/**
 * Does this record show that a night crossed?
 *
 * The calendar moved, the record's own receipt claims the crossing, or the record is a reconciled night that names the
 * day it ended on. Asked before a record's ending day is allowed to say which world night it covers: a record that
 * shows no crossing covers no night, and a day derived from its calendar would otherwise claim the night before it.
 */
function showsACrossing(record) {
  if (!isPlainObject(record)) return false;
  if (isFiniteNumber(record.endedDayOfMonth)) return true;
  if (calendarCrossed(record.after) === true) return true;
  return crossingReceiptOf(record) !== null;
}

/**
 * A NIGHT THE WATCHER NEVER SAW, as a record the baseline can judge.
 *
 * The loop watches the nights it was asked for; the CLOSING day's turn can still end in a night, and by then no watcher
 * is running (`runMultiDayLoop`). Measured 2026-11-18 (`round76`): the pass-out landed inside that closing turn, so the
 * ledger read `crossings: 2` beside three world days while `round-verdict` counted the third from the run's own evidence.
 * Measured again 2026-11-19 (`round77`) with the other spelling: that closing night was her own `sleep`, witnessed only
 * by the `day_advanced` receipt its lifecycle carried.
 *
 * `watched: false` and the CAUSE are the two things this record exists to say. A night nobody watched and cannot say how
 * it ended is two silences, and `day` is `null` rather than invented: the loop's day numbers are its own iterations and
 * this night has none.
 *
 * `nextDayIssued: false` is the third thing, and it is a FACT rather than an inference from the record's position. The
 * loop fills `nextDayAccomplishedActionIds` from the turn it issued after a night, so an empty list on a record it stood
 * over means the day produced nothing; a night appended here has no turn of its own at all, and `[]` must not read as a
 * day that was given a turn and did nothing (measured `round80`: the closing night's day lived 8.9 s before the runner
 * stopped, and the assertion fired on it only because the reconciled records had moved it away from the array's end).
 */
export function worldWitnessedNightRecord(ending) {
  return Object.freeze({
    day: null,
    terminal: null,
    after: null,
    menus: Object.freeze([]),
    nextDayAccomplishedActionIds: Object.freeze([]),
    // No turn followed this night: the loop had already stopped when it ended. Stated, so the rule that asks for farm
    // work after a night reads the fact instead of the record's index.
    nextDayIssued: false,
    watched: false,
    cause: ending.cause,
    // NO CLOCK WAS EVER READ FOR THIS NIGHT, AND THE RECORD SAYS WHY. It carries a cause (the world's own ending) and
    // no watch stood over it, so it can have no hour - and a bare `bedTime: null` would leave the cause supported by
    // nothing. Stated rather than omitted, so the gate reads the reason instead of the absence.
    bedTime: null,
    bedTimeSource: null,
    bedTimeAbsent: "night_not_watched",
    passedOut: ending.cause === NIGHT_CAUSE_PASS_OUT,
    // THE SAME NUMBER THE WATCHED RECORDS CARRY: a `dayOfMonth`, converted from the fact's `TotalDays` here and nowhere
    // else, so `nightEndedDayOfMonth` and the finding that names a missing night agree about which day it was.
    endedDayOfMonth: worldEndingDayOfMonth(ending),
  });
}

/**
 * EVERY NIGHT THIS RUN HAD, as the ledger of it: the ones the watcher saw, plus the ones only the record witnessed.
 *
 * The two counts are reported SEPARATELY and never merged into one number, because they answer different questions:
 * `watched` is how many nights the loop stood over, and `recorded` is how many the ledger covers. A reader who sees
 * `recorded 3 · watched 2` knows the third night was reconciled rather than observed, and a reader who sees only
 * `crossings 3` does not.
 *
 * A night is reconciled only when NO record's own ending day is the day the record ended it: the ending for a night the
 * watcher already recorded is that record's cause, which the baseline matches by day and which must not be added twice.
 * Both spellings of an ending come from `worldNightEndingsFromFacts`, so which channel a night came through cannot
 * change how it is reconciled.
 */
export function reconcileDaysWithTheWorld({ dayRecords = [], worldNightEndings = null } = {}) {
  if (!Array.isArray(dayRecords)) {
    return Object.freeze({ records: Object.freeze([]), watched: 0, examined: null, recorded: 0, missing: null });
  }
  const endings = Array.isArray(worldNightEndings) ? worldNightEndings : null;
  const watched = dayRecords.length;
  if (endings === null) {
    return Object.freeze({ records: dayRecords, watched, examined: null, recorded: watched, missing: null });
  }
  const covered = new Set(
    dayRecords.map((record) => (showsACrossing(record) ? nightEndedDayOfMonth(record) : null)).filter(isFiniteNumber),
  );
  const open = endings.filter((ending) => {
    const day = worldEndingDayOfMonth(ending);
    return day !== null && !covered.has(day);
  });
  return Object.freeze({
    records: Object.freeze([...dayRecords, ...open.map(worldWitnessedNightRecord)]),
    watched,
    examined: endings.length,
    recorded: watched + open.length,
    missing: open.length,
  });
}

/**
 * The calendar day (1..28) the night ENDED on, from whichever witness the RECORD itself carries.
 *
 * FOUR SHAPES, ONE QUESTION. A reconciled record names the day it ended on (`endedDayOfMonth`); a calendar-witnessed
 * night carries the runner's `after.dayBefore`, which is the `dayOfMonth` the watch began on; a record whose snapshot
 * published only `after.dayOfMonth` shows the day the night OPENED, and the night ended on the day before it; and a
 * record with no calendar at all still carries the receipt it crossed with, whose `day_before` is the engine's
 * `TotalDays`. All four answer "the day the night ended on". `null` when none was published: a night whose ending day
 * nobody recorded cannot be matched against the world's endings, and guessing would attribute a pass-out to the wrong
 * night - which is worse than saying nothing.
 *
 * THE RECORD'S OWN CALENDAR OUTRANKS THE RECEIPT IT CARRIES, and that ordering is the fix for a measured mispairing
 * (`round80`, 2026-11-19). Her `day_advanced` receipt is minted 18-122 ms AFTER the `day_started` of the day it opened,
 * so it arrives inside the NEXT day's watch: a reader that trusts whichever receipt a record holds attributes the first
 * night's receipt to the second night's record, and then the night it really names is left looking uncovered. The
 * receipt is evidence about the night ITS OWN days name, not about the record it happens to sit on - so the record's
 * calendar answers here, and `nightReceiptPairings` says which night each receipt names.
 */
function nightEndedDayOfMonth(record) {
  if (isFiniteNumber(record?.endedDayOfMonth)) return record.endedDayOfMonth;
  // THE WORLD'S OWN READING FIRST. A record's `after.dayBefore` is the `dayOfMonth` the watch began on - the world's own
  // number - and the receipt's `day_before` is a `TotalDays` that has to be converted before it means anything. They
  // agreed by construction until a run whose first night the receipt called day 4 while the world called it day 5, and
  // two spellings of one day is how a night gets attributed to its neighbour.
  if (isFiniteNumber(record?.after?.dayBefore)) return record.after.dayBefore;
  // THE DAY IT OPENED IS THE CALENDAR'S OWN STATEMENT ABOUT THIS NIGHT, and the ending is the day before it. Measured
  // 2026-11-19 (`round77`): both watched records published `after.dayOfMonth` and NO `after.dayBefore`, so this function
  // answered `null` for every night the watcher saw and every one of her receipts read as a night no record covered.
  // That fix read the receipt instead; this reads the calendar the record already published, which is the same number
  // and does not move when the receipt is filed on the wrong night.
  if (isFiniteNumber(record?.after?.dayOfMonth)) return dayOfMonthBefore(record.after.dayOfMonth);
  // A RECORD WITH NO CALENDAR AT ALL has only its receipt left, and its `day_before` is the one number it carries.
  const carried = crossingReceiptOf(record);
  return carried === null ? null : dayOfMonthForTotalDays(carried.dayBefore);
}

/**
 * WHICH NIGHT EACH `day_advanced` RECEIPT NAMES, and which day record that night has - keyed on the receipt's OWN days.
 *
 * THE QUESTION THIS ANSWERS IS NOT "WHICH RECEIPT ARRIVED FIRST". A receipt that arrives after the event it explains
 * cannot be attributed by sequence: measured `round80` (`2026-11-19T21-44-19-653Z-multiday_routine`), each of the run's
 * three `sleep -> day_advanced` receipts was emitted 18-122 ms AFTER the `day_started` of the day it opened, so all
 * three arrived inside the NEXT day's watch. The identity is the day the receipt opened (`day_after`, the engine's own
 * `TotalDays`, converted once to the `dayOfMonth` every record carries) and the day the night ended on (`day_before`):
 * a record observes the day AFTER its night, so `after.dayOfMonth` IS the day the receipt opened.
 *
 * A receipt LANDS on a record two ways, and both are reported because they can disagree:
 *   - `namedBy`: the record's own day is the day the receipt opened - the identity above;
 *   - `filedOn`: the record carries this receipt as its crossing, whichever of `terminal` / `sleepReceipt` it sits on.
 * A receipt with one landing is PAIRED; with none it is UNPAIRED (the night it crossed has no record); with two or more
 * it is DOUBLE-PAIRED - which is exactly what an arrival-order attribution produces, because the receipt of night N
 * is still the freshest one on the record of night N+1.
 *
 * `entries` is ordered by the receipt's own day, never by arrival: reordering the facts cannot change this reading, and
 * that is the property the gate asserts rather than assumes.
 */
export function nightReceiptPairings({ dayRecords = [], worldNightEndings = null } = {}) {
  const records = Array.isArray(dayRecords) ? dayRecords : [];
  const endedDays = records.map((record) => nightEndedDayOfMonth(record));
  const filedReceipts = records.map((record) => crossingReceiptOf(record));
  const entries = [];
  for (const ending of Array.isArray(worldNightEndings) ? worldNightEndings : []) {
    if (!isPlainObject(ending) || ending.cause !== NIGHT_CAUSE_SLEEP || !Number.isInteger(ending.day)) continue;
    const endedDayOfMonth = worldEndingDayOfMonth(ending);
    const namedBy = [];
    const filedOn = [];
    for (const [index, endedDay] of endedDays.entries()) {
      if (endedDayOfMonth !== null && endedDay === endedDayOfMonth) namedBy.push(index);
      if (filedReceipts[index] !== null && filedReceipts[index].dayBefore === ending.day) filedOn.push(index);
    }
    const landsOn = [...new Set([...namedBy, ...filedOn])].sort((left, right) => left - right);
    entries.push(
      Object.freeze({
        day: ending.day,
        dayAfter: Number.isInteger(ending.dayAfter) ? ending.dayAfter : null,
        endedDayOfMonth,
        namedBy: Object.freeze(namedBy),
        filedOn: Object.freeze(filedOn),
        records: Object.freeze(landsOn),
      }),
    );
  }
  entries.sort((left, right) => left.day - right.day);
  return Object.freeze({
    examined: entries.length,
    paired: entries.filter((entry) => entry.records.length === 1).length,
    unpaired: entries.filter((entry) => entry.records.length === 0).length,
    doublePaired: entries.filter((entry) => entry.records.length > 1).length,
    entries: Object.freeze(entries),
  });
}

/** The one line a run's pairing is read off: `receipts R · paired P · unpaired U · double-paired D`. */
export function nightReceiptPairingLine(pairings) {
  const count = (field) => (pairings === null ? "not_measured" : String(pairings[field]));
  return `receipts ${count("examined")} · paired ${count("paired")} · unpaired ${count("unpaired")} · double-paired ${count("doublePaired")}`;
}

/**
 * A PROMISE TO GO TO BED THAT WAS NEVER TAKEN, which is the cause of a night the engine had to end.
 *
 * <p>
 * Measured 2026-11-13 (`round47`). At 22:00 she dispatched `enter_exit` into `FarmHouse:3,11` - the tile beside her own
 * bed - and then stood there. Her delivered lines over the next turns were 「就睡，别撑到一点半了——斧头往墙角一靠，这就躺平」,
 * 「都十二点了」 and 「手里还攥着斧柄，松开手，这觉才算真睡下去」. She dispatched NINE turns of it and submitted `sleep`
 * zero times in fifty-nine turns, so at 26:00 the engine took the night (`night_ended_pass_out_day_4`), and the only
 * thing the run's account could say about it was `pass_out` - the CONSEQUENCE. Asked afterwards she answered exactly
 * that: 「我把「我在文字里躺下了」当成「我已经躺下了」」.
 * </p>
 *
 * <p>
 * `pass_out` is a consequence, not a cause. `WorldModel.cs:193` is where the Mod decides the actor has been passed out
 * (`facts.Stamina <= PassOutStaminaFloor || facts.TimeOfDay >= PassOutDayEndTime`, the constants at `:110`/`:114` being
 * the engine's own `-15f` and `2600` from `Game1.cs:6452`), and `Sensory/StardewSalientEventHooks.cs:64-75` is where
 * that crossing is published as `night_ended_pass_out_day_<TotalDays>`. Both observe the engine taking a night that was
 * never ended by her, which is why a reading is needed and why a *postcondition* is not the right instrument: nothing
 * was attempted and refused. A promise is a decision that was never carried out, and the only record of it is the line
 * she delivered.
 * </p>
 *
 * <p>
 * THE WORDS ARE A DECLARED LIST, NOT A STEM. Every phrase below is one she actually delivered: 「就睡」, 「躺平」 and
 * 「睡下去」 on the round47 evening above, and `go to bed` / `going to bed` on 2026-10-28 (run `game-1793210285549`,
 * day 5), where her own thinking read "Going to bed would be good. Let me check if there's a sleep action" and the same
 * 2:00 pass-out took the night. A form of committing to bed that is not in this list is a form the reading will miss -
 * the fix is to name it here, never to widen the match to bare 「睡」, which is in half of every night's narration.
 * </p>
 *
 * <p>
 * A NEGATED COMMITMENT IS NOT A COMMITMENT. The same words behind a declared negating prefix are read as a refusal, so
 * 「今晚不躺平了，干到天亮」 - a companion choosing to work the night - cannot be reported as a promise she broke.
 * </p>
 */
export const SLEEP_PROMISE_PHRASES = Object.freeze([
  // Measured 2026-11-13 (`round47`), the evening she stood in the farmhouse until 02:00.
  "就睡",
  "躺平",
  "睡下去",
  // Measured 2026-10-28 (run `game-1793210285549`, day 5), the same defect in the other locale.
  "go to bed",
  "going to bed",
]);

/** Prefixes that turn one of the phrases above into a refusal to do it. */
export const SLEEP_PROMISE_NEGATIONS = Object.freeze(["不", "没", "别", "not ", "never "]);

/**
 * How many turns a promise has before the reading calls it unkept.
 *
 * <p>
 * MEASURED, not chosen: on `round47` the farmhouse was entered on delivered turn 38 (`time_milestone_day_4_2200` at the
 * same boundary), the commitment was delivered on turn 39, and the engine's pass-out landed on turn 47 - EIGHT turns
 * from the promise to the consequence, NINE from the door to it. Three is the window this repository already waits
 * before it calls narration without work a finding the next turn must answer (`NARRATION_WITHOUT_WORK_TURNS`, the same
 * three turns), so the same three turns here name the missing `sleep` five turns before the pass-out could take the
 * night - and a companion standing on her own bed tile who means it needs one turn, not four.
 * </p>
 *
 * <p>
 * The window does not pretend the promise is void after three turns: a `sleep` submitted later still ends the night, it
 * is simply not the promise being kept. A reading that waited for the consequence would only re-spell `pass_out`.
 * </p>
 */
export const SLEEP_PROMISE_TURNS = 3;

/** The reading a promise leaves behind when the engine had to end the night it promised. */
const SLEEP_PROMISED_NOT_TAKEN = "sleep_promised_not_taken";

/**
 * The commitment a delivered turn's lines carry, or `null`. First match wins, scanning the lines in the order she spoke
 * them, so the phrase reported is the one that actually opened the promise. `index` is the line's position in the turn's
 * `spokenLines`, which is what joins it to `spokenAtMs` - the moment the player was shown it.
 */
export function sleepPromiseIn(lines) {
  for (const [index, line] of (Array.isArray(lines) ? lines : []).entries()) {
    if (typeof line !== "string") continue;
    const text = line.trim();
    if (text.length === 0) continue;
    const lowered = text.toLowerCase();
    for (const phrase of SLEEP_PROMISE_PHRASES) {
      const at = lowered.indexOf(phrase.toLowerCase());
      if (at < 0) continue;
      const before = lowered.slice(Math.max(0, at - 6), at);
      if (SLEEP_PROMISE_NEGATIONS.some((negation) => before.endsWith(negation))) continue;
      return Object.freeze({ phrase, line: text, index });
    }
  }
  return null;
}

/**
 * WHICH OF A RUN'S NIGHTS THE ENGINE TOOK, by the loop's own day number - the only nights a bedtime promise can be
 * charged for.
 *
 * <p>
 * The receipt that contradicts a promise to go to bed is the engine taking the night: `Game1.PassOutNewDay()` forces
 * `NewDay`, and `Sensory/StardewSalientEventHooks.cs:64-75` publishes it as `night_ended_pass_out_day_<TotalDays>`. A
 * night her own `sleep` ended is the opposite - the receipt CONFIRMS what she said - and a night with no ending at all
 * has no receipt to contradict anything.
 * </p>
 * <p>
 * The join is by the day the night ENDED on, which is the one base the rest of this module compares in
 * (`nightEndedDayOfMonth` against `worldEndingDayOfMonth`): a record's `day` is the loop's day number, a world ending's
 * `day` is an engine count, and neither may be compared to the other directly. `null` when nobody supplied the world's
 * endings - NOT MEASURED, which is not the same as a run the engine never passed her out of.
 * </p>
 * <p>
 * A reconciled night (`worldWitnessedNightRecord`) carries no day number of its own, so it contributes none here: a
 * promise spoken on a day no watcher covered is not charged, which is the fail-safe direction - the ledger does not
 * accuse without a receipt.
 * </p>
 */
export function nightsTheEngineTook({ dayRecords = [], worldNightEndings = null } = {}) {
  const records = Array.isArray(dayRecords) ? dayRecords : [];
  const endings = Array.isArray(worldNightEndings) ? worldNightEndings : null;
  if (endings === null) return null;
  const passOutDays = new Set(
    endings
      .filter((ending) => isPlainObject(ending) && ending.cause === NIGHT_CAUSE_PASS_OUT)
      .map(worldEndingDayOfMonth)
      .filter(isFiniteNumber),
  );
  const days = [];
  for (const record of records) {
    if (!isPlainObject(record) || !Number.isInteger(record.day)) continue;
    if (passOutDays.has(nightEndedDayOfMonth(record))) days.push(record.day);
  }
  return Object.freeze(days);
}

/** The newest receipt any turn in a window carried, or `null` when none of them recorded one. */
function lastReceiptWithin(turns) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const receipt = turns[index]?.lastReceipt;
    if (isPlainObject(receipt)) return Object.freeze({ ...receipt });
  }
  return null;
}

/**
 * Every promise to go to bed in a run's turn stream that a receipt CONTRADICTS, each as a NAMED reading.
 *
 * <p>
 * THE LEDGER MAY ONLY CHARGE HER FOR A CLAIM A RECEIPT CONTRADICTS. A promise to go to bed is dialogue; the only receipt
 * that contradicts it is the engine taking the night (`engineTakenDays`, from `nightsTheEngineTook`). A promise on a
 * night her own `sleep` ended is a promise KEPT - the receipt says she went to bed - and nothing about it belongs in the
 * account. Measured 2026-11-23 (`round98`): 「进屋了，天都黑透了。我把纤维和石头塞进箱子，这就睡」 was published as
 * `sleep_promised_not_taken:1` while her `sleep` settled `day_advanced` on that same night, folded to the target
 * `own_bed`. The window is why a reading fired at all: her sleep was submitted in an assistant turn the harness had
 * already closed (`runAgentTurn` returned on the idle event, the pump then delivered a time milestone and she went on
 * working in the same session), so no turn record carried `sleepSubmitted: true` and the reader believed the window
 * instead of the receipt.
 * </p>
 *
 * <p>
 * The turn stream is the runner's own `sessionTurns`: the lines it PRESENTED for that turn, whether a `sleep` submission
 * happened during it from either dispatch channel, the clock she spoke them at, and the last receipt the run had when the
 * turn ended. `sleepSubmitted` is the DISPATCH half - it proves she acted even when the receipt has not arrived yet -
 * and it is the thing that went blind on `round98`, which is why it is no longer the only witness.
 * </p>
 *
 * <p>
 * FIVE ANSWERS, never three. `examined` is the population the reading ran over; `promiseTurns` says how many of those
 * turns delivered a commitment (kept or not, so a `0` here is a statement about the run, not about the list);
 * `turnsWithoutSleepRecord` counts turns whose submission record is absent, which is NOT MEASURED rather than "nothing
 * was submitted" - and a window holding one of those is not judged (`windowsNotMeasured`), so an unrecorded turn cannot
 * silently become the evidence that she never went to bed. `engineTakenNights` is `null` when nobody supplied the world's
 * endings (`not measured`) and a count otherwise, and `promisesWithoutAContradictingReceipt` says how many promises a
 * receipt left standing: a promise the account does not charge is a reading about her dialogue, and that number keeps it
 * visible instead of dropping it.
 * </p>
 *
 * <p>
 * A READING NAMES THE GAP, NOT JUST THE WORD: `promisedAtMs` is the moment the player was shown the promise, from the
 * presentation piece's own clock, and `lastReceipt` is the last thing she actually did by the end of the window (the
 * newest dispatch record the run had - flat or program), so a reader can see what happened between the two instead of
 * taking "she did not" on the strength of a sentence.
 * </p>
 */
export function sleepPromisesNotTaken({ turns, withinTurns = SLEEP_PROMISE_TURNS, engineTakenDays = null } = {}) {
  const stream = Array.isArray(turns) ? turns : [];
  const window = Number.isInteger(withinTurns) && withinTurns > 0 ? withinTurns : SLEEP_PROMISE_TURNS;
  const engineTaken = Array.isArray(engineTakenDays) ? new Set(engineTakenDays.filter(Number.isInteger)) : null;
  const readings = [];
  let promiseTurns = 0;
  let turnsWithoutSleepRecord = 0;
  let windowsNotMeasured = 0;
  let promisesWithoutAContradictingReceipt = 0;
  for (const [index, turn] of stream.entries()) {
    if (typeof turn?.sleepSubmitted !== "boolean") {
      turnsWithoutSleepRecord += 1;
      continue;
    }
    const promise = sleepPromiseIn(turn?.spokenLines);
    if (promise === null) continue;
    promiseTurns += 1;
    const ahead = stream.slice(index, index + window);
    if (ahead.some((entry) => typeof entry?.sleepSubmitted !== "boolean")) {
      windowsNotMeasured += 1;
      continue;
    }
    if (ahead.some((entry) => entry.sleepSubmitted === true)) continue;
    // THE RECEIPT DECIDES, and a promise no receipt contradicts is dialogue: nothing was supplied to contradict it
    // (`not measured`), or the night it promised was not one the engine took.
    if (engineTaken === null || !Number.isInteger(turn?.day) || !engineTaken.has(turn.day)) {
      promisesWithoutAContradictingReceipt += 1;
      continue;
    }
    const number = index + 1;
    const spokenAt = Array.isArray(turn?.spokenAtMs) ? turn.spokenAtMs[promise.index] : undefined;
    readings.push(
      Object.freeze({
        day: turn.day,
        turn: number,
        phrase: promise.phrase,
        utterance: promise.line,
        // WHEN SHE SAID IT, on the run's own clock, from the presentation piece the player was shown.
        promisedAtMs: isFiniteNumber(spokenAt) ? spokenAt : null,
        // AND WHAT SHE WAS DOING INSTEAD, up to the end of the window: the newest dispatch record the turn stream holds.
        lastReceipt: lastReceiptWithin(ahead),
        // The spelling a reader greps for and a verdict quotes: `<reading>:<turn>:<utterance>`.
        code: `${SLEEP_PROMISED_NOT_TAKEN}:${String(number)}:${promise.line}`,
      }),
    );
  }
  return Object.freeze({
    examined: stream.length,
    promiseTurns,
    turnsWithoutSleepRecord,
    windowsNotMeasured,
    engineTakenNights: engineTaken === null ? null : engineTaken.size,
    promisesWithoutAContradictingReceipt,
    readings: Object.freeze(readings),
  });
}

/**
 * WHAT SUPPORTS EACH NIGHT'S CLAIMED CAUSE, per cause, as the support gate reads it.
 *
 * A NIGHT THAT NAMES A CAUSE MUST NAME WHAT SUPPORTS IT. Measured 2026-11-20 (`round81`, day 1): `MULTIDAY_NIGHT
 * {"day":1,"cause":"sleep","bedTime":null}` beside a `day_advanced` receipt carrying
 * `entered_via=native_sleep_prompt`. `cause: sleep` with no hour reads as "she slept, at some point", and nothing
 * distinguishes "the native prompt published no clock" from "the harness failed to read one". The night record
 * therefore either carries the reading it was decided on (`bedTime` + `bedTimeSource`, naming which observation
 * produced the hour) or says why it has none (`bedTimeAbsent`) - and a claim with neither is BARE.
 *
 * THE POPULATION IS THE DECLARED CAUSES (`NIGHT_CAUSES`), not a list kept here, and a cause a record carries that is
 * not declared is bare by construction: this ledger does not know what would support it. The reading reports the causes
 * the records actually claim, so `supported` and `bare` partition `causes` and neither is printed without the other.
 */
export function nightCauseSupport(dayRecords) {
  const records = Array.isArray(dayRecords) ? dayRecords : [];
  const claims = [];
  for (const [index, record] of records.entries()) {
    if (!isPlainObject(record)) continue;
    const cause = typeof record.cause === "string" && record.cause.length > 0 ? record.cause : null;
    // A night that names NO cause is not in this gate's population: `night_mechanism_unobserved` is where an
    // unattributed crossing is judged, and it is a different question.
    if (cause === null) continue;
    const reading =
      Number.isInteger(record.bedTime) && typeof record.bedTimeSource === "string" && record.bedTimeSource.length > 0;
    const stated =
      record.bedTime === null && typeof record.bedTimeAbsent === "string" && record.bedTimeAbsent.length > 0;
    // WHICH support a claim has, and never a nested ternary: a reconciled night STATES its absence rather than carrying
    // an hour nobody could have read, and a cause this ledger has not declared is bare whatever the record says.
    let support = "bare";
    if (NIGHT_CAUSES.includes(cause) && reading) support = "reading";
    else if (NIGHT_CAUSES.includes(cause) && stated) support = "stated_absence";
    claims.push(
      Object.freeze({
        where: `dayRecords[${String(index)}]`,
        cause,
        declared: NIGHT_CAUSES.includes(cause),
        supported: support !== "bare",
        support,
        bedTime: Number.isInteger(record.bedTime) ? record.bedTime : null,
        bedTimeSource: typeof record.bedTimeSource === "string" ? record.bedTimeSource : null,
        bedTimeAbsent: typeof record.bedTimeAbsent === "string" ? record.bedTimeAbsent : null,
      }),
    );
  }
  const byCause = [];
  for (const cause of [...new Set(claims.map((claim) => claim.cause))].sort()) {
    const forCause = claims.filter((claim) => claim.cause === cause);
    byCause.push(
      Object.freeze({
        cause,
        claims: forCause.length,
        supported: forCause.filter((claim) => claim.supported).length,
        bare: forCause.filter((claim) => !claim.supported).length,
      }),
    );
  }
  return Object.freeze({
    declared: NIGHT_CAUSES,
    examined: claims.length,
    causes: byCause.length,
    supported: byCause.filter((entry) => entry.bare === 0).length,
    bare: byCause.filter((entry) => entry.bare > 0).length,
    byCause: Object.freeze(byCause),
    claims: Object.freeze(claims),
  });
}

/** The one line the support gate is read off: `causes C · supported S · bare B`. */
export function nightCauseSupportLine(support) {
  const count = (field) => (support === null || support === undefined ? "not_measured" : String(support[field]));
  return `causes ${count("causes")} · supported ${count("supported")} · bare ${count("bare")}`;
}

/**
 * Judge one run's day records against the baseline's rules. Every rule can fail on its own and names
 * itself, so a red result says which single-game fact was missing instead of "multi-day timed out".
 *
 * `sleepPromises` is the run's own turn-stream reading (`sleepPromisesNotTaken().readings`), or `null` when nobody
 * measured it. It is an INPUT and never a second judgement: a night the engine took is still counted as a pass-out -
 * that is the consequence - and the promise, when there is one, is named as the cause of it, ahead of the settlement
 * menu that never came because the night ended before she went to bed. `null` is `not_measured` and says so on the
 * reading; an empty list is the measurement answering "no promise was delivered".
 */
export function assessMultiDayBaseline({
  dayRecords,
  daysRequested = null,
  worldDayStarts = null,
  worldNightEndings = null,
  sleepPromises = null,
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

  // A NIGHT THAT NAMES A CAUSE MUST NAME WHAT SUPPORTS IT, judged before the rules that read the night's own
  // witnesses: `cause: sleep` with a bare `bedTime: null` is a claim about her night with nothing behind it, and the
  // failure names the CAUSE (`a_night_that_names_a_cause_names_what_supports_it:sleep`).
  const causeSupport = nightCauseSupport(dayRecords);
  for (const claim of causeSupport.claims) {
    if (claim.supported) continue;
    violations.push(violation(`a_night_that_names_a_cause_names_what_supports_it:${claim.cause}`, claim.where));
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
  // WHICH NIGHT EACH `day_advanced` RECEIPT NAMES, computed once and read by every rule below that needs to know
  // whether a night has a receipt at all. `null` when nobody supplied the facts: a pairing computed against no
  // population is not a pairing, and `not_measured` is not `nothing was paired`.
  const nightReceipts =
    worldEndings === null ? null : nightReceiptPairings({ dayRecords, worldNightEndings: worldEndings });

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
  // WHAT THE RUN'S OWN TURNS SAID, when the caller measured it: `null` is NOT MEASURED, and every entry beside it names
  // the night the engine had to end and what she promised instead. Published per pass-out night so a reader cannot see
  // the consequence (`pass_out`) without the cause when one was measured, and cannot read "nobody promised" where the
  // answer is "nobody looked".
  const promises = Array.isArray(sleepPromises)
    ? sleepPromises.filter((entry) => isPlainObject(entry) && typeof entry.code === "string")
    : null;
  const passOutCauses = [];
  for (const [index, record] of dayRecords.entries()) {
    const where = `dayRecords[${String(index)}]`;
    if (!isPlainObject(record)) {
      violations.push(violation("day_record_not_object", where));
      continue;
    }
    // THE DAY THIS NIGHT ENDED ON, AND THE WORLD'S FACT FOR IT - both found BEFORE the night is classified: a night
    // nobody watched has no receipt and no calendar inside the record, and the fact is its only witness. The day comes
    // from the record's OWN calendar (`nightEndedDayOfMonth`), never from whichever receipt the record happens to hold.
    const endedDayOfMonth = nightEndedDayOfMonth(record);
    const worldEndingForThisNight =
      worldEndings === null || endedDayOfMonth === null
        ? undefined
        : worldEndings.find((entry) => worldEndingDayOfMonth(entry) === endedDayOfMonth);
    // A RECEIPT IS EVIDENCE ABOUT THE NIGHT ITS OWN DAYS NAME, NOT ABOUT THE RECORD IT SITS ON.
    //
    // Measured `round80`: the first night's `day_advanced` receipt is minted 18-122 ms after the `day_started` of the day
    // it opened, so it was still the freshest receipt on the SECOND night's record. Judged as that record's own receipt,
    // its `day_after=5` contradicted the record's calendar (day 7) and the assessment called a correct night
    // `night_world_calendar_mismatch`. The pairing says which record the receipt names; when it names another one and
    // THIS record has a witness of its own, the receipt is set aside rather than obeyed - and when it does not, it stays,
    // because dropping the only witness would turn a contradiction into a missing terminal.
    const filedReceipt = crossingReceiptOf(record);
    const filedNight =
      filedReceipt === null
        ? null
        : (nightReceipts?.entries.find((entry) => entry.day === filedReceipt.dayBefore) ?? null);
    const filedElsewhere = filedNight !== null && !filedNight.namedBy.includes(index);
    const witnessedOtherwise = calendarCrossed(record.after) === true || worldEndingForThisNight !== undefined;
    const night = classifyNight({
      terminal: filedElsewhere && witnessedOtherwise ? null : record.terminal,
      after: record.after,
      worldEnding: worldEndingForThisNight ?? null,
    });
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
    // `sleep_unsettled` IS A LIFECYCLE RECEIPT THAT DID NOT CARRY THE CROSSING. A `sleepReceipt` whose reason IS the
    // crossing is this night's crossing claim, and reading it as the unsettled witness turns a settled night into a
    // disagreement - measured `round80`, where the runner copies the crossing receipt onto both fields.
    const sleepEnteredVia =
      sleepReceipt === null || sleepReceipt.reasonCode === CROSSING_OUTCOME.reasonCode
        ? null
        : parseReceiptEvidence(sleepReceipt.evidence).entered_via;
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
    const worldEnding = worldEndingForThisNight;
    if (worldEnding !== undefined) recordedEndedDays.add(worldEndingDayOfMonth(worldEnding));
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
    if (cause === NIGHT_CAUSE_PASS_OUT) {
      passOutNights += 1;
      // THE CAUSE, NAMED BEFORE THE CONSEQUENCES IT PRODUCED.
      //
      // `pass_out` says the ENGINE ended the night, which is what happened and not why: she was passed out because she
      // never went to bed. Measured 2026-11-13 (`round47`): entered `FarmHouse:3,11` at 22:00, said 「就睡」 and 「这就躺平」,
      // submitted `sleep` zero times in fifty-nine turns, and the run's own account reported the pass-out - while the
      // only rule that fired on that night was `first_night_shipping_menu_never_dismissed`, a menu she never reached
      // because the engine took the night first. The promise is pushed HERE, before the menu rules below, so the night's
      // cause is the first thing the assessment says about it rather than the settlement it never got to.
      const promise =
        promises === null
          ? null
          : (promises.find((entry) => Number.isInteger(record.day) && entry.day === record.day) ?? null);
      if (promise !== null) violations.push(violation(promise.code, `${where}.cause`));
      passOutCauses.push(
        Object.freeze({
          night: index + 1,
          day: Number.isInteger(record.day) ? record.day : null,
          code: promise?.code ?? null,
          reason:
            promise !== null ? SLEEP_PROMISED_NOT_TAKEN : promises === null ? "not_measured" : "no_promise_delivered",
        }),
      );
    }
    // `sleep` is a claim that the COMPANION's own `advance_day` crossed the night, and only the lifecycle receipt that
    // `advance_day` starts can show it. A record claiming one while the ONLY witness is the calendar (no receipt at all,
    // so no lifecycle existed) is stating an event nobody observed - which is exactly the shape that read as "the
    // companion slept" for two nights the engine had taken (measured 2026-10-30). `pass_out` needs no such proof: the
    // runner's own observation of the hold is a witness, and the engine taking the night needs none, as recorded.
    //
    // `sleep_unsettled` is NOT this claim: it is derived from a receipt, so reaching it means the receipt is in hand.
    //
    // AND THE RECEIPT IS THE RUN'S, NOT THE RECORD'S: a receipt filed on the wrong day still proves the companion's own
    // `advance_day` crossed the night it names, so the rule asks the PAIRING whether this night has one. Without that,
    // `round80`'s first night - whose receipt was filed on the second record - was called a sleep with no receipt while
    // the receipt sat one record away. What the rule still refuses is a night NO receipt in the run names.
    const receiptNamesThisNight =
      nightReceipts === null
        ? filedReceipt !== null && !filedElsewhere
        : nightReceipts.entries.some((entry) => entry.endedDayOfMonth === endedDayOfMonth);
    if (cause === NIGHT_CAUSE_SLEEP && night.witness === "calendar" && !receiptNamesThisNight) {
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
    const witnessedWithoutALifecycle = night.witness === "calendar" || night.witness === "world";
    if (!witnessedWithoutALifecycle && night.facts.saved_observed !== "true") {
      violations.push(violation("night_saved_edge_not_observed", `${where}.terminal.evidence.saved_observed`));
    }
    if (!witnessedWithoutALifecycle && night.facts.day_started_observed !== "true") {
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
    // a loop.
    //
    // WHETHER A TURN FOLLOWED THE NIGHT IS A FACT ABOUT THE RECORD, NOT ITS POSITION. `isLast` is a positional identity -
    // the same shape as a dedupe keyed on line number - and it stopped holding the moment `reconcileDaysWithTheWorld`
    // appended the world's own nights after the loop's records: measured `round80`, the record that really is the closing
    // night became index 2 of 4, and the assertion fired on a night whose next day lived 8.9 s and was never given a turn.
    // So a record that states no turn followed it (`nextDayIssued: false`, which is what the reconciled records say) is
    // NOT MEASURED wherever it sits, and the loop's own records - whose following day was always played, and whose empty
    // list therefore means the day produced nothing - keep the array-end exemption they had.
    const nextDayIssued = record.nextDayIssued ?? index !== dayRecords.length - 1;
    if (nextDayIssued) {
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
  //
  // THE DAY IS A `dayOfMonth`, THE SAME NUMBER THE RECORDS CARRY. It used to print the fact's own `TotalDays`, so a
  // reader comparing `a_night_the_world_had_is_not_missing_from_the_record:pass_out:6` against a record whose night ended
  // on day 6 of the month was looking at two different bases - the engine's own count of days played, and the calendar.
  // `round76`'s `worldNightEndings: [{ day: 6 }]` was a pass-out on day 7 of the month.
  //
  // THE GATE'S POPULATION IS EVERY WAY A DAY CAN END - a `night_ended_*` fact, a `sleep` receipt whose reason is
  // `day_advanced`, and any cause the Mod mints that this ledger has not met - and it is printed with all four numbers,
  // because `0 missing` beside `examined 3` is a reading and `0 missing` alone is not.
  //
  // THE THIRD NIGHT OF `round77` IS WHY THE SECOND SPELLING IS IN IT. That run's three nights were all her own sleep: its
  // timeline held three `day_started` facts and three `day_advanced` receipts, and not one `night_ended_*` fact - so a
  // population made of `night_ended_*` alone was EMPTY (`examined 0`), `missing 0` agreed with itself, and the closing
  // day's night belonged to no record at all.
  let worldEndingsExamined = null;
  let worldEndingsRecorded = null;
  for (const ending of worldEndings ?? []) {
    const day = worldEndingDayOfMonth(ending);
    if (day !== null && recordedEndedDays.has(day)) continue;
    if (ending.cause === NIGHT_CAUSE_PASS_OUT) passOutNights += 1;
    violations.push(
      violation(
        `a_night_the_world_had_is_not_missing_from_the_record:${ending.cause}:${String(day)}`,
        "worldNightEndings",
      ),
    );
  }
  if (worldEndings !== null) {
    worldEndingsExamined = worldEndings.length;
    worldEndingsRecorded = worldEndings.filter((ending) => {
      const day = worldEndingDayOfMonth(ending);
      return day !== null && recordedEndedDays.has(day);
    }).length;
  }
  // EVERY `day_advanced` RECEIPT IS PAIRED BY ITS OWN DAY, OR THE RUN SAYS WHICH ONE WAS NOT.
  //
  // THE POPULATION IS THE RECEIPTS IN THE RUN'S OWN FACTS - not a list kept here, and not the records: a receipt that
  // arrived after the event it explains cannot be attributed by sequence, so the pairing is keyed on the days the
  // receipt carries (`day_before` / `day_after`) and on the day each record's own calendar shows. A receipt with no
  // record is UNPAIRED (a night the ledger does not cover); one that lands on two records is DOUBLE-PAIRED, which is the
  // exact shape an arrival-order attribution produces. `round80` measured it: three receipts, and the first night's was
  // still filed on the second record because it was minted 18-122 ms after the `day_started` of the day it opened.
  //
  // BOTH NUMBERS ARE PRINTED, because `0 unpaired` beside `receipts 0` is what an empty population says, and a run with
  // no receipt at all is a fact about the run rather than a pairing that agreed with itself.
  if (nightReceipts !== null) {
    for (const entry of nightReceipts.entries) {
      if (entry.records.length === 1) continue;
      const days =
        entry.dayAfter === null ? `day${String(entry.day)}` : `${String(entry.day)}->${String(entry.dayAfter)}`;
      const landedOn =
        entry.records.length === 0
          ? "no_record"
          : entry.records.map((landed) => `dayRecords[${String(landed)}]`).join(",");
      violations.push(violation(`a_night_receipt_is_paired_by_its_own_day:${days}:${landedOn}`, "worldNightEndings"));
    }
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
    // Every promise to go to bed the run's own turn stream carried with no `sleep` behind it, and - per pass-out night -
    // which one of them the engine's pass-out was the consequence of. `sleepPromisesNotTaken: null` is NOT MEASURED.
    sleepPromisesNotTaken: promises === null ? null : Object.freeze([...promises]),
    passOutCauses: Object.freeze(passOutCauses),
    // WHICH NIGHT EACH `day_advanced` RECEIPT NAMES, and whether that night has a record. `null` is "nobody supplied the
    // facts" - not "nothing was paired", which is `examined 0` beside an empty run.
    nightReceipts:
      nightReceipts === null
        ? null
        : Object.freeze({
            examined: nightReceipts.examined,
            paired: nightReceipts.paired,
            unpaired: nightReceipts.unpaired,
            doublePaired: nightReceipts.doublePaired,
            entries: nightReceipts.entries,
          }),
    worldDaysCrossed,
    dayCountWitness,
    // EVERY WAY A DAY CAN END, AGAINST WHAT THE RECORD COVERS: the gate's own population, printed with the criterion so
    // `0 missing` never travels alone. `watched` is how many records the loop stood over; the difference is the nights
    // reconciled from the world's own ending, and it is a reading about the WATCH rather than about the run.
    //
    // `witnessedBy` names WHICH endings the population is made of (`sleep` = her own `day_advanced` receipt, `pass_out`
    // = the engine's own `night_ended_pass_out` fact, `other` = a cause the Mod mints that this ledger has not met
    // yet). A gate that counted three endings without saying which kind witnessed them could not tell a run she ended
    // every night of from one the engine took three times - the two are not the same reading, and the second is a
    // finding about her night routine.
    worldNights: Object.freeze({
      examined: worldEndingsExamined,
      recorded: worldEndingsRecorded,
      missing: worldEndingsExamined === null ? null : worldEndingsExamined - worldEndingsRecorded,
      watched: dayRecords.filter((record) => isPlainObject(record) && record.watched !== false).length,
      witnessedBy:
        worldEndings === null ? null : Object.freeze([...new Set(worldEndings.map((entry) => entry.cause))].sort()),
    }),
    // The attribution the judgement actually used, per night: the world's own endings when the caller could read them,
    // `null` when nobody supplied the facts (which is not "the world said nothing"). A reader must be able to see WHICH
    // night was called a pass-out, and `nightWitness` says whose answer that was.
    worldNightEndings: worldEndings === null ? null : Object.freeze([...worldEndings]),
    nightWitness: worldEndings === null ? "assessor" : "world",
    // WHAT SUPPORTS EACH NIGHT'S CAUSE, printed as `causes C · supported S · bare B` beside the nights it describes:
    // `bare 0` on its own would also be what an empty population prints.
    nightCauseSupport: causeSupport,
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
  "sleep_promised_not_taken",
  "night_raised_unclosable_menu",
  "level_up_menu_not_resolved",
  "level_up_branch_chosen_by_harness",
  "shipping_menu_not_dismissed",
  "next_day_produced_no_farm_work",
  "baseline_days_crossed_below_minimum",
  "day_count_disagrees_with_the_world",
  "night_cause_disagrees_with_the_world",
  "a_night_the_world_had_is_not_missing_from_the_record",
  "a_night_receipt_is_paired_by_its_own_day",
  "a_night_that_names_a_cause_names_what_supports_it",
  "first_night_shipping_menu_never_dismissed",
]);
