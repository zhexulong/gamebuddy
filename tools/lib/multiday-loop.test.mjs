// The multi-day loop's falsifiers: the night must not be declared crossed while a menu still holds the
// actor, a menu the product must not close must stop the run BY NAME, and the companion must be the one
// that ends the day.
//
// red-proof: inject  the rollover-menu branch answering `dismiss` where the loop must wait ->
//                    `✖ a menu with no audited handling stops the run by name instead of timing out`, exit 1; the
//                    unmodified loop passes the same suite, exit 0 (tools/lib/multiday-loop.test.mjs)
import assert from "node:assert/strict";
import test from "node:test";

import { assessMultiDayBaseline } from "./multiday-baseline.mjs";
import {
  classifyActorHold,
  closeIsEngineCommitted,
  crossingsFromEvidence,
  DECIDER_WAKE_REASONS,
  decideDayWake,
  decideHeldMenu,
  OBJECTIVE_STATE,
  objectiveProgressKey,
  QUIET_BOUND_MS,
  readHeldMenu,
  readObjectiveState,
  runMultiDayLoop,
  WAKE_REASON,
  wakeReasonReachability,
  WAKE_SUPPRESSION,
  watchRollover,
} from "./multiday-loop.mjs";

/** A scripted world: each observe() returns the next snapshot, and dismiss() records the call. */
function world(
  snapshots,
  dismissOutcome = { receipt: { state: "succeeded", reasonCode: "modal_dismissed" }, reasonCode: null },
) {
  const observed = [];
  const dismissals = [];
  const levelUpCalls = [];
  let index = 0;
  const scripted = {
    observed,
    dismissals,
    levelUpCalls,
    // Scripted by the test: `ordinary` means the menu is a level the watcher may confirm, otherwise it is a
    // milestone the watcher must leave to the companion.
    levelUp: { ordinary: true },
    async observe() {
      const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
      observed.push(snapshot);
      index += 1;
      return snapshot;
    },
    async dismiss(menuType) {
      dismissals.push(menuType);
      return dismissOutcome;
    },
    async respondLevelUp() {
      levelUpCalls.push(scripted.levelUp.ordinary ? "confirm" : "refused");
      return scripted.levelUp.ordinary
        ? {
            receipt: { state: "succeeded", reasonCode: "level_up_resolved" },
            reasonCode: null,
            choice: "confirm",
            levelUp: { skill: 0, level: 2 },
          }
        : {
            receipt: null,
            reasonCode: "level_up_requires_companion_choice:0@5",
            choice: null,
            levelUp: { skill: 0, level: 5 },
          };
    },
  };
  return scripted;
}

const free = (dayOfMonth) => ({
  actionable: true,
  activeExecution: null,
  dayOfMonth,
  actorDispositionKind: "idle",
  actorDispositionDetail: null,
});
const held = (menuType, dayOfMonth) => ({
  actionable: false,
  activeExecution: null,
  dayOfMonth,
  actorDispositionKind: "modal",
  actorDispositionDetail: menuType,
});

const instant = { sleep: async () => {}, now: () => 0, pollIntervalMs: 0 };

test("the night is not crossed while a menu still holds the actor, even if the calendar moved", async () => {
  // The calendar moves FIRST (that is the real order), so a loop that trusted the day number would
  // declare the night over with the settlement menu still up.
  //
  // The summary is closed by the night lifecycle, not here, so this case no longer asserts a dismissal - it asserts
  // the ordering: held, held, then free, and only the free one is a crossing.
  const scripted = world([held("ShippingMenu", 7), held("ShippingMenu", 7), free(7)]);
  const outcome = await watchRollover(scripted, { dayBefore: 6, timeoutMs: 600_000, ...instant });
  assert.equal(outcome.crossed, true);
  assert.equal(outcome.dayAfter, 7);
  assert.deepEqual(scripted.dismissals, [], "dismissal is the lifecycle's, not the loop's");
  assert.equal(outcome.menus[0].menuType, "ShippingMenu");
});

test("a menu with no audited handling stops the run by name instead of timing out", () => {
  assert.deepEqual(decideHeldMenu("LetterViewerMenu"), {
    kind: "blocked",
    menuType: "LetterViewerMenu",
    reasonCode: "actor_held_by_unclosable_menu:LetterViewerMenu",
  });
  assert.equal(decideHeldMenu("SaveGameMenu").kind, "wait");
  assert.equal(decideHeldMenu("DialogueBox").kind, "wait");
  assert.equal(decideHeldMenu("ReadyCheckDialog").kind, "wait");
  // The lifecycle commits it; from here it is something to WAIT on, like the other engine-owned modals.
  assert.equal(decideHeldMenu("ShippingMenu").kind, "wait");
  assert.equal(decideHeldMenu(null).kind, "none");
  assert.equal(readHeldMenu({ actorDispositionKind: "modal", actorDispositionDetail: "" }), "unknown");
  assert.equal(readHeldMenu({ actorDispositionKind: "idle" }), null);
  assert.equal(readHeldMenu(null), null);
});

test("the level-up menu is RESOLVED, not dismissed and not stopped", async () => {
  // An ACTIVE LevelUpMenu grants its perk when it closes, so it has no pure-cancel path: it needs
  // `respond_level_up`. An ordinary level has exactly one legal value, so the watcher may pass `confirm`
  // without taking a decision for the companion; a milestone is stopped by name instead.
  assert.equal(decideHeldMenu("LevelUpMenu").kind, "respond_level_up");
  const scripted = world([held("LevelUpMenu", 7), free(7)]);
  scripted.levelUp = { ordinary: true };
  const outcome = await watchRollover(scripted, { dayBefore: 6, timeoutMs: 600_000, ...instant });
  assert.equal(outcome.crossed, true);
  assert.deepEqual(scripted.dismissals, []);
  assert.deepEqual(scripted.levelUpCalls, ["confirm"]);
  assert.equal(outcome.menus[0].respondChoice, "confirm");
  assert.equal(outcome.menus[0].respondReasonCode, null);
});

test("a milestone level-up is the companion's decision, so the watcher stops by name", async () => {
  const scripted = world([held("LevelUpMenu", 7)]);
  scripted.levelUp = { ordinary: false };
  const outcome = await watchRollover(scripted, { dayBefore: 6, timeoutMs: 600_000, ...instant });
  assert.equal(outcome.crossed, false);
  assert.equal(outcome.reasonCode, "level_up_requires_companion_choice:0@5");
  assert.deepEqual(scripted.dismissals, []);
  // It asked once and reported; it did NOT retry into a loop.
  assert.equal(scripted.levelUpCalls.length, 1);
});

