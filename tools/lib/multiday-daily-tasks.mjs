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
 */
import { readdirSync } from "node:fs";

/** The published action ids each task expects the companion to reach for. Used by the run's own audit. */
export const DAILY_TASK_ACTION_HINTS = Object.freeze({
  clear_east_patch: Object.freeze(["cut_weeds", "cut_grass", "break_rock_source", "chop_stump"]),
  water_and_harvest: Object.freeze(["harvest_crop", "scythe_crop", "plant_seed", "water_crop"]),
  forage_and_trees: Object.freeze(["pickup_forage", "shake_tree", "harvest_fruit_tree", "chop_tree_source"]),
  craft_and_place_machine: Object.freeze(["craft_item", "place_owned_object", "machine_inspect"]),
  town_errand: Object.freeze(["travel", "talk_to_npc"]),
  // The rows below exist for COVERAGE, and that is a measured need rather than a preference: of the 95 published
  // actions, 78 were reachable by no task for ever, so a capability could be finished, gated, and still never exercised.
  // `enter_mine` is the proof - published, correct, and used in zero runs because nothing ever asked for a mine.
  go_mining: Object.freeze(["navigate_to_destination", "enter_mine", "break_rock_source"]),
  till_and_sow: Object.freeze(["till_soil", "plant_seed", "water_crop", "fertilize_tile"]),
  store_and_sort: Object.freeze(["chest_store", "chest_retrieve", "pickup_item"]),
  tend_the_animals: Object.freeze(["pet_animal", "feed_animal", "collect_animal_product", "water_pet_bowl"]),
  tidy_and_repair: Object.freeze(["clear_debris", "clear_hoedirt", "remove_placed_item", "break_container_source"]),
  dress_and_display: Object.freeze(["equip_wearable", "unequip_wearable", "dress_mannequin", "set_sign_display"]),
});

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
  "town_errand",
  "go_mining",
  "store_and_sort",
  "till_and_sow",
  "tidy_and_repair",
  "tend_the_animals",
  "dress_and_display",
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
