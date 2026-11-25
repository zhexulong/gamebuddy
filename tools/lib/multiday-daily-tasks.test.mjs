import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sortedDirents } from "./directory-entries.mjs";
import { judgeCrossDayContinuation } from "./multiday-baseline.mjs";
import {
  buildTaskRotation,
  CROSS_DAY_CONSTRAINT,
  crossDayConstraintLine,
  DAILY_TASK_ACTION_HINTS,
  DAILY_TASK_ROTATION,
  dailyTaskFor,
  dayTaskSchedule,
  describeScheduledPillars,
  describeTaskDelivery,
  overriddenTaskForDay,
  pillarOfTask,
  readCrossDayPairing,
  readPillarWindows,
  readTaskDelivery,
  runOffsetFor,
  SWEEP_DAILY_TASKS,
  TASK_ANY_TASKS,
  TASK_PILLAR_ORDER,
  TASK_PILLARS,
} from "./multiday-daily-tasks.mjs";
import { judgesAPublishedFact, judgeTaskPurpose, TASK_PURPOSE_CRITERIA, TOWN_MAP_ANSWERS } from "./task-purpose.mjs";

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
    () => overriddenTaskForDay("2:a_fish_from_the_water,2:mine_delve"),
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
  // With no pin and no first-day override, every day is the rotation's own answer: the pin moves the day it names and
  // nothing else. `a_fish_from_the_water` is now the rotation's own second day - the water pillar opens there - so the pin
  // agrees with the walk instead of overriding it, and the days on either side are left where the rotation put them.
  const rotationOnly = dayTaskSchedule({ runOffset: 0, judgesAPublishedFact: () => true });
  assert.equal(rotationOnly(1), day1);
  assert.equal(rotationOnly(2), dailyTaskFor(0, 2));
  assert.equal(rotationOnly(3), dailyTaskFor(0, 3), "a pin on day 2 leaves day 3 where the rotation put it");
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

const stepReceipts = (actionId, count) => {
  const details = {
    shop_purchase: {
      reasonCode: "item_purchased",
      detail:
        "shop=SeedShop;location=SeedShop;owner=Pierre;entry=npc_owner;item=(O)472;requested=25;purchased=25;unit_price=20;money_before=1060;money_after=560;owned_before=0;owned_after=25;gained=25;stock_before=2147483647;stock_after=2147483647;owner_tile=4,17;menu_closed=true;clicks=ok;drops=ok",
    },
    till_soil: (x, y) => ({
      reasonCode: "soil_tilled",
      detail: `location=Farm;target=${String(x)},${String(y)};tool_selected=hoe;slot=3;tool_before=none;slot_before=0;before=none;after=HoeDirt;charge_requested=0;charge_applied=0;window=${String(x - 5)},${String(y - 5)}:${String(x + 5)},${String(y + 5)};tiles_changed=1;changed=${String(x)}:${String(y)};stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2;tool_restored=none`,
    }),
    plant_seed: (x, y) => ({
      reasonCode: "seed_planted",
      detail: `location=Farm;target=soil_01;tile=${String(x)},${String(y)};item=(O)472;crop=Parsnip;inventory_before=25;inventory_after=24`,
    }),
    water_crop: (x, y) => ({
      reasonCode: "crop_watered",
      detail: `location=Farm;target=crop_${String(x)}_${String(y)};tile=${String(x)},${String(y)};tool_selected=watering_can;slot=2;tool_before=watering_can;slot_before=2;before_watered=false;after_watered=true;water_before=40;water_after=39;water_consumed=true;water_expected_cost=1;charge_requested=0;charge_applied=0;window=${String(x - 5)},${String(y - 5)}:${String(x + 5)},${String(y + 5)};tiles_changed=1;changed=${String(x)}:${String(y)};stamina_before=254;stamina_after=252;stamina_delta=-2;expected_stamina_cost=2;tool_restored=watering_can`,
    }),
  };
  const entry = details[actionId];
  return Array.from({ length: count }, (_, index) => {
    const resolved = typeof entry === "function" ? entry(12 + index, 4) : entry;
    return Object.freeze({
      actionId,
      state: "succeeded",
      reasonCode: resolved.reasonCode,
      evidence: { detail: resolved.detail },
    });
  });
};

