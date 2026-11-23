/**
 * The daily tasks a multiday run rotates through, and which one each day gets.
 *
 * The problem this replaces: every day of a multiday run asked the SAME thing - "the east patch needs
 * clearing, weeds and rocks" - so two days of evidence covered one capability, and the cross-night crossing
 * itself was the only thing day two could prove. A run that died on day one also took the whole scenario with
 * it, because there was nothing else it was ever going to do.
 *
 * Two rotations, deliberately separate:
 *
 *   WITHIN A RUN   day 1 gets a different task from day 2, so one run covers several capabilities and the
 *                  night crossing doubles as a TASK SWITCH.
 *   BETWEEN RUNS   the first day's task advances by one each run, so consecutive runs do not all begin with
 *                  clearing and the same code path is not the only one ever exercised first.
 *
 * FIXED ROTATION, NOT RANDOM. `tools/compare-live-run-findings.mjs` treats a new finding as a regression; if
 * the task were random, every run would differ in what it attempted and comparison would stop meaning
 * anything. The rotation is a function of (start offset, day), so it is reproducible from the artifact.
 *
 * EVERY TASK IS BUILT FROM PUBLISHED ACTIONS. Nothing here introduces a capability; the tasks only say which
 * already-published actions the companion should reach for. A task that named an action the Mod does not
 * publish would make the run measure a capability gap instead of the behaviour it was built to observe.
 *
 * AND THE DAYS IT GIVES ARE NOT ALL UNJUDGEABLE. The rotation also decides whether a run can say anything about the days
 * it lived: measured on `round84`, three consecutive rotation entries were criteria whose facts nothing publishes, and a
 * healthy three-day run ended `task_purposes_nothing_judged:3of3` - a property of this list, not of her day. So
 * `dayTaskSchedule` applies the rule that two such days are never scheduled next to each other (see its own note), and
 * `task-purpose.mjs`'s `readScheduledJudgement` prints what a run was given and how much of it the evidence can judge.
 *
 * AND THE DAYS IT GIVES ARE NOT ALL THE SAME PART OF THE GAME. `TASK_PILLARS` groups the pool into the three parts of the
 * game it holds - the fields, the water and the town, the mine and the machines its ore feeds - and the rotation is the WALK
 * that takes one of them per day, so a three-day run measures three capabilities instead of two days of one. Measured on
 * `round96`: the flat list handed that run the `3x20` strip on day 2 and the seed plot on day 3, one pillar for two thirds
 * of the run. See `TASK_PILLARS`, `readPillarWindows` and `describeScheduledPillars`.
 *
 * THE SCENARIO LIST ABOVE WAS NOT ENOUGH, so it is now followed by SWEEP TASKS derived from the published surface
 * itself. Measured when they were added: the eighteen scenario tasks named 50 of the 95 published execution
 * actions, so 45 could be finished, gated, and never once asked for - and a run stays green through that, which is
 * the same defect `enter_mine` was for months. The sweep is not a new capability and not a new list to maintain:
 * it is the remainder of the artifact, grouped by the family the Mod's own registration catalog declares, and
 * `tools/check-stardew-task-action-coverage.mjs` fails when a published action is named by no task and explained by
 * no exclusion.
 *
 * AND A TASK THAT THE WORLD CANNOT HOLD IS NOT A DAY. Every rotation entry also declares its WORLD PRECONDITIONS
 * (`SCENARIO_TASK_PRECONDITIONS`, and one signature per sweep group), beside the task and in the same module, so the two
 * cannot be kept in step by memory: `tools/live-run/game/task-pool-feasibility.mjs` reads one real observation and answers
 * the whole pool, and a task with no signature fails there by name. See `SCENARIO_TASK_PRECONDITIONS` for why that exists
 * and what its vocabulary deliberately cannot say.
 */
import { readdirSync, readFileSync } from "node:fs";

import { readStardewActionFamilies } from "./stardew-published-action-registry.mjs";

/** The published action ids each SCENARIO task expects the companion to reach for. Used by the run's own audit. */
const SCENARIO_TASK_ACTION_HINTS = Object.freeze({
  // Home is not scenery. A companion that only ever works the fields is a farmhand; these are what make the house
  // somewhere a person lives - arranging it, then making it bigger.
  home_and_hearth: Object.freeze([
    "place_owned_object",
    "remove_placed_item",
    "dress_mannequin",
    "set_sign_display",
    "craft_item",
  ]),
  clear_east_patch: Object.freeze(["cut_weeds", "cut_grass", "break_rock", "chop_stump"]),
  water_and_harvest: Object.freeze(["harvest_crop", "scythe_crop", "plant_seed", "water_crop"]),
  forage_and_trees: Object.freeze(["pickup_forage", "shake_tree", "harvest_fruit_tree", "chop_tree"]),
  craft_and_place_machine: Object.freeze(["craft_item", "place_owned_object", "machine_inspect"]),
  town_market: Object.freeze(["travel", "shop_purchase", "claim_mail_attachment"]),
  town_visit: Object.freeze([
    "travel",
    "talk_to_npc",
    "npc_relationship",
    "interact_npc_with_item",
    "accept_daily_quest",
    "claim_museum_reward",
  ]),
  // The rows below exist for COVERAGE, and that is a measured need rather than a preference: of the 95 published
  // actions, 78 were reachable by no task for ever, so a capability could be finished, gated, and still never exercised.
  // `enter_mine` is the proof - published, correct, and used in zero runs because nothing ever asked for a mine.
  mine_delve: Object.freeze([
    "navigate_to_destination",
    "enter_mine",
    "break_rock",
    "break_container",
    "use_item",
    "select_mine_elevator_floor",
    "ride_minecart",
  ]),
  // The way OUT, which is its own action and its own failure: round30 got into a shaft and could not leave, and no task had
  // ever asked for the exit ladder because there was nothing to ask for. A task that only names `enter_mine` measures entry.
  mine_ladder_to_depth: Object.freeze([
    "travel",
    "navigate_to_destination",
    "enter_mine",
    "use_mine_ladder",
    "break_rock",
    "break_container",
  ]),
  // Arranging beats placing. `place_owned_object` was exercised and `move_placed_furniture` was not, so the companion could
  // put a chair down and never move it - and round30's stone sign in the doorway is what a task that only says "place"
  // produces.
  furnish_and_arrange: Object.freeze([
    "place_owned_object",
    "move_placed_furniture",
    "remove_placed_item",
    "color_placed_object",
    "dress_mannequin",
    "set_sign_display",
  ]),
  // Machines are now data-driven (any machine the game's own data admits), which is worth nothing if no task ever loads one.
  run_the_machines: Object.freeze([
    "machine_load",
    "machine_collect_output",
    "machine_inspect",
    "craft_item",
    "place_owned_object",
  ]),
  store_and_sort: Object.freeze(["chest_store", "chest_retrieve", "pickup_item"]),
  tend_the_animals: Object.freeze(["pet_animal", "feed_animal", "collect_animal_product", "water_pet_bowl"]),
  tidy_and_repair: Object.freeze(["clear_debris", "clear_hoedirt", "remove_placed_item", "break_container"]),
  dress_and_display: Object.freeze(["equip_wearable", "unequip_wearable", "dress_mannequin", "set_sign_display"]),
  // THE ONLY TASK WHOSE SHAPE IS LONGER THAN ONE VIEW, and after the `2x18` bed was cut it is the only one whose
  // purpose is a shape at all. Target discovery is Chebyshev radius 6, so every snapshot is a 13x13 window and no
  // snapshot contains this plot: 3x20 is twenty tiles long. Sixty tiles at three actions each keeps the day's cost
  // beside a day of ordinary field work, and the question is one no task has ever asked - can she hold a boundary
  // after walking out of the window she laid the far end of it in?
  //
  // `chop_tree`/`chop_stump` are deliberately absent, and that is the only pruning: this patch is a strip of open
  // ground, and a tile a tree stands on is not a tile you till. Weeds, grass, loose debris and rocks are what a
  // clearable strip in front of the house actually holds, and all of them stand between her and the first tilled tile.
  //
  // AND THE CRITERION READS THIS LIST. `task-purpose.mjs` crosses these actions with the Mod's own `Clears(...)`
  // declarations to decide which occupants a tile of the strip owes cleared and which ones make a tile the day was
  // never asked for - so a kind whose only clearer is missing here (`tree`, cleared by `chop_tree`) is excluded from the
  // denominator and named in the verdict, rather than demanded and missed. Measured 2026-11-23 (`round96`, day 3):
  // fifty-eight of sixty tiles worked and two trees standing, filed `not_achieved` while the strip was laid.
  clear_and_plant_long_patch: Object.freeze([
    "cut_weeds",
    "cut_grass",
    "clear_debris",
    "break_rock",
    "travel",
    "shop_purchase",
    "chest_retrieve",
    "till_soil",
    "plant_seed",
    "water_crop",
    "refill_watering_can",
  ]),
  // TWENTY TILES, AND THE HOE IS ONE WAY TO OPEN THEM. The criterion counts the tiles that carry a sowing and a
  // watering at the end of the day (`plot` in `task-purpose.mjs`), so `till_soil` is work this day may reach for and
  // not a quota it must meet: measured 2026-11-23 (`round96`), the day sowed and watered twenty tiles and turned five of
  // them, and the plot was laid. `shop_purchase` is the half the name carries - the seed has to be bought - and it is
  // read from a receipt, not from the seed being in the pack.
  buy_seeds_and_expand_plot: Object.freeze([
    "cut_weeds",
    "clear_debris",
    "break_rock",
    "travel",
    "shop_purchase",
    "chest_retrieve",
    "till_soil",
    "plant_seed",
    "water_crop",
    "refill_watering_can",
  ]),
  // THE ONLY TASK THAT ASKS FOR A WATER ACTION. `fish_here` is published and no task named it, which is the same
  // coverage hole `enter_mine` was in: an action can be finished, gated, and never exercised because nothing asked.
  // One action, deliberately - the task is "did she go and fish", not a quota of fish.
  a_fish_from_the_water: Object.freeze(["fish_here"]),
});

