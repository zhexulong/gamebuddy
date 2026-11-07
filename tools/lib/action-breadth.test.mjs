/**
 * The breadth reading, proved on the shapes it exists for.
 *
 * Every fixture here is synthetic and injected: the population, the family table and the ratchet are arguments, so a
 * test never measures today's catalog and cannot go red because an action was published. The two shapes that matter
 * most are both taken from real runs: `round39` (15 of 95 actions, 124 executions, a quarter of them cutting weeds)
 * and `round38` (24 actions in 11 families, the best multiday day on this machine).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { programExecutionRows } from "../live-run/game/execution-trace.mjs";
import {
  ACTION_BREADTH_CONCENTRATION_SHARE,
  actionBreadthClause,
  actionExecutionCounts,
  formatActionBreadth,
  measureActionBreadth,
} from "./action-breadth.mjs";

/** A family per action, so a reading's family count is decided by the fixture and not by today's catalog. */
const FAMILY_OF = Object.freeze({
  cut_weeds: "resource_gathering",
  cut_grass: "resource_gathering",
  break_rock: "resource_gathering",
  harvest_crop: "farming_crops",
  till_soil: "farming_crops",
  plant_seed: "farming_crops",
  water_crop: "farming_crops",
  move_to_tile: "movement_navigation",
  enter_exit: "movement_navigation",
  sleep: "world_lifecycle",
  talk_to_npc: "npc_social",
  ride_bus: "transport_warps",
});

function surfaceOf(actionIds) {
  const families = new Map(actionIds.map((actionId) => [actionId, FAMILY_OF[actionId] ?? "unmapped"]));
  return { actionIds, families, familyCount: new Set(families.values()).size };
}

const ALL_ACTIONS = Object.keys(FAMILY_OF);
const SURFACE = surfaceOf(ALL_ACTIONS);

/** The ratchet: four families over eight actions, and one action this fixture cannot reach. */
const BASELINE = Object.freeze({
  baselines: { multiday_routine: { label: "fixture-best", attempted: 8, families: 4 } },
  exclusions: Object.freeze([
    Object.freeze({
      actionId: "ride_bus",
      reason:
        "targets the Bus Stop ticket machine and drives its native dialogue; the bus is out of order until the Vault repair",
    }),
  ]),
});

/**
 * One program's executions, grouped by action: `{ cut_weeds: 32, break_rock: 17 }` becomes one candidate node and N
 * journal executions per action, plus the DEDUPLICATED rows `execution-trace.mjs` owns.
 */
function programRunFixture(counts) {
  const programId = "plan_fixture";
  const nodes = [];
  const executions = [];
  const nodeOutcomes = [];
  for (const [actionId, count] of Object.entries(counts)) {
    const nodeId = `n${String(nodes.length + 1)}`;
    nodes.push(Object.freeze({ nodeId, actionId }));
    nodeOutcomes.push(Object.freeze({ nodeId, state: "succeeded" }));
    for (let attempt = 1; attempt <= count; attempt += 1)
      executions.push(
        Object.freeze({
          nodeId,
          nodeAttempt: attempt,
          cursor: executions.length + 1,
          atMs: attempt,
          settledAtMs: attempt + 1,
        }),
      );
  }
  const programOutcomes = [
    Object.freeze({ programId, observed: true, dispatched: executions.length, executions, nodeOutcomes }),
  ];
  return Object.freeze({
    programSubmissions: Object.freeze([Object.freeze({ programId, code: "accepted", accepted: true, nodes })]),
    programRows: programExecutionRows(programOutcomes),
    attempted: Object.freeze(nodes.map((node) => node.actionId)),
    executions: executions.length,
  });
}

async function measure(counts, overrides = {}) {
  const run = programRunFixture(counts);
  return measureActionBreadth({
    scenario: "multiday_routine",
    attempted: run.attempted,
    succeeded: run.attempted,
    executions: run.executions,
    actionRows: [],
    programRows: run.programRows,
    programSubmissions: run.programSubmissions,
    surface: SURFACE,
    baseline: BASELINE,
    ...overrides,
  });
}

