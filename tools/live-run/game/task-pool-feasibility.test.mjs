/**
 * The pool's world preconditions, and the one observation that answers all of them.
 *
 * The cases below are the failure classes the check exists for, in the order the pool met them: a task nobody declared a
 * world for, a fact the Mod did not measure read as if it were an empty world, an empty pool that would otherwise agree
 * with itself, and the two halves of `dress_and_display` - the day the opening snapshot could not have supported.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DAILY_TASK_ROTATION, TASK_PRECONDITIONS } from "../../lib/multiday-daily-tasks.mjs";
import {
  TASK_POOL_BUDGET_MS,
  describeRequirement,
  describeTaskPoolAtOpening,
  estimateTaskPoolAtOpening,
  readRequirement,
  rereadDaySeedMarket,
} from "./task-pool-feasibility.mjs";

const SNAPSHOT_SAMPLE = new URL(
  "../../../integrations/stardew/action-development/contracts/generated/snapshot-sample.v1.json",
  import.meta.url,
);

/** The opening snapshot as the harness hands it over: a Farm, a revision, and a world with one of everything. */
function satisfiedWorld() {
  const block = { blockX: 60, blockY: 10, blockW: 3, blockH: 20 };
  return {
    revision: 7,
    location: "Farm",
    tile: { x: 64, y: 12 },
    money: 12_000,
    soilTiles: [
      { x: 60, y: 10, hoeDirt: false, ...block },
      { x: 61, y: 10, hoeDirt: false, ...block },
      { x: 62, y: 10, hoeDirt: false, ...block },
      { x: 60, y: 11, hoeDirt: false, ...block },
      { x: 61, y: 11, hoeDirt: false, ...block },
      { x: 62, y: 11, hoeDirt: false, ...block },
    ],
    warps: [{ sourceX: 66, sourceY: 15, targetLocation: "BusStop", targetX: 0, targetY: 0 }],
    doorTargets: [{ sourceX: 64, sourceY: 12, targetLocation: "FarmHouse", targetX: 5, targetY: 9 }],
    mineEntranceTargets: [{ targetId: "mine_entrance_1", x: 54, y: 4 }],
    waterTargets: [{ x: 70, y: 20 }],
    craftingRecipeTargets: [{ expectedTargetId: "craft_1", recipeName: "Scarecrow" }],
    cropTargets: [{ targetId: "crop_1", x: 60, y: 12 }],
    machineTargets: [{ targetId: "machine_1", x: 62, y: 12 }],
    petTargets: [{ targetId: "pet_1", x: 63, y: 13 }],
    farmAnimalPetTargets: [{ targetId: "animal_1", x: 64, y: 13 }],
    feedTroughTargets: [{ targetId: "trough_1", x: 65, y: 13 }],
    animalProductTargets: [{ targetId: "produce_1", x: 66, y: 13 }],
    seedSupplyTargets: [
      { qualifiedItemId: "(O)472", displayName: "Parsnip Seeds", heldCount: 0, shopId: "SeedShop", price: 20 },
    ],
    mailboxTargets: [{ targetId: "mailbox_1", x: 68, y: 12, pendingCount: 1 }],
    weedTargets: [{ targetId: "weed_1", x: 59, y: 9 }],
    grassTargets: [{ targetId: "grass_1", x: 58, y: 9 }],
    rockSourceTargets: [{ targetId: "rock_1", x: 57, y: 9 }],
    treeStumpTargets: [{ targetId: "stump_1", x: 56, y: 9 }],
    treeChopSourceTargets: [{ targetId: "tree_1", x: 55, y: 9 }],
    shakeTreeTargets: [{ targetId: "shake_1", x: 54, y: 9 }],
    mannequinTargets: [{ targetId: "mannequin_1", x: 5, y: 9 }],
    signTargets: [],
    inventoryItemFacts: [{ slot: 0, qualifiedItemId: "(H)15", displayName: "Hat", stack: 1 }],
    npcRelationshipTargets: [{ targetId: "npc_1", npcName: "Abigail" }],
    chests: [{ chestId: "chest_1", x: 63, y: 12 }],
    worldObjectTargets: [{ targetId: "object_1", x: 6, y: 9 }],
    colorTargets: [{ targetId: "color_1", x: 7, y: 9 }],
    debrisTargets: [{ targetId: "debris_1", x: 58, y: 11 }],
    clearHoeDirtTargets: [{ targetId: "hoedirt_1", x: 58, y: 12 }],
    forageTargets: [{ targetId: "forage_1", x: 59, y: 13 }],
    shippingBinTargets: [{ targetId: "bin_1", x: 0, y: 0, slot: 3 }],
    animalDoorTargets: [{ targetId: "door_1", x: 65, y: 14 }],
  };
}