/**
 * WHAT THE WORLD MUST HOLD BEFORE A TASK CAN BE DONE AT ALL, declared beside the task it belongs to.
 *
 * A CRITERION SAYS WHAT A DAY MUST PRODUCE. It cannot say whether the day could have produced it, and the pool learnt that
 * the expensive way: `dress_and_display` needs a wearable to put on and a mannequin or sign to display it on, and the
 * opening world held neither; the `3x20` strip needs sixty tiles of untilled ground and the day found fewer; `till_soil`
 * needed ground the Hoe had not already turned. None of those needed a turn to discover - they are facts of the opening
 * snapshot, and discovering them on day 3 of a thirty-five-minute run costs the run. So each task declares the facts its
 * own purpose needs before anything can start, in the closed vocabulary below, and
 * `tools/live-run/game/task-pool-feasibility.mjs` reads one real observation and answers the whole pool at once.
 *
 * A DECLARATION, NOT A DESCRIPTION. Every requirement is one published fact and names it: a snapshot family (by the name
 * the wire uses), the shape of published ground, whether the pack holds a wearable, and what a seed counter offers. Nothing
 * here reads the fixture, invents a world, or asks a fact nothing publishes. What the vocabulary deliberately cannot say is
 * "this task is unmeasurable": a task whose world half nobody can read would then pass by declaring its own silence, which
 * is the failure this exists to catch. A task with NO signature is refused by name instead.
 */

/** One fact of the opening snapshot, as the wire publishes it. */
const rowsOf = (families, { atLeast = 1 } = {}) =>
  Object.freeze({ fact: "family_rows", families: Object.freeze([...families]), atLeast });

/**
 * Ground the task shapes: a strip of published `soilTiles` rows, by rectangle or by tile count.
 *
 * `hoed` is the state those rows must carry: `false` for ground the Hoe has not turned (the `3x20` strip and the twenty
 * tiles `buy_seeds_and_expand_plot` expands onto). The EXTENT is the strip's own whole-map measurement - `blockX`,
 * `blockY`, `blockW`, `blockH` come from a walk with no radius (`FarmableBlocks` in
 * `integrations/stardew/farmhandexecutioncontroller.targetdiscovery.cs`), which is what makes "three wide and twenty
 * long" a thing one snapshot can state at all.
 *
 * THE EXTENT IS GROUND, NOT THIS FAMILY'S ROWS. A row exists for a tile a soil action addresses NOW (under the Hoe, or
 * ground it admits), so a rock, a weed, grass or a twig on the field is not a row - and an extent measured over rows was
 * therefore an extent measured over BARE ground: the `3x20` day answered `largest published strip 28x19`, one row short,
 * on a farm whose field is one rectangle. The walk now asks the permanent half of the Hoe's admission and puts up with an
 * occupant some published action clears, so the box is the ground a patch can be opened in, while a row stays a tile an
 * action addresses. The STATE is only known for the rows inside the six-tile window: a strip is accepted when every
 * published row of it carries `hoed`, and a tile of that strip outside the window is not read. That ceiling is why the
 * criterion, not this, remains the judge of a patch day.
 */
const soilGround = ({ width = 1, height = 1, tiles = null, hoed }) => {
  if (typeof hoed !== "boolean") throw new Error("stardew_task_precondition_soil_needs_its_state");
  if (tiles === null && (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1))
    throw new Error("stardew_task_precondition_soil_needs_its_shape");
  if (tiles !== null && (!Number.isInteger(tiles) || tiles < 1))
    throw new Error("stardew_task_precondition_soil_tile_count_invalid");
  return Object.freeze({ fact: "soil_ground", width, height, tiles, hoed });
};

