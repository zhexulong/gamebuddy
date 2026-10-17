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
  parseReceiptEvidence,
  WAIT_ROLLOVER_MENUS,
} from "./multiday-baseline.mjs";

const EVIDENCE = (overrides = {}) =>
  [
    "state=passed",
    "reason=day_advanced",
    "topology=single_player",
    "entered_via=native_sleep_prompt",
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
  after: overrides.after ?? { dayOfMonth: 8, timeOfDay: 610, seasonIndex: 3 },
  menus: overrides.menus ?? [MENU()],
  nextDayAccomplishedActionIds: overrides.nextDayAccomplishedActionIds ?? ["harvest_crop", "cut_weeds"],
});

const codes = (result) => result.violations.map((entry) => entry.code);

test("a healthy two-day run passes, and the constants state the window", () => {
  const result = assessMultiDayBaseline({ dayRecords: [DAY({ day: 1 }), DAY({ day: 2 })], daysRequested: 2 });
  assert.deepEqual(result.violations, []);
  assert.equal(result.state, "passed");
  assert.equal(result.daysCrossed, 2);
  assert.equal(result.shoppingMenuDismissals, 2);
  assert.equal(MINIMUM_BASELINE_DAYS, 2);
  assert.equal(MAXIMUM_BASELINE_DAYS, 3);
  assert.deepEqual([...DISMISSIBLE_ROLLOVER_MENUS], ["ShippingMenu"]);
  assert.ok(WAIT_ROLLOVER_MENUS.includes("SaveGameMenu"));
  assert.ok(result.checkedRules.length > 12);
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
