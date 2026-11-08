/**
 * The breadth reading, proved on the shapes it exists for.
 *
 * Every fixture here is synthetic and injected: the population, the family table, the target-field join, the census
 * and the ratchet are arguments, so a test never measures today's catalog and cannot go red because an action was
 * published. The two shapes that matter most are both taken from real runs: `round39` (15 actions addressing a small
 * part of the world it was given, a quarter of its executions cutting weeds) and `round38` (24 actions in 11
 * families, the best multiday day on this machine).
 *
 * THE DENOMINATOR HERE IS THE CENSUS. Seven of the twelve fixture actions are target-bound, and their families carry
 * rows in the default census; the other five (`till_soil`, `move_to_tile`, `enter_exit`, `sleep`, `ride_bus`) name no
 * snapshot family, so nothing can gate them. `ride_bus` is then withheld by the baseline's exclusion, which is why the
 * world is 11 actions wide, not 12 - and why "8 of 11" is a different claim from "8 of 12".
 */

import assert from "node:assert/strict";
import test from "node:test";

import { programExecutionRows } from "../live-run/game/execution-trace.mjs";
import {
  ACTION_BREADTH_CONCENTRATION_SHARE,
  actionBreadthClause,
  actionExecutionCounts,
  addSnapshotToCensus,
  buildSnapshotCensus,
  deriveAddressable,
  formatActionBreadth,
  measureActionBreadth,
  SNAPSHOT_CENSUS_SOURCE,
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

/** The snapshot family each target-bound fixture action names; the five actions absent here need no row at all. */
const TARGET_FIELD_OF = Object.freeze({
  cut_weeds: "weedTargets",
  cut_grass: "grassTargets",
  break_rock: "rockSourceTargets",
  harvest_crop: "harvestTargets",
  plant_seed: "seedTargets",
  water_crop: "cropTargets",
  talk_to_npc: "npcRelationshipTargets",
});

function surfaceOf(actionIds) {
  const families = new Map(actionIds.map((actionId) => [actionId, FAMILY_OF[actionId] ?? "unmapped"]));
  const targetFieldOf = new Map(
    actionIds
      .filter((actionId) => actionId in TARGET_FIELD_OF)
      .map((actionId) => [actionId, TARGET_FIELD_OF[actionId]]),
  );
  return {
    actionIds,
    families,
    familyCount: new Set(families.values()).size,
    targetFieldOf,
    targetFields: [...new Set(targetFieldOf.values())].sort(),
  };
}

const ALL_ACTIONS = Object.keys(FAMILY_OF);
const SURFACE = surfaceOf(ALL_ACTIONS);

/** Every target family of the fixture world carrying rows: the widest world this fixture can arm. */
const WIDE_ROWS = Object.freeze({
  weedTargets: 16,
  grassTargets: 16,
  rockSourceTargets: 8,
  harvestTargets: 3,
  seedTargets: 16,
  cropTargets: 2,
  npcRelationshipTargets: 1,
});

function censusOf(rows, { surface = SURFACE, snapshots = 5 } = {}) {
  return buildSnapshotCensus({ surface, rows: new Map(Object.entries(rows)), snapshots });
}

const WIDE_CENSUS = censusOf(WIDE_ROWS);
/** Nine addressable actions: the wide world minus the two families this census never saw a row for. */
const NARROW_ROWS = Object.freeze({
  weedTargets: 16,
  grassTargets: 16,
  rockSourceTargets: 8,
  harvestTargets: 3,
  seedTargets: 16,
  cropTargets: 2,
});

/** The ratchet: 8 of 11 addressable actions in 4 families, and one action this fixture cannot reach. */
const BASELINE = Object.freeze({
  baselines: { multiday_routine: { label: "fixture-best", attempted: 8, addressable: 11, families: 4 } },
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
    census: WIDE_CENSUS,
    surface: SURFACE,
    baseline: BASELINE,
    ...overrides,
  });
}