test("a menu the product must not close is stopped before any dismissal is attempted", async () => {
  const scripted = world([held("LetterViewerMenu", 7)]);
  const outcome = await watchRollover(scripted, { dayBefore: 6, timeoutMs: 600_000, ...instant });
  assert.equal(outcome.reasonCode, "actor_held_by_unclosable_menu:LetterViewerMenu");
  assert.deepEqual(scripted.dismissals, []);
});

test("a hold the Mod itself reports is named, never dismissed", async () => {
  const cutscene = world([{ actionable: false, actorDispositionKind: "event", actorDispositionDetail: "festival" }]);
  const outcome = await watchRollover(cutscene, { dayBefore: 6, timeoutMs: 0, ...instant });
  assert.equal(outcome.crossed, false);
  assert.equal(outcome.reasonCode, "actor_held_by_cutscene");
  assert.deepEqual(cutscene.dismissals, []);
  assert.deepEqual(classifyActorHold({ actorDispositionKind: "pass_out" }), {
    hold: "pass_out",
    reasonCode: "actor_passed_out",
  });
  assert.deepEqual(classifyActorHold({ actorDispositionKind: "idle" }), { hold: null, reasonCode: null });
});

test("the unclosable menu is stopped after a false menu type was reported", async () => {
  const scripted = world([held("LetterViewerMenu", 7)]);
  const outcome = await watchRollover(scripted, { dayBefore: 6, timeoutMs: 600_000, ...instant });
  assert.equal(outcome.reasonCode, "actor_held_by_unclosable_menu:LetterViewerMenu");
  assert.deepEqual(scripted.dismissals, []);
});

test("the loop never dismisses the shipping summary: that is the lifecycle's own commit", async () => {
  // The summary used to be closed from here, while the companion was blocked inside `advance_day`. It is now
  // committed by `SleepAndAdvanceDayLifecycle`, so the loop only waits - and a summary nothing closes is a named
  // stop with the menu in its name, not a dismissal the harness performed.
  //
  // `timeoutMs: 0` on purpose: with a frozen clock the wait can only end by expiring, and an expired wait is what
  // this case is about. A generous timeout here would make the test spin instead of asserting.
  const snapshots = Array.from({ length: 8 }, () => held("ShippingMenu", 7));
  const scripted = world(snapshots);
  const outcome = await watchRollover(scripted, { dayBefore: 6, timeoutMs: 0, ...instant });
  assert.equal(outcome.crossed, false);
  assert.equal(outcome.reasonCode, "night_not_observed:modal:ShippingMenu");
  assert.deepEqual(scripted.dismissals, [], "the loop must not click the summary on the companion's behalf");
});

test("an expired wait names what was holding the actor", async () => {
  const scripted = world([held("SaveGameMenu", 7)]);
  const outcome = await watchRollover(scripted, { dayBefore: 6, timeoutMs: 0, ...instant });
  assert.equal(outcome.crossed, false);
  assert.equal(outcome.reasonCode, "night_not_observed:modal:SaveGameMenu");
});

test("a menu that stands while no observed fact moves is named a DEADLOCK, not a spent budget", async () => {
  // Measured 2026-10-28 (`round6`): the companion never dispatched `advance_day`, the engine's 02:00 pass-out took
  // the night, the day began with the settlement summary standing, and the watch spent 31 of a 45.79-minute run before
  // answering `night_never_started`. Nothing was going to close that menu and nothing was acting on it: the same menu
  // type stood and not one fact the Mod publishes moved. That is a deadlock, and it must not be spelled with the word
  // a slow night uses - a reader of the result had to guess which of the two had happened.
  //
  // The harness clock advances (that is what spends the budget) while the WHOLE snapshot is frozen, including
  // `timeOfDay`: the engine is not running the day either. The mismatch between the two clocks is the deadlock.
  const frozen = { ...held("ShippingMenu", 7), timeOfDay: 2610 };
  const scripted = world([frozen]);
  let clock = 0;
  const outcome = await watchRollover(scripted, {
    dayBefore: 6,
    timeoutMs: 600_000,
    pollIntervalMs: 250,
    now: () => clock,
    sleep: async () => {
      clock += 250;
    },
  });
  assert.equal(outcome.crossed, false);
  assert.match(outcome.reasonCode, /^rollover_menu_deadlock:ShippingMenu:/u);
  assert.match(outcome.reasonCode, /held_ms=\d+/u);
  assert.match(outcome.reasonCode, /unchanged_ms=\d+/u);
  assert.match(outcome.reasonCode, /unchanged_observations=\d+/u);
  assert.match(outcome.reasonCode, /actionable_changed=false/u);
  assert.doesNotMatch(
    outcome.reasonCode,
    /night_not_observed/u,
    "the slow-night word must not be reused for a night nothing owns",
  );
  assert.deepEqual(scripted.dismissals, [], "naming the deadlock must not become closing the menu");
});

test("the same menu standing while the game's own clock runs is a SLOW night, not a deadlock", async () => {
  // The mirror case, and the whole reason the verdict reads evidence instead of a menu name: the SAME
  // `ShippingMenu` stands in both tests, and only the published facts differ. Something is running behind this one,
  // so it is a night being slow - and a slow night must not be reported as abandoned, or the deadlock word stops
  // meaning anything.
  let minute = 18 * 60;
  const moving = {
    async observe() {
      minute += 1;
      return { ...held("ShippingMenu", 7), timeOfDay: Math.floor(minute / 60) * 100 + (minute % 60) };
    },
    async dismiss() {
      throw new Error("the loop must never dismiss the summary");
    },
  };
  let clock = 0;
  const outcome = await watchRollover(moving, {
    dayBefore: 6,
    timeoutMs: 300_000,
    pollIntervalMs: 250,
    now: () => clock,
    sleep: async () => {
      clock += 60_000;
    },
  });
  assert.equal(outcome.crossed, false);
  assert.equal(outcome.reasonCode, "night_not_observed:modal:ShippingMenu");
  assert.doesNotMatch(outcome.reasonCode, /deadlock/u, "a moving world is not a deadlock");
});