/**
 * A shop counter that sells a seed - and either she holds one or she can pay the price it charges.
 *
 * <p>
 * WHAT THIS ASKS IS NARROWER THAN WHAT A SOWING DAY NEEDS, and the gap is measured rather than suspected. The gate
 * (`readSeedMarket`) reads `seedSupplyTargets`, whose population is the seeds SHE HOLDS crossed with the shops in
 * `Data/Shops` that stock one (`DiscoverSeedSupplyTargets` in
 * `integrations/stardew/farmhandexecutioncontroller.shopactions.cs`), and answers satisfied when ANY of those rows is
 * held (\`heldCount >= 1\`) or costs no more than her purse. So it answers "is there a seed she could get", and a day
 * that owes sixty tiles needs sixty of them.
 * </p>
 * <p>
 * 2026-11-23 (`tools/_multiday_routine-round96.result.json`) is that gap with a date on it. The run opened at 06:00 with
 * two cauliflower seeds and 500g: `seedSupplyTargets` published 3 rows, three of them stocked, so this requirement was
 * satisfied and the gate called both sowing tasks feasible. By the evening of the same day the same family published 0
 * rows - she had planted the cauliflower - and on day 2 she walked to Pierre's, found 「店里摆的全是沙漠节那些摊子，连防风草
 * 种子都没上架」, and came back with nothing: 60 tiles of strip owed, 20 tilled, 0 sowed. Asked on THAT snapshot the gate
 * answers `task_precondition_unmet:<task>:a_seed_counter_she_can_buy_or_already_holds` and is right to: the day could
 * not be held. Asked at boot it answers feasible and is right about the world it read.
 * </p>
 * <p>
 * SO THE DEFECT IS THE MOMENT, NOT THE READING, and the fix belongs to the layer that decides a DAY - which now asks
 * again: `rereadDaySeedMarket` in `tools/live-run/game/task-pool-feasibility.mjs` reads THIS requirement, through the same
 * `readSeedMarket`, on the snapshot the day is standing in, and the day loop publishes the answer at the minute it changes
 * (`task_precondition_broken_at:<gameMinutes>:seed_market:<rows>`). `seedShortageFact` in `seed-shortage.mjs` states the
 * same supply to her in her own words every morning. A declaration here is still read once, at the launch it belongs to,
 * which is why the re-ask lives beside the gate and not in this file.
 * </p>
 */
const seedMarket = () => Object.freeze({ fact: "seed_market" });

/**
 * Something the pack carries that a task acts on.
 *
 * `wearable` is the only kind: `equip_wearable` moves a Hat, Boots, Ring or Clothing out of a pack slot
 * (`IsWearableItem` in `integrations/stardew/farmhandexecutioncontroller.actorstateactions.cs`) and the wire publishes
 * the pack's qualified item ids and not that judgement. The engine's own type-definition prefixes name four of those
 * kinds - `(H)` hat, `(B)` boots, `(S)` shirt, `(P)` pants (`StardewValley.ItemTypeDefinitions`) - and a RING carries an
 * `(O)` id, so a pack holding only a ring reads as "no wearable", which is the one direction this reading can be wrong
 * in. Stated here rather than discovered as a false `task_precondition_unmet` nobody can explain.
 */
const packHolds = (kind) => {
  if (kind !== "wearable") throw new Error(`stardew_task_precondition_pack_kind_unknown:${String(kind)}`);
  return Object.freeze({ fact: "pack_kind", kind });
};

/** A balance the task's own price has to be paid out of. `because` is the price the number comes from. */
const money = (atLeast, because) => {
  if (!Number.isInteger(atLeast) || atLeast < 0) throw new Error("stardew_task_precondition_money_invalid");
  if (typeof because !== "string" || because.length === 0)
    throw new Error("stardew_task_precondition_money_needs_its_price");
  return Object.freeze({ fact: "money", atLeast, because });
};

/** A signature: the facts of one task's world, in reading order. Never empty - silence is what this exists to remove. */
const sig = (...needs) => {
  if (needs.length === 0) throw new Error("stardew_task_precondition_signature_empty");
  return Object.freeze(needs);
};

/**
 * The scenario tasks' own world preconditions, keyed by the ids above.
 *
 * One requirement is one fact the task cannot begin without, so a signature with two requirements is a conjunction: both
 * must hold. Where a purpose has two halves (`dress_and_display` puts something ON and puts it SOMEWHERE) the halves are
 * separate requirements, so the finding names the half that failed instead of the pair.
 */
const SCENARIO_TASK_PRECONDITIONS = Object.freeze({
  // The strip the day lays: sixty tiles of ground the Hoe has not turned, and a seed counter she can buy from (see
  // `seedMarket` for how much narrower that is than "a counter that will sell her sixty"). Both were untrue when this was
  // written, and both are opening-snapshot facts - which is exactly why a day that opens on a different world than the
  // launch snapshot is not covered by them.
  clear_and_plant_long_patch: sig(soilGround({ width: 3, height: 20, hoed: false }), seedMarket()),
  // Twenty tiles is the count its criterion owes; the shape is not, so the ground is asked for by area. The STATE half
  // is what the plot criterion reads: ground the Hoe has not turned, because a seed goes into tilled soil and this day
  // may turn it itself. A farm whose twenty tiles are ALREADY tilled would be refused here while the criterion would
  // accept it - the one direction this reading is wrong in, stated rather than hidden (`readSoilGround` in
  // `tools/live-run/game/task-pool-feasibility.mjs` can only ask for one hoe state).
  buy_seeds_and_expand_plot: sig(soilGround({ tiles: 20, hoed: false }), seedMarket()),
  // THE MINE IS NOT ON THIS MAP, and that is what the requirements say: `mineEntranceTargets` is discovered within the
  // six-tile window of the map she stands on, so a Farm snapshot can only publish an entrance when she is already near
  // one. The other half of the same fact is that this map has an exit to go and find one - `warps` and `doorTargets` are
  // the map's own, whole-map, so the reading is "the mine is reachable from here", never "the mine is at her feet".
  mine_ladder_to_depth: sig(rowsOf(["mineEntranceTargets", "warps", "doorTargets"])),
  mine_delve: sig(rowsOf(["mineEntranceTargets", "warps", "doorTargets"])),
  // `fish_here` casts where she stands; the water it can cast into is the family.
  a_fish_from_the_water: sig(rowsOf(["waterTargets"])),
  // A recipe she has learnt is the only thing `craft_item` can make, and the machine has to be put down and loaded.
  craft_and_place_machine: sig(rowsOf(["craftingRecipeTargets"])),
  // The day replants what a harvest day emptied: a crop to come off (or one ready for it - the whereabouts families are
  // the location-wide count of each, and a ripe crop is a crop whose ground is owed), and a seed to put in its place.
  water_and_harvest: sig(
    rowsOf(["cropTargets", "harvestTargets", "harvestWhereabouts", "wateringWhereabouts"]),
    seedMarket(),
  ),
  run_the_machines: sig(rowsOf(["machineTargets"])),
  // Petting, feeding and collecting are three families because an animal that is not in any of them cannot be tended.
  tend_the_animals: sig(rowsOf(["petTargets", "farmAnimalPetTargets", "feedTroughTargets", "animalProductTargets"])),
  // A counter that stocks something she carries, and a box with post in it.
  town_market: sig(rowsOf(["seedSupplyTargets"]), rowsOf(["mailboxTargets"])),
  clear_east_patch: sig(rowsOf(["weedTargets", "grassTargets", "rockSourceTargets", "treeStumpTargets"])),
  // THE TWO HALVES THAT WERE BOTH ABSENT. Something to put on, and somewhere to display it.
  dress_and_display: sig(packHolds("wearable"), rowsOf(["mannequinTargets", "signTargets"])),
  // Same shape as the mine, for the same reason: villagers are discovered around her, so a Farm snapshot holds none of
  // them and a way off the map is the half of "there is someone to talk to" this map can state.
  town_visit: sig(rowsOf(["npcRelationshipTargets", "warps", "doorTargets"])),
  store_and_sort: sig(rowsOf(["chests"])),
  // The house is arranged out of what can be crafted and what is already standing in it.
  home_and_hearth: sig(rowsOf(["craftingRecipeTargets", "worldObjectTargets"])),
  // Clearing is `clear_debris`, and putting something away needs something standing there to put away.
  tidy_and_repair: sig(rowsOf(["debrisTargets"]), rowsOf(["worldObjectTargets", "clearHoeDirtTargets"])),
  forage_and_trees: sig(rowsOf(["forageTargets"]), rowsOf(["shakeTreeTargets", "treeChopSourceTargets"])),
  furnish_and_arrange: sig(rowsOf(["worldObjectTargets"]), rowsOf(["colorTargets"])),
});