test("a run at the recorded best is rich, and one action below it is below_baseline", async () => {
  // Eight actions in five families, four executions each: nothing above a fifth of the day, so coverage alone decides.
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
  assert.equal(
    atBaseline.addressable,
    11,
    "eleven: seven target-bound families with rows, five family-free, one excluded",
  );
  assert.equal(atBaseline.addressableTargetBound, 7);
  assert.equal(atBaseline.addressableTargetless, 4, "ride_bus is family-free but excluded, so it is not addressable");
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
  // Eight actions, but every one of them resource_gathering, farming_crops or world_lifecycle: "eight actions" would
  // read as breadth while the day was one kind of work.
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
  assert.equal(breadth.addressable, 11);
  assert.equal(breadth.coverage, 8 / 11, "coverage is exactly the recorded fraction, so only the families can fail it");
  assert.equal(breadth.families, 3);
  assert.deepEqual(breadth.familyNames, ["farming_crops", "resource_gathering", "world_lifecycle"]);
  assert.equal(breadth.verdict, "narrow:below_baseline:fixture-best", "the families dimension is what fails it");
});

test("coverage is compared as a fraction, so a smaller world is not charged for being smaller", async () => {
  // The defect this reading was rebuilt for: a world that arms six actions cannot be held to a count of five attempts
  // out of a ten-action world. Four of six is above five of ten, even though four is fewer attempts than five.
  const baseline = {
    baselines: { multiday_routine: { label: "fixture-best", attempted: 5, addressable: 10, families: 1 } },
    exclusions: [],
  };
  const smallerWorld = censusOf({ weedTargets: 16 });
  const fourOfSix = await measure(
    { cut_weeds: 4, till_soil: 4, move_to_tile: 4, sleep: 4 },
    { baseline, census: smallerWorld },
  );
  assert.equal(fourOfSix.addressable, 6, "the small world: one target family with rows, five actions needing none");
  assert.equal(fourOfSix.attempted, 4);
  assert.ok(
    fourOfSix.attempted < baseline.baselines.multiday_routine.attempted,
    "fewer attempts than the baseline made",
  );
  assert.equal(fourOfSix.verdict, "rich", "and still above it, because 4 of 6 covers more of its world than 5 of 10");

  const threeOfEleven = await measure(
    { cut_weeds: 4, till_soil: 4, sleep: 4 },
    {
      baseline: {
        baselines: { multiday_routine: { label: "fixture-best", attempted: 5, addressable: 10, families: 1 } },
      },
    },
  );
  assert.equal(threeOfEleven.addressable, 12, "the whole fixture world, with no exclusions declared for this baseline");
  assert.equal(threeOfEleven.verdict, "narrow:below_baseline:fixture-best", "3 of 12 is below 5 of 10");
});

test("a run that attempts every addressable action is rich, and one that attempts three of eleven is narrow", async () => {
  const world = {
    baselines: { multiday_routine: { label: "fixture-best", attempted: 8, addressable: 9, families: 3 } },
    exclusions: BASELINE.exclusions,
  };
  const everything = await measure(
    {
      cut_weeds: 2,
      cut_grass: 2,
      break_rock: 2,
      harvest_crop: 2,
      plant_seed: 2,
      water_crop: 2,
      till_soil: 2,
      move_to_tile: 2,
      enter_exit: 2,
      sleep: 2,
      talk_to_npc: 2,
    },
    { baseline: world },
  );
  assert.equal(everything.addressable, 11);
  assert.equal(everything.attempted, 11);
  assert.equal(everything.coverage, 1);
  assert.equal(
    everything.verdict,
    "rich",
    "the whole addressable surface was used, including the excluded action's absence",
  );

  // And the other end: three of eleven, all in the one family the ratchet's family count does not object to, so
  // coverage is what fails it.
  const threeOfEleven = await measure(
    { cut_weeds: 4, cut_grass: 4, break_rock: 4 },
    {
      baseline: {
        baselines: { multiday_routine: { label: "fixture-best", attempted: 8, addressable: 9, families: 1 } },
        exclusions: BASELINE.exclusions,
      },
    },
  );
  assert.equal(threeOfEleven.addressable, 11);
  assert.equal(threeOfEleven.attempted, 3);
  assert.equal(threeOfEleven.families, 1, "the family dimension is satisfied, so only coverage can fail this run");
  assert.equal(threeOfEleven.verdict, "narrow:below_baseline:fixture-best");
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
    baselines: { multiday_routine: { label: "fixture-best", attempted: 4, addressable: 12, families: 2 } },
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
  const surface = surfaceOf(reached);
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
    { surface, census: censusOf(WIDE_ROWS, { surface }) },
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
    census: WIDE_CENSUS,
    surface: SURFACE,
    baseline: BASELINE,
  });
  assert.equal(breadth.verdict, "not_measured:no_executions");
  assert.equal(breadth.concentration, null);
  assert.equal(breadth.concentrationReason, "no_executions");
  assert.equal(actionBreadthClause(breadth).passed, true, "a measurement we could not take is not a defect of the run");
});