test("an execution in flight is an owner, so a standing menu is not a deadlock", async () => {
  // The third shape, and the one that keeps the word honest: if an action is executing, whatever holds the menu may
  // still be answered by it. Reporting a deadlock there would be a claim about ownership that nothing observed.
  const inFlight = { ...held("ShippingMenu", 7), timeOfDay: 2610, activeExecution: { executionId: "exec-1" } };
  const scripted = world([inFlight]);
  let clock = 0;
  const outcome = await watchRollover(scripted, {
    dayBefore: 6,
    timeoutMs: 60_000,
    pollIntervalMs: 250,
    now: () => clock,
    sleep: async () => {
      clock += 250;
    },
  });
  assert.equal(outcome.crossed, false);
  assert.equal(outcome.reasonCode, "night_not_observed:modal:ShippingMenu");
  assert.deepEqual(scripted.dismissals, []);
});

test("the companion ends the day: the loop delivers days and watches the nights between them", async () => {
  const delivered = [];
  const watched = [];
  const result = await runMultiDayLoop({
    crossNights: 2,
    dayTurn: async (day) => {
      delivered.push(day);
      return { accomplishedActionIds: [`day-${String(day)}-work`] };
    },
    nightWatch: async (day) => {
      watched.push(day);
      return {
        terminal: { state: "succeeded", reasonCode: "day_advanced" },
        after: { dayOfMonth: 6 + day },
        menus: [
          {
            menuType: "ShippingMenu",
            decision: "dismiss",
            dismissReceipt: { state: "succeeded", reasonCode: "modal_dismissed" },
            dismissReasonCode: null,
          },
        ],
        reasonCode: null,
      };
    },
  });
  // Two nights means THREE days: the closing day is the one the last night opened.
  assert.deepEqual(delivered, [1, 2, 3]);
  assert.deepEqual(watched, [1, 2]);
  assert.equal(result.daysCrossed, 2);
  assert.equal(result.completed, true);
  // The record shape is what the baseline gate judges: each night carries the work of the day AFTER it, which
  // is the evidence that the loop kept going rather than stopping at the rollover.
  assert.equal(result.dayRecords.length, 2);
  assert.deepEqual(result.dayRecords[0].nextDayAccomplishedActionIds, ["day-2-work"]);
  assert.deepEqual(result.dayRecords[1].nextDayAccomplishedActionIds, ["day-3-work"]);
});

test("a night that stops ends the loop with its own reason and keeps what it had", async () => {
  const result = await runMultiDayLoop({
    crossNights: 3,
    dayTurn: async () => ({ accomplishedActionIds: ["harvest_crop"] }),
    nightWatch: async (day) =>
      day === 1
        ? {
            terminal: { state: "succeeded", reasonCode: "day_advanced" },
            after: { dayOfMonth: 7 },
            menus: [],
            reasonCode: null,
          }
        : {
            terminal: null,
            after: { dayOfMonth: 7 },
            menus: [],
            reasonCode: "actor_held_by_unclosable_menu:LevelUpMenu",
          },
  });
  assert.equal(result.completed, false);
  assert.equal(result.reasonCode, "actor_held_by_unclosable_menu:LevelUpMenu");
  assert.equal(result.daysCrossed, 1);
  assert.equal(result.dayRecords.length, 2);
});

test("bad loop inputs are refused by name", async () => {
  await assert.rejects(
    () => runMultiDayLoop({ crossNights: 1, dayTurn: async () => ({}), nightWatch: async () => ({}) }),
    /multiday_crossings_out_of_range:1/u,
  );
  await assert.rejects(
    () => runMultiDayLoop({ crossNights: 4, dayTurn: async () => ({}), nightWatch: async () => ({}) }),
    /multiday_crossings_out_of_range:4/u,
  );
  await assert.rejects(
    () => runMultiDayLoop({ crossNights: 2, dayTurn: null, nightWatch: async () => ({}) }),
    /multiday_callbacks_required/u,
  );
});

test("a dead transport ends the night watch at once, rather than timing out like a slow game", async () => {
  // Measured 2026-10-17: the pipe died 15s into the first multi-day run and the loop kept waiting for a night
  // that could never arrive, because nothing asked whether the bridge was still there.
  const scripted = world([held("ShippingMenu", 7)]);
  const outcome = await watchRollover(scripted, {
    dayBefore: 6,
    timeoutMs: 600_000,
    ...instant,
    abort: () => "night_watched_over_a_dead_bridge:local_close",
  });
  assert.equal(outcome.crossed, false);
  assert.equal(outcome.reasonCode, "night_watched_over_a_dead_bridge:local_close");
  assert.deepEqual(scripted.dismissals, [], "a dead bridge must not be asked to dismiss anything");
  assert.deepEqual(scripted.observed, [], "it must not even observe once");
});

test("the loop's records are what the baseline gate judges, end to end", async () => {
  // The two modules must agree on the record shape, or a passing loop would red the gate for a reason
  // that is about serialization rather than about the game.
  const result = await runMultiDayLoop({
    crossNights: 3,
    dayTurn: async (day) => ({ accomplishedActionIds: day === 1 ? ["harvest_crop"] : ["cut_weeds"] }),
    nightWatch: async (day) => ({
      terminal: {
        state: "succeeded",
        reasonCode: "day_advanced",
        evidence: [
          "state=passed",
          "reason=day_advanced",
          "saving_observed=true",
          "saved_observed=true",
          "day_started_observed=true",
          `day_before=${String(5 + day)}`,
          `days_before=${String(5 + day)}`,
          `day_after=${String(6 + day)}`,
          `days_after=${String(6 + day)}`,
        ].join(";"),
      },
      after: { dayOfMonth: 6 + day + 1, timeOfDay: 610 },
      menus: [
        {
          menuType: "ShippingMenu",
          decision: "dismiss",
          dismissReceipt: { state: "succeeded", reasonCode: "modal_dismissed" },
          dismissReasonCode: null,
        },
      ],
      reasonCode: null,
    }),
  });
  const assessment = assessMultiDayBaseline({ dayRecords: result.dayRecords, daysRequested: 3 });
  assert.deepEqual(assessment.violations, []);
  assert.equal(assessment.state, "passed");
  assert.equal(assessment.daysCrossed, 3);
});

