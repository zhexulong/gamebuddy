/**
 * A task's PURPOSE, and the difference between it and an action's success.
 *
 * Three levels are decided in this product, and they are not interchangeable:
 *
 *   1. ACTION POSTCONDITION - did this one action do what it promised? Decided by the Mod's receipt and, on the
 *      Host side, by `judgeStardewCompletionEvidence`: the per-action evidence parser in
 *      `host/src/stardew-completion-contracts.ts`, gated one rule per action by
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
 * purpose, and "some declared action succeeded" satisfies none of them.
 *
 * ORDER IS PART OF A CRITERION ONLY WHERE THE PURPOSE IS A CAUSE. An ordered criterion (`ordered`, the default) matches
 * its steps forward through the receipt log, so it asserts that each earlier fact is a PRECONDITION of the next - and
 * the row must name that link in `because`. A row that cannot name it is unordered. Measured 2026-11-18 (`round76`): a
 * day that cleared, sowed, watered and tilled was reported `not_achieved`, because the criterion it was judged on
 * demanded the chain clearing-then-tilling-then-sowing. The chain is ONE way to prepare ground; she had sown into
 * ground that was already tilled, which is what a farmhand does, so the criterion graded the drawing instead of the day.
 *
 * GROUND IS GRADED BY ITS STATE AT THE END OF THE DAY, NEVER BY THE SWINGS THAT OPENED IT. That is the rule above applied
 * to a purpose about a PLOT rather than about a sequence: the day owes tiles that are tilled, sown and watered when it
 * ends, and it does not owe a Hoe swung once per tile. So a tile a SOWING named is tilled ground - `plant_seed` puts a
 * seed into that tile's soil, which is the one place a seed can go - and a day that sows into ground turned earlier has
 * laid the plot exactly as much as one that turned every tile itself. Measured 2026-11-23 (the round96 run published as
 * `tools/_multiday_routine-round96.result.json`): day 3 bought fifty parsnip seeds at Pierre's, sowed and watered twenty
 * tiles, turned FIVE of them with its own Hoe, and answered `till_soil 5/20`, because the criterion it was judged on
 * counted swings. The twenty tiles were the plot. What the reading keeps is how much of it was ground the day had to
 * open itself (`already_tilled`), so "expand" stays a measured word rather than an assertion.
 *
 * AND IT MAY NOT DEMAND WHAT THE DAY'S OWN ACTIONS CANNOT PRODUCE. Measured 2026-11-23 (`round96`, day 3,
 * `clear_and_plant_long_patch`): she tilled, sowed and watered fifty-eight tiles of the 20x3 strip at `(44,21)..(63,23)`
 * and was filed `not_achieved` for the two she did not - `(60,22)` and `(62,23)`, where two standing trees answered
 * `soil_not_diggable:occupied:tree` twice. Her own words that turn: 「就差两棵树占着的那两格。」 `chop_tree` is not among
 * the actions that day declares (`DAILY_TASK_ACTION_HINTS`), and the strip's own declaration says why - "a tile a tree
 * stands on is not a tile you till" - so the criterion asked for a shape the day's action set could not produce, and a
 * model that did everything right was filed as failed. A patch's denominator is therefore the tiles INSIDE its rectangle
 * that the day could make ready (`PATCH_OCCUPANT_REFUSAL` below), and the ones it could not are named in the verdict
 * rather than silently missed.
 *
 * WHAT A CRITERION MAY NOT DO. It may not read a fact the receipts do not publish, and it may not substitute a
 * readable neighbour for the purpose (clearing twenty pieces of clutter somewhere is not clearing the twenty the day
 * was given). Where the purpose needs a fact nothing publishes, the entry carries `missingFact` instead of `steps`: the
 * day is then `unjudged` with that sentence attached, and `judgeTaskPurpose` still cannot return `achieved` for it.
 *
 * UNJUDGED IS A THIRD ANSWER, NOT A QUIETER UNPROVEN. Measured 2026-11-20 (`round81`): day 3 was `sweep_yard_and_work`,
 * whose purpose is a fact nothing publishes, and its `unproven` verdict read as a failed day - the run was blocked for a
 * task no run could have passed. A purpose the receipts cannot decide by construction is our own reporting gap, so a gap
 * day never blocks. The other half is what keeps the state worth reading: a NON-gap day nobody proved still blocks every
 * time (`task_unproven`), and a run whose every day was a gap day is `task_purposes_nothing_judged` - judged by nothing is
 * not a pass. The gate over both halves is `a_day_task_whose_criterion_decides_nothing_is_not_reported_either_way` in
 * `task-purpose.test.mjs`.
 *
 * AND THE GAP NAMES THE FACT AND THE PRODUCER THAT DOES NOT PUBLISH IT. `missingFact` is the sentence a reader gets;
 * `unpublishedFact` is the same fact as data - its NAME, and the producer that would have to publish it
 * (`producerAt(path, anchor)`) or `null` when nothing in this tree is even the right place. The gate
 * `a_criterion_asks_for_a_fact_the_product_does_not_publish` in `task-purpose.test.mjs` walks every criterion in this
 * table - never a list of the gaps - resolves each required fact's producer, and fails naming the criterion and the
 * fact when one asks for a fact nobody publishes and does not say so. Measured 2026-11-19 (`round77`): two of the three
 * days answered `task_purpose_needs_an_unpublished_fact` while the gameplay was healthy (500 actions, 2 nights), and
 * the sentence was the only place the fact and the missing producer were written down.
 */

import { readFileSync } from "node:fs";
import { clearedKinds, constantsIn, SOURCES } from "../../gates/stardew/audit-stardew-clearing-vocabulary.mjs";
import { LOCATION_NAMES_ZH } from "../../host/dist-test/game-world-vocabulary.js";
import { judgeStardewCompletionEvidence } from "../../host/dist-test/stardew-completion-contracts.js";

import { DAILY_TASK_ACTION_HINTS, SWEEP_DAILY_TASKS } from "./multiday-daily-tasks.mjs";
import { bestWindow, largestFilledRectangle, windowHoldsAll } from "./tile-patch.mjs";

/** A step of a criterion: one admitted postcondition, or `count` distinct receipts of it. */
const step = (actionId, { count = 1 } = {}) => Object.freeze(count === 1 ? { actionId } : { actionId, count });

/** A step satisfied by any one of several actions - the same purpose reached by different native seams. */
const anyOf = (...actionIds) => Object.freeze({ anyOf: Object.freeze(actionIds) });

/**
 * A criterion, and the causal link that makes its order unavoidable.
 *
 * `ordered` says the steps are read forward through the receipt log, so the earlier fact has to be a precondition of the
 * later one; `because` is where the row names that link. An ORDERED row without a link is an order the table invented,
 * and one the day cannot fail to violate when the farm offers the same work in another sequence - which is why the gate
 * over this table (`a_criterion_requires_an_order_the_world_does_not` in `task-purpose.test.mjs`) refuses it. An
 * unordered criterion takes its steps in whatever order the farm allowed, still from distinct receipts, and carries no
 * `because`: a row that declares both has not decided which it is.
 */
const criterion = (purpose, steps, { ordered = true, because } = {}) =>
  Object.freeze({ purpose, steps: Object.freeze(steps), ordered, because });

/**
 * What a task's reason rests on, one fact at a time.
 *
 * A `missingFact` sentence is a claim about TODAY's catalog, and until these declarations existed nothing re-read it:
 * `mine_ladder_to_depth` named `use_mine_ladder` as `Experimental` long after the action was promoted to
 * `LiveVerified` with a live gate, and the tree went on answering "this task cannot be decided" for a criterion that
 * was writable. So the reason's load-bearing facts are declared in the closed vocabulary
 * `tools/check-stardew-task-gap-reasons.mjs` checks - a lifecycle, a postcondition, an action's presence, an evidence
 * field a receipt carries or cannot carry - and each is read back from the Mod's generated surface or the Host's
 * completion contract. The claim and the sentence are one fact with two spellings, which is why the gate also refuses
 * a claim whose action the sentence never names.
 */
const actionLifecycle = (actionId, lifecycle) => Object.freeze({ kind: "action_lifecycle", actionId, lifecycle });
const actionPostcondition = (actionId, name) => Object.freeze({ kind: "action_postcondition", actionId, name });
const presentEvidenceField = (actionId, field) => Object.freeze({ kind: "present_evidence_field", actionId, field });

/**
 * The half of a reason no artifact can decide, with the artifact that would refute it.
 *
 * Declared rather than implied, because an absence nobody enumerates - "no published family says which tile the piece of
 * furniture came to rest on" - is a debt: the reader has to be able to check it without a run, and the next lane has to
 * know which file to change to retire it.
 */
const proseReason = (refutableBy) => Object.freeze({ kind: "prose", refutableBy });

/**
 * The producer that does not publish a fact, named by its FILE and an ANCHOR that file must still contain.
 *
 * An anchor rather than a line, for the reason `mine_ladder_to_depth` paid for: `FarmhandActionDefinitions.cs:270` was
 * true when it was written and held another declaration a month later, so a line is a claim about a layout. The anchor
 * is a token the producer writes (`shop_purchase: (claim) =>`, `place_owned_object_postcondition_unavailable`), the
 * gate finds the line it sits on today, and the reading it prints carries that line - derived, never typed here.
 */
const producerAt = (path, anchor) => Object.freeze({ path, anchor });

/**
 * The fact a purpose needs and no producer publishes: what it is, and who would have to publish it.
 *
 * `producer: null` is a reading of this tree rather than a shrug: for `home_upgrade` no action's postcondition is the
 * carpenter's answer, and the branch that offers the upgrade is the game's own dialogue script, so there is no row to
 * amend and no key to add - only an action that does not exist yet. Where a row DOES exist and stops one field short,
 * the producer names it, and the gate prints the line the row is on today.
 */
const unpublishedFact = (name, producer = null) => Object.freeze({ name, producer });

/**
 * A purpose that cannot be decided from published facts, with the fact that would be needed.
 *
 * This is not an exclusion from the gate: the gate requires every rotation task to have an entry, and this entry
 * still answers `unjudged` rather than `achieved` for any receipt set, however complete.
 *
 * `reason` says whether the blocker itself is machine-checkable (`mechanical`) or rests on an absence no artifact
 * enumerates (`prose`), and `tools/check-stardew-task-gap-reasons.mjs` holds the declaration and the claims to each
 * other in both directions. A reason may not cite a source LINE - `file.cs:270` is a claim about a layout no gate can
 * re-check, and it is how this table's stale entry looked true. `fact` is the same missing fact as DATA
 * (`unpublishedFact`), so the gate can name it and resolve the producer that would have to publish it without parsing
 * the sentence.
 */
const gap = (purpose, missingFact, { reason, claims, fact }) =>
  Object.freeze({ purpose, missingFact, reason, claims: Object.freeze(claims), unpublishedFact: fact });

/**
 * A purpose that is a SHAPE in the world, declared as the rectangle it asks for.
 *
 * `steps` cannot state this one: a patch is not "these actions happened", it is "the tiles those actions changed
 * form one 3x20 strip". So the entry declares the rectangle, and beside it the actions whose own postcondition names
 * the tile it changed and the evidence field that name is in - the only tile coordinates any receipt publishes.
 * Whether a set of coordinates contains the declared rectangle is decided in `tile-patch.mjs`.
 */
const patch = (purpose, { width, height, tilledBy, croppedBy }) =>
  Object.freeze({
    purpose,
    patch: Object.freeze({ width, height }),
    tilledBy: Object.freeze(tilledBy),
    croppedBy: Object.freeze(croppedBy),
  });

/** One action that proves a tile is tilled or carries a crop, and the evidence field that names the tile. */
const tileProof = (actionId, tileField) => Object.freeze({ actionId, tileField });

/**
 * A purpose that is a COUNT OF SEPARATE THINGS TAKEN OFF THE GROUND, and no place anywhere in it.
 *
 * <p>
 * THIS IS WHAT A CLEARING DAY CAN PROVE. It used to be a gap: `clear_east_patch` asked for "the east patch" left
 * without weeds and rocks, and no published fact says which part of the farm is east - the farm arrives as one `Farm`
 * map with one tile grid, and `cut_weeds`, `cut_grass`, `break_rock` and `chop_stump` publish no `location` at all. So
 * the day was `unjudged` by construction, and what she was asked to hold was a region the world never states (the
 * owner's rule: the perception layer publishes anchors, never a hard-coded east area).
 * </p>
 * <p>
 * WHAT THE FOUR RECEIPTS DO STATE is the opaque `target` id of the thing each one removed - `target=weed_01` on
 * `weeds_cut`, the same `target` on the `*_gone` settlements those actions answer with - so the honest purpose is a
 * COUNT: twenty separate pieces cleared, wherever they stood. No shape and no place, because neither is published.
 * </p>
 * <p>
 * THE JUDGE COUNTS DISTINCT TARGETS, NEVER RECEIPTS, and that is the rounds-96 rule applied to loot rather than to
 * ground: twenty receipts can name fifteen things (`weed_target_gone` answers the tile an earlier node already cut, and
 * `rock_source_gone` the stone an earlier swing removed), exactly as twenty hoe swings are not a plot. `clearedBy` states,
 * per action, the field that names the thing - beside the id, so a clearing action that names its target differently is a
 * declaration and not an assumption.
 * </p>
 */
const clearedPieces = (purpose, { atLeast, clearedBy }) => {
  if (!Number.isInteger(atLeast) || atLeast < 1) throw new Error("stardew_cleared_pieces_needs_its_count");
  if (!Array.isArray(clearedBy) || clearedBy.length === 0)
    throw new Error("stardew_cleared_pieces_needs_its_actions");
  return Object.freeze({
    purpose,
    pieces: Object.freeze({ atLeast }),
    clearedBy: Object.freeze(clearedBy),
  });
};

