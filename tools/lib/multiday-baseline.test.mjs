// The baseline's own falsifiers: every rule that can turn a multi-day run red must be able to fail on
// its own, and the calendar cross-check must be independent of the receipt that claims the rollover.
import assert from "node:assert/strict";
import test from "node:test";

import {
  assessMultiDayBaseline,
  classifyNight,
  dayOfMonthForTotalDays,
  DISMISSIBLE_ROLLOVER_MENUS,
  MAXIMUM_BASELINE_DAYS,
  MINIMUM_BASELINE_DAYS,
  nightCause,
  parseReceiptEvidence,
  WAIT_ROLLOVER_MENUS,
} from "./multiday-baseline.mjs";

const EVIDENCE = (overrides = {}) =>
  [
    "state=passed",
    "reason=day_advanced",
    "topology=single_player",
    `entered_via=${overrides.enteredVia ?? "native_sleep_prompt"}`,
    `saving_observed=${overrides.savingObserved ?? "true"}`,
    `saved_observed=${overrides.savedObserved ?? "true"}`,
    `day_started_observed=${overrides.dayStartedObserved ?? "true"}`,
    `day_before=${overrides.dayBefore ?? 6}`,
    `days_before=${overrides.daysBefore ?? 6}`,
    `day_after=${overrides.dayAfter ?? 7}`,
    `days_after=${overrides.daysAfter ?? 7}`,
  ].join(";");

const TERMINAL = (overrides = {}) => ({
  requestId: "req-night",
  state: overrides.state ?? "succeeded",
  reasonCode: overrides.reasonCode ?? "day_advanced",
  evidence: overrides.evidence ?? EVIDENCE(),
});

const MENU = (overrides = {}) => ({
  menuType: overrides.menuType ?? "ShippingMenu",
  decision: overrides.decision ?? "dismiss",
  dismissReceipt: overrides.dismissReceipt ?? { state: "succeeded", reasonCode: "modal_dismissed" },
  dismissReasonCode: overrides.dismissReasonCode ?? null,
  // The level-up path's own fields, carried through when a case sets them.
  respondReceipt: overrides.respondReceipt ?? null,
  respondReasonCode: overrides.respondReasonCode ?? null,
  respondChoice: overrides.respondChoice ?? null,
});

/** One day record of a healthy run: night crossed, the settlement menu closed by the product. */
const DAY = (overrides = {}) => ({
  day: overrides.day ?? 1,
  terminal: overrides.terminal === null ? null : TERMINAL(overrides.terminal),
  after: overrides.after ?? { dayOfMonth: 8, timeOfDay: 610, seasonIndex: 0 },
  menus: overrides.menus ?? [MENU()],
  // How the night ended, as the loop records it: the companion's own sleep, or the engine's 2:00 AM pass-out.
  cause: overrides.cause ?? "sleep",
  nextDayAccomplishedActionIds: overrides.nextDayAccomplishedActionIds ?? ["harvest_crop", "cut_weeds"],
});

const codes = (result) => result.violations.map((entry) => entry.code);

/** A night the ENGINE took: no `advance_day`, no lifecycle, only the calendar as the witness. */
const ENGINE_TAKEN_NIGHT = (overrides = {}) => ({
  ...DAY({ day: overrides.day ?? 1, terminal: null, after: { dayBefore: 6, dayOfMonth: 7, timeOfDay: 600 } }),
  cause: overrides.cause ?? "pass_out",
});

