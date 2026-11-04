import assert from "node:assert/strict";
import test from "node:test";

import { DAILY_TASK_ACTION_HINTS, DAILY_TASK_ROTATION } from "./multiday-daily-tasks.mjs";
import {
  readAllPublishedExecutionStardewActionIds,
  readExperimentalStardewActionIds,
} from "./stardew-published-action-registry.mjs";
import { judgeTaskPurpose, purposeReceipts, TASK_PURPOSE_CRITERIA } from "./task-purpose.mjs";

/**
 * The task-purpose gate.
 *
 * It exists for one defect class: a TASK being called accomplished because an ACTION succeeded. Measured on a
 * `go_mining` day declared `[travel, enter_mine, break_rock]` - the companion broke rocks on the surface, the
 * `break_rock` receipt was real (`succeeded/rock_source_broken`), and the day was counted as having mined.
 *
 * The population is derived, never listed: the rotation from `multiday-daily-tasks.mjs`, the declared actions from
 * its hint table, and the published action set from the Mod's own catalog. A task added tomorrow is covered by
 * existing, and the failure names it.
 *
 * red-proof: inject  restoring `mine_delve` to "a rock or container was broken" (one action, no mine) turns two
 *            falsifiers red - `a rock broken with no mine entered is not a mine delved` (got `achieved`) and
 *            `a criterion of one step can be satisfied by a single action's success`
 *            (tools/lib/task-purpose.test.mjs)
 */

const ROTATION = [...DAILY_TASK_ROTATION];

/** A receipt in the shape the run's fact log yields: action, terminal state, and the Mod's evidence block. */
const receipt = (actionId, { reasonCode = "some_terminal", evidence = { detail: "target=opaque_1" } } = {}) =>
  Object.freeze({ actionId, state: "succeeded", reasonCode, evidence });

/** The Mod's own success shapes, taken from the adapter's completion rules (`stardew-game-integration-adapter.test.ts`). */
const BROKE_ROCK = receipt("break_rock", {
  reasonCode: "rock_source_broken",
  evidence: {
    detail:
      "target=rock_source_1234;tool=pickaxe;tool_selected=pickaxe;slot=4;tool_before=axe;slot_before=0;qualified_item_id=(O)2;durability_before=1;durability_after=removed;removed=true;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2;tool_restored=axe",
  },
});
const ENTERED_MINE = receipt("enter_mine", {
  reasonCode: "mine_entered",
  evidence: { detail: "level=11;tile=6,6;from_level=10" },
});

test("every rotation task declares a purpose or names the fact that is missing", () => {
  const undeclared = ROTATION.filter((task) => TASK_PURPOSE_CRITERIA[task] === undefined);
  assert.deepEqual(
    undeclared,
    [],
    `these tasks have no declared purpose, so a run cannot say whether they were accomplished: ${undeclared.join(", ")}`,
  );
});

test("no purpose is declared for a task the rotation never asks for", () => {
  const orphans = Object.keys(TASK_PURPOSE_CRITERIA).filter((task) => !ROTATION.includes(task));
  assert.deepEqual(orphans, [], `these criteria describe tasks no run asks for: ${orphans.join(", ")}`);
});

test("a purpose is either a criterion of more than one fact, or a named gap", () => {
  for (const [task, entry] of Object.entries(TASK_PURPOSE_CRITERIA)) {
    if (entry.missingFact !== undefined) {
      assert.ok(
        typeof entry.missingFact === "string" && entry.missingFact.trim().length > 40,
        `${task}: a gap has to name the fact that is missing, not merely decline to answer`,
      );
      assert.equal(
        entry.steps,
        undefined,
        `${task}: a task with a missing fact must not also carry a criterion - one of the two is wrong`,
      );
      assert.ok(
        typeof entry.purpose === "string" && entry.purpose.length > 0,
        `${task}: a gap states the purpose it cannot decide`,
      );
      continue;
    }
    assert.ok(
      typeof entry.purpose === "string" && entry.purpose.trim().length > 0,
      `${task}: a criterion states its purpose`,
    );
    assert.ok(Array.isArray(entry.steps), `${task}: a criterion without steps decides nothing`);
    // A one-step criterion IS the old defect: one action's success would be the whole purpose.
    assert.ok(
      entry.steps.length >= 2,
      `${task}: a criterion of one step can be satisfied by a single action's success, which is the defect this table exists to prevent`,
    );
    for (const candidate of entry.steps) {
      assert.ok(
        typeof candidate.actionId === "string" || Array.isArray(candidate.anyOf),
        `${task}: every step names an action id or a set of them`,
      );
    }
  }
});

test("every action a criterion reads is published by the Mod", async () => {
  const published = new Set(await readAllPublishedExecutionStardewActionIds());
  const experimental = new Set(await readExperimentalStardewActionIds());
  const drifting = [];
  for (const [task, entry] of Object.entries(TASK_PURPOSE_CRITERIA)) {
    for (const candidate of entry.steps ?? []) {
      for (const actionId of candidate.actionId === undefined ? candidate.anyOf : [candidate.actionId]) {
        if (published.has(actionId)) continue;
        drifting.push(
          experimental.has(actionId)
            ? `${task} reads ${actionId}, which the Mod registers Experimental - no run can dispatch it`
            : `${task} reads ${actionId}, which the Mod does not publish`,
        );
      }
    }
  }
  assert.deepEqual(drifting, [], drifting.join("; "));
});