/** One action that removed something, and the evidence field that names the thing it removed. */
const targetProof = (actionId, targetField) => Object.freeze({ actionId, targetField });

/**
 * A purpose that is a COUNT OF TILES on one map, with no shape declared.
 *
 * <p>
 * `patch` asks for a rectangle; a farm's own plot need not be one, and `round96`'s was not - twenty tiles in a 7x3 block
 * missing a corner. So this declares the count and, beside it, the actions whose own postcondition names the tile it
 * changed and the evidence field that name is in, exactly as `patch` does and for the same reason. The judge counts
 * TILES and never receipts: twenty swings of the Hoe on ONE tile is not a plot, which is the difference between this and
 * a step list.
 * </p>
 * <p>
 * `boughtBy` is the half its name carries - seeds were BOUGHT - and it is an action list without a tile because a
 * purchase names a counter and a stack, not ground. `tilledBy` is NOT a demand here: it is the evidence that tells the
 * ground the day opened from the ground it inherited (`already_tilled`), and a plot whose sowing never needed the Hoe
 * passes without it.
 * </p>
 */
const plot = (purpose, { tiles, boughtBy, tilledBy, sownBy, wateredBy }) =>
  Object.freeze({
    purpose,
    plot: Object.freeze({ tiles }),
    boughtBy: Object.freeze(boughtBy),
    tilledBy: Object.freeze(tilledBy),
    sownBy: Object.freeze(sownBy),
    wateredBy: Object.freeze(wateredBy),
  });

/**
 * A purpose about WHERE the day's own facts happened: two receipt shapes that state a map, and a declared map set.
 *
 * <p>
 * `steps` cannot state this one. A step list matches ACTION IDS, and the purpose here is not "a receipt of `talk_to_npc`
 * came back" but "the words happened on a map the declaration answers as town" - a different question about the same
 * receipt, so the entry names the FIELD that carries the map beside the actions that carry it. The two shapes are not the
 * same field: a conversation publishes `location`, a door transition publishes `actual=<map>:x,y`, and a criterion that
 * read one field for both would read nothing.
 * </p>
 */
const townVisit = (purpose, { arrival, conversation }) =>
  Object.freeze({
    purpose,
    town: Object.freeze({
      arrival: Object.freeze({ actionIds: Object.freeze(arrival.actionIds), field: arrival.field }),
      conversation: Object.freeze({ actionIds: Object.freeze(conversation.actionIds), field: conversation.field }),
    }),
  });

/**
 * EVERY OCCUPANT THE MOD DECLARES A CLEARING ACTION FOR, and which action clears it.
 *
 * <p>
 * Read from the Mod's own `Clears(...)` declarations through the reader the clearing-vocabulary gate publishes
 * (`gates/stardew/audit-stardew-clearing-vocabulary.mjs`), the same one `tools/live-run/slices/patch-3x20.mjs` measures
 * the farm with - so a kind that gains or loses a clearer changes this criterion in the same edit, and no kind list is
 * written here to drift. A kind in the Mod's vocabulary with NO clearer appears in no row: nothing published removes it,
 * which is a fact about the tile and not a missing reading.
 * </p>
 */
const REPOSITORY_ROOT = new URL("../../", import.meta.url);

function readOccupantClearers() {
  const constants = constantsIn(readFileSync(new URL(SOURCES.vocabulary, REPOSITORY_ROOT), "utf8"));
  const cleared = clearedKinds(readFileSync(new URL(SOURCES.catalog, REPOSITORY_ROOT), "utf8"), constants);
  // A catalog that parsed to nothing would answer "no action clears anything", which silently excuses every occupied
  // tile in every strip - the direction that reads like a finished patch.
  if (cleared.size === 0) throw new Error("stardew_clearing_vocabulary_has_no_cleared_kinds");
  return cleared;
}

const OCCUPANT_CLEARERS = readOccupantClearers();

/**
 * The occupant kinds ONE DAY's declared actions can clear - the tiles that day was asked to open, and no others.
 *
 * <p>
 * WHY THE DAY'S OWN ACTIONS AND NOT THE WHOLE CATALOG. `round96` stands on the difference: `chop_tree` fells a tree, and
 * that task's own declaration (`SCENARIO_TASK_ACTION_HINTS.clear_and_plant_long_patch` in
 * `multiday-daily-tasks.mjs`) leaves `chop_tree` out on purpose - "a tile a tree stands on is not a tile you till". A
 * reader that asked the catalog instead would call the tree tile openable ground and demand it, which is the verdict
 * that run was filed under. A task that DOES declare `chop_tree` tomorrow becomes answerable to trees with no edit here.
 * </p>
 * <p>
 * A patch task with no declared actions is refused by name: with none, everything would read as "no action of this day
 * clears it" and the criterion would agree with any short day.
 * </p>
 */
function patchClearableKinds(taskId) {
  const actions = DAILY_TASK_ACTION_HINTS[taskId];
  if (!Array.isArray(actions) || actions.length === 0)
    throw new Error(`stardew_patch_task_declares_no_actions:${String(taskId)}`);
  const offered = new Set(actions);
  const kinds = new Set();
  for (const [kind, clearers] of OCCUPANT_CLEARERS)
    if (clearers.some((actionId) => offered.has(actionId))) kinds.add(kind);
  return kinds;
}

/** The Mod's own word for a tile the Hoe refused because something stands on it: `soil_not_diggable:occupied:tree`. */
const PATCH_OCCUPANT_REFUSAL = /^soil_not_diggable:occupied:(.+)$/u;

/**
 * The tiles of the day's rectangle the day was never asked for: a standing occupant no action IT declares clears.
 *
 * <p>
 * The fact comes from the REFUSAL, which is the only receipt that names a tile the day could not work: `till_soil`
 * answered `soil_not_diggable:occupied:tree` with `target=60,22`, so the tile AND the kind are the Mod's own statement
 * and neither is inferred here. An occupant the day's own actions CAN clear is deliberately not excluded - a weed left
 * standing in the strip is work it owes, and a criterion that excused it would grade nothing.
 * </p>
 * <p>
 * WHAT THIS DOES NOT READ: the refusal carries no `location` (its evidence is `target`, `diggable_tiles`,
 * `diggable_nearest`, `search_radius`), so an excluded tile is read against the strip each map's own admitted tiles
 * form. It can only ever shrink the denominator of a window that covers it, and the two strips a day proves on two maps
 * are already never added together (`patchTileFacts` groups by map).
 * </p>
 */
function patchExcludedTiles(entry, taskId, receipts) {
  const tillActionIds = new Set(entry.tilledBy.map((proof) => proof.actionId));
  const clearable = patchClearableKinds(taskId);
  const byTile = new Map();
  for (const receipt of receipts ?? []) {
    if (receipt === null || typeof receipt !== "object") continue;
    if (receipt.state === "succeeded") continue;
    if (!tillActionIds.has(receipt.actionId)) continue;
    const detail = receipt.evidence?.detail;
    if (typeof detail !== "string") continue;
    const match = PATCH_OCCUPANT_REFUSAL.exec(typeof receipt.reasonCode === "string" ? receipt.reasonCode : "");
    if (match === null) continue;
    const kind = match[1];
    if (clearable.has(kind)) continue;
    const tile = tileOf(evidenceFields(detail).get("target"));
    if (tile === null) continue;
    const key = tileKey(tile);
    if (!byTile.has(key)) byTile.set(key, Object.freeze({ tile, kind, reasonCode: receipt.reasonCode }));
  }
  return Object.freeze([...byTile.values()]);
}

/** The excluded tiles as the one reading a verdict prints: `excluded_by_occupant=tree@60,22,tree@62,23`. */
const describeExcludedTiles = (excluded) =>
  `excluded_by_occupant=${excluded.map((entry) => `${entry.kind}@${tileKey(entry.tile)}`).join(",")}`;
/**
 * THE ACTIONS WHOSE OWN POSTCONDITION IS ABOUT WHAT SHE IS CARRYING, and the direction each one proves.
 *
 * <p>
 * A purpose about her pack cannot be read FROM the pack. `inventoryItemFacts` publishes it - 36 rows of slot, item and
 * stack - but on the OBSERVATION (`integrations/stardew/farmhandexecutioncontroller.targetdiscovery.cs`,
 * `DiscoverInventoryItemFacts`), and this judge reads RECEIPTS. Measured `round85`: `sweep_carried_things` answered
 * `unjudged` for a day that had already shipped an item and put a seed in the ground, because its criterion asked for a
 * backpack before/after that no receipt carries - undecidable BY CONSTRUCTION rather than unproduced. What a receipt does
 * prove is that a carried stack was spent to do something, and that is the act the day's own prompt asks for.
 * </p>
 * <p>
 * ONE DECLARATION, NOT A LIST INSIDE THE CRITERION. `spends` is the direction the action's own completion rule proves:
 * `true` when its receipt requires the count of the item it names to FALL (the seed that went into the ground, the post
 * that left the pack, the geode that was opened), `false` when it requires that count to RISE (a forage picked up, a crop
 * harvested). The gate `a_new_action_that_proves_a_pack_count_is_declared` derives its population from the published
 * action surface crossed with the Host's completion contract - every action whose receipt can carry a pack count - and
 * fails naming any such action with no row here.
 * </p>
 * <p>
 * FIVE ROWS PUBLISH NO COUNT AT ALL, and no artifact could derive them: `use_item` eats a carried food, `open_geode`
 * spends a carried geode, `use_warp_item` spends the warp item, and the two tailoring actions spend the material and the
 * dye they name by slot. Their evidence names a slot and not a before/after pair, so they are declared with the reason -
 * and the gate refuses a row outside its derived population that claims the pack went UP, because nothing would prove it.
 * </p>
 */
export const CARRIED_ITEM_ACTIONS = Object.freeze({
  // A pack count falls: the stack named by the receipt is spent to do the thing.
  bait_crab_pot: Object.freeze({ spends: true, because: "the bait leaves the pack into the pot" }),
  dye_clothing_with_item: Object.freeze({
    spends: true,
    because: "the dye items the receipt names are spent on the garment",
  }),
  fertilize_tile: Object.freeze({ spends: true, because: "the fertilizer stack leaves the pack onto the soil" }),
  open_geode: Object.freeze({
    spends: true,
    because: "the geode leaves the pack and the counter hands back what was inside",
  }),
  place_crab_pot: Object.freeze({ spends: true, because: "the pot leaves the pack onto the water's edge" }),
  place_owned_object: Object.freeze({ spends: true, because: "the stack leaves the pack onto the ground" }),
  place_wood_fence: Object.freeze({ spends: true, because: "the fence leaves the pack onto the field" }),
  plant_sapling: Object.freeze({ spends: true, because: "the sapling leaves the pack into the ground" }),
  plant_seed: Object.freeze({ spends: true, because: "the seed stack leaves the pack into the soil" }),
  redeem_prize_ticket: Object.freeze({ spends: true, because: "the prize ticket leaves the pack into the machine" }),
  ship_item: Object.freeze({
    spends: true,
    because: "the stack leaves the pack into the shipping bin, which is how a farmhand sells",
  }),
  tailor_clothing: Object.freeze({ spends: true, because: "the cloth the receipt names is spent on the garment" }),
  use_item: Object.freeze({ spends: true, because: "the food the actor was carrying is eaten" }),
  use_warp_item: Object.freeze({ spends: true, because: "the warp item is spent by arriving" }),
  // A pack count rises: the receipt proves something entered the pack.
  chest_retrieve: Object.freeze({ spends: false, because: "the chest hands the stack back into the pack" }),
  claim_mail_attachment: Object.freeze({ spends: false, because: "the letter's contents arrive in the pack" }),
  claim_museum_reward: Object.freeze({ spends: false, because: "the museum's reward arrives in the pack" }),
  collect_animal_product: Object.freeze({ spends: false, because: "the product arrives in the pack" }),
  collect_crab_pot_output: Object.freeze({ spends: false, because: "the pot's catch arrives in the pack" }),
  cook_recipe: Object.freeze({
    spends: false,
    because:
      "the dish arrives in the pack; what its ingredients cost is published beside it as the materials' own rule",
  }),
  fish_here: Object.freeze({ spends: false, because: "the catch arrives in the pack" }),
  harvest_crop: Object.freeze({ spends: false, because: "the harvest arrives in the pack" }),
  move_placed_furniture: Object.freeze({
    spends: false,
    because: "the piece is picked UP off the floor into the pack",
  }),
  pan_ore: Object.freeze({ spends: false, because: "the ore arrives in the pack" }),
  pickup_forage: Object.freeze({ spends: false, because: "the forage arrives in the pack" }),
  pickup_item: Object.freeze({ spends: false, because: "the item arrives in the pack" }),
  take_pedestal_item: Object.freeze({ spends: false, because: "the pedestal hands its piece into the pack" }),
});

/** The declared actions a receipt can prove spent what she was carrying, in one spelling derived from the table above. */
export const CARRIED_ITEM_SPEND_ACTIONS = Object.freeze(
  Object.entries(CARRIED_ITEM_ACTIONS)
    .filter(([, row]) => row.spends === true)
    .map(([actionId]) => actionId),
);

/**
 * The USING half of the day, which is the same population one act short.
 *
 * `ship_item` is the sale the prompt names second, and it is a spend too - so it is its own step, and it cannot also
 * answer the using step: two shipments are two sales, not "used something and sold something". Derived by subtraction
 * rather than written again, so a sale that stops spending cannot drift from the criterion that names it twice.
 */
export const CARRIED_ITEM_USE_ACTIONS = Object.freeze(
  CARRIED_ITEM_SPEND_ACTIONS.filter((actionId) => actionId !== "ship_item"),
);

