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
 * purpose, and "some declared action succeeded" satisfies none of them.
 *
 * ORDER IS PART OF A CRITERION ONLY WHERE THE PURPOSE IS A CAUSE. An ordered criterion (`ordered`, the default) matches
 * its steps forward through the receipt log, so it asserts that each earlier fact is a PRECONDITION of the next - and
 * the row must name that link in `because`. A row that cannot name it is unordered. Measured 2026-11-18 (`round76`): a
 * day that cleared, sowed, watered and tilled was reported `not_achieved`, because `clear_and_cultivate` demanded the
 * chain clearing-then-tilling-then-sowing. The chain is ONE way to prepare ground; she had sown into ground that was
 * already tilled, which is what a farmhand does, so the criterion graded the drawing instead of the day.
 *
 * WHAT A CRITERION MAY NOT DO. It may not read a fact the receipts do not publish, and it may not substitute a
 * readable neighbour for the purpose (clearing "one patch somewhere" is not clearing the east patch). Where the
 * purpose needs a fact nothing publishes, the entry carries `missingFact` instead of `steps`: the day is then
 * `unjudged` with that sentence attached, and `judgeTaskPurpose` still cannot return `achieved` for it.
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

import { STARDEW_GAME_INTEGRATION_ADAPTER } from "../../host/dist-test/stardew-game-integration-adapter.js";

import { SWEEP_DAILY_TASKS } from "./multiday-daily-tasks.mjs";
import { bestWindow, largestFilledRectangle, windowHoldsAll } from "./tile-patch.mjs";

/** A step of a criterion: one admitted postcondition, or `count` distinct receipts of it. */
const step = (actionId, { count = 1 } = {}) =>
  Object.freeze(count === 1 ? { actionId } : { actionId, count });

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
const absentEvidenceField = (actionId, field) => Object.freeze({ kind: "absent_evidence_field", actionId, field });
const presentEvidenceField = (actionId, field) => Object.freeze({ kind: "present_evidence_field", actionId, field });

/**
 * The half of a reason no artifact can decide, with the artifact that would refute it.
 *
 * Declared rather than implied, because an absence nobody enumerates - "no map of the Farm says which part is the east
 * patch" - is a debt: the reader has to be able to check it without a run, and the next lane has to know which file to
 * change to retire it.
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
  dye_clothing_with_item: Object.freeze({ spends: true, because: "the dye items the receipt names are spent on the garment" }),
  fertilize_tile: Object.freeze({ spends: true, because: "the fertilizer stack leaves the pack onto the soil" }),
  open_geode: Object.freeze({ spends: true, because: "the geode leaves the pack and the counter hands back what was inside" }),
  place_crab_pot: Object.freeze({ spends: true, because: "the pot leaves the pack onto the water's edge" }),
  place_owned_object: Object.freeze({ spends: true, because: "the stack leaves the pack onto the ground" }),
  place_wood_fence: Object.freeze({ spends: true, because: "the fence leaves the pack onto the field" }),
  plant_sapling: Object.freeze({ spends: true, because: "the sapling leaves the pack into the ground" }),
  plant_seed: Object.freeze({ spends: true, because: "the seed stack leaves the pack into the soil" }),
  redeem_prize_ticket: Object.freeze({ spends: true, because: "the prize ticket leaves the pack into the machine" }),
  ship_item: Object.freeze({ spends: true, because: "the stack leaves the pack into the shipping bin, which is how a farmhand sells" }),
  tailor_clothing: Object.freeze({ spends: true, because: "the cloth the receipt names is spent on the garment" }),
  use_item: Object.freeze({ spends: true, because: "the food the actor was carrying is eaten" }),
  use_warp_item: Object.freeze({ spends: true, because: "the warp item is spent by arriving" }),
  // A pack count rises: the receipt proves something entered the pack.
  chest_retrieve: Object.freeze({ spends: false, because: "the chest hands the stack back into the pack" }),
  claim_mail_attachment: Object.freeze({ spends: false, because: "the letter's contents arrive in the pack" }),
  claim_museum_reward: Object.freeze({ spends: false, because: "the museum's reward arrives in the pack" }),
  collect_animal_product: Object.freeze({ spends: false, because: "the product arrives in the pack" }),
  collect_crab_pot_output: Object.freeze({ spends: false, because: "the pot's catch arrives in the pack" }),
  cook_recipe: Object.freeze({ spends: false, because: "the dish arrives in the pack; what its ingredients cost is published beside it as the materials' own rule" }),
  fish_here: Object.freeze({ spends: false, because: "the catch arrives in the pack" }),
  harvest_crop: Object.freeze({ spends: false, because: "the harvest arrives in the pack" }),
  move_placed_furniture: Object.freeze({ spends: false, because: "the piece is picked UP off the floor into the pack" }),
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
 * What each rotation task's purpose requires, keyed by the task ids in `multiday-daily-tasks.mjs`.
 *
 * Each criterion reads only postconditions the Mod already publishes and the Host already validates, and each one
 * requires at least two of them, so no single action's success can satisfy a task.
 */