/**
 * The published EXECUTION population, read from the Mod-owned generated surface artifact.
 *
 * Derived, not listed. `kind: "execution"` is the artifact's own statement of what the companion can be asked to
 * DO - `read_only` actions are the ones a snapshot already answers - and the coverage gate reads the same field
 * as its population, so the tasks and the gate cannot disagree about what "all of it" means.
 */
const SURFACE_ARTIFACT = new URL(
  "../../integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
  import.meta.url,
);

function readExecutionPopulation() {
  const artifact = JSON.parse(readFileSync(SURFACE_ARTIFACT, "utf8"));
  const actions = (artifact.actions ?? []).filter((action) => action.kind === "execution");
  if (actions.length === 0) throw new Error("stardew_action_surface_has_no_execution_actions");
  return Object.freeze(actions.map((action) => action.actionId));
}

/**
 * The sweep tasks, as the Mod's own action FAMILIES gathered into a few groups.
 *
 * The families are read from the Mod's registration catalog (`FarmhandActionDefinitions.cs`, through
 * `readStardewActionFamilies`), which `host/src/games/stardew/stardew-action-families.ts` already names as the
 * authority for that vocabulary. No taxonomy is invented here: a group is a set of families the Mod declares.
 *
 * WHY GROUPS AND NOT ONE TASK PER ACTION. A prompt is one sentence a partner says, and a sentence that lists
 * actions reads as a checklist - the shape the interaction-value gate penalises, because a companion handed a
 * checklist reports steps instead of doing a job. Grouping by family is what keeps every prompt below speakable:
 * a family is a PLACE or a KIND OF WORK (the yard's fixtures, the animals), so the sentence can be about that
 * place and the actions stay the companion's decision. Each prompt names a place and no action, which is the same
 * rule the scenario tasks follow.
 *
 * A family is absent from this table for one of two reasons, and the difference is visible in the gate: either every
 * action it holds is already named by a scenario task (machines, world navigation), or the actions left in it are
 * ones no single Farmhand can perform at all - a second player, a horse, an island that needs unlocking. The second
 * kind is named with its blocker in `TASK_ACTION_EXCLUSIONS` in the coverage gate, and that gate fails if an
 * exclusion ever turns out to be covered - so a family added here cannot leave a stale reason behind.
 */
const SWEEP_GROUPS = Object.freeze([
  Object.freeze({
    id: "sweep_yard_and_work",
    families: Object.freeze([
      "buildings_farm_management",
      "facility_storage_lighting",
      "resource_gathering",
      "farming_crops",
      "movement_navigation",
      "world_lifecycle",
    ]),
    prompt: Object.freeze({
      zh: "农场上的东西今天都用一用，能装能收的顺手收了，天黑就回屋睡。",
      en: "put the farm's own fixtures to use today - whatever holds or yields something, work it - and turn in when it gets dark.",
    }),
    purpose: "the farm's own fixtures and the ground around them were all worked",
    missingFact:
      "no published fact says a fixture was used as a class: every receipt names one action and one target, and the grouping is a declaration in this repository, so a run can report which of these actions ran but never that the farm's fixtures were worked through.",
    // The yard always holds something to work: the map's own exits are a published family (`warps`), so the day is never
    // asked from a world where there is nothing at all. The rows that a farm with fixtures adds are beside them, not instead.
    preconditions: sig(
      rowsOf(["weedTargets", "debrisTargets", "treeChopSourceTargets", "seedTargets", "animalDoorTargets", "warps"]),
    ),
  }),
  Object.freeze({
    id: "sweep_animals_and_company",
    families: Object.freeze(["animals_pets", "expression", "modal_handling", "quests_journal"]),
    prompt: Object.freeze({
      zh: "去看看牲口，碰上人就聊两句，有人问话就答。",
      en: "look in on the animals, and when you run into somebody have a word - answer whatever they ask.",
    }),
    purpose: "the animals were seen to and whoever was around was spoken to",
    missingFact:
      "the receipts name one action each - `pet_animal` reports the animal it touched and `talk_to_npc` the map the words happened on - and nothing publishes whether anyone was around to talk to, so 'the animals and the company were seen to' cannot be decided from them.",
    // A day about company needs company: an animal to look in on or a villager to speak to. The yard alone is not one.
    preconditions: sig(rowsOf(["petTargets", "farmAnimalPetTargets", "npcRelationshipTargets"])),
  }),
  Object.freeze({
    id: "sweep_carried_things",
    families: Object.freeze(["body_tools", "crafting_cooking", "shops_economy", "inventory_items"]),
    prompt: Object.freeze({
      zh: "把随身带着的东西理一遍，能用的用掉、该卖的卖掉。",
      en: "sort through what you are carrying - use what is worth using, sell what should be sold.",
    }),
    // NOT A GAP, and it never needed to be one. This day asked the pack's before and after, a fact `inventoryItemFacts`
    // publishes on the OBSERVATION while `judgeTaskPurpose` reads RECEIPTS - so it was undecidable by construction while
    // the product published everything it needed. The sentence below is the two acts its own prompt names, each one a
    // receipt, and the criterion in `task-purpose.mjs` says the same thing once.
    purpose: "something she was carrying was used up, and something she was carrying was sold",
    // Both halves of its criterion read the pack, and selling needs the bin: the pack's rows are the only published form
    // of "what she is carrying" (`inventoryItemFacts`), and `ship_item` pairs a shippable slot with the Farm's bin.
    preconditions: sig(rowsOf(["inventoryItemFacts"]), rowsOf(["shippingBinTargets"])),
  }),
]);

/**
 * The sweep tasks for one published population: the actions no scenario task names, grouped by declared family.
 *
 * Pure over its three inputs, so the falsifier can hand it a population the repository does not have. An action
 * whose family belongs to no group comes out in NO task - which is not a silent drop: it is what the coverage gate
 * then reports as uncovered, and it is why the excluded actions need no entry in this table.
 */
export function buildSweepTasks({ population, familyOf, named }) {
  const groupOfFamily = new Map();
  for (const group of SWEEP_GROUPS) {
    for (const family of group.families) {
      const claimed = groupOfFamily.get(family);
      if (claimed !== undefined) {
        throw new Error(`stardew_sweep_family_in_two_groups:${family}:${claimed}:${group.id}`);
      }
      groupOfFamily.set(family, group.id);
    }
  }
  const remaining = population.filter((actionId) => !named.has(actionId));
  const tasks = [];
  for (const group of SWEEP_GROUPS) {
    const actions = remaining.filter((actionId) => groupOfFamily.get(familyOf.get(actionId)) === group.id);
    if (actions.length === 0) continue;
    tasks.push(
      Object.freeze({
        id: group.id,
        families: group.families,
        actions: Object.freeze(actions),
        prompt: group.prompt,
        purpose: group.purpose,
        missingFact: group.missingFact,
        preconditions: group.preconditions,
      }),
    );
  }
  return Object.freeze(tasks);
}