/**
 * The population of movement actions, read from the group the Mod's own registrations declare.
 *
 * <p>
 * Measured 2026-11-21 (`round88`, day 1, `a_fish_from_the_water`): three smallmouth bass came back - three `fish_here`
 * receipts, `fish_caught`, `location=Forest`, `tile=46,25` - and the criterion answered `not_achieved`, because its
 * waypoint half named `navigate_to_destination` and `travel` as the only ways to reach the water. That day's two
 * `navigate_to_destination` dispatches were both abandoned on a large bush (`navigation_approach_unavailable`,
 * `approach_blocked_by=large:Bush@49,10`); she walked there herself instead - `move_to_tile` to `40,64` and
 * `enter_exit` at `Farm:41,65 -> Forest:68,0` - and the row graded the route rather than the day.
 * </p>
 * <p>
 * SO THE POPULATION IS THE SURFACE'S, NOT A LIST HERE. `action-handler-groups.v1.json` is the generated statement of
 * which handler group each registration belongs to (`FarmhandActionHandlerGroup.Movement` in
 * `integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs`), written by
 * `integrations/stardew/action-development/src/action-source-projection-producer.mjs` and held to that source by the
 * surface's own drift gates; `handlerGroup: "movement"` is the Mod saying "this action moves her". A movement action
 * added tomorrow answers the waypoint half with no edit here, which is the point: the criterion is about being at
 * fishable water, never about which seam carried her.
 * </p>
 */
const ACTION_HANDLER_GROUPS = new URL(
  "../../integrations/stardew/action-development/contracts/generated/action-handler-groups.v1.json",
  import.meta.url,
);

/**
 * THE TWO MOVEMENTS WHOSE OWN RECEIPT NAMES NO PLACE SHE CAME TO REST, and what it carries instead.
 *
 * Declared rather than dropped quietly, for the reason every exemption in this tree is declared: an exclusion nobody
 * enumerates is a debt. `face_direction`'s `actor_facing_matches` evidence is `direction` and `moving`, and
 * `mount_transport`'s `horse_mounted` is `target`, `horse_id`, `mounted` and `mounting`
 * (`host/src/stardew-completion-contracts.ts`) - each proves an act of movement and no arrival, so neither can answer
 * "she went to the water".
 *
 * WHAT THE GATE CAN AND CANNOT READ: whether a receipt says where she ended is a sentence about one action's evidence,
 * so the gate does not re-derive it from a key name - `mount_transport`'s `target` names the horse rather than a tile, and
 * `ride_bus` names its stations `origin`/`destination`, so any key-name rule lands on the wrong side of both. The two
 * things it does hold are
 * the two it can: the criterion reads exactly the derived group minus these rows, and every row here is still an action
 * the surface groups as movement with a reason attached, so the exemption expires instead of outliving its subject.
 */
export const MOVEMENT_ACTIONS_WITHOUT_ARRIVAL = Object.freeze({
  face_direction: "turns her where she stands: `direction` and `moving`, no tile she arrived on",
  mount_transport: "puts her on the transport: `target`, `horse_id`, `mounted` and `mounting`, no tile she arrived on",
});

/**
 * Every action the Mod publishes as movement, the two above excepted.
 *
 * Fails closed on an artifact that declares no movement action, for the reason `readExecutionPopulation` in
 * `multiday-daily-tasks.mjs` does: an empty population would answer every fishing day with "no movement happened"
 * while looking like a reading.
 */
function readMovementActions() {
  const artifact = JSON.parse(readFileSync(ACTION_HANDLER_GROUPS, "utf8"));
  const movement = (artifact.actions ?? []).filter((row) => row.handlerGroup === "movement");
  if (movement.length === 0) throw new Error("stardew_action_handler_groups_have_no_movement_actions");
  return movement.map((row) => row.actionId).filter((actionId) => !(actionId in MOVEMENT_ACTIONS_WITHOUT_ARRIVAL));
}

const MOVEMENT_ACTIONS = Object.freeze(readMovementActions());

/**
 * WHICH MAPS ARE THE TOWN, which is a declaration THIS TREE HAS TO MAKE.
 *
 * <p>
 * THE ENGINE HAS NO SUCH GROUPING, and that is a reading of the engine rather than a shortcut: `StardewValley.Locations`
 * declares one class per map (`Town.cs`, `SeedShop.cs`, `ManorHouse.cs`, `LibraryMuseum.cs`, `JojaMart.cs`,
 * `CommunityCenter.cs`, `FishShop.cs`, `AnimalShop.cs`, `AdventureGuild.cs`, ...) and no membership set anywhere - `Town`
 * is the name of ONE map, not of a family. The only word the engine uses for a group of them is
 * `LocationData.MusicIsTownTheme` (`GameLocation.cs:3186`, read by `Game1.cs:4564`), and that is a music flag in the
 * location CONTENT data: it says whose music is the town theme, not which maps are the town, and content data is not in
 * this tree at all. So the set below is OURS, `TOWN_MAP_ANSWERS`, and every answer carries its own reason.
 * </p>
 * <p>
 * THE NAMES ARE THE ENGINE'S OWN, and they have to be: `talk_to_npc` publishes `location=<NameOrUniqueName>` and a door
 * transition publishes `actual=<NameOrUniqueName>:x,y`, so a receipt names a map the way the engine spells it and a set
 * written in any other spelling would decide nothing. THE POPULATION is the maps this product can say out loud
 * (`LOCATION_NAMES_ZH`, the table `位置:` renders from), which is the one place this tree writes map names down: every
 * one of them is answered here, in both directions, and a map added to that table tomorrow fails at import until it is
 * answered. Measured 2026-11-23 (`round98`, day 2 `town_visit`): she walked Farm -> BusStop -> Town, the receipt named
 * `Town`, and the day still answered `task_purpose_needs_an_unpublished_fact` - the only thing missing was this table.
 * </p>
 * <p>
 * A MAP OUTSIDE THE POPULATION IS ANSWERED BY NOTHING, and that is a fact the verdict prints rather than hides
 * (`townMapsUndeclared`): a conversation in a map no answer covers is not town here, and a reader is told which map it
 * was instead of being handed a quiet `not_achieved`. A town interior the spoken table gains tomorrow is answered in the
 * same edit that adds it, by construction.
 * </p>
 */
const inTown = (because) => Object.freeze({ inTown: true, because });
const outsideTown = (because) => Object.freeze({ inTown: false, because });

export const TOWN_MAP_ANSWERS = Object.freeze({
  // IN THE TOWN: Pelican Town's own map and the buildings that open off it.
  Town: inTown("the town map itself - its square, its streets and the doors every errand in it opens"),
  Saloon: inTown("the Stardrop Saloon stands on the town square, and its door is on that map"),
  SeedShop: inTown("Pierre's general store stands on the town square, with the family's rooms above it"),
  ManorHouse: inTown("Mayor Lewis's house is one of the town map's own doors"),
  ArchaeologyHouse: inTown("the museum and library stand on the town map's north side"),
  Blacksmith: inTown("Clint's smithy opens off the town square's east side"),
  Hospital: inTown("Harvey's clinic is the building on the town square's east side"),
  CommunityCenter: inTown("the community centre is the building north of the square"),
  JojaMart: inTown("Joja Mart stands on the town map's east side"),
  JoshHouse: inTown("Alex's house is on the town map, beside its river"),
  // NOT THE TOWN: the farm and its buildings, the roads out, and the places the roads lead to.
  Farm: outsideTown("the farm, which is the map the round wakes up on"),
  FarmHouse: outsideTown("the farmhouse, on the farm"),
  Greenhouse: outsideTown("the greenhouse, on the farm"),
  Cellar: outsideTown("the cellar, under the farmhouse"),
  Barn: outsideTown("a barn, on the farm"),
  BigBarn: outsideTown("a barn, on the farm"),
  DeluxeBarn: outsideTown("a barn, on the farm"),
  Coop: outsideTown("a coop, on the farm"),
  BigCoop: outsideTown("a coop, on the farm"),
  DeluxeCoop: outsideTown("a coop, on the farm"),
  Shed: outsideTown("a shed, on the farm"),
  Cabins: outsideTown("the cabins, on the farm"),
  BusStop: outsideTown("the stop at the end of the farm road: a stop on the way to town is not the town"),
  Backwoods: outsideTown("the backwoods between the farm and the mountain"),
  Mountain: outsideTown("the mountain, where the carpenter, the guild and the mine entrance are"),
  Forest: outsideTown("the forest south of the farm, whatever houses and shops open onto it"),
  Beach: outsideTown("the beach, where the fish shop stands"),
  Railroad: outsideTown("the railroad north of the mountain"),
  Desert: outsideTown("the desert, reached by bus"),
  Mine: outsideTown("the mine"),
  UndergroundMine: outsideTown("a mine level"),
  AnimalShop: outsideTown("Marnie's ranch in the forest"),
  FishShop: outsideTown("Willy's shop on the beach"),
  IslandWest: outsideTown("the island"),
  IslandEast: outsideTown("the island"),
  IslandSouth: outsideTown("the island"),
  IslandNorth: outsideTown("the island"),
  IslandFarmHouse: outsideTown("the island's farmhouse"),
});

/**
 * What crossing these answers with the map names the product can say finds: both directions, and a reason on every answer.
 *
 * Pure over its two inputs so the falsifier can hand it a vocabulary this repository does not have. An answer set that
 * declares no town at all is a finding too - a table that makes every map outside the town would agree with a criterion
 * that can never fire, which is the failure this table exists to remove.
 */
export function townMapFindings(answers, names) {
  const findings = [];
  const answered = answers ?? {};
  const named = new Set(names ?? []);
  for (const [map, answer] of Object.entries(answered)) {
    if (!named.has(map)) findings.push(`town_answer_for_a_map_the_product_does_not_name:${map}`);
    if (typeof answer?.because !== "string" || answer.because.trim().length === 0)
      findings.push(`town_answer_without_its_reason:${map}`);
  }
  for (const map of named) if (!Object.hasOwn(answered, map)) findings.push(`map_with_no_town_answer:${map}`);
  if (Object.values(answered).every((answer) => answer?.inTown !== true)) findings.push("town_answers_declare_no_town");
  return findings;
}

const TOWN_FINDINGS = townMapFindings(TOWN_MAP_ANSWERS, Object.keys(LOCATION_NAMES_ZH));
if (TOWN_FINDINGS.length > 0) throw new Error(`stardew_town_map_declaration_invalid:${TOWN_FINDINGS.join("|")}`);

/** The declared town, derived from the answers above: one spelling of the set, so a member cannot drift from its answer. */
export const TOWN_MAPS = Object.freeze(
  Object.entries(TOWN_MAP_ANSWERS)
    .filter(([, answer]) => answer.inTown)
    .map(([map]) => map),
);

const TOWN_MAP_SET = new Set(TOWN_MAPS);

/** Whether a receipt's map is one the declaration answers as town - the only membership test the criterion performs. */
export const inTownMap = (map) => typeof map === "string" && TOWN_MAP_SET.has(map);

/**
 * What each rotation task's purpose requires, keyed by the task ids in `multiday-daily-tasks.mjs`.
 *
 * Each criterion reads only postconditions the Mod already publishes and the Host already validates, and each one
 * requires at least two of them, so no single action's success can satisfy a task.
 */
