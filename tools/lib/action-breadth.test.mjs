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
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { programExecutionRows } from "../live-run/game/execution-trace.mjs";
import {
  ACTION_BREADTH_CONCENTRATION_SHARE,
  actionBreadthClause,
  actionExecutionCounts,
  addSnapshotToCensus,
  addSnapshotToolCategories,
  buildSnapshotCensus,
  deriveAddressable,
  formatActionBreadth,
  measureActionBreadth,
  readActionBreadthBaseline,
  readActionBreadthSurface,
  SNAPSHOT_CENSUS_SOURCE,
  TOOL_CLAIM_CATEGORIES,
  unmeasuredActionBreadth,
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
  // The one fixture action whose target family is a TILE list and whose declared tool is not a farming implement: the cast
  // needs the rod, and the water in reach says nothing about whether one is in the pack (`round76`'s `fish_here`).
  fish_here: "waterTargets",
});

function surfaceOf(actionIds, { toolClaimOf = {} } = {}) {
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
    toolClaimOf: new Map(Object.entries(toolClaimOf).filter(([actionId]) => actionIds.includes(actionId))),
  };
}

const ALL_ACTIONS = Object.keys(FAMILY_OF).concat(["fish_here"]);
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

/** The eleven actions the wide fixture world makes addressable: seven target-bound families with rows, four needing none. */
const WIDE_ADDRESSABLE = Object.freeze([
  "cut_weeds",
  "cut_grass",
  "break_rock",
  "harvest_crop",
  "plant_seed",
  "water_crop",
  "talk_to_npc",
  "till_soil",
  "move_to_tile",
  "enter_exit",
  "sleep",
]);

/** The eight of those the recorded floor run addressed. */
const FLOOR_ATTEMPTED = Object.freeze([
  "cut_weeds",
  "break_rock",
  "harvest_crop",
  "till_soil",
  "move_to_tile",
  "enter_exit",
  "sleep",
  "talk_to_npc",
]);

/** The one action this fixture cannot reach, with the native precondition that says why. */
const RIDE_BUS_EXCLUSION = Object.freeze([
  Object.freeze({
    actionId: "ride_bus",
    reason:
      "targets the Bus Stop ticket machine and drives its native dialogue; the bus is out of order until the Vault repair",
  }),
]);

/** The whole fixture world when nothing is excluded: the eleven above plus the bus. */
const WHOLE_FIXTURE_WORLD = Object.freeze([...WIDE_ADDRESSABLE, "ride_bus"]);

/**
 * One ratchet entry, with the coverage floor recorded the way the reader records it: as the ACTIONS the floor run could
 * address and the ones it addressed.
 *
 * The floor's counts are deliberately absent - the reader derives them from the two lists, and a second spelling here
 * would be the disagreement between a count and the ids it counts that this shape exists to end.
 */
function ratchet({
  attempted,
  addressable,
  floorLabel = "fixture-floor",
  label = "fixture-best",
  familiesAttempted = null,
  exclusions = [],
}) {
  return {
    baselines: {
      multiday_routine: {
        label,
        attempted: 8,
        addressable: null,
        families: 4,
        ...(familiesAttempted === null ? {} : { familiesAttempted }),
        coverageFloor: { label: floorLabel, attemptedActionIds: attempted, addressableActionIds: addressable },
      },
    },
    exclusions,
  };
}

/** The ratchet: the floor addressed eight of the world's eleven addressable actions, and `ride_bus` is out of reach. */
const BASELINE = ratchet({ attempted: FLOOR_ATTEMPTED, addressable: WIDE_ADDRESSABLE, exclusions: RIDE_BUS_EXCLUSION });

test("every tool the catalog declares is a word this reading can interpret", async () => {
  // THE ONE TEST HERE THAT READS TODAY'S CATALOG, and it must: the population is the Mod's own declarations, and a claim
  // word this tree cannot interpret would silently stop withholding - or start withholding - for actions nobody has
  // written yet. `TOOL_CLAIM_CATEGORIES` holds the Mod's own vocabulary (`ToolCategory` plus its three predicate words);
  // a word outside it has to be added there with the predicate it means, so this fails and names the word.
  const surface = await readActionBreadthSurface();
  assert.ok(surface.toolClaimOf.size > 0, "blocked: the catalog declares no tool claim, so this gate examined nothing");
  const uninterpretable = [...new Set(surface.toolClaimOf.values())].filter(
    (word) => TOOL_CLAIM_CATEGORIES[word] === undefined,
  );
  assert.deepEqual(
    uninterpretable,
    [],
    `these declared tool words have no category set in TOOL_CLAIM_CATEGORIES, so the actions that declare them cannot be judged: ${uninterpretable.join(",")}`,
  );
});