test("hitting a task's declared actions with a bare succeeded receipt accomplishes nothing", () => {
  // The reported shape of the old path: the declaration says which actions serve the task, every one of them comes
  // back succeeded, and the day is counted. `succeeded` alone is not a postcondition, so none of these may reach
  // `achieved` - and the assertion is per ACTION, so a single success is covered as well as the whole set.
  const drifting = [];
  for (const task of ROTATION) {
    const declared = new Set(DAILY_TASK_ACTION_HINTS[task] ?? []);
    for (const candidate of TASK_PURPOSE_CRITERIA[task]?.steps ?? []) {
      for (const actionId of candidate.actionId === undefined ? candidate.anyOf : [candidate.actionId])
        declared.add(actionId);
    }
    for (const actionId of declared) {
      const judged = judgeTaskPurpose(task, [receipt(actionId, { evidence: { detail: "result=ok" } })]);
      if (judged.state === "achieved") drifting.push(`${task} <- ${actionId}`);
    }
    // And the first step on its own is not the purpose either, whatever else the run did.
    const first = TASK_PURPOSE_CRITERIA[task]?.steps?.[0];
    if (first !== undefined) {
      const actionId = first.actionId === undefined ? first.anyOf[0] : first.actionId;
      if (judgeTaskPurpose(task, [receipt(actionId)]).state === "achieved")
        drifting.push(`${task} <- its first step only`);
    }
  }
  assert.deepEqual(
    drifting,
    [],
    `a task was accomplished by an action succeeding instead of by its own criterion: ${drifting.join(", ")}`,
  );
});

test("a succeeded receipt that carries no postcondition of its own is refused, and proves nothing", () => {
  const drifting = [];
  for (const task of ROTATION) {
    const entry = TASK_PURPOSE_CRITERIA[task];
    if (entry?.steps === undefined) continue;
    const steps = entry.steps.map((candidate) =>
      receipt(candidate.actionId === undefined ? candidate.anyOf[0] : candidate.actionId, { evidence: null }),
    );
    const judged = judgeTaskPurpose(task, steps);
    if (judged.state === "achieved") drifting.push(`${task}: a succeeded receipt with no evidence accomplished it`);
    assert.deepEqual(
      judged.refusedReceipts.map((refused) => refused.actionId).sort(),
      steps.map((step) => step.actionId).sort(),
      `${task}: every evidence-less success must be reported as refused`,
    );
  }
  assert.deepEqual(drifting, [], drifting.join("; "));
});

test("a succeeded receipt whose detail is another terminal's is refused", () => {
  // The same real `break_rock` detail under a reason code that is not that action's terminal proves no completion -
  // the evidence is the Mod's `rock_source_damaged` progress shape, which is a real `succeeded` dispatch.
  const damaged = Object.freeze({ ...BROKE_ROCK, reasonCode: "rock_source_damaged" });
  const { admitted, refused } = purposeReceipts([damaged]);
  assert.deepEqual(admitted, [], "a progress terminal is not a completion");
  assert.deepEqual(
    refused.map((entry) => entry.actionId),
    ["break_rock"],
  );
  assert.equal(judgeTaskPurpose("mine_delve", [damaged]).state, "unproven");
});

test("mine_delve: the surface rock that started this gate does not accomplish the task", () => {
  // THE MEASURED DEFECT. A day declared `[travel, enter_mine, break_rock]` and broke rocks on the farm: the rock's
  // own postcondition is real, so the old path counted the task. The purpose is order-sensitive, and the rock came
  // before any mine was entered.
  const surface = judgeTaskPurpose("mine_delve", [BROKE_ROCK]);
  assert.equal(surface.state, "not_achieved", "a rock broken with no mine entered is not a mine delved");
  assert.deepEqual(
    surface.admittedActionIds,
    ["break_rock"],
    "the rock's postcondition IS admitted - it just is not the purpose",
  );

  const wrongOrder = judgeTaskPurpose("mine_delve", [BROKE_ROCK, ENTERED_MINE]);
  assert.equal(wrongOrder.state, "not_achieved", "a rock broken BEFORE the mine was entered is still the surface");

  const delved = judgeTaskPurpose("mine_delve", [ENTERED_MINE, BROKE_ROCK]);
  assert.equal(delved.state, "achieved", "entering a mine and then breaking something is the purpose");
  assert.match(delved.purpose ?? "", /mine level was entered/);
});

test("a task with a named gap answers unproven for every receipt set, however complete", () => {
  const gaps = Object.entries(TASK_PURPOSE_CRITERIA).filter(([, entry]) => entry.missingFact !== undefined);
  assert.ok(gaps.length > 0, "the registry is expected to declare the purposes it cannot decide");
  for (const [task, entry] of gaps) {
    // Every declared action of that task, each with evidence-shaped detail: the strongest set a run could produce.
    const complete = (DAILY_TASK_ACTION_HINTS[task] ?? []).map((actionId) => receipt(actionId));
    const judged = judgeTaskPurpose(task, complete);
    assert.equal(judged.state, "unproven", `${task}: a purpose with no decidable fact must not be reported either way`);
    assert.equal(judged.missingFact, entry.missingFact, `${task}: the gap has to travel with the verdict`);
  }
});

test("an unregistered task is unproven and names itself", () => {
  const judged = judgeTaskPurpose("not_a_rotation_task", [BROKE_ROCK]);
  assert.equal(judged.state, "unproven");
  assert.match(judged.missingFact ?? "", /not_a_rotation_task/);
});