export const TASK_PURPOSE_CRITERIA = Object.freeze({
  clear_ground_clutter: clearedPieces("twenty separate pieces of clutter were cleared off the ground", {
    atLeast: 20,
    // ALL FOUR ARE THE DAY'S OWN DECLARED ACTIONS (`DAILY_TASK_ACTION_HINTS.clear_ground_clutter`), and each names what it
    // removed in `target`. `clear_debris` is deliberately NOT among them: its receipt names the debris it cleared, and the
    // day's own declaration does not offer it, so adding it here would widen a criterion past the work it asks for.
    clearedBy: [
      targetProof("cut_weeds", "target"),
      targetProof("cut_grass", "target"),
      targetProof("break_rock", "target"),
      targetProof("chop_stump", "target"),
    ],
  }),
  // THE DAY AFTER A HARVEST DAY OWES THE GROUND, NOT THE HARVEST.
  //
  // Measured (`round89`, `.live-runs/game-ladder/2026-11-21T20-38-52-354Z-multiday_routine`, day 2): she bought fifteen
  // parsnip seeds at the SeedShop, sowed all fifteen into the plot the cauliflowers had left, watered all fifteen - and
  // the day answered `not_achieved`, because this row read `[harvest_crop, plant_seed]` and nothing was ripe. She had
  // brought in all three cauliflowers on DAY 1, to pay for copper, so the harvest half had already happened one day early
  // and the row graded a step the day could not have owed.
  //
  // THE WINDOW IS THE DAY, and that is what makes this a criterion fix rather than a run-window fix. `judgeTaskPurpose` is
  // handed the receipts ONE DAY's dispatches minted (`receiptsSince(factsBefore)` in the runner, for the day's verdict and
  // for its wake alike), so a harvest that happened yesterday is not a fact this verdict can see - and widening it to the
  // run would make `decideDayWake`'s `objectiveMet` true at her first watering, because the harvest was already banked.
  // Ending a day early is a wake defect, and this row is not allowed to buy one. So the harvest leaves the step list and
  // the purpose says what the day still owed: the ground a crop came off was replanted and watered.
  //
  // `plant_seed` STAYS A STEP, and not because the day is graded on the sowing alone: `taskSowsSeed`
  // (`tools/lib/seed-shortage.mjs`) reads this row to decide whether a planting day is handed its seed supply at all, so a
  // criterion that dropped the sowing would silently stop handing a `water_and_harvest` day its seeds. `harvest_crop`
  // stays in `DAILY_TASK_ACTION_HINTS`, where the day's own reach is declared: the harvest is still work such a day does,
  // it is just not the work that decides it. What that costs is written in the row's own `because`.
  water_and_harvest: criterion(
    "the ground a crop came off was replanted and watered",
    [step("plant_seed"), step("water_crop")],
    {
      because:
        "`plant_seed` refills the ground `harvest_crop` emptied and `water_crop` proves the tile it turned wet, so the " +
        "sowing has to come first - and NOTHING IS BROUGHT IN BY THIS ROW: a day that plants and waters and harvests " +
        "nothing passes, because the harvest such a day follows already happened in a day of its own. The cost of that, " +
        "written here so it is not discovered later: with the harvest gone the watering is the only half that can fail a " +
        "day which does its sowing, so an idle day is caught by the sowing and a dry one by the water. If that ever reads " +
        "as too weak, the answer is another step the day can actually owe in its own receipts - never the run window, " +
        "which would end the day at her first watering.",
    },
  ),
  forage_and_trees: criterion(
    "something was picked up and a tree was shaken",
    [step("pickup_forage"), step("shake_tree")],
    { ordered: false },
  ),
  craft_and_place_machine: criterion(
    "a machine was crafted, then put down, then put to work",
    [step("craft_item"), step("place_owned_object"), step("machine_load")],
    {
      because:
        "`place_owned_object` sets down the object `craft_item` produced, and `machine_load` fills that very machine - each later fact names an object the earlier one made",
    },
  ),
  // WAS A GAP, AND THE GAP EXPIRED THE WAY THE RULE SAYS A GAP SHOULD: BY PUBLISHING THE FACT, NOT BY WEAKENING THE
  // CRITERION. The entry asked for "the map the purchase happened on" and named the producer that would have to publish
  // it (`shop_purchase: (claim) =>`); measured `round92`
  // (`.live-runs/game-ladder/2026-11-22T09-12-45-412Z-multiday_routine`, day 3), two purchases succeeded at Pierre's
  // counter and the day answered `unjudged · task_purpose_needs_an_unpublished_fact` because `shop=SeedShop;owner_tile=4,17`
  // named a shop and a coordinate and never a map - `4,17` is a tile in that shop and a tile on the Farm.
  //
  // The receipt now carries `location` (the producer writes the map the body stood on, the same key `till_soil` and
  // `remove_placed_item` write) and the Host's `shop_purchase` row REQUIRES it, so an admitted purchase is a purchase
  // that names where it happened - which is what makes this purpose decidable from receipts. No step here reads the
  // observation, and no key was added to accommodate the criterion.
  //
  // UNORDERED, because the post is collected whenever she is home and buying has no need to come first: the two receipts
  // are one purchase and one collection, and either order is a day that did its errand. IT STILL DOES NOT TEST
  // TOWN-NESS: the declaration below answers which maps are the town, and this row is decided by the two receipts alone -
  // a purchase at a counter outside the valley floor is a purchase, and tightening this row is a separate decision.
  town_market: criterion(
    "something was bought in town and the post was brought in",
    [step("shop_purchase"), step("claim_mail_attachment")],
    { ordered: false },
  ),
  // WAS THE LAST GAP IN THE TABLE, AND THE GAP EXPIRED BY DECLARING THE FACT, NOT BY REMOVING THE SENTENCE. `talk_to_npc`
  // has published the map since it existed (`talk_to_npc_talked`'s evidence carries `location=<NameOrUniqueName>`), and a
  // door transition has published the map it arrived on (`actual=<NameOrUniqueName>:x,y`), so the receipts were never the
  // missing half; the missing half was a DECLARATION of which maps count as the town, which is now `TOWN_MAP_ANSWERS`
  // above. Measured 2026-11-23 (`round98`, day 2): she walked Farm -> BusStop -> Town, the `enter_exit` into `Town` was
  // published, and the day answered `task_purpose_needs_an_unpublished_fact` for want of a table - a whole day measured
  // nothing. What the criterion reads now is those two receipts and nothing else: not her own account of the trip, and not
  // the snapshot's `location`, which is where she stands and not where the words happened.
  //
  // TWO RECEIPTS, NOT ONE, because the day's own prompt asks for both halves (「去一趟镇上，找个人说说话」): a day that
  // stays on the farm and a day that walks to town and speaks to nobody are different days, and both miss the purpose.
  // ORDERED, and the order is a cause: the arrival is how she got there, so a conversation that precedes every arrival in
  // town is a conversation somewhere else in a run that happened to visit town afterwards. Each shape is declared with the
  // field it reads, and the population of shapes is the two below - the door and the walk, which is how every run so far has
  // got there. FOUR OTHER TRANSITIONS ALSO PUBLISH AN ARRIVAL AND ARE NOT READ: `ride_minecart`, `use_obelisk` and
  // `use_warp_item` write the same `actual=<map>:x,y` this row parses, and `ride_bus` names its stations
  // `origin`/`destination`. WHAT THIS ROW CANNOT SAY is that none of them lands in a declared town map - the minecart
  // stations come from content data (`DiscoverMinecartTargets` reads `Data/Minecarts`), which is not in this tree - so an
  // arrival by station is the shape to add here, and the receipt that would ask for it is
  // `ride_minecart ... actual=<a declared town map>:x,y`.
  town_visit: townVisit("a conversation happened in town, after she went there", {
    arrival: { actionIds: ["travel", "enter_exit"], field: "actual" },
    conversation: { actionIds: ["talk_to_npc"], field: "location" },
  }),
  mine_delve: criterion(
    "a mine level was entered and something was broken after it",
    [step("enter_mine"), anyOf("break_rock", "break_container")],
    {
      because:
        "the purpose is something broken INSIDE a mine, so `enter_mine` has to come first - a `break_rock` on the surface is the run this table exists for",
    },
  ),
  store_and_sort: criterion(
    "something was put into a chest and taken back out",
    [step("chest_store"), step("chest_retrieve")],
    {
      because:
        "`chest_retrieve` can only take out of a chest what `chest_store` put in it: the two receipts are one chest's contents before and after",
    },
  ),
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
  dress_and_display: criterion(
    "something else was put on and the house was given a display",
    [step("equip_wearable"), anyOf("dress_mannequin", "set_sign_display")],
    {
      because:
        "`dress_mannequin` and `set_sign_display` both display what she is wearing or holding, so `equip_wearable` has to come first for the display to be of THAT thing",
    },
  ),
  // THE ONE CRITERION THAT COUNTS TILES IN A SHAPE, and the only one that asks for a SHAPE rather than naming actions: a
  // purpose made of steps is satisfied by one receipt per step, and "tilled, then planted, then watered" is three
  // steps a single tile answers in three dispatches. The clearing day cannot prove a shape at all - its receipts name an
  // opaque target and no tile (`clear_ground_clutter` above) - so it asks for a COUNT, and this entry asks for the shape
  // nothing else measures: sixty tiles, all tilled, all carrying a crop, inside a 3x20 strip - a plot longer than the
  // 13x13 window one snapshot sees, so the boundary has to survive her walking out of view.
  //
  // "SIXTY" IS THE RECTANGLE, NOT A COUNT OF GROUND: a tile a tree stands on is a tile this strip is not made of
  // (`PATCH_OCCUPANT_REFUSAL` above, measured `round96`), so the denominator is the tiles of that rectangle the day's
  // own declared actions could make ready - sixty on open ground, fifty-eight when two trees are in the way.
  clear_and_plant_long_patch: patch(
    "one long strip, three tiles wide and twenty long, was tilled and sown the whole way",
    {
      width: 3,
      height: 20,
      // `till_soil` proves the HoeDirt at the tile it turned (`before=none;after=HoeDirt`) and names that tile as its
      // `target`; `plant_seed` and `water_crop` each name the `tile` the crop is on. No other action a real patch day
      // uses - `cut_weeds`, `break_rock`, `clear_debris` - publishes a tile, which is why clearing cannot prove a
      // shape and only the tilling and sowing can.
      tilledBy: [tileProof("till_soil", "target")],
      croppedBy: [tileProof("plant_seed", "tile"), tileProof("water_crop", "tile")],
    },
  ),
  // TWENTY TILES AND NO SHAPE, WHICH IS WHAT A PLOT IS. It used to be a step list - `shop_purchase`, then twenty
  // `till_soil`, twenty `plant_seed`, twenty `water_crop` - and a step list counts RECEIPTS on whatever tile each one
  // landed on, which is a count of swings and not of ground. `round96` is the measurement: twenty tiles sowed and
  // watered, five of them turned by the day's own Hoe, and the criterion answered `till_soil 5/20` about a plot that
  // was laid. The twenty tiles were there; the twenty TILLINGS were not owed, because the ground she sowed into was
  // already tilled (the Hoe proves it, `plant_seed` only succeeds on soil). So the plot is the tiles that carry a sowing
  // AND a watering at the end of the day, the purchase is what bought the seed, and how much of the ground she had to
  // open herself travels in the reading as `already_tilled` rather than as a passing grade.
  //
  // THE NAME SURVIVES THE READING: "expand" is the PLOT's arrival - twenty tiles that were not under crop now are -
  // and it cannot mean "ground the Hoe had never touched", because that is a verb, and a criterion that graded it
  // would file a farmhand who sows into yesterday's tilth as idle (the same defect `round76` fixed for
  // `clear_and_plant_long_patch`).
  buy_seeds_and_expand_plot: plot(
    "seeds were bought from a shop and a twenty-tile plot was tilled, planted, and watered",
    {
      tiles: 20,
      boughtBy: ["shop_purchase"],
      tilledBy: [tileProof("till_soil", "target")],
      sownBy: [tileProof("plant_seed", "tile")],
      wateredBy: [tileProof("water_crop", "tile")],
    },
  ),
  // Two steps, because the purpose is not "an action succeeded": it is that she went to water and came back with a
  // fish. The waypoint half is EVERY movement the surface publishes (`MOVEMENT_ACTIONS`), not the one seam a particular
  // day happens to use - `round88` is the measurement: she caught three fish after walking there, and a criterion that
  // named `navigate_to_destination`/`travel` alone reported the two abandoned navigations instead of the day.
  a_fish_from_the_water: criterion(
    "she went to the water and came back with a fish",
    [anyOf(...MOVEMENT_ACTIONS), step("fish_here")],
    {
      because:
        "`fish_here` casts where she stands, so the movement receipt has to come first - whether she walked there with `move_to_tile`, stepped through a door with `enter_exit`, rode or warped; a movement after the cast is another trip",
    },
  ),
  home_and_hearth: gap(
    "the house was tidied and a few things put out so it feels lived in",
    "what is absent is an ACTION with a postcondition for tidying, not a published fact: `place_owned_object`'s receipt carries `location` and the object it set down, and the snapshot publishes the room's own furniture as `kind: \"placed_furniture\"` rows carrying `location`, `displayName`, the tile and the footprint (`integrations/stardew/farmhandexecutioncontroller.worldobjectactions.cs`, measured round57: the bed and the oak table reached her as rows), so what the room holds IS readable. 'Tidy it up' still names no action whose postcondition is the room tidied or the clutter gone.",
    {
      reason: "prose",
      fact: unpublishedFact("an action whose postcondition is the room tidied"),
      claims: [
        presentEvidenceField("place_owned_object", "location"),
        proseReason(
          "an action whose declared postcondition names the room being tidied would refute this: the population is the catalog rows of `integrations/stardew/action-development/contracts/generated/action-surface.v1.json`, and no row's postcondition names a room or its contents",
        ),
      ],
    },
  ),
  home_upgrade: gap(
    "the carpenter was asked about extending the house",
    "the gap is an ACTION, not a receipt: the only carpenter-class action the catalog publishes is `build_farm_building`, which its own definition registers `Synthetic: true` and describes as the BUILD branch alone - 'demolish, move and paint are separate world changes and are deferred' (`integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs`) - and its postcondition is `farm_building_built`, a new structure on the farm rather than a bigger house. The house upgrade is an answer inside the carpenter's own dialogue, and that branch (`GameLocation.answerDialogueAction`) mints no world fact an action could report.",
    {
      reason: "prose",
      fact: unpublishedFact("the carpenter's answer that offered the house upgrade"),
      claims: [
        actionPostcondition("build_farm_building", "farm_building_built"),
        proseReason(
          "an action whose declared postcondition names the farmhouse upgrade would refute this: the population is the catalog rows of `integrations/stardew/action-development/contracts/generated/action-surface.v1.json`, and no row's postcondition names a house or an upgrade",
        ),
      ],
    },
  ),
  // WAS A GAP, AND THE GAP EXPIRED. It said the exit half `use_mine_ladder` was registered
  // `FarmhandActionLifecycle.Experimental` at a named line of `FarmhandActionDefinitions.cs`, so "the action is not
  // published, so no run can dispatch it and no receipt can prove a ladder was taken". The action is `LiveVerified` and
  // has been since it gained `run-stardew-native-local-player-use-mine-ladder-smoke.mjs`, a gate row in
  // `stardew-action-gate-descriptors.mjs`, a fixture scenario, and `check-stardew-promotion-parity` in
  // `harness-conformance.mjs` - and the line the reason cited now holds a different declaration, which is why the entry
  // went on reading as true. Both halves are published facts today: `enter_mine`'s `mine_entered` terminal names the
  // level it entered, and `use_mine_ladder`'s `mine_left` terminal names the ladder and the level it left
  // (`from`, `question=ExitMine`, `response=Leave`, `ladder`), so the purpose is decided by two receipts in the order the
  // world saw them.
  mine_ladder_to_depth: criterion(
    "a mine level was worked deeper and then left by its own exit ladder",
    [step("enter_mine"), step("use_mine_ladder")],
    {
      because:
        "`use_mine_ladder` leaves the level `enter_mine` entered - a ladder taken with no level entered is not a depth worked",
    },
  ),
  furnish_and_arrange: gap(
    "placed furniture was moved and something was recoloured",
    "`move_placed_furniture` is live and its receipt proves the piece LEFT a tile (`location`, `tile`, `carried_tile`, `removed_from_furniture`, `carried`, `inventory_before`/`inventory_after`), but its own postcondition is `placed_furniture_picked_up` and nothing in it - nor in `place_owned_object`, whose receipt names only the tile a stack landed on - says which tile the SAME piece came to rest on (`integrations/stardew/farmhandexecutioncontroller.worldobjectactions.cs`). So 'the furniture was moved' (one piece, two places) is not a fact any receipt states, and `color_placed_object` alone is one action rather than the arrangement.",
    {
      reason: "prose",
      fact: unpublishedFact(
        "the tile the same furniture piece came to rest on",
        producerAt(
          "integrations/stardew/farmhandexecutioncontroller.worldobjectactions.cs",
          "place_owned_object_postcondition_unavailable",
        ),
      ),
      claims: [
        actionLifecycle("move_placed_furniture", "live_verified"),
        actionPostcondition("move_placed_furniture", "placed_furniture_picked_up"),
        proseReason(
          "a receipt that names both the tile a piece left and the tile the same piece landed on would refute this: `move_placed_furniture` reports only where it took the piece from, and `place_owned_object` only where a stack went down",
        ),
      ],
    },
  ),
  run_the_machines: criterion(
    "a machine was loaded and its output collected",
    [step("machine_load"), step("machine_collect_output")],
    {
      because:
        "`machine_collect_output` collects what `machine_load` put in it, and a machine loaded after the collect had nothing to give",
    },
  ),
  // The sweep tasks, each of whose purpose is "this group of the farm was worked". No receipt names a group - one
  // receipt names one action and one target - so a sweep day is a GAP unless its purpose can be restated as facts the
  // receipts do publish. `sweep_carried_things` is that case, and its criterion is declared below this spread: an
  // explicit entry placed after it wins, which is why the two halves stay one declaration and the group's own sentence
  // in `multiday-daily-tasks.mjs` is gone rather than kept as a second, false spelling.
  ...Object.fromEntries(
    SWEEP_DAILY_TASKS.filter((task) => typeof task.missingFact === "string").map((task) => [
      task.id,
      gap(task.purpose, task.missingFact, {
        reason: "prose",
        // The fact is the GROUP, and no producer names one: the grouping is this repository's own declaration
        // (`SWEEP_GROUPS`), while every receipt names one action and one target. `null` is that reading, not a shrug.
        fact: unpublishedFact("a fact naming the group of work rather than one action and one target"),
        claims: [
          proseReason(
            "a published fact that names a GROUP of actions rather than one action and one target would refute this: every receipt names one action and one target (`host/src/stardew-completion-contracts.ts`), and the grouping is this repository's own declaration (`SWEEP_GROUPS` in `tools/lib/multiday-daily-tasks.mjs`)",
          ),
        ],
      }),
    ]),
  ),
  // THE SWEEP DAY THAT IS NOT A GAP, and it is not a gap because its purpose was never about a GROUP: it is about what
  // she was carrying, and the two acts its prompt names - "能用的用掉、该卖的卖掉" - are each one receipt. It used to be a
  // gap for asking the pack's before and after, a fact `inventoryItemFacts` publishes on the OBSERVATION while this judge
  // reads receipts, so the day was undecidable by construction rather than unproduced (`round85` answered `unjudged` for a
  // day that had already shipped an item and sown a seed). Unordered: using something and selling something have no order
  // the world imposes, and the two steps still have to be two receipts.
  sweep_carried_things: criterion(
    "something she was carrying was used up, and something she was carrying was sold",
    [anyOf(...CARRIED_ITEM_USE_ACTIONS), step("ship_item")],
    { ordered: false },
  ),
});