test("a close the ENGINE owns is waited for instead of being counted as a failed dismissal", () => {
  // Measured on g42stall: the settlement menu's dismissal commits through the engine's own path (the outro that
  // creates the save menu), so the menu stays on screen while the engine finishes it. The loop dispatched three
  // "successful" dismissals of the same menu, exhausted its attempts, and reported
  // `rollover_menu_not_cleared:ShippingMenu` - while the Mod's lifecycle finished the day eight seconds later.
  assert.equal(
    closeIsEngineCommitted({ reasonCode: "modal_dismissed", evidence: "modal_type=ShippingMenu;clearing=true" }),
    true,
  );
  assert.equal(closeIsEngineCommitted("modal_type=ShippingMenu;close_effect=engine_shipping_commit"), true);
  assert.equal(
    closeIsEngineCommitted({ reasonCode: "modal_dismissed", evidence: "modal_type=ShippingMenu;cleared=true" }),
    false,
  );
  assert.equal(closeIsEngineCommitted(null), false);

  // A world whose menu stays up for two observations after the committed dismissal, then clears as the day changes.
  let observed = 0;
  const world = {
    observe: async () => {
      observed += 1;
      if (observed <= 2)
        return {
          dayOfMonth: 5,
          actorDispositionKind: "modal",
          actorDispositionDetail: "ShippingMenu",
          actionable: false,
        };
      return { dayOfMonth: 6, actorDispositionKind: "idle", actionable: true, activeExecution: null };
    },
    dismiss: async () => ({
      receipt: { reasonCode: "modal_dismissed", evidence: "modal_type=ShippingMenu;clearing=true" },
      reasonCode: null,
    }),
  };
  return watchRollover(world, {
    dayBefore: 5,
    now: () => Date.now(),
    sleep: async () => {},
    timeoutMs: 5_000,
    pollIntervalMs: 1,
  }).then((outcome) => {
    assert.equal(outcome.crossed, true, JSON.stringify(outcome));
    assert.equal(outcome.dayAfter, 6);
  });
});

test("a day-start transition is WAITED for, not answered as a cutscene verdict", async () => {
  // Measured 2026-11-09 (round40): six seconds into day 6 the world was still fading in - `can_move=False`,
  // `fade=0.76`, `actorDispositionKind: event` - and the watcher declared `actor_held_by_cutscene`, ending a run that
  // had crossed one of its two nights. The fade finished two seconds later, on its own. An event that clears itself is
  // a wait; only an event that never clears is a stop, and then it must say how long it waited.
  let clock = 0;
  const advancing = { sleep: async () => {}, now: () => clock, pollIntervalMs: 0 };
  const fading = [
    { actionable: false, actorDispositionKind: "event", actorDispositionDetail: "new_day_transition", dayOfMonth: 6 },
    { actionable: false, actorDispositionKind: "event", actorDispositionDetail: "new_day_transition", dayOfMonth: 7 },
    free(7),
  ];
  const world = {
    dismissed: [],
    async observe() {
      clock += 500;
      return fading[Math.min(Math.floor(clock / 500) - 1, fading.length - 1)];
    },
    async dismiss(menuType) {
      this.dismissed.push(menuType);
      return { receipt: null, reasonCode: null };
    },
  };
  const outcome = await watchRollover(world, { dayBefore: 6, timeoutMs: 60_000, ...advancing });
  assert.equal(outcome.crossed, true, "the transition cleared, so the night was crossed after it");
  assert.equal(outcome.dayAfter, 7);
  assert.deepEqual(world.dismissed, [], "waiting is not dismissing: the event closes itself");
});

test("an event that never clears stops by name, with the time it was given", async () => {
  let clock = 0;
  const advancing = { sleep: async () => {}, now: () => clock, pollIntervalMs: 0 };
  const stuck = {
    async observe() {
      clock += 1000;
      return { actionable: false, actorDispositionKind: "event", actorDispositionDetail: "festival", dayOfMonth: 6 };
    },
    async dismiss() {
      return { receipt: null, reasonCode: null };
    },
  };
  const outcome = await watchRollover(stuck, { dayBefore: 6, timeoutMs: 600_000, eventWaitMs: 3000, ...advancing });
  assert.equal(outcome.crossed, false);
  assert.match(
    String(outcome.reasonCode),
    /^actor_held_by_cutscene:waited_ms=\d+$/u,
    "the refusal must say it waited, and for how long - 'a cutscene is standing' is a different claim",
  );
  assert.ok(Number(String(outcome.reasonCode).split("waited_ms=")[1]) >= 3000);
});

test("a cutscene cannot outrank a calendar that already moved", async () => {
  // Measured 2026-11-09 (round40 second attempt): she slept at 21:40, the night advanced, and the watcher spent its whole
  // event budget watching the NEW day's transition - `actor_held_by_cutscene:waited_ms=20124` - and reported the night
  // uncrossed on a day record whose own terminal said `day_advanced`. A menu holds a night because the harness must not
  // close it; a cutscene has already let the world move, and the day moving IS the crossing.
  let clock = 0;
  const advancing = { sleep: async () => {}, now: () => clock, pollIntervalMs: 0 };
  const transitionAfterCrossing = {
    async observe() {
      clock += 500;
      // The calendar has moved (6 -> 7) and the new day's own transition is still running.
      return { actionable: false, actorDispositionKind: "event", actorDispositionDetail: "new_day", dayOfMonth: 7 };
    },
    async dismiss() {
      return { receipt: null, reasonCode: null };
    },
  };
  const outcome = await watchRollover(transitionAfterCrossing, { dayBefore: 6, timeoutMs: 600_000, ...advancing });
  assert.equal(outcome.crossed, true, "the day moved, so the night was crossed - whatever is on screen now");
  assert.equal(outcome.dayAfter, 7);
});

// THE CROSSINGS ARE THE NIGHTS THAT HAPPENED, NOT THE NIGHTS SOMEBODY WATCHED.
//
// Measured 2026-11-10 (round44): three `sleep` receipts reached `day_advanced`, the world published three `day_started`
// facts, and the artifact said `crossings: 2` because the third night was crossed inside the closing day's turn, after
// which no watcher runs.
const receipt = (requestId) => ({ requestId, reasonCode: "day_advanced" });
const watched = (day) => ({ day, terminal: { state: "succeeded", reasonCode: "day_advanced" }, menus: [] });

