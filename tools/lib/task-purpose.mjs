/**
 * A task's PURPOSE, and the difference between it and an action's success.
 *
 * Three levels are decided in this product, and they are not interchangeable:
 *
 *   1. ACTION POSTCONDITION - did this one action do what it promised? Decided by the Mod's receipt and, on the
 *      Host side, by `IntegrationActionCatalog.hasCompletionEvidence`: the per-action evidence parser in
 *      `host/src/stardew-game-integration-adapter.ts`, gated one rule per action by
 *      `host/src/stardew-completion-evidence-coverage.test.ts`. A receipt whose state is `succeeded` but whose
 *      detail does not parse as THAT action's own postcondition is evidence of nothing, and this module refuses it.
 *
 *   2. TASK CRITERION - was the PURPOSE achieved? A purpose is a statement about the world, and it is never the
 *      same fact as "an action succeeded". `break_rock`'s postcondition is true when a rock left the layer; the
 *      purpose "a mine was entered and something was broken inside it" is false when the rock was on the surface.
 *      The table below is the only place a daily task is declared accomplished.
 *
 *   3. REPORT - what the run publishes and tells the player. It is projected FROM (2). It never decides (2).
 *
 * Measured: a `go_mining`-shaped day declared `[travel, enter_mine, break_rock]`, broke rocks on the surface, and
 * was counted as having accomplished the task because `break_rock` came back `succeeded`. The postcondition was
 * real; the purpose was never touched. So a criterion is composed from postconditions that TOGETHER state the
 * purpose - the order the world saw them in is part of the statement - and "some declared action succeeded"
 * satisfies none of them.
 *
 * WHAT A CRITERION MAY NOT DO. It may not read a fact the receipts do not publish, and it may not substitute a
 * readable neighbour for the purpose (clearing "one patch somewhere" is not clearing the east patch). Where the
 * purpose needs a fact nothing publishes, the entry carries `missingFact` instead of `steps`: the task is then
 * `unproven` with that sentence attached, and `judgeTaskPurpose` still cannot return `achieved` for it.
 */

import { STARDEW_GAME_INTEGRATION_ADAPTER } from "../../host/dist-test/stardew-game-integration-adapter.js";

/** A step of a criterion: one admitted postcondition. */
const step = (actionId) => Object.freeze({ actionId });

/** A step satisfied by any one of several actions - the same purpose reached by different native seams. */
const anyOf = (...actionIds) => Object.freeze({ anyOf: Object.freeze(actionIds) });

const criterion = (purpose, steps, { ordered = true } = {}) =>
  Object.freeze({ purpose, steps: Object.freeze(steps), ordered });

/**
 * A purpose that cannot be decided from published facts, with the fact that would be needed.
 *
 * This is not an exclusion from the gate: the gate requires every rotation task to have an entry, and this entry
 * still answers `unproven` rather than `achieved` for any receipt set, however complete.
 */
const gap = (purpose, missingFact) => Object.freeze({ purpose, missingFact });

/**
 * What each rotation task's purpose requires, keyed by the task ids in `multiday-daily-tasks.mjs`.
 *
 * Each criterion reads only postconditions the Mod already publishes and the Host already validates, and each one
 * requires at least two of them, so no single action's success can satisfy a task.
 */