/**
 * Whether a task's own purpose is decided by facts the product publishes.
 *
 * ONE SPELLING OF "THIS DAY IS A GAP": the `gap(...)` entry is the one that carries `missingFact` and no steps, and that
 * is the same declaration `judgeTaskPurpose` branches on - so a schedule, its gate and the judge cannot disagree about
 * which of a run's days the evidence can decide. A task with no entry at all is not decidable either: nothing says what
 * would have been accomplished for it, which is a reporting gap and not a purpose.
 */
export function judgesAPublishedFact(taskId) {
  const entry = TASK_PURPOSE_CRITERIA[taskId];
  return entry !== undefined && entry.missingFact === undefined;
}

/**
 * WHAT A RUN'S DAYS WERE, AND HOW MANY OF THEM THE EVIDENCE CAN DECIDE.
 *
 * <p>
 * A run's days can each be scheduled and delivered and still leave the run unable to say whether anything was achieved.
 * Measured on `round84`: `state: blocked`, `reason task_purposes_nothing_judged:3of3` - day 1 `sweep_animals_and_company`,
 * day 2 `sweep_carried_things`, day 3 `clear_east_patch`, three criteria whose facts nothing publishes - while
 * `violations 0`, `crossings 2 of 2` and every night's lifecycle agreed with the world. Nothing was wrong with the days
 * and the run could not say whether anything was achieved, because the ROTATION had scheduled nothing judgeable and no
 * reading said so: `readTaskDelivery` names the tasks, and the purpose line counts verdicts after the fact, so `J === 0`
 * first appeared as a blocked run.
 * </p>
 * <p>
 * `reading` is that line, and it names the gap days rather than counting them: `days 3 · judgedable 2 · gap 1
 * (day1=sweep_animals_and_company)`. A rotation that picks three gaps is not bad luck, it is a pool where the days
 * nothing can judge are over-represented - and a reader has to be able to see which ones it chose.
 * </p>
 */
export function readScheduledJudgement(scheduled = []) {
  const days = [];
  for (const entry of scheduled) {
    const task = entry?.task;
    if (typeof task !== "string" || task.length === 0) continue;
    days.push(
      Object.freeze({
        day: Number.isInteger(entry.day) ? entry.day : days.length + 1,
        task,
        judgeable: judgesAPublishedFact(task),
      }),
    );
  }
  const judged = days.filter((entry) => entry.judgeable);
  const gaps = days.filter((entry) => !entry.judgeable);
  const chosen = gaps.map((entry) => `day${String(entry.day)}=${entry.task}`).join(", ");
  return Object.freeze({
    days: days.length,
    judgeable: judged.length,
    gap: gaps.length,
    gapDays: Object.freeze(gaps),
    reading:
      `days ${String(days.length)} · judgedable ${String(judged.length)} · gap ${String(gaps.length)} ` +
      `(${gaps.length === 0 ? "none" : chosen})`,
  });
}

/**
 * The admitted evidence a purpose may read: one entry per receipt that is BOTH a success state AND its own
 * action's postcondition, as the Host decides that question.
 *
 * THREE ANSWERS, NOT TWO. A `succeeded` receipt is admitted, unfinished or refused, and the difference between the last
 * two is the difference between "the action did what one dispatch does and the postcondition is further on" and "this
 * receipt proves nothing at all". The Host is the one that decides which, and it says so in its own words
 * (`before_its_postcondition:<reasonCode>`, `host/src/stardew-completion-contracts.ts`); this module does not re-decide
 * it.
 *
 * WHY THE THIRD LIST EXISTS. Measured 2026-11-22 (`round90`, day 1 `mine_delve`): four `break_rock` receipts came back
 * `succeeded` with `removed=false;durability_after=1` - one hit of two on a stone that was still standing - and this
 * module filed all four as `succeeded_receipt_without_its_own_postcondition`, which reads as "the Host cannot read
 * this" about receipts it reads in full. One label for three facts teaches the next reader that four honest swings were
 * a contract hole. The reading a caller gets is `succeeded_before_its_postcondition:<actionId>:<warrant>`, and it blocks
 * nothing: the swing landed, and the purpose that wants the stone gone simply has not got there yet.
 *
 * The admitted entry keeps the receipt it admitted, so a criterion about tiles reads the SAME evidence the Host just
 * validated instead of re-deciding admission: one authority per fact, even when the fact is "this receipt proves a
 * tile".
 */
export function purposeReceipts(receipts) {
  const admitted = [];
  const unfinished = [];
  const refused = [];
  for (const receipt of receipts ?? []) {
    if (receipt === null || typeof receipt !== "object") continue;
    const actionId = receipt.actionId;
    if (typeof actionId !== "string" || actionId.length === 0) continue;
    // Only a success state is a candidate. A failure or an in-flight state is not evidence of anything, and it is
    // not "refused" either - there is nothing to refuse.
    if (receipt.state !== "succeeded") continue;
    const verdict = judgeStardewCompletionEvidence(actionId, {
      state: receipt.state,
      reasonCode: typeof receipt.reasonCode === "string" ? receipt.reasonCode : "",
      evidence: receipt.evidence,
    });
    if (verdict.accepted === true) {
      admitted.push(Object.freeze({ actionId, receipt }));
      continue;
    }
    const BEFORE_ITS_POSTCONDITION = "before_its_postcondition:";
    if (typeof verdict.refusal === "string" && verdict.refusal.startsWith(BEFORE_ITS_POSTCONDITION)) {
      unfinished.push(
        Object.freeze({
          actionId,
          reasonCode: "succeeded_before_its_postcondition",
          warrant: verdict.refusal.slice(BEFORE_ITS_POSTCONDITION.length),
        }),
      );
      continue;
    }
    refused.push(Object.freeze({ actionId, reasonCode: "succeeded_receipt_without_its_own_postcondition" }));
  }
  return Object.freeze({
    admitted: Object.freeze(admitted),
    unfinished: Object.freeze(unfinished),
    refused: Object.freeze(refused),
  });
}

/** The first receipt, at or after `from`, that satisfies this step without reusing an already-consumed one. */
function matchingIndexIn(admitted, used, from, candidate) {
  const actionIds = candidate.actionId === undefined ? candidate.anyOf : [candidate.actionId];
  for (let index = from; index < admitted.length; index += 1) {
    if (!used.has(index) && actionIds.includes(admitted[index].actionId)) return index;
  }
  return -1;
}

/** The action ids a criterion's steps read: one per step, or the set a step offers as alternatives. */
function criterionActionIdsOf(entry) {
  const actionIds = new Set();
  for (const candidate of entry.steps ?? [])
    for (const actionId of candidate.actionId === undefined ? candidate.anyOf : [candidate.actionId])
      actionIds.add(actionId);
  return actionIds;
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
    const needed = candidate.count ?? 1;
    for (let hit = 0; hit < needed; hit += 1) {
      const index = matchingIndexIn(admitted, used, entry.ordered === false ? 0 : cursor + 1, candidate);
      if (index < 0) return false;
      used.add(index);
      cursor = index;
    }
  }
  return true;
}

/** Per-step matched counts for quantified criteria so shortfall verdicts report how far each step got. */
function quantifiedProgressDetail(entry, admitted) {
  if (!(entry.steps ?? []).some((candidate) => (candidate.count ?? 1) > 1)) return undefined;
  const used = new Set();
  const parts = [];
  for (const candidate of entry.steps) {
    const needed = candidate.count ?? 1;
    const label = candidate.actionId ?? candidate.anyOf.join("/");
    let matched = 0;
    for (let hit = 0; hit < needed; hit += 1) {
      const index = matchingIndexIn(admitted, used, 0, candidate);
      if (index < 0) break;
      used.add(index);
      matched += 1;
    }
    parts.push(`${label} ${String(matched)}/${String(needed)}`);
  }
  return parts.join(" · ");
}

/**
 * The fields of the Mod's evidence literal, as the producer wrote them.
 *
 * A lenient reader on purpose: this parses what admission ALREADY accepted, so a field it cannot read costs a tile
 * rather than a verdict - and a criterion that loses a tile reports `unproven` or a smaller count, never an
 * achievement it did not see.
 */
function evidenceFields(detail) {
  const fields = new Map();
  for (const part of detail.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const field = part.slice(0, separator);
    if (!fields.has(field)) fields.set(field, part.slice(separator + 1));
  }
  return fields;
}

