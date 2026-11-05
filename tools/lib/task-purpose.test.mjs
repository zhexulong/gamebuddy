import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { modConstants } from "../check-stardew-snapshot-family-bounds.mjs";
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
// The tile-bearing terminals, in the producer's own shapes (`stardew-game-integration-adapter.test.ts`). A patch day's
// evidence IS a coordinate: these three actions each name the tile they changed as part of their postcondition.
const TILLED = (x, y, location = "Farm") =>
  receipt("till_soil", {
    reasonCode: "soil_tilled",
    evidence: {
      detail:
        "location=" +
        location +
        ";target=" +
        String(x) +
        "," +
        String(y) +
        ";before=none;after=HoeDirt;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2",
    },
  });
const PLANTED = (x, y, location = "Farm") =>
  receipt("plant_seed", {
    reasonCode: "seed_planted",
    evidence: {
      detail:
        "location=" +
        location +
        ";target=soil_01;tile=" +
        String(x) +
        "," +
        String(y) +
        ";item=(O)472;crop=Parsnip;inventory_before=2;inventory_after=1",
    },
  });
const CUT_WEEDS = receipt("cut_weeds", {
  reasonCode: "weeds_cut",
  evidence: {
    detail:
      "target=weed_01;type=weed;tool=scythe;tool_selected=scythe;slot=1;tool_before=axe;slot_before=0;qualified_item_id=(O)313;health_before=2;health_after=removed;swings=2;removed=true;stamina_before=100;stamina_after=100;stamina_delta=0;expected_stamina_cost=0;tool_restored=axe",
  },
});

/** A rectangle of tiles, as `[x, y]` pairs. */
const rectangle = (width, height, originX = 12, originY = 4) => {
  const points = [];
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) points.push([originX + x, originY + y]);
  }
  return points;
};

/** The receipts a patch day's own history would leave: every tile tilled, then a seed put in it. */
const patchReceipts = (points) => points.flatMap(([x, y]) => [TILLED(x, y), PLANTED(x, y)]);

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