test("the_rotation_leads_with_concrete_decidable_work", (t) => {
  const scenarioTasks = DAILY_TASK_ROTATION.slice(0, DAILY_TASK_ROTATION.length - SWEEP_DAILY_TASKS.length);
  const findings = [];
  const opener = scenarioTasks[0];
  const openerEntry = TASK_PURPOSE_CRITERIA[opener];
  if (!judgesAPublishedFact(opener)) {
    findings.push(`rotation_opener_is_unjudgeable:${opener}`);
  } else if (
    openerEntry?.patch === undefined &&
    !(openerEntry?.steps ?? []).some((candidate) => (candidate.count ?? 1) >= 15)
  ) {
    findings.push(`rotation_opener_lacks_quantified_scale:${opener}`);
  }
  for (let index = 0; index + 1 < scenarioTasks.length; index += 1) {
    const left = scenarioTasks[index];
    const right = scenarioTasks[index + 1];
    if (!(judgesAPublishedFact(left) || judgesAPublishedFact(right))) {
      findings.push(`adjacent_unjudgeable_scenario_pair:${left}->${right}`);
    }
  }
  // A POOL WITH ONE SHAPE, AND THE FLOOR IS ONE. It was two while the `2x18` market bed existed beside the `3x20`
  // strip; the bed was cut for measuring the same shape smaller, so the floor is the shape criterion itself - zero is
  // the red, and a rotation that drops every patch day stops asking for a plot longer than one screen.
  const patchTasks = DAILY_TASK_ROTATION.filter((task) => TASK_PURPOSE_CRITERIA[task]?.patch !== undefined);
  if (patchTasks.length < 1) {
    findings.push(`insufficient_patch_tasks:${String(patchTasks.length)} (${patchTasks.join(", ")})`);
  }
  const shopAndSowTasks = DAILY_TASK_ROTATION.filter((task) => {
    const entry = TASK_PURPOSE_CRITERIA[task];
    const steps = entry?.steps ?? [];
    const sows = entry?.sownBy ?? [];
    const buys =
      steps.some((candidate) => candidate.actionId === "shop_purchase") ||
      (entry?.boughtBy ?? []).includes("shop_purchase");
    // The scale is the same fact in either shape: a counted `plant_seed` step, or a plot of tiles the sowing has to fill.
    const sowsScaled =
      steps.some((candidate) => candidate.actionId === "plant_seed" && (candidate.count ?? 1) >= 15) ||
      (sows.some((proof) => proof.actionId === "plant_seed") && (entry?.plot?.tiles ?? 0) >= 15);
    return buys && sowsScaled;
  });
  if (shopAndSowTasks.length < 1) {
    findings.push(`missing_shop_purchase_plus_scaled_sowing_task:${String(shopAndSowTasks.length)}`);
  }
  const reading =
    `scenario ${String(scenarioTasks.length)} · opener=${opener} · ` +
    `patches=${String(patchTasks.length)} · shop+sow=${String(shopAndSowTasks.length)}`;
  t.diagnostic(reading);
  assert.deepEqual(findings, [], `${reading}\n${findings.join("\n")}`);
});