test("the floor fails a run that addressed fewer of the shared actions than the recorded floor did", async () => {
  // THE ARM THAT KEEPS THE FAMILY COMPARISON HONEST. Dropping the absolute family count leaves a run in a thin world free
  // to work in both of its families and still address three of eleven actions; the floor is the coverage such a run has to
  // meet, taken from the best census-bearing run and recorded as the ACTIONS it could address and the ones it addressed.
  const thin = await measure({ cut_weeds: 4, harvest_crop: 4, move_to_tile: 4 });
  assert.equal(thin.addressable, 11);
  assert.deepEqual(
    [thin.baselineSameWorld.attempted, thin.baselineSameWorld.addressable, thin.baselineSameWorld.held],
    [3, 11, 8],
    "three of the eleven both worlds made addressable, against the floor's eight there",
  );
  assert.deepEqual(
    [...thin.baselineSameWorld.skipped],
    ["break_rock", "enter_exit", "sleep", "talk_to_npc", "till_soil"],
    "and the floor's actions it never touched are named, not counted",
  );
  assert.equal(
    thin.verdict,
    "narrow:below_baseline:fixture-best:coverage=3/11:held=8/11:by=fixture-floor",
    "coverage alone fails it, and the code names the dimension, both halves of the shared world's counts, and who held it",
  );
  assert.deepEqual(thin.baselineCompared, {
    dimension: "coverage",
    label: "fixture-floor",
    attempted: 8,
    addressable: 11,
    what: "the actions both worlds made addressable, and how many of them the floor run addressed",
  });
  assert.equal(thin.baselineFailed, "coverage", "and which dimension decided is a field, not a word to decode");

  // The falsifier: the floor's own eight clears the floor, and nothing else in this reading objects.
  const wide = await measure({
    cut_weeds: 4,
    break_rock: 4,
    harvest_crop: 4,
    till_soil: 4,
    move_to_tile: 4,
    enter_exit: 4,
    sleep: 4,
    talk_to_npc: 4,
  });
  assert.equal(wide.verdict, "rich");
});

test("the floor is compared on the world both runs had, so a wider world does not lower a run's verdict", async () => {
  // MEASURED 2026-11-23 (`round95`/`96`/`97`): three consecutive multiday runs attempted 26 of 57, 20 of 55 and 18 of 53
  // addressable, and the addressable width fell only because families published no rows on those days. Against a floor
  // recorded as a rate (17 of 43) the same 18 attempts read as 34.0 %, and against a 43-wide world as 41.9 % - the verdict
  // moved with the fixture, not with her.
  //
  // The fixture is that shape in miniature: a floor whose world held six actions and which addressed all six, and a run in
  // an eleven-action world that addressed exactly those six. Its own coverage (6 of 11) is half the floor's 6 of 6, and it
  // is NOT below it: the five actions the floor's world never had are not this run's work to do.
  const sharedWorld = ["cut_weeds", "cut_grass", "break_rock", "harvest_crop", "plant_seed", "move_to_tile"];
  const narrowFloor = ratchet({ attempted: sharedWorld, addressable: sharedWorld, exclusions: RIDE_BUS_EXCLUSION });
  const sameSix = await measure(
    { cut_weeds: 4, cut_grass: 4, break_rock: 4, harvest_crop: 4, plant_seed: 4, move_to_tile: 4 },
    { baseline: narrowFloor },
  );
  assert.equal(sameSix.addressable, 11, "this run's own world is nearly twice the floor's");
  assert.ok(sameSix.coverage <= 6 / 11, "and its own coverage is below the floor's own");
  assert.deepEqual(
    [sameSix.baselineSameWorld.attempted, sameSix.baselineSameWorld.addressable, sameSix.baselineSameWorld.held],
    [6, 6, 6],
  );
  assert.equal(sameSix.verdict, "rich", "the six actions both worlds had were all addressed, by both runs");

  // The falsifier, one action apart: skip one of the six and the same run is below the same floor.
  const five = await measure(
    { cut_weeds: 4, cut_grass: 4, break_rock: 4, harvest_crop: 4, plant_seed: 4 },
    { baseline: narrowFloor },
  );
  assert.deepEqual([...five.baselineSameWorld.skipped], ["move_to_tile"]);
  assert.equal(five.verdict, "narrow:below_baseline:fixture-best:coverage=5/6:held=6/6:by=fixture-floor");
});