/** Every snapshot family the pool's signatures name, emptied: a world that measured everything and holds nothing. */
function emptyWorld() {
  const world = satisfiedWorld();
  for (const [key, value] of Object.entries(world)) {
    if (Array.isArray(value)) world[key] = [];
  }
  return world;
}

const findingsFor = (reading, task) => reading.findings.filter((code) => code.includes(`:${task}:`));

test("every task in the pool declares a world, and every declaration belongs to a task in the pool", () => {
  const pool = DAILY_TASK_ROTATION.filter((task) => typeof task === "string");
  assert.ok(pool.length > 0, "the rotation names no task at all");
  const undeclared = pool.filter(
    (task) => !Array.isArray(TASK_PRECONDITIONS[task]) || TASK_PRECONDITIONS[task].length === 0,
  );
  const orphaned = Object.keys(TASK_PRECONDITIONS).filter((task) => !pool.includes(task));
  assert.deepEqual(
    undeclared,
    [],
    `a task with no precondition signature is a task nobody asked the world about: ${undeclared.join(", ")}`,
  );
  assert.deepEqual(orphaned, [], `a signature outlived the task it was declared for: ${orphaned.join(", ")}`);
});

test("every family a signature names is a family the generated snapshot shape publishes", () => {
  const sample = JSON.parse(readFileSync(SNAPSHOT_SAMPLE, "utf8"));
  const published = new Set([...Object.keys(sample.real ?? {}), ...(sample.absent ?? []).map((row) => row.field)]);
  assert.ok(published.size > 0, "the generated snapshot sample names no family: this test would agree with itself");
  const named = [];
  for (const [task, signature] of Object.entries(TASK_PRECONDITIONS)) {
    for (const requirement of signature) {
      if (requirement.fact !== "family_rows") continue;
      for (const family of requirement.families) named.push({ task, family });
    }
  }
  const unknown = named.filter((entry) => !published.has(entry.family));
  assert.deepEqual(
    unknown,
    [],
    `a signature asks for a family the snapshot does not carry, so its task could never be judged: ${unknown
      .map((entry) => `${entry.task}:${entry.family}`)
      .join(", ")}`,
  );
  assert.ok(named.length > 0, "no signature names a family at all");
});

test("a world holding one of everything makes the whole pool feasible", () => {
  const reading = estimateTaskPoolAtOpening({ snapshot: satisfiedWorld() });
  assert.equal(reading.blocked, null);
  assert.equal(
    reading.infeasible,
    0,
    `unexpected infeasible tasks: ${reading.readings
      .filter((row) => row.verdict !== "feasible")
      .map((row) => `${row.task} ${row.findings.join(" + ")}`)
      .join("; ")}`,
  );
  assert.equal(reading.undecided, 0);
  assert.equal(reading.feasible, reading.tasks);
  // The line leads with the MOMENT it speaks for, and ends with the two numbers a second world changes: the seed counter
  // and the purse. The population is derived from the rotation rather than typed: `feasible 22` on its own read the same on
  // `round96`'s launch world and on its day 2, and a pool that gained or lost a task is not this reading's failure.
  const pool = DAILY_TASK_ROTATION.filter((task) => typeof task === "string");
  assert.equal(reading.tasks, pool.length, "the reading's population is the rotation's, not a number of its own");
  assert.equal(
    reading.reading,
    `opening_snapshot r7 Farm · tasks ${String(pool.length)} · feasible ${String(pool.length)} · infeasible 0 (none) · seed_market rows 1 · purse 12000`,
  );
});