test("a night crossed after the watcher stopped still counts, and is named post_watch", () => {
  const result = crossingsFromEvidence({
    sleepReceipts: [receipt("r1"), receipt("r2"), receipt("r3")],
    dayStartedDays: [5, 6, 7],
    dayRecords: [watched(1), watched(2)],
    recorded: 2,
  });
  assert.equal(result.crossings, 3);
  assert.equal(result.witness, "sleep_receipts+day_started_facts");
  assert.deepEqual(result.observed, ["watch", "watch", "post_watch"]);
  assert.equal(result.watched, 2);
  assert.equal(result.postWatch, 1);
  // ALL FOUR NUMBERS, EACH WITH ITS OWN SOURCE, so a reader can see which one was the lie rather than being handed one.
  assert.deepEqual(
    result.sources.map((entry) => [entry.name, entry.crossings]),
    [
      ["sleep_receipts", 3],
      // Nobody supplied the night-ending facts, so the engine's own crossings were not measured - which is `null`, never
      // a zero that would have claimed the engine crossed nothing.
      ["night_endings", null],
      ["day_started_facts", 3],
      ["day_records", 2],
      ["recorded", 2],
    ],
  );
  // THE DISAGREEMENT NAMES THE CLAIM, NOT THE EVIDENCE. The three nights are agreed by the receipts and the calendar; it is
  // the loop's own records and the artifact's published number that fall short, and that is the round44 defect named.
  assert.equal(result.disagreement, "crossings_disagree:day_records=2:recorded=2");
});

test("two evidence sources that disagree produce no number at all, and the disagreement names both", () => {
  const result = crossingsFromEvidence({
    sleepReceipts: [receipt("r1"), receipt("r2"), receipt("r3")],
    dayStartedDays: [5, 6],
    dayRecords: [watched(1), watched(2)],
    recorded: 2,
  });
  assert.equal(result.crossings, null, "a run that cannot say how many nights it lived has no number");
  assert.equal(result.witness, null);
  assert.deepEqual(result.observed, []);
  assert.match(result.disagreement, /crossings_disagree:sleep_receipts=3:day_started_facts=2/u);
});

test("a redelivered receipt is the same night, and an unreadable source is not a count of none", () => {
  const redelivered = crossingsFromEvidence({
    sleepReceipts: [receipt("r1"), receipt("r1"), receipt("r2")],
    dayStartedDays: [5, 6],
    dayRecords: [watched(1), watched(2)],
    recorded: 2,
  });
  assert.equal(redelivered.crossings, 2);
  assert.equal(redelivered.postWatch, 0);
  assert.equal(redelivered.disagreement, null);

  // Nothing readable: the artifact's own number is all there is, and it says so rather than reading as evidence.
  const recordsOnly = crossingsFromEvidence({ recorded: 2 });
  assert.equal(recordsOnly.crossings, 2);
  assert.equal(recordsOnly.witness, "recorded");
  assert.equal(recordsOnly.sources.find((entry) => entry.name === "sleep_receipts").crossings, null);
  assert.equal(recordsOnly.postWatch, 2, "a crossing nothing watched is post_watch, not watched");

  const nothing = crossingsFromEvidence({});
  assert.equal(nothing.crossings, null);
  assert.equal(nothing.witness, null);
  assert.equal(nothing.disagreement, null, "no source was readable, so nothing disagrees");
});

test("an empty evidence list is a run that crossed nothing, which is a measurement and not a missing field", () => {
  const result = crossingsFromEvidence({ sleepReceipts: [], dayStartedDays: [], dayRecords: [], recorded: 0 });
  assert.equal(result.crossings, 0);
  assert.deepEqual(result.observed, []);
  assert.equal(result.postWatch, 0);
  assert.equal(result.disagreement, null);
});

// THE ENGINE'S PASS-OUT IS A CROSSING, AND THE RUN MUST SAY WHICH CAUSE IT COUNTED.
//
// Measured 2026-11-11 (`round45`, `2026-11-10T22-13-25-922Z-multiday_routine`): the world published `day_started_day_5`,
// `_6`, `_7` and `night_ended_pass_out_day_5`, `_6`, while exactly ONE `sleep` receipt reached `day_advanced`. Counting
// only her own sleep could not add up to the days the world opened, so the pairing answered `null` - on a run that lived
// three nights and could name the cause of every one of them.
const PASS_OUT_NIGHT = (day) => ({ day, cause: "pass_out" });

test("a night the engine passed her out on is a crossing, and every crossing names its cause", () => {
  const result = crossingsFromEvidence({
    sleepReceipts: [receipt("r1")],
    worldNightEndings: [PASS_OUT_NIGHT(5), PASS_OUT_NIGHT(6), PASS_OUT_NIGHT(5)],
    dayStartedDays: [5, 6, 7],
    dayRecords: [watched(1)],
    recorded: 1,
  });
  assert.equal(result.crossings, 3, "three days started, so three nights were crossed");
  assert.equal(result.witness, "sleep_receipts+night_endings+day_started_facts");
  assert.deepEqual(
    result.crossedBy,
    { sleep: 1, pass_out: 2, other: 0 },
    "a redelivered pass-out fact is the same night",
  );
  // The artifact published the number it WATCHED; the evidence says three. That is the disagreement, named.
  assert.equal(result.disagreement, "crossings_disagree:day_records=1:recorded=1");
  assert.deepEqual(result.observed, ["watch", "post_watch", "post_watch"]);
});

test("a crossing nothing in the run explains is `other`, and a claim larger than the world is no count at all", () => {
  // The calendar proves three nights; her own sleep crossed one; no pass-out fact names either of the others. That is a
  // recognized cause - `other` - not a mismatch, because the crossing is real and only its attribution is missing.
  const unexplained = crossingsFromEvidence({
    sleepReceipts: [receipt("r1")],
    worldNightEndings: [],
    dayStartedDays: [5, 6, 7],
  });
  assert.equal(unexplained.crossings, 3);
  assert.deepEqual(unexplained.crossedBy, { sleep: 1, pass_out: 0, other: 2 });
  assert.equal(unexplained.disagreement, null, "`other` is an answer, so nothing disagrees with it");

  // Three attributed nights against one day the world opened: two sources cannot both be right, so no number is stated.
  const impossible = crossingsFromEvidence({
    sleepReceipts: [receipt("r1"), receipt("r2")],
    worldNightEndings: [PASS_OUT_NIGHT(5)],
    dayStartedDays: [5],
  });
  assert.equal(impossible.crossings, null, "more crossings than days opened has no number");
  assert.equal(impossible.witness, null);
  assert.equal(impossible.crossedBy.pass_out, 1, "the cause counts it DID read are still published");
  assert.match(impossible.disagreement, /^crossings_disagree:/u);
});