test("a floor whose world shares no action with this run is not_measured, never rich", async () => {
  // A population of zero is never a pass: with nothing the two worlds share, the ratchet compared nothing, and the verdict
  // says which input was missing instead of reading as a comparison she won.
  const otherWorld = ratchet({ attempted: ["fish_here"], addressable: ["fish_here"] });
  const breadth = await measure({ cut_weeds: 4, break_rock: 4, till_soil: 4, sleep: 4 }, { baseline: otherWorld });
  assert.equal(breadth.baselineSameWorld, null);
  assert.equal(breadth.verdict, "not_measured:no_shared_world_with_baseline:fixture-floor");
});

test("a ratchet whose three dimensions disagree with each other is refused, not partly read", async () => {
  const path = join(tmpdir(), `action-breadth-baseline-${process.pid}.json`);
  const write = (entry) =>
    writeFileSync(path, JSON.stringify({ baselines: { multiday_routine: entry }, exclusions: [] }));
  try {
    write({ label: "fixture", attempted: 5, families: 2, familiesAttempted: { farming_crops: 2 } });
    await assert.rejects(
      readActionBreadthBaseline({ path }),
      /action_breadth_baseline_families_do_not_sum:multiday_routine:2:5/u,
      "a split that does not add up describes a different run",
    );
    // The floor is ids, and its two lists are one population: an attempt outside the world the same entry records, a list
    // with a repeated id, and an empty list each mean the entry describes a comparison no run ever had.
    write({
      label: "fixture",
      attempted: 5,
      families: 2,
      coverageFloor: { label: "x", addressableActionIds: ["a"], attemptedActionIds: ["b"] },
    });
    await assert.rejects(
      readActionBreadthBaseline({ path }),
      /action_breadth_baseline_coverage_floor_attempted_outside:multiday_routine:b/u,
      "an action the floor addressed outside the world it could address is not a coverage",
    );
    write({
      label: "fixture",
      attempted: 5,
      families: 2,
      coverageFloor: { label: "x", addressableActionIds: ["a", "a"], attemptedActionIds: ["a"] },
    });
    await assert.rejects(
      readActionBreadthBaseline({ path }),
      /action_breadth_baseline_coverage_floor_duplicate:multiday_routine/u,
    );
    write({
      label: "fixture",
      attempted: 5,
      families: 2,
      coverageFloor: { label: "x", addressableActionIds: [], attemptedActionIds: ["a"] },
    });
    await assert.rejects(
      readActionBreadthBaseline({ path }),
      /action_breadth_baseline_coverage_floor_unpopulated:multiday_routine/u,
      "a floor with no world is a comparison over nothing",
    );
    // And the counts the file used to carry are derived, so an entry that repeats them beside the ids is read from the ids.
    write({
      label: "fixture",
      attempted: 5,
      families: 2,
      coverageFloor: {
        label: "x",
        addressableActionIds: ["a", "b", "c"],
        attemptedActionIds: ["a", "b"],
        attempted: 99,
        addressable: 99,
      },
    });
    const read = await readActionBreadthBaseline({ path });
    assert.deepEqual(
      [
        read.baselines.multiday_routine.coverageFloor.attempted,
        read.baselines.multiday_routine.coverageFloor.addressable,
      ],
      [2, 3],
      "the lists are the authority, so a stale count beside them cannot decide anything",
    );
  } finally {
    rmSync(path, { force: true });
  }
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

test("the ratchet this tree ships is one its own reader can read, and one its own catalog names", async () => {
  // THE FILE AND THE READER ARE ONE UNIT. Measured 2026-11-23 (`round98`): the floor was re-recorded as action ids at
  // 17:36 while a process that had loaded the PREVIOUS reader at 17:28 was still running, so the reader refused the tree's
  // own floor file inside that run's assembly - and the run's record was lost. A test against a temp file cannot say
  // anything about that pair; this one reads the shipped pair, and every floor id against the shipped catalog.
  const baseline = await readActionBreadthBaseline();
  const surface = await readActionBreadthSurface();
  const scenarios = Object.keys(baseline.baselines);
  assert.ok(scenarios.length > 0, "blocked: the shipped ratchet records no scenario, so this gate examined nothing");
  let floors = 0;
  for (const scenario of scenarios) {
    const floor = baseline.baselines[scenario].coverageFloor ?? null;
    if (floor === null || floor === undefined) continue;
    floors += 1;
    const unknown = [...floor.addressableActionIds, ...floor.attemptedActionIds].filter(
      (actionId) => !surface.actionIds.includes(actionId),
    );
    assert.deepEqual(
      unknown,
      [],
      `${scenario}: the recorded floor names actions this catalog does not publish: ${unknown.join(",")} - re-record it from the bundle it came from`,
    );
    assert.ok(
      floor.attempted > 0 && floor.addressable >= floor.attempted,
      `${scenario}: the floor's counts are derived from its own ids, so the world is never narrower than what it addressed`,
    );
  }
  assert.ok(
    floors > 0,
    "blocked: no scenario records a coverage floor, so the coverage dimension is compared against nothing",
  );
});

test("a reading nobody could take is the same shape as one that was, and says so", async () => {
  // THE SHAPE PARITY. `round98` (2026-11-23) finished its work and could not measure its breadth: the baseline reader threw
  // while the record was being assembled. The artifact still has to carry `actionBreadth`, and every reader of it - the
  // clause, the formatter, the bundle, the analysis tool - reads ONE shape. So the gap is a reading whose numbers are
  // `null` and whose verdict is the gap code, and this test holds the two shapes to each other key by key: a field added
  // to `measureActionBreadth` without being added here would make the unmeasured artifact a second, smaller shape.
  const measured = await measure({ cut_weeds: 4, break_rock: 4 });
  const unmeasured = unmeasuredActionBreadth({
    scenario: "multiday_routine",
    code: "not_measured:action_breadth:action_breadth_baseline_coverage_floor_invalid:multiday_routine",
    attempted: 2,
    succeeded: 2,
  });
  assert.deepEqual(
    Object.keys(unmeasured).sort(),
    Object.keys(measured).sort(),
    "an unmeasured reading and a measured one are one shape",
  );
  // What the caller already knew travels: the run's own dispatch trace is not this reading's work, so a failed reading
  // still says how many actions were used.
  assert.equal(unmeasured.attempted, 2);
  assert.equal(unmeasured.succeeded, 2);
  assert.equal(unmeasured.scenario, "multiday_routine");
  // And every population is absent rather than zero: a measured zero is a fact, and this run never measured one.
  for (const key of ["addressable", "published", "coverage", "catalogCoverage", "families", "executions"])
    assert.equal(unmeasured[key], null, `${key} must be null, never 0: the reading was never taken`);
  assert.equal(
    unmeasured.verdict,
    "not_measured:action_breadth:action_breadth_baseline_coverage_floor_invalid:multiday_routine",
  );
  // NOT MEASURED IS NOT NARROW, and not rich either: the clause passes, carrying the code.
  assert.deepEqual(actionBreadthClause(unmeasured), {
    id: "action_breadth",
    passed: true,
    reasonCode: unmeasured.verdict,
  });
  // The formatter prints the gap and nothing invented: one line, no `attempted 0`.
  const lines = formatActionBreadth(unmeasured);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^action_breadth: not measured - not_measured:action_breadth:.+$/u);
});

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
  assert.equal(oneShort.verdict, "narrow:below_baseline:fixture-best:coverage=7/11:held=8/11:by=fixture-floor");
  assert.deepEqual(actionBreadthClause(oneShort), {
    id: "action_breadth",
    passed: false,
    reasonCode: "narrow:below_baseline:fixture-best:coverage=7/11:held=8/11:by=fixture-floor",
  });
});