test("an empty world is infeasible AND NAMED, and a window's emptiness is not the world's", () => {
  const reading = estimateTaskPoolAtOpening({ snapshot: emptyWorld() });
  // DECISIVE: the actor's own pack, her purse, the map's own exits, her recipes and the seed supply - every fact that
  // answers for the whole map or the whole actor - so nothing in this world can hold a day. The SET is derived from the
  // rotation instead of listed here: a hand-written membership list went red the moment the pool gained or lost a task,
  // which is a pool change and not this reading's defect.
  assert.equal(reading.feasible, 0, "an empty world cannot hold any task");
  assert.deepEqual(
    [...reading.infeasibleTasks, ...reading.undecidedTasks].sort(),
    [...DAILY_TASK_ROTATION].sort(),
    "every task is either refused by the world or out of the gate's view; a task that read feasible here would be the defect",
  );
  assert.deepEqual(findingsFor(reading, "dress_and_display"), [
    "task_precondition_unmet:dress_and_display:pack:wearable",
    "task_precondition_out_of_view:dress_and_display:mannequinTargets|signTargets>=1",
  ]);
  // A target family is a thirteen-tile window, so an empty one is reported and never counted against the world.
  assert.ok(reading.undecidedTasks.includes("tend_the_animals"));
  assert.equal(reading.verdictCode, "task_precondition_unmet:clear_and_plant_long_patch:ground:3x20:unhoed");
  assert.ok(
    reading.reading.startsWith(`opening_snapshot r7 Farm · tasks ${String(reading.tasks)} · feasible 0 · infeasible `),
    reading.reading,
  );
  assert.match(reading.reading, /· undecided /u);
  assert.match(reading.reading, /· seed_market rows 0 · purse 12000$/u);
});

test("a family the Mod did not measure is not the same reading as a family it measured as empty", () => {
  const unmeasured = satisfiedWorld();
  delete unmeasured.soilTiles;
  const reading = estimateTaskPoolAtOpening({ snapshot: unmeasured });
  assert.deepEqual(findingsFor(reading, "clear_and_plant_long_patch"), [
    "task_precondition_not_measured:clear_and_plant_long_patch:ground:3x20:unhoed",
  ]);
  // And an empty list in the same slot is a measured emptiness, which is a different code and a different owner.
  const measured = satisfiedWorld();
  measured.soilTiles = [];
  assert.deepEqual(findingsFor(estimateTaskPoolAtOpening({ snapshot: measured }), "clear_and_plant_long_patch"), [
    "task_precondition_unmet:clear_and_plant_long_patch:ground:3x20:unhoed",
  ]);
});

test("the strip's STATE is read from the rows it published, and the inverse is refused by name", () => {
  const world = satisfiedWorld();
  world.soilTiles = world.soilTiles.map((row) => ({ ...row, hoeDirt: true }));
  const reading = estimateTaskPoolAtOpening({ snapshot: world });
  const [unmet] = findingsFor(reading, "clear_and_plant_long_patch");
  assert.equal(unmet, "task_precondition_unmet:clear_and_plant_long_patch:ground:3x20:unhoed");
  const ground = readRequirement(world, TASK_PRECONDITIONS.clear_and_plant_long_patch[0]);
  assert.equal(ground.satisfied, false);
  assert.match(ground.detail, /already tilled/u, "the finding has to say which state the strip is in");
});

test("the strip is read by its whole-map extent, so a plot longer than the window can be judged", () => {
  const world = satisfiedWorld();
  // One published row of a 3x20 strip: the window shows a corner, the strip's own box states the shape.
  world.soilTiles = [{ x: 60, y: 10, hoeDirt: false, blockX: 60, blockY: 10, blockW: 3, blockH: 20 }];
  const ground = readRequirement(world, TASK_PRECONDITIONS.clear_and_plant_long_patch[0]);
  assert.equal(ground.satisfied, true, ground.detail);
  // A shorter strip is refused, and the refusal names the strip it did see.
  world.soilTiles = [{ x: 60, y: 10, hoeDirt: false, blockX: 60, blockY: 10, blockW: 3, blockH: 10 }];
  const short = readRequirement(world, TASK_PRECONDITIONS.clear_and_plant_long_patch[0]);
  assert.equal(short.satisfied, false);
  assert.match(short.detail, /largest published strip 3x10, wanted 3x20/u);
  // Transposed counts: three wide and twenty long is the same ground as twenty wide and three long.
  world.soilTiles = [{ x: 60, y: 10, hoeDirt: false, blockX: 60, blockY: 10, blockW: 20, blockH: 3 }];
  assert.equal(readRequirement(world, TASK_PRECONDITIONS.clear_and_plant_long_patch[0]).satisfied, true);
  // A row whose state the Mod did not publish is a missing reading, not a wrong one.
  world.soilTiles = [{ x: 60, y: 10, blockX: 60, blockY: 10, blockW: 3, blockH: 20 }];
  const unknown = readRequirement(world, TASK_PRECONDITIONS.clear_and_plant_long_patch[0]);
  assert.equal(unknown.satisfied, false);
  assert.equal(unknown.measured, false, "an unpublished hoe state must not read as tilled ground");
  assert.match(unknown.detail, /publishes no hoe state/u);
});