test("a bundle that publishes no census is not_measured, never measured against the catalog instead", async () => {
  // `round38` and `round39` predate the census. Dividing their attempts by the 95 published actions is the defect this
  // gate was rebuilt for, so the reading refuses: the world cannot be read back, and the catalog is not a substitute.
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
    { census: null },
  );
  assert.equal(breadth.addressable, null);
  assert.equal(breadth.coverage, null);
  assert.equal(breadth.census, null);
  assert.ok(breadth.catalogCoverage > 0, "the catalog coverage stays visible as context");
  assert.equal(breadth.verdict, "not_measured:no_snapshot_census");
  assert.equal(actionBreadthClause(breadth).passed, true, "unmeasurable is not narrow - but it is never rich either");
  assert.notEqual(breadth.verdict, "rich");

  // A census with no snapshots behind it is the same answer: a zero-row census would otherwise make everything
  // addressable-by-absence look measured.
  const emptyCensus = await measure(
    { cut_weeds: 4, harvest_crop: 4, move_to_tile: 4, sleep: 4 },
    { census: { source: SNAPSHOT_CENSUS_SOURCE, snapshots: 0, families: [{ family: "weedTargets", rows: 16 }] } },
  );
  assert.equal(emptyCensus.verdict, "not_measured:no_snapshot_census");
});

test("a target family the census never names is drift, reported by name", async () => {
  // The runner derived its key space from the same catalog this gate joins through, so a family missing from a
  // published census means the two sides have drifted (an older runner, a renamed family). Every action in that family
  // would silently leave the denominator, so the reading refuses and names it.
  const truncated = {
    source: SNAPSHOT_CENSUS_SOURCE,
    snapshots: 4,
    families: Object.entries(WIDE_ROWS)
      .filter(([family]) => family !== "npcRelationshipTargets")
      .map(([family, rows]) => ({ family, rows })),
  };
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
    { census: truncated },
  );
  assert.deepEqual([...breadth.censusFamiliesAbsent], ["npcRelationshipTargets"]);
  assert.equal(breadth.verdict, "not_measured:census_family_absent:npcRelationshipTargets");
});

test("an action dispatched against a family the census saw no rows for is refused, not counted", async () => {
  // The coherence the denominator rests on: every action a run dispatched had a row somewhere in its world, so an
  // attempt on a family the census reports as empty means the census missed it. Reading that as "1 of 10" would be a
  // coverage number measured against the wrong world.
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
    { census: censusOf({ ...WIDE_ROWS, weedTargets: 0 }) },
  );
  assert.deepEqual([...breadth.outsideAddressable], ["cut_weeds"]);
  assert.equal(breadth.verdict, "not_measured:action_outside_addressable:cut_weeds");
});

test("the addressable set is derived from the census, not from the catalog", async () => {
  const addressable = deriveAddressable({ surface: SURFACE, census: censusOf(NARROW_ROWS), exclusions: ["ride_bus"] });
  assert.deepEqual(
    [...addressable.targetBound],
    ["cut_weeds", "cut_grass", "break_rock", "harvest_crop", "plant_seed", "water_crop"],
    "the two families with no rows (npcRelationshipTargets, and every family-free action) are the difference",
  );
  assert.deepEqual([...addressable.targetless], ["till_soil", "move_to_tile", "enter_exit", "sleep"]);
  assert.equal(addressable.actionIds.length, 10);
  assert.deepEqual([...addressable.excludedAddressable], ["ride_bus"]);
  assert.deepEqual(
    addressable.families.map((entry) => `${entry.family}:${entry.rows}:${entry.actionIds.join("+")}`),
    [
      "cropTargets:2:water_crop",
      "grassTargets:16:cut_grass",
      "harvestTargets:3:harvest_crop",
      "rockSourceTargets:8:break_rock",
      "seedTargets:16:plant_seed",
      "weedTargets:16:cut_weeds",
    ],
    "one line per family that gave the run something to address, with the rows and the actions it made constructible",
  );
  assert.deepEqual(
    [...addressable.censusFamiliesAbsent],
    [],
    "`buildSnapshotCensus` names every target family, so a census built by this tree never drifts",
  );

  // No census, no addressable set: null rather than a catalog-sized default.
  assert.equal(deriveAddressable({ surface: SURFACE, census: null, exclusions: [] }), null);
});