test("a family the run's own world offered and the baseline worked in is what fails the ratchet", async () => {
  // THE DEFECT THIS REPLACED. The old arm opened with `familyCount < scenarioBaseline.families` and vetoed any run whose
  // world or task mix was narrower than the best run's - `round38` worked in eleven families including `transport_warps`,
  // so three farm-only days that did real work in every family their own world offered were "below" it for families they
  // never had. What is compared now is the share of THIS run's own families that the baseline also worked in.
  const baseline = ratchet({
    attempted: FLOOR_ATTEMPTED,
    addressable: WIDE_ADDRESSABLE,
    exclusions: RIDE_BUS_EXCLUSION,
    familiesAttempted: { resource_gathering: 3, farming_crops: 2, npc_social: 1 },
  });
  const withoutSocial = {
    cut_weeds: 4,
    cut_grass: 4,
    break_rock: 4,
    harvest_crop: 4,
    till_soil: 4,
    move_to_tile: 4,
    enter_exit: 4,
    sleep: 4,
  };

  // The world offered a stranger and the run never spoke to one: below, and NAMED, because that is a family the run could
  // have worked in and did not.
  const skipped = await measure(withoutSocial, { baseline });
  assert.deepEqual([...skipped.baselineMissedFamilies], ["npc_social"]);
  assert.equal(skipped.verdict, "narrow:below_baseline:fixture-best:families=npc_social");

  // The falsifier, one action apart: the same day plus one conversation is not below the same baseline.
  const covered = await measure({ ...withoutSocial, talk_to_npc: 4 }, { baseline });
  assert.deepEqual([...covered.baselineMissedFamilies], []);
  assert.equal(covered.verdict, "rich", "a family the run worked in is a family it cannot be charged for skipping");

  // And the veto this arm exists to remove: a world that never published a villager is not asked about `npc_social`, so
  // the same work in a farm-only world is not below a baseline recorded in a world that had a town.
  const farmOnly = await measure(withoutSocial, { baseline, census: censusOf(NARROW_ROWS) });
  assert.equal(farmOnly.addressable, 10, "the narrow world: five target-bound actions, four family-free, one excluded");
  assert.equal(farmOnly.families, 4, "and four families worked in, over the three the baseline recorded");
  assert.equal(
    farmOnly.verdict,
    "rich",
    "`round38`'s transport_warps and npc_social are not charged to a run whose world never offered them",
  );
});