test("the twentieth tile is read by area, and a purse too small for the cheapest seed is named", () => {
  const world = satisfiedWorld();
  world.soilTiles = [{ x: 60, y: 10, hoeDirt: false, blockX: 60, blockY: 10, blockW: 4, blockH: 5 }];
  const expand = TASK_PRECONDITIONS.buy_seeds_and_expand_plot[0];
  assert.equal(readRequirement(world, expand).satisfied, true);
  world.soilTiles = [{ x: 60, y: 10, hoeDirt: false, blockX: 60, blockY: 10, blockW: 4, blockH: 4 }];
  assert.equal(readRequirement(world, expand).satisfied, false, "sixteen tiles cannot hold a twenty-tile plot");

  world.money = 5;
  world.seedSupplyTargets = [
    { qualifiedItemId: "(O)472", displayName: "Parsnip Seeds", heldCount: 0, shopId: "SeedShop", price: 20 },
  ];
  const market = readRequirement(world, TASK_PRECONDITIONS.buy_seeds_and_expand_plot[1]);
  assert.equal(market.satisfied, false);
  assert.match(market.detail, /costs 20, purse 5/u);
  // Held seeds are the other half of the same requirement: buying is not the only way to have one.
  world.seedSupplyTargets = [
    { qualifiedItemId: "(O)472", displayName: "Parsnip Seeds", heldCount: 3, shopId: "SeedShop" },
  ];
  assert.equal(readRequirement(world, TASK_PRECONDITIONS.buy_seeds_and_expand_plot[1]).satisfied, true);
});

test("a price the day cannot pay is the money requirement's own refusal, and a full purse is not", () => {
  // Constructed here rather than taken from a task, because the pool declares no priced task now (`home_upgrade` left the
  // rotation): the reader is pinned, and a task that declares a price tomorrow is read by this same branch.
  const requirement = Object.freeze({
    fact: "money",
    atLeast: 10_000,
    because: "the first farmhouse upgrade costs 10,000g",
  });
  assert.equal(readRequirement({ money: 500 }, requirement).satisfied, false);
  assert.match(describeRequirement(requirement), /^money>=10000$/u);
  assert.equal(readRequirement({ money: 10_000 }, requirement).satisfied, true);
  assert.equal(readRequirement({}, requirement).measured, false);
});

test("a pool of zero tasks is blocked, never a pass", () => {
  const reading = estimateTaskPoolAtOpening({ snapshot: satisfiedWorld(), rotation: [] });
  assert.equal(reading.tasks, 0);
  assert.equal(reading.feasible, 0);
  assert.equal(reading.blocked, "task_pool_empty");
  assert.equal(reading.verdictCode, "task_pool_empty");
});

test("a snapshot that is not an observation is blocked, not read as an empty world", () => {
  const reading = estimateTaskPoolAtOpening({ snapshot: {} });
  assert.equal(reading.blocked, "opening_snapshot_unmeasured");
  assert.equal(reading.verdictCode, "opening_snapshot_unmeasured");
});

test("an undeclared task and an orphaned signature both fail by name", () => {
  const reading = estimateTaskPoolAtOpening({
    snapshot: satisfiedWorld(),
    rotation: [...DAILY_TASK_ROTATION, "a_task_nobody_declared"],
    signatures: { ...TASK_PRECONDITIONS, another_task_the_pool_lost: TASK_PRECONDITIONS.clear_east_patch },
  });
  assert.ok(reading.findings.includes("task_precondition_undeclared:a_task_nobody_declared"));
  assert.equal(reading.blocked, "task_precondition_orphaned:another_task_the_pool_lost");
  assert.equal(reading.verdictCode, "task_precondition_orphaned:another_task_the_pool_lost");
});