test("a_step_with_a_count_is_not_satisfied_by_fewer_receipts", (t) => {
  const countedTasks = DAILY_TASK_ROTATION.filter(
    (task) =>
      (TASK_PURPOSE_CRITERIA[task]?.steps ?? []).some((candidate) => candidate.count !== undefined) ||
      TASK_PURPOSE_CRITERIA[task]?.plot !== undefined,
  );
  assert.ok(countedTasks.length > 0, "blocked: no rotation criterion declares a count of any kind");
  const receiptsFor = (steps, reduceTaskIndex = -1) =>
    steps.flatMap((candidate, index) => {
      const actionId = candidate.actionId === undefined ? candidate.anyOf[0] : candidate.actionId;
      const needed = candidate.count ?? 1;
      return stepReceipts(actionId, index === reduceTaskIndex ? needed - 1 : needed);
    });
  // A PLOT DECLARES ITS COUNT AS TILES, so the shortfall is one tile and not one receipt: `plotReceipts(n)` sows and
  // waters n distinct tiles, which is the only shape that satisfies the criterion at all.
  const plotReceipts = (entry, tiles) => [
    ...entry.boughtBy.flatMap((actionId) => stepReceipts(actionId, 1)),
    // `stepReceipts` names tile `(12 + index, 4)` for each unit, so the two halves land on the SAME tiles.
    ...stepReceipts("plant_seed", tiles),
    ...stepReceipts("water_crop", tiles),
  ];
  const findings = [];
  for (const task of countedTasks) {
    const entry = TASK_PURPOSE_CRITERIA[task];
    if (entry.plot !== undefined) {
      const declared = entry.plot.tiles;
      const short = judgeTaskPurpose(task, plotReceipts(entry, declared - 1));
      if (short.state !== "not_achieved")
        findings.push(`${task}: a plot of ${String(declared - 1)}/${String(declared)} tiles answered ${short.state}`);
      else if (
        !String(short.detail ?? "").includes(`${String(declared - 1)}/${String(declared)} tiles sown and watered`)
      )
        findings.push(`${task}: short verdict detail missed the tile count: ${String(short.detail ?? "")}`);
      const full = judgeTaskPurpose(task, plotReceipts(entry, declared));
      if (full.state !== "achieved")
        findings.push(`${task}: a plot of ${String(declared)} tiles answered ${full.state} (${full.reasonCode})`);
      continue;
    }
    for (const [index, candidate] of entry.steps.entries()) {
      if (candidate.count === undefined) continue;
      if (!Number.isInteger(candidate.count) || candidate.count < 2) {
        findings.push(`${task}: step ${String(index)} has invalid count ${String(candidate.count)}`);
        continue;
      }
      const short = judgeTaskPurpose(task, receiptsFor(entry.steps, index));
      if (short.state !== "not_achieved") {
        findings.push(
          `${task}: step ${String(index)} (${candidate.actionId ?? candidate.anyOf.join("/")}) passed on ` +
            `${String(candidate.count - 1)}/${String(candidate.count)} receipts (${short.state})`,
        );
      } else {
        const label = candidate.actionId ?? candidate.anyOf.join("/");
        const expectedProgress = `${label} ${String(candidate.count - 1)}/${String(candidate.count)}`;
        if (!String(short.detail ?? "").includes(expectedProgress)) {
          findings.push(`${task}: short verdict detail missed ${expectedProgress}: ${String(short.detail ?? "")}`);
        }
      }
    }
    const full = judgeTaskPurpose(task, receiptsFor(entry.steps));
    if (full.state !== "achieved") {
      findings.push(`${task}: exact count receipts answered ${full.state} (${full.reasonCode})`);
    }
  }
  t.diagnostic(`counted_criteria ${String(countedTasks.length)}: ${countedTasks.join(", ")}`);
  assert.deepEqual(findings, [], findings.join("\n"));
});

/**
 * THE PILLAR GATE: `the_rotation_walks_one_pillar_per_day`.
 *
 * <p>
 * THE DEFECT. The rotation was a flat list, and the two farm days opened it, so a three-day run could spend two of its
 * three days in one part of the game. Measured on `round96` (`tools/_multiday_routine-round96.result.json`): day 2
 * `clear_and_plant_long_patch`, day 3 `buy_seeds_and_expand_plot` - the `3x20` strip and then the seed plot, one pillar
 * for two thirds of the run.
 * </p>
 * <p>
 * THE PROPERTY, NOT AN ORDER. A schedule of up to three days never draws one pillar twice, read from the days a run
 * would actually get - `dayTaskSchedule`, so a pin, a first-day override and the substitution rule for unjudgeable days
 * are inside the population rather than beside it. `any` is exempt: it is what a slot falls back to when the pillar
 * groups are exhausted.
 * </p>
 * <p>
 * red-proof: inject  a rotation with the two farm days adjacent (the pre-pillar order, `round96`'s own days below) -> the
 *                   window reading names `task_pillar_repeats_in_three_day_run:farm:...`;
 *                   hand `buildTaskRotation` a grouping with an empty `water` group -> `task_pillar_empty:water`
 *                   (tools/lib/multiday-daily-tasks.test.mjs)
 * </p>
 */
const PILLAR_GATE = "the_rotation_walks_one_pillar_per_day";

/** The day counts a short run can have. A run of N nights ends N+1 days (`multiday-loop.mjs`); two and three are the
 * window this rule exists for, and a run that dies on day one cannot repeat a pillar at all. */
const PILLAR_WINDOW_DAY_COUNTS = Object.freeze([2, 3]);

