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
 *     this a loop rather than one rollover.
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

/** Does the calendar advanced by this night follow from the totals the same receipt reported? */
export function classifyNight({ terminal, after }) {
  if (!isPlainObject(terminal)) {
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
  for (const [index, record] of dayRecords.entries()) {
    const where = `dayRecords[${String(index)}]`;
    if (!isPlainObject(record)) {
      violations.push(violation("day_record_not_object", where));
      continue;
    }
    const night = classifyNight({ terminal: record.terminal, after: record.after });
    if (!night.advanced) {
      violations.push(violation(night.reasonCode ?? "night_not_advanced", `${where}.night`));
      continue;
    }
    daysCrossed += 1;

    // Scope, enforced rather than assumed: this corpus proves consecutive days inside one season, with no
    // festival and no profession milestone. A night that left that window is a BLOCKED result, because the
    // verdict would otherwise read as covering a day the run never actually held.
    const outsideScope = nightOutsideBaselineScope(
      night.dayBefore === undefined ? night : { ...night, seasonIndex: seasonIndexFor(record.after) },
    );
    if (outsideScope !== null) violations.push(violation(outsideScope, `${where}.night`));

    // The Mod's own night facts. `saving_observed` is not required (a dismissed menu skips the
    // menu-owned save), but the two edges that DECIDE the terminal are.
    if (night.facts.saved_observed !== "true") {
      violations.push(violation("night_saved_edge_not_observed", `${where}.evidence.saved_observed`));
    }
    if (night.facts.day_started_observed !== "true") {
      violations.push(violation("night_day_started_edge_not_observed", `${where}.evidence.day_started_observed`));
    }
    // A claim of a save is only believable if the save boundary was ever entered. The lifecycle's own evidence now
    // distinguishes "a save was observed" from "the save-boundary budget expired and the transition was taken
    // anyway", because the two produce the same phase sequence (measured 2026-10-17/18: run g28 moved
    // `AwaitingSave -> AwaitingDayStart` exactly 300 frames after entering it - the budget, not a save - while
    // `is_saving=false` for the whole run).
    if (night.facts.save_boundary_not_observed === "true" && night.facts.saved_observed === "true") {
      violations.push(violation("night_claims_a_save_without_entering_the_save_boundary", `${where}.evidence`));
    }

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
      if (menu.dismissReceipt?.reasonCode !== "modal_dismissed" || menu.dismissReceipt?.state !== "succeeded") {
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
    violations: Object.freeze(violations),
    checkedRules: CHECKED_RULES,
  });
}

const CHECKED_RULES = Object.freeze([
  "baseline_window_out_of_range",
  "day_record_not_object",
  "night_terminal_missing",
  "night_not_advanced",
  "night_totals_missing",
  "night_totals_did_not_advance",
  "night_world_calendar_unobserved",
  "night_world_calendar_mismatch",
  "night_saved_edge_not_observed",
  "night_claims_a_save_without_entering_the_save_boundary",
  "night_day_started_edge_not_observed",
  "night_raised_unclosable_menu",
  "level_up_menu_not_resolved",
  "level_up_branch_chosen_by_harness",
  "shipping_menu_not_dismissed",
  "next_day_produced_no_farm_work",
  "baseline_days_crossed_below_minimum",
  "first_night_shipping_menu_never_dismissed",
]);