test("a night witnessed only by the calendar does not demand lifecycle edges it never had", () => {
  // MEASURED 2026-10-30 (`round8`): both nights were the engine's 02:00 pass-out - ZERO `advance_day` receipts in the
  // whole run - so no `SleepAndAdvanceDayLifecycle` existed to publish `saved_observed` or `day_started_observed`.
  // `classifyNight`'s calendar branch returns exactly `{day_before, day_of_month}` and can never return them, so these
  // two gates fired on every calendar night while the run's own timeline carried `lifecycle saving` twice and
  // `day_started_day_5`/`day_started_day_6` as world facts. The edges existed; the witness does not read them.
  const calendarNight = DAY({
    day: 1,
    terminal: null,
    after: { dayOfMonth: 8, dayBefore: 7, timeOfDay: 610, seasonIndex: 0 },
  });
  const result = assessMultiDayBaseline({
    dayRecords: [calendarNight, DAY({ day: 2 })],
    daysRequested: MINIMUM_BASELINE_DAYS,
  });
  assert.ok(
    !codes(result).includes("night_saved_edge_not_observed"),
    `a calendar night has no save edge to observe: ${codes(result).join(",")}`,
  );
  assert.ok(!codes(result).includes("night_day_started_edge_not_observed"));
  // The controls: a night with a RECEIPT but a missing edge must still be caught, or this exemption would have
  // disabled the gates instead of scoping them.
  const receiptMissingSave = assessMultiDayBaseline({
    dayRecords: [DAY({ day: 1, terminal: { evidence: EVIDENCE({ savedObserved: "false" }) } }), DAY({ day: 2 })],
    daysRequested: MINIMUM_BASELINE_DAYS,
  });
  assert.ok(codes(receiptMissingSave).includes("night_saved_edge_not_observed"));
});

test("a healthy two-day run passes, and the constants state the window", () => {
  const result = assessMultiDayBaseline({ dayRecords: [DAY({ day: 1 }), DAY({ day: 2 })], daysRequested: 2 });
  assert.deepEqual(result.violations, []);
  assert.equal(result.state, "passed");
  assert.equal(result.daysCrossed, 2);
  assert.equal(result.shoppingMenuDismissals, 2);
  assert.equal(result.passOutNights, 0);
  assert.equal(MINIMUM_BASELINE_DAYS, 2);
  assert.equal(MAXIMUM_BASELINE_DAYS, 3);
  assert.deepEqual([...DISMISSIBLE_ROLLOVER_MENUS], ["ShippingMenu"]);
  assert.ok(WAIT_ROLLOVER_MENUS.includes("SaveGameMenu"));
  assert.ok(result.checkedRules.length > 12);
});

test("a night the engine ended by a pass-out is a crossed night, reported by its cause", () => {
  // A 2:00 AM pass-out is normal play: `Game1.PassOutNewDay()` calls `NewDay(0f)` itself, so the calendar
  // crosses exactly as it does after a sleep and the receipt says `entered_via=native_pass_out`. The baseline
  // reports HOW the night ended and must not turn that into a verdict about whether the run crossed.
  const passedOut = assessMultiDayBaseline({
    dayRecords: [
      DAY({
        cause: "pass_out",
        terminal: {
          state: "succeeded",
          reasonCode: "day_advanced",
          evidence: EVIDENCE({ enteredVia: "native_pass_out" }),
        },
      }),
      DAY({ day: 2 }),
    ],
    daysRequested: 2,
  });
  assert.deepEqual(codes(passedOut), []);
  assert.equal(passedOut.state, "passed");
  assert.equal(passedOut.passOutNights, 1);
  // What the baseline still asks of that night is the night's own facts - a pass-out does not excuse a
  // missing save edge. The cause is a description, never a waiver.
  const unresolved = assessMultiDayBaseline({
    dayRecords: [
      DAY({
        cause: "pass_out",
        terminal: {
          state: "blocked",
          reasonCode: "day_start_not_observed",
          evidence: EVIDENCE({ enteredVia: "native_pass_out" }),
        },
      }),
      DAY({ day: 2 }),
    ],
    daysRequested: 2,
  });
  assert.ok(codes(unresolved).some((code) => code.startsWith("night_not_advanced")));
  assert.equal(unresolved.passOutNights, 0, "a night that did not cross is not counted as a pass-out crossing");
});

test("the night's own receipt says how it ended even when the record does not", () => {
  // The Mod mints `entered_via` on the night's terminal, so the gate does not depend on the runner remembering to
  // copy the cause onto the record: a night the receipt names as a pass-out is counted as one either way.
  const fromReceipt = assessMultiDayBaseline({
    dayRecords: [
      {
        ...DAY({
          day: 1,
          terminal: {
            state: "succeeded",
            reasonCode: "day_advanced",
            evidence: EVIDENCE({ enteredVia: "native_pass_out" }),
          },
        }),
        // No runner-side cause at all: the receipt is the authority.
        cause: undefined,
      },
      DAY({ day: 2 }),
    ],
    daysRequested: 2,
  });
  assert.deepEqual(codes(fromReceipt), []);
  assert.equal(fromReceipt.passOutNights, 1);
});

