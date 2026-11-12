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
 * THE SCENARIO LIST ABOVE WAS NOT ENOUGH, so it is now followed by SWEEP TASKS derived from the published surface
 * itself. Measured when they were added: the eighteen scenario tasks named 50 of the 95 published execution
 * actions, so 45 could be finished, gated, and never once asked for - and a run stays green through that, which is
 * the same defect `enter_mine` was for months. The sweep is not a new capability and not a new list to maintain:
 * it is the remainder of the artifact, grouped by the family the Mod's own registration catalog declares, and
 * `tools/check-stardew-task-action-coverage.mjs` fails when a published action is named by no task and explained by
 * no exclusion.
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
  home_upgrade: Object.freeze(["travel", "shop_purchase"]),
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
  till_and_sow: Object.freeze(["till_soil", "plant_seed", "water_crop", "fertilize_tile"]),
  store_and_sort: Object.freeze(["chest_store", "chest_retrieve", "pickup_item"]),
  tend_the_animals: Object.freeze(["pet_animal", "feed_animal", "collect_animal_product", "water_pet_bowl"]),
  tidy_and_repair: Object.freeze(["clear_debris", "clear_hoedirt", "remove_placed_item", "break_container"]),
  dress_and_display: Object.freeze(["equip_wearable", "unequip_wearable", "dress_mannequin", "set_sign_display"]),
  clear_and_cultivate: Object.freeze([
    "chop_tree",
    "chop_stump",
    "clear_debris",
    "till_soil",
    "plant_seed",
    "water_crop",
  ]),
  // THE ONE TASK WHOSE SHAPE IS LONGER THAN ONE VIEW. Target discovery is Chebyshev radius 6, so every snapshot is a
  // 13x13 window and no snapshot contains this plot: 3x20 is twenty tiles long. Sixty tiles at three actions each keeps
  // the day's cost beside `clear_and_cultivate`, and the question is one no task has ever asked - can she hold a
  // boundary after walking out of the window she laid the far end of it in?
  //
  // `chop_tree`/`chop_stump` are deliberately absent, and that is the only pruning: this patch is a strip of open
  // ground, and a tile a tree stands on is not a tile you till - `clear_and_cultivate` keeps both because its patch is
  // cut out of the woods, which is the opposite ground. Weeds, loose debris and rocks are what a clearable strip in
  // front of the house actually holds, and all three stand between her and the first tilled tile.
  clear_and_plant_long_patch: Object.freeze([
    "cut_weeds",
    "clear_debris",
    "break_rock",
    "till_soil",
    "plant_seed",
    "water_crop",
  ]),
  // THE ONLY TASK THAT ASKS FOR A WATER ACTION. `fish_here` is published and no task named it, which is the same
  // coverage hole `enter_mine` was in: an action can be finished, gated, and never exercised because nothing asked.
  // One action, deliberately - the task is "did she go and fish", not a quota of fish.
  a_fish_from_the_water: Object.freeze(["fish_here"]),
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
  }),
  Object.freeze({
    id: "sweep_carried_things",
    families: Object.freeze(["body_tools", "crafting_cooking", "shops_economy", "inventory_items"]),
    prompt: Object.freeze({
      zh: "把随身带着的东西理一遍，能用的用掉、该卖的卖掉。",
      en: "sort through what you are carrying - use what is worth using, sell what should be sold.",
    }),
    purpose: "what was carried was sorted and put to use",
    missingFact:
      "the receipts report one action and one item each, and nothing publishes what the backpack held before or after, so 'what was carried was sorted' has no fact behind it - only the individual uses it led to.",
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
 * The rotation, in the order a run walks it. Stable ids; the prompts live in the runner because they are
 * player-facing text and the framing has to change with the day.
 *
 * ORDER IS THE COVERAGE PLAN. Consecutive days get consecutive entries, and `runOffsetFor` shifts the first day by one
 * per completed run, so a series of runs walks the whole list. The first five are what the world can already satisfy with
 * certainty on a bare farm; the second group asks for things the play-session fixture may not contain, and those are
 * allowed to end in "there is nothing here to do" - which is a true observation, not a failed task.
 */
export const DAILY_TASK_ROTATION = Object.freeze([
  "clear_east_patch",
  "water_and_harvest",
  "forage_and_trees",
  "craft_and_place_machine",
  "town_market",
  "town_visit",
  "mine_delve",
  "store_and_sort",
  "till_and_sow",
  "tidy_and_repair",
  "tend_the_animals",
  "dress_and_display",
  "clear_and_cultivate",
  "home_and_hearth",
  "home_upgrade",
  "mine_ladder_to_depth",
  "furnish_and_arrange",
  "run_the_machines",
  // APPENDED after the farming tasks rather than interleaved: it is the last of the scenario days, and the sweep tasks
  // stay the tail of the rotation. A day that has to till sixty tiles should not be what the first run of a series
  // begins with, and `runOffsetFor` still walks the whole list one first-day per run.
  "clear_and_plant_long_patch",
  // APPENDED beside the long patch for the same reason it was: the first days belong to what a bare farm can satisfy,
  // and a fishing day depends on water she has to walk to. The action exists and no task had ever asked for it.
  "a_fish_from_the_water",
  // The sweep tasks come LAST, deliberately. The nineteen above are a coverage plan somebody argued for, in an
  // order that puts what a bare farm can satisfy first; appending rather than interleaving keeps that plan intact
  // and makes the new days the tail of the rotation rather than a silent reordering of every run that came before.
  ...SWEEP_TASKS.map((task) => task.id),
]);

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
 * THE ONE SCHEDULING PATH a multi-day run's days take, composed from the three ways a task is named.
 *
 * <p>
 * Precedence is the whole rule: an explicit `day:task` pin first (`GAMEBUDDY_TASK_FOR_DAY`), then
 * `GAMEBUDDY_FIRST_DAY_TASK` for day 1 only, then the rotation. Measured 2026-11-09 (round42): day 1 was forced to
 * `clear_and_plant_long_patch`, day 2 came out as `mine_delve`, and the fishing day that had just entered the rotation
 * could not appear in a two-night run at all - which is why the pin exists, and why every reader of "which task is day
 * N" goes through this function. A prompt that asks for day 2's task and a purpose check that judges a different one is
 * one composition written twice.
 * </p>
 */
export function dayTaskSchedule({ runOffset = 0, firstDayTask = undefined, pinnedTaskForDay = undefined } = {}) {
  return (day) =>
    pinnedTaskForDay?.(day) ?? (day === 1 && firstDayTask !== undefined ? firstDayTask : dailyTaskFor(runOffset, day));
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
  const number = Number.isFinite(value) ? Math.trunc(value) : 0;
  return ((number % DAILY_TASK_ROTATION.length) + DAILY_TASK_ROTATION.length) % DAILY_TASK_ROTATION.length;
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