test("coverage is compared on the actions both worlds had, so a smaller world is not charged for being smaller", async () => {
  // The defect this reading was rebuilt for: a world that arms six actions cannot be held to a count of five attempts out
  // of a ten-action world. Here the floor's world is the whole fixture (twelve actions) and it addressed five of them; a run
  // in a world that published one family and addressed the four it had is not below it, because the shared world is what
  // both counts are taken inside and the four are all of it.
  const baseline = ratchet({
    attempted: ["cut_weeds", "till_soil", "move_to_tile", "sleep", "talk_to_npc"],
    addressable: WHOLE_FIXTURE_WORLD,
  });
  const smallerWorld = censusOf({ weedTargets: 16 });
  const fourOfSix = await measure(
    { cut_weeds: 4, till_soil: 4, move_to_tile: 4, sleep: 4 },
    { baseline, census: smallerWorld },
  );
  assert.equal(fourOfSix.addressable, 6, "the small world: one target family with rows, five actions needing none");
  assert.equal(fourOfSix.attempted, 4, "and four attempts, fewer than the floor's five");
  assert.deepEqual(
    [fourOfSix.baselineSameWorld.attempted, fourOfSix.baselineSameWorld.addressable, fourOfSix.baselineSameWorld.held],
    [4, 6, 4],
    "the shared world is the four target-bound actions plus the two family-free ones the floor also had",
  );
  assert.equal(fourOfSix.verdict, "rich", "four of the four shared actions the floor addressed is not below it");

  // And the other end, in a world with no exclusion declared: three actions of twelve, none of them the floor's missing
  // one, is below a floor that addressed five.
  const threeOfTwelve = await measure({ cut_weeds: 4, till_soil: 4, sleep: 4 }, { baseline });
  assert.equal(threeOfTwelve.addressable, 12, "the whole fixture world, with no exclusions declared for this baseline");
  assert.equal(
    threeOfTwelve.verdict,
    "narrow:below_baseline:fixture-best:coverage=3/12:held=5/12:by=fixture-floor",
    "3 of the 12 shared actions is below the floor's 5, and the code carries both halves for a reader to redo it",
  );
});