export const TASK_PURPOSE_CRITERIA = Object.freeze({
  clear_east_patch: gap(
    "the east patch has no weeds and rocks left in it",
    "no fact says which part of the farm is the east patch: `cut_weeds`/`cut_grass`/`break_rock`/`chop_stump` publish the target they removed and the tool they used, never the map or the region, so 'a patch was cleared somewhere' is the strongest statement a run can make.",
  ),
  water_and_harvest: criterion("a crop was brought in and the ground it left was then planted", [
    step("harvest_crop"),
    step("plant_seed"),
  ]),
  forage_and_trees: criterion(
    "something was picked up and a tree was shaken",
    [step("pickup_forage"), step("shake_tree")],
    { ordered: false },
  ),
  craft_and_place_machine: criterion("a machine was crafted, then put down, then put to work", [
    step("craft_item"),
    step("place_owned_object"),
    step("machine_load"),
  ]),
  town_market: gap(
    "something was bought in town and the post was brought in",
    "no published fact places the actor in Town: `shop_purchase` publishes the shop and `claim_mail_attachment` the farm mailbox, neither publishes a map, and `travel` publishes endpoints only when travel is the route that was used.",
  ),
  town_visit: gap(
    "a conversation happened in town",
    "`talk_to_npc` publishes the NAME of the map the conversation happened on (Farm, SeedShop, Saloon, ...), and nothing publishes which of those maps is Town, so a word at the farm and a word in the square are the same fact.",
  ),
  mine_delve: criterion("a mine level was entered and something was broken after it", [
    step("enter_mine"),
    anyOf("break_rock", "break_container"),
  ]),
  store_and_sort: criterion("something was put into a chest and taken back out", [
    step("chest_store"),
    step("chest_retrieve"),
  ]),
  till_and_sow: criterion("the ground was tilled, then planted, then watered", [
    step("till_soil"),
    step("plant_seed"),
    step("water_crop"),
  ]),
  tidy_and_repair: criterion(
    "debris was cleared and something placed was put away",
    [step("clear_debris"), step("remove_placed_item")],
    { ordered: false },
  ),
  tend_the_animals: criterion(
    "an animal was petted, fed, and its product collected",
    [step("pet_animal"), step("feed_animal"), step("collect_animal_product")],
    { ordered: false },
  ),
  dress_and_display: criterion("something else was put on and the house was given a display", [
    step("equip_wearable"),
    anyOf("dress_mannequin", "set_sign_display"),
  ]),
  clear_and_cultivate: criterion("a patch was cleared, then tilled, then planted and watered", [
    anyOf("chop_tree", "chop_stump", "clear_debris"),
    step("till_soil"),
    step("plant_seed"),
    step("water_crop"),
  ]),
  home_and_hearth: gap(
    "the house was tidied and a few things put out so it feels lived in",
    "`place_owned_object` publishes the one object it set down and the map it landed on, and nothing publishes what the room now holds - the note's own end state ('so it feels lived in') has no fact behind it, and 'tidy it up' names no action with a postcondition.",
  ),
  home_upgrade: gap(
    "the carpenter was asked about extending the house",
    "the farmhouse upgrade is an answer inside the carpenter's own dialogue; no receipt reports it. `shop_purchase` reports a shop sale, and the game's upgrade branch (`GameLocation.answerDialogueAction`) mints no world fact.",
  ),
  mine_ladder_to_depth: gap(
    "a mine level was worked deeper and then left by its own exit ladder",
    "the exit half is `use_mine_ladder`, which the Mod catalog registers `FarmhandActionLifecycle.Experimental` (`FarmhandActionDefinitions.cs:270`): the action is not published, so no run can dispatch it and no receipt can prove a ladder was taken.",
  ),
  furnish_and_arrange: gap(
    "placed furniture was moved and something was recoloured",
    "the move half is `move_placed_furniture`, which the Mod catalog registers `FarmhandActionLifecycle.Experimental`: it is not published, so no run can dispatch it, and `color_placed_object` alone is one action rather than the arrangement.",
  ),
  run_the_machines: criterion("a machine was loaded and its output collected", [
    step("machine_load"),
    step("machine_collect_output"),
  ]),
});

/**
 * The admitted evidence a purpose may read: one entry per receipt that is BOTH a success state AND its own
 * action's postcondition, as the Host decides that question.
 *
 * A `succeeded` receipt with no evidence, or with evidence that does not parse as the action it names, is moved to
 * `refused` instead of being counted. That list is what lets a caller say "the receipt existed and proved nothing"
 * rather than "the run did nothing", and it is the reason a refused receipt can only ever produce `unproven`.
 */
