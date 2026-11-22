/**
 * The falsifiers for `tools/check-stardew-task-action-coverage.mjs`.
 *
 * Two things are being proven here, and they are different claims:
 *
 *   THE GATE REACTS - a published action no task names fails it, an exclusion that has been overtaken fails it,
 *   and an exclusion that explains nothing fails it. Each injection changes one input and nothing else.
 *
 *   THE SWEEP IS DERIVED - an action added to the surface lands in a sweep task because of its own declared
 *   family, not because somebody typed its id. So the same population the repository has today is rebuilt from a
 *   synthetic one, and the assertion is about where the action goes rather than that a list contains it.
 *
 * red-proof: inject  a ghost action added to the population -> `uncovered_action_without_an_exclusion:ghost_action`,
 *                    and an exclusion for an action a task names -> `exclusion_names_a_covered_action:cut_weeds`
 *                    (tools/check-stardew-task-action-coverage.test.mjs)
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  readCoverageInputs,
  TASK_ACTION_EXCLUSIONS,
  taskActionCoverage,
} from "./check-stardew-task-action-coverage.mjs";
import {
  buildSweepTasks,
  DAILY_TASK_ACTION_HINTS,
  DAILY_TASK_ROTATION,
  SWEEP_DAILY_TASKS,
} from "../../tools/lib/multiday-daily-tasks.mjs";
import { readStardewActionFamilies } from "../../tools/lib/stardew-published-action-registry.mjs";
import { judgesAPublishedFact, TASK_PURPOSE_CRITERIA } from "../../tools/lib/task-purpose.mjs";

const INPUTS = readCoverageInputs();
const FAMILY_OF = readStardewActionFamilies();

test("every published execution action is named by a task or excluded with a reason", () => {
  const report = taskActionCoverage(INPUTS);
  assert.deepEqual(report.violations, [], report.violations.map((violation) => violation.code).join("; "));
  // Nothing falls between the two halves: an action is covered or it carries a blocker, never neither.
  assert.equal(report.covered + report.excluded, report.total);
  assert.equal(report.excluded, TASK_ACTION_EXCLUSIONS.length);
});

test("an uncovered action with no exclusion fails the gate", () => {
  const report = taskActionCoverage({
    actions: [...INPUTS.actions, Object.freeze({ actionId: "ghost_action", lifecycle: "published" })],
    taskActionHints: INPUTS.taskActionHints,
  });
  assert.deepEqual(
    report.violations.map((violation) => violation.code),
    ["uncovered_action_without_an_exclusion:ghost_action"],
  );
  // The population grew, the covered set did not: the new action is the whole finding.
  assert.equal(report.covered, taskActionCoverage(INPUTS).covered);
  assert.equal(report.total, INPUTS.actions.length + 1);
  assert.deepEqual(
    report.uncovered.filter((entry) => entry.reason === null).map((entry) => [entry.actionId, entry.lifecycle]),
    [["ghost_action", "published"]],
  );
});

test("an exclusion whose action a task does name fails, so the table cannot rot", () => {
  const report = taskActionCoverage({
    ...INPUTS,
    exclusions: [...TASK_ACTION_EXCLUSIONS, { actionId: "cut_weeds", reason: "a blocker that was true yesterday" }],
  });
  assert.ok(
    report.violations.some((violation) => violation.code === "exclusion_names_a_covered_action:cut_weeds"),
    report.violations.map((violation) => violation.code).join("; "),
  );
});

test("an exclusion naming an action the surface does not publish fails", () => {
  const report = taskActionCoverage({
    ...INPUTS,
    exclusions: [
      ...TASK_ACTION_EXCLUSIONS,
      { actionId: "retired_action", reason: "a blocker for an action that no longer exists anywhere" },
    ],
  });
  assert.deepEqual(
    report.violations.map((violation) => violation.code),
    ["exclusion_names_an_unpublished_action:retired_action"],
  );
});

test("an exclusion that names no blocker fails", () => {
  const report = taskActionCoverage({
    ...INPUTS,
    exclusions: TASK_ACTION_EXCLUSIONS.map((entry) =>
      entry.actionId === "ride_bus" ? { ...entry, reason: "cannot" } : entry,
    ),
  });
  assert.deepEqual(
    report.violations.map((violation) => violation.code),
    ["exclusion_reason_names_no_blocker:ride_bus"],
  );
});

test("the population is the artifact's execution actions, not every action it carries", () => {
  // A read-only action is one a snapshot already answers; asking a task to "do" it would be a category error, and
  // counting it as uncovered would put it in the exclusion table for no reason at all.
  const readOnly = ["inspect_world_map", "find_destination", "observe_scene"];
  for (const actionId of readOnly) {
    assert.ok(
      !INPUTS.actions.some((action) => action.actionId === actionId),
      `${actionId} is a read-only action and must not be in the execution population`,
    );
  }
});

test("a newly published action lands in the sweep task that owns its family", () => {
  const population = [...INPUTS.actions.map((action) => action.actionId), "brand_new_farm_thing"];
  const familyOf = new Map(FAMILY_OF);
  familyOf.set("brand_new_farm_thing", "facility_storage_lighting");
  const tasks = buildSweepTasks({
    population,
    familyOf,
    named: new Set(Object.values(DAILY_TASK_ACTION_HINTS).flat()),
  });
  const owners = tasks.filter((task) => task.actions.includes("brand_new_farm_thing")).map((task) => task.id);
  assert.deepEqual(owners, ["sweep_yard_and_work"]);
});

test("an action whose family belongs to no group lands in no task, so the gate reports it", () => {
  // This is why the excluded actions need no entry in the task table: their families are simply not swept, and the
  // gate - not a silent filter - is what turns that into a named finding.
  const population = [...INPUTS.actions.map((action) => action.actionId), "brand_new_second_player_thing"];
  const familyOf = new Map(FAMILY_OF);
  familyOf.set("brand_new_second_player_thing", "npc_social");
  const tasks = buildSweepTasks({
    population,
    familyOf,
    named: new Set(Object.values(DAILY_TASK_ACTION_HINTS).flat()),
  });
  assert.deepEqual(
    tasks.filter((task) => task.actions.includes("brand_new_second_player_thing")),
    [],
  );
});

test("the sweep is the remainder: no action twice, and nothing a scenario task already names", () => {
  const sweepActions = SWEEP_DAILY_TASKS.flatMap((task) => task.actions);
  assert.equal(new Set(sweepActions).size, sweepActions.length, "one action is asked for by two sweep tasks");
  const scenarioNamed = new Set(Object.values(DAILY_TASK_ACTION_HINTS).flat());
  for (const actionId of sweepActions) scenarioNamed.delete(actionId);
  assert.deepEqual(
    sweepActions.filter((actionId) => scenarioNamed.has(actionId)),
    [],
    "a sweep task repeats an action a scenario task already asks for, so it is not the remainder",
  );
  for (const actionId of sweepActions) {
    assert.notEqual(
      FAMILY_OF.get(actionId),
      undefined,
      `the sweep names ${actionId}, which the Mod's catalog does not register`,
    );
  }
});

test("the sweep tasks follow the scenario tasks in the rotation", () => {
  // Appended, not interleaved: the nineteen scenario tasks are a coverage plan in an argued order, and reordering
  // them would silently change what every future run covers first.
  assert.deepEqual(
    DAILY_TASK_ROTATION.slice(-SWEEP_DAILY_TASKS.length),
    SWEEP_DAILY_TASKS.map((task) => task.id),
    "the sweep tasks must be the tail of the rotation",
  );
  assert.ok(SWEEP_DAILY_TASKS.length >= 2, "the sweep is meant to be more than one day's work");
});

test("every sweep task states a purpose, and that purpose is either decidable or names the fact that is missing", () => {
  // A sweep task's purpose is usually "the group was worked", and no receipt names a group, so the honest entry is a
  // named gap - and the sentence has to name what is missing rather than merely decline to answer. `sweep_carried_things`
  // is the case that is a CRITERION instead: its purpose was never the group but the two acts its prompt names, which
  // two receipts decide (`round85` answered `unjudged` for a day that had already shipped an item and sown a seed).
  //
  // BOTH HALVES COME FROM THE ONE TABLE, so the task's own sentence and the entry cannot disagree: a gap's sentence is
  // the entry's own `missingFact`, and a judged day carries none. That is also what keeps the retired text retired - the
  // "backpack before and after" sentence that `inventoryItemFacts` refuted cannot come back here unread.
  const judged = [];
  const gaps = [];
  for (const task of SWEEP_DAILY_TASKS) {
    assert.equal(typeof task.purpose, "string", `${task.id} states no purpose`);
    assert.ok(task.purpose.trim().length > 0, `${task.id} states an empty purpose`);
    assert.ok(task.prompt.zh.trim().length > 0 && task.prompt.en.trim().length > 0, `${task.id} has no prompt`);
    const entry = TASK_PURPOSE_CRITERIA[task.id];
    assert.notEqual(entry, undefined, `${task.id} has no entry in the purpose table, so nothing says what it would be`);
    assert.equal(entry.purpose, task.purpose, `${task.id}: the task and the criterion must say one thing, not two`);
    if (judgesAPublishedFact(task.id)) {
      judged.push(task.id);
      assert.equal(task.missingFact, undefined, `${task.id} is judged from published facts and must not also name a gap`);
      continue;
    }
    gaps.push(task.id);
    assert.ok(
      typeof task.missingFact === "string" && task.missingFact.trim().length > 40,
      `${task.id} must name the fact that is missing`,
    );
    assert.equal(task.missingFact, entry.missingFact, `${task.id}: the gap has to travel with the task, not beside it`);
  }
  assert.ok(SWEEP_DAILY_TASKS.length > 0, "the sweep is the population, so an empty one agrees with itself");
  assert.ok(
    judged.length + gaps.length === SWEEP_DAILY_TASKS.length,
    "every sweep task is either judged or names its gap",
  );
});