/** A tile the way the Mod spells one - `x,y`, both within the map's coordinate bound - or null. */
function tileOf(value) {
  const match = /^(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/u.exec(typeof value === "string" ? value : "");
  if (match === null) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return x <= 1000 && y <= 1000 ? Object.freeze({ x, y }) : null;
}

const tileKey = (tile) => `${String(tile.x)},${String(tile.y)}`;

/**
 * The seed a receipt put in the ground, or null when it put none there.
 *
 * ONE SPELLING OF "THIS TILE WAS SOWN": an action the entry declares as a SOWING (`sownBy` on a plot, the crop proofs
 * of a patch) that also names the `item` it spent. `plant_seed`'s postcondition carries `item`, `inventory_before` and
 * `inventory_after`; a `water_crop` carries the water it spent and no seed, so it proves a crop without proving a
 * sowing. Adding a second declaration of which actions sow would be the same fact written twice, and the two copies
 * would drift.
 */
const sowingProofsOf = (entry) => entry.sownBy ?? entry.croppedBy;

function sownSeed(entry, actionId, fields) {
  if (!sowingProofsOf(entry).some((proof) => proof.actionId === actionId)) return null;
  const item = fields.get("item");
  return typeof item === "string" && item.length > 0 ? item : null;
}

/**
 * The tiles the run proved, grouped by the map they are on.
 *
 * Two sources, and they are not the same kind of fact. A receipt proves what IT changed, and the tile it names is
 * part of that action's own postcondition, so the coordinate is exactly as trustworthy as the receipt. An observed
 * row is what the companion could see at one moment, and it is read as it describes itself: a `cropTargets` row is a
 * crop, while a `soilTiles` row counts as tilled ONLY when the row's own `hoeDirt` says so - the Mod's
 * `DiscoverSoilTiles` skips every tile that already has HoeDirt, because the family is the `till_soil` target list,
 * and counting those rows as tilled would let untilled ground be reported as a finished plot.
 *
 * `sown` is the subset of `cropped` that a receipt proved by naming the seed it spent (`sownSeed`). It exists because
 * "a crop is on this tile" and "a seed went into this tile" answer differently: a day that waters the crops of an
 * earlier week proves forty crops and sows none, and a verdict that called those forty "sown" would report a patch
 * day she never planted.
 *
 * AND A TILE A SOWING NAMED IS TILLED GROUND. `plant_seed` succeeded ON that tile, and the one place a seed goes is
 * tilled soil, so the receipt that proves the seed also proves the ground under it - whether this day's Hoe turned it or
 * a day before did. The rule is the header's: the strip's state at the end of the day, never the swings that got it
 * there. One observation can still contradict it, and only one: a `soilTiles` row whose own `hoeDirt` is `false` says
 * the Hoe can turn that tile NOW, and a receipt and an observation that disagree are not a strip laid. That is why the
 * contradiction is read before the inference and kept per map.
 */
const mapOf = (location) =>
  typeof location === "string" && location.length > 0 && location !== "none" ? location : null;

function patchTileFacts(entry, admitted, observations) {
  const byLocation = new Map();
  const factsFor = (location) => {
    const existing = byLocation.get(location);
    if (existing !== undefined) return existing;
    const created = { tilled: new Map(), cropped: new Map(), sown: new Map(), untilled: new Set() };
    byLocation.set(location, created);
    return created;
  };
  for (const admittedReceipt of admitted) {
    const proofs = [...entry.tilledBy, ...entry.croppedBy].filter(
      (proof) => proof.actionId === admittedReceipt.actionId,
    );
    const detail = admittedReceipt.receipt?.evidence?.detail;
    if (proofs.length === 0 || typeof detail !== "string") continue;
    const fields = evidenceFields(detail);
    const location = mapOf(fields.get("location"));
    const tile = tileOf(fields.get(proofs[0].tileField));
    if (location === null || tile === null) continue;
    const facts = factsFor(location);
    for (const proof of proofs) {
      if (entry.tilledBy.includes(proof)) {
        facts.tilled.set(tileKey(tile), tile);
        continue;
      }
      facts.cropped.set(tileKey(tile), tile);
      if (sownSeed(entry, admittedReceipt.actionId, fields) !== null) facts.sown.set(tileKey(tile), tile);
    }
  }
  const observedOn = mapOf(observations?.location);
  if (observedOn !== null) {
    const facts = factsFor(observedOn);
    for (const row of observations?.soilTiles ?? []) {
      const tile = tileOf(`${String(row?.x)},${String(row?.y)}`);
      if (tile === null) continue;
      if (row?.hoeDirt === true) facts.tilled.set(tileKey(tile), tile);
      else if (row?.hoeDirt === false) facts.untilled.add(tileKey(tile));
    }
    for (const row of observations?.cropTargets ?? []) {
      const tile = tileOf(`${String(row?.x)},${String(row?.y)}`);
      if (tile !== null) facts.cropped.set(tileKey(tile), tile);
    }
  }
  for (const facts of byLocation.values()) {
    // THE GROUND THE DAY HOLDS, which is the state the strip is judged on: a tile the day's Hoe named, plus a tile a
    // sowing proved and no observation contradicted. `tilled` stays what the Hoe named, so `tilled 20` in a verdict still
    // means twenty swings or settlements and never twenty plus whatever she sowed into.
    facts.ground = new Map(facts.tilled);
    for (const [key, tile] of facts.sown) if (!facts.untilled.has(key)) facts.ground.set(key, tile);
  }
  return byLocation;
}

/**
 * What one map's proven tiles say about the declared patch.
 *
 * `holdsAll` is the line between the two failures that must not read alike: a set of tiles that fits inside one
 * declared window is a patch that is not finished yet, and a set that fits inside none of them is a different shape
 * however many tiles it holds.
 *
 * `excludedTiles` is the denominator's other half: the tiles inside that same window the day was never asked for
 * (`patchExcludedTiles`), so `tileCount === availableTiles` is a finished patch and `tileCount === area` is a finished
 * patch with nothing standing in it. A tile the day DID work is never also an excluded tile - the exclusion comes from a
 * refusal, and a refusal cannot be the last thing that happened to a tile she went on to till.
 */
function patchReading(location, facts, orientations, excluded) {
  const qualified = [...facts.ground.keys()]
    .filter((key) => facts.cropped.has(key))
    .map((key) => facts.ground.get(key));
  const windows = orientations.map((orientation) => bestWindow(qualified, orientation));
  let window = windows[0];
  for (const candidate of windows) {
    if (candidate !== null && (window === null || candidate.count > window.count)) window = candidate;
  }
  const used = new Set(qualified.map(tileKey));
  const area = orientations[0].width * orientations[0].height;
  const inside =
    window === null
      ? []
      : excluded.filter((entry) => !used.has(tileKey(entry.tile)) && windowContains(window, entry.tile));
  return Object.freeze({
    location,
    coordinateCount: facts.ground.size + facts.cropped.size,
    tileCount: qualified.length,
    // The components of `tileCount`, so a short verdict can say WHY it is short instead of only that it is - and each
    // number keeps its own meaning: `tilledTiles` is ground the day's Hoe named, `sownTiles` is ground a seed went into.
    // A tile is in the patch when both a crop and a sowing-or-Hoe witness hold it (`ground`), which is why the two can
    // describe the same tile without being the same count.
    sownTiles: facts.sown.size,
    tilledTiles: facts.tilled.size,
    groundTiles: facts.ground.size,
    window,
    excludedTiles: Object.freeze(inside),
    availableTiles: area - inside.length,
    holdsAll: orientations.some((orientation) => windowHoldsAll(qualified, orientation)),
    largestRectangle: largestFilledRectangle(qualified),
  });
}

/** Whether a tile sits inside a window of the declared shape - the only place a rectangle's own geometry is read. */
function windowContains(window, tile) {
  return (
    tile.x >= window.x && tile.x < window.x + window.width && tile.y >= window.y && tile.y < window.y + window.height
  );
}

/**
 * The seed each planting spent, in the words of the receipt that spent it.
 *
 * `plant_seed`'s own postcondition carries `item`, `inventory_before` and `inventory_after`, so the pack's count of
 * THAT seed before the day's first sowing and after its last is a published fact rather than an inference. It is the
 * number that tells "sown 2, and the pack was empty" from "sown 2 of 60, and seed was never the limit".
 *
 * An unpublished count stays `unknown` rather than becoming zero, for the reason every count in this product does: a
 * zero derived from an absence tells a reader she holds none of a seed nobody counted.
 */
function seedLedger(entry, admitted) {
  const byItem = new Map();
  for (const admittedReceipt of admitted) {
    const detail = admittedReceipt.receipt?.evidence?.detail;
    if (typeof detail !== "string") continue;
    const fields = evidenceFields(detail);
    const item = sownSeed(entry, admittedReceipt.actionId, fields);
    if (item === null) continue;
    const existing = byItem.get(item);
    if (existing === undefined)
      byItem.set(item, { item, before: heldCount(fields.get("inventory_before")), after: "unknown" });
    byItem.get(item).after = heldCount(fields.get("inventory_after"));
  }
  return [...byItem.values()].sort((left, right) => left.item.localeCompare(right.item));
}

/** A published count, or `unknown`. `Number("")` is 0, which is why an absent field is read as text first. */
function heldCount(value) {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value) ? Number(value) : "unknown";
}

/**
 * How many tiles a patch day got, and what the receipts say limited it.
 *
 * <p>
 * THE COUNT ALONE LEAVES THE NEXT READER GUESSING. Measured 2026-11-20 (`round81`, `clear_and_plant_long_patch`):
 * the day's verdict was `unproven/task_purpose_evidence_without_postcondition` and carried no number at all, while
 * the run had sown two tiles and the pack had held two seeds. "Two of sixty" and "none of sixty" are different
 * days, and "sixty composed and fifty-eight refused" is a third - none of which that sentence could distinguish.
 * </p>
 * <p>
 * So a patch verdict carries the count it reached (`patchTiles`) and its components - how many tiles a sowing proved
 * (`patchSownTiles`) and how many a tilling did (`patchTilledTiles`) - beside the named limits: the seed each
 * planting spent, the tile-bearing receipts that were refused, and the tilled tiles nothing sowed. The ledger is
 * derived from the receipts the day actually minted, so it is bounded by a measured population rather than by a cap.
 * </p>
 * <p>
 * AND THE COUNT NAMES ITS OWN DENOMINATOR when that denominator is smaller than the declared rectangle: `round96`'s
 * `58/60` is a finished patch when the two missing tiles hold trees no action of that day's set fells, and a reader
 * must see that the two were excluded rather than assume they were missed (`excluded_by_occupant=tree@60,22,...`).
 * </p>
 */
function patchTally(entry, admitted, refusedTileProofs, reading, area) {
  const tileCount = reading?.tileCount ?? 0;
  const sownTiles = reading?.sownTiles ?? 0;
  const tilledTiles = reading?.tilledTiles ?? 0;
  const excluded = reading?.excludedTiles ?? [];
  return Object.freeze({
    patchTiles: tileCount,
    patchSownTiles: sownTiles,
    patchTilledTiles: tilledTiles,
    patchExcludedTiles: excluded,
    limitingFactors: Object.freeze([
      ...seedLedger(entry, admitted).map(
        (seed) => `seed_ledger:${seed.item}:${String(seed.before)}->${String(seed.after)}`,
      ),
      ...(refusedTileProofs > 0 ? [`tile_proof_refused:${String(refusedTileProofs)}`] : []),
      ...(tilledTiles > tileCount ? [`tilled_not_sown:${String(tilledTiles - tileCount)}`] : []),
      ...(sownTiles === 0 ? ["nothing_sown"] : []),
    ]),
    countDetail:
      `${String(tileCount)}/${String(area)} tiles tilled and sown (sown ${String(sownTiles)}, tilled ${String(tilledTiles)})` +
      (excluded.length === 0
        ? ""
        : ` · tillable=${String(area - excluded.length)}/${String(area)} · ${describeExcludedTiles(excluded)}`),
  });
}

/** One verdict's `detail`: the count first, then what this branch found, then the named limits - each written once. */
function patchDetail(tally, finding = "") {
  return [tally.countDetail, finding, tally.limitingFactors.join(" \u00b7 ")]
    .filter((part) => part.length > 0)
    .join(" \u00b7 ");
}

/**
 * The verdict for a patch purpose: did the run prove the declared rectangle?
 *
 * Four outcomes, and they are deliberately four. `achieved` needs a full window of tiles that are BOTH tilled and
 * carrying a crop. A run inside one declared window but short of its 60 tiles is a patch that is not finished, and it
 * reports the count it reached. A run whose tiles fit inside no declared window worked a different shape, and that is
 * named as its own finding with the largest rectangle it did form. A run whose receipts carry no tile at all leaves
 * us nothing to place on a map, which is our gap rather than her failure.
 *
 * EVERY ONE OF THE FOUR CARRIES THE COUNT. The refused branch used to return before anything was placed on a map, so
 * the one outcome a run reaches when a tile-bearing receipt cannot be read was also the only outcome that could not
 * say whether it saw two tiles or fifty-nine (`round81`, below). It now carries the count as a FLOOR and says so: a
 * refused proof may hide tiles, so it cannot be read as proof that they were not there.
 *
 * AND `achieved` IS A FULL WINDOW OF THE TILES THE DAY WAS ASKED FOR, which is the declared rectangle less the tiles a
 * standing occupant no action of this day clears holds (`patchExcludedTiles`). `round96` is the measurement: 58 worked
 * tiles and two trees inside the same 20x3 strip is a strip that was laid, and the verdict names the two rather than
 * reporting them as missing.
 */