test("the reading is one line that names its population, and the half that failed", () => {
  const world = satisfiedWorld();
  world.inventoryItemFacts = [];
  const reading = estimateTaskPoolAtOpening({ snapshot: world });
  assert.equal(
    describeTaskPoolAtOpening(reading),
    `opening_snapshot r7 Farm · tasks ${String(reading.tasks)} · feasible ${String(reading.tasks - 2)} · infeasible 2 (dress_and_display, sweep_carried_things) · seed_market rows 1 · purse 12000`,
  );
  assert.ok(TASK_POOL_BUDGET_MS <= 15_000, "the budget is what makes this runnable at a rung");
});

test("an unknown requirement is refused by name instead of being skipped", () => {
  assert.throws(() => describeRequirement({ fact: "a_fact_nobody_reads" }), /task_precondition_kind_unknown/u);
  assert.equal(readRequirement(satisfiedWorld(), { fact: "a_fact_nobody_reads" }).satisfied, false);
});

/**
 * THE DEFECT: `a_sowing_day_is_refused_on_the_world_that_holds_no_seed`.
 *
 * <p>
 * Measured on `round96` (the run published as `tools/_multiday_routine-round96.result.json`). Its opening snapshot held
 * two cauliflower seeds and 500g, and `seedSupplyTargets` published THREE rows - three shops that stock the seed she was
 * carrying - so this gate called both sowing tasks feasible. That reading was right about the world it read and it was
 * the last moment that world existed: by the evening of the SAME day the family published ZERO rows (she had planted the
 * cauliflower), and on day 2 she walked to Pierre's, found 「店里摆的全是沙漠节那些摊子，连防风草种子都没上架」, came back
 * empty-handed, and left twenty of the strip's sixty tiles tilled. The day's criterion then filed
 * `0/60 ... nothing_sown` against her.
 * </p>
 * <p>
 * SO THE GATE IS RIGHT AND THE MOMENT IS WRONG. `seedSupplyTargets`'s population is the seeds SHE HOLDS crossed with the
 * shops that stock them, so a world with no plantable seed in the pack can only answer "none stocked by a shop" - and
 * that answer is DECISIVE, because the family is whole-world. Both halves are asserted here: the day-2 world is
 * REFUSED, and the launch world was not. A reader who saw only the second would conclude the gate was wrong; the truth
 * is that the world moved between the snapshot and the day, which is a scheduling defect and not a reading defect.
 * </p>
 * <p>
 * WHAT WAS DONE ABOUT THE MOMENT. The reading now says which moment it is (`opening_snapshot r7 Farm · … · seed_market
 * rows 3 · purse 500`), so it cannot be quoted for a day; and the requirement itself is re-asked inside the day, through
 * the same reader, by `rereadDaySeedMarket` - asserted below, at 14:00 on the market that broke.
 * </p>
 *
 * red-proof: inject  reading `seed_market` as satisfied when the family is empty (`usable` defaulting to true) -> the
 *                   day-2 rows below go red naming both sowing tasks
 *                   (tools/live-run/game/task-pool-feasibility.test.mjs)
 */
