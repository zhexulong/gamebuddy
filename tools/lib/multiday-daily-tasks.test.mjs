import assert from "node:assert/strict";
import test from "node:test";

import {
  DAILY_TASK_ACTION_HINTS,
  DAILY_TASK_ROTATION,
  dailyTaskFor,
  runOffsetFor,
  overriddenTaskForDay,
} from "./multiday-daily-tasks.mjs";

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
