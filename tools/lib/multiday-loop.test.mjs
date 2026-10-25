// The multi-day loop's falsifiers: the night must not be declared crossed while a menu still holds the
// actor, a menu the product must not close must stop the run BY NAME, and the companion must be the one
// that ends the day.
import assert from "node:assert/strict";
import test from "node:test";

import { assessMultiDayBaseline } from "./multiday-baseline.mjs";
import {
  closeIsEngineCommitted,
  classifyActorHold,
  decideHeldMenu,
  readHeldMenu,
  runMultiDayLoop,
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