test("a purpose is either a criterion of more than one fact, a declared shape, or a named gap", () => {
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
    // A SHAPE is the third kind, and it declares the rectangle rather than a step list: the criterion is not "these
    // actions happened" but "the tiles they changed form this rectangle". It must still name what proves a tile,
    // because a shape nothing can fill is a purpose nothing can decide.
    if (entry.patch !== undefined) {
      assert.equal(entry.steps, undefined, `${task}: a declared shape is not a step list`);
      for (const dimension of ["width", "height"])
        assert.ok(
          Number.isInteger(entry.patch[dimension]) && entry.patch[dimension] > 1,
          `${task}: a declared patch needs an integer ${dimension} of more than one tile`,
        );
      assert.ok(
        typeof entry.purpose === "string" && entry.purpose.trim().length > 0,
        `${task}: a shape criterion states its purpose`,
      );
      for (const kind of ["tilledBy", "croppedBy"])
        assert.ok(
          Array.isArray(entry[kind]) && entry[kind].length > 0,
          `${task}: a declared patch must say which actions prove a tile is ${kind === "tilledBy" ? "tilled" : "crop-bearing"}`,
        );
      for (const proof of [...entry.tilledBy, ...entry.croppedBy])
        assert.ok(
          typeof proof.actionId === "string" && typeof proof.tileField === "string",
          `${task}: every tile proof names an action and the evidence field that carries the tile`,
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
    // A shape criterion reads its tile proofs instead of steps, and the same rule governs them.
    for (const proof of [...(entry.tilledBy ?? []), ...(entry.croppedBy ?? [])]) {
      if (published.has(proof.actionId)) continue;
      drifting.push(
        experimental.has(proof.actionId)
          ? `${task} reads ${proof.actionId}, which the Mod registers Experimental - no run can dispatch it`
          : `${task} reads ${proof.actionId}, which the Mod does not publish`,
      );
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

/**
 * The shape criterion, and the four outcomes it must never confuse.
 *
 * red-proof: inject  `judgePatch` returning `achieved` whenever any tile was proved (drop the window count) ->
 *                    `37 of the sixty tiles is a patch that is not finished` and
 *                    `sixty tiles in another shape are named as another shape` both go red, because 37 tiles and a
 *                    10x6 block would be reported as a finished 3x20 strip;
 *                    and returning `not_achieved` for a set with no coordinates at all ->
 *                    `a patch day whose receipts carry no tile is our gap, not her failure`
 *                    (tools/lib/task-purpose.test.mjs)
 */
test("a declared patch is longer than the window one snapshot sees", () => {
  // THE PREMISE OF THE TASK, not a size preference: target discovery is Chebyshev radius 6, so one snapshot is a
  // 13x13 window. A declared patch that fits inside it would be provable from a single observation, and the day would
  // measure nothing `till_and_sow` does not already measure. The radius is read from the Mod itself, so a change
  // there either keeps the premise true or fails here.
  const constants = modConstants([
    {
      file: "integrations/stardew/farmhandexecutioncontroller.cs",
      text: readFileSync(
        new URL("../../integrations/stardew/farmhandexecutioncontroller.cs", import.meta.url),
        "utf8",
      ),
    },
  ]);
  const radius = constants.get("TargetDiscoveryRadius");
  assert.ok(
    Number.isInteger(radius),
    "the Mod's discovery radius is not readable, so the premise a long patch rests on cannot be checked",
  );
  const window = radius * 2 + 1;
  const declared = Object.entries(TASK_PURPOSE_CRITERIA).filter(([, entry]) => entry.patch !== undefined);
  assert.ok(declared.length > 0, "no task declares a shape, so nothing asks for a plot longer than one view");
  for (const [task, entry] of declared)
    assert.ok(
      Math.max(entry.patch.width, entry.patch.height) > window,
      `${task}: a ${String(entry.patch.width)}x${String(entry.patch.height)} patch fits inside the ${String(window)}x${String(window)} window one snapshot sees, so a single observation already answers it`,
    );
});

test("a long strip proved tile by tile is the declared patch", () => {
  const judged = judgeTaskPurpose("clear_and_plant_long_patch", patchReceipts(rectangle(3, 20)));
  assert.equal(judged.state, "achieved");
  assert.equal(judged.patchWindow?.count, 60, "all sixty tiles of the strip must be proved, tile by tile");
  assert.equal(judged.location, "Farm");
});

test("the same strip laid the other way is the same work", () => {
  // The player asked for a strip three wide and twenty long. A companion that laid it twenty wide and three deep did
  // the same clearing, tilling and sowing, and a criterion that failed it would be grading the drawing.
  const judged = judgeTaskPurpose("clear_and_plant_long_patch", patchReceipts(rectangle(20, 3)));
  assert.equal(judged.state, "achieved");
});

test("37 of the sixty tiles is a patch that is not finished, and the count says so", () => {
  const judged = judgeTaskPurpose("clear_and_plant_long_patch", patchReceipts(rectangle(3, 20).slice(0, 37)));
  assert.equal(judged.state, "not_achieved");
  assert.equal(judged.reasonCode, "task_purpose_not_achieved");
  assert.match(judged.detail ?? "", /37\/60 tiles inside the best 3x20 window/u);
});

test("sixty tiles in another shape are named as another shape, not as a short patch", () => {
  // Both are sixty tiles and neither is the patch - but "planted 37 of a 60-tile strip" and "planted sixty tiles that
  // are not a strip" are different defects, and one sentence for both is how the second goes unnoticed.
  const judged = judgeTaskPurpose("clear_and_plant_long_patch", patchReceipts(rectangle(10, 6)));
  assert.equal(judged.state, "not_achieved");
  assert.equal(judged.reasonCode, "tiles_do_not_form_the_declared_patch");
  assert.deepEqual(judged.largestRectangle, { x: 12, y: 4, width: 10, height: 6, area: 60 });
  assert.match(judged.detail ?? "", /largest rectangle found is 10x6 \(60 tiles\), not the declared 3x20/u);
  const short = judgeTaskPurpose("clear_and_plant_long_patch", patchReceipts(rectangle(3, 20).slice(0, 37)));
  assert.notEqual(
    short.reasonCode,
    judged.reasonCode,
    "a strip that is not finished and a patch of the wrong shape must not read the same",
  );
});

test("a patch day whose receipts carry no tile is our gap, not her failure", () => {
  // `cut_weeds` is a real completion with a real postcondition and no coordinate at all: a day of clearing proves work
  // and proves nothing about where it happened. Answering `not_achieved` there would report a plot that was never
  // tilled as a plot she failed, and the coordinate is what this run did not record.
  for (const receipts of [[], [CUT_WEEDS]]) {
    const judged = judgeTaskPurpose("clear_and_plant_long_patch", receipts);
    assert.equal(judged.state, "unproven");
    assert.equal(judged.reasonCode, "task_purpose_has_no_tile_coordinates");
    assert.match(judged.missingFact ?? "", /no receipt of this run carried a tile/u);
  }
});

test("what the run saw counts beside what it proved, and only as each row describes itself", () => {
  const strip = rectangle(3, 20);
  // The receipts prove the tilling; the crops were observed rather than dispatched. The union is the plot, so this is
  // the same strip - and it is the only way the observation half can contribute at all, because `cropTargets` is a
  // radius-6 list that cannot hold twenty tiles in a row by itself. The receipts are the memory.
  const union = judgeTaskPurpose(
    "clear_and_plant_long_patch",
    strip.map(([x, y]) => TILLED(x, y)),
    { location: "Farm", cropTargets: strip.map(([x, y]) => ({ x, y, cropId: "24" })) },
  );
  assert.equal(union.state, "achieved");
  // `soilTiles` is the Mod's `till_soil` TARGET list: `DiscoverSoilTiles` skips every tile that already has HoeDirt, so
  // a row without the flag describes ground that is NOT tilled. Counting it as tilled would report untilled ground as
  // a finished plot - the one thing a tile-counting criterion must never do.
  const untilled = judgeTaskPurpose(
    "clear_and_plant_long_patch",
    strip.map(([x, y]) => PLANTED(x, y)),
    { location: "Farm", soilTiles: strip.map(([x, y]) => ({ x, y, hoeDirt: false })) },
  );
  assert.equal(untilled.state, "not_achieved");
  assert.match(untilled.detail ?? "", /0\/60/u);
  // A row that DOES say hoeDirt is tilled ground, and it counts.
  const tilled = judgeTaskPurpose(
    "clear_and_plant_long_patch",
    strip.map(([x, y]) => PLANTED(x, y)),
    { location: "Farm", soilTiles: strip.map(([x, y]) => ({ x, y, hoeDirt: true })) },
  );
  assert.equal(tilled.state, "achieved");
});

test("two maps' tiles never add up to one strip", () => {
  // Stardew's coordinates restart at (0, 0) in every location, so half a strip on the farm and half in the greenhouse
  // name the same coordinates as the whole strip. An ungrouped union would report a plot that exists on no map.
  const strip = rectangle(3, 20);
  const judged = judgeTaskPurpose("clear_and_plant_long_patch", [
    ...patchReceipts(strip.slice(0, 30)),
    ...strip.slice(30).flatMap(([x, y]) => [TILLED(x, y, "Greenhouse"), PLANTED(x, y, "Greenhouse")]),
  ]);
  assert.notEqual(judged.state, "achieved", "thirty tiles on one map and thirty on another is not a strip");
});

test("a strip is the strip whether it is one tile short or one tile over", () => {
  const strip = rectangle(3, 20);
  // One tile short: the count says so rather than rounding up into the shape it nearly is.
  const short = judgeTaskPurpose("clear_and_plant_long_patch", patchReceipts(strip.slice(0, 59)));
  assert.equal(short.state, "not_achieved");
  assert.match(short.detail ?? "", /59\/60/u);
  // One tile beyond the strip: the strip itself is there tile for tile, so this is not a failure. The criterion asks
  // whether a full 3x20 is among the tiles proved, and it is.
  const over = judgeTaskPurpose("clear_and_plant_long_patch", patchReceipts([...strip, [40, 40]]));
  assert.equal(over.state, "achieved");
});