function judgePatch(taskId, entry, admitted, refused, receipts, observations) {
  const declared = entry.patch;
  const area = declared.width * declared.height;
  // The same strip laid across the farm and laid down it is the same work, so the declared shape is tried in both
  // orientations. Rotation is the criterion's decision, not the geometry's.
  const orientations = [declared, Object.freeze({ width: declared.height, height: declared.width })];
  const excluded = patchExcludedTiles(entry, taskId, receipts);
  const byLocation = patchTileFacts(entry, admitted, observations);
  const readings = [...byLocation].map(([location, facts]) => patchReading(location, facts, orientations, excluded));
  // A full window means every tile of it the day could make ready is tilled AND sown; `availableTiles` is `area` when
  // nothing stands in the strip, so a plain sixty-tile patch answers exactly as it did.
  const proved = readings.find((reading) => reading.window !== null && reading.window.count === reading.availableTiles);
  if (proved !== undefined) {
    const strip = proved.window;
    return Object.freeze({
      state: "achieved",
      reasonCode: "task_purpose_achieved",
      purpose: entry.purpose,
      missingFact: null,
      patch: declared,
      location: proved.location,
      patchTiles: proved.tileCount,
      patchSownTiles: proved.sownTiles,
      patchTilledTiles: proved.tilledTiles,
      patchExcludedTiles: proved.excludedTiles,
      patchWindow: strip,
      // Nothing limited a day that reached every tile it could make ready, and a ledger here would invite a reader to
      // look for the catch. What it could NOT make ready is not a limit on the day, and travels in the count itself.
      limitingFactors: Object.freeze([]),
      detail:
        `${String(proved.tileCount)}/${String(area)} tiles of a ${String(strip.width)}x${String(strip.height)} strip at ` +
        `${String(strip.x)},${String(strip.y)} are tilled and sown` +
        (proved.excludedTiles.length === 0 ? "" : ` · ${describeExcludedTiles(proved.excludedTiles)}`),
    });
  }
  // A refused receipt means the evidence that would have decided this purpose exists and proved nothing about the
  // action it named. That is not "the patch is not there"; it is "this run cannot tell", and it is treated as such -
  // but only for the actions this criterion reads a TILE from. Measured 2026-11-06 (`round38`): the patch day refused
  // nine receipts of `move_to_tile`, `shop_purchase`, `harvest_crop` and `dismiss_modal`, none of which publishes a
  // coordinate this criterion counts, and the criterion answered `unproven` - telling a reader that the plot could not
  // be read while every tile that decides it was admitted and in hand. Twenty tiles tilled, thirteen planted, and the
  // artifact could say neither "achieved" nor "3/60".
  const tileProvingActionIds = new Set(
    [...entry.tilledBy, ...entry.croppedBy].map((tileProofEntry) => tileProofEntry.actionId),
  );
  const refusedTileProofs = refused.filter((receipt) => tileProvingActionIds.has(receipt.actionId)).length;
  // The plot is the map the most tiles were proven on. A map with no proven tile at all is not the plot; it is the
  // bedroom she slept in, or the garden pots in the house, and it only speaks when no map proves anything.
  const populated = readings.filter((reading) => reading.coordinateCount > 0);
  const best =
    [...populated].sort(
      (left, right) =>
        right.coordinateCount - left.coordinateCount ||
        (right.holdsAll ? 1 : 0) - (left.holdsAll ? 1 : 0) ||
        (right.window?.count ?? 0) - (left.window?.count ?? 0) ||
        (right.largestRectangle?.area ?? 0) - (left.largestRectangle?.area ?? 0) ||
        left.location.localeCompare(right.location),
    )[0] ?? null;
  const tally = patchTally(entry, admitted, refusedTileProofs, best, area);
  const counted = {
    patchTiles: tally.patchTiles,
    patchSownTiles: tally.patchSownTiles,
    patchTilledTiles: tally.patchTilledTiles,
    // The tiles the day was NOT asked for, named in every branch that has a window: a short reading that printed only
    // the count would leave "two tiles stand under a tree" and "two tiles she never reached" reading the same.
    patchExcludedTiles: tally.patchExcludedTiles,
    limitingFactors: tally.limitingFactors,
  };
  if (refusedTileProofs > 0) {
    return Object.freeze({
      ...counted,
      state: "unproven",
      reasonCode: "task_purpose_evidence_without_postcondition",
      purpose: entry.purpose,
      missingFact: null,
      patch: declared,
      location: best?.location ?? null,
      patchWindow: best?.window ?? null,
      detail: patchDetail(
        tally,
        `${String(refusedTileProofs)} tile proofs were refused, so this count is a floor rather than the day's total`,
      ),
    });
  }
  if (best === null) {
    return Object.freeze({
      ...counted,
      state: "unproven",
      reasonCode: "task_purpose_has_no_tile_coordinates",
      purpose: entry.purpose,
      missingFact:
        "no receipt of this run carried a tile for the patch: `till_soil` names the tile it turned and `plant_seed`/`water_crop` name the tile their crop is on, so with none of those admitted nothing says where the plot was. This is the run's observation gap, not a failure of the companion's.",
      patch: declared,
      detail: patchDetail(tally, "no receipt carried a tile"),
    });
  }
  const strip = best.window ?? Object.freeze({ width: declared.width, height: declared.height, count: 0 });
  // NO PLOT AT ALL IS ITS OWN SENTENCE. With no tile carrying both a tilling and a sowing there is no window to be inside,
  // and the branch below would report it as `inside the best 3x20 window at undefined,undefined` - a coordinate that does
  // not exist, printed by the one reading a day with nothing in the ground gets.
  if (best.window === null) {
    return Object.freeze({
      ...counted,
      state: "not_achieved",
      reasonCode: "task_purpose_not_achieved",
      purpose: entry.purpose,
      missingFact: null,
      patch: declared,
      location: best.location,
      patchWindow: strip,
      detail: patchDetail(tally, "no tile carries both a tilling and a sowing"),
    });
  }
  if (best.holdsAll) {
    return Object.freeze({
      ...counted,
      state: "not_achieved",
      reasonCode: "task_purpose_not_achieved",
      purpose: entry.purpose,
      missingFact: null,
      patch: declared,
      location: best.location,
      patchWindow: strip,
      detail: patchDetail(
        tally,
        `inside the best ${String(strip.width)}x${String(strip.height)} window at ${String(strip.x)},${String(strip.y)}`,
      ),
    });
  }
  const largest = best.largestRectangle;
  return Object.freeze({
    ...counted,
    state: "not_achieved",
    reasonCode: "tiles_do_not_form_the_declared_patch",
    purpose: entry.purpose,
    missingFact: null,
    patch: declared,
    location: best.location,
    largestRectangle: largest,
    detail: patchDetail(
      tally,
      `the largest rectangle found is ${String(largest.width)}x${String(largest.height)} (${String(largest.area)} tiles), not the declared ${String(declared.width)}x${String(declared.height)}`,
    ),
  });
}

/**
 * The tiles one day's receipts named, grouped by the map they are on, split by what each receipt PROVES.
 *
 * <p>
 * One map at a time, for the reason the strip is read that way: Stardew's coordinates restart at `(0, 0)` in every
 * location, so a plot half on the Farm and half in the greenhouse names the same coordinates as one plot and would be
 * counted as twenty tiles of ground that exists on no map.
 * </p>
 */
function plotFacts(entry, admitted) {
  const byLocation = new Map();
  const factsFor = (location) => {
    const existing = byLocation.get(location);
    if (existing !== undefined) return existing;
    const created = { tilled: new Map(), sown: new Map(), watered: new Map() };
    byLocation.set(location, created);
    return created;
  };
  const sinks = [
    [entry.tilledBy, "tilled"],
    [entry.sownBy, "sown"],
    [entry.wateredBy, "watered"],
  ];
  for (const admittedReceipt of admitted) {
    const detail = admittedReceipt.receipt?.evidence?.detail;
    if (typeof detail !== "string") continue;
    const fields = evidenceFields(detail);
    const location = mapOf(fields.get("location"));
    if (location === null) continue;
    for (const [proofs, sink] of sinks) {
      const proof = proofs.find((candidate) => candidate.actionId === admittedReceipt.actionId);
      if (proof === undefined) continue;
      const tile = tileOf(fields.get(proof.tileField));
      if (tile !== null) factsFor(location)[sink].set(tileKey(tile), tile);
    }
  }
  return byLocation;
}

/**
 * What one map's tiles say about the declared plot.
 *
 * <p>
 * THE PLOT IS THE TILES THAT CARRY A SOWING AND A WATERING, so the two sets have to be the SAME tiles: twenty sows on
 * one field and twenty waterings on another is a plot nowhere. That is the whole reason the entry is a count of tiles
 * instead of a step list, and it is why a step list could not be repaired into one - a step list has no way to say
 * "these, and not those".
 * </p>
 * <p>
 * `alreadyTilled` is the ground the day inherited: a sown tile whose ground this day's own `till_soil` never named.
 * It is not a deduction about yesterday - the sowing proves the tile was tilled when the seed went in - and it is the
 * number that makes "expand" a measurement rather than a word.
 * </p>
 */
function plotReading(location, facts) {
  const plot = [...facts.sown.keys()]
    .filter((key) => facts.watered.has(key))
    .map((key) => facts.sown.get(key))
    .sort((left, right) => left.y - right.y || left.x - right.x);
  return Object.freeze({
    location,
    plot: Object.freeze(plot),
    plotTiles: plot.length,
    sownTiles: facts.sown.size,
    wateredTiles: facts.watered.size,
    tilledTiles: facts.tilled.size,
    // A sow on a tile the day's Hoe never named: the ground was already tilled when the seed went in.
    alreadyTilled: [...facts.sown.keys()].filter((key) => !facts.tilled.has(key)).length,
  });
}

/** The plot as one reading: the count against the declared tiles, then the two facts that make it a PLOT. */
function describePlot(reading, declared, bought) {
  const counts =
    `${String(reading.plotTiles)}/${String(declared)} tiles sown and watered ` +
    `(sown ${String(reading.sownTiles)}, watered ${String(reading.wateredTiles)}) · ` +
    `tiles_not_under_crop_before=${String(reading.sownTiles)} · already_tilled=${String(reading.alreadyTilled)}`;
  const purchase = bought.length === 0 ? "nothing bought" : `bought=${bought.join(",")}`;
  const tiles = reading.plotTiles === 0 ? "" : ` · tiles ${reading.plot.map(tileKey).join(" ")}`;
  return `${counts} · ${purchase}${tiles}`;
}

/**
 * The verdict for a plot purpose: did the day leave the declared count of tiles tilled, sown and watered?
 *
 * <p>
 * THREE OUTCOMES, and the difference between the last two is the one this table keeps having to protect: `achieved` is
 * a plot of the declared count on ONE map with the seed bought; `not_achieved` is a day whose receipts are complete
 * evidence that it did not get there; `unproven` is a day whose tile-bearing receipts were refused - the evidence that
 * would have decided it exists and proved nothing, which is a floor rather than a total, and it carries the count so a
 * reader can tell "two tiles" from "sixty".
 * </p>
 */
function judgePlot(entry, admitted, refused) {
  const declared = entry.plot.tiles;
  const bought = entry.boughtBy.filter((actionId) => admitted.some((receipt) => receipt.actionId === actionId));
  const readings = [...plotFacts(entry, admitted)].map(([location, facts]) => plotReading(location, facts));
  // The plot is the map that carries the most of it, and ties break by map name so the same day always reads the same.
  const best =
    [...readings].sort(
      (left, right) =>
        right.plotTiles - left.plotTiles ||
        right.sownTiles - left.sownTiles ||
        left.location.localeCompare(right.location),
    )[0] ??
    Object.freeze({
      location: null,
      plot: Object.freeze([]),
      plotTiles: 0,
      sownTiles: 0,
      wateredTiles: 0,
      tilledTiles: 0,
      alreadyTilled: 0,
    });
  const tally = Object.freeze({
    plotTiles: best.plotTiles,
    plotSownTiles: best.sownTiles,
    plotWateredTiles: best.wateredTiles,
    plotAlreadyTilled: best.alreadyTilled,
    plotBoughtActions: Object.freeze(bought),
    detail: describePlot(best, declared, bought),
    limitingFactors: Object.freeze([
      ...(best.plotTiles < declared ? [`plot_short:${String(declared - best.plotTiles)}`] : []),
      ...(bought.length === 0 ? ["nothing_bought"] : []),
      ...seedLedger(entry, admitted).map(
        (seed) => `seed_ledger:${seed.item}:${String(seed.before)}->${String(seed.after)}`,
      ),
    ]),
  });
  const tileProvingActionIds = new Set(
    [...entry.tilledBy, ...entry.sownBy, ...entry.wateredBy].map((proof) => proof.actionId),
  );
  const refusedTileProofs = refused.filter((receipt) => tileProvingActionIds.has(receipt.actionId)).length;
  if (refusedTileProofs > 0) {
    return Object.freeze({
      ...tally,
      state: "unproven",
      reasonCode: "task_purpose_evidence_without_postcondition",
      purpose: entry.purpose,
      missingFact: null,
      plot: entry.plot,
      location: best.location,
      detail:
        `${tally.detail} · ` +
        `${String(refusedTileProofs)} tile proofs were refused, so this count is a floor rather than the day's total`,
    });
  }
  if (best.plotTiles >= declared && bought.length > 0) {
    return Object.freeze({
      ...tally,
      state: "achieved",
      reasonCode: "task_purpose_achieved",
      purpose: entry.purpose,
      missingFact: null,
      plot: entry.plot,
      location: best.location,
      // Nothing limited a day that laid its plot, and a ledger here would invite a reader to look for the catch - the
      // same rule the strip's achieved branch keeps. What the day inherited is in the count, not in the limits.
      limitingFactors: Object.freeze([]),
    });
  }
  return Object.freeze({
    ...tally,
    state: "not_achieved",
    reasonCode: "task_purpose_not_achieved",
    purpose: entry.purpose,
    missingFact: null,
    plot: entry.plot,
    location: best.location,
    detail: `${tally.detail} · ${tally.limitingFactors.join(" \u00b7 ")}`,
  });
}

/**
 * The distinct things one day's receipts removed, by the action that removed each, and the count they add up to.
 *
 * <p>
 * A TARGET ID IS THE THING, and the same id twice is one thing: `cut_weeds` answers `weed_target_gone` on a tile an
 * earlier node already cut, `break_rock` answers `rock_source_gone` on the stone an earlier swing removed, and both carry
 * the `target` the earlier receipt carried. Counting receipts would read that as two pieces cleared, which is the
 * rounds-96 defect (twenty hoe swings on one tile is not a plot) in its other direction.
 * </p>
 * <p>
 * THE FIELD IS DECLARED PER ACTION (`clearedBy`), not assumed: every clearing action publishes its target today, and an
 * action that names it otherwise is a declaration here rather than a silent zero.
 * </p>
 * <p>
 * ONE COUNT FOR THE WHOLE DAY, WITH NO MAP AROUND IT, and that is safe BECAUSE OF THE PRODUCER: a clearing target id is
 * `<location>:<x>,<y>:<kind>:<item>` hashed (`BuildWeedTargetId` and its three siblings in
 * `integrations/stardew/farmhandexecutioncontroller.cs`), so the map is inside the identity this counts. Two maps can
 * therefore never mint one id for two pieces - which is what the receipts, carrying no `location`, could not prove on
 * their own.
 * </p>
 */