test("a_sowing_day_is_refused_on_the_world_that_holds_no_seed", (t) => {
  // THE LAUNCH SNAPSHOT, in the run's own numbers: two seeds held, purse 500, three supply rows and all three stocked.
  const launch = satisfiedWorld();
  launch.money = 500;
  launch.seedSupplyTargets = ["SeedShop", "JojaMart", "Sandy"].map((shopId) => ({
    qualifiedItemId: "(O)474",
    displayName: "Cauliflower Seeds",
    heldCount: 2,
    shopId,
    price: 80,
  }));
  const atLaunch = estimateTaskPoolAtOpening({ snapshot: launch });
  const sowingTasks = ["clear_and_plant_long_patch", "buy_seeds_and_expand_plot"];
  assert.ok(sowingTasks.length > 0, "the population is named here because it is two tasks of one shape");
  for (const task of sowingTasks)
    assert.deepEqual(
      findingsFor(atLaunch, task),
      [],
      `${task}: two seeds held and three shops stocking them is what this gate called feasible at launch, and it has to ` +
        `stay that reading - the defect is the moment, not the answer`,
    );

  // THE DAY-2 WORLD: she holds no plantable seed at all, so the family is measured and EMPTY, and the purse is 1060.
  // The ground is the farm's own, so the only refused half is the seed - otherwise this test would pass for the wrong
  // reason on a world with no field in it.
  const sownDay = satisfiedWorld();
  sownDay.revision = 178;
  sownDay.money = 1060;
  sownDay.seedSupplyTargets = [];
  const onTheDay = estimateTaskPoolAtOpening({ snapshot: sownDay });
  const examined = [];
  for (const task of sowingTasks) {
    examined.push(task);
    t.diagnostic(`a_sowing_day_is_refused_on_the_world_that_holds_no_seed:${task}`);
    assert.deepEqual(
      findingsFor(onTheDay, task),
      [`task_precondition_unmet:${task}:a_seed_counter_she_can_buy_or_already_holds`],
      `${task}: with no seed held and nothing named that stocks one, this day cannot be held - and the finding has to ` +
        `name the seed counter rather than the ground`,
    );
  }
  assert.deepEqual(
    onTheDay.infeasibleTasks.filter((task) => sowingTasks.includes(task)),
    sowingTasks,
    "both sowing days are infeasible on that world, and neither is silently undecided",
  );
  // The ground half is still satisfied on the day-2 world: the strip and the plot both have their tiles, so the seed is
  // the only thing that failed.
  for (const task of sowingTasks)
    for (const requirement of TASK_PRECONDITIONS[task]) {
      if (requirement.fact !== "soil_ground") continue;
      assert.equal(
        readRequirement(sownDay, requirement).satisfied,
        true,
        `${task}: the ground was not what stopped this day - ${readRequirement(sownDay, requirement).detail}`,
      );
    }
  // BOTH WORLDS, PRINTED WITH THE TWO NUMBERS THAT DIFFER, so the readings cannot be confused again: three stocked rows
  // and 500g at launch, zero rows and 1060 on the day. The line itself carries both numbers too, which is why they are
  // asserted rather than merely printed.
  t.diagnostic(
    `at_launch · seed_market rows ${String(launch.seedSupplyTargets.length)} · purse ${String(launch.money)} · ${atLaunch.reading}`,
  );
  t.diagnostic(
    `on_the_day · seed_market rows ${String(sownDay.seedSupplyTargets.length)} · purse ${String(sownDay.money)} · ${onTheDay.reading}`,
  );
  assert.match(atLaunch.reading, /· seed_market rows 3 · purse 500$/u);
  assert.match(onTheDay.reading, /· seed_market rows 0 · purse 1060$/u);
  assert.notEqual(atLaunch.reading, onTheDay.reading, "two worlds must not print one line");
  t.diagnostic(`sowing days ${String(examined.length)} · refused on the day-2 world ${String(onTheDay.infeasible)}`);
  assert.ok(examined.length > 0, "blocked: no sowing task was examined");
});

/**
 * THE FIX FOR THE MOMENT: `the_day_re_asks_its_seed_counter_where_the_market_changes`.
 *
 * <p>
 * The same requirement the opening gate read, asked again on the world the day is standing in. `round96` is the case: the
 * launch snapshot held three stocked rows and 500g, and while that day ran the family went to ZERO rows; on day 2 the
 * purse held 1060 and the counter she walked to carried the desert festival's stalls and no parsnip seed at all. Asked at
 * 14:00 on that world the answer is a broken premise the run can see, published at the minute it broke:
 * `task_precondition_broken_at:<gameMinutes>:seed_market:<rows>`.
 * </p>
 * <p>
 * AND A MARKET THAT MOVED BUT STILL HOLDS IS A DIFFERENT LINE, because "went from three shops to one" is not "the seed
 * is not in town": `seed_market_changed:<gameMinutes>:<rowsAtOpen>-><rows>`. The day only fails when the market fails it.
 * </p>
 *
 * red-proof: inject  `broken` computed from the row count alone (`rows === 0`), ignoring `readSeedMarket` -> the
 *                   priced-out case below goes red, reading `seed_market_changed` on a day the counter stocks the seed
 *                   and she cannot pay for it (tools/live-run/game/task-pool-feasibility.test.mjs)
 */