const SWEEP_TASKS = buildSweepTasks({
  population: readExecutionPopulation(),
  familyOf: readStardewActionFamilies(),
  named: new Set(Object.values(SCENARIO_TASK_ACTION_HINTS).flat()),
});

/**
 * Every task in the pool's world preconditions, keyed by the ids in `DAILY_TASK_ROTATION`.
 *
 * The union is what makes a sweep group's signature unavoidable: a group added to `SWEEP_GROUPS` tomorrow carries its own
 * requirements into the task it builds, so the gate cannot be passed by a task nobody declared. The population of both
 * halves - this table and the rotation - is refused in either direction: a rotation entry with no signature fails by name,
 * and a signature for a task the pool no longer holds fails as `task_precondition_orphaned`, so a declaration cannot
 * outlive its subject.
 */
export const TASK_PRECONDITIONS = Object.freeze({
  ...SCENARIO_TASK_PRECONDITIONS,
  ...Object.fromEntries(SWEEP_TASKS.map((task) => [task.id, task.preconditions])),
});

/**
 * Every published action id a task expects the companion to reach for - the scenario tasks and the sweep tasks.
 *
 * The coverage gate's population of COVERED actions is the union of these values, read from this module rather
 * than parsed out of it, so a task added tomorrow is covered by construction.
 */
export const DAILY_TASK_ACTION_HINTS = Object.freeze({
  ...SCENARIO_TASK_ACTION_HINTS,
  ...Object.fromEntries(SWEEP_TASKS.map((task) => [task.id, task.actions])),
});

/** The sweep tasks themselves, in rotation order, with the purpose each one cannot decide from published facts. */
export const SWEEP_DAILY_TASKS = SWEEP_TASKS;

/**
 * The sweep tasks' prompts, by locale and keyed by task id.
 *
 * The runner owns the player-facing framing, but it does not own the sweep tasks' sentences: writing them there as
 * well would be a second list of the same ids, and the runner reads its prompt table BY KEY - so a key it does not
 * have becomes the literal string "undefined" in the note the companion is handed. One authority, two locales.
 */
export function sweepTaskPrompts() {
  return Object.freeze({
    zh: Object.freeze(Object.fromEntries(SWEEP_TASKS.map((task) => [task.id, task.prompt.zh]))),
    en: Object.freeze(Object.fromEntries(SWEEP_TASKS.map((task) => [task.id, task.prompt.en]))),
  });
}

/**
 * WHAT EACH DAY OF THE POOL IS ABOUT: three PILLARS, and the entries no pillar can honestly hold.
 *
 * <p>
 * THE DEFECT THIS ANSWERS. The rotation used to be a flat list ordered by one rule - "no two scenario gaps sit adjacent" -
 * and the two farm days happened to open it: `clear_and_plant_long_patch` at position 1 and `buy_seeds_and_expand_plot` at
 * position 2. So a three-day run could open on the `3x20` strip and follow it with the seed plot, which is what `round96`
 * did (`day2=clear_and_plant_long_patch, day3=buy_seeds_and_expand_plot`), and the criteria lane measured the cost: one
 * pillar of the game's work took two of the run's three days, so two thirds of the evidence covered one capability.
 * </p>
 * <p>
 * A PILLAR IS A PART OF THE GAME, NOT A TAXONOMY somebody invented to sort ids. `farm` is the fields, `water` is the water
 * and the town and the foraging that goes with them, `mine` is the mine and the machines its ore feeds. Every id below was
 * already in the rotation and every one is filed once: the grouping only says which of them are the same part of the game,
 * so the walk can promise one of each instead of whatever the list's order happened to give.
 * </p>
 * <p>
 * `forage_and_trees` IS THE WATER HALF and not one of the leftovers, because foraging is what she does on the way to the
 * water and in the forest the town road runs through. That reading is stated here rather than left to the order, because
 * the tail below is described elsewhere as "the remaining entries" and a reader is owed the one place that decides which
 * group an id is in.
 * </p>
 * <p>
 * THE GROUPS ARE NOT THE SAME SIZE AND ARE NOT MADE SO: `water` holds three days and the other two hold four, because that
 * is what this game's work is. The walk fills a missing pillar slot with `any` rather than filing a fourth water day that
 * is not about water, which is the same rule that keeps `home_upgrade` out of the farm pillar.
 * </p>
 */
export const TASK_PILLARS = Object.freeze({
  // The fields: the strip, the plot, the crop day that harvests and replants, and the east patch that keeps the ground
  // open. Both of the days that draw a shape longer than one view are here, which is what a farm pillar is for.
  farm: Object.freeze([
    "clear_and_plant_long_patch",
    "buy_seeds_and_expand_plot",
    "water_and_harvest",
    "clear_east_patch",
  ]),
  // The water and the town: a cast, a counter with post in it, and the forage and trees on the way back.
  water: Object.freeze(["a_fish_from_the_water", "town_market", "forage_and_trees"]),
  // The mine and the machines: a recipe crafted and put down, the ladder down, the delve, and the machines loaded.
  mine: Object.freeze(["craft_and_place_machine", "mine_ladder_to_depth", "mine_delve", "run_the_machines"]),
});

/**
 * The order the walk takes the pillars in, ONE PILLAR PER DAY: day 1 farm, day 2 water, day 3 mine, then round again from
 * each group's next member.
 *
 * <p>
 * A THREE-DAY RUN THEREFORE OPENS ON ONE OF EACH, at every offset inside the pillar block, and `readPillarWindows` is the
 * reading that refuses any schedule where it does not. The order is the declaration a reader argues with; the promise is
 * the window rule, and the two are separate so a reordering cannot quietly weaken it.
 * </p>
 */
export const TASK_PILLAR_ORDER = Object.freeze(["farm", "water", "mine"]);

/**
 * THE ENTRIES NO PILLAR CAN HOLD, in the order the tail walks them.
 *
 * <p>
 * THE HONEST PLACE FOR A TASK THAT BELONGS NOWHERE IS ITS OWN GROUP. Filing a leftover under a pillar would make that
 * pillar promise a kind of work it does not measure - a house day is not field work - and would move the repetition defect
 * somewhere else instead of removing it. So `home_and_hearth`, `dress_and_display`, `furnish_and_arrange`,
 * `home_upgrade`, `store_and_sort`, `tidy_and_repair`, `tend_the_animals` and `town_visit` are filed as `any`, they fill
 * the slots a pillar group can no longer take, and a day drawn from them prints `any` beside its id.
 * </p>
 * <p>
 * ALTERNATING DECIDABLE AND GAP, because the other rule the rotation keeps is that no two days the evidence cannot judge
 * sit adjacent: `tend_the_animals` (decidable), `home_and_hearth` (gap), `dress_and_display` (decidable),
 * `furnish_and_arrange` (gap), and so on to the end. `dayTaskSchedule`'s substitution is the rail that catches a pool
 * holding nothing judgeable; this order is what keeps that rail from having to fire on the shipped pool.
 * </p>
 * <p>
 * `home_upgrade` IS NOT HERE, AND NOT ANYWHERE. It needs ten thousand gold and the carpenter, and nothing publishes whether the
 * house grew - so its criterion is a gap, and a day drawn from it can only ever read `unjudged`. A gap task is not a lean day,
 * it is a third of a run measuring nothing (`round93` spent a whole day on an entry one tile could satisfy; this is the same
 * arithmetic with a different cause). Its two actions, `travel` and `shop_purchase`, are named by tasks that are decidable.
 * </p>
 */