function clearedTargets(entry, admitted) {
  const fieldOf = new Map(entry.clearedBy.map((proof) => [proof.actionId, proof.targetField]));
  const targets = new Set();
  const byAction = new Map();
  for (const admittedReceipt of admitted) {
    const field = fieldOf.get(admittedReceipt.actionId);
    if (field === undefined) continue;
    const detail = admittedReceipt.receipt?.evidence?.detail;
    if (typeof detail !== "string") continue;
    const target = evidenceFields(detail).get(field);
    if (typeof target !== "string" || target.length === 0 || targets.has(target)) continue;
    targets.add(target);
    byAction.set(admittedReceipt.actionId, (byAction.get(admittedReceipt.actionId) ?? 0) + 1);
  }
  return { targets, byAction };
}

/**
 * The verdict for a clearing purpose: how many separate pieces came off the ground, against the declared count.
 *
 * <p>
 * THREE OUTCOMES, and the middle one is the floor the other criteria keep: `achieved` is the declared count of DISTINCT
 * targets; `unproven` is a day whose clearing receipts were refused - the evidence that would have decided it exists and
 * proved nothing - so the count is a floor rather than a total; `not_achieved` is a complete reading of a day that fell
 * short, and it carries the count it reached with the split by action so a reader can tell "four weeds and no rocks" from
 * "nothing found".
 * </p>
 * <p>
 * IT NAMES NO PLACE, deliberately. The purpose this replaces asked for "the east patch", which no published family
 * states - see `clearedPieces` - and inventing a place here would put the same unjudgeable demand back one layer down.
 * </p>
 */
function judgeClearedPieces(entry, admitted, refused) {
  const declared = entry.pieces.atLeast;
  const { targets, byAction } = clearedTargets(entry, admitted);
  const cleared = targets.size;
  const split = [...byAction].map(([actionId, count]) => `${actionId} ${String(count)}`).join(", ");
  const tally = Object.freeze({
    clearedPieces: cleared,
    clearedDeclared: declared,
    clearedByAction: Object.freeze(Object.fromEntries(byAction)),
    detail: `${String(cleared)}/${String(declared)} pieces cleared${split.length === 0 ? "" : ` (${split})`}`,
  });
  const readActionIds = new Set(entry.clearedBy.map((proof) => proof.actionId));
  const refusedReadings = refused.filter((receipt) => readActionIds.has(receipt.actionId)).length;
  const common = Object.freeze({ ...tally, purpose: entry.purpose, missingFact: null });
  if (cleared >= declared) return Object.freeze({ ...common, state: "achieved", reasonCode: "task_purpose_achieved" });
  if (refusedReadings > 0) {
    return Object.freeze({
      ...common,
      state: "unproven",
      reasonCode: "task_purpose_evidence_without_postcondition",
      detail:
        `${tally.detail} \u00b7 ${String(refusedReadings)} clearing receipt(s) were refused, so this count is a floor ` +
        "rather than the day's total",
    });
  }
  return Object.freeze({
    ...common,
    state: "not_achieved",
    reasonCode: "task_purpose_not_achieved",
    detail: `${tally.detail}${cleared === 0 ? " \u00b7 nothing_cleared" : ""}`,
  });
}
/**
 * The map a door transition's `actual` names, or null.
 *
 * The grammar is the Mod's own and the Host's (`parseWarpDestination` in `host/src/stardew-completion-contracts.ts`):
 * `<NameOrUniqueName>:x,y`, the name greedy up to the final colon so a map whose own name carries one still round-trips,
 * and the tile bounded the way every coordinate in this file is.
 */
function arrivalMapOf(value) {
  const match = /^(.*):(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/u.exec(typeof value === "string" ? value : "");
  if (match === null) return null;
  const map = match[1];
  const x = Number(match[2]);
  const y = Number(match[3]);
  return map.length > 0 && map !== "none" && x <= 1000 && y <= 1000 ? map : null;
}

/**
 * The admitted receipts that state a map, in the two shapes the entry declares, each with the map it named.
 *
 * An arrival is read from the field its own receipt writes (`actual`), a conversation from the field its own receipt
 * writes (`location`), and both are the Mod's words: nothing here infers a map from a tile, and a receipt that names no
 * map contributes nothing rather than a guess.
 */
function townMapFacts(entry, admitted) {
  const arrivals = [];
  const conversations = [];
  for (const [index, admittedReceipt] of admitted.entries()) {
    const detail = admittedReceipt.receipt?.evidence?.detail;
    if (typeof detail !== "string") continue;
    const fields = evidenceFields(detail);
    const { arrival, conversation } = entry.town;
    if (arrival.actionIds.includes(admittedReceipt.actionId)) {
      const map = arrivalMapOf(fields.get(arrival.field));
      if (map !== null) arrivals.push(Object.freeze({ index, map, actionId: admittedReceipt.actionId }));
      continue;
    }
    if (!conversation.actionIds.includes(admittedReceipt.actionId)) continue;
    const map = mapOf(fields.get(conversation.field));
    if (map === null) continue;
    const npc = fields.get("npc") ?? fields.get("target") ?? null;
    conversations.push(Object.freeze({ index, map, actionId: admittedReceipt.actionId, npc }));
  }
  return { arrivals, conversations };
}

/** The maps a reading saw, and the ones no answer covers - the sentence every town verdict ends with. */
function describeTownMaps(maps, undeclared) {
  return (
    `maps=${maps.length === 0 ? "none" : maps.join(",")}` +
    (undeclared.length === 0 ? "" : ` · undeclared_maps=${undeclared.join(",")}`)
  );
}

/**
 * The verdict for a town purpose: did she go there, and did she speak to somebody after she arrived?
 *
 * <p>
 * BOTH HALVES ARE REQUIRED, because the day's own prompt asks for both and the two failures are different days: a run that
 * never left the farm and a run that walked to town and spoke to nobody. Each answer is a receipt - `travel`/`enter_exit`
 * for the arrival and `talk_to_npc` for the words - so the verdict never rests on what she said she did.
 * </p>
 * <p>
 * A REFUSED MAP RECEIPT IS A FLOOR, NOT A FAILURE, and only for the actions this criterion reads: `round77`'s rule. A
 * conversation in a map no answer covers is `not_achieved` AND NAMED (`undeclared_maps=`), so the one direction this
 * declaration can be incomplete in is visible instead of quiet.
 * </p>
 */
function judgeTownVisit(entry, admitted, refused) {
  const { arrivals, conversations } = townMapFacts(entry, admitted);
  const maps = [...new Set([...arrivals, ...conversations].map((candidate) => candidate.map))].sort();
  const undeclared = maps.filter((map) => !Object.hasOwn(TOWN_MAP_ANSWERS, map));
  const reading = Object.freeze({
    townMaps: Object.freeze(maps),
    townMapsUndeclared: Object.freeze(undeclared),
    purpose: entry.purpose,
    missingFact: null,
  });
  const arrival = arrivals.find((candidate) => inTownMap(candidate.map)) ?? null;
  const conversation =
    conversations.find(
      (candidate) => inTownMap(candidate.map) && arrival !== null && candidate.index > arrival.index,
    ) ?? null;
  if (arrival !== null && conversation !== null) {
    return Object.freeze({
      ...reading,
      state: "achieved",
      reasonCode: "task_purpose_achieved",
      townArrival: arrival,
      townConversation: conversation,
      detail:
        `a conversation in town: arrived in ${arrival.map} (${arrival.actionId}), then talked to ` +
        `${conversation.npc ?? "someone"} in ${conversation.map}`,
    });
  }
  const readActionIds = new Set([...entry.town.arrival.actionIds, ...entry.town.conversation.actionIds]);
  const refusedMapReceipts = refused.filter((receipt) => readActionIds.has(receipt.actionId)).length;
  if (refusedMapReceipts > 0) {
    return Object.freeze({
      ...reading,
      state: "unproven",
      reasonCode: "task_purpose_evidence_without_postcondition",
      townArrival: arrival,
      townConversation: conversation,
      detail:
        `${String(refusedMapReceipts)} receipt(s) that name a map were refused, so this reading is a floor rather than the ` +
        `day's total · ${describeTownMaps(maps, undeclared)}`,
    });
  }
  const seen = describeTownMaps(maps, undeclared);
  const townConversations = conversations.filter((candidate) => inTownMap(candidate.map));
  const finding = townVisitFinding({ arrival, conversations, townConversations, seen });
  return Object.freeze({
    ...reading,
    state: "not_achieved",
    reasonCode: "task_purpose_not_achieved",
    townArrival: arrival,
    townConversation: conversation,
    detail: finding,
  });
}

/**
 * Which half of a town purpose the day missed, in one sentence.
 *
 * Four days answer differently and a reader acts on each of them separately: never went, went and spoke to nobody, spoke
 * in town BEFORE going, and spoke somewhere that is not the town. One sentence per case, never one sentence for all four.
 */
function townVisitFinding({ arrival, conversations, townConversations, seen }) {
  if (arrival === null) return `she never entered a declared town map · ${seen}`;
  if (conversations.length === 0) return `she arrived in ${arrival.map} (${arrival.actionId}) and spoke to nobody · ${seen}`;
  if (townConversations.length > 0)
    return (
      `she arrived in ${arrival.map} (${arrival.actionId}) after the conversation: the words in ` +
      `${townConversations.map((candidate) => candidate.map).join(",")} came first · ${seen}`
    );
  return (
    `she arrived in ${arrival.map} and every conversation was outside a declared town map ` +
    `(${conversations.map((candidate) => candidate.map).join(",")}) · ${seen}`
  );
}

/**
 * Did the task's own purpose hold?
 *
 * `achieved` is reachable only through the criterion above. Everything else is named: `not_achieved` when the
 * receipts are complete evidence that the purpose did not hold, `unproven` when the receipts that would have decided it
 * carried no postcondition of their own, and `unjudged` when the criterion itself asks for a fact nothing publishes
 * (`missingFact`) - a purpose no receipt set can decide, and therefore no day of a run can be blamed for.
 *
 * `observations` is the snapshot rows the run saw (`{ location, soilTiles, cropTargets }`), and only a shape
 * criterion reads it: a purpose about three actions is decided by the receipts alone, while a purpose about a strip
 * of tiles may also count what the companion could see. Absent, the criterion reads the receipts.
 */
export function judgeTaskPurpose(taskId, receipts, observations = null) {
  const entry = TASK_PURPOSE_CRITERIA[taskId];
  const { admitted, unfinished, refused } = purposeReceipts(receipts);
  const common = Object.freeze({
    taskId,
    admittedActionIds: Object.freeze([...new Set(admitted.map((receipt) => receipt.actionId))].sort()),
    refusedReceipts: refused,
    // THE SWINGS THAT LANDED AND DID NOT FINISH. Reported beside the refusals and NOT blocking: a purpose that wanted
    // the stone gone has simply not got there, which is `not_achieved` and not "this run cannot tell".
    unfinishedReceipts: unfinished,
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
      state: "unjudged",
      reasonCode: "task_purpose_needs_an_unpublished_fact",
      purpose: entry.purpose,
      missingFact: entry.missingFact,
      // The sentence AND the fact as data: a run's own artifact then carries which fact the day wanted and the producer
      // that does not publish it, instead of leaving a reader to re-read this table to find out who would have to change.
      unpublishedFact: entry.unpublishedFact ?? null,
    });
  }
  if (entry.patch !== undefined) {
    return Object.freeze({ ...common, ...judgePatch(taskId, entry, admitted, refused, receipts, observations) });
  }
  // A plot is judged on the tiles it left behind, so it reads receipts the same way and never the step list - which is
  // what keeps "twenty tiles" from becoming "twenty receipts" (see the entry's own note).
  if (entry.plot !== undefined) {
    return Object.freeze({ ...common, ...judgePlot(entry, admitted, refused) });
  }
  // A town purpose is decided by WHERE the receipts happened rather than by which actions returned: it reads a map field
  // out of two receipt shapes, so it is neither a step list nor a shape on a map (see the entry's own note).
  if (entry.town !== undefined) {
    return Object.freeze({ ...common, ...judgeTownVisit(entry, admitted, refused) });
  }
  // A clearing purpose is a COUNT of the things the receipts named, so it reads neither a step list nor a map: the
  // receipts it counts publish no map and no tile (see the entry's own note).
  if (entry.pieces !== undefined) {
    return Object.freeze({ ...common, ...judgeClearedPieces(entry, admitted, refused) });
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
  // action it named. That is not "the purpose did not hold"; it is "this run cannot tell", and it is treated as such -
  // FOR THE ACTIONS THIS CRITERION READS. Measured 2026-11-19 (`round77`, day 2, `mine_ladder_to_depth`): the day's
  // seven refused receipts were `move_to_tile`'s adjacency arrival and one `dismiss_modal` that said `modal=none`, while
  // the criterion reads `enter_mine` and `use_mine_ladder` and that day dispatched NEITHER - so the run was complete
  // evidence that no mine was entered, and it answered "cannot tell" instead. The patch criterion has scoped its
  // refusals this way since round38 (`judgePatch`); this is the same rule for a step list, and the exemption is the
  // reason a refusal can only ever produce `unproven` in the first place.
  if (refused.some((receipt) => criterionActionIdsOf(entry).has(receipt.actionId))) {
    return Object.freeze({
      ...common,
      state: "unproven",
      reasonCode: "task_purpose_evidence_without_postcondition",
      purpose: entry.purpose,
      missingFact: null,
    });
  }
  const detail = quantifiedProgressDetail(entry, admitted);
  return Object.freeze({
    ...common,
    state: "not_achieved",
    reasonCode: "task_purpose_not_achieved",
    purpose: entry.purpose,
    missingFact: null,
    ...(detail === undefined ? {} : { detail }),
  });
}