test("a night that did not cross reds the run, and says why", () => {
  const notAdvanced = assessMultiDayBaseline({
    dayRecords: [DAY({ terminal: { state: "blocked", reasonCode: "day_start_not_observed" } }), DAY({ day: 2 })],
    daysRequested: 2,
  });
  assert.ok(codes(notAdvanced).some((code) => code.startsWith("night_not_advanced")));
  assert.equal(notAdvanced.state, "blocked");

  const missing = assessMultiDayBaseline({ dayRecords: [DAY({ terminal: null }), DAY({ day: 2 })], daysRequested: 2 });
  assert.ok(codes(missing).includes("night_terminal_missing"));
});

test("the receipt's totals must actually advance, and the world must agree with them", () => {
  const flat = assessMultiDayBaseline({
    dayRecords: [
      DAY({
        terminal: {
          state: "succeeded",
          reasonCode: "day_advanced",
          evidence: EVIDENCE({ dayBefore: 6, dayAfter: 6, daysBefore: 6, daysAfter: 6 }),
        },
      }),
      DAY({ day: 2 }),
    ],
    daysRequested: 2,
  });
  assert.ok(codes(flat).some((code) => code.startsWith("night_totals_did_not_advance")));

  // The world's own calendar is the independent half: a receipt claiming the rollover while the
  // calendar still reads the old day was the exact shape of the shipping-world defect.
  const disagreeing = assessMultiDayBaseline({
    dayRecords: [DAY({ after: { dayOfMonth: 6 } }), DAY({ day: 2 })],
    daysRequested: 2,
  });
  assert.ok(codes(disagreeing).some((code) => code.startsWith("night_world_calendar_mismatch")));

  const unobserved = assessMultiDayBaseline({ dayRecords: [DAY({ after: {} }), DAY({ day: 2 })], daysRequested: 2 });
  assert.ok(codes(unobserved).includes("night_world_calendar_unobserved"));
  assert.equal(dayOfMonthForTotalDays(7), 8);
  assert.equal(dayOfMonthForTotalDays(28), 1);
  assert.equal(dayOfMonthForTotalDays(-1), null);
});

test("a night the engine took alone is judged by its calendar, not by a lifecycle that never ran", () => {
  // `saved_observed` and `day_started_observed` are edges the SLEEP LIFECYCLE observed for the night it crossed:
  // SMAPI's `Saved` really arrived, and the new day really became playable. Both exist to prove the receipt's own
  // `day_advanced` was earned rather than taken from a counter that raced ahead of the save. So they belong to the
  // receipt that claimed the advance.
  //
  // A night the engine took by itself (`Game1.PassOutNewDay()` calls `NewDay(0f)` at 2:00 AM) has no receipt and no
  // lifecycle, so the question cannot be put to it at all - there is nobody who could have observed those edges. The
  // calendar is what witnesses that night, and `classifyNight` already refuses a night the calendar cannot show.
  // Measured 2026-10-30: two such nights, and both edges were reported missing on both - a false negative that fired
  // on every pass-out run.
  const result = assessMultiDayBaseline({
    dayRecords: [ENGINE_TAKEN_NIGHT(), DAY({ day: 2 })],
    daysRequested: 2,
  });
  assert.deepEqual(codes(result), [], `a pass-out night must not be red for edges no lifecycle could publish`);
  assert.equal(result.passOutNights, 1);

  // The falsifier for the relaxation: a night WITH a receipt is still asked for both edges, because a lifecycle ran
  // and a receipt that does not say what it observed is exactly what those rules exist to catch.
  const receiptWithoutEdges = assessMultiDayBaseline({
    dayRecords: [
      DAY({
        terminal: {
          state: "succeeded",
          reasonCode: "day_advanced",
          evidence: "state=passed;reason=day_advanced;day_before=6;days_before=6;day_after=7;days_after=7",
        },
      }),
      DAY({ day: 2 }),
    ],
    daysRequested: 2,
  });
  assert.ok(codes(receiptWithoutEdges).includes("night_saved_edge_not_observed"));
  assert.ok(codes(receiptWithoutEdges).includes("night_day_started_edge_not_observed"));
});

