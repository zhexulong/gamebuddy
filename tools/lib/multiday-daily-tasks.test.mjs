import assert from "node:assert/strict";
import test from "node:test";

import {
  DAILY_TASK_ACTION_HINTS,
  DAILY_TASK_ROTATION,
  dailyTaskFor,
  dayTaskSchedule,
  describeTaskDelivery,
  overriddenTaskForDay,
  readTaskDelivery,
  runOffsetFor,
} from "./multiday-daily-tasks.mjs";

/**
 * A fake multi-day session: the loop starts a day, which SCHEDULES its task, and then that day's first turn either reaches
 * the companion (DELIVERED) or the run stops before it - the `turn_unsettled` shape a real run can end on.
 */
const fakeSession = ({ schedule, daysEntered, askedFor = (_day, task) => task }) => {
  const scheduled = [];
  const delivered = [];
  for (let day = 1; day <= daysEntered; day += 1) {
    const task = schedule(day);
    scheduled.push({ day, task });
    const asked = askedFor(day, task);
    if (asked !== null) delivered.push({ day, task: asked });
  }
  return readTaskDelivery({ scheduled, delivered });
};

/**
 * The rotation has two independent jobs, and a test that only checked one would let the other regress.
 *
 *   WITHIN A RUN: consecutive days get different tasks, so one run covers several capabilities and the night
 *   crossing is also a task switch.
 *   BETWEEN RUNS: the first day's task moves, so consecutive runs do not all begin the same way.
 */
test("consecutive days of one run get different tasks", () => {
  for (let runOffset = 0; runOffset < DAILY_TASK_ROTATION.length; runOffset += 1) {
    assert.notEqual(
      dailyTaskFor(runOffset, 1),
      dailyTaskFor(runOffset, 2),
      `run offset ${String(runOffset)} repeated its first task on day 2`,
    );
  }
});

test("the first day's task advances between runs", () => {
  const firsts = DAILY_TASK_ROTATION.map((_, runOffset) => dailyTaskFor(runOffset, 1));
  assert.equal(
    new Set(firsts).size,
    DAILY_TASK_ROTATION.length,
    `runs must not all begin with the same task: ${firsts.join(",")}`,
  );
  assert.equal(firsts[0], DAILY_TASK_ROTATION[0]);
  assert.equal(firsts[1], DAILY_TASK_ROTATION[1]);
});

test("a run that spans the whole rotation covers every task exactly once", () => {
  const covered = DAILY_TASK_ROTATION.map((_, index) => dailyTaskFor(0, index + 1));
  assert.deepEqual(
    [...covered].sort(),
    [...DAILY_TASK_ROTATION].sort(),
    `a full-length run should cover every task: ${covered.join(",")}`,
  );
});

test("more days than tasks wraps rather than failing", () => {
  // A run may be configured longer than the rotation. Wrapping is more useful than a crash, and the same day
  // number must always produce the same task or the artifact stops being reproducible.
  //
  // Read the length: this asserted "day 6 is day 1" with the rotation hard-coded at five, so it went red the moment a
  // sixth task was added - a test pinning the SIZE of a list rather than the property that the list wraps.
  const sixth = dailyTaskFor(0, 6);
  assert.equal(sixth, DAILY_TASK_ROTATION[5 % DAILY_TASK_ROTATION.length]);
  const wrapped = dailyTaskFor(0, DAILY_TASK_ROTATION.length + 1);
  assert.equal(wrapped, dailyTaskFor(0, 1), "one more than the rotation length is day 1 again");
});

test("the offset is derived from completed runs, not stored", () => {
  // Derived, so it cannot drift from the artifacts on disk; there is no second authority to disagree with.
  assert.equal(runOffsetFor(0), 0);
  assert.equal(runOffsetFor(1), 1);
  assert.equal(runOffsetFor(DAILY_TASK_ROTATION.length), 0);
  assert.equal(runOffsetFor(7), 7 % DAILY_TASK_ROTATION.length);
});

test("nonsense input produces a valid task rather than throwing", () => {
  // The runner may hand these from parsed CLI/env values. A rotation helper that throws would turn a bad
  // environment variable into a crash instead of a run with a defined first task.
  for (const [offset, day] of [
    [Number.NaN, 1],
    [0, Number.NaN],
    [-1, 1],
    [0, -5],
    [1.9, 2.7],
  ]) {
    const task = dailyTaskFor(offset, day);
    assert.ok(DAILY_TASK_ROTATION.includes(task), `(${String(offset)}, ${String(day)}) -> ${String(task)}`);
  }
});