export function purposeReceipts(receipts) {
  const admitted = [];
  const refused = [];
  for (const receipt of receipts ?? []) {
    if (receipt === null || typeof receipt !== "object") continue;
    const actionId = receipt.actionId;
    if (typeof actionId !== "string" || actionId.length === 0) continue;
    // Only a success state is a candidate. A failure or an in-flight state is not evidence of anything, and it is
    // not "refused" either - there is nothing to refuse.
    if (receipt.state !== "succeeded") continue;
    if (
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(actionId, {
        state: receipt.state,
        reasonCode: typeof receipt.reasonCode === "string" ? receipt.reasonCode : "",
        evidence: receipt.evidence,
      }) !== true
    ) {
      refused.push(Object.freeze({ actionId, reasonCode: "succeeded_receipt_without_its_own_postcondition" }));
      continue;
    }
    admitted.push(Object.freeze({ actionId }));
  }
  return Object.freeze({ admitted: Object.freeze(admitted), refused: Object.freeze(refused) });
}

/** The first receipt, at or after `from`, that satisfies this step without reusing an already-consumed one. */
function matchingIndexIn(admitted, used, from, candidate) {
  const actionIds = candidate.actionId === undefined ? candidate.anyOf : [candidate.actionId];
  for (let index = from; index < admitted.length; index += 1) {
    if (!used.has(index) && actionIds.includes(admitted[index].actionId)) return index;
  }
  return -1;
}

/**
 * Whether every step of a criterion is satisfied, each by a DISTINCT admitted receipt.
 *
 * An ordered criterion (`ordered: true`, the default) matches its steps forward through the receipt log, so the
 * order the world saw them in is part of the statement: a rock broken before the mine was entered cannot satisfy
 * "a mine was entered and something was broken after it", and water poured before the seed went in cannot satisfy
 * "tilled, then planted, then watered". An unordered one still requires distinct receipts, so one action cannot
 * answer two of its steps.
 */
function criterionSatisfied(entry, admitted) {
  const used = new Set();
  let cursor = -1;
  for (const candidate of entry.steps) {
    const index = matchingIndexIn(admitted, used, entry.ordered === false ? 0 : cursor + 1, candidate);
    if (index < 0) return false;
    used.add(index);
    cursor = index;
  }
  return true;
}

/**
 * Did the task's own purpose hold?
 *
 * `achieved` is reachable only through the criterion above. Everything else is named: `not_achieved` when the
 * receipts are complete evidence that the purpose did not hold, `unproven` when the criterion cannot be evaluated at
 * all (no entry, or a published fact it needs is missing) or when the receipts that would have decided it carried no
 * postcondition of their own.
 */
export function judgeTaskPurpose(taskId, receipts) {
  const entry = TASK_PURPOSE_CRITERIA[taskId];
  const { admitted, refused } = purposeReceipts(receipts);
  const common = Object.freeze({
    taskId,
    admittedActionIds: Object.freeze([...new Set(admitted.map((receipt) => receipt.actionId))].sort()),
    refusedReceipts: refused,
  });
  if (entry === undefined) {
    return Object.freeze({
      ...common,
      state: "unproven",
      reasonCode: "task_purpose_not_declared",
      purpose: null,
      missingFact: `no purpose criterion is declared for "${String(taskId)}", so nothing can say whether it was accomplished.`,
    });
  }
  if (entry.missingFact !== undefined) {
    return Object.freeze({
      ...common,
      state: "unproven",
      reasonCode: "task_purpose_needs_an_unpublished_fact",
      purpose: entry.purpose,
      missingFact: entry.missingFact,
    });
  }
  if (criterionSatisfied(entry, admitted)) {
    return Object.freeze({
      ...common,
      state: "achieved",
      reasonCode: "task_purpose_achieved",
      purpose: entry.purpose,
      missingFact: null,
    });
  }
  // A refused receipt means the evidence that would have decided this purpose exists and proved nothing about the
  // action it named. That is not "the purpose did not hold"; it is "this run cannot tell", and it is treated as such.
  if (refused.length > 0) {
    return Object.freeze({
      ...common,
      state: "unproven",
      reasonCode: "task_purpose_evidence_without_postcondition",
      purpose: entry.purpose,
      missingFact: null,
    });
  }
  return Object.freeze({
    ...common,
    state: "not_achieved",
    reasonCode: "task_purpose_not_achieved",
    purpose: entry.purpose,
    missingFact: null,
  });
}