export const TASK_ANY_TASKS = Object.freeze([
  "tend_the_animals",
  "home_and_hearth",
  "dress_and_display",
  "furnish_and_arrange",
  "store_and_sort",
  "town_visit",
  "tidy_and_repair",
]);

/**
 * The rotation as the WALK that produces it, rather than a list somebody ordered by hand.
 *
 * <p>
 * ONE GROUP PER DAY in `order`, repeated: day 1 farm, day 2 water, day 3 mine, then round again from each group's next
 * member. THE `any` GROUP FILLS THE SLOT A PILLAR GROUP CAN NO LONGER TAKE, in place and not only at the end - so the
 * walk keeps its three-day rhythm after `water` runs out instead of degrading to a two-day cycle, which is not a detail:
 * a shorter cycle repeats a pillar two days apart at every rank that remains (measured: the first version of this walk put
 * `mine_delve` and `run_the_machines` two days apart at offset 8, and the gate below named it). The sweep tasks follow,
 * because remaining published actions stay covered without displacing a pillar.
 * </p>
 * <p>
 * PURE OVER ITS INPUTS, so the two refusals can be seen to fire on a grouping the repository does not have - a rotation
 * whose `water` group is empty, or an id filed under two groups. The declared grouping is walked at module load and any
 * finding THROWS: an empty pillar silently promises a pillar the walk cannot draw, and every run afterwards measures two
 * thirds of the game without saying so.
 * </p>
 */
export function buildTaskRotation({
  pillars = TASK_PILLARS,
  order = TASK_PILLAR_ORDER,
  anyTasks = TASK_ANY_TASKS,
  sweepTasks = SWEEP_TASKS,
} = {}) {
  const findings = [];
  for (const pillar of order) {
    if (!Array.isArray(pillars?.[pillar]) || pillars[pillar].length === 0) findings.push(`task_pillar_empty:${pillar}`);
  }
  const rotation = [];
  const filed = new Map();
  const file = (task, group) => {
    const already = filed.get(task);
    if (already !== undefined) {
      findings.push(`task_filed_under_two_groups:${task}:${already}:${group}`);
      return;
    }
    filed.set(task, group);
    rotation.push(task);
  };
  const queued = new Map(order.map((pillar) => [pillar, [...(pillars?.[pillar] ?? [])]]));
  const queuedAny = [...anyTasks];
  let filled = true;
  while (filled) {
    filled = false;
    for (const pillar of order) {
      const members = queued.get(pillar);
      const next = members.length > 0 ? { task: members.shift(), group: pillar } : undefined;
      const fallingBack = next ?? (queuedAny.length > 0 ? { task: queuedAny.shift(), group: "any" } : undefined);
      if (fallingBack === undefined) continue;
      file(fallingBack.task, fallingBack.group);
      filled = true;
    }
  }
  for (const task of queuedAny) file(task, "any");
  for (const task of sweepTasks) file(task.id, "any");
  return Object.freeze({ rotation: Object.freeze(rotation), findings: Object.freeze(findings) });
}

const DECLARED_TASK_ROTATION = buildTaskRotation();

if (DECLARED_TASK_ROTATION.findings.length > 0) {
  throw new Error(`stardew_daily_task_rotation_invalid:${DECLARED_TASK_ROTATION.findings.join("|")}`);
}

/**
 * The rotation, in the order a run walks it. Stable ids; the prompts live in the runner because they are
 * player-facing text and the framing has to change with the day.
 *
 * ORDER IS THE COVERAGE PLAN. Consecutive days get consecutive entries, and `runOffsetFor` shifts the first day by one
 * per completed run, so a series of runs walks the whole list. The pillar block opens it - one pillar per day, so a
 * three-day run covers one of each part of the game - and the `any` tail plus the sweep tasks follow once the pillar
 * groups are exhausted, which is also where the days that ask for things the play-session fixture may not contain live.
 * Those are allowed to end in "there is nothing here to do", which is a true observation and not a failed task.
 */
export const DAILY_TASK_ROTATION = DECLARED_TASK_ROTATION.rotation;

/**
 * Which group a rotation entry was filed under: `farm`/`water`/`mine`, or `any` for the entries no pillar can hold.
 *
 * Derived from the declaration above, so an id added to a group tomorrow answers here without a second list.
 */
const PILLAR_OF_TASK = new Map();
for (const pillar of TASK_PILLAR_ORDER) for (const task of TASK_PILLARS[pillar]) PILLAR_OF_TASK.set(task, pillar);
for (const task of TASK_ANY_TASKS) PILLAR_OF_TASK.set(task, "any");
for (const task of SWEEP_TASKS) PILLAR_OF_TASK.set(task.id, "any");

export function pillarOfTask(taskId) {
  return PILLAR_OF_TASK.get(taskId) ?? null;
}

/**
 * NEVER TWO DAYS OF ONE PILLAR IN A THREE-DAY RUN, read from the schedule a run actually got.
 *
 * <p>
 * THE PROPERTY, NOT THE ORDER. `round96` is what the order alone produced: day 2 `clear_and_plant_long_patch`, day 3
 * `buy_seeds_and_expand_plot`, two farm days inside the three-day window that run lived - and this reading answers that
 * schedule with `task_pillar_repeats_in_three_day_run:farm:day2=...->day3=...`, naming both days, rather than with a
 * comment about adjacency. It is a WINDOW rule and not a list rule, so a pin, a first-day override and
 * `dayTaskSchedule`'s substitution all land in it: whatever the days were, this decides whether one pillar took two.
 * </p>
 * <p>
 * The three pillars are subject to it and `any` is exempt, because `any` is what a slot falls back to when the pillar
 * groups are exhausted - a run of three such days is a run covering the remainder, and refusing it would make the
 * fallback unusable. A scheduled task the declaration does not hold at all is `task_pillar_undeclared:<task>`: a schedule
 * that has quietly grown an id nobody filed is not a run measured against a pillar.
 * </p>
 */