test("the census names every target family, including the ones it saw no row for", () => {
  const census = buildSnapshotCensus({
    surface: SURFACE,
    rows: new Map([
      ["weedTargets", 16],
      ["capabilities", 95],
    ]),
    snapshots: 3,
  });
  assert.equal(census.source, SNAPSHOT_CENSUS_SOURCE);
  assert.equal(census.snapshots, 3);
  assert.equal(
    census.families.length,
    7,
    "the key space is the catalog's target families, not what the snapshots happened to carry",
  );
  assert.deepEqual(
    census.families.filter((entry) => entry.rows > 0),
    [{ family: "weedTargets", rows: 16 }],
    "a non-target array (capabilities) is not a family this census speaks about",
  );
  assert.equal(
    census.families.find((entry) => entry.family === "cropTargets").rows,
    0,
    "empty and unobserved differ here",
  );
});

test("a snapshot contributes the largest row count it showed for each family", () => {
  const rows = new Map();
  addSnapshotToCensus(rows, {
    weedTargets: [{ targetId: "a" }, { targetId: "b" }],
    capabilities: ["x"],
    location: "Farm",
  });
  addSnapshotToCensus(rows, { weedTargets: [{ targetId: "c" }], cropTargets: [] });
  addSnapshotToCensus(rows, null);
  assert.equal(rows.get("weedTargets"), 2, "the max, not the sum: one snapshot cannot be counted twice");
  assert.equal(rows.get("capabilities"), 1);
  assert.equal(rows.has("cropTargets"), false, "an empty array is no row at all");
  assert.equal(rows.has("location"), false, "a scalar is not a family");
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
    census: WIDE_CENSUS,
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

test("the reading prints its population, its census, its addressable set, its coverage and its verdict", () => {
  const breadth = {
    attempted: 15,
    succeeded: 14,
    published: 95,
    judged: 91,
    census: {
      source: SNAPSHOT_CENSUS_SOURCE,
      snapshots: 402,
      families: [
        { family: "weedTargets", rows: 16 },
        { family: "grassTargets", rows: 16 },
        { family: "fishPondTargets", rows: 0 },
      ],
    },
    addressable: 40,
    addressableTargetBound: 25,
    addressableTargetless: 15,
    coverage: 15 / 40,
    catalogCoverage: 15 / 95,
    families: 2,
    publishedFamilies: 20,
    familyNames: ["resource_gathering", "world_lifecycle"],
    executions: 124,
    attributedExecutions: 124,
    concentration: { actionId: "cut_weeds", executions: 32, share: 32 / 124 },
    concentrationReason: null,
    verdict: "narrow:below_baseline:round38",
  };
  assert.deepEqual(formatActionBreadth(breadth), [
    "action_breadth: population 95 published, 91 judged (4 excluded)",
    "action_breadth: census 402 snapshots from runner_observations, 2 of 3 target families with rows",
    "action_breadth: addressable 40 of 95 published (target-bound 25, targetless 15)",
    "action_breadth: attempted 15 of 40 addressable (37.5%); succeeded 14 of 40; catalog 15 of 95 (15.8%)",
    "action_breadth: families 2 of 20 resource_gathering,world_lifecycle",
    "action_breadth: executions 124 (124 attributed); concentration cut_weeds 32 (25.8%)",
    "action_breadth: verdict narrow:below_baseline:round38",
  ]);

  // And the shape a bundle from before the census produces: the catalog stays visible, the addressable set does not.
  assert.deepEqual(formatActionBreadth({ ...breadth, census: null, addressable: null, coverage: null }).slice(1, 4), [
    "action_breadth: census none published - the addressable surface cannot be measured",
    "action_breadth: addressable not_measured (no snapshot census)",
    "action_breadth: attempted 15 of 95 published (15.8%)",
  ]);
});