test("how a night ended is the witness that names it, and never a default", () => {
  // The runner records HOW each night ended. Measured 2026-10-30: two nights the engine passed the actor out on were
  // recorded `sleep`, because the record's cause was `passOutObserved ? "pass_out" : "sleep"` - a two-valued default
  // whose second value claims the companion slept whenever the pass-out had not been observed. Nothing observed the
  // pass-out on those nights either, so the claim was true of neither value, and the record said `sleep` anyway.
  const sleeping = TERMINAL({ evidence: EVIDENCE({ enteredVia: "native_sleep_prompt" }) });
  assert.equal(nightCause({ enteredVia: parseReceiptEvidence(sleeping.evidence).entered_via }), "sleep");
  assert.equal(
    nightCause({
      enteredVia: parseReceiptEvidence(TERMINAL({ evidence: EVIDENCE({ enteredVia: "native_pass_out" }) }).evidence)
        .entered_via,
    }),
    "pass_out",
  );
  // A night the engine took can have no receipt at all; the observation of its pass-out is then the only witness.
  assert.equal(nightCause({ passOutObserved: true }), "pass_out");
  // Nothing witnessed HOW it ended, so the night is neither called a sleep nor left unspoken: `engine` records that the
  // night was taken and the attribution was not observed.
  assert.equal(nightCause({}), "engine");
  // The receipt wins over the runner's own note, and a note cannot upgrade an unproven night into a sleep.
  assert.equal(nightCause({ enteredVia: "native_sleep_prompt", recorded: "pass_out" }), "sleep");
  assert.equal(nightCause({ recorded: "sleep" }), "sleep");
  // `engine` is a value in its own right and survives being written back through the record unread - so a re-judged run
  // does not silently promote it to a sleep on the next pass.
  assert.equal(nightCause({ recorded: "engine" }), "engine");
});

test("a record may not claim a sleep it has no receipt for", () => {
  // The rule that makes the contradiction unrepresentable: `sleep` says the companion's own `advance_day` crossed the
  // night, and only its lifecycle receipt can show that. A calendar-witnessed night that says `sleep` anyway is the
  // exact record shape that read as a sleep for two pass-out nights (measured 2026-10-30).
  const claimed = assessMultiDayBaseline({
    dayRecords: [ENGINE_TAKEN_NIGHT({ cause: "sleep" }), DAY({ day: 2 })],
    daysRequested: 2,
  });
  assert.ok(
    codes(claimed).includes("night_cause_claims_a_sleep_without_a_receipt"),
    `a sleep with no receipt must be refused; got ${JSON.stringify(codes(claimed))}`,
  );
  // An unproven night says `engine` and is not a violation: the crossing is a fact and only the attribution is missing.
  const unclaimed = assessMultiDayBaseline({
    dayRecords: [ENGINE_TAKEN_NIGHT({ cause: "engine" }), DAY({ day: 2 })],
    daysRequested: 2,
  });
  assert.deepEqual(codes(unclaimed), []);
});

test("the Mod's own night edges are required, not inferred", () => {
  const noSaved = assessMultiDayBaseline({
    dayRecords: [
      DAY({
        terminal: { state: "succeeded", reasonCode: "day_advanced", evidence: EVIDENCE({ savedObserved: "false" }) },
      }),
      DAY({ day: 2 }),
    ],
    daysRequested: 2,
  });
  assert.ok(codes(noSaved).includes("night_saved_edge_not_observed"));
  const noDayStarted = assessMultiDayBaseline({
    dayRecords: [
      DAY({
        terminal: {
          state: "succeeded",
          reasonCode: "day_advanced",
          evidence: EVIDENCE({ dayStartedObserved: "false" }),
        },
      }),
      DAY({ day: 2 }),
    ],
    daysRequested: 2,
  });
  assert.ok(codes(noDayStarted).includes("night_day_started_edge_not_observed"));
  // `saving_observed` alone is deliberately NOT required: a dismissed menu skips the menu-owned save.
  const noSaving = assessMultiDayBaseline({
    dayRecords: [
      DAY({
        terminal: { state: "succeeded", reasonCode: "day_advanced", evidence: EVIDENCE({ savingObserved: "false" }) },
      }),
      DAY({ day: 2 }),
    ],
    daysRequested: 2,
  });
  assert.deepEqual(codes(noSaving), []);
});