test(PILLAR_GATE, (t) => {
  const schedules = [];
  for (const days of PILLAR_WINDOW_DAY_COUNTS) {
    for (let runOffset = 0; runOffset < DAILY_TASK_ROTATION.length; runOffset += 1) {
      const taskForDay = dayTaskSchedule({ runOffset, judgesAPublishedFact });
      const scheduled = Array.from({ length: days }, (_, index) => ({ day: index + 1, task: taskForDay(index + 1) }));
      schedules.push(Object.freeze({ runOffset, days, ...readPillarWindows({ scheduled }) }));
    }
  }
  const findings = schedules.flatMap((schedule) =>
    schedule.findings.map((code) => `${code} @offset_${String(schedule.runOffset)}/${String(schedule.days)}days`),
  );
  const pairs = schedules.reduce((total, schedule) => total + schedule.pairs, 0);
  const anyEntries = DAILY_TASK_ROTATION.filter((task) => pillarOfTask(task) === "any");
  const reading =
    `schedules ${String(schedules.length)} (${PILLAR_WINDOW_DAY_COUNTS.join("/")} days x ` +
    `${String(DAILY_TASK_ROTATION.length)} offsets) · pairs ${String(pairs)} · ` +
    `pillars ${TASK_PILLAR_ORDER.join("/")} · any ${String(anyEntries.length)}`;
  t.diagnostic(reading);
  assert.ok(pairs > 0, `${reading} - no pair of days was examined, so this gate cannot fail`);
  assert.deepEqual(findings, [], `${reading}\n${findings.join("\n")}`);
});

/**
 * THE TWO REFUSALS, ON A GROUPING THE REPOSITORY DOES NOT HAVE.
 *
 * A gate over a correct declaration can only ever pass, so both halves are falsified here: the builder is pure over the
 * groups it is handed, and an empty pillar is the shape that would silently promise a pillar the walk cannot draw.
 */
test("an empty pillar and an id filed twice are refused by name", (t) => {
  const refused = buildTaskRotation({ pillars: { ...TASK_PILLARS, water: [] } });
  assert.ok(
    refused.findings.includes("task_pillar_empty:water"),
    `an empty water group has to be refused by name; got ${refused.findings.join(",") || "(no finding)"}`,
  );
  assert.ok(refused.rotation.includes("clear_and_plant_long_patch"), "the other groups are still walked");

  const twice = buildTaskRotation({
    pillars: { ...TASK_PILLARS, mine: [...TASK_PILLARS.mine, TASK_PILLARS.farm[0]] },
  });
  assert.ok(
    twice.findings.includes(`task_filed_under_two_groups:${TASK_PILLARS.farm[0]}:farm:mine`),
    `an id filed under two groups makes the printed pillar a coin toss; got ${twice.findings.join(",") || "(no finding)"}`,
  );

  // The control: a grouping the walk can state, and the day order it produces.
  const control = buildTaskRotation({
    pillars: { farm: ["farm_day"], water: ["water_day"], mine: ["mine_day"] },
    anyTasks: ["any_day"],
    sweepTasks: [],
  });
  assert.deepEqual(control.findings, []);
  assert.deepEqual(control.rotation, ["farm_day", "water_day", "mine_day", "any_day"]);
  t.diagnostic(
    `refusals examined ${String(refused.findings.length + twice.findings.length)} · control ${control.rotation.join(",")}`,
  );
});

/** The schedule a recorded run actually got, from its own artifact: `multiday.tasks.scheduled`, in day order. */
function recordedSchedule(run) {
  const artifact = JSON.parse(
    readFileSync(new URL(`../_multiday_routine-round${String(run)}.result.json`, import.meta.url), "utf8"),
  );
  const scheduled = artifact?.multiday?.tasks?.scheduled ?? {};
  return Object.entries(scheduled)
    .map(([dayKey, task]) => ({ day: Number(dayKey.slice("day".length)), task }))
    .filter((entry) => Number.isInteger(entry.day))
    .sort((left, right) => left.day - right.day);
}

/**
 * THE THREE RECORDED RUNS, READ BY THE SAME RULE, SO THE CHANGE IS VISIBLE.
 *
 * `round95/96/97` are the last three multi-day runs on disk and their artifacts hold the schedules the old flat rotation
 * handed them. Read by the pillar rule, two of the three name the defect the criteria lane measured, and the third shows
 * the other half of the old list's shape - two `any` days - which the rule deliberately permits.
 */