// WHAT MAY START A MODEL TURN.
//
// The harness woke her once per programme and paid 1912.8 s of model time for 2035.8 s of wall on `round44` (109 prompt
// turns for four days, 73 of them producing no dispatch at all). A settlement is not a reason to think: it is the
// moment the harness learns that the thing it was waiting for has stopped, and the decision below says whether that
// stopping left anything for her to decide.
const ROUND44_SETTLEMENT = Object.freeze({
  // Not the first prompt of the day: this is the loop re-entering after a turn settled.
  turnIndex: 1,
  // The day's task purpose has not been achieved, so the day's objective is still open.
  objectiveMet: false,
  // The body has an accepted programme whose terminal has not arrived: the Mod's own pass continues.
  programRunning: true,
  admissionPending: false,
  // The session has been quiet for three bounds; the wake is NOT being withheld for want of quiet.
  quietMs: QUIET_BOUND_MS * 3,
  lateDay: false,
  dayEndOffered: false,
  stalled: false,
});

test("a settlement with a continuable pass in hand does not wake her", () => {
  const wake = decideDayWake(ROUND44_SETTLEMENT);
  assert.equal(wake.wake, false, "the Mod's own pass owns the next move, so there is nothing for her to decide");
  assert.equal(wake.reason, WAKE_SUPPRESSION.bodyStillWorking);
});

test("an accepted dispatch with no terminal is body work, whatever the snapshot says the actor is free", () => {
  // `activeExecution` is the Mod's projection of the execution it is running; an admission it accepted and has not
  // terminated is a pass that WILL re-enter, and a wake on it would be a wake on a pass that is still going.
  const admitted = decideDayWake({ ...ROUND44_SETTLEMENT, programRunning: false, admissionPending: true });
  assert.equal(admitted.wake, false);
  assert.equal(admitted.reason, WAKE_SUPPRESSION.bodyStillWorking);
});

test("a quiet session that has not been quiet for the bound is not a wake either", () => {
  const recent = decideDayWake({
    ...ROUND44_SETTLEMENT,
    programRunning: false,
    quietMs: QUIET_BOUND_MS - 1,
  });
  assert.equal(recent.wake, false);
  assert.equal(recent.reason, WAKE_SUPPRESSION.quietPeriod);
});

test("an unmeasured quiet is not a licence to wake her", () => {
  for (const quietMs of [null, undefined, Number.NaN]) {
    const wake = decideDayWake({ ...ROUND44_SETTLEMENT, programRunning: false, quietMs });
    assert.equal(wake.wake, false, `quietMs=${String(quietMs)} cannot say the session is quiet`);
    assert.equal(wake.reason, WAKE_SUPPRESSION.quietPeriod);
  }
});

test("the day's work being done is not a wake before the day is nearly over", () => {
  const done = decideDayWake({ ...ROUND44_SETTLEMENT, objectiveMet: true, programRunning: false });
  assert.equal(done.wake, false);
  assert.equal(done.reason, WAKE_SUPPRESSION.objectiveMet);
});

test("the day-end offer is made once, and asks rather than ordering", () => {
  const offer = decideDayWake({
    ...ROUND44_SETTLEMENT,
    objectiveMet: true,
    programRunning: false,
    lateDay: true,
  });
  assert.equal(offer.wake, true);
  assert.equal(offer.reason, WAKE_REASON.dayEndOffer, "a day-end offer is not a continuation of the day's work");
  const again = decideDayWake({
    ...ROUND44_SETTLEMENT,
    objectiveMet: true,
    programRunning: false,
    lateDay: true,
    dayEndOffered: true,
  });
  assert.equal(again.wake, false, "an offer that repeats until answered is the ping this change removes");
  assert.equal(again.reason, WAKE_SUPPRESSION.alreadyOffered);
});

test("the day-end offer never pre-empts a pass that can still continue", () => {
  const busy = decideDayWake({
    ...ROUND44_SETTLEMENT,
    objectiveMet: true,
    programRunning: true,
    lateDay: true,
  });
  assert.equal(busy.wake, false, "a pass that can continue is the owner, whatever the clock says");
  assert.equal(busy.reason, WAKE_SUPPRESSION.bodyStillWorking);
});

test("a stalled body wakes her whatever the objective and the body say", () => {
  // The one thing this change must NOT remove: a stall is the body not continuing, so it is exactly the moment she is
  // the only thing left that can decide.
  for (const objectiveMet of [true, false]) {
    const wake = decideDayWake({ ...ROUND44_SETTLEMENT, objectiveMet, stalled: true });
    assert.equal(wake.wake, true, `objectiveMet=${String(objectiveMet)} must not silence a stall`);
    assert.equal(wake.reason, WAKE_REASON.stallWake);
  }
});

test("a stale world reading wakes her to look, and outranks the quiet bound that would have said carry on", () => {
  // Measured 2026-11-10 (`round45`): fifty turns were issued as `continuation` while the block she was handed stayed at
  // `revision 352` - `06:00 第 6 天` through two 02:00 pass-outs and two day starts - and she dispatched nothing for the
  // last thirty minutes. A frozen picture of the world is not a quiet world.
  const stale = decideDayWake({ ...ROUND44_SETTLEMENT, programRunning: false, quietMs: 0, worldStateStale: true });
  assert.equal(stale.wake, true, "a reading older than its bound is a reason to look, whatever the silence says");
  assert.equal(stale.reason, WAKE_REASON.staleWorld);
  // A pass in hand is still the owner: it publishes its own facts, and re-reading the world would race it.
  const busy = decideDayWake({ ...ROUND44_SETTLEMENT, programRunning: true, worldStateStale: true });
  assert.equal(busy.wake, false, "a pass that can continue owns the next move, stale picture or not");
  assert.equal(busy.reason, WAKE_SUPPRESSION.bodyStillWorking);
  // A stall is the body saying it will not continue, which outranks a stale picture: that one changes what she should do
  // first, and it is still a wake, so nothing is lost by the ordering but the reason's own name.
  const both = decideDayWake({ ...ROUND44_SETTLEMENT, programRunning: false, stalled: true, worldStateStale: true });
  assert.equal(both.reason, WAKE_REASON.stallWake);
});

test("the first prompt of a day is the day's own opening, whatever the world is doing", () => {
  const opening = decideDayWake({ ...ROUND44_SETTLEMENT, turnIndex: 0 });
  assert.equal(opening.wake, true, "a day begins by asking her, and that is not a settlement-driven wake");
  assert.equal(opening.reason, WAKE_REASON.dayStart);
});

/**
 * The span a staleness is measured over: ONE PROMPT TURN OF THIS RUN, not a constant of the decider.
 *
 * `round45` issued 62 prompt turns in 2510 s, so one turn of that run is about 40 s; the runner measures its own median
 * interval and passes it, and this number only stands in for it in a replay.
 */
const MEASURED_TURN_SPAN_MS = 40_000;