test("every task names at least one published action", () => {
  // A task whose hints were empty would silently measure nothing. A task naming an unpublished action would
  // measure a capability gap instead of the behaviour the run exists to observe.
  for (const task of DAILY_TASK_ROTATION) {
    const hints = DAILY_TASK_ACTION_HINTS[task];
    assert.ok(Array.isArray(hints) && hints.length > 0, `${task} has no action hints`);
    for (const actionId of hints) {
      assert.match(actionId, /^[a-z][a-z0-9_]*$/u, `${task}: ${actionId} is not an action id`);
    }
  }
});

/**
 * A capability that needs its own day has to be nameable.
 *
 * MEASURED 2026-11-09 (round42): day 1 was forced to `clear_and_plant_long_patch`, day 2 came out as `mine_delve`, and
 * the fishing day that had just entered the rotation could not appear in a two-night run at all - the override moves
 * only the first day, and the rotation offset does not follow it.
 */
test("a day can be pinned to its own task, and the pin names what it cannot apply", () => {
  const pinned = overriddenTaskForDay("2:a_fish_from_the_water");
  assert.equal(pinned(2), "a_fish_from_the_water", "the pinned day answers its own task");
  assert.equal(pinned(1), undefined, "an unpinned day answers nothing, so the caller keeps the rotation");

  assert.equal(overriddenTaskForDay(undefined), undefined, "no spec leaves the rotation alone");
  assert.equal(overriddenTaskForDay("  "), undefined, "a blank spec leaves the rotation alone");
  assert.throws(() => overriddenTaskForDay("2:no_such_task"), /unknown daily task/u, "an unknown id fails the launch");
  assert.throws(
    () => overriddenTaskForDay("zero:a_fish_from_the_water"),
    /positive integer/u,
    "a non-numeric day fails",
  );
  assert.throws(
    () => overriddenTaskForDay("2:a_fish_from_the_water,2:till_and_sow"),
    /twice/u,
    "the same day pinned twice is refused: one of the two would be silently ignored",
  );
});

/**
 * A CAPABILITY THAT NEEDS A LATER DAY IS SCHEDULED **AND DELIVERED** ON THAT DAY.
 *
 * `GAMEBUDDY_TASK_FOR_DAY="2:a_fish_from_the_water"` on a two-night run: day 1 keeps the rotation, day 2 is the fishing
 * day. The pin was added on 2026-11-09 because `GAMEBUDDY_FIRST_DAY_TASK` can only move the FIRST day, and this is the
 * regression that keeps the later day reachable - the scheduling path is driven here against a fake session instead of
 * being read off the runner's source, so a composition that drops a day fails a test rather than a 34-minute run.
 */
test("a task pinned to a later day is scheduled and delivered on that day (2026-11-09)", () => {
  const schedule = dayTaskSchedule({
    runOffset: 0,
    firstDayTask: "clear_and_plant_long_patch",
    pinnedTaskForDay: overriddenTaskForDay("2:a_fish_from_the_water"),
    // Every task counts as decidable here: this test is about the three NAMING sources, and the rule that keeps a run
    // from being judged by nothing has its own test below.
    judgesAPublishedFact: () => true,
  });
  const session = fakeSession({ schedule, daysEntered: 2 });
  const day1 = dailyTaskFor(0, 1);
  // The three sources say which day each one owns: `firstDayTask` moved day 1, the pin moved day 2, and both are the
  // task the RUN decided rather than the rotation's answer.
  assert.deepEqual(session.scheduled, { day1: "clear_and_plant_long_patch", day2: "a_fish_from_the_water" });
  assert.deepEqual(
    session.delivered,
    { day1: "clear_and_plant_long_patch", day2: "a_fish_from_the_water" },
    "both days' tasks reach the companion, in day order",
  );
  assert.deepEqual(session.notDelivered, []);
  assert.deepEqual(session.mismatched, []);
  // ONE SPELLING: the line travels with the reading, so a log and an artifact cannot state it two ways.
  assert.equal(session.reading, describeTaskDelivery(session));
  assert.equal(
    describeTaskDelivery(session),
    "tasks_scheduled: day1=clear_and_plant_long_patch, day2=a_fish_from_the_water; " +
      "tasks_delivered: day1=clear_and_plant_long_patch, day2=a_fish_from_the_water",
    "the line states both halves side by side",
  );
  // With no pin and no first-day override, day 1 is the rotation's and day 2 is not the pinned task - the pin is not a
  // rotation change, which is what keeps a series of runs covering different days.
  const rotationOnly = dayTaskSchedule({ runOffset: 0, judgesAPublishedFact: () => true });
  assert.equal(rotationOnly(1), day1);
  assert.notEqual(rotationOnly(2), "a_fish_from_the_water");
});