export function readPillarWindows({ scheduled = [], pillarOf = pillarOfTask, window = 3 } = {}) {
  const days = [];
  const findings = [];
  for (const entry of scheduled) {
    if (!Number.isInteger(entry?.day) || typeof entry?.task !== "string" || entry.task.length === 0) continue;
    const pillar = pillarOf(entry.task);
    if (pillar === null || pillar === undefined) findings.push(`task_pillar_undeclared:${entry.task}`);
    days.push(Object.freeze({ day: entry.day, task: entry.task, pillar: pillar ?? null }));
  }
  let pairs = 0;
  for (let index = 0; index < days.length; index += 1) {
    for (let ahead = 1; ahead < window && index + ahead < days.length; ahead += 1) {
      pairs += 1;
      const left = days[index];
      const right = days[index + ahead];
      if (left.pillar === null || right.pillar === null) continue;
      if (left.pillar === "any" || right.pillar === "any") continue;
      if (left.pillar !== right.pillar) continue;
      findings.push(
        `task_pillar_repeats_in_three_day_run:${left.pillar}:` +
          `day${String(left.day)}=${left.task}->day${String(right.day)}=${right.task}`,
      );
    }
  }
  const drawn = [...new Set(days.map((day) => day.pillar))].filter((pillar) => pillar !== null);
  return Object.freeze({
    days: Object.freeze(days),
    pairs,
    drawn: Object.freeze(drawn),
    findings: Object.freeze(findings),
    reading: `days ${String(days.length)} · pairs ${String(pairs)} · drew ${drawn.length === 0 ? "none" : drawn.join(",")}`,
  });
}

/**
 * WHICH PILLAR EACH DAY DREW, in the one line a run's own log answers "which pillar did this run measure" with:
 * `day 1: farm/clear_and_plant_long_patch · day 2: water/a_fish_from_the_water · day 3: mine/craft_and_place_machine`.
 *
 * The line travels with the schedule rather than being composed at the print site, so the runner's log and the gate that
 * holds the schedule to `readPillarWindows` cannot spell the same three days two ways.
 */
export function describeScheduledPillars(scheduled = []) {
  const entries = [];
  for (const entry of scheduled) {
    if (!Number.isInteger(entry?.day) || typeof entry?.task !== "string" || entry.task.length === 0) continue;
    entries.push(`day ${String(entry.day)}: ${pillarOfTask(entry.task) ?? "unfiled"}/${entry.task}`);
  }
  return entries.length === 0 ? "(no day scheduled)" : entries.join(" · ");
}

/**
 * Which task a given day of a given run gets.
 *
 * `runOffset` advances the FIRST day's task between runs; `day` advances it within one. Both are 1-based.
 *
 *   run 0, day 1 -> clear_east_patch      run 1, day 1 -> water_and_harvest
 *   run 0, day 2 -> water_and_harvest     run 1, day 2 -> forage_and_trees
 *
 * `day` may be anything the runner has already validated; the modulo keeps the function total rather than
 * throwing on a day outside the rotation length, because a run may legitimately be configured for more days
 * than there are tasks and wrapping is more useful than a crash.
 */
/**
 * Force the first day's task for one run, without disturbing the rotation.
 *
 * <p>
 * The rotation stays the coverage plan and `dailyTaskFor` stays its one reader. This exists because a single
 * run sometimes has to observe ONE task from day one - `go_mining` is sixth in the rotation, so a run that
 * begins at the start of the list cannot reach it before day six, and a run that only lives three days never
 * sees it at all. Rather than reordering the list (which would silently change what every future run covers)
 * the first day is overridden and every later day continues from the rotation as usual.
 * </p>
 * <p>
 * Returns `undefined` when no override is set, so the caller keeps the plain rotation answer and the override
 * cannot be mistaken for a rotation entry.
 * </p>
 */
export function overriddenFirstDayTask(task) {
  if (task === undefined || task === null || task === "") return undefined;
  if (!DAILY_TASK_ROTATION.includes(task)) {
    throw new RangeError(`unknown daily task: ${String(task)}`);
  }
  return task;
}

/**
 * A task pinned to a named day, from `GAMEBUDDY_TASK_FOR_DAY="2:a_fish_from_the_water"`.
 *
 * <p>
 * `overriddenFirstDayTask` can only move the FIRST day, and it deliberately does not touch the rotation offset - so
 * forcing day 1 leaves day 2 wherever the offset already pointed. Measured 2026-11-09 (round42): day 1 was forced to
 * `clear_and_plant_long_patch`, day 2 came out as `mine_delve`, and the fishing day that had just been added to the
 * rotation could not appear in a run that lives two nights. A capability that needs its own day has to be nameable,
 * not hoped for.
 * </p>
 * <p>
 * The spec is `day:task` pairs, comma-separated. A malformed day, an id outside the rotation, or the same day twice is
 * refused by name rather than silently ignored: a pin nobody applied is worse than no pin, because the run then
 * measures a task nobody asked for. Returns a lookup (not a single task) so the caller keeps one answer per day.
 * </p>
 */
export function overriddenTaskForDay(spec) {
  if (spec === undefined || spec === null || String(spec).trim() === "") return undefined;
  const pinned = new Map();
  for (const part of String(spec).split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) throw new RangeError(`GAMEBUDDY_TASK_FOR_DAY wants day:task, got ${trimmed}`);
    const day = Number(trimmed.slice(0, separator));
    const task = trimmed.slice(separator + 1).trim();
    if (!Number.isInteger(day) || day < 1)
      throw new RangeError(`GAMEBUDDY_TASK_FOR_DAY day must be a positive integer: ${trimmed}`);
    if (!DAILY_TASK_ROTATION.includes(task)) throw new RangeError(`unknown daily task: ${task}`);
    if (pinned.has(day)) throw new RangeError(`GAMEBUDDY_TASK_FOR_DAY pins day ${String(day)} twice`);
    pinned.set(day, task);
  }
  return (day) => pinned.get(day);
}
export function dailyTaskFor(runOffset, day) {
  const offset = normalise(runOffset);
  // `day` is NOT normalised: it is a 1-based day number the runner owns, and `normalise` reduces modulo the
  // rotation length, which turned day 5 of a 5-task rotation into index 0 - day 1's task. Only the SUM is taken
  // modulo, so day 6 wraps to day 1 while day 5 stays day 5.
  const dayIndex = Number.isFinite(day) ? Math.trunc(day) - 1 : 0;
  return DAILY_TASK_ROTATION[
    (((offset + dayIndex) % DAILY_TASK_ROTATION.length) + DAILY_TASK_ROTATION.length) % DAILY_TASK_ROTATION.length
  ];
}

/**
 * Which rotation entry a run should START from, derived from what has already been recorded.
 *
 * Derived rather than stored: a stored counter would be a second authority that can disagree with the runs on
 * disk, and the runs on disk are the fact. `completedRuns` is the count of prior multiday runs' artifacts.
 */
export function runOffsetFor(completedRuns) {
  return normalise(completedRuns) % DAILY_TASK_ROTATION.length;
}