test("the settlement menu must be closed by the product, with its own receipt", () => {
  // The first-night menu is what holds the actor at the end of a night, so zero dismissals makes the
  // whole "a rollover does not stall" claim vacuous.
  const never = assessMultiDayBaseline({
    dayRecords: [DAY({ menus: [] }), DAY({ day: 2, menus: [] })],
    daysRequested: 2,
  });
  assert.ok(codes(never).includes("first_night_shipping_menu_never_dismissed"));

  const refused = assessMultiDayBaseline({
    dayRecords: [
      DAY({
        menus: [
          MENU({
            dismissReceipt: { state: "blocked", reasonCode: "modal_not_dismissible" },
            dismissReasonCode: "shipping_not_closed",
          }),
        ],
      }),
      DAY({ day: 2 }),
    ],
    daysRequested: 2,
  });
  assert.ok(codes(refused).some((code) => code.startsWith("shipping_menu_not_dismissed")));

  // A menu the product must NOT close stops the night by name instead of timing out.
  const unclosable = assessMultiDayBaseline({
    dayRecords: [
      DAY({ menus: [MENU({ menuType: "LetterViewerMenu", decision: "blocked" }), MENU()] }),
      DAY({ day: 2 }),
    ],
    daysRequested: 2,
  });
  assert.ok(codes(unclosable).includes("night_raised_unclosable_menu:LetterViewerMenu"));
});

test("a level-up menu is red unless the product resolved it, and never by a branch the harness picked", () => {
  // A rollover CAN raise a level-up menu. The baseline accepts it only with the product's own
  // `level_up_resolved` receipt, and only when the recorded choice is the one that takes no decision: a
  // milestone branch in the record would be the harness choosing the companion's growth path.
  const unresolved = assessMultiDayBaseline({
    dayRecords: [DAY({ menus: [MENU({ menuType: "LevelUpMenu", decision: "respond_level_up" })] }), DAY({ day: 2 })],
    daysRequested: 2,
  });
  assert.ok(codes(unresolved).some((code) => code.startsWith("level_up_menu_not_resolved")));

  const resolved = assessMultiDayBaseline({
    dayRecords: [
      DAY({
        menus: [
          MENU({
            menuType: "LevelUpMenu",
            decision: "respond_level_up",
            respondReceipt: { state: "succeeded", reasonCode: "level_up_resolved" },
            respondReasonCode: null,
            respondChoice: "confirm",
          }),
        ],
      }),
      DAY({ day: 2 }),
    ],
    daysRequested: 2,
  });
  assert.deepEqual(codes(resolved), []);

  const branched = assessMultiDayBaseline({
    dayRecords: [
      DAY({
        menus: [
          MENU({
            menuType: "LevelUpMenu",
            decision: "respond_level_up",
            respondReceipt: { state: "succeeded", reasonCode: "level_up_resolved" },
            respondReasonCode: null,
            respondChoice: "branch_a",
          }),
        ],
      }),
      DAY({ day: 2 }),
    ],
    daysRequested: 2,
  });
  assert.ok(codes(branched).includes("level_up_branch_chosen_by_harness:branch_a"));
});

test("the day after a night must still produce the companion's own farm work", () => {
  const idle = assessMultiDayBaseline({
    dayRecords: [DAY({ nextDayAccomplishedActionIds: [] }), DAY({ day: 2 })],
    daysRequested: 2,
  });
  assert.ok(codes(idle).includes("next_day_produced_no_farm_work"));
  // The LAST night has no following day inside the record, so it is not asserted.
  const lastIdle = assessMultiDayBaseline({
    dayRecords: [DAY({ day: 1 }), DAY({ day: 2, nextDayAccomplishedActionIds: [] })],
    daysRequested: 2,
  });
  assert.deepEqual(codes(lastIdle), []);
});