test("the_recorded_runs_that_measured_one_pillar_twice_are_named", (t) => {
  const runs = [95, 96, 97].map((run) => ({
    run,
    scheduled: recordedSchedule(run),
    ...readPillarWindows({ scheduled: recordedSchedule(run) }),
  }));
  assert.ok(
    runs.every((entry) => entry.scheduled.length >= 2),
    `every run examined has at least two days on record; got ${runs.map((entry) => `${String(entry.run)}:${String(entry.scheduled.length)}`).join(",")}`,
  );
  const findingsOf = (run) => runs.find((entry) => entry.run === run)?.findings ?? [];
  assert.deepEqual(
    findingsOf(96),
    ["task_pillar_repeats_in_three_day_run:farm:day2=clear_and_plant_long_patch->day3=buy_seeds_and_expand_plot"],
    "round96 is the run the criteria lane measured: two of its three days were the farm pillar",
  );
  assert.deepEqual(
    findingsOf(97),
    ["task_pillar_repeats_in_three_day_run:farm:day1=clear_and_plant_long_patch->day2=buy_seeds_and_expand_plot"],
    "round97 opened on the same pair, on the two days it lived",
  );
  assert.deepEqual(findingsOf(95), [], "round95's two repeated days were the fallback group, not a pillar");
  for (const entry of runs) t.diagnostic(`round${String(entry.run)} ${describeScheduledPillars(entry.scheduled)}`);
  // THE CHANGE, SIDE BY SIDE: the same three-day run under the walk says which pillar each day drew.
  const taskForDay = dayTaskSchedule({ runOffset: 0, judgesAPublishedFact });
  t.diagnostic(`pillar walk ${describeScheduledPillars([1, 2, 3].map((day) => ({ day, task: taskForDay(day) })))}`);
});

test("the_schedule_prints_the_pillar_each_day_drew", () => {
  const taskForDay = dayTaskSchedule({ runOffset: 0, judgesAPublishedFact });
  const scheduled = [1, 2, 3].map((day) => ({ day, task: taskForDay(day) }));
  assert.equal(
    describeScheduledPillars(scheduled),
    "day 1: farm/clear_and_plant_long_patch · day 2: water/a_fish_from_the_water · " +
      "day 3: mine/craft_and_place_machine",
    "a run's own log has to answer which pillar it measured, in the pillars' own names",
  );
  // A day the declaration does not hold is `unfiled` rather than silently printed as one of the pillars.
  assert.equal(describeScheduledPillars([{ day: 1, task: "no_such_task" }]), "day 1: unfiled/no_such_task");
  assert.equal(describeScheduledPillars([]), "(no day scheduled)");
});

/**
 * EVERY ENTRY IS FILED ONCE, AND NOTHING IS LOST BY THE GROUPING.
 *
 * Population derived from the declaration: the three pillar groups plus `any` plus the sweep tail must be exactly the
 * rotation, with no id missing and none filed twice. A leftover the tail forgets is a day a run can never be given, which
 * is the `enter_mine` shape this pool has been caught in before.
 */
test("every rotation entry is filed under exactly one group, and the tail keeps its coverage", () => {
  const declared = [
    ...TASK_PILLAR_ORDER.flatMap((pillar) => TASK_PILLARS[pillar].map((task) => ({ task, pillar }))),
    ...TASK_ANY_TASKS.map((task) => ({ task, pillar: "any" })),
    ...SWEEP_DAILY_TASKS.map((task) => ({ task: task.id, pillar: "any" })),
  ];
  assert.ok(declared.length > 0, "the declaration holds no id at all, so this test would agree with itself");
  assert.deepEqual(
    declared
      .filter((entry) => DAILY_TASK_ROTATION.filter((task) => task === entry.task).length !== 1)
      .map((entry) => entry.task),
    [],
    "every declared id has to appear in the rotation exactly once",
  );
  assert.deepEqual(
    DAILY_TASK_ROTATION.filter((task) => pillarOfTask(task) === null),
    [],
    "a rotation entry no group holds is a day whose pillar the log would have to guess",
  );
  assert.deepEqual(
    [...DAILY_TASK_ROTATION].sort(),
    declared.map((entry) => entry.task).sort(),
    "the grouping and the rotation have to be the same population, not two lists that agree today",
  );
  for (const pillar of TASK_PILLAR_ORDER) {
    assert.ok(TASK_PILLARS[pillar].length > 0, `pillar ${pillar} is declared with no members`);
    assert.equal(pillarOfTask(TASK_PILLARS[pillar][0]), pillar, `a ${pillar} day prints its own pillar`);
  }
});