/**
 * THE ONE SCHEDULING PATH a multi-day run's days take, composed from the three ways a task is named AND from the one
 * rule that keeps a run from being judged by nothing.
 *
 * <p>
 * Precedence is the whole rule: an explicit `day:task` pin first (`GAMEBUDDY_TASK_FOR_DAY`), then
 * `GAMEBUDDY_FIRST_DAY_TASK` for day 1 only, then the rotation. Measured 2026-11-09 (round42): day 1 was forced to
 * `clear_and_plant_long_patch`, day 2 came out as `mine_delve`, and the fishing day that had just entered the rotation
 * could not appear in a two-night run at all - which is why the pin exists, and why every reader of "which task is day
 * N" goes through this function. A prompt that asks for day 2's task and a purpose check that judges a different one is
 * one composition written twice.
 * </p>
 * <p>
 * THE ROTATION'S OWN ANSWERS NEVER PUT TWO UNJUDGEABLE DAYS IN A ROW, and `judgesAPublishedFact` is required rather
 * than optional because a schedule that cannot say which of its days the evidence can decide is the run this rule
 * exists for: measured on `round84`, three scheduled days were `sweep_animals_and_company`, `sweep_carried_things` and
 * `clear_east_patch` - three criteria whose facts nothing publishes - and a healthy three-day run ended
 * `task_purposes_nothing_judged:3of3`, unable to say whether anything had been achieved. So a rotation entry nothing
 * can judge is not scheduled directly after another one: the second of the pair takes the next entry the evidence CAN
 * decide, the walk continues from there, and a run of two or more days therefore always carries one day the evidence
 * decides. Adjacent pairs are what the rotation's tail held (`sweep_yard_and_work`, `sweep_animals_and_company`,
 * `sweep_carried_things`, then day 1's `clear_east_patch`), which is why the rule is applied to the WALK rather than to
 * the list: the order is a coverage plan somebody argued for, and moving the days is a smaller change than re-arguing it.
 * </p>
 * <p>
 * A PIN OR A FIRST-DAY OVERRIDE IS LEFT ALONE. Those are the operator naming a day, and the rotation does not get to
 * overrule them; a run pinned entirely to unjudgeable days is still caught by `task_purposes_nothing_judged` in
 * `run-verdicts.mjs`, which is the rail for the days nobody could judge.
 * </p>
 * <p>
 * `rotation` is an input rather than a read of the module constant so the falsifier can hand this function a pool the
 * repository does not have - a pool whose every day is unjudgeable, where the rule has nothing to choose and the run
 * really is judged by nothing.
 * </p>
 */
export function dayTaskSchedule({
  runOffset = 0,
  firstDayTask = undefined,
  pinnedTaskForDay = undefined,
  judgesAPublishedFact,
  rotation = DAILY_TASK_ROTATION,
} = {}) {
  if (typeof judgesAPublishedFact !== "function")
    throw new TypeError(
      "task_schedule_needs_its_judgement: a schedule that cannot say which of its days the evidence can decide can schedule a run nothing judges",
    );
  const decided = (task) => judgesAPublishedFact(task) === true;
  // The rotation's own answer for each day of this run, 1-based, computed on demand and kept so the same day asked twice
  // answers the same task.
  const answers = [];
  const used = new Set();
  let cursor = normaliseAgainst(runOffset, rotation.length);
  // The next entry the evidence can decide and this run has not already been given, or -1 when the pool holds none: that
  // is a pool no schedule can make judgeable, not a reason to stop walking.
  const nextDecidable = (from) => {
    for (let step = 0; step < rotation.length; step += 1) {
      const index = (from + step) % rotation.length;
      if (decided(rotation[index]) && !used.has(rotation[index])) return index;
    }
    return -1;
  };
  const rotationDay = (day) => {
    while (answers.length < day) {
      let index = cursor;
      // THE RULE. An unjudgeable day is only ever scheduled after a day the evidence can decide.
      if (answers.length > 0 && !decided(rotation[index]) && !decided(answers[answers.length - 1])) {
        const substitute = nextDecidable((index + 1) % rotation.length);
        if (substitute >= 0) index = substitute;
      }
      answers.push(rotation[index]);
      used.add(rotation[index]);
      cursor = (index + 1) % rotation.length;
    }
    return answers[day - 1];
  };
  return (day) => {
    const wanted = Number.isFinite(day) ? Math.max(1, Math.trunc(day)) : 1;
    return pinnedTaskForDay?.(day) ?? (day === 1 && firstDayTask !== undefined ? firstDayTask : rotationDay(wanted));
  };
}

/**
 * WHAT WAS SCHEDULED FOR EACH DAY VERSUS WHAT WAS ACTUALLY DELIVERED.
 *
 * <p>
 * A day's task is decided the moment its loop body starts; whether the day's first turn ever reached the companion is a
 * separate fact. Without this reading the two are indistinguishable in an artifact: measured 2026-11-11 (`round46`), a
 * run asked for two nights delivered day 1's task and nothing in its bundle said day 2's task had been decided and
 * dropped, so "the fishing day was asked for" and "it never was" read the same.
 * </p>
 * <p>
 * `scheduled` and `delivered` are `{day, task}` entries in delivery order. A day that was scheduled and never delivered
 * yields `task_not_delivered:<day>:<taskId>`; a day asked for a different task than the one scheduled yields
 * `task_delivered_differs_from_scheduled:<day>:<scheduled>:<delivered>`. Both name the day and the task, because a run
 * judged against a task it was never given is the defect they exist for.
 * </p>
 */
export function readTaskDelivery({ scheduled = [], delivered = [] } = {}) {
  const byDay = (entries) => {
    const out = {};
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!Number.isInteger(entry?.day) || typeof entry?.task !== "string") continue;
      out[`day${String(entry.day)}`] = entry.task;
    }
    return out;
  };
  const scheduledByDay = byDay(scheduled);
  const deliveredByDay = byDay(delivered);
  const notDelivered = [];
  const mismatched = [];
  for (const [dayKey, task] of Object.entries(scheduledByDay)) {
    const day = Number(dayKey.slice("day".length));
    const asked = deliveredByDay[dayKey];
    if (asked === undefined) {
      notDelivered.push(`task_not_delivered:${String(day)}:${task}`);
      continue;
    }
    if (asked !== task) mismatched.push(`task_delivered_differs_from_scheduled:${String(day)}:${task}:${asked}`);
  }
  return Object.freeze({
    scheduled: Object.freeze(scheduledByDay),
    delivered: Object.freeze(deliveredByDay),
    notDelivered: Object.freeze(notDelivered),
    mismatched: Object.freeze(mismatched),
    // The one-line spelling travels WITH the reading, so a run's log and its artifact state the same sentence rather
    // than two call sites composing it.
    reading: describeTaskDelivery({ scheduled: scheduledByDay, delivered: deliveredByDay }),
  });
}

/**
 * The reading as ONE line, in the spelling the run's log and its artifact both use: the two halves side by side, so a
 * missing task is visible rather than assumed.
 */
export function describeTaskDelivery(reading) {
  const pairs = (byDay) => {
    const entries = Object.entries(byDay ?? {});
    return entries.length === 0 ? "(none)" : entries.map(([day, task]) => `${day}=${task}`).join(", ");
  };
  return `tasks_scheduled: ${pairs(reading?.scheduled)}; tasks_delivered: ${pairs(reading?.delivered)}`;
}

function normalise(value) {
  return normaliseAgainst(value, DAILY_TASK_ROTATION.length);
}

function normaliseAgainst(value, size) {
  const number = Number.isFinite(value) ? Math.trunc(value) : 0;
  return ((number % size) + size) % size;
}

/**
 * How many multiday runs are already recorded under a live-run root.
 *
 * Counted from the artifacts rather than from a counter file: a stored counter is a second authority that can
 * disagree with the runs on disk, and the runs on disk are the fact. A missing root means no runs yet, which is
 * offset 0.
 */
export function countPriorMultidayRuns(root) {
  if (typeof root !== "string" || root.length === 0) return 0;
  try {
    return readdirSync(root, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && entry.name.includes("multiday_routine"),
    ).length;
  } catch {
    return 0;
  }
}