/**
 * Every reason the day loop's decider can answer, each with the facts that make it answer it.
 *
 * A TABLE rather than a set of assertions, because the population is `DECIDER_WAKE_REASONS`: a reason added to the
 * closed set with no producer here fails `declared_reason_unreachable:<reason>`, and a producer for a reason nobody
 * declares fails the same test from the other side. Measured 2026-11-11 (`round45`): `day_end_offer` was declared and
 * wired and was answered ZERO times in a whole run - `decideWake` returned `continuation` whenever `objectiveMet !==
 * true`, so all 60 wakes of that run took the one branch and the offer branch was never reached.
 */
const DAY_LOOP_PRODUCERS = Object.freeze({
  day_start: () => decideDayWake({ ...ROUND44_SETTLEMENT, turnIndex: 0 }).reason,
  continuation: () => decideDayWake({ ...ROUND44_SETTLEMENT, programRunning: false }).reason,
  stall_wake: () => decideDayWake({ ...ROUND44_SETTLEMENT, stalled: true }).reason,
  stale_world: () => decideDayWake({ ...ROUND44_SETTLEMENT, programRunning: false, worldStateStale: true }).reason,
  day_end_offer: () =>
    decideDayWake({ ...ROUND44_SETTLEMENT, objectiveMet: true, programRunning: false, lateDay: true }).reason,
  objective_unreachable_for_today: () =>
    decideDayWake({
      ...ROUND44_SETTLEMENT,
      programRunning: false,
      lateDay: true,
      objectiveProgressSinceMs: MEASURED_TURN_SPAN_MS * 2,
      objectiveSpanMs: MEASURED_TURN_SPAN_MS,
    }).reason,
});

test("the day loop can reach every wake reason it declares, and no other", () => {
  console.log(
    `wake gate: examined ${String(DECIDER_WAKE_REASONS.length)} declared reason(s): ${DECIDER_WAKE_REASONS.join(", ")}`,
  );
  for (const reason of DECIDER_WAKE_REASONS) {
    const produce = DAY_LOOP_PRODUCERS[reason];
    assert.equal(typeof produce, "function", `declared_reason_unreachable:${reason}`);
    assert.equal(produce(), reason, `declared_reason_unreachable:${reason}`);
  }
  assert.deepEqual(
    Object.keys(DAY_LOOP_PRODUCERS).sort(),
    [...DECIDER_WAKE_REASONS].sort(),
    "a declared reason with no producer, or a producer for a reason nobody declares",
  );
});

// THE OBJECTIVE HAS THREE STATES, AND THE CONFLATION OF TWO IS THE DEFECT.
//
// `round45`: day 2 asked for `a_fish_from_the_water` while the day's admitted actions were `enter_exit` and `move_to_tile`
// - there was no `fish_here` in its reach - so the purpose judge answered `not_achieved` for the whole day and every wake
// was issued as `continuation`. She was never asked whether to end the day and the engine passed her out twice.
test("an achieved, an advancing and a stalled objective are three answers, and only the last one says today cannot finish", () => {
  assert.equal(
    readObjectiveState({ objectiveMet: true, sinceProgressMs: 0, spanMs: MEASURED_TURN_SPAN_MS }).state,
    OBJECTIVE_STATE.achieved,
    "the judge's own word outranks any span: there is nothing left to measure",
  );
  assert.equal(
    readObjectiveState({ sinceProgressMs: MEASURED_TURN_SPAN_MS - 1, spanMs: MEASURED_TURN_SPAN_MS }).state,
    OBJECTIVE_STATE.advancing,
    "progress inside the span is progress",
  );
  assert.equal(
    readObjectiveState({ sinceProgressMs: MEASURED_TURN_SPAN_MS, spanMs: MEASURED_TURN_SPAN_MS }).state,
    OBJECTIVE_STATE.stalled,
    "a whole measured turn with the objective's reading unchanged is the stall",
  );
  // AN UNMEASURED SPAN IS NOT A STALL: `null`/`NaN` on either side names what was missing and answers `advancing`.
  for (const facts of [
    { sinceProgressMs: 10 * MEASURED_TURN_SPAN_MS, spanMs: null },
    { sinceProgressMs: 10 * MEASURED_TURN_SPAN_MS, spanMs: 0 },
    { sinceProgressMs: null, spanMs: MEASURED_TURN_SPAN_MS },
    { sinceProgressMs: Number.NaN, spanMs: MEASURED_TURN_SPAN_MS },
  ]) {
    const state = readObjectiveState(facts);
    assert.equal(state.state, OBJECTIVE_STATE.advancing, JSON.stringify(facts));
    assert.match(String(state.because), /^objective_(span|progress)_unmeasured$/u);
  }
});

/**
 * A day replayed through the decider: one poll per entry, carrying the purpose reading the judge published at that moment.
 *
 * Progress is the READING's own change (`objectiveProgressKey`), which is what the runner observes, rather than a count
 * the replay invents. `dayEndOffered` is set by whatever this decider answered, so a replay exercises the once-per-day
 * rule the runner keeps.
 */
function replayDay({ polls, objectiveSpanMs = MEASURED_TURN_SPAN_MS, quietMs = QUIET_BOUND_MS * 2 }) {
  const wakes = [];
  let progressKey = null;
  let progressAtMs = 0;
  let nowMs = 0;
  let dayEndOffered = false;
  for (const poll of polls) {
    nowMs += poll.everyMs;
    const key = objectiveProgressKey(poll.reading);
    if (key !== progressKey) {
      progressKey = key;
      progressAtMs = nowMs;
    }
    const wake = decideDayWake({
      turnIndex: wakes.length === 0 ? 0 : 1,
      objectiveMet: poll.reading.state === "achieved",
      objectiveProgressSinceMs: nowMs - progressAtMs,
      objectiveSpanMs,
      programRunning: false,
      admissionPending: false,
      quietMs,
      lateDay: poll.lateDay === true,
      dayEndOffered,
      stalled: false,
      worldStateStale: false,
    });
    wakes.push(wake);
    if (wake.reason === WAKE_REASON.dayEndOffer || wake.reason === WAKE_REASON.objectiveUnreachableForToday)
      dayEndOffered = true;
  }
  return wakes;
}

/** The round45 day-2 reading: a purpose whose admitted actions never change because the action it needs was not there. */
const STILL_FISHING_READING = Object.freeze({
  state: "not_achieved",
  admittedActionIds: Object.freeze(["enter_exit", "move_to_tile"]),
});

const pollsOf = (reading, { lateDay, count = 10, everyMs = MEASURED_TURN_SPAN_MS }) =>
  Array.from({ length: count }, () => ({ reading, lateDay, everyMs }));