test("the window and the minimum are enforced, so a one-night run cannot claim the baseline", () => {
  const one = assessMultiDayBaseline({ dayRecords: [DAY()], daysRequested: 1 });
  assert.ok(codes(one).includes("baseline_window_out_of_range:1"));
  assert.ok(codes(one).includes("baseline_days_crossed_below_minimum:1"));
  const four = assessMultiDayBaseline({
    dayRecords: [DAY(), DAY({ day: 2 }), DAY({ day: 3 }), DAY({ day: 4 })],
    daysRequested: 4,
  });
  assert.ok(codes(four).includes("baseline_window_out_of_range:4"));
  assert.equal(assessMultiDayBaseline({ dayRecords: null }).state, "blocked");
  assert.ok(
    codes(assessMultiDayBaseline({ dayRecords: [null, DAY({ day: 2 })], daysRequested: 2 })).includes(
      "day_record_not_object",
    ),
  );
});

test("the evidence projection reads both live shapes the receipts carry", () => {
  assert.equal(parseReceiptEvidence("day_after=7;saved_observed=true").day_after, "7");
  assert.equal(parseReceiptEvidence({ detail: "day_after=7" }).day_after, "7");
  assert.deepEqual(parseReceiptEvidence(null), {});
  const viaObject = classifyNight({
    terminal: { state: "succeeded", reasonCode: "day_advanced", evidence: { detail: EVIDENCE() } },
    after: { dayOfMonth: 8 },
  });
  assert.equal(viaObject.advanced, true);
});

// After the shipping summary moved into the night lifecycle, no run could satisfy the baseline: it demanded a
// dismissal receipt the loop no longer produces, so every night was `shipping_menu_not_dismissed:no_receipt` while the
// menu had in fact been cleared. The baseline asks whether the summary was CLEARED, not who typed the receipt.
test("a summary cleared by the lifecycle counts as cleared", () => {
  const result = assessMultiDayBaseline({
    daysRequested: 2,
    dayRecords: [
      DAY({ menus: [{ menuType: "ShippingMenu", decision: "wait", clearedAt: 1234 }] }),
      DAY({ day: 2, menus: [{ menuType: "ShippingMenu", decision: "wait", clearedAt: 5678 }] }),
    ],
  });
  assert.equal(result.shoppingMenuDismissals, 2, `violations=${JSON.stringify(codes(result))}`);
});

test("a summary that was held and never cleared is still a violation", () => {
  // The property that must survive the relaxation: waiting is not itself evidence, and this is the case that would
  // catch a gate relaxed into uselessness.
  const result = assessMultiDayBaseline({
    daysRequested: 2,
    dayRecords: [DAY({ menus: [{ menuType: "ShippingMenu", decision: "wait" }] }), DAY({ day: 2, menus: [] })],
  });
  assert.ok(
    codes(result).some((code) => String(code).startsWith("shipping_menu_not_dismissed")),
    `an uncleared summary must be refused; got ${JSON.stringify(codes(result))}`,
  );
});
test("a night with no receipt still crosses when the calendar moved, and says which witness answered", () => {
  // `actionTrace` records only FLAT dispatches. Measured 2026-10-28 (`round5`): `dismiss_modal` succeeded at
  // 00:27:59, SMAPI logged "after save, starting spring 6 Y1" at 00:28:04, and the run was reported as
  // `night_never_started:actor_held_by_cutscene` because all 42 dispatches went through a Body Program and the
  // trace held no `advance_day`.
  //
  // The calendar is the witness a dispatch path cannot hide. Both directions are asserted, because a classifier
  // that answers `advanced: true` whenever the receipt is absent would pass the first half alone.
  const byCalendar = classifyNight({ terminal: null, after: { dayBefore: 5, dayOfMonth: 6 } });
  assert.equal(byCalendar.advanced, true, "a moved calendar is a crossed night");
  assert.equal(byCalendar.witness, "calendar");

  const unchanged = classifyNight({ terminal: null, after: { dayBefore: 5, dayOfMonth: 5 } });
  assert.equal(unchanged.advanced, false, "an unmoved calendar is not a crossing");
  assert.equal(unchanged.reasonCode, "night_terminal_missing");

  const unknown = classifyNight({ terminal: null, after: { dayOfMonth: 6 } });
  assert.equal(unknown.advanced, false, "a calendar with no before-value proves nothing");
});