/**
 * THE CROSS-DAY CONSTRAINT: spoken once, in both locales, and no day of the pool can produce it by itself.
 *
 * Two of the three questions a memory probe has to survive are asked here, because both are about the POOL rather than
 * about a run: ① the promise's words must be the pool's single spelling and must not name the calendar, and ③ no task the
 * rotation can hand a later day may require the errand (a trap) or be the reason she does it (an ambiguity that has to be
 * declared). The third - could she have answered it by looking - is applied to a real observation in
 * `multiday-baseline.test.mjs`'s `crossDayFieldReading` tests, where the world is.
 */
test("the day-one constraint is one sentence, in both locales, and it names no day of the run", () => {
  const zh = crossDayConstraintLine("zh", 1);
  const en = crossDayConstraintLine("en", 1);
  assert.ok(zh.length > 0 && en.length > 0, "both locales have to carry the constraint, or one of them proves nothing");
  // ONCE: the days it does not belong to answer with nothing, so the note cannot restate a promise whose continuation is
  // the reading. A second sentence would also make `noteLater` differ for a reason nobody declared.
  for (const day of [2, 3, 7]) {
    assert.equal(crossDayConstraintLine("zh", day), "", `day ${String(day)} must not carry the constraint again`);
    assert.equal(crossDayConstraintLine("en", day), "");
  }
  // A sentence in a locale nobody wrote is `""` rather than invented: a run in that locale has no constraint, and a
  // judgement about a promise never spoken is not a judgement.
  assert.equal(crossDayConstraintLine("fr", 1), "");
  for (const line of [zh, en]) {
    assert.doesNotMatch(line, /[0-9]/u, "the promise must not count the days");
    assert.ok(!line.includes("第"), "the promise must not name the day it is spoken on");
  }
  // The two halves a later day is judged on are declared and non-empty; a constraint missing one of them could only ever
  // answer `not_measured`, which is the defect the corpus test below exists to catch.
  assert.ok(CROSS_DAY_CONSTRAINT.subjectTokens.length > 0, "her side has to have words to look for");
  assert.ok(CROSS_DAY_CONSTRAINT.maps.length > 0, "the world side has to name a place a receipt can prove");
  assert.ok(CROSS_DAY_CONSTRAINT.arrival.actionIds.length > 0, "and the shapes that publish that place");
});