test("objective_state_conflates_stalled_and_advancing: a still objective past the evening is offered, a moving one is not", () => {
  const still = replayDay({ polls: pollsOf(STILL_FISHING_READING, { lateDay: true }) });
  const offer = still.find((wake) => wake.reason === WAKE_REASON.objectiveUnreachableForToday);
  assert.ok(
    offer !== undefined,
    "a still objective past the evening is a day that can be ended, and she must be asked",
  );
  assert.ok(offer.wake === true);
  // THE CONDITIONS PRINT WITH IT: every fact the branch read, named.
  assert.deepEqual(
    [...offer.conditions].map((condition) => condition.split("=")[0]),
    ["objective_state", "since_objective_progress_ms", "objective_span_ms", "objective_span_source", "late_day"],
  );
  assert.ok(offer.conditions.includes("objective_state=stalled"));
  assert.ok(offer.conditions.includes(`objective_span_ms=${String(MEASURED_TURN_SPAN_MS)}`));
  assert.ok(offer.conditions.includes("late_day=true"));
  // Asked ONCE per day: an offer repeated until answered is the ping this decider exists to remove.
  assert.equal(
    still.filter((wake) => wake.reason === WAKE_REASON.objectiveUnreachableForToday).length,
    1,
    "the day-end offer is one per day, whatever the polls do after it",
  );

  // THE SAME DAY, WITH AN OBJECTIVE THAT KEEPS MOVING: every poll changes the reading, so it is `advancing` and the day is
  // never called unfinishable. This is the other half of the conflation, and without it the new reason would be a timer.
  const moving = replayDay({
    polls: pollsOf(STILL_FISHING_READING, { lateDay: true }).map((poll, index) => ({
      ...poll,
      reading: { state: "not_achieved", admittedActionIds: ["till_soil"], patchTiles: index },
    })),
  });
  assert.equal(
    moving.some((wake) => wake.reason === WAKE_REASON.objectiveUnreachableForToday),
    false,
    "an objective whose reading moves is still being worked on, whatever the clock says",
  );
  assert.ok(moving.some((wake) => wake.reason === WAKE_REASON.continuation));

  // AND BEFORE THE EVENING THE SAME STILL OBJECTIVE IS NOT AN OFFER: the day still has hours in it.
  const early = replayDay({ polls: pollsOf(STILL_FISHING_READING, { lateDay: false }) });
  assert.equal(
    early.some((wake) => wake.reason === WAKE_REASON.objectiveUnreachableForToday),
    false,
    "`unreachable_for_today` names a day that is nearly over, not an objective that is hard",
  );
  assert.ok(early.some((wake) => wake.reason === WAKE_REASON.continuation));

  // WHAT THE DECIDER ANSWERED BEFORE THIS CHANGE, from the same replay: with no span there is no third state, every poll
  // is `continuation`, and the day is never offered - which is exactly `round45`'s 60 wakes and two 02:00 pass-outs.
  const noSpan = replayDay({ polls: pollsOf(STILL_FISHING_READING, { lateDay: true }), objectiveSpanMs: null });
  assert.equal(
    noSpan.some((wake) => wake.reason === WAKE_REASON.objectiveUnreachableForToday),
    false,
  );
  assert.equal(
    noSpan.filter((wake) => wake.reason === WAKE_REASON.continuation).length,
    noSpan.length - 1,
    "one measured span, and the one branch that conflated `still working` with `cannot be done today` is gone",
  );
});

test("a stale world is asked about before a still objective, because seeing comes before deciding", () => {
  // The ordering is the one `decideWake` keeps above the objective: `stale_world` says we cannot see the world, the
  // still objective says we can see it and it is not moving. Both are wakes, so only the reason's name is at stake - and
  // it is the name a reader needs beside a frozen block.
  const both = decideDayWake({
    ...ROUND44_SETTLEMENT,
    programRunning: false,
    lateDay: true,
    worldStateStale: true,
    objectiveProgressSinceMs: MEASURED_TURN_SPAN_MS,
    objectiveSpanMs: MEASURED_TURN_SPAN_MS,
  });
  assert.equal(both.reason, WAKE_REASON.staleWorld);
  const seenButStill = decideDayWake({
    ...ROUND44_SETTLEMENT,
    programRunning: false,
    lateDay: true,
    worldStateStale: false,
    objectiveProgressSinceMs: MEASURED_TURN_SPAN_MS,
    objectiveSpanMs: MEASURED_TURN_SPAN_MS,
  });
  assert.equal(seenButStill.reason, WAKE_REASON.objectiveUnreachableForToday);
});

// WHAT THE RUN SAYS IT ISSUED, JUDGED AGAINST THE REASONS THE DECIDER OWNS.
//
// `round45`'s own wake account, verbatim from `multiday.wakes.byReason` of
// `2026-11-10T22-13-25-922Z-multiday_routine`. It is the red proof for the gate below: two of the reasons the decider
// declares were issued zero times in a run that lasted 41.9 minutes.
const ROUND45_WAKE_ACCOUNT = Object.freeze({ day_start: 2, continuation: 60, stall_wake: 0, day_end_offer: 0 });

test("wake_reason_never_reachable: a run's own wake account names every reason it never produced", () => {
  const reading = wakeReasonReachability({ byReason: ROUND45_WAKE_ACCOUNT });
  console.log(
    `wake gate: examined ${String(reading.examined.length)} declared reason(s): ${reading.examined.join(", ")}`,
  );
  assert.deepEqual(
    [...reading.examined],
    [...DECIDER_WAKE_REASONS],
    "the population comes from the decider, not a list here",
  );
  assert.equal(reading.issued.continuation, 60);
  assert.ok(
    reading.violations.includes("wake_reason_never_reachable:day_end_offer"),
    "round45 never asked her whether to end the day: the offer branch was unreachable while the objective was not achieved",
  );
  assert.ok(
    reading.violations.includes("wake_reason_never_reachable:objective_unreachable_for_today"),
    "and the reason for exactly that case did not exist when the run was made",
  );
  assert.ok(!reading.violations.includes("wake_reason_never_reachable:continuation"));
  // A run that published no wake account is NOT a run that issued nothing.
  const unmeasured = wakeReasonReachability({ byReason: null });
  assert.ok(unmeasured.unmeasured !== null, "an unread account names itself unmeasured rather than counting zero");
  assert.deepEqual(unmeasured.violations, []);
  assert.deepEqual(unmeasured.neverIssued, []);
});