/**
 * A TASK THE RUN DECIDED ON AND NEVER DELIVERED IS NAMED, NOT ASSUMED.
 *
 * Measured 2026-11-11 (`round46`): the run was asked for two nights, delivered day 1's task, and its bundle said nothing
 * about day 2's task having been scheduled and dropped - so "the fishing day was asked for" and "it never was" read the
 * same. The reading is the difference, and it has to be able to fire.
 */
test("a scheduled day whose first turn never ran is named (round46)", () => {
  const schedule = dayTaskSchedule({
    runOffset: 0,
    pinnedTaskForDay: overriddenTaskForDay("2:a_fish_from_the_water"),
    judgesAPublishedFact: () => true,
  });
  // The loop started day 2, so its task was scheduled; the run ended before that day's first turn reached her.
  const stopped = fakeSession({ schedule, daysEntered: 2, askedFor: (day, task) => (day === 1 ? task : null) });
  assert.deepEqual(
    stopped.notDelivered,
    ["task_not_delivered:2:a_fish_from_the_water"],
    `a pin nobody was asked is named by day and task; got ${JSON.stringify(stopped.notDelivered)}`,
  );
  assert.deepEqual(stopped.delivered, { day1: dailyTaskFor(0, 1) }, "the day that WAS delivered is still reported");
  // A day asked for a DIFFERENT task than the one scheduled is named too: the run would otherwise be judged against a
  // task it was never given.
  const substituted = fakeSession({
    schedule,
    daysEntered: 2,
    askedFor: (day, task) => (day === 2 ? "mine_delve" : task),
  });
  assert.deepEqual(
    substituted.mismatched,
    ["task_delivered_differs_from_scheduled:2:a_fish_from_the_water:mine_delve"],
    `a substituted task is named by both its values; got ${JSON.stringify(substituted.mismatched)}`,
  );
  // And a run that delivered every scheduled day has nothing to report - the reading is not a permanent red.
  assert.deepEqual(fakeSession({ schedule, daysEntered: 2 }).notDelivered, []);
});

/**
 * THE RULE THAT KEEPS A RUN FROM BEING JUDGED BY NOTHING, measured at the schedule rather than at the rotation table.
 *
 * <p>
 * Measured on `round84`: `state: blocked`, `reason task_purposes_nothing_judged:3of3` - day 1
 * `sweep_animals_and_company`, day 2 `sweep_carried_things`, day 3 `clear_east_patch`, three criteria whose facts
 * nothing publishes - while `violations 0`, `crossings 2 of 2` and every night agreed with the world. Nothing was wrong
 * with the days; the ROTATION had scheduled nothing a run can be judged on. The rotation's order is a coverage plan
 * somebody argued for, so the days are not re-ordered: the walk skips an unjudgeable entry when the day before it was
 * unjudgeable too, which is the smallest thing that makes every run of two or more days carry a judgeable one.
 * </p>
 * <p>
 * The pool here is injected, which is why the rule is falsifiable at all: the repository's own rotation has no such
 * pool any more, and a rule that can only be exercised on a healthy rotation is a rule nobody can see break. The real
 * rotation is held to it by `a_run_is_never_scheduled_on_days_nothing_can_judge` in `task-purpose.test.mjs`.
 * </p>
 */
test("an unjudgeable day is never scheduled directly after another one", () => {
  const decided = (task) => task.startsWith("decided_");
  const schedule = dayTaskSchedule({
    runOffset: 0,
    judgesAPublishedFact: decided,
    rotation: ["gap_a", "gap_b", "gap_c", "decided_1", "decided_2", "decided_3"],
  });
  assert.deepEqual(
    [1, 2, 3, 4].map((day) => schedule(day)),
    ["gap_a", "decided_1", "decided_2", "decided_3"],
    "the second unjudgeable day of a pair takes the next day the evidence decides, and the walk continues from it",
  );
  // A POOL WITH NOTHING TO CHOOSE. The rule cannot invent a day the evidence decides, and it must not pretend to: the
  // schedule answers the rotation, and the run is judged by nothing - which is the pool the gate over the real rotation
  // fails on, naming the days it chose.
  const nothingToChoose = dayTaskSchedule({
    runOffset: 0,
    judgesAPublishedFact: decided,
    rotation: ["gap_a", "gap_b", "gap_c"],
  });
  assert.deepEqual(
    [1, 2, 3].map((day) => nothingToChoose(day)),
    ["gap_a", "gap_b", "gap_c"],
  );
});

test("a schedule that cannot say which days the evidence decides is refused, not composed", () => {
  // Optional would be fail-open: a caller that forgot the predicate would get the plain rotation back and a run that
  // nobody could judge would look scheduled.
  assert.throws(() => dayTaskSchedule({ runOffset: 0 }), /task_schedule_needs_its_judgement/u);
});