test("a run at the recorded best is rich, and one action below it is below_baseline", async () => {
  // Eight actions in four families, four executions each: nothing above a sixth of the day, so coverage alone decides.
  const atBaseline = await measure({
    cut_weeds: 4,
    break_rock: 4,
    harvest_crop: 4,
    till_soil: 4,
    move_to_tile: 4,
    enter_exit: 4,
    sleep: 4,
    talk_to_npc: 4,
  });
  assert.equal(atBaseline.attempted, 8);
  assert.equal(atBaseline.families, 5, "five families: the baseline asks for four, more is not a failure");
  assert.equal(atBaseline.concentration.actionId, "break_rock", "the largest action is named, ties broken by id");
  assert.equal(atBaseline.verdict, "rich");
  assert.equal(actionBreadthClause(atBaseline).passed, true);

  // One fewer action, same families: the ratchet is about what was USED, so this is below it.
  const oneShort = await measure({
    cut_weeds: 4,
    break_rock: 4,
    harvest_crop: 4,
    till_soil: 4,
    move_to_tile: 4,
    enter_exit: 4,
    sleep: 4,
  });
  assert.equal(oneShort.attempted, 7);
  assert.equal(oneShort.verdict, "narrow:below_baseline:fixture-best");
  assert.deepEqual(actionBreadthClause(oneShort), {
    id: "action_breadth",
    passed: false,
    reasonCode: "narrow:below_baseline:fixture-best",
  });
});

test("the same action count in fewer families is below the baseline too", async () => {
  // Eight actions, but every one of them resource_gathering or farming_crops: "eight actions" would read as breadth
  // while the day was one kind of work.
  const breadth = await measure({
    cut_weeds: 4,
    cut_grass: 4,
    break_rock: 4,
    harvest_crop: 4,
    till_soil: 4,
    plant_seed: 4,
    water_crop: 4,
    sleep: 4,
  });
  assert.equal(breadth.attempted, 8, "the action count still meets the baseline");
  assert.equal(breadth.families, 3);
  assert.deepEqual(breadth.familyNames, ["farming_crops", "resource_gathering", "world_lifecycle"]);
  assert.equal(breadth.verdict, "narrow:below_baseline:fixture-best", "the families dimension is what fails it");
});

test("one action holding most of the executions is narrow even when the coverage looks acceptable", async () => {
  // The round39 shape, sharpened: eight actions attempted, so coverage meets the baseline, and 32 of 60 executions are
  // cutting weeds. A count of executions cannot tell this from a varied day.
  const breadth = await measure({
    cut_weeds: 32,
    cut_grass: 4,
    break_rock: 4,
    harvest_crop: 4,
    till_soil: 4,
    plant_seed: 4,
    move_to_tile: 4,
    sleep: 4,
  });
  assert.equal(breadth.attempted, 8);
  assert.equal(breadth.concentration.actionId, "cut_weeds");
  assert.equal(breadth.concentration.executions, 32);
  assert.ok(breadth.concentration.share > ACTION_BREADTH_CONCENTRATION_SHARE);
  assert.equal(breadth.verdict, "narrow:concentrated_on:cut_weeds");
});

test("the concentration boundary is 'more than the share', not 'at least'", async () => {
  // Exactly 40 % of 100 executions: the largest action is a large part of the day but the day still has four parts.
  // The ratchet is set at this run's own coverage, so only the concentration rule is being asked about here.
  const atTheLine = {
    baselines: { multiday_routine: { label: "fixture-best", attempted: 4, families: 2 } },
    exclusions: [],
  };
  const atThreshold = await measure(
    { cut_weeds: 40, cut_grass: 20, break_rock: 20, harvest_crop: 20 },
    { baseline: atTheLine },
  );
  assert.equal(atThreshold.concentration.share, ACTION_BREADTH_CONCENTRATION_SHARE);
  assert.equal(atThreshold.verdict, "rich");

  const overThreshold = await measure(
    { cut_weeds: 41, cut_grass: 20, break_rock: 20, harvest_crop: 19 },
    { baseline: atTheLine },
  );
  assert.ok(overThreshold.concentration.share > ACTION_BREADTH_CONCENTRATION_SHARE);
  assert.equal(overThreshold.verdict, "narrow:concentrated_on:cut_weeds");
});

test("an excluded action that was attempted turns the reading red, because the carve-out has stopped being true", async () => {
  const breadth = await measure({
    cut_weeds: 4,
    break_rock: 4,
    harvest_crop: 4,
    till_soil: 4,
    move_to_tile: 4,
    enter_exit: 4,
    sleep: 4,
    talk_to_npc: 4,
    ride_bus: 4,
  });
  assert.equal(breadth.verdict, "narrow:excluded_action_attempted:ride_bus");
  assert.deepEqual([...breadth.excludedAttempted], ["ride_bus"]);
  assert.equal(actionBreadthClause(breadth).passed, false);
});