test("the_day_re_asks_its_seed_counter_where_the_market_changes", (t) => {
  const dayTask = "clear_and_plant_long_patch";
  // The launch world, in `round96`'s own numbers: three shops stocking the seed she carried, purse 500.
  const launch = satisfiedWorld();
  launch.money = 500;
  launch.seedSupplyTargets = ["SeedShop", "JojaMart", "Sandy"].map((shopId) => ({
    qualifiedItemId: "(O)474",
    displayName: "Cauliflower Seeds",
    heldCount: 2,
    shopId,
    price: 80,
  }));
  const holds = rereadDaySeedMarket({ taskId: dayTask, snapshot: launch, gameMinutes: 360, rowsAtOpen: 3 });
  assert.equal(holds.measured, true, holds.detail);
  assert.equal(holds.broken, false, holds.detail);
  assert.equal(holds.code, null, "a counter that still holds what the day needs is not a fact worth a line");
  assert.equal(holds.key, "holds:3");

  // 14:00, the festival's day: zero rows honestly measured, and a purse that could pay for a seed nobody stocks.
  const festival = { ...launch, money: 1060, seedSupplyTargets: [] };
  const broke = rereadDaySeedMarket({ taskId: dayTask, snapshot: festival, gameMinutes: 840, rowsAtOpen: 3 });
  assert.equal(broke.broken, true, broke.detail);
  assert.equal(broke.code, "task_precondition_broken_at:840:seed_market:0");
  assert.equal(broke.key, "broken:0");
  // The same state read again at 15:00 is the same state: the key is what a caller dedupes on, so the run prints one line
  // for one broken market rather than one per poll.
  const later = rereadDaySeedMarket({ taskId: dayTask, snapshot: festival, gameMinutes: 900, rowsAtOpen: 3 });
  assert.equal(later.key, broke.key, "one broken market is one state, however many times it is read");
  assert.equal(later.code, "task_precondition_broken_at:900:seed_market:0", "the code carries the minute it was read");

  // THE THIRD STATE, AND THE ONE A ROW COUNT ALONE GETS WRONG: the counter stocks the seed and the purse cannot pay for
  // it. `readSeedMarket` owns that judgement, so the re-ask inherits it instead of counting rows.
  const pricedOut = {
    ...launch,
    money: 5,
    seedSupplyTargets: [
      { qualifiedItemId: "(O)474", displayName: "Cauliflower Seeds", heldCount: 0, shopId: "SeedShop", price: 80 },
    ],
  };
  const unaffordable = rereadDaySeedMarket({ taskId: dayTask, snapshot: pricedOut, gameMinutes: 780, rowsAtOpen: 3 });
  assert.equal(unaffordable.broken, true, unaffordable.detail);
  assert.equal(unaffordable.code, "task_precondition_broken_at:780:seed_market:1");

  // A MARKET THAT MOVED AND STILL HOLDS says so, and does not fail the day: three shops became one, and that one sells it.
  const thinner = satisfiedWorld();
  const moved = rereadDaySeedMarket({ taskId: "buy_seeds_and_expand_plot", snapshot: thinner, gameMinutes: 600, rowsAtOpen: 3 });
  assert.equal(moved.broken, false, moved.detail);
  assert.equal(moved.code, "seed_market_changed:600:3->1");

  // A task whose declared world holds no seed counter is never re-asked: a fact about a task nobody was given is noise.
  assert.equal(rereadDaySeedMarket({ taskId: "mine_delve", snapshot: festival, gameMinutes: 840 }), null);
  t.diagnostic(`day task ${dayTask} · 06:00 ${holds.key} (${holds.detail}) · 14:00 ${broke.code}`);
});

test("a seed counter the Mod did not measure is silent, never broken", () => {
  const unmeasured = satisfiedWorld();
  delete unmeasured.seedSupplyTargets;
  const unknown = rereadDaySeedMarket({
    taskId: "clear_and_plant_long_patch",
    snapshot: unmeasured,
    gameMinutes: 600,
    rowsAtOpen: 3,
  });
  assert.equal(unknown.measured, false, "a family nobody read is a missing reading, not an empty market");
  assert.equal(unknown.broken, false);
  assert.equal(unknown.code, null, "the opening gate already owns `task_precondition_not_measured` for this state");
  assert.equal(unknown.key, "holds:not_measured");
});

test("a re-ask with no clock still publishes, and says the minute was unknown", () => {
  const festival = satisfiedWorld();
  festival.seedSupplyTargets = [];
  const broke = rereadDaySeedMarket({
    taskId: "clear_and_plant_long_patch",
    snapshot: festival,
    gameMinutes: null,
    rowsAtOpen: 1,
  });
  assert.equal(broke.gameMinutes, null);
  assert.equal(broke.code, "task_precondition_broken_at:unknown:seed_market:0");
});