export const TASK_PURPOSE_CRITERIA = Object.freeze({
  clear_east_patch: gap(
    "the east patch has no weeds and rocks left in it",
    "no fact says which part of the farm is the east patch. `cut_weeds`, `cut_grass`, `break_rock` and `chop_stump` each publish the target they removed and the tool they used, and not one of their evidence key sets admits a `location` at all (`host/src/stardew-completion-contracts.ts`), so the removal is proved and the map it happened on is not. Even a map name would not bound it: the farm is one `Farm` map with one tile grid and no subdivision fact, so 'a patch was cleared somewhere on the Farm' is the strongest statement a run can make.",
    {
      reason: "prose",
      fact: unpublishedFact("a sub-area of the Farm named the east patch"),
      claims: [
        absentEvidenceField("cut_weeds", "location"),
        absentEvidenceField("cut_grass", "location"),
        absentEvidenceField("break_rock", "location"),
        absentEvidenceField("chop_stump", "location"),
        proseReason(
          "a published fact naming a sub-area of the Farm would refute this: the Farm arrives as one map with one tile grid and no family or receipt carries a region or plot id, so the declaration that would retire this entry is a reading of the farm's own partition",
        ),
      ],
    },
  ),
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
  town_market: gap(
    "something was bought in town and the post was brought in",
    "the RECEIPT carries no location on the buying half: `shop_purchase`'s `item_purchased` evidence is exactly shop;owner;entry;item;requested;purchased;unit_price;money_before;money_after;owned_before;owned_after;gained;stock_before;stock_after;owner_tile;menu_closed;clicks;drops (`host/src/stardew-completion-contracts.ts`), which names the shop and the counter tile and never the map the actor stood on - while the mail half's `claim_mail_attachment` does carry `location` in its `mail_claimed` evidence. The observation publishes the map she is standing on, so the purchase is the half with no map of its own, and a criterion decides a task from admitted receipts rather than from an observation.",
    {
      reason: "prose",
      fact: unpublishedFact(
        "the map the purchase happened on",
        producerAt("host/src/stardew-completion-contracts.ts", "shop_purchase: (claim) =>"),
      ),
      claims: [
        absentEvidenceField("shop_purchase", "location"),
        presentEvidenceField("claim_mail_attachment", "location"),
        proseReason(
          "a criterion that decides its purpose from the observation's own `location` rather than from an admitted receipt would refute the second half: `judgeTaskPurpose` in `tools/lib/task-purpose.mjs` reads receipts, and hands observations to the declared-shape criterion alone",
        ),
      ],
    },
  ),
  town_visit: gap(
    "a conversation happened in town",
    "`talk_to_npc` DOES publish the map: `talk_to_npc_talked`'s evidence carries `location=<NameOrUniqueName>` beside the villager's tile (`host/src/stardew-completion-contracts.ts`), so where the conversation happened is a published fact and the actor's position is not what is missing. What is missing is the other half of the sentence - a DECLARATION of which maps count as Town (is the Saloon town? the SeedShop?) - which no module in this tree makes, so a word at the farm and a word in the square are still decided as the same fact.",
    {
      reason: "prose",
      fact: unpublishedFact("a declaration of which maps count as Town"),
      claims: [
        presentEvidenceField("talk_to_npc", "location"),
        proseReason(
          "a declared Town map set would refute this: nothing in this tree says which maps are Town, and the population such a declaration would join is the task table in `tools/lib/multiday-daily-tasks.mjs`",
        ),
      ],
    },
  ),
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
  till_and_sow: criterion(
    "the ground was tilled, then planted, then watered",
    [step("till_soil"), step("plant_seed"), step("water_crop")],
    {
      because:
        "`plant_seed` needs the HoeDirt `till_soil` turned, and `water_crop` waters the crop `plant_seed` put in it - each postcondition is the next one's precondition",
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
  // UNORDERED, and it was the only row whose order was a claim about the table rather than about the world.
  //
  // Measured 2026-11-18 (`round76`, day 1, judged here from the run's own `timeline.jsonl`): the day cut 30 weeds and
  // 20 grasses, broke 13 rocks, sowed two seeds on (69,20) and (69,19) (receipt #52/#53), watered those same two tiles
  // (#54/#55), tilled four OTHER tiles (#70-#73) and felled a tree (#76, with only four more weeds cut after it) - and
  // answered `not_achieved`, because the chain wanted a `till_soil` AFTER the clearing and the four tills all came
  // before it.
  //
  // She was right and the row was wrong. She sowed into ground that was already tilled - what a farmhand does - so
  // "clear the ground, then till it, then sow it" describes ONE way of preparing ground, not the purpose of a day that
  // did all four kinds of work in whatever order the farm allowed: something cleared (a tree, a stump, debris), the
  // ground tilled, a seed in it, and the crop watered. The purpose is what the day produced, not the route it took.
  //
  // THE ORDER DID CARRY INFORMATION IN ONE CASE, and this is what was dropped on purpose: ground that has NEVER been
  // tilled, where the clearing and the tilling are the same dirt and a `till_soil` before the felling left that tile
  // untouched. No receipt can show that pairing - `chop_tree`'s and `chop_stump`'s evidence key sets carry neither
  // `location` nor `tile` (`host/src/stardew-completion-contracts.ts`), `cut_weeds` and `break_rock` declare no
  // `location` at all (`clear_east_patch`'s claims), and `clear_debris` is the only one of the three that names the tile
  // it cleared - so the chain was asserting a same-tile relation for all three that only one of them can describe.
  clear_and_cultivate: criterion(
    "a patch was cleared, and the ground was tilled, planted and watered",
    [anyOf("chop_tree", "chop_stump", "clear_debris"), step("till_soil"), step("plant_seed"), step("water_crop")],
    { ordered: false },
  ),
  // THE ONLY CRITERION THAT COUNTS TILES. `clear_east_patch` cannot say which part of the farm was cleared, and
  // `till_and_sow` cannot say how much was tilled, because a receipt names one tile and no criterion asked for a
  // shape. This one does: sixty tiles, all tilled, all carrying a crop, inside a 3x20 strip - a plot longer than the
  // 13x13 window one snapshot sees, so the boundary has to survive her walking out of view.
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
  // A second spatial + seed-shortage patch (36 tiles > 15 chest seeds, 18 > 13x13 window): fits inside starter gold
  // even for higher-value spring crops while still forcing SeedShop planning and refill capacity.
  plant_market_strip: patch(
    "one spring market bed, two tiles wide and eighteen long, was tilled and sown the whole way",
    {
      width: 2,
      height: 18,
      tilledBy: [tileProof("till_soil", "target")],
      croppedBy: [tileProof("plant_seed", "tile"), tileProof("water_crop", "tile")],
    },
  ),
  // Explicit shop-purchase + scaled-cultivation loop: 20 tiles exceeds starter chest seeds and explicitly requires a
  // `shop_purchase` receipt alongside twenty distinct till, sow, and water postconditions.
  buy_seeds_and_expand_plot: criterion(
    "seeds were bought from a shop and a twenty-tile plot was tilled, planted, and watered",
    [
      step("shop_purchase"),
      step("till_soil", { count: 20 }),
      step("plant_seed", { count: 20 }),
      step("water_crop", { count: 20 }),
    ],
    { ordered: false },
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
 * A `succeeded` receipt with no evidence, or with evidence that does not parse as the action it names, is moved to
 * `refused` instead of being counted. That list is what lets a caller say "the receipt existed and proved nothing"
 * rather than "the run did nothing", and it is the reason a refused receipt can only ever produce `unproven`.
 *
 * The admitted entry keeps the receipt it admitted, so a criterion about tiles reads the SAME evidence the Host just
 * validated instead of re-deciding admission: one authority per fact, even when the fact is "this receipt proves a
 * tile".
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
    admitted.push(Object.freeze({ actionId, receipt }));
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
 * ONE SPELLING OF "THIS TILE WAS SOWN": a crop proof (an action the criterion's `croppedBy` declares) that also names
 * the `item` it spent. `plant_seed`'s postcondition carries `item`, `inventory_before` and `inventory_after`; a
 * `water_crop` carries the water it spent and no seed, so it proves a crop without proving a sowing. Adding a second
 * declaration of which actions sow would be the same fact written twice, and the two copies would drift.
 */
function sownSeed(entry, actionId, fields) {
  if (!entry.croppedBy.some((proof) => proof.actionId === actionId)) return null;
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
 */
function patchTileFacts(entry, admitted, observations) {
  const byLocation = new Map();
  const factsFor = (location) => {
    const existing = byLocation.get(location);
    if (existing !== undefined) return existing;
    const created = { tilled: new Map(), cropped: new Map(), sown: new Map() };
    byLocation.set(location, created);
    return created;
  };
  const mapOf = (location) =>
    typeof location === "string" && location.length > 0 && location !== "none" ? location : null;
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
      if (row?.hoeDirt === true && tile !== null) facts.tilled.set(tileKey(tile), tile);
    }
    for (const row of observations?.cropTargets ?? []) {
      const tile = tileOf(`${String(row?.x)},${String(row?.y)}`);
      if (tile !== null) facts.cropped.set(tileKey(tile), tile);
    }
  }
  return byLocation;
}

/**
 * What one map's proven tiles say about the declared patch.
 *
 * `holdsAll` is the line between the two failures that must not read alike: a set of tiles that fits inside one
 * declared window is a patch that is not finished yet, and a set that fits inside none of them is a different shape
 * however many tiles it holds.
 */
function patchReading(location, facts, orientations) {
  const qualified = [...facts.tilled.keys()]
    .filter((key) => facts.cropped.has(key))
    .map((key) => facts.tilled.get(key));
  const windows = orientations.map((orientation) => bestWindow(qualified, orientation));
  let window = windows[0];
  for (const candidate of windows) {
    if (candidate !== null && (window === null || candidate.count > window.count)) window = candidate;
  }
  return Object.freeze({
    location,
    coordinateCount: facts.tilled.size + facts.cropped.size,
    tileCount: qualified.length,
    // The components of `tileCount`, so a short verdict can say WHY it is short instead of only that it is.
    sownTiles: facts.sown.size,
    tilledTiles: facts.tilled.size,
    window,
    holdsAll: orientations.some((orientation) => windowHoldsAll(qualified, orientation)),
    largestRectangle: largestFilledRectangle(qualified),
  });
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
 */
function patchTally(entry, admitted, refusedTileProofs, reading, area) {
  const tileCount = reading?.tileCount ?? 0;
  const sownTiles = reading?.sownTiles ?? 0;
  const tilledTiles = reading?.tilledTiles ?? 0;
  return Object.freeze({
    patchTiles: tileCount,
    patchSownTiles: sownTiles,
    patchTilledTiles: tilledTiles,
    limitingFactors: Object.freeze([
      ...seedLedger(entry, admitted).map(
        (seed) => `seed_ledger:${seed.item}:${String(seed.before)}->${String(seed.after)}`,
      ),
      ...(refusedTileProofs > 0 ? [`tile_proof_refused:${String(refusedTileProofs)}`] : []),
      ...(tilledTiles > tileCount ? [`tilled_not_sown:${String(tilledTiles - tileCount)}`] : []),
      ...(sownTiles === 0 ? ["nothing_sown"] : []),
    ]),
    countDetail: `${String(tileCount)}/${String(area)} tiles tilled and sown (sown ${String(sownTiles)}, tilled ${String(tilledTiles)})`,
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
 */
function judgePatch(entry, admitted, refused, observations) {
  const declared = entry.patch;
  const area = declared.width * declared.height;
  // The same strip laid across the farm and laid down it is the same work, so the declared shape is tried in both
  // orientations. Rotation is the criterion's decision, not the geometry's.
  const orientations = [declared, Object.freeze({ width: declared.height, height: declared.width })];
  const byLocation = patchTileFacts(entry, admitted, observations);
  const readings = [...byLocation].map(([location, facts]) => patchReading(location, facts, orientations));
  const proved = readings.find((reading) => reading.window?.count === area);
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
      patchWindow: strip,
      // Nothing limited a day that reached all sixty, and a ledger here would invite a reader to look for the catch.
      limitingFactors: Object.freeze([]),
      detail: `${String(area)}/${String(area)} tiles of a ${String(strip.width)}x${String(strip.height)} strip at ${String(strip.x)},${String(strip.y)} are tilled and sown`,
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
    return Object.freeze({ ...common, ...judgePatch(entry, admitted, refused, observations) });
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