test("an exclusion whose action left the catalog is named instead of quietly shrinking the denominator", async () => {
  const reached = ALL_ACTIONS.filter((actionId) => actionId !== "ride_bus");
  const breadth = await measure(
    {
      cut_weeds: 4,
      break_rock: 4,
      harvest_crop: 4,
      till_soil: 4,
      move_to_tile: 4,
      enter_exit: 4,
      sleep: 4,
      talk_to_npc: 4,
    },
    { surface: surfaceOf(reached) },
  );
  assert.deepEqual([...breadth.staleExclusions], ["ride_bus"]);
  assert.equal(breadth.verdict, "not_measured:excluded_action_not_published:ride_bus");
});

test("a run with no executions is not_measured, never rich", async () => {
  const breadth = await measureActionBreadth({
    scenario: "multiday_routine",
    attempted: [],
    succeeded: [],
    executions: 0,
    actionRows: [],
    programRows: [],
    programSubmissions: [],
    surface: SURFACE,
    baseline: BASELINE,
  });
  assert.equal(breadth.verdict, "not_measured:no_executions");
  assert.equal(breadth.concentration, null);
  assert.equal(breadth.concentrationReason, "no_executions");
  assert.equal(actionBreadthClause(breadth).passed, true, "a measurement we could not take is not a defect of the run");
});

test("an execution that names no action is counted as unattributed, never as one concentrated action", async () => {
  // Measured on real bundles: the journal rows of an older run have no submitted candidate to join to, so every
  // execution is unattributable. Reading that as "one action holds 100 %" would blame the companion for our gap.
  const run = programRunFixture({ cut_weeds: 2 });
  const breadth = await measureActionBreadth({
    scenario: "multiday_routine",
    attempted: run.attempted,
    succeeded: run.attempted,
    executions: 10,
    actionRows: [],
    programRows: run.programRows,
    programSubmissions: [],
    surface: SURFACE,
    baseline: { baselines: {}, exclusions: [] },
  });
  assert.equal(breadth.attributedExecutions, 0);
  assert.equal(breadth.unattributedExecutions, 10);
  assert.equal(breadth.concentration, null);
  assert.equal(breadth.concentrationReason, "executions_unattributed:10");
  assert.equal(breadth.verdict, "not_measured:no_baseline_for_scenario:multiday_routine");
});

test("a flat dispatch is attributed by its own action, and a program node by the candidate the Host submitted", () => {
  const run = programRunFixture({ cut_weeds: 2, harvest_crop: 1 });
  const counts = actionExecutionCounts({
    actionRows: [
      { action: "move_to_tile", state: "succeeded" },
      { action: "move_to_tile", state: "failed" },
    ],
    programRows: run.programRows,
    programSubmissions: run.programSubmissions,
  });
  assert.equal(counts.attributed, 5);
  assert.deepEqual(Object.fromEntries(counts.counts), { move_to_tile: 2, cut_weeds: 2, harvest_crop: 1 });

  // The same rows with no candidate: nothing can be joined, so nothing is invented.
  const orphaned = actionExecutionCounts({ actionRows: [], programRows: run.programRows, programSubmissions: [] });
  assert.equal(orphaned.attributed, 0);
  assert.equal(orphaned.counts.size, 0);
});

test("the reading prints its population, its coverage, its families and its verdict", () => {
  const breadth = {
    attempted: 15,
    succeeded: 14,
    published: 95,
    judged: 91,
    families: 2,
    publishedFamilies: 20,
    familyNames: ["resource_gathering", "world_lifecycle"],
    executions: 124,
    attributedExecutions: 124,
    concentration: { actionId: "cut_weeds", executions: 32, share: 32 / 124 },
    concentrationReason: null,
    verdict: "narrow:below_baseline:round38",
  };
  const lines = formatActionBreadth(breadth);
  assert.equal(lines[0], "action_breadth: population 95 published, 91 judged (4 excluded)");
  assert.equal(lines[1], "action_breadth: attempted 15 of 95 (15.8%); succeeded 14 of 95");
  assert.equal(lines[2], "action_breadth: families 2 of 20 resource_gathering,world_lifecycle");
  assert.equal(lines[3], "action_breadth: executions 124 (124 attributed); concentration cut_weeds 32 (25.8%)");
  assert.equal(lines[4], "action_breadth: verdict narrow:below_baseline:round38");
});