test("a run that attempts every addressable action is rich, and one that attempts three of eleven is narrow", async () => {
  const world = ratchet({ attempted: FLOOR_ATTEMPTED, addressable: WIDE_ADDRESSABLE, exclusions: RIDE_BUS_EXCLUSION });
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
      baseline: ratchet({ attempted: FLOOR_ATTEMPTED, addressable: WIDE_ADDRESSABLE, exclusions: RIDE_BUS_EXCLUSION }),
    },
  );
  assert.equal(threeOfEleven.addressable, 11);
  assert.equal(threeOfEleven.attempted, 3);
  assert.equal(threeOfEleven.families, 1, "the family dimension is satisfied, so only coverage can fail this run");
  assert.equal(threeOfEleven.verdict, "narrow:below_baseline:fixture-best:coverage=3/11:held=8/11:by=fixture-floor");
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
  // Exactly 40 % of 100 executions: the largest action is a large part of the day but the day still has four parts. The
  // floor addressed exactly the four actions both runs here attempt, so only the concentration rule is being asked about.
  const atTheLine = ratchet({
    attempted: ["cut_weeds", "cut_grass", "break_rock", "harvest_crop"],
    addressable: WHOLE_FIXTURE_WORLD,
  });
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
    // Every family the catalog names except the one being withheld: the census's own key space, so the only drift is the
    // family this fixture leaves out.
    families: SURFACE.targetFields
      .filter((family) => family !== "npcRelationshipTargets")
      .map((family) => ({ family, rows: WIDE_ROWS[family] ?? 0 })),
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
  // Five published ids in one literal would itself be the second authority this gate forbids, so the set is read in
  // two halves against the same derived array.
  const targetBound = [...addressable.targetBound];
  assert.deepEqual(targetBound.slice(0, 3), ["cut_weeds", "cut_grass", "break_rock"]);
  assert.deepEqual(
    targetBound.slice(3),
    ["harvest_crop", "plant_seed", "water_crop"],
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
    SURFACE.targetFields.length,
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

test("an action whose declared tool was never held is withheld, whatever its witness family carried", () => {
  // MEASURED 2026-11-18 (`round76`): `waterTargets` carried 32 reachable tiles and `fish_here` was counted addressable for
  // a run that never held a rod. The declaration the Mod resolves the tool from is the authority here, and the run's own
  // `toolSlots` is the evidence.
  const surface = surfaceOf(ALL_ACTIONS, { toolClaimOf: { cut_weeds: "scythe" } });
  const withoutTool = deriveAddressable({
    surface,
    census: censusOf(WIDE_ROWS, { surface }),
    exclusions: ["ride_bus"],
  });
  assert.deepEqual(
    withoutTool.withheld.map((entry) => `${entry.actionId}:${entry.reason}`),
    ["cut_weeds:tool_not_held:scythe"],
    "the family had rows and the action still could not run",
  );
  assert.ok(!withoutTool.actionIds.includes("cut_weeds"));
  assert.deepEqual(
    withoutTool.families.find((entry) => entry.family === "weedTargets").actionIds,
    ["cut_weeds"],
    "the family still says what it made constructible; the withholding is its own list",
  );

  // The falsifier: the same world with the tool in the pack puts it back, and nothing else changes.
  const withTool = deriveAddressable({
    surface,
    census: buildSnapshotCensus({ surface, rows: new Map(Object.entries(WIDE_ROWS)), snapshots: 5, tools: ["scythe"] }),
    exclusions: ["ride_bus"],
  });
  assert.deepEqual(withTool.withheld, []);
  assert.ok(withTool.actionIds.includes("cut_weeds"));
  assert.equal(withTool.actionIds.length, withoutTool.actionIds.length + 1);
});

test("an action the run dispatched stays addressable when its census could not evidence the tool", () => {
  // A census from before the tool reading (`tools: null`) says nothing about the pack. Withholding on it would charge the
  // run for our sampling gap, so the dispatch itself is the evidence and the row says where the evidence came from.
  const surface = surfaceOf(ALL_ACTIONS, {
    toolClaimOf: { cut_weeds: "scythe", cut_grass: "scythe", fish_here: "fishing_rod" },
  });
  const addressable = deriveAddressable({
    surface,
    census: censusOf(WIDE_ROWS, { surface }),
    exclusions: ["ride_bus"],
    attempted: ["cut_weeds"],
  });
  // `cut_grass` declares the SAME single-category tool the run demonstrably used, so the tool is held for it too; the rod
  // was never used and never published, so `fish_here` is withheld - but it has no witness family in this fixture, so it
  // is not in the target-bound set at all and nothing is withheld.
  assert.deepEqual([...addressable.fromAttempt], ["cut_weeds", "cut_grass"]);
  assert.deepEqual(addressable.withheld, [], "no other action in this fixture declares a tool");
  assert.ok(addressable.actionIds.includes("cut_weeds") && addressable.actionIds.includes("cut_grass"));

  // And an action that declares a tool nothing else proves, which the run never attempted, is withheld.
  const loneRod = deriveAddressable({
    surface: surfaceOf(ALL_ACTIONS, { toolClaimOf: { cut_grass: "scythe", fish_here: "fishing_rod" } }),
    census: buildSnapshotCensus({
      surface: SURFACE,
      rows: new Map([...Object.entries(WIDE_ROWS), ["waterTargets", 32]]),
      snapshots: 5,
      tools: ["axe"],
    }),
    exclusions: ["ride_bus"],
    attempted: ["cut_grass"],
  });
  assert.deepEqual(
    loneRod.withheld.map((entry) => `${entry.actionId}:${entry.reason}`),
    ["fish_here:tool_not_held:fishing_rod"],
    "the pack published an axe, not the rod the cast needs",
  );
});

test("a declared tool word this tree cannot interpret is named, never used to withhold", () => {
  // The failure this rule must not have: a modded claim word silently removing an action from every future denominator.
  const surface = surfaceOf(ALL_ACTIONS, { toolClaimOf: { cut_weeds: "modded_laser_wand" } });
  const addressable = deriveAddressable({
    surface,
    census: buildSnapshotCensus({ surface, rows: new Map(Object.entries(WIDE_ROWS)), snapshots: 5, tools: [] }),
    exclusions: ["ride_bus"],
  });
  assert.deepEqual(
    addressable.toolClaimUnmeasured.map((entry) => `${entry.actionId}:${entry.word}`),
    ["cut_weeds:modded_laser_wand"],
  );
  assert.ok(addressable.actionIds.includes("cut_weeds"), "an uninterpretable claim must not shrink the surface");
  assert.deepEqual(addressable.withheld, []);
});

test("a family that publishes the whole bag does not witness its action's subject", () => {
  // `round76`'s own shape: 16 ordinary slots made `open_geode` addressable. The decl ared list names the family and the
  // fact it cannot carry; an action the run ATTEMPTED is put back, so a stale entry cannot quietly shrink the surface.
  const surface = surfaceOf(ALL_ACTIONS, {});
  // The family must be in the surface's own key space as well as on the action, or the census cannot name it at all.
  surface.targetFieldOf.set("ride_bus", "inventoryItemFacts");
  surface.targetFields.push("inventoryItemFacts");
  const rows = { ...WIDE_ROWS, inventoryItemFacts: 16 };
  const withheldReading = deriveAddressable({
    surface,
    census: buildSnapshotCensus({ surface, rows: new Map(Object.entries(rows)), snapshots: 5 }),
  });
  assert.deepEqual(
    withheldReading.withheld.map((entry) => `${entry.actionId}:${entry.reason}`),
    ["ride_bus:witness_is_a_superset:inventoryItemFacts"],
  );
  assert.ok(!withheldReading.actionIds.includes("ride_bus"));

  const attemptedReading = deriveAddressable({
    surface,
    census: buildSnapshotCensus({ surface, rows: new Map(Object.entries(rows)), snapshots: 5 }),
    attempted: ["ride_bus"],
  });
  assert.deepEqual(
    [...attemptedReading.fromAttempt],
    ["ride_bus"],
    "the run's own execution outranks the declared rule",
  );
  assert.ok(attemptedReading.actionIds.includes("ride_bus"));
});

test("the census carries the tool categories the snapshots published, and only those", () => {
  const categories = new Set();
  addSnapshotToolCategories(categories, {
    toolSlots: [
      { slot: 0, label: "Axe", category: "axe" },
      { slot: 1, label: "Watering Can", category: "watering_can" },
    ],
  });
  addSnapshotToolCategories(categories, { toolSlots: [{ slot: 0, label: "Pickaxe", category: "pickaxe" }] });
  addSnapshotToolCategories(categories, { toolSlots: [{ slot: 0, label: "mystery" }, { category: "" }, null] });
  addSnapshotToolCategories(categories, null);
  assert.deepEqual([...categories].sort(), ["axe", "pickaxe", "watering_can"]);
  // A census built without them says so with null, which is not the same answer as "nothing was held".
  assert.equal(buildSnapshotCensus({ surface: SURFACE, rows: new Map(), snapshots: 1 }).tools, null);
  assert.deepEqual(
    buildSnapshotCensus({ surface: SURFACE, rows: new Map(), snapshots: 1, tools: [] }).tools,
    [],
    "sampled and empty is an answer",
  );
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
    scenario: "multiday_routine",
    baseline: { label: "round38" },
    baselineCompared: {
      dimension: "coverage",
      label: "round76",
      attempted: 14,
      addressable: 26,
      what: "the actions both worlds made addressable, and how many of them the floor run addressed",
    },
    baselineSameWorld: {
      label: "round76",
      addressable: 26,
      attempted: 12,
      held: 14,
      skipped: ["craft_item", "till_soil"],
    },
    baselineFailed: "coverage",
    verdict: "narrow:below_baseline:round38:coverage=12/26:held=14/26:by=round76",
  };
  assert.deepEqual(formatActionBreadth(breadth), [
    "action_breadth: population 95 published, 91 judged (4 excluded)",
    "action_breadth: census 402 snapshots from runner_observations, 2 of 3 target families with rows",
    "action_breadth: addressable 40 of 95 published (target-bound 25, targetless 15)",
    // THE LINE THE VERDICT HAS TO BE READ AGAINST: the companion's attempts, the world's own width in families, the
    // catalog, and the bar - which is the SAME-WORLD pair, printed with this run's number inside it so a reader can see
    // which of the two moved.
    "action_breadth: attempted 15 of 40 addressable (37.5%) (published 2 of 3 families); succeeded 14 of 40; published 95 (55 never addressable in this world); baseline-held 14 of 26 same-world by round76, this run 12 (the actions both worlds made addressable, and how many of them the floor run addressed); compared coverage",
    "action_breadth: families 2 of 20 resource_gathering,world_lifecycle",
    "action_breadth: executions 124 (124 attributed); concentration cut_weeds 32 (25.8%)",
    "action_breadth: verdict narrow:below_baseline:round38:coverage=12/26:held=14/26:by=round76",
  ]);

  // And the shape a bundle from before the census produces: the catalog stays visible, the addressable set does not, and
  // the bar says which input was missing rather than printing a ratio nobody held.
  assert.deepEqual(
    formatActionBreadth({ ...breadth, census: null, addressable: null, coverage: null, baselineFailed: null }).slice(
      1,
      4,
    ),
    [
      "action_breadth: census none published - the addressable surface cannot be measured",
      "action_breadth: addressable not_measured (no snapshot census)",
      "action_breadth: attempted 15 of 95 published; succeeded 14 (no snapshot census, so the addressable width is not measurable); baseline-held not_measured (this run published no snapshot census, so it has no world of its own to compare); compared none",
    ],
  );

  // The families arm prints its own bar in its own terms: a set, not a ratio, because that is what it compares.
  const byFamily = formatActionBreadth({
    ...breadth,
    baselineCompared: {
      dimension: "families",
      label: "round38",
      offered: ["farming_crops", "resource_gathering", "shops_economy"],
      touched: 1,
      what: "the families this run's world offered that the recorded best worked in",
    },
    baselineFailed: "families",
    verdict: "narrow:below_baseline:round38:families=resource_gathering,shops_economy",
  });
  assert.match(
    byFamily[3],
    /baseline-held 1 of 3 families by round38 \(the families this run's world offered .*compared families$/u,
  );
});