test("no task the pool can hand a later day requires the errand, and the ones that could answer it are declared", () => {
  // ③'s two halves, from the pool's own declarations.
  //
  // (a) NO TASK REQUIRES IT. The constraint's world side is a map, and the only criterion in the pool that reads a map is
  // `town_visit`'s - which accepts ANY declared town map (`TOWN_MAP_ANSWERS`), so no day is ever satisfied only by the
  // smithy. A pool where the in-town answer set narrowed to the constraint's own maps would be a trap: the day's task
  // would hand her the errand and the run could never tell memory from the prompt.
  const inTown = Object.values(TOWN_MAP_ANSWERS)
    .filter((answer) => answer.inTown === true)
    .length;
  assert.ok(inTown > 1, `a town-visit day accepts ${String(inTown)} maps, so none of them can be required`);
  const placeReading = DAILY_TASK_ROTATION.filter((task) => TASK_PURPOSE_CRITERIA[task]?.town !== undefined);
  assert.ok(placeReading.length > 0, "the population of map-reading tasks must not be empty, or this proves nothing");
  // (b) EVERY TASK THAT COULD ANSWER IT FOR ITS OWN REASON IS DECLARED, so the ambiguity is named on the day it happens
  // instead of being counted as a continuation. The population is derived from the criteria table, so a task added or
  // edited to read a place tomorrow fails here until it is answered.
  for (const task of placeReading) {
    const answer = TASK_PURPOSE_CRITERIA[task].town.arrival;
    if (!CROSS_DAY_CONSTRAINT.arrival.actionIds.some((actionId) => answer.actionIds.includes(actionId))) continue;
    assert.ok(
      task in CROSS_DAY_CONSTRAINT.answeredByItsOwnWork,
      `${task} can arrive in the constraint's own map for its own reason, so its ambiguity has to be declared beside the constraint`,
    );
  }
  // The declared overlap is a real task, and the constraint's map is one a town day may reach: that is why the overlap
  // exists at all rather than being a hypothetical.
  for (const task of Object.keys(CROSS_DAY_CONSTRAINT.answeredByItsOwnWork)) {
    assert.ok(DAILY_TASK_ROTATION.includes(task), `${task} is declared as an overlap and is not in the rotation`);
    assert.equal(TOWN_MAP_ANSWERS[CROSS_DAY_CONSTRAINT.maps[0]].inTown, true, "the constraint's map has to be a town map");
  }
  // AND THE PAIRING READING NAMES IT, per scheduled day, leaving the schedule alone: the rotation's jobs stay the
  // rotation's, and a day that both does its work and passes the smithy is reported rather than removed.
  const pairing = readCrossDayPairing({
    scheduled: [
      { day: 1, task: DAILY_TASK_ROTATION[0] },
      { day: 2, task: Object.keys(CROSS_DAY_CONSTRAINT.answeredByItsOwnWork)[0] },
      { day: 3, task: "run_the_machines" },
    ],
  });
  assert.deepEqual(pairing.findings, [], "a declaration naming a task the pool holds is not a finding");
  assert.equal(pairing.examined, 2, "only the days AFTER the one the constraint is spoken on are paired");
  assert.equal(pairing.ambiguous, 1);
  assert.equal(pairing.days[0].answeredByItsOwnWork, CROSS_DAY_CONSTRAINT.answeredByItsOwnWork[pairing.days[0].task]);
  assert.equal(pairing.days[1].answeredByItsOwnWork, null);
  // The declaration's own hygiene: a constraint with no world side, or one naming a task the pool no longer has, is
  // refused by name rather than quietly exempting nobody.
  assert.ok(
    readCrossDayPairing({ constraint: { ...CROSS_DAY_CONSTRAINT, maps: [] } }).findings.includes(
      "cross_day_constraint_has_no_world_side",
    ),
  );
  assert.ok(
    readCrossDayPairing({ constraint: { ...CROSS_DAY_CONSTRAINT, answeredByItsOwnWork: { no_such_task: "x" } } }).findings.includes(
      "cross_day_constraint_declared_for_no_such_task:no_such_task",
    ),
  );
});

/**
 * ⑤ THE CORPUS: how many of the recorded runs' later days COULD have been judged at all.
 *
 * <p>
 * A constraint nobody could ever observe is one that answers `not_measured` for ever, and a `not_measured` verdict reads
 * exactly like a probe that was never worth running. So the schedule the pool hands a three-day run is replayed over the
 * multiday bundles on this machine: for every day after the first, the day's own receipts are read through
 * `judgeCrossDayContinuation`, and the day counts as judgeable when the world half is readable - she was somewhere a
 * receipt names, so "not the smithy" is a measurement rather than a silence.
 * </p>
 *
 * <p>
 * WHAT THE CORPUS CANNOT ANSWER, said here rather than discovered later: every recorded run predates the constraint, so
 * no day-one note carries the sentence and no run can answer `continued`. What the count does answer is the question it
 * is asked - whether a later day's world is readable enough to judge the constraint - and `spoken: false` is reported on
 * every one of them so nobody reads a corpus of `not continued` days as a corpus of companions who forgot.
 * </p>
 *
 * <p>
 * THE DAY A RECEIPT BELONGS TO is found from the run's own night crossings (`sleep` receipts and the Mod's
 * `night_ended_*` facts), in wall-clock order: a bundle carries `atMs` on every fact and no day number on any receipt, so
 * the crossing is the only boundary the artifact states. A bundle that predates `multiday.tasks.scheduled` or
 * `bridgeFacts` is not in the population at all and is counted as such.
 * </p>
 */
