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
 */
export function classifyNight({ terminal, after }) {
  if (!isPlainObject(terminal)) {
    const observed = after?.dayOfMonth;
    const before = after?.dayBefore;
    if (isFiniteNumber(observed) && isFiniteNumber(before) && observed !== before) {
      return Object.freeze({
        advanced: true,
        witness: "calendar",
        reasonCode: null,
        facts: Object.freeze({ day_before: String(before), day_of_month: String(observed) }),
      });
    }
    return Object.freeze({ advanced: false, reasonCode: "night_terminal_missing", facts: Object.freeze({}) });
  }
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "day_advanced") {
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
 * Judge one run's day records against the baseline's rules. Every rule can fail on its own and names
 * itself, so a red result says which single-game fact was missing instead of "multi-day timed out".
 */
export function assessMultiDayBaseline({ dayRecords, daysRequested = null } = {}) {
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

  let daysCrossed = 0;
  let shoppingMenuDismissals = 0;
  // Nights the engine ended with a pass-out: reported next to the verdict, because it is how the day was
  // crossed rather than whether it was, and a run whose nights were all pass-outs must be readable as such.
  let passOutNights = 0;
  // Nights whose MECHANISM nobody recorded. Distinct from `passOutNights`, which is a description of a night that was
  // observed. This one is a verdict: a calendar witness says the day changed and cannot say how, and "nobody knows how"
  // must not read as a pass.
  let unobservedNights = 0;
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
    const cause = nightCause({
      enteredVia,
      sleepEnteredVia: typeof sleepEnteredVia === "string" ? sleepEnteredVia : null,
      recorded: record.cause ?? null,
    });
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
    violations: Object.freeze(violations),
    checkedRules: CHECKED_RULES,
  });
}

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
  "first_night_shipping_menu_never_dismissed",
]);
