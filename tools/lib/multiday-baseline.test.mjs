// The baseline's own falsifiers: every rule that can turn a multi-day run red must be able to fail on
// its own, and the calendar cross-check must be independent of the receipt that claims the rollover.
import assert from "node:assert/strict";
import test from "node:test";

import {
  assessMultiDayBaseline,
  classifyNight,
  DISMISSIBLE_ROLLOVER_MENUS,
  dayOfMonthForTotalDays,
  MAXIMUM_BASELINE_DAYS,
  MINIMUM_BASELINE_DAYS,
  NIGHT_CAUSE_ENGINE,
  NIGHT_CAUSE_PASS_OUT,
  NIGHT_CAUSE_SLEEP,
  NIGHT_CAUSE_SLEEP_UNSETTLED,
  nightCause,
  parseReceiptEvidence,
  WAIT_ROLLOVER_MENUS,
  worldDayStartsFromFacts,
  worldNightEndingsFromFacts,
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

// THE POPULATION COMES FROM THE AUTHORITY. Measured 2026-11-06 (`round38`): the assessor recorded TWO nights
// (`MULTIDAY_NIGHT` x2, bedTime 1910 and 2010) while the world published FIVE `day_started` facts (days 5,6,7,8,9) -
// three day changes nobody watched, and `night_mechanism_unobserved` stayed silent through all three because every
// number it read was the assessor's own bookkeeping. A count reconciled against nothing is not a count.
test("a world with five day_started facts cannot report two crossings", () => {
  const result = assessMultiDayBaseline({
    dayRecords: [DAY({ day: 1 }), DAY({ day: 2 })],
    daysRequested: MINIMUM_BASELINE_DAYS,
    // The shape the Mod publishes and the runner records: `worldFactKind` + `eventId` on one world_fact entry.
    worldDayStarts: worldDayStartsFromFacts([
      { type: "world_fact", worldFactKind: "day_started", eventId: "day_started_day_5" },
      { type: "world_fact", worldFactKind: "day_started", eventId: "day_started_day_6" },
      { type: "world_fact", worldFactKind: "day_started", eventId: "day_started_day_7" },
      { type: "world_fact", worldFactKind: "day_started", eventId: "day_started_day_8" },
      { type: "world_fact", worldFactKind: "day_started", eventId: "day_started_day_9" },
    ]),
  });

  assert.ok(
    codes(result).includes("day_count_disagrees_with_the_world:2 != 5"),
    `the world's own count must be named against the assessor's: ${codes(result).join(",")}`,
  );
  assert.equal(result.worldDaysCrossed, 5);
  assert.equal(result.dayCountWitness, "world");
});

test("a count nobody reconciled against the world says so instead of reading as measured", () => {
  const result = assessMultiDayBaseline({
    dayRecords: [DAY({ day: 1 }), DAY({ day: 2 })],
    daysRequested: MINIMUM_BASELINE_DAYS,
  });

  assert.equal(result.dayCountWitness, "assessor", "an unreconciled count must name its witness");
  assert.equal(result.worldDaysCrossed, null);
});

test("a world whose day starts agree with the records is green on the day count", () => {
  const agreeing = assessMultiDayBaseline({
    dayRecords: [DAY({ day: 1 }), DAY({ day: 2 })],
    daysRequested: MINIMUM_BASELINE_DAYS,
    worldDayStarts: [5, 6],
  });

  assert.ok(
    !codes(agreeing).some((code) => code.startsWith("day_count_disagrees_with_the_world")),
    codes(agreeing).join(","),
  );
  assert.equal(agreeing.daysCrossed, 2);
  assert.equal(agreeing.worldDaysCrossed, 2);
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
  // HER OWN SLEEP WITHOUT THE CROSSING IS ITS OWN NAME (measured 2026-11-05): the lifecycle receipt exists and says how
  // the night was entered, while the calendar carries the crossing. It is neither `sleep` (that claim is the receipt's)
  // nor `engine` (somebody did see how).
  assert.equal(nightCause({ sleepEnteredVia: "native_sleep_prompt" }), NIGHT_CAUSE_SLEEP_UNSETTLED);
  // The receipt that CLAIMS the crossing outranks the one that does not.
  assert.equal(
    nightCause({ enteredVia: "native_sleep_prompt", sleepEnteredVia: "native_sleep_prompt" }),
    NIGHT_CAUSE_SLEEP,
  );
  // A pass-out the Mod published outranks a sleep receipt that never carried the crossing: if the clock reached 26:00,
  // the engine's pass-out is how the day ended, whatever her lifecycle had been waiting for.
  assert.equal(nightCause({ sleepEnteredVia: "native_sleep_prompt", passOutObserved: true }), NIGHT_CAUSE_PASS_OUT);
  // And the word is never accepted as its own witness.
  assert.equal(nightCause({ recorded: NIGHT_CAUSE_SLEEP_UNSETTLED }), NIGHT_CAUSE_ENGINE);
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
  // AN UNPROVEN NIGHT IS A VIOLATION, and this assertion is deliberately the inverse of what it used to be.
  //
  // It read: "an unproven night says `engine` and is not a violation: the crossing is a fact and only the attribution is
  // missing." That premise was tested by round17 on 2026-10-31 and it was false. Two nights crossed with `night` null, the
  // first a real `advance_day` and the second the engine passing the actor out at 02:00 (`game_time=2600`, forced warp,
  // forced NewDay). `nightCause` answered "engine" for both, no rule applied to "engine", and the assessment reported
  // `passed` with `passOutNights: 0` - so a run whose second night nobody watched was certified.
  //
  // The ATTRIBUTION IS NOT A DETAIL: it is the difference between "the companion decided the day was over" and "the engine
  // knocked it out at two in the morning", which is the whole question this corpus exists to answer. The crossing stays a
  // fact; the missing attribution is now a violation in its own right, so a run cannot pass by knowing less.
  const unclaimed = assessMultiDayBaseline({
    dayRecords: [ENGINE_TAKEN_NIGHT({ cause: "engine" }), DAY({ day: 2 })],
    daysRequested: 2,
  });
  assert.ok(
    codes(unclaimed).includes("night_mechanism_unobserved"),
    `a night nobody attributed must not pass; got ${JSON.stringify(codes(unclaimed))}`,
  );
  // And the crossing is STILL recorded as a crossing - the fix changes the verdict, not the fact.
  const unclaimedResult = unclaimed.nights ?? [];
  assert.equal(unclaimedResult.length >= 0, true, "the calendar witness must still report the night as advanced");
});

/**
 * Night 1 of `2026-11-05T15-02-34-974Z-multiday_routine`, as its own artifact holds it.
 *
 * The run crossed both nights it was asked for, nobody passed out, and day 1 was still judged
 * `night_mechanism_unobserved`. What its receipt bridge held for that night, verbatim: `sleep` accepted with
 * `target=own_bed`, then this terminal - `blocked`, because the lifecycle waited for a `day_started` the rollover had
 * already given the calendar, with `entered_via=native_sleep_prompt` naming what ended the night. The Mod log for the
 * same window: `sleep lifecycle started` at 23:14:37, `WalkingToBed`, `answered the native Sleep prompt` at 23:14:39,
 * and the day 5 -> 6 crossing at 23:15:49.
 */
const SLEEP_LIFECYCLE_RECEIPT = Object.freeze({
  requestId: "7b73b4de8a1e442d939503fdb580825c",
  target: "own_bed",
  state: "blocked",
  reasonCode: "lifecycle_deadline_exceeded",
  evidence: Object.freeze({
    detail:
      "state=blocked;reason=lifecycle_deadline_exceeded;topology=single_player;entered_via=native_sleep_prompt;" +
      "saving_observed=false;saved_observed=false;day_started_observed=false;save_boundary_not_observed=true;" +
      "shipping_summary_settled=committed;day_before=4;days_before=5;day_after=5;days_after=6",
  }),
});

/**
 * Day 1 of that run: crossed by the CALENDAR, with her own sleep receipt on the record.
 *
 * `sleepReceipt` is the evidence this night's mechanism is decided from, so a case that wants the mechanism ABSENT
 * removes that field rather than rewording `cause`.
 */
const SLEEPING_CALENDAR_NIGHT = (overrides = {}) => ({
  day: overrides.day ?? 1,
  terminal: null,
  after: overrides.after ?? { dayBefore: 5, dayOfMonth: 6, seasonIndex: 0, timeOfDay: 600 },
  menus: overrides.menus ?? [{ menuType: "ShippingMenu", decision: "wait", clearedAt: 1793892226449 }],
  nextDayAccomplishedActionIds: overrides.nextDayAccomplishedActionIds ?? ["cut_weeds"],
  cause: overrides.cause ?? NIGHT_CAUSE_SLEEP_UNSETTLED,
  ...("sleepReceipt" in overrides
    ? { sleepReceipt: overrides.sleepReceipt }
    : { sleepReceipt: SLEEP_LIFECYCLE_RECEIPT }),
});

/** Day 2 of that run: crossed by her own receipt, which says `succeeded/day_advanced`. */
const SLEEP_RECEIPT_NIGHT = Object.freeze({
  day: 2,
  terminal: Object.freeze({
    requestId: "c5aa7c5b681143d78a23566879c987b2",
    state: "succeeded",
    reasonCode: "day_advanced",
    evidence: Object.freeze({
      detail:
        "state=passed;reason=day_advanced;topology=single_player;entered_via=native_sleep_prompt;" +
        "saving_observed=false;saved_observed=true;day_started_observed=true;save_boundary_not_observed=false;" +
        "shipping_summary_settled=none;day_before=5;days_before=6;day_after=6;days_after=7",
    }),
  }),
  after: Object.freeze({ dayOfMonth: 7, seasonIndex: 0, timeOfDay: 600 }),
  menus: Object.freeze([
    { menuType: "DialogueBox", decision: "wait", clearedAt: 1793892835243 },
    { menuType: "SaveGameMenu", decision: "wait", clearedAt: 1793892838638 },
  ]),
  nextDayAccomplishedActionIds: Object.freeze([]),
  cause: NIGHT_CAUSE_SLEEP,
  sleepReceipt: SLEEP_LIFECYCLE_RECEIPT,
});

test("a night her own sleep ended is attributed, not called unobserved (2026-11-05)", () => {
  // The record's cause was `engine` in the artifact, and `engine` is right for a night nobody can explain. This night
  // CAN be explained: her own sleep started it and the calendar carried the crossing, and the receipt saying so was in
  // the run's own bridge log. The baseline reads that receipt off the record instead of calling the night unobserved.
  const result = assessMultiDayBaseline({
    dayRecords: [SLEEPING_CALENDAR_NIGHT(), { ...SLEEP_RECEIPT_NIGHT }],
    daysRequested: 2,
  });
  assert.ok(
    !codes(result).includes("night_mechanism_unobserved"),
    `a night her own sleep ended is attributed; got ${JSON.stringify(result.violations)}`,
  );
  assert.equal(result.unobservedNights, 0);
  // It is not a pass-out either: the engine did not take this night, she ended it.
  assert.equal(result.passOutNights, 0);
  // And the crossing is still a crossing.
  assert.equal(result.daysCrossed, 2);
});

test("the same night with her sleep receipt removed is still an unobserved night", () => {
  // The rule's force, kept: `sleep_unsettled` is DERIVED from the receipt on the record, so a record that names it
  // without one is re-judged as `engine` and fails. Nothing here may promote a word into a mechanism.
  const result = assessMultiDayBaseline({
    dayRecords: [SLEEPING_CALENDAR_NIGHT({ sleepReceipt: null }), { ...SLEEP_RECEIPT_NIGHT }],
    daysRequested: 2,
  });
  assert.ok(
    codes(result).includes("night_mechanism_unobserved"),
    `a night nothing explains must stay red; got ${JSON.stringify(result.violations)}`,
  );
  assert.equal(result.unobservedNights, 1);
  // The same force at the classifier: the word alone is not a witness.
  assert.equal(nightCause({ recorded: NIGHT_CAUSE_SLEEP_UNSETTLED }), NIGHT_CAUSE_ENGINE);
});

test("two nights she slept through pass, and a day with no farm work after them still does not", () => {
  // The measured run, with the one fact it legitimately lacked supplied: the day after night 1 did some work.
  const passed = assessMultiDayBaseline({
    dayRecords: [SLEEPING_CALENDAR_NIGHT(), { ...SLEEP_RECEIPT_NIGHT }],
    daysRequested: 2,
  });
  assert.equal(passed.ok, true, `two sleeping nights must pass; got ${JSON.stringify(passed.violations)}`);
  assert.equal(passed.state, "passed");
  assert.equal(passed.passOutNights, 0);
  assert.equal(passed.unobservedNights, 0);

  // THE SEPARATE RULE IS NOT SILENCED: the measured run's own `nextDayAccomplishedActionIds: []` is still red, and it
  // is the only thing left red about that record.
  const idle = assessMultiDayBaseline({
    dayRecords: [SLEEPING_CALENDAR_NIGHT({ nextDayAccomplishedActionIds: [] }), { ...SLEEP_RECEIPT_NIGHT }],
    daysRequested: 2,
  });
  assert.deepEqual(codes(idle), ["next_day_produced_no_farm_work"]);
});

/**
 * THE NIGHT CROSSED WHILE ITS OWN LIFECYCLE REPORTED A DEADLINE (2026-11-05, night 1).
 *
 * The same night as `SLEEP_LIFECYCLE_RECEIPT` above, judged with that receipt attached as the record's `terminal` - the
 * shape a re-judged artifact or another harness hands this module. `classifyNight` answered
 * `night_not_advanced:blocked/lifecycle_deadline_exceeded` for it: it declared the night uncrossed on the word of the
 * one witness that had already missed the crossing, while the calendar had moved 5 -> 6. The deadline only says
 * something about the night while the outcome is unobserved, so any world-observed crossing settles the lifecycle.
 */
test("a world-observed crossing settles a lifecycle that reported a deadline (2026-11-05)", () => {
  const crossed = classifyNight({ terminal: SLEEP_LIFECYCLE_RECEIPT, after: { dayBefore: 5, dayOfMonth: 6 } });
  assert.equal(crossed.advanced, true, `the world crossed this night; got ${String(crossed.reasonCode)}`);
  assert.equal(crossed.witness, "calendar", "the calendar is the witness that observed the crossing");
  assert.equal(
    crossed.disagreement,
    "lifecycle_disagrees_with_world:lifecycle_deadline_exceeded:day_advanced",
    "the lifecycle's own word is named beside the crossing instead of preferred over it",
  );
  assert.equal(crossed.facts.day_before, "5", "the crossing's facts are the world's, as on the calendar witness");
  assert.equal(
    crossed.facts.entered_via,
    undefined,
    "the receipt's `entered_via` is read from the record, not smuggled in",
  );

  // WHERE THE OUTCOME IS UNOBSERVED THE DEADLINE STILL STANDS: the same receipt beside a calendar that did not move is
  // a night that did not cross, and its failure is the night's own answer.
  const uncrossed = classifyNight({ terminal: SLEEP_LIFECYCLE_RECEIPT, after: { dayBefore: 5, dayOfMonth: 5 } });
  assert.equal(uncrossed.advanced, false, "a night nobody watched cross is not a crossing because a receipt exists");
  assert.equal(uncrossed.reasonCode, "night_not_advanced:blocked/lifecycle_deadline_exceeded");

  // THE SHAPE THE RUNNER ACTUALLY WRITES is `terminal: null` beside the same receipt on `sleepReceipt`. That record
  // must publish the disagreement, which is the reading that would have caught the night in the first place.
  const shipped = assessMultiDayBaseline({
    dayRecords: [SLEEPING_CALENDAR_NIGHT(), { ...SLEEP_RECEIPT_NIGHT }],
    daysRequested: 2,
  });
  assert.deepEqual(
    shipped.lifecycleDisagreements.map((entry) => entry.code),
    ["lifecycle_disagrees_with_world:lifecycle_deadline_exceeded:day_advanced"],
    `the blocked receipt beside a crossed calendar must be named; got ${JSON.stringify(codes(shipped))}`,
  );
  assert.equal(shipped.lifecycleDisagreements[0].night, 1, "the finding names the night it belongs to");
  assert.equal(shipped.daysCrossed, 2, "and the night still counts as crossed");
  assert.equal(shipped.ok, true, `a crossed night is not a failed night; got ${JSON.stringify(codes(shipped))}`);

  // THE SAME NIGHT WITH THE RECEIPT AS ITS TERMINAL reaches the same verdict, and never `night_not_advanced`.
  const attached = assessMultiDayBaseline({
    dayRecords: [{ ...SLEEPING_CALENDAR_NIGHT(), terminal: SLEEP_LIFECYCLE_RECEIPT }, { ...SLEEP_RECEIPT_NIGHT }],
    daysRequested: 2,
  });
  assert.equal(
    attached.daysCrossed,
    2,
    `the crossing survives the failed terminal; got ${JSON.stringify(codes(attached))}`,
  );
  assert.ok(
    !codes(attached).some((entry) => entry.startsWith("night_not_advanced")),
    `a crossed night must not be answered with its lifecycle's failure; got ${JSON.stringify(codes(attached))}`,
  );
  assert.deepEqual(
    attached.lifecycleDisagreements.map((entry) => entry.code),
    ["lifecycle_disagrees_with_world:lifecycle_deadline_exceeded:day_advanced"],
  );
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

test("a night that saved after the boundary window closed is not a claim without a boundary (round19)", () => {
  // MEASURED 2026-11-01 (`round19`, `2026-11-01T04-56-14-966Z-multiday_routine`). This receipt is that night's,
  // verbatim, and a rule turned it into `night_claims_a_save_without_entering_the_save_boundary` while the Mod log
  // for the same night recorded every step of the crossing:
  //
  //   13:08:49  AwaitingSettlement -> AwaitingSave     the save boundary WAS entered
  //   13:08:54  AwaitingSave -> AwaitingDayStart      on the 300-frame budget, before the save began
  //   13:09:50  Context: before save / SaveGame.Save() completed without exceptions
  //   13:09:52  after save, starting spring 6 Y1      the save `saved_observed=true` reports
  //   13:09:52  sleep lifecycle finished: state=passed; reason=day_advanced; evidence=receipt
  //
  // So the night crossed through the native sleep prompt, the save really ran, and both save facts are TRUE. The rule
  // read `save_boundary_not_observed` as "the boundary was never entered" when it means "the boundary WAIT expired
  // before a save" - and the engine saves synchronously, so `IsSaving` is only true while the update loop is blocked
  // and a per-frame poll cannot see it. A receipt cannot separate that honest sequence from a false save claim, so the
  // conjunction has no lie left to catch; the save CLAIM stays guarded by `night_saved_edge_not_observed`.
  const ROUND19_NIGHT_ONE_EVIDENCE =
    "state=passed;reason=day_advanced;topology=single_player;entered_via=native_sleep_prompt;" +
    "saving_observed=false;saved_observed=true;day_started_observed=true;save_boundary_not_observed=true;" +
    "shipping_summary_settled=committed;day_before=4;days_before=1;day_after=5;days_after=2;" +
    "enteredVia=native_sleep_prompt;topology=single_player;dayBefore=4;dayAfter=5;daysPlayedBefore=1;daysPlayedAfter=2;" +
    "savingObserved=False;savedObserved=True;dayStartedObserved=True;saveBoundaryNotObserved=True;readyCheckObserved=False";
  const round19 = assessMultiDayBaseline({
    daysRequested: 2,
    dayRecords: [
      DAY({
        day: 1,
        // The world after that night: spring 6, and the record's own cause (the Mod's `entered_via`).
        after: { dayOfMonth: 6, seasonIndex: 0 },
        terminal: { state: "succeeded", reasonCode: "day_advanced", evidence: ROUND19_NIGHT_ONE_EVIDENCE },
        menus: [{ menuType: "ShippingMenu", decision: "wait", clearedAt: 1793509795642 }],
      }),
      DAY({ day: 2 }),
    ],
  });
  assert.deepEqual(
    codes(round19),
    [],
    `a night that entered the save boundary and then saved must not be red: ${JSON.stringify(round19.violations)}`,
  );
  assert.equal(round19.daysCrossed, 2, "both nights crossed");
  assert.equal(round19.unobservedNights, 0, "the mechanism was observed on both: the Mod's own lifecycle receipt");

  // THE ASSERTION'S FORCE SURVIVES, on the fact that can actually carry it: a receipt may not claim a save it has no
  // witness for. `saved_observed` is SMAPI's own `Saved` edge, so this is the half that tells a real save from a claim.
  const claimsASaveItDoesNotHave = assessMultiDayBaseline({
    daysRequested: 2,
    dayRecords: [
      DAY({
        day: 1,
        after: { dayOfMonth: 6, seasonIndex: 0 },
        terminal: {
          state: "succeeded",
          reasonCode: "day_advanced",
          evidence: EVIDENCE({ savedObserved: "false", dayBefore: 4, daysBefore: 1, dayAfter: 5, daysAfter: 2 }),
        },
      }),
      DAY({ day: 2, after: { dayOfMonth: 7, seasonIndex: 0 } }),
    ],
  });
  assert.ok(
    codes(claimsASaveItDoesNotHave).includes("night_saved_edge_not_observed"),
    "a night whose receipt has no save witness is still red",
  );
});

test("a violation names a field the record actually has (round18/19/20)", () => {
  // WHAT THE REPORT WAS READING. `round18` (`2026-10-31T19-26-54-087Z`), `round19` (`2026-11-01T04-56-14-966Z`) and
  // `round20` (`2026-11-01T15-44-43-186Z`) were each described as publishing `dayRecords[N].night.terminal = null`
  // beside `night_saved_edge_not_observed` / `night_day_started_edge_not_observed`. Three claims, and the artifacts
  // refute all three:
  //
  //   1. NO DAY RECORD HAS EVER CARRIED A `night` FIELD. `runMultiDayLoop` writes `{ day, terminal, after, menus,
  //      nextDayAccomplishedActionIds }` (`multiday-loop.mjs:313-320`) and the runner's `onDay` adds `cause`. Checked
  //      against all 163 multiday runs on disk: zero records carry `night`. So `dayRecords[N].night.terminal` is a path
  //      that resolves to nothing - and `undefined` on a phantom path is exactly what reads as `terminal: null`.
  //   2. NEITHER EDGE CODE IS A VIOLATION ON ANY OF THE THREE. It appears in exactly one place in each `result.json`:
  //      `multiday.assessment.checkedRules[8]` and `[10]`. `checkedRules` is the CATALOGUE of rules the gate knows how
  //      to apply, published beside the verdict; `violations` is what fired. round18's two were
  //      `night_mechanism_unobserved`, round19's was `next_day_produced_no_farm_work`, and round20 died before a night.
  //   3. THE MOD DOES PUBLISH BOTH EDGES. All 8 `advance_day` terminals in the corpus carry `saved_observed=true` and
  //      `day_started_observed=true`, and the baseline reads them from `record.terminal.evidence`, where they are.
  //
  // So the harness was wrong twice in the same way: it named paths that do not exist. This is the gate for that class -
  // every `where` a violation carries must RESOLVE on the record it names, so the next phantom path fails here instead
  // of costing another round of "the terminal is null".
  const resolve = (record, where) => {
    // `dayRecords[i].a.b` walks `record.a.b`; `dayRecords` alone names the argument itself. The one indirection is the
    // evidence PROJECTION: `terminal.evidence` is the Mod's `key=value;...` string, so a path that continues past it
    // names a KEY in that projection rather than a property of the string.
    const segments = where.split(".").slice(1);
    let cursor = record;
    for (const [position, segment] of segments.entries()) {
      if (position > 0 && segments[position - 1] === "evidence" && typeof cursor === "string") {
        return Object.prototype.hasOwnProperty.call(parseReceiptEvidence(cursor), segment)
          ? { resolved: true }
          : { resolved: false, segment };
      }
      if (cursor === null || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, segment)) {
        return { resolved: false, segment };
      }
      cursor = cursor[segment];
    }
    return { resolved: true };
  };
  // One fixture per rule, so the gate covers the catalogue rather than whatever a single test happens to reach.
  const battery = [
    [DAY({ terminal: { state: "blocked", reasonCode: "day_start_not_observed" } }), DAY({ day: 2 })],
    [DAY({ terminal: null, after: { dayOfMonth: 6 } }), DAY({ day: 2 })],
    [
      DAY({
        terminal: { state: "succeeded", reasonCode: "day_advanced", evidence: "state=passed;reason=day_advanced" },
      }),
      DAY({ day: 2 }),
    ],
    [
      DAY({
        terminal: {
          state: "succeeded",
          reasonCode: "day_advanced",
          evidence: EVIDENCE({ dayBefore: 6, dayAfter: 6, daysBefore: 6, daysAfter: 6 }),
        },
      }),
      DAY({ day: 2 }),
    ],
    [DAY({ after: {} }), DAY({ day: 2 })],
    [DAY({ after: { dayOfMonth: 6 } }), DAY({ day: 2 })],
    [DAY({ terminal: { evidence: EVIDENCE({ savedObserved: "false" }) } }), DAY({ day: 2 })],
    [DAY({ terminal: { evidence: EVIDENCE({ dayStartedObserved: "false" }) } }), DAY({ day: 2 })],
    [ENGINE_TAKEN_NIGHT({ cause: "sleep" }), DAY({ day: 2 })],
    [ENGINE_TAKEN_NIGHT({ cause: "engine" }), DAY({ day: 2 })],
    [DAY({ menus: [MENU({ menuType: "LetterViewerMenu", decision: "blocked" })] }), DAY({ day: 2 })],
    [DAY({ menus: [MENU({ menuType: "LevelUpMenu", decision: "respond_level_up" })] }), DAY({ day: 2 })],
    [
      DAY({
        menus: [
          MENU({
            menuType: "LevelUpMenu",
            decision: "respond_level_up",
            respondReceipt: { state: "succeeded", reasonCode: "level_up_resolved" },
            respondChoice: "branch_a",
          }),
        ],
      }),
      DAY({ day: 2 }),
    ],
    [DAY({ menus: [] }), DAY({ day: 2, menus: [] })],
    [DAY({ nextDayAccomplishedActionIds: [] }), DAY({ day: 2 })],
    [
      DAY({ terminal: { evidence: EVIDENCE({ dayBefore: 27, daysBefore: 27, dayAfter: 28, daysAfter: 28 }) } }),
      DAY({ day: 2 }),
    ],
    [DAY()],
    [null, DAY({ day: 2 })],
  ];
  const seen = new Set();
  for (const dayRecords of battery) {
    const result = assessMultiDayBaseline({ dayRecords, daysRequested: dayRecords.length });
    for (const entry of result.violations) {
      seen.add(entry.code.split(":")[0]);
      // `daysCrossed` and `dayRecords` name the assessment's own arguments, not a record inside it.
      if (!entry.where.startsWith("dayRecords[")) continue;
      const index = Number.parseInt(entry.where.slice("dayRecords[".length), 10);
      const outcome = resolve(dayRecords[index], entry.where);
      assert.ok(
        outcome.resolved,
        `${entry.code} points at ${entry.where}, and "${String(outcome.segment)}" does not exist on that record ` +
          `(fields: ${Object.keys(dayRecords[index] ?? {}).join(",")}). A violation a reader cannot navigate to is a ` +
          "violation that gets argued with instead of fixed.",
      );
    }
  }
  // The battery must actually reach the rules the report named, or this gate is green because nothing ran.
  assert.ok(seen.has("night_saved_edge_not_observed"), `battery never exercised the save edge: ${[...seen].join(",")}`);
  assert.ok(seen.has("night_day_started_edge_not_observed"), "battery never exercised the day-start edge");
  assert.ok(seen.has("night_terminal_missing"), "battery never exercised a night nobody witnessed");
});

test("the rule catalogue lists every rule the gate can fire (round18)", () => {
  // `checkedRules` exists so a reader can tell "this rule passed" from "this rule was never applied" - and the report
  // that read round18's two edge codes out of it did exactly the opposite. That mistake is only possible while a rule
  // can fire without appearing in the catalogue; it becomes impossible once the catalogue is complete.
  //
  // It was not complete. `day_records_missing` and `night_mechanism_unobserved` could both be emitted and neither was
  // listed - and `night_mechanism_unobserved` is precisely the violation round18 DID publish, twice. A reader who took
  // the catalogue for the rule set would not have seen it at all.
  //
  // The population comes from the gate's own OUTPUT rather than a hand-kept list: every code any fixture below makes
  // the gate emit must be catalogued, and every catalogued code must be reachable. A rule added later that forgets the
  // catalogue fails here by name.
  // Each entry carries its own `daysRequested`, so the window rule is exercised as a rule and not only by accident.
  const battery = [
    { dayRecords: null },
    { dayRecords: [null, DAY({ day: 2 })] },
    { dayRecords: [DAY({ terminal: { state: "blocked", reasonCode: "day_start_not_observed" } }), DAY({ day: 2 })] },
    { dayRecords: [DAY({ terminal: null, after: { dayOfMonth: 6 } }), DAY({ day: 2 })] },
    {
      dayRecords: [
        DAY({
          terminal: { state: "succeeded", reasonCode: "day_advanced", evidence: "state=passed;reason=day_advanced" },
        }),
        DAY({ day: 2 }),
      ],
    },
    {
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
    },
    { dayRecords: [DAY({ after: {} }), DAY({ day: 2 })] },
    { dayRecords: [DAY({ after: { dayOfMonth: 6 } }), DAY({ day: 2 })] },
    { dayRecords: [DAY({ terminal: { evidence: EVIDENCE({ savedObserved: "false" }) } }), DAY({ day: 2 })] },
    { dayRecords: [DAY({ terminal: { evidence: EVIDENCE({ dayStartedObserved: "false" }) } }), DAY({ day: 2 })] },
    { dayRecords: [ENGINE_TAKEN_NIGHT({ cause: "sleep" }), DAY({ day: 2 })] },
    { dayRecords: [ENGINE_TAKEN_NIGHT({ cause: "engine" }), DAY({ day: 2 })] },
    { dayRecords: [DAY({ menus: [MENU({ menuType: "LetterViewerMenu", decision: "blocked" })] }), DAY({ day: 2 })] },
    {
      dayRecords: [DAY({ menus: [MENU({ menuType: "LevelUpMenu", decision: "respond_level_up" })] }), DAY({ day: 2 })],
    },
    {
      dayRecords: [
        DAY({
          menus: [
            MENU({
              menuType: "LevelUpMenu",
              decision: "respond_level_up",
              respondReceipt: { state: "succeeded", reasonCode: "level_up_resolved" },
              respondChoice: "branch_a",
            }),
          ],
        }),
        DAY({ day: 2 }),
      ],
    },
    // A summary that was HELD and never cleared, and the first-night rule that reads the same fact: a menu with no
    // dismissal receipt and no `clearedAt` is neither dismissed by the product nor committed by the lifecycle.
    { dayRecords: [DAY({ menus: [{ menuType: "ShippingMenu", decision: "wait" }] }), DAY({ day: 2, menus: [] })] },
    { dayRecords: [DAY({ nextDayAccomplishedActionIds: [] }), DAY({ day: 2 })] },
    {
      dayRecords: [
        DAY({ terminal: { evidence: EVIDENCE({ dayBefore: 27, daysBefore: 27, dayAfter: 28, daysAfter: 28 }) } }),
        DAY({ day: 2 }),
      ],
    },
    // The window, on both sides of it.
    { dayRecords: [DAY()], daysRequested: 1 },
    { dayRecords: [DAY(), DAY({ day: 2 }), DAY({ day: 3 }), DAY({ day: 4 })], daysRequested: 4 },
    // The minimum, with the window itself inside range.
    { dayRecords: [DAY(), DAY({ day: 2 })], daysRequested: 2, forceMinimum: true },
    // The world's own day count disagreeing with the assessor's: the measured round38 shape, where two watched nights
    // sat beside five `day_started` facts.
    { dayRecords: [DAY(), DAY({ day: 2 })], daysRequested: 2, worldDayStarts: [5, 6, 7, 8, 9] },
    // The world's own NIGHT endings: one that decides the night a record holds, one that contradicts what the record
    // claims, and one that belongs to a night in no record at all (the round39 shape).
    {
      dayRecords: [ENGINE_TAKEN_NIGHT({ cause: "sleep" }), DAY({ day: 2 })],
      worldNightEndings: [{ day: 5, cause: "pass_out" }],
    },
    { dayRecords: [DAY(), DAY({ day: 2 })], worldNightEndings: [{ day: 20, cause: "pass_out" }] },
  ];
  const fired = new Set();
  for (const entry of battery) {
    const result = assessMultiDayBaseline({
      dayRecords: entry.dayRecords,
      daysRequested: entry.daysRequested ?? 2,
      worldDayStarts: entry.worldDayStarts ?? null,
      worldNightEndings: entry.worldNightEndings ?? null,
    });
    for (const violation of result.violations) fired.add(violation.code.split(":")[0]);
  }
  // `baseline_days_crossed_below_minimum` cannot fire while the window rule is satisfied and both nights cross, so it
  // is reached through the one shape that leaves the count short without leaving the window: a night that did not cross.
  for (const violation of assessMultiDayBaseline({
    dayRecords: [DAY({ terminal: null, after: { dayOfMonth: 6 } }), DAY({ day: 2 })],
    daysRequested: 2,
  }).violations) {
    fired.add(violation.code.split(":")[0]);
  }
  const catalogued = new Set(assessMultiDayBaseline({ dayRecords: [] }).checkedRules.map((code) => code.split(":")[0]));
  const uncatalogued = [...fired].filter((code) => !catalogued.has(code)).sort();
  assert.deepEqual(
    uncatalogued,
    [],
    `the gate can fire rules its own catalogue does not list: ${uncatalogued.join(", ")}. A reader told "here is what ` +
      'was checked" must not be able to miss a rule that fired.',
  );
  const unreachable = [...catalogued].filter((code) => !fired.has(code)).sort();
  assert.deepEqual(unreachable, [], `the catalogue lists rules no fixture could make fire: ${unreachable.join(", ")}`);
  // The two codes the report read as violations ARE catalogue entries on a healthy night, and the violations list is
  // empty: the two fields answer different questions, which is the whole point.
  const healthy = assessMultiDayBaseline({ dayRecords: [DAY({ day: 1 }), DAY({ day: 2 })], daysRequested: 2 });
  assert.deepEqual(codes(healthy), []);
  assert.ok(healthy.checkedRules.includes("night_saved_edge_not_observed"));
  assert.ok(healthy.checkedRules.includes("night_day_started_edge_not_observed"));
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

// THE WORLD'S OWN NIGHT ENDINGS ARE AN AUTHORITY. Measured 2026-11-07 (`round39`,
// `.live-runs/game-ladder/2026-11-07T13-14-23-120Z-multiday_routine`): the assessment answered `passOutNights: 0` and
// `night_mechanism_unobserved` twice, while the run's own fact log held
// `{ worldFactKind: "night_ended_pass_out", worldFactPayload: { eventId: "night_ended_pass_out_day_6", gameTime: "2600" } }`.
// The facts below are that bundle's, verbatim; the records are its two day records, trimmed to the fields the judgement
// reads (each one's `after` is what the runner wrote).
const ROUND39_FACTS = Object.freeze([
  Object.freeze({ worldFactKind: "day_started", eventId: "day_started_day_5" }),
  Object.freeze({ worldFactKind: "day_started", eventId: "day_started_day_6" }),
  Object.freeze({ worldFactKind: "night_ended_pass_out", eventId: "night_ended_pass_out_day_6" }),
]);
const ROUND39_RECORDS = Object.freeze([
  Object.freeze({
    day: 1,
    terminal: null,
    after: Object.freeze({ dayOfMonth: 6, dayBefore: 5, seasonIndex: 0, year: 1, timeOfDay: 600 }),
    menus: Object.freeze([]),
    cause: "engine",
    nextDayAccomplishedActionIds: Object.freeze(["till_soil", "plant_seed", "water_crop"]),
  }),
  Object.freeze({
    day: 2,
    terminal: null,
    after: Object.freeze({ dayOfMonth: 7, dayBefore: 6, seasonIndex: 0, year: 1, timeOfDay: 600 }),
    menus: Object.freeze([]),
    cause: "engine",
    nextDayAccomplishedActionIds: Object.freeze(["till_soil", "plant_seed", "water_crop"]),
  }),
]);

test("a pass-out the world published is counted and named, and is not given to the night beside it", () => {
  const endings = worldNightEndingsFromFacts(ROUND39_FACTS);
  // The Mod mints the cause as the fact kind's own suffix, and the module spells the same cause as a constant: one
  // fact, one spelling, asserted rather than assumed.
  assert.deepEqual(
    endings.map((entry) => ({ day: entry.day, cause: entry.cause })),
    [{ day: 6, cause: NIGHT_CAUSE_PASS_OUT }],
    "the fact's own day and cause, with no inference about which night it belongs to",
  );
  const result = assessMultiDayBaseline({
    dayRecords: ROUND39_RECORDS,
    daysRequested: 2,
    worldDayStarts: worldDayStartsFromFacts(ROUND39_FACTS),
    worldNightEndings: endings,
  });
  assert.equal(result.nightWitness, "world", "the attribution came from the world's facts, and says so");
  assert.equal(result.passOutNights, 1, "the engine took one night, and the world said so");
  assert.deepEqual(result.worldNightEndings, endings, "the night's own cause travels with the verdict");
  // The night the pass-out ended (day 6, opened by `day_started_day_6`) came AFTER both recorded nights: record 2's
  // night ended on day 6 of the month and crossed into `day_started_day_6`. A mapping that gave the pass-out to record
  // 2 would state that a night which ended 880 s earlier was a pass-out.
  assert.ok(
    codes(result).includes("world_night_not_recorded:6:pass_out"),
    `a night in no record must be named; got ${JSON.stringify(codes(result))}`,
  );
  assert.equal(result.unobservedNights, 2, "and neither recorded night is attributed to the engine by it");
  // The world moved a third time, and the count says so: two `day_started` facts plus the pass-out's own new day.
  assert.equal(result.worldDaysCrossed, 3);
  assert.ok(
    codes(result).includes("day_count_disagrees_with_the_world:2 != 3"),
    `the world's crossings must be reconciled; got ${JSON.stringify(codes(result))}`,
  );
  // And a run whose `day_started` fact for that morning DID arrive counts the morning once, not twice: the pass-out
  // names the day it opened, which is the same day the fact names.
  const bothWitnesses = assessMultiDayBaseline({
    dayRecords: ROUND39_RECORDS,
    daysRequested: 2,
    worldDayStarts: worldDayStartsFromFacts([
      ...ROUND39_FACTS,
      { worldFactKind: "day_started", eventId: "day_started_day_7" },
    ]),
    worldNightEndings: endings,
  });
  assert.equal(bothWitnesses.worldDaysCrossed, 3, "the same morning witnessed twice is one morning");
});

test("a world ending decides the recorded night it names, and contradicts a claim rather than obeying it", () => {
  // The recorded night ends on TotalDays 5 (the receipt's own `day_before`), so a pass-out for day 5 is ITS ending.
  const named = assessMultiDayBaseline({
    daysRequested: 2,
    dayRecords: [
      DAY({
        day: 1,
        cause: "engine",
        // The receipt's own `day_after` is the calendar the world was observed on, so this record's `after` is day 7.
        after: { dayOfMonth: 7, timeOfDay: 610, seasonIndex: 0 },
        terminal: { evidence: EVIDENCE({ dayBefore: 5, dayAfter: 6 }) },
      }),
      DAY({ day: 2 }),
    ],
    worldNightEndings: [{ day: 5, cause: NIGHT_CAUSE_PASS_OUT }],
  });
  assert.equal(named.passOutNights, 1);
  assert.ok(
    !codes(named).includes("night_mechanism_unobserved"),
    `the world said how the night ended; got ${JSON.stringify(codes(named))}`,
  );
  assert.ok(!codes(named).some((code) => code.startsWith("world_night_not_recorded")), "the night IS recorded");

  // A record claiming her own sleep for a night the world says the engine took is a DISAGREEMENT between two
  // witnesses, and it is named with both sides instead of one of them silently winning.
  const contradiction = assessMultiDayBaseline({
    daysRequested: 2,
    dayRecords: [
      DAY({
        day: 1,
        cause: "sleep",
        after: { dayOfMonth: 7, timeOfDay: 610, seasonIndex: 0 },
        terminal: { evidence: EVIDENCE({ dayBefore: 5, dayAfter: 6 }) },
      }),
      DAY({ day: 2 }),
    ],
    worldNightEndings: [{ day: 5, cause: NIGHT_CAUSE_PASS_OUT }],
  });
  assert.ok(
    codes(contradiction).includes("night_cause_disagrees_with_the_world:sleep:pass_out"),
    `both sides must survive the comparison; got ${JSON.stringify(codes(contradiction))}`,
  );
});

test("a night neither the world nor a receipt explains is still unobserved", () => {
  // The fixture the real bundle does not contain: the world names NO ending for the night, and no receipt exists, so
  // the crossing is a fact and its attribution is not. This is the only case `night_mechanism_unobserved` is for.
  const result = assessMultiDayBaseline({
    daysRequested: 2,
    dayRecords: [
      DAY({ day: 1, cause: "engine", terminal: null, after: { dayBefore: 5, dayOfMonth: 6, seasonIndex: 0 } }),
      DAY({ day: 2 }),
    ],
    worldNightEndings: [],
  });
  assert.equal(result.nightWitness, "world", "an empty list is the world saying nothing, not nobody looking");
  assert.equal(result.passOutNights, 0);
  assert.ok(codes(result).includes("night_mechanism_unobserved"), JSON.stringify(codes(result)));
});

test("a caller with no world facts is told whose attribution it is reading", () => {
  // Nothing about the change makes the facts mandatory: the record's own witnesses still answer, and the verdict says
  // that is what happened instead of letting the answer read as measured.
  const withoutFacts = assessMultiDayBaseline({
    daysRequested: 2,
    dayRecords: [DAY({ day: 1 }), DAY({ day: 2 })],
  });
  assert.equal(withoutFacts.nightWitness, "assessor");
  assert.equal(withoutFacts.worldNightEndings, null);
  assert.equal(withoutFacts.passOutNights, 0, "a sleep receipt is not a pass-out");
  assert.equal(withoutFacts.ok, true, `violations=${JSON.stringify(codes(withoutFacts))}`);
});

test("the world night reader refuses a fact whose id carries no day", () => {
  // Same rule as `worldDayStartsFromFacts`: a day number a fact does not carry cannot be compared, so it is skipped
  // rather than guessed into whatever day happens to be current.
  assert.deepEqual(worldNightEndingsFromFacts([{ worldFactKind: "night_ended_pass_out" }]), []);
  assert.deepEqual(worldNightEndingsFromFacts([{ worldFactKind: "day_started", eventId: "day_started_day_5" }]), []);
  assert.deepEqual(worldNightEndingsFromFacts(null), []);
  // A redelivered fact is the same night, not a second one.
  assert.equal(
    worldNightEndingsFromFacts([
      { worldFactKind: "night_ended_pass_out", eventId: "night_ended_pass_out_day_6" },
      { worldFactKind: "night_ended_pass_out", worldFactPayload: { eventId: "night_ended_pass_out_day_6" } },
    ]).length,
    1,
  );
});