test("the recorded corpus says how many later days a constraint like this one could be judged on", (t) => {
  const root = new URL("../../.live-runs/game-ladder/", import.meta.url);
  const bundles = [];
  for (const entry of sortedDirents(fileURLToPath(root))) {
    if (!entry.isDirectory() || !entry.name.includes("multiday_routine")) continue;
    const file = new URL(`${entry.name}/result.json`, root);
    try {
      bundles.push(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      // A run that never wrote a result bundle is not evidence about anything, and the count below is of the ones that
      // did.
    }
  }
  const receiptOf = (fact) =>
    fact?.type === "execution_receipt" && fact.worldFactPayload !== null && typeof fact.worldFactPayload === "object"
      ? fact.worldFactPayload
      : null;
  let considered = 0;
  let laterDays = 0;
  let judgeable = 0;
  let notMeasured = 0;
  let theSmithy = 0;
  const maps = new Map();
  for (const result of bundles) {
    const scheduled = result?.multiday?.tasks?.scheduled ?? null;
    const facts = Array.isArray(result?.bridgeFacts) ? result.bridgeFacts : [];
    if (scheduled === null || facts.length === 0) continue;
    considered += 1;
    const days = Object.entries(scheduled)
      .map(([key, task]) => ({ day: Number(key.slice("day".length)), task }))
      .filter((entry) => Number.isInteger(entry.day))
      .sort((left, right) => left.day - right.day);
    const boundaries = facts
      .filter((fact) => {
        const payload = receiptOf(fact);
        if (payload !== null && payload.actionId === "sleep") return true;
        const kind = fact?.worldFactPayload?.kind ?? fact?.kind;
        return typeof kind === "string" && kind.startsWith("night_ended_");
      })
      .map((fact) => fact.atMs)
      .filter((at) => Number.isFinite(at))
      .sort((left, right) => left - right);
    const receiptsByDay = new Map();
    for (const fact of facts) {
      const payload = receiptOf(fact);
      if (payload === null || !Number.isFinite(fact.atMs)) continue;
      let day = 1;
      for (const boundary of boundaries) if (fact.atMs >= boundary) day += 1;
      if (!receiptsByDay.has(day)) receiptsByDay.set(day, []);
      receiptsByDay.get(day).push(payload);
    }
    const turns = Array.isArray(result?.sessionTurns) ? result.sessionTurns : [];
    const reading = judgeCrossDayContinuation({
      observation: result?.multiday?.dayRecords?.[0]?.after ?? null,
      days: days.map((entry) => ({
        day: entry.day,
        task: entry.task,
        delivered: turns.some((turn) => turn.day === entry.day),
        // The recorded bundles predate the constraint, so the words she was handed are the day's own goal. That is also
        // why every one of them answers `spoken: false` below.
        noteText: turns.find((turn) => turn.day === entry.day)?.goal ?? "",
        receipts: receiptsByDay.get(entry.day) ?? [],
        spokenLines: turns.filter((turn) => turn.day === entry.day).flatMap((turn) => turn.spokenLines ?? []),
      })),
    });
    laterDays += reading.examined;
    judgeable += reading.judgeable;
    notMeasured += reading.notMeasured;
    for (const day of reading.days) {
      for (const map of day.mapsSeen) maps.set(map, (maps.get(map) ?? 0) + 1);
      if (day.mapsSeen.some((map) => CROSS_DAY_CONSTRAINT.maps.includes(map))) theSmithy += 1;
    }
  }
  const mapLine = [...maps.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([map, count]) => `${map}:${String(count)}`)
    .join(" ");
  t.diagnostic(
    `CROSS_DAY_CORPUS bundles ${String(bundles.length)} · readable ${String(considered)} · later days ${String(laterDays)} · ` +
      `judgeable ${String(judgeable)} · not measured ${String(notMeasured)} · named the smithy ${String(theSmithy)} · maps ${mapLine || "(none)"}`,
  );
  // NOT MEASURED ON THIS MACHINE IS NOT A FAILURE, and it is not a pass either: a corpus that is not here says so.
  if (considered === 0) {
    t.diagnostic("CROSS_DAY_CORPUS not_measured: no recorded multiday bundle carries `multiday.tasks.scheduled`");
    return;
  }
  // THE PROPERTY THE COUNT PROTECTS: a later day's world is readable for the great majority of the corpus. A constraint
  // whose world half nobody publishes would print `judgeable 0` here, which is the reading that says "do not ship this
  // probe" rather than "the companions forgot".
  assert.ok(
    judgeable > 0,
    `no later day of ${String(laterDays)} could be judged, so this constraint answers not_measured for ever: ${mapLine}`,
  );
  assert.ok(
    judgeable * 2 >= laterDays,
    `only ${String(judgeable)} of ${String(laterDays)} later days could be judged; a constraint the world mostly cannot ` +
      `observe is a constraint that will always read not_measured (maps seen: ${mapLine || "none"})`,
  );
});
