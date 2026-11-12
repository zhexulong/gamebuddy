import type { IntegrationReceiptEvidence } from "./game-integration-adapter.js";
import { isQualifiedItemId } from "./protocol-target-facts.js";
import type { ExecutionRequest } from "./protocol.js";

/**
 * THE COMPLETION CONTRACTS: what a `succeeded` receipt must prove before the Host records a typed transition.
 *
 * THE POPULATION IS THE WIRE UNION. The table is typed
 * `satisfies Record<ExecutionRequest["action"], CompletionContract>`, so an action that reaches the wire without a row
 * is a COMPILE error instead of a receipt that quietly falls through to `return false`. It used to be a `switch` over
 * the same ids with `default: return false`: fail-closed at run time and silent at authoring time, which is how seven
 * registered, dispatchable actions (furniture pickup, furniture rotation, fence removal, fish-tank deposit, pedestal
 * deposit, geode opening, fishing) stayed unread for as long as nobody ran the coverage gate.
 *
 * EVERY ROW IS THE MOD'S OWN EVIDENCE VOCABULARY, not a second opinion about the game. The keys are the fields the
 * handler PRINTS and the predicate restates the handler's own success condition from them - `removed === "true"`, the
 * pack losing exactly one, the geode count falling, `Farmer.fishCaught` rising. A row may not invent a field to reach a
 * verdict: if a receipt cannot be read, the producer is what has to change.
 *
 * A ROW MAY NOT BE UNIFORM, AND THE ONES THAT ARE NOT SAY SO. Most rows are one shape (`reasonCode` plus one declared key
 * set): 68 of the 102. The rest keep the predicate they need rather than being flattened - 7 rows accept MORE THAN ONE
 * terminal, each with its own evidence shape (`equip_tool`'s `tool_equipped`/`already_equipped`, `scythe_crop`'s harvest
 * and its dead-crop clear, `dismiss_modal`'s dismissal and the settlement commit already under way), and 34 delegate to
 * a named predicate because their evidence grammar is not one key list (`sleep`'s detail carries a duplicate key the
 * key/value parser must refuse, so its row reads field membership; `cook_recipe` passes `dropped_output` because one
 * action has two delivery branches). `cook_recipe` and `interact_npc_with_item` are in both groups at once, which is why
 * a table that claimed one uniform shape would be lying.
 *
 * THE FOLD AT THE END IS THE ONLY ENTRY POINT. It holds the two facts common to every action - the receipt says
 * `succeeded` and carries a bounded non-empty `detail` - and hands the rest to the row.
 */

/** What one row is handed: the terminal the receipt claims, and the evidence it claims it from. */
type CompletionClaim = Readonly<{
  /** The `reasonCode` the Mod minted with this receipt. */
  reasonCode: string;
  /** The receipt's evidence string, already narrowed to a non-empty bounded string by the fold's guard. */
  detail: string;
}>;

/** One action's completion contract: the couple `(terminal, evidence shape)` its own handler mints. */
export type CompletionContract = (claim: CompletionClaim) => boolean;

/** The four lowercase boolean spellings the Mod writes with `bool.ToString().ToLowerInvariant()`. */
function booleanEvidenceValue(value: string | undefined): boolean {
  return value === "true" || value === "false";
}

/** The six actor body slots the wearable family publishes
 * (farmhandexecutioncontroller.actorstateactions.cs:146). */
function isWearableBodySlot(value: string | undefined): boolean {
  return (
    value === "hat" ||
    value === "boots" ||
    value === "shirt" ||
    value === "pants" ||
    value === "left_ring" ||
    value === "right_ring"
  );
}

/** The two storage kinds the container family can resolve (a player chest or the fridge). */
function isStorageContainerKind(value: string | undefined): boolean {
  return value === "chest" || value === "fridge";
}

/**
 * movementactions.cs:611-617 CompleteTravelAfterWarp for select_mine_elevator_floor.
 * Floor 0 targets the mine-entrance MAP and emits only the expected/actual pair; a
 * generated floor lands in a MineShaft and appends `level`. In both shapes only the
 * destination LOCATION is a postcondition - the native layout picks the landing tile.
 */
function hasMineElevatorFloorCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const keys = Object.keys(evidence);
  const generatedFloor = keys.length === 3 && "level" in evidence;
  if (keys.length !== 2 && !generatedFloor) return false;
  if (!("expected" in evidence) || !("actual" in evidence)) return false;
  if (generatedFloor && positiveIntegerEvidence(evidence.level) === null) return false;
  return (
    hasOpaqueEvidenceValue(evidence.expected) &&
    hasOpaqueEvidenceValue(evidence.actual) &&
    evidence.expected.split(":")[0] === evidence.actual.split(":")[0]
  );
}

/**
 * The three producer shapes of enter_mine's `mine_entered` terminal:
 *   transportactions.cs:194  level;tile;from_level — ladder descent, synchronous;
 *   transportactions.cs:232  level;tile            — mine entrance, synchronous;
 *   movementactions.cs:611-617 expected;actual;level — the asynchronous Warped arrival,
 *     where the native MineShaft layout owns the landing tile.
 * All three prove the same declared/reached level; none is admitted with a foreign shape.
 */
/**
 * `use_mine_ladder`'s two real completions.
 *
 * <para>
 * The synchronous one is the answer itself: the game's `ExitMine_Leave` response performs the warp inside
 * `GameLocation.answerDialogueAction`, so the receipt states which question was asked and which response settled it
 * beside where the actor ended up. The asynchronous one is the shared travel receipt, whose evidence is the
 * expected/actual destination pair because the landing tile belongs to the game's own warp.
 * </para>
 */
function hasMineExitCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const keys = Object.keys(evidence);
  if (
    keys.length === 5 &&
    "from" in evidence &&
    "question" in evidence &&
    "response" in evidence &&
    "ladder" in evidence &&
    "actual" in evidence
  )
    return (
      hasOpaqueEvidenceValue(evidence.from) &&
      evidence.question === "ExitMine" &&
      evidence.response === "Leave" &&
      hasTileEvidenceValue(evidence.ladder) &&
      hasOpaqueEvidenceValue(evidence.actual)
    );
  if (keys.length === 2 && "expected" in evidence && "actual" in evidence)
    return (
      hasOpaqueEvidenceValue(evidence.expected) &&
      hasOpaqueEvidenceValue(evidence.actual) &&
      evidence.expected.split(":")[0] === evidence.actual.split(":")[0]
    );
  return false;
}

function hasMineEntryCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const keys = Object.keys(evidence);
  if (keys.length === 3 && "level" in evidence && "tile" in evidence && "from_level" in evidence)
    return (
      positiveIntegerEvidence(evidence.level) !== null &&
      positiveIntegerEvidence(evidence.from_level) !== null &&
      hasTileEvidenceValue(evidence.tile)
    );
  if (keys.length === 2 && "level" in evidence && "tile" in evidence)
    return positiveIntegerEvidence(evidence.level) !== null && hasTileEvidenceValue(evidence.tile);
  if (keys.length === 3 && "expected" in evidence && "actual" in evidence && "level" in evidence)
    return (
      hasOpaqueEvidenceValue(evidence.expected) &&
      hasOpaqueEvidenceValue(evidence.actual) &&
      evidence.expected.split(":")[0] === evidence.actual.split(":")[0] &&
      positiveIntegerEvidence(evidence.level) !== null
    );
  return false;
}

/**
 * The gift branch of interact_npc_with_item
 * (farmhandexecutioncontroller.machinesanimalsitemsactions.cs:885-889). Succeeded is exactly
 * `giftGiven && consumedExactlyOne && (giftRecorded || pointsChanged)`, and the native answer
 * is asked with `showResponse: false`, so no dialogue may have been mounted.
 */
function hasGiftGivenCompletionEvidence(detail: string): boolean {
  return declaredCompletionEvidence(
    detail,
    [
      "location",
      "target",
      "tile",
      "npc",
      "item",
      "slot",
      "stack_before",
      "points_before",
      "gifts_today_before",
      "gifts_this_week_before",
      "quest_25_completed_before",
      "stack_after",
      "points_after",
      "gifts_today_after",
      "gifts_this_week_after",
      "quest_25_completed_after",
      "update_gift_limit",
      "showed_response",
      "gift_recorded",
      "points_changed",
      "spouse_jealousy",
      "spouse_points_before",
      "spouse_points_after",
      "menu_open_after",
      "dialogue_open_after",
    ],
    (e) =>
      hasBoundedNonemptyEvidenceValue(e.location) &&
      hasOpaqueIdEvidenceValue(e.target) &&
      hasTileEvidenceValue(e.tile) &&
      hasOpaqueEvidenceValue(e.npc) &&
      hasOpaqueEvidenceValue(e.item) &&
      validSlot(e.slot) &&
      positiveIntegerEvidence(e.stack_before) !== null &&
      signedIntegerEvidenceValue(e.points_before) !== null &&
      integerEvidenceValue(e.gifts_today_before) !== null &&
      integerEvidenceValue(e.gifts_this_week_before) !== null &&
      booleanEvidenceValue(e.quest_25_completed_before) &&
      integerEvidenceValue(e.stack_after) !== null &&
      Number(e.stack_after) === Number(e.stack_before) - 1 &&
      signedIntegerEvidenceValue(e.points_after) !== null &&
      integerEvidenceValue(e.gifts_today_after) !== null &&
      integerEvidenceValue(e.gifts_this_week_after) !== null &&
      booleanEvidenceValue(e.quest_25_completed_after) &&
      booleanEvidenceValue(e.update_gift_limit) &&
      e.showed_response === "false" &&
      booleanEvidenceValue(e.gift_recorded) &&
      booleanEvidenceValue(e.points_changed) &&
      (e.gift_recorded === "true" || e.points_changed === "true") &&
      booleanEvidenceValue(e.spouse_jealousy) &&
      signedIntegerEvidenceValue(e.spouse_points_before) !== null &&
      signedIntegerEvidenceValue(e.spouse_points_after) !== null &&
      booleanEvidenceValue(e.menu_open_after) &&
      booleanEvidenceValue(e.dialogue_open_after),
  );
}

/**
 * The delivery-quest branch of interact_npc_with_item
 * (farmhandexecutioncontroller.machinesanimalsitemsactions.cs:747-769). Succeeded is exactly
 * `deliveryCompleted && consumedRequiredNumber && noModalMounted`, where `noModalMounted` is the
 * receipt's own `dialogue_open_after=false && menu_open_after=false` pair.
 */
function hasQuestItemDeliveredCompletionEvidence(detail: string): boolean {
  return declaredCompletionEvidence(
    detail,
    [
      "location",
      "target",
      "tile",
      "npc",
      "item",
      "slot",
      "stack_before",
      "points_before",
      "gifts_today_before",
      "gifts_this_week_before",
      "quest_25_completed_before",
      "quest_id",
      "quest_target",
      "quest_item",
      "quest_number",
      "quest_daily",
      "quest_completed_before",
      "quest_completed_after",
      "quest_stays_in_log",
      "completed_quests_before",
      "completed_quests_after",
      "stack_after",
      "points_after",
      "friendship_amount",
      "quest_25_completed_after",
      "showed_response",
      "dialogue_open_after",
      "menu_open_after",
    ],
    (e) => {
      const stackBefore = positiveIntegerEvidence(e.stack_before);
      const requiredNumber = positiveIntegerEvidence(e.quest_number);
      const stackAfter = integerEvidenceValue(e.stack_after);
      return (
        hasBoundedNonemptyEvidenceValue(e.location) &&
        hasOpaqueIdEvidenceValue(e.target) &&
        hasTileEvidenceValue(e.tile) &&
        hasOpaqueEvidenceValue(e.npc) &&
        hasOpaqueEvidenceValue(e.item) &&
        validSlot(e.slot) &&
        stackBefore !== null &&
        signedIntegerEvidenceValue(e.points_before) !== null &&
        integerEvidenceValue(e.gifts_today_before) !== null &&
        integerEvidenceValue(e.gifts_this_week_before) !== null &&
        booleanEvidenceValue(e.quest_25_completed_before) &&
        hasBoundedNonemptyEvidenceValue(e.quest_id) &&
        hasOpaqueEvidenceValue(e.quest_target) &&
        hasOpaqueEvidenceValue(e.quest_item) &&
        requiredNumber !== null &&
        booleanEvidenceValue(e.quest_daily) &&
        e.quest_completed_before === "false" &&
        e.quest_completed_after === "true" &&
        booleanEvidenceValue(e.quest_stays_in_log) &&
        integerEvidenceValue(e.completed_quests_before) !== null &&
        integerEvidenceValue(e.completed_quests_after) !== null &&
        Number(e.completed_quests_after) >= Number(e.completed_quests_before) &&
        stackAfter !== null &&
        stackAfter === stackBefore - requiredNumber &&
        signedIntegerEvidenceValue(e.points_after) !== null &&
        positiveIntegerEvidence(e.friendship_amount) !== null &&
        booleanEvidenceValue(e.quest_25_completed_after) &&
        e.showed_response === "false" &&
        e.dialogue_open_after === "false" &&
        e.menu_open_after === "false"
      );
    },
  );
}

/**
 * advance_day's `day_advanced` terminal, read by exact field membership because
 * SleepAndAdvanceDayLifecycle.BuildReceiptEvidence (:863-894) appends its settlement block to a
 * base list that already carries `topology`, so the duplicate-rejecting key/value parser cannot
 * read the detail at all. `day_started_observed=true` is the marker the lifecycle gates the
 * `passed` terminal on (DecideDayStart => Confirmed, :811-813).
 */
function hasDayAdvancedCompletionEvidence(detail: string): boolean {
  const fields = detail.split(";");
  return (
    fields.includes("state=passed") &&
    fields.includes("reason=day_advanced") &&
    fields.includes("day_started_observed=true")
  );
}

/**
 * The shared body of water_pet_bowl and water_slime_hutch_trough
 * (farmhandexecutioncontroller.petbowlactions.cs:98-115,
 * farmhandexecutioncontroller.slimehutchtroughactions.cs:121-138). Both run the same native
 * watering-tool path, so both owe the same relation water_crop already asserts: the watered
 * flag flipped from false to true, at most one unit left the can (a bottomless can or an
 * enchantment legitimately consumes none), and the embodied stamina half closes.
 */
function hasWateringToolCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "before_watered",
    "after_watered",
    "water_before",
    "water_after",
    "water_consumed",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
    "native_menu_opened",
    "tool_selected",
    "slot",
    "tool_before",
    "slot_before",
    "tool_restored",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const before = integerEvidenceValue(evidence.water_before);
  const after = integerEvidenceValue(evidence.water_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    hasToolSelectionEvidence(evidence, "watering_can") &&
    evidence.before_watered === "false" &&
    evidence.after_watered === "true" &&
    before !== null &&
    after !== null &&
    after <= before &&
    before - after <= 1 &&
    evidence.water_consumed === "true" &&
    evidence.native_menu_opened === "false" &&
    hasStaminaConservationEvidence(evidence)
  );
}

/**
 * cook_recipe's two Succeeded terminals (farmhandexecutioncontroller.cookingactions.cs:244-253).
 * `droppedOutput` selects the branch: false is `dish_cooked` (the whole dish entered the
 * backpack), true is `dish_cooked_dropped_on_ground` (a full backpack, whole dish dropped).
 * The partially-dropped terminal is PartiallySucceeded and never reaches this rule.
 */
function hasCookRecipeCompletionEvidence(detail: string, droppedOutput: boolean): boolean {
  return declaredCompletionEvidence(
    detail,
    [
      "location",
      "recipe",
      "station",
      "crafted",
      "crafted_stack",
      "quality",
      "seasoning_used",
      "space_prechecked",
      "inventory_before",
      "inventory_after",
      "delivered",
      "dropped",
      "disposition",
      "recipes_cooked_before",
      "recipes_cooked_after",
      "count_incremented",
      "native_menu_opened",
      "native_entry",
    ],
    (e) => {
      const craftedStack = positiveIntegerEvidence(e.crafted_stack);
      const delivered = integerEvidenceValue(e.delivered);
      const dropped = integerEvidenceValue(e.dropped);
      const cookedBefore = integerEvidenceValue(e.recipes_cooked_before);
      const cookedAfter = integerEvidenceValue(e.recipes_cooked_after);
      return (
        hasBoundedNonemptyEvidenceValue(e.location) &&
        hasOpaqueEvidenceValue(e.recipe) &&
        hasBoundedNonemptyEvidenceValue(e.station) &&
        e.station.includes("@") &&
        hasOpaqueEvidenceValue(e.crafted) &&
        craftedStack !== null &&
        integerEvidenceValue(e.quality) !== null &&
        // `seasoning_used={seasoning is not null}` is the one boolean the cooking
        // producer interpolates without ToLowerInvariant, so it is spelled Title-case.
        (e.seasoning_used === "True" || e.seasoning_used === "False") &&
        booleanEvidenceValue(e.space_prechecked) &&
        integerEvidenceValue(e.inventory_before) !== null &&
        integerEvidenceValue(e.inventory_after) !== null &&
        delivered !== null &&
        dropped !== null &&
        delivered === craftedStack - dropped &&
        Number(e.inventory_after) === Number(e.inventory_before) + delivered &&
        (droppedOutput
          ? dropped > 0 && delivered === 0 && e.disposition === "dropped_on_ground"
          : dropped === 0 && delivered > 0 && e.disposition === "inventory") &&
        cookedBefore !== null &&
        cookedAfter !== null &&
        cookedAfter === cookedBefore + 1 &&
        e.count_incremented === "true" &&
        hasBoundedNonemptyEvidenceValue(e.native_entry) &&
        e.native_menu_opened === "false"
      );
    },
  );
}

/**
 * One completion rule's evidence contract, declared as a SET rather than a key count.
 *
 * `required` ⊆ emitted ⊆ `required ∪ optional`. The count form this replaced
 * (`Object.keys(evidence).length === expectedKeys.length`) made every extra producer field a contract break rather
 * than a producer bug to look at, and it shipped that way twice: `dismiss_modal` appends `text=` whenever the box has
 * text, and the shipping commit's `close_effect=engine_shipping_commit` was not among the accepted values, so both of
 * that action's real successes were unreadable to the Host. A field a producer may publish and a field the rule
 * requires are different statements; only the second belongs in `required`.
 *
 * THE NAME CARRIES A CONSTRAINT, so do not shorten it back to `declaredEvidence`:
 * `tools/check-stardew-postcondition-delta` derives the Host contract population from the rows whose text mentions
 * `CompletionEvidence`, and the short name drops most rows out of that gate while every one of them still reads
 * exactly as before (measured when the population was a switch: 34 contracts under `declaredEvidence`, 95 under
 * this name, key sets identical).
 */
function declaredCompletionEvidence(
  detail: string,
  required: readonly string[],
  validate: (evidence: Readonly<Record<string, string>>) => boolean,
  optional: readonly string[] = [],
): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  if (!required.every((key) => key in evidence)) return false;
  const declared = new Set([...required, ...optional]);
  if (!Object.keys(evidence).every((key) => declared.has(key))) return false;
  return validate(evidence);
}
function validSlot(value: string | undefined): boolean {
  const slot = integerEvidenceValue(value);
  return slot !== null && slot <= 36;
}
function decremented(before: string | undefined, after: string | undefined): boolean {
  const left = integerEvidenceValue(before);
  const right = integerEvidenceValue(after);
  return left !== null && right !== null && right === left - 1;
}

/** The exact +1 counterpart of `decremented`, for a transfer's receiving side. */
function incremented(before: string | undefined, after: string | undefined): boolean {
  const left = integerEvidenceValue(before);
  const right = integerEvidenceValue(after);
  return left !== null && right !== null && right === left + 1;
}

function hasNavigationCompletionEvidence(detail: string): boolean {
  // The Mod emits exactly this navigation_completed evidence only from a fresh
  // post-warp coordinator re-read at the destination. It contains only the
  // canonical opaque destination identity and a fresh actual location assertion
  // together with the two Mod postcondition markers; never a route/tile/warp.
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = ["destination", "location", "arrived", "postcondition"];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  return (
    hasOpaqueEvidenceValue(evidence.destination) &&
    hasOpaqueEvidenceValue(evidence.location) &&
    evidence.arrived === "true" &&
    evidence.postcondition === "true"
  );
}

function hasMoveToTileCompletionEvidence(detail: string): boolean {
  return declaredCompletionEvidence(detail, ["tile", "target", "arrival", "path"], (e) => {
    const target = parseCanonicalIntegralTile(e.target);
    const tile = parseFormatTile(e.tile);
    return (
      target !== null &&
      tile !== null &&
      canBeSerializedExactArrival(tile, target) &&
      e.arrival === "exact" &&
      e.path === "stardew_native"
    );
  });
}

/**
 * The request producer admits integral [0, 1000] target tiles and serializes
 * them with `:0.##`; preserve that canonical integer spelling in the receipt.
 */
function parseCanonicalIntegralTile(value: string | undefined): readonly [number, number] | null {
  if (value === undefined) return null;
  const match = /^(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/.exec(value);
  if (match === null) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return x <= 1000 && y <= 1000 ? [x, y] : null;
}

/** Parses exactly the nonnegative canonical output grammar of C# `:0.##`. */
function parseFormatTile(value: string | undefined): readonly [number, number] | null {
  if (value === undefined) return null;
  // `:0.##` omits a zero fractional part and never retains a trailing zero.
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{0,1}[1-9]))?,(0|[1-9][0-9]*)(?:\.([0-9]{0,1}[1-9]))?$/.exec(value);
  if (match === null) return null;
  const x = Number(match[1]) + Number(`0.${match[2] ?? "0"}`);
  const y = Number(match[3]) + Number(`0.${match[4] ?? "0"}`);
  // A successful requested edge tile may round to 1000.2; the exact-arrival
  // relation below imposes the tighter target-relative bound.
  return x <= 1000.2 && y <= 1000.2 ? [x, y] : null;
}

function canBeSerializedExactArrival(tile: readonly [number, number], target: readonly [number, number]): boolean {
  // The producer succeeds when |actual - target|² <= 0.04 (radius 0.2).
  // `:0.##` quantizes each displayed coordinate by at most 0.005, so an
  // emitted coordinate q is possible iff max(|q-target|-0.005, 0) per axis
  // can still lie within that radius. This rejects tiles definitely outside
  // every successful producer value without inventing a looser tolerance.
  const x = Math.max(Math.abs(tile[0] - target[0]) - 0.005, 0);
  const y = Math.max(Math.abs(tile[1] - target[1]) - 0.005, 0);
  return x * x + y * y <= 0.04;
}

/**
 * The receipt-detail keys a `till_soil` success publishes, declared ONCE.
 *
 * The Mod states its own copy in `ToolActionEvidence.TillSoil` and
 * `DeclaredToolSelectionTests.EveryToolActionStillPublishesExactlyTheEvidenceKeysTheHostPins` compares the two, so a
 * key added on one side and not the other fails there rather than in a live run. `charge_requested` and
 * `charge_applied` are separate keys because a charge above the held tool's ceiling is REFUSED rather than clamped:
 * the two being equal is the receipt's own proof that the swing was performed at the charge the caller named.
 * `window`, `tiles_changed` and `changed` describe what the ONE native use actually touched - a measured consequence
 * of the engine's own footprint, never the completion condition.
 */
const TILL_SOIL_EVIDENCE_KEYS = Object.freeze([
  "location",
  "target",
  "tool_selected",
  "slot",
  "tool_before",
  "slot_before",
  "before",
  "after",
  "charge_requested",
  "charge_applied",
  "window",
  "tiles_changed",
  "changed",
  "stamina_before",
  "stamina_after",
  "stamina_delta",
  "expected_stamina_cost",
  "tool_restored",
]);

/** The same declaration for `water_crop`, plus `water_expected_cost` (the engine spends `power + 1` water, not one). */
const WATER_CROP_EVIDENCE_KEYS = Object.freeze([
  "location",
  "target",
  "tile",
  "tool_selected",
  "slot",
  "tool_before",
  "slot_before",
  "before_watered",
  "after_watered",
  "water_before",
  "water_after",
  "water_consumed",
  "water_expected_cost",
  "charge_requested",
  "charge_applied",
  "window",
  "tiles_changed",
  "changed",
  "stamina_before",
  "stamina_after",
  "stamina_delta",
  "expected_stamina_cost",
  "tool_restored",
]);

/**
 * The receipt-detail keys a `sweep_scythe` success publishes, declared ONCE on each end (the Mod's copy is
 * `ToolActionEvidence.SweepScythe`) and compared by
 * `DeclaredToolSelectionTests.EveryToolActionStillPublishesExactlyTheEvidenceKeysTheHostPins`.
 *
 * `arc_tiles`/`arc_sweepable`/`arc_clear` describe the arc the engine's own six rectangles sampled: how many tiles it
 * held, how many carried something a scythe cuts, and how many carried nothing at all. Unlike the charged tools'
 * `window`, that set is not a superset - it is the exact tiles the engine samples - so "already clear" is a measurement
 * here rather than a class the Mod cannot tell apart. `changed` names the tiles that MOVED, each with what stood there
 * before the swing, because after a successful cut the tile is empty and the kind would be unrecoverable. No key claims
 * a hit, a kill or a projectile: six `DoDamage` evaluations are not vanilla's seven.
 */
const SWEEP_SCYTHE_EVIDENCE_KEYS = Object.freeze([
  "location",
  "target",
  "before_occupant",
  "after_occupant",
  "named_moved",
  "arc_tiles",
  "arc_sweepable",
  "arc_clear",
  "changed",
  "tiles_changed",
  "tool_selected",
  "slot",
  "tool_before",
  "slot_before",
  "stamina_before",
  "stamina_after",
  "stamina_delta",
  "expected_stamina_cost",
  "tool_restored",
]);

/** The tool-charge facts both generated-tool rows publish, read as one shape. */
function hasToolChargeEvidence(evidence: Readonly<Record<string, string>>): boolean {
  const requested = integerEvidenceValue(evidence.charge_requested);
  const applied = integerEvidenceValue(evidence.charge_applied);
  return (
    requested !== null &&
    applied !== null &&
    // `0` is the uncharged tap and covers exactly the named tile; 5 is the top of the engine's ladder
    // (`Tool.tilesAffected`'s last case is `power >= 6`, Tool.cs:1062).
    requested <= 5 &&
    // Refused rather than clamped, so a receipt that says otherwise is reporting a swing the caller did not ask for.
    applied === requested
  );
}

/**
 * The box a charged swing scanned and the tiles it moved, as `x:y|x:y` (or `none`).
 *
 * `tiles_changed` is the count of `changed` and nothing else - the Mod never publishes a number it did not read, so a
 * mismatch here means the receipt was assembled from two different reads.
 */
function hasAreaFootprintEvidence(evidence: Readonly<Record<string, string>>): boolean {
  const box = /^(-?(?:0|[1-9][0-9]*)),(-?(?:0|[1-9][0-9]*)):(-?(?:0|[1-9][0-9]*)),(-?(?:0|[1-9][0-9]*))$/.exec(
    evidence.window ?? "",
  );
  const changed = evidence.changed;
  const tilesChanged = integerEvidenceValue(evidence.tiles_changed);
  if (box === null || changed === undefined || tilesChanged === null) return false;
  const left = Number(box[1]);
  const top = Number(box[2]);
  const right = Number(box[3]);
  const bottom = Number(box[4]);
  // The scanned box is a real box, which is what makes it a superset of the footprint rather than a decorative field.
  if (!(left < right && top < bottom)) return false;
  if (changed === "none") return tilesChanged === 0;
  const tiles = changed.split("|");
  if (tiles.length !== tilesChanged) return false;
  return tiles.every((tile) => {
    const match = /^(-?(?:0|[1-9][0-9]*)):(-?(?:0|[1-9][0-9]*))$/.exec(tile);
    if (match === null) return false;
    const x = Number(match[1]);
    const y = Number(match[2]);
    return x >= left && x <= right && y >= top && y <= bottom;
  });
}

function hasTillSoilCompletionEvidence(detail: string): boolean {
  return declaredCompletionEvidence(detail, TILL_SOIL_EVIDENCE_KEYS, (evidence) => {
    return (
      hasBoundedNonemptyEvidenceValue(evidence.location) &&
      evidence.location !== "none" &&
      hasTileEvidenceValue(evidence.target) &&
      hasToolSelectionEvidence(evidence, "hoe") &&
      evidence.before === "none" &&
      evidence.after === "HoeDirt" &&
      hasToolChargeEvidence(evidence) &&
      hasAreaFootprintEvidence(evidence) &&
      hasStaminaConservationEvidence(evidence)
    );
  });
}

function hasWaterCropCompletionEvidence(detail: string): boolean {
  return declaredCompletionEvidence(detail, WATER_CROP_EVIDENCE_KEYS, (evidence) => {
    const before = integerEvidenceValue(evidence.water_before);
    const after = integerEvidenceValue(evidence.water_after);
    const expected = integerEvidenceValue(evidence.water_expected_cost);
    return (
      hasBoundedNonemptyEvidenceValue(evidence.location) &&
      evidence.location !== "none" &&
      hasOpaqueIdEvidenceValue(evidence.target) &&
      hasTileEvidenceValue(evidence.tile) &&
      hasToolSelectionEvidence(evidence, "watering_can") &&
      evidence.before_watered === "false" &&
      evidence.after_watered === "true" &&
      before !== null &&
      after !== null &&
      expected !== null &&
      // THE ENGINE SPENDS WATER BY THE CHARGE, NOT BY THE TILE: `WaterLeft -= power + 1` (WateringCan.cs:189-191), so a
      // charge-4 watering of eighteen tiles spends 5 units, and a bottomless can spends none. The Mod publishes the
      // engine's own cost as `water_expected_cost` (`charge_applied + 1`, or 0 for a bottomless can) and this checks the
      // measured drop against it exactly, rather than accepting a fixed one-unit window that was only ever right for an
      // uncharged tap.
      before - after === expected &&
      evidence.water_consumed === "true" &&
      hasToolChargeEvidence(evidence) &&
      hasAreaFootprintEvidence(evidence) &&
      hasStaminaConservationEvidence(evidence)
    );
  });
}

/**
 * The arc one scythe swing sampled and the tiles it moved, as `x:y:kind|x:y:kind` (or `none`).
 *
 * The three counts partition the arc, and the changed set is a subset of the tiles that carried something cuttable - so a
 * receipt assembled from two different reads fails here instead of reaching a caller as an area nobody swung at.
 */
function hasScytheSweepArcEvidence(evidence: Readonly<Record<string, string>>): boolean {
  const arcTiles = integerEvidenceValue(evidence.arc_tiles);
  const arcSweepable = integerEvidenceValue(evidence.arc_sweepable);
  const arcClear = integerEvidenceValue(evidence.arc_clear);
  const tilesChanged = integerEvidenceValue(evidence.tiles_changed);
  if (arcTiles === null || arcSweepable === null || arcClear === null || tilesChanged === null) return false;
  // A swing that happened sampled a real arc, and the Mod refuses an arc with nothing cuttable on it BEFORE swinging
  // (`sweep_nothing_to_cut`), so a success reporting either is describing a different swing.
  if (!(arcTiles > 0) || !(arcSweepable > 0)) return false;
  // The arc's counts partition it: a tile is sweepable, clear, or holding something a scythe does not cut.
  if (arcSweepable + arcClear > arcTiles) return false;
  // `changed` measures tiles the arc sampled and nothing else, and every one of them was sweepable before the swing.
  if (!(tilesChanged > 0) || tilesChanged > arcSweepable) return false;
  const changed = evidence.changed ?? "";
  if (changed === "none") return false;
  const entries = changed.split("|");
  if (entries.length !== tilesChanged) return false;
  return entries.every((entry) => /^-?(?:0|[1-9][0-9]*):-?(?:0|[1-9][0-9]*):[a-z][a-z_]*$/.test(entry));
}

/**
 * `sweep_scythe`'s completion: the tile the caller NAMED moved, and the receipt says how far the swing's arc reached.
 *
 * `hasStardewCompletionEvidence` only reaches a contract for a `succeeded` receipt, so a partial sweep
 * (`scythe_sweep_partial`, `PartiallySucceeded`) never claims completion through this rule.
 */
function hasSweepScytheCompletionEvidence(detail: string): boolean {
  return declaredCompletionEvidence(detail, SWEEP_SCYTHE_EVIDENCE_KEYS, (evidence) => {
    return (
      hasBoundedNonemptyEvidenceValue(evidence.location) &&
      evidence.location !== "none" &&
      hasTileEvidenceValue(evidence.target) &&
      hasOpaqueEvidenceValue(evidence.before_occupant) &&
      hasOpaqueEvidenceValue(evidence.after_occupant) &&
      // The named tile's own transition is the completion condition, stated as the fact it is: a weed that lost one point
      // of health still reads `weed` on both sides, so the two occupancy words alone cannot carry this claim.
      evidence.named_moved === "true" &&
      hasToolSelectionEvidence(evidence, "scythe") &&
      hasScytheSweepArcEvidence(evidence) &&
      hasStaminaConservationEvidence(evidence)
    );
  });
}

/** Parses bounded key/value evidence without accepting duplicate fields. */
function parseSemicolonEvidence(detail: string): Readonly<Record<string, string>> | null {
  const result: Record<string, string> = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) return null;
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (
      !(key in result) &&
      // Camel-case keys are legal: the frozen pickup_forage contract names its key
      // `targetIdentity`, and a lower-case-only grammar made that evidence
      // unparseable, so the action could never complete. The point of this check is
      // to reject protocol scalar sentinels and junk, not to forbid capitals.
      /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) &&
      value.length <= 512
    ) {
      result[key] = value;
      continue;
    }
    return null;
  }
  return result;
}

// Evidence values are serialized with up to four decimal places; allow rounding plus binary floating-point noise.
const STAMINA_EVIDENCE_EPSILON = 0.011;

/**
 * Family-level embodied conservation: every tool action mutation has two halves
 * (world + agent stamina). A succeeded receipt must prove the stamina half
 * closes the loop: before/after/delta/expected all present, delta consistent
 * with before→after, and the actual spend equals the native formula so a
 * power/formula drift (e.g. power=0 feeding stamina back) is caught here.
 */
function hasStaminaConservationEvidence(evidence: Readonly<Record<string, string>>): boolean {
  const staminaBefore = finiteEvidenceValue(evidence.stamina_before);
  const staminaAfter = finiteEvidenceValue(evidence.stamina_after);
  const staminaDelta = finiteEvidenceValue(evidence.stamina_delta);
  const expectedStaminaCost = finiteEvidenceValue(evidence.expected_stamina_cost);
  return (
    staminaBefore !== null &&
    staminaAfter !== null &&
    staminaDelta !== null &&
    expectedStaminaCost !== null &&
    Math.abs(staminaAfter - staminaBefore - staminaDelta) <= 0.001 &&
    Math.abs(-staminaDelta - expectedStaminaCost) <= STAMINA_EVIDENCE_EPSILON &&
    staminaDelta <= 0 &&
    expectedStaminaCost >= 0
  );
}

function hasDigArtifactSpotCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "result_target",
    "tile",
    "tool",
    "slot",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
    "qualified_item_id",
    "source_present_before",
    "source_present_after",
    "hoedirt_present_before",
    "hoedirt_present_after",
    "source_removed",
    "tool_selected",
    "tool_before",
    "slot_before",
    "tool_restored",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasOpaqueIdEvidenceValue(evidence.result_target) &&
    hasTileEvidenceValue(evidence.tile) &&
    evidence.tool === "hoe" &&
    hasToolSelectionEvidence(evidence, "hoe") &&
    slot !== null &&
    slot >= 0 &&
    slot <= 36 &&
    hasStaminaConservationEvidence(evidence) &&
    // Mirror the Mod's native predicate exactly: the diggable category is the two
    // ids `Object.cs:1310` routes through the single `t is Hoe` branch, not any id.
    // Accepting every id here would also admit a non-diggable item such as
    // `(O)388` (Wood).
    (evidence.qualified_item_id === "(O)590" || evidence.qualified_item_id === "(O)SeedSpot") &&
    evidence.source_present_before === "true" &&
    evidence.source_present_after === "false" &&
    evidence.hoedirt_present_before === "false" &&
    evidence.hoedirt_present_after === "true" &&
    evidence.source_removed === "true"
  );
}

function hasRefillWateringCanCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "target",
    "slot",
    "can",
    "water_before",
    "water_after",
    "water_max",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
    "tool_selected",
    "tool_before",
    "slot_before",
    "tool_restored",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const before = integerEvidenceValue(evidence.water_before);
  const after = integerEvidenceValue(evidence.water_after);
  const max = integerEvidenceValue(evidence.water_max);
  return (
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasOpaqueEvidenceValue(evidence.can) &&
    validSlot(evidence.slot) &&
    hasToolSelectionEvidence(evidence, "watering_can") &&
    before !== null &&
    after !== null &&
    max !== null &&
    before < max &&
    after === max &&
    hasStaminaConservationEvidence(evidence)
  );
}

function hasBreakRockSourceCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "target",
    "tool",
    "tool_selected",
    "slot",
    "tool_before",
    "slot_before",
    "qualified_item_id",
    "durability_before",
    "durability_after",
    "removed",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
    "tool_restored",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const durabilityBefore = integerEvidenceValue(evidence.durability_before);
  return (
    hasOpaqueIdEvidenceValue(evidence.target) &&
    evidence.tool === "pickaxe" &&
    hasToolSelectionEvidence(evidence, "pickaxe") &&
    // The rock the swing landed on is the NATIVE breakable-stone category
    // (`Category == -999 && Name == "Stone"`, Object.cs:6082), not `(O)2`: the mine's ore
    // nodes are 751/290/764/765/95 and the mountain's are 668/670/75/76/77, and all of
    // them are that category. Pinning one id refused every real rock that was not the
    // plain farm stone.
    hasBoundedNonemptyEvidenceValue(evidence.qualified_item_id) &&
    durabilityBefore !== null &&
    durabilityBefore >= 1 &&
    // SOURCE TRANSFORMATION, not "the swing landed": the rock must have LEFT the layer. A swing that only lowers
    // durability is a real, succeeded dispatch - the Mod reports it as `rock_source_damaged` - but this rule is the
    // completion boundary, so it asks the same question the tree rule asks (`stump_after === "true"`). What
    // durability_before may be is the rock's whole population (1-25), no longer just the one-swing value 1.
    evidence.durability_after === "removed" &&
    evidence.removed === "true" &&
    hasStaminaConservationEvidence(evidence)
  );
}

function hasBreakResourceClumpCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "parent",
    "required_upgrade",
    "tool",
    "tool_selected",
    "slot",
    "tool_before",
    "slot_before",
    "health_before",
    "health_after",
    "swings",
    "clump_removed",
    "drop_observed",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
    "tool_restored",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const tool = evidence.tool;
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    integerEvidenceValue(evidence.parent) !== null &&
    integerEvidenceValue(evidence.required_upgrade) !== null &&
    // The family is the CLUMP's own answer (ResourceClump.performToolAction branches per parentSheetIndex), so the
    // selection must be the tool the target demanded - not one the caller named.
    (tool === "axe" || tool === "pickaxe") &&
    hasToolSelectionEvidence(evidence, tool) &&
    integerEvidenceValue(evidence.swings) !== null &&
    (integerEvidenceValue(evidence.swings) ?? 0) >= 1 &&
    finiteEvidenceValue(evidence.health_before) !== null &&
    finiteEvidenceValue(evidence.health_after) !== null &&
    evidence.clump_removed === "true" &&
    evidence.drop_observed === "true" &&
    hasStaminaConservationEvidence(evidence)
  );
}

function hasClearHoeDirtCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "tool",
    "slot",
    "crop_before",
    "hoedirt_present_before",
    "hoedirt_present_after",
    "removed",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
    "tool_selected",
    "tool_before",
    "slot_before",
    "tool_restored",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    evidence.tool === "pickaxe" &&
    hasToolSelectionEvidence(evidence, "pickaxe") &&
    slot !== null &&
    slot >= 0 &&
    slot <= 36 &&
    evidence.crop_before === "false" &&
    evidence.hoedirt_present_before === "true" &&
    evidence.hoedirt_present_after === "false" &&
    evidence.removed === "true" &&
    hasStaminaConservationEvidence(evidence)
  );
}

function hasWoodFenceCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "source",
    "location",
    "x",
    "y",
    "target",
    "item",
    "slot",
    "source_empty_before",
    "is_fence",
    "is_gate",
    "health",
    "max_health",
    "inventory_before",
    "inventory_after",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const x = integerEvidenceValue(evidence.x);
  const y = integerEvidenceValue(evidence.y);
  const slot = integerEvidenceValue(evidence.slot);
  const health = finiteEvidenceValue(evidence.health);
  const maxHealth = finiteEvidenceValue(evidence.max_health);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    evidence.source === "(O)322" &&
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    x !== null &&
    x <= 1000 &&
    y !== null &&
    y <= 1000 &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    evidence.item === "(O)322" &&
    slot !== null &&
    slot <= 36 &&
    evidence.source_empty_before === "true" &&
    evidence.is_fence === "true" &&
    evidence.is_gate === "false" &&
    health !== null &&
    health > 0 &&
    maxHealth !== null &&
    maxHealth >= health &&
    before === 1 &&
    after === 0
  );
}

function hasBaitCrabPotCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "source",
    "location",
    "x",
    "y",
    "target",
    "pot",
    "slot",
    "owner",
    "bait_before",
    "bait_after",
    "inventory_before",
    "inventory_after",
    "actionable",
    "active_execution",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const x = integerEvidenceValue(evidence.x);
  const y = integerEvidenceValue(evidence.y);
  const slot = integerEvidenceValue(evidence.slot);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    evidence.source === "(O)685" &&
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    evidence.location !== "none" &&
    x !== null &&
    x <= 1000 &&
    y !== null &&
    y <= 1000 &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    evidence.pot === "(O)710" &&
    slot !== null &&
    slot <= 36 &&
    hasDecimalOwnerIdEvidenceValue(evidence.owner) &&
    evidence.bait_before === "none" &&
    evidence.bait_after === "(O)685" &&
    before === 1 &&
    after === 0 &&
    evidence.actionable === "true" &&
    evidence.active_execution === "null"
  );
}

function hasChopTreeSourceCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "target",
    "tool",
    "slot",
    "tree",
    "health_before",
    "health_after",
    "stump_before",
    "stump_after",
    "source_transformed",
    "swings",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
    "tool_selected",
    "tool_before",
    "slot_before",
    "tool_restored",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  // The action fells the tree inside ONE request now, so `health_before` is whatever durability the live tree carried
  // (ten for a mature tree, not the fixture's one) and `swings` is the number of native hits that took it to the
  // engine's felled state (`stump = true; health = 5f`, Tree.cs:1489-1497). The completion boundary is still the world:
  // the tree LEFT its standing state, and the receipt names the health pair and the swing count that did it.
  const healthBefore = finiteEvidenceValue(evidence.health_before);
  const swings = integerEvidenceValue(evidence.swings);
  return (
    hasOpaqueIdEvidenceValue(evidence.target) &&
    evidence.tool === "axe" &&
    validSlot(evidence.slot) &&
    hasToolSelectionEvidence(evidence, "axe") &&
    hasBoundedNonemptyEvidenceValue(evidence.tree) &&
    healthBefore !== null &&
    healthBefore > 0 &&
    evidence.health_after === "5" &&
    evidence.stump_before === "false" &&
    evidence.stump_after === "true" &&
    evidence.source_transformed === "true" &&
    swings !== null &&
    swings >= 1 &&
    hasStaminaConservationEvidence(evidence)
  );
}

function hasDoorTransitionCompletionEvidence(detail: string): boolean {
  // An ordinary warp/enter_exit emits exactly {expected, actual}: the ride's own
  // objective identity belongs to `ride_minecart`, whose terminal is separate.
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = ["expected", "actual"];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  return warpPostconditionHolds(evidence);
}

function hasMinecartRideCompletionEvidence(detail: string): boolean {
  // A minecart ride ends in the same Warped postcondition, but the ride has to
  // name which published objective it actually rode: the coordinate pair alone
  // cannot distinguish two destinations on one station tile.
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = ["expected", "actual", "network", "destination"];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  if (!hasBoundedNonemptyEvidenceValue(evidence.network)) return false;
  if (!hasBoundedNonemptyEvidenceValue(evidence.destination)) return false;
  return warpPostconditionHolds(evidence);
}

/** The Warped postcondition both `travel` and `ride_minecart` share. */
function warpPostconditionHolds(evidence: Readonly<Record<string, string>>): boolean {
  const expected = parseWarpDestination(evidence.expected);
  const actual = parseWarpDestination(evidence.actual);
  return (
    expected !== null &&
    actual !== null &&
    actual.location === expected.location &&
    actual.x === expected.x &&
    actual.y === expected.y
  );
}

/**
 * Parses the producer's `location:x,y` destination grammar. The location is
 * greedy up to the final colon so native names that themselves contain a
 * colon still round-trip; the trailing coordinates are canonical integers.
 */
function parseWarpDestination(value: string | undefined): { location: string; x: number; y: number } | null {
  if (value === undefined) return null;
  const match = /^(.*):(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/.exec(value);
  if (match === null) return null;
  const location = match[1];
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (!hasBoundedNonemptyEvidenceValue(location) || x > 1000 || y > 1000) return null;
  return { location, x, y };
}

function hasPickupForageCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = ["location", "targetIdentity", "tile", "item", "removed", "inventory_before", "inventory_after"];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.targetIdentity) &&
    hasTileEvidenceValue(evidence.tile) &&
    hasOpaqueEvidenceValue(evidence.item) &&
    evidence.removed === "true" &&
    before !== null &&
    after !== null &&
    after === before + 1
  );
}
function hasPickupItemCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "item",
    "stack",
    "native_auto_collect",
    "chunk_removed",
    "inventory_before",
    "inventory_after",
  ];
  // `reason` is the ONE optional key, and it exists only to explain `chunk_removed=false`.
  if (!expectedKeys.every((key) => key in evidence)) return false;
  if (Object.keys(evidence).some((key) => key !== "reason" && !expectedKeys.includes(key))) return false;
  const stack = integerEvidenceValue(evidence.stack);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    hasOpaqueEvidenceValue(evidence.item) &&
    stack !== null &&
    stack >= 1 &&
    evidence.native_auto_collect === "true" &&
    chunkRemovalAccountedFor(evidence) &&
    before !== null &&
    after !== null &&
    after >= before + stack
  );
}

/**
 * Whether the receipt's `chunk_removed` says what the Mod OBSERVED about the whole location.
 *
 * The ground and the backpack are two different authorities: the inventory delta proves the pickup, and the location
 * proves the removal. This validator used to require `chunk_removed=true` outright, which forced the Mod to state a
 * removal it had just disproved whenever the engine's cleanup left a chunk of the same identity on the ground
 * (measured 2026-10-25: `inventory_before=8;inventory_after=9` with the debris still present). A removal therefore
 * needs no excuse, and a surviving chunk must name itself with `reason=chunk_still_present`.
 */
function chunkRemovalAccountedFor(evidence: Readonly<Record<string, string>>): boolean {
  if (evidence.chunk_removed === "true") return !("reason" in evidence);
  return evidence.chunk_removed === "false" && evidence.reason === "chunk_still_present";
}

function hasHarvestCropCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "crop",
    "item",
    "native_path_return",
    "native_accepted",
    "regrows",
    "phase_before",
    "phase_after",
    "day_of_phase_before",
    "day_of_phase_after",
    "regrow_advanced",
    "inventory_before",
    "inventory_after",
    "inventory_gained",
    "crop_present_after",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const phaseBefore = integerEvidenceValue(evidence.phase_before);
  const dayOfPhaseBefore = integerEvidenceValue(evidence.day_of_phase_before);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  if (
    !hasBoundedNonemptyEvidenceValue(evidence.location) ||
    !hasOpaqueIdEvidenceValue(evidence.target) ||
    !hasTileEvidenceValue(evidence.tile) ||
    !hasOpaqueEvidenceValue(evidence.crop) ||
    !hasOpaqueEvidenceValue(evidence.item) ||
    evidence.native_accepted !== "true" ||
    evidence.inventory_gained !== "true" ||
    before === null ||
    after === null ||
    after <= before ||
    phaseBefore === null ||
    dayOfPhaseBefore === null
  )
    return false;
  if (evidence.regrows === "true") {
    // A regrowing harvest keeps the crop and advances its phase/day; the
    // native path return is deliberately unconstrained because the producer
    // documents that a successful regrow harvest normally falls through.
    const phaseAfter = integerEvidenceValue(evidence.phase_after);
    const dayOfPhaseAfter = integerEvidenceValue(evidence.day_of_phase_after);
    return (
      evidence.crop_present_after === "true" &&
      evidence.regrow_advanced === "true" &&
      phaseAfter !== null &&
      phaseAfter >= phaseBefore &&
      dayOfPhaseAfter !== null &&
      dayOfPhaseAfter > dayOfPhaseBefore
    );
  }
  if (evidence.regrows === "false") {
    // A non-regrowing harvest destroys the crop through the native path.
    return (
      evidence.crop_present_after === "false" &&
      evidence.phase_after === "none" &&
      evidence.day_of_phase_after === "none" &&
      evidence.native_path_return === "true"
    );
  }
  return false;
}

function hasFertilizeTileCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "item",
    "fertilizer_before",
    "fertilizer_after",
    "inventory_before",
    "inventory_after",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    hasOpaqueEvidenceValue(evidence.item) &&
    isNoneOrOpaqueEvidenceValue(evidence.fertilizer_before) &&
    evidence.fertilizer_after === evidence.item &&
    before !== null &&
    after !== null &&
    after === before - 1
  );
}

function hasPlaceCrabPotCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "source",
    "location",
    "x",
    "y",
    "target",
    "item",
    "slot",
    "source_empty_before",
    "is_crab_pot",
    "owner",
    "offset_x",
    "offset_y",
    "overlay_tiles",
    "inventory_before",
    "inventory_after",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const x = integerEvidenceValue(evidence.x);
  const y = integerEvidenceValue(evidence.y);
  const slot = integerEvidenceValue(evidence.slot);
  const offsetX = finiteEvidenceValue(evidence.offset_x);
  const offsetY = finiteEvidenceValue(evidence.offset_y);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    evidence.source === "(O)710" &&
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    x !== null &&
    x <= 1000 &&
    y !== null &&
    y <= 1000 &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    evidence.item === "(O)710" &&
    slot !== null &&
    slot <= 36 &&
    evidence.source_empty_before === "true" &&
    evidence.is_crab_pot === "true" &&
    hasDecimalOwnerIdEvidenceValue(evidence.owner) &&
    offsetX !== null &&
    offsetY !== null &&
    hasCrabPotOverlayEvidence(evidence.overlay_tiles) &&
    before !== null &&
    after !== null &&
    after === before - 1
  );
}

/**
 * The producer joins only count>0 overlay tiles as `x,y:count|...`; the
 * shared evidence grammar rejects empty values, so a completed receipt must
 * carry at least one overlay tile.
 */
function hasCrabPotOverlayEvidence(value: string | undefined): boolean {
  if (value === undefined) return false;
  return /^(?:0|[1-9][0-9]*),(?:0|[1-9][0-9]*):[1-9][0-9]*(?:\|(?:0|[1-9][0-9]*),(?:0|[1-9][0-9]*):[1-9][0-9]*)*$/.test(
    value,
  );
}

function hasMachineInspectCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "machine",
    "ready_for_harvest",
    "minutes_until_ready",
    "held",
    "last_input",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const minutes = signedIntegerEvidenceValue(evidence.minutes_until_ready);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    hasOpaqueEvidenceValue(evidence.machine) &&
    (evidence.ready_for_harvest === "true" || evidence.ready_for_harvest === "false") &&
    minutes !== null &&
    isNoneOrOpaqueEvidenceValue(evidence.held) &&
    isNoneOrOpaqueEvidenceValue(evidence.last_input)
  );
}

/**
 * A machine load is proved by what the MACHINE did with the input, not by which machine it was: the game's own
 * `Data/Machines` rows decide both the accepted input and the consumption count, so pinning a Keg and five coffee beans
 * here would only re-state one row of that table and refuse every other machine the Mod loaded.
 *
 * The equalities the pin used to encode are kept as INVARIANTS: the item consumed and the item the machine recorded are
 * the same item, the stack difference is exactly the count the machine's data declared, something is held afterwards,
 * the observed processing window equals the window the Mod derived from the same data, and readiness agrees with that
 * window (Object.OutputMachine sets `readyForHarvest` exactly when the window is zero, Object.cs:2581-2585).
 */
function hasMachineLoadCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "machine",
    "slot",
    "input",
    "input_stack_before",
    "input_consumed",
    "input_stack_after",
    "last_input",
    "held",
    "ready_for_harvest",
    "minutes_until_ready",
    "expected_minutes_until_ready",
    "native_check_action",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  const stackBefore = integerEvidenceValue(evidence.input_stack_before);
  const stackAfter = integerEvidenceValue(evidence.input_stack_after);
  const consumed = positiveIntegerEvidence(evidence.input_consumed);
  const observedMinutes = integerEvidenceValue(evidence.minutes_until_ready);
  // The window is NOT a content constant: the Mod derives it from the matched machine rule plus the machine's
  // ReadyTimeModifiers and reports the derived expectation next to the observed value, so a rebalance cannot turn a
  // legitimate native load into either a false success or a false failure. A rule whose duration a custom output method
  // owns states `unavailable_in_machine_data`; there is then nothing to compare, and the observed window must still be
  // a real one.
  const windowDerived = evidence.expected_minutes_until_ready !== MACHINE_WINDOW_UNAVAILABLE;
  const expectedMinutes = windowDerived ? integerEvidenceValue(evidence.expected_minutes_until_ready) : null;
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    isQualifiedItemId(evidence.machine) &&
    slot !== null &&
    slot <= 36 &&
    isQualifiedItemId(evidence.input) &&
    stackBefore !== null &&
    stackBefore >= 1 &&
    consumed !== null &&
    stackAfter !== null &&
    stackBefore - stackAfter === consumed &&
    evidence.last_input === evidence.input &&
    isQualifiedItemId(evidence.held) &&
    observedMinutes !== null &&
    evidence.ready_for_harvest === (observedMinutes === 0 ? "true" : "false") &&
    (!windowDerived || (expectedMinutes !== null && expectedMinutes === observedMinutes)) &&
    evidence.native_check_action === "true"
  );
}

function hasMachineCollectOutputCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "machine",
    "output",
    "output_stack",
    "input",
    "ready_before",
    "minutes_until_ready_before",
    "inventory_output_before",
    "inventory_output_after",
    "held_after",
    "ready_after",
    "native_check_action",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const before = integerEvidenceValue(evidence.inventory_output_before);
  const after = integerEvidenceValue(evidence.inventory_output_after);
  const outputStack = positiveIntegerEvidence(evidence.output_stack);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    isQualifiedItemId(evidence.machine) &&
    isQualifiedItemId(evidence.output) &&
    (evidence.input === "none" || isQualifiedItemId(evidence.input)) &&
    outputStack !== null &&
    evidence.ready_before === "true" &&
    evidence.minutes_until_ready_before === "0" &&
    before !== null &&
    after !== null &&
    // The pack gained exactly the stack the machine was holding - not "one item", which is what a Keg happens to
    // produce and what a machine producing a stack would have been misreported as.
    after === before + outputStack &&
    evidence.held_after === "none" &&
    evidence.ready_after === "false" &&
    evidence.native_check_action === "true"
  );
}

function hasUseItemCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "slot",
    "item",
    "stack_before",
    "stack_after",
    "edibility",
    "drink",
    "stamina_before",
    "stamina_after",
    "health_before",
    "health_after",
    "animation_complete",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  const stackBefore = integerEvidenceValue(evidence.stack_before);
  const stackAfter = integerEvidenceValue(evidence.stack_after);
  const edibility = signedIntegerEvidenceValue(evidence.edibility);
  const staminaBefore = finiteEvidenceValue(evidence.stamina_before);
  const staminaAfter = finiteEvidenceValue(evidence.stamina_after);
  const healthBefore = integerEvidenceValue(evidence.health_before);
  const healthAfter = integerEvidenceValue(evidence.health_after);
  return (
    slot !== null &&
    slot <= 36 &&
    hasOpaqueEvidenceValue(evidence.item) &&
    stackBefore !== null &&
    stackBefore >= 1 &&
    stackAfter !== null &&
    stackAfter === stackBefore - 1 &&
    edibility !== null &&
    (evidence.drink === "true" || evidence.drink === "false") &&
    staminaBefore !== null &&
    staminaAfter !== null &&
    healthBefore !== null &&
    healthBefore >= 0 &&
    healthAfter !== null &&
    healthAfter >= 0 &&
    evidence.animation_complete === "true"
  );
}

function hasFeedAnimalCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "slot",
    "native_handled",
    "trough_filled",
    "hay_before",
    "hay_after",
    "hay_consumed",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  const before = integerEvidenceValue(evidence.hay_before);
  const after = integerEvidenceValue(evidence.hay_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    slot !== null &&
    slot <= 36 &&
    evidence.native_handled === "true" &&
    evidence.trough_filled === "true" &&
    before !== null &&
    before >= 1 &&
    after !== null &&
    after === before - 1 &&
    evidence.hay_consumed === "true"
  );
}

function hasCollectAnimalProductCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "animal",
    "tool",
    "produce",
    "produce_stack",
    "produce_cleared",
    "inventory_before",
    "inventory_after",
    "inventory_gained",
    "animation_complete",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const produceStack = integerEvidenceValue(evidence.produce_stack);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasDecimalOwnerIdEvidenceValue(evidence.animal) &&
    (evidence.tool === "milk_pail" || evidence.tool === "shears") &&
    hasOpaqueEvidenceValue(evidence.produce) &&
    produceStack !== null &&
    produceStack >= 1 &&
    produceStack <= 2 &&
    evidence.produce_cleared === "true" &&
    before !== null &&
    after !== null &&
    after >= before + produceStack &&
    evidence.inventory_gained === "true" &&
    evidence.animation_complete === "true" &&
    hasStaminaConservationEvidence(evidence) &&
    // MilkPail/Shears deduct a flat 4f; the agent must observe exactly that
    // embodied cost so an animation counting the wrong number of tool uses is
    // caught at the approval boundary, not silently accepted.
    Math.abs(Number(evidence.expected_stamina_cost) - 4) <= STAMINA_EVIDENCE_EPSILON
  );
}

function integerEvidenceValue(value: string | undefined): number | null {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function finiteEvidenceValue(value: string | undefined): number | null {
  if (value === undefined || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isNoneOrOpaqueEvidenceValue(value: string | undefined): value is string {
  return value === "none" || hasOpaqueEvidenceValue(value);
}

function signedIntegerEvidenceValue(value: string | undefined): number | null {
  if (value === undefined || !/^-?(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/** A canonical positive integer: the machine is in a running processing window. */
function positiveIntegerEvidence(value: string | undefined): number | null {
  const number = integerEvidenceValue(value);
  return number !== null && number > 0 ? number : null;
}

function hasBoundedNonemptyEvidenceValue(value: string | undefined): value is string {
  return hasOpaqueEvidenceValue(value);
}

/** `none` is an explicit producer literal only for the absent equipped tool. */
function isToolSelectionBeforeValue(value: string | undefined): value is string {
  return value === "none" || hasOpaqueEvidenceValue(value);
}

/**
 * The tool-selection half of a tool action, which the Mod states from the side that performed each fact: the tool its
 * own registration claimed (`tool_selected`, equals the category the action drives), the slot that tool came from, the
 * tool and slot the actor held beforehand, and `tool_restored` - written only after the handler put the actor's own
 * selection back, so it must name what the actor held before. A receipt missing either half, or claiming a restore
 * that leaves a different tool in hand, is not a completed action.
 */
function hasToolSelectionEvidence(evidence: Readonly<Record<string, string>>, selectedCategory: string): boolean {
  return (
    evidence.tool_selected === selectedCategory &&
    validSlot(evidence.slot) &&
    isToolSelectionBeforeValue(evidence.tool_before) &&
    validSlot(evidence.slot_before) &&
    isToolSelectionBeforeValue(evidence.tool_restored) &&
    evidence.tool_restored === evidence.tool_before
  );
}

function hasTileEvidenceValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const match = /^(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/.exec(value);
  return match !== null && Number(match[1]) <= 1000 && Number(match[2]) <= 1000;
}

/**
 * A furniture footprint as the rotation handler spells it (`FormatFootprint`): `x,y:WxH`, one tile rectangle derived
 * from the piece's own `boundingBox`. Only the SHAPE is checked here; whether the box moved is the rule's business.
 */
function hasFootprintEvidenceValue(value: string | undefined): boolean {
  return value !== undefined && /^(?:0|[1-9][0-9]*),(?:0|[1-9][0-9]*):[1-9][0-9]*x[1-9][0-9]*$/.test(value);
}

function hasOpaqueEvidenceValue(value: string | undefined): value is string {
  // Opaque native values may have game-specific grammar, but protocol scalar
  // sentinels are never meaningful evidence of a materialized object.
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !["none", "null", "undefined", "true", "false", "nan", "infinity"].includes(value.toLowerCase())
  );
}

function hasOpaqueIdEvidenceValue(value: string | undefined): value is string {
  // Preserve the stricter identity grammar, while rejecting every protocol
  // scalar/sentinel spelling already rejected for opaque non-ID evidence.
  return hasOpaqueEvidenceValue(value) && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/**
 * The producer's `expected_minutes_until_ready` when the machine's own rule cannot state a duration because a custom
 * output method owns it. Nothing is compared in that case; the observed window must still be real.
 */
const MACHINE_WINDOW_UNAVAILABLE = "unavailable_in_machine_data";

/** Stardew multiplayer IDs can exceed JavaScript's safe integer range. */
function hasDecimalOwnerIdEvidenceValue(value: string | undefined): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,19})$/.test(value);
}

/**
 * ONE ROW PER WIRE ACTION, and every row carries the producer evidence literal it reads.
 *
 * The comments are load-bearing: they name the handler that prints the keys, and the reason the row cannot decide from
 * a native return value (a fence's `performToolAction` answers false on every branch; furniture rotation answers
 * nothing at all). A reader who trusts a bool the engine never promised is the defect these rows exist to refuse.
 *
 * `satisfies` is the completeness gate at authoring time; `tools/check-stardew-postcondition-delta.mjs` is the same
 * population at run time, read as the receipt schema for each action. Neither is a list maintained by hand.
 */
export const STARDEW_COMPLETION_CONTRACTS = Object.freeze({
  place_owned_object: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.worldobjectactions.cs ExecutePlaceOwnedObject —
    // target;location;tile;slot;item;terrain_feature;terrain_feature_tapped;native_placement;
    // object_present;placed_qualified_item_id;placed_type;inventory_before;inventory_after.
    // The native branch adds a COPY, so nothing may be decided from a reference; the proof is the
    // object being present on the tile afterwards plus the inventory count dropping by one.
    return (
      claim.reasonCode === "owned_object_placed" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "location",
          "tile",
          "slot",
          "item",
          "terrain_feature",
          "terrain_feature_tapped",
          "native_placement",
          "object_present",
          "placed_qualified_item_id",
          "placed_type",
          "inventory_before",
          "inventory_after",
        ],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          e.native_placement === "true" &&
          e.object_present === "true" &&
          e.placed_qualified_item_id === e.item &&
          e.inventory_after !== e.inventory_before &&
          Number.isSafeInteger(Number(e.inventory_before)) &&
          Number.isSafeInteger(Number(e.inventory_after)) &&
          Number(e.inventory_after) === Number(e.inventory_before) - 1,
      )
    );
  },
  remove_placed_item: (claim) => {
    // Evidence literal: ExecuteRemovePlacedItem — target;location;tile;item;type;tool;tool_kind;
    // slot;swings;removed;tile_object_after;drops;drop_count;stamina_before;stamina_after.
    // The removal is proved by the tile being empty afterwards, never by a native return value.
    return (
      claim.reasonCode === "placed_item_removed" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "location",
          "tile",
          "item",
          "type",
          "tool",
          "tool_kind",
          "slot",
          "swings",
          "removed",
          "tile_object_after",
          "drops",
          "drop_count",
          "stamina_before",
          "stamina_after",
        ],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          e.removed === "true" &&
          e.tile_object_after === "none" &&
          (e.tool_kind === "axe" || e.tool_kind === "pickaxe") &&
          Number.isSafeInteger(Number(e.swings)) &&
          Number(e.swings) >= 1 &&
          Number(e.drop_count) === (e.drops === undefined || e.drops.length === 0 ? 0 : e.drops.split("|").length),
      )
    );
  },
  break_container: (claim) => {
    // Evidence literal: ExecuteBreakContainerSource — target;location;tile;item;type;tool;slot;
    // swings;container_gone;tile_object_after;drops;drop_count;stamina_before;stamina_after.
    // The seam returns false even when it destroys the container, so the ONLY proof is the
    // container being gone plus the drops the game added during the swing window.
    return (
      claim.reasonCode === "container_source_broken" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "location",
          "tile",
          "item",
          "type",
          "tool",
          "slot",
          "swings",
          "container_gone",
          "tile_object_after",
          "drops",
          "drop_count",
          "stamina_before",
          "stamina_after",
        ],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          e.container_gone === "true" &&
          e.tile_object_after === "none" &&
          Number.isSafeInteger(Number(e.swings)) &&
          Number(e.swings) >= 1 &&
          Number(e.drop_count) === (e.drops === undefined || e.drops.length === 0 ? 0 : e.drops.split("|").length),
      )
    );
  },
  equip_tool: (claim) => {
    // The frozen contract is ["tool_equipped","already_equipped"]
    // (farmhandactiondevelopmentcontract.cs:74) and the Mod emits exactly those
    // (farmhandexecutioncontroller.resourcetoolactions.cs:434/444). This branch
    // previously required "tool_selected" and a "slot" evidence key, neither of
    // which exists on the production path, so equip_tool could never be judged
    // complete — and the fixtures were built from the same stale literals, which is
    // why every test stayed green. equip_tool/v2 deliberately made slot Mod-private
    // and reports the resolved tool instead.
    //
    // "already_equipped" is the code for the no-change case, and "tool_equipped" is the code for a real switch -
    // so the terminal code and the observed change must AGREE. Accepting `tool_equipped` with `before == expected`
    // (which the first version of this rule did, via the shared clauses) turned "nothing happened" into a
    // completion, which is the worse half of the trade the coverage work was fixing: a permissive rule is worse
    // than a missing one, because a silent drop becomes a wrong success.
    return (
      (claim.reasonCode === "tool_equipped" || claim.reasonCode === "already_equipped") &&
      declaredCompletionEvidence(
        claim.detail,
        ["tool", "before", "expected", "after"],
        (e) =>
          hasOpaqueEvidenceValue(e.tool) &&
          isToolSelectionBeforeValue(e.before) &&
          hasOpaqueEvidenceValue(e.expected) &&
          e.after === e.expected &&
          (claim.reasonCode === "tool_equipped" ? e.before !== e.expected : e.before === e.expected),
      )
    );
  },
  send_multiplayer_chat: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.chatactions.cs — recipient;length;role;sent. The
    // receipt proves the SEND and nothing more, so the rule asks for exactly that: the terminal code, the
    // four keys, `sent=true`, a real role, and a positive length. It deliberately requires NO receiving-side
    // fact, because the Mod cannot observe one (the chat box may not exist on a client at all).
    return (
      claim.reasonCode === "chat_message_sent" &&
      declaredCompletionEvidence(claim.detail, ["recipient", "length", "role", "sent"], (e) => {
        const length = integerEvidenceValue(e.length);
        return (
          e.sent === "true" &&
          e.recipient === "all_players" &&
          (e.role === "client" || e.role === "server") &&
          length !== null &&
          length > 0
        );
      })
    );
  },
  clear_fish_pond: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.pondactions.cs — the identity, the fish type before and
    // after, the occupant counts, the population gate, the spawn day, the golden-cracker flag and the
    // ejected count. The native seam returns void, so the proof is the OBSERVED reset: BOTH halves of the
    // card's postcondition (occupants 0 AND fish type none), an ejected count equal to what the pond held,
    // and a pond that held something to begin with. The fish are dropped rather than destroyed, so nothing
    // here claims a loss.
    return (
      claim.reasonCode === "fish_pond_cleared" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "pond_id",
          "location",
          "tile_x",
          "tile_y",
          "building_origin",
          "fish_type_before",
          "fish_type_after",
          "occupants_before",
          "occupants_after",
          "population_gate_before",
          "population_gate_after",
          "days_since_spawn_before",
          "days_since_spawn_after",
          "golden_cracker_before",
          "golden_cracker_after",
          "fish_ejected",
        ],
        (e) => {
          const occupantsBefore = integerEvidenceValue(e.occupants_before);
          return (
            occupantsBefore !== null &&
            occupantsBefore > 0 &&
            e.occupants_after === "0" &&
            e.fish_type_after === "none" &&
            integerEvidenceValue(e.fish_ejected) === occupantsBefore &&
            integerEvidenceValue(e.population_gate_after) === 0
          );
        },
      )
    );
  },
  build_farm_building: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.buildfarmbuildingactions.cs - the site identity, the
    // building type, the new building id, the money and materials before/after, and the tile's building
    // afterwards. The commission is the observable change, so the rule demands all three halves: money fell
    // by exactly the declared cost, the declared materials were consumed, and the tile now holds the type
    // that was commissioned. A receipt that merely says it called the settlement cannot satisfy those.
    return (
      claim.reasonCode === "farm_building_built" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "location",
          "tile",
          "building_type",
          "building_id",
          "money_before",
          "money_after",
          "build_cost",
          "materials_before",
          "materials_after",
          "materials_required",
          "build_days",
          "days_of_construction_left",
          "magical",
          "tile_building_after",
          "native_placement",
        ],
        (e) => {
          const before = integerEvidenceValue(e.money_before);
          const after = integerEvidenceValue(e.money_after);
          const cost = integerEvidenceValue(e.build_cost);
          const materialsBefore = integerEvidenceValue(e.materials_before);
          const materialsAfter = integerEvidenceValue(e.materials_after);
          const materialsRequired = integerEvidenceValue(e.materials_required);
          return (
            before !== null &&
            after !== null &&
            cost !== null &&
            cost > 0 &&
            before - after === cost &&
            materialsBefore !== null &&
            materialsAfter !== null &&
            materialsRequired !== null &&
            materialsRequired > 0 &&
            materialsBefore - materialsAfter === materialsRequired &&
            typeof e.building_id === "string" &&
            e.building_id.length > 0 &&
            typeof e.building_type === "string" &&
            e.building_type.length > 0 &&
            e.tile_building_after === e.building_type
          );
        },
      )
    );
  },
  accept_daily_quest: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.questactions.cs - the quest id and type, the day, and the
    // quest-log and day-flag counts before and after. The accept writes the quest log AND the day flag, so the
    // rule requires both: the log grew by exactly one entry and both flags now read true. The target id is
    // required non-empty because the receipt must name WHICH quest was accepted.
    return (
      claim.reasonCode === "daily_quest_accepted" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "daily_quest_id",
          "day_of_month",
          "quest_type",
          "accepted_before",
          "accepted_daily_before",
          "days_left_before",
          "quest_log_before",
          "quest_log_after",
          "days_left_after",
          "accepted_after",
          "accepted_daily_after",
          "daily_after",
          "can_be_cancelled_after",
          "day_accepted_after",
        ],
        (e) => {
          const logBefore = integerEvidenceValue(e.quest_log_before);
          const logAfter = integerEvidenceValue(e.quest_log_after);
          return (
            typeof e.daily_quest_id === "string" &&
            e.daily_quest_id.length > 0 &&
            logBefore !== null &&
            logAfter !== null &&
            logAfter - logBefore === 1 &&
            e.accepted_after === "true" &&
            e.accepted_daily_after === "true" &&
            e.accepted_before === "false"
          );
        },
      )
    );
  },
  tailor_clothing: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.tailoringactions.cs - the opaque pair identity, both
    // backpack slots, the two item ids, the produced item id, both item counts before/after, whether the
    // right spot was spent, the output count before/after, and the delivered/dropped disposition. The
    // native `CraftItem` settlement builds the garment AND the menu's own completion consumes the
    // reagents, so the rule requires both halves: the left reagent fell by exactly one (and the right one
    // when the recipe spends it) and the produced stack reached the world (backpack plus ground drop).
    return (
      claim.reasonCode === "clothing_tailored" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "left_slot",
          "right_slot",
          "location",
          "left",
          "right",
          "output",
          "left_before",
          "left_after",
          "right_before",
          "right_after",
          "right_spent",
          "output_before",
          "output_after",
          "delivered",
          "dropped",
          "disposition",
          "dropped_debris",
        ],
        (e) => {
          const leftBefore = integerEvidenceValue(e.left_before);
          const leftAfter = integerEvidenceValue(e.left_after);
          const rightBefore = integerEvidenceValue(e.right_before);
          const rightAfter = integerEvidenceValue(e.right_after);
          const outputBefore = integerEvidenceValue(e.output_before);
          const outputAfter = integerEvidenceValue(e.output_after);
          const delivered = integerEvidenceValue(e.delivered);
          const dropped = integerEvidenceValue(e.dropped);
          const rightSpent = e.right_spent === "true";
          return (
            hasOpaqueIdEvidenceValue(e.target) &&
            hasOpaqueEvidenceValue(e.left) &&
            hasOpaqueEvidenceValue(e.right) &&
            hasOpaqueEvidenceValue(e.output) &&
            leftBefore !== null &&
            leftAfter !== null &&
            leftAfter === leftBefore - 1 &&
            rightBefore !== null &&
            rightAfter !== null &&
            rightAfter === (rightSpent ? rightBefore - 1 : rightBefore) &&
            outputBefore !== null &&
            outputAfter !== null &&
            delivered !== null &&
            dropped !== null &&
            dropped >= 0 &&
            // The garment must exist SOMEWHERE (backpack or ground), and the backpack must have grown by
            // exactly what the receipt says it delivered.
            delivered + dropped >= 1 &&
            outputAfter === outputBefore + delivered &&
            // ...and the receipt's own disposition must agree with its split. This is what makes a fully
            // dropped garment acceptable (an honest outcome `delivered >= 1` used to refuse) while still
            // failing a receipt that contradicts itself.
            integerEvidenceValue(e.dropped_debris) === dropped &&
            ((e.disposition === "inventory" && dropped === 0 && delivered >= 1) ||
              (e.disposition === "dropped_on_ground" && delivered === 0 && dropped >= 1) ||
              (e.disposition === "partially_dropped" && delivered >= 1 && dropped >= 1))
          );
        },
      )
    );
  },
  color_placed_object: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.colorobjectactions.cs - the opaque target id, the
    // tile, the location, the palette index and the colour before/after read off the chest instance.
    // The game has no callable settlement for this write, so the proof is the OBSERVED change: the
    // colour must equal the palette colour for the named index AND differ from the recorded before
    // value. A repaint to the colour it already carried is `color_already_set`, never a success.
    return (
      claim.reasonCode === "placed_object_recolored" &&
      declaredCompletionEvidence(
        claim.detail,
        ["target", "tile", "location", "color_selection", "color_before", "color_after", "color_changed"],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          hasBoundedNonemptyEvidenceValue(e.tile) &&
          hasBoundedNonemptyEvidenceValue(e.location) &&
          integerEvidenceValue(e.color_selection) !== null &&
          hasBoundedNonemptyEvidenceValue(e.color_before) &&
          hasBoundedNonemptyEvidenceValue(e.color_after) &&
          e.color_changed === "true" &&
          e.color_after !== e.color_before,
      )
    );
  },
  dye_clothing_with_item: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.tailoringactions.cs - the opaque pair identity, the
    // garment and dye slots, the two item ids, the colour before/expected/after, the strength and its
    // source, whether the colour moved, the prismatic flag after, the dye counts before/after and which
    // spot was spent. `DyeItems` is a no-op on a garment it cannot recolour, so the rule requires the
    // colour to have SETTLED (moved when the dye carries a different colour, stayed when it carries the
    // same one) and the dye to have been consumed as the native spend rule says.
    return (
      claim.reasonCode === "clothing_dyed" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "garment_slot",
          "dye_slot",
          "location",
          "garment",
          "dye",
          "colour_before",
          "colour_expected",
          "colour_after",
          "strength",
          "strength_source",
          "colour_changed",
          "prismatic_after",
          "dye_before",
          "dye_after",
          "dye_spent",
          "colour_route",
        ],
        (e) => {
          const dyeBefore = integerEvidenceValue(e.dye_before);
          const dyeAfter = integerEvidenceValue(e.dye_after);
          const dyeSpent = e.dye_spent === "true";
          const changed = e.colour_before !== e.colour_after;
          return (
            hasOpaqueIdEvidenceValue(e.target) &&
            hasOpaqueEvidenceValue(e.garment) &&
            hasOpaqueEvidenceValue(e.dye) &&
            (e.colour_before?.length ?? 0) > 0 &&
            (e.colour_expected?.length ?? 0) > 0 &&
            (e.colour_after?.length ?? 0) > 0 &&
            e.colour_changed === String(changed) &&
            (e.prismatic_after === "true" || e.prismatic_after === "false") &&
            dyeBefore !== null &&
            dyeAfter !== null &&
            dyeAfter === (dyeSpent ? dyeBefore - 1 : dyeBefore) &&
            e.colour_route === "TailoringMenu.GetDyeColor"
          );
        },
      )
    );
  },
  accept_special_order: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.specialorders.cs - the opaque target, the board type,
    // the order key and seed, the board marker before and after, the team order-list length before and
    // after, and the two facts read back off the added order. The accept is the board's own two writes, so
    // the rule requires both halves: the list grew by exactly one, the order is present and InProgress, and
    // the board marker flipped from unset to set.
    return (
      claim.reasonCode === "special_order_accepted" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "special_order_id",
          "board_type",
          "quest_key",
          "generation_seed",
          "board_marker_before",
          "board_marker_after",
          "orders_before",
          "orders_after",
          "order_present_after",
          "order_in_progress_after",
        ],
        (e) => {
          const before = integerEvidenceValue(e.orders_before);
          const after = integerEvidenceValue(e.orders_after);
          const seed = integerEvidenceValue(e.generation_seed);
          return (
            hasOpaqueIdEvidenceValue(e.special_order_id) &&
            (e.board_type === "none" || e.board_type === "" ? true : hasBoundedNonemptyEvidenceValue(e.board_type)) &&
            hasBoundedNonemptyEvidenceValue(e.quest_key) &&
            seed !== null &&
            e.board_marker_before === "false" &&
            e.board_marker_after === "true" &&
            before !== null &&
            after !== null &&
            after - before === 1 &&
            e.order_present_after === "true" &&
            e.order_in_progress_after === "true"
          );
        },
      )
    );
  },
  claim_museum_reward: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.museumrewards.cs - the opaque target, the museum
    // location, the reward counts before/returned/delivered/recorded/after, the mail-flag counts, and the
    // inventory units. `rewards_collected` is the body's own verdict, so the rule re-derives it: the
    // published set was non-empty, the enumeration returned exactly that many, every one was delivered AND
    // recorded, and a fresh read found nothing left.
    return (
      claim.reasonCode === "museum_rewards_collected" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "location",
          "rewards_before",
          "rewards_returned",
          "rewards_delivered",
          "rewards_recorded",
          "rewards_after",
          "mail_flags_before",
          "mail_flags_after",
          "inventory_units_before",
          "inventory_units_after",
          "rewards_collected",
        ],
        (e) => {
          const before = integerEvidenceValue(e.rewards_before);
          const returned = integerEvidenceValue(e.rewards_returned);
          const delivered = integerEvidenceValue(e.rewards_delivered);
          const recorded = integerEvidenceValue(e.rewards_recorded);
          const after = integerEvidenceValue(e.rewards_after);
          const mailBefore = integerEvidenceValue(e.mail_flags_before);
          const mailAfter = integerEvidenceValue(e.mail_flags_after);
          return (
            hasOpaqueIdEvidenceValue(e.target) &&
            hasBoundedNonemptyEvidenceValue(e.location) &&
            before !== null &&
            before >= 1 &&
            returned !== null &&
            returned === before &&
            delivered !== null &&
            delivered === returned &&
            recorded !== null &&
            recorded === returned &&
            after === 0 &&
            mailBefore !== null &&
            mailAfter !== null &&
            mailAfter > mailBefore &&
            integerEvidenceValue(e.inventory_units_before) !== null &&
            integerEvidenceValue(e.inventory_units_after) !== null &&
            e.rewards_collected === "true"
          );
        },
      )
    );
  },
  redeem_prize_ticket: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.prizeticketactions.cs ExecuteRedeemPrizeTicket -
    // prize_level;prize_item_id;prize_stack;prize_held_before;prize_held_after;ticket_item_id;
    // tickets_before;tickets_after;prizes_claimed_before;prizes_claimed_after;prize_delivered.
    // The exchange is BOTH halves, so the rule demands both: the ticket stack fell by exactly one from
    // a stack that held one, the pack holds exactly the delivered prize stack more than it did, and the
    // machine's own stat advanced by one. The level the receipt names must be the stat it read, so a
    // receipt cannot report a prize its own level does not produce.
    return (
      claim.reasonCode === "prize_ticket_redeemed" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "prize_level",
          "prize_item_id",
          "prize_stack",
          "prize_held_before",
          "prize_held_after",
          "ticket_item_id",
          "tickets_before",
          "tickets_after",
          "prizes_claimed_before",
          "prizes_claimed_after",
          "prize_delivered",
        ],
        (e) => {
          const ticketsBefore = integerEvidenceValue(e.tickets_before);
          const ticketsAfter = integerEvidenceValue(e.tickets_after);
          const heldBefore = integerEvidenceValue(e.prize_held_before);
          const heldAfter = integerEvidenceValue(e.prize_held_after);
          const claimedBefore = integerEvidenceValue(e.prizes_claimed_before);
          const claimedAfter = integerEvidenceValue(e.prizes_claimed_after);
          const stack = integerEvidenceValue(e.prize_stack);
          return (
            ticketsBefore !== null &&
            ticketsBefore >= 1 &&
            ticketsAfter !== null &&
            ticketsAfter === ticketsBefore - 1 &&
            claimedBefore !== null &&
            claimedAfter !== null &&
            claimedAfter === claimedBefore + 1 &&
            stack !== null &&
            stack >= 1 &&
            heldBefore === 0 &&
            heldAfter !== null &&
            heldAfter === heldBefore + stack &&
            e.prize_delivered === "true" &&
            typeof e.prize_item_id === "string" &&
            e.prize_item_id.length > 0 &&
            typeof e.ticket_item_id === "string" &&
            e.ticket_item_id.length > 0 &&
            integerEvidenceValue(e.prize_level) === claimedBefore
          );
        },
      )
    );
  },
  name_entity: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.nameentityactions.cs - the subject, the horse
    // id, the requested name, the name read back and the Mod's own read-back verdict. The
    // entity's stored name IS the terminal, so the rule asks for exactly that: the terminal code,
    // the twelve keys, an entity that was unnamed before the call, and a read-back that matched.
    return (
      claim.reasonCode === "entity_named" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "owner_id",
          "location",
          "actor_tile",
          "horse_tile",
          "horse_owner_id",
          "horse_name",
          "horse_id",
          "name_before",
          "requested",
          "name_after",
          "name_matches_requested",
          "player_horse_name_updated",
        ],
        (e) =>
          typeof e.name_before === "string" &&
          e.name_before === "none" &&
          typeof e.name_matches_requested === "string" &&
          e.name_matches_requested === "true" &&
          typeof e.name_after === "string" &&
          e.name_after.length > 0 &&
          typeof e.requested === "string" &&
          e.name_after === e.requested,
      )
    );
  },
  toggle_animal_door: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.animaldooractions.cs:194-197 —
    // target;tile;building_type;animal_door_open_before;animal_door_open_after;
    // animal_door_open_changed;animal_door_amount_before;animal_door_amount_after.
    // The native seam returns void, so the ONLY proof the door moved is the observed flip; the
    // rule therefore requires the before/after pair AND the derived flag to agree.
    return (
      claim.reasonCode === "animal_door_toggled" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "tile",
          "building_type",
          "animal_door_open_before",
          "animal_door_open_after",
          "animal_door_open_changed",
          "animal_door_amount_before",
          "animal_door_amount_after",
        ],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          (e.animal_door_open_before === "true" || e.animal_door_open_before === "false") &&
          (e.animal_door_open_after === "true" || e.animal_door_open_after === "false") &&
          e.animal_door_open_before !== e.animal_door_open_after &&
          e.animal_door_open_changed === "true",
      )
    );
  },
  withdraw_silo_hay: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.silohaywithdrawactions.cs:96 —
    // target;item;silo_hay_before;silo_hay_after;silo_hay_decreased;carried_before;
    // carried_after;carried_hay_increased;inventory_inserted.
    // The transfer is two-sided, so the rule requires BOTH halves to be visible in the receipt and
    // not merely implied by the terminal code.
    return (
      claim.reasonCode === "silo_hay_taken" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "item",
          "silo_hay_before",
          "silo_hay_after",
          "silo_hay_decreased",
          "carried_before",
          "carried_after",
          "carried_hay_increased",
          "inventory_inserted",
        ],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          e.item === "(O)178" &&
          decremented(e.silo_hay_before, e.silo_hay_after) &&
          e.silo_hay_decreased === "true" &&
          incremented(e.carried_before, e.carried_after) &&
          e.carried_hay_increased === "true" &&
          e.inventory_inserted === "true",
      )
    );
  },
  use_obelisk: (claim) => {
    // The arrival is minted by the shared travel path (movementactions.cs), whose evidence is the
    // expected/actual destination pair. The tile is deliberately absent: the native layout chooses
    // the landing tile, so only the location can be asserted — the same rule the sibling
    // enter_mine / select_mine_elevator_floor terminals use.
    return (
      claim.reasonCode === "obelisk_arrived" &&
      declaredCompletionEvidence(
        claim.detail,
        ["expected", "actual"],
        (e) =>
          hasOpaqueEvidenceValue(e.expected) &&
          hasOpaqueEvidenceValue(e.actual) &&
          e.expected.split(":")[0] === e.actual.split(":")[0],
      )
    );
  },
  load_building_chest: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.buildingchestactions.cs — the chest identity
    // prefix (tile;location;target;building_type;building_origin;chest_id;branch) plus item;
    // held_stack_before;held_stack_after;chest_item_before;chest_item_after;chest_slots_before;
    // chest_slots_after;moved_count;released_count;required_count;chest_capacity_before;
    // item_accepted;native_accepted;native_refusal;native_menu_opened.
    //
    // The native branch returns a bool, so the bool is NOT the proof: the rule requires BOTH
    // observed halves of the quantised transfer (the chest gained exactly as many of the named
    // item as the held stack lost) and that the amount is a whole number of the conversion's
    // `required_count` quanta. `native_refusal` names which native data field's gate the
    // refusal belonged to; on a success it must be `none`.
    return (
      claim.reasonCode === "building_chest_loaded" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "tile",
          "location",
          "target",
          "building_type",
          "building_origin",
          "chest_id",
          "branch",
          "item",
          "held_stack_before",
          "held_stack_after",
          "chest_item_before",
          "chest_item_after",
          "chest_slots_before",
          "chest_slots_after",
          "moved_count",
          "released_count",
          "required_count",
          "chest_capacity_before",
          "item_accepted",
          "native_accepted",
          "native_refusal",
          "native_menu_opened",
        ],
        (e) => {
          const heldBefore = integerEvidenceValue(e.held_stack_before);
          const heldAfter = integerEvidenceValue(e.held_stack_after);
          const chestBefore = integerEvidenceValue(e.chest_item_before);
          const chestAfter = integerEvidenceValue(e.chest_item_after);
          const moved = integerEvidenceValue(e.moved_count);
          const released = integerEvidenceValue(e.released_count);
          const required = positiveIntegerEvidence(e.required_count);
          return (
            hasTileEvidenceValue(e.tile) &&
            hasOpaqueIdEvidenceValue(e.target) &&
            e.branch === "load" &&
            hasOpaqueEvidenceValue(e.item) &&
            heldBefore !== null &&
            heldAfter !== null &&
            chestBefore !== null &&
            chestAfter !== null &&
            moved !== null &&
            moved > 0 &&
            released === moved &&
            heldBefore - heldAfter === moved &&
            chestAfter - chestBefore === moved &&
            required !== null &&
            moved % required === 0 &&
            integerEvidenceValue(e.chest_capacity_before) !== null &&
            e.item_accepted === "true" &&
            e.native_accepted === "true" &&
            e.native_refusal === "none" &&
            e.native_menu_opened === "false"
          );
        },
      )
    );
  },
  collect_building_chest_output: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.buildingchestactions.cs — the same chest
    // identity prefix plus item;chest_slots_before;chest_slots_after;chest_item_before;
    // chest_item_after;moved_count;carried_before;carried_after;native_accepted;
    // native_menu_opened.
    //
    // Collect auto-collects only a SINGLE stack, so a success must show the named stack leaving
    // the chest (its count and the chest's slot count both fell) AND the actor's inventory
    // gaining exactly that many of the same item; `native_menu_opened` must be false because the
    // >= 2-stack case is refused by name rather than handed to a container menu.
    return (
      claim.reasonCode === "building_chest_output_collected" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "tile",
          "location",
          "target",
          "building_type",
          "building_origin",
          "chest_id",
          "branch",
          "item",
          "chest_slots_before",
          "chest_slots_after",
          "chest_item_before",
          "chest_item_after",
          "moved_count",
          "carried_before",
          "carried_after",
          "native_accepted",
          "native_menu_opened",
        ],
        (e) => {
          const slotsBefore = integerEvidenceValue(e.chest_slots_before);
          const slotsAfter = integerEvidenceValue(e.chest_slots_after);
          const chestBefore = integerEvidenceValue(e.chest_item_before);
          const chestAfter = integerEvidenceValue(e.chest_item_after);
          const moved = integerEvidenceValue(e.moved_count);
          const carriedBefore = integerEvidenceValue(e.carried_before);
          const carriedAfter = integerEvidenceValue(e.carried_after);
          return (
            hasTileEvidenceValue(e.tile) &&
            hasOpaqueIdEvidenceValue(e.target) &&
            e.branch === "collect" &&
            hasOpaqueEvidenceValue(e.item) &&
            slotsBefore !== null &&
            slotsAfter !== null &&
            chestBefore !== null &&
            chestAfter !== null &&
            moved !== null &&
            carriedBefore !== null &&
            carriedAfter !== null &&
            moved > 0 &&
            chestBefore - chestAfter === moved &&
            slotsAfter < slotsBefore &&
            carriedAfter - carriedBefore === moved &&
            e.native_accepted === "true" &&
            e.native_menu_opened === "false"
          );
        },
      )
    );
  },
  till_soil: (claim) => {
    return claim.reasonCode === "soil_tilled" && hasTillSoilCompletionEvidence(claim.detail);
  },
  water_crop: (claim) => {
    return claim.reasonCode === "crop_watered" && hasWaterCropCompletionEvidence(claim.detail);
  },
  refill_watering_can: (claim) => {
    return claim.reasonCode === "watering_can_refilled" && hasRefillWateringCanCompletionEvidence(claim.detail);
  },
  dig_artifact_spot: (claim) => {
    return claim.reasonCode === "artifact_spot_dug" && hasDigArtifactSpotCompletionEvidence(claim.detail);
  },
  break_rock: (claim) => {
    // `rock_source_broken` is the source TRANSFORMED, and that is this action's completion boundary - the same
    // line the tree path draws: one swing that only damages is a completed swing (the Mod reports
    // `rock_source_damaged` with `state: succeeded`), but it has not yet removed the source, so it is not the
    // transition a completed task is recorded from. A multi-hit rock therefore needs as many dispatches as its
    // durability, and the last one is the one that counts.
    return claim.reasonCode === "rock_source_broken" && hasBreakRockSourceCompletionEvidence(claim.detail);
  },
  clear_hoedirt: (claim) => {
    return claim.reasonCode === "hoedirt_cleared" && hasClearHoeDirtCompletionEvidence(claim.detail);
  },
  chop_tree: (claim) => {
    return claim.reasonCode === "tree_source_chopped" && hasChopTreeSourceCompletionEvidence(claim.detail);
  },
  place_wood_fence: (claim) => {
    return claim.reasonCode === "wood_fence_placed" && hasWoodFenceCompletionEvidence(claim.detail);
  },
  bait_crab_pot: (claim) => {
    return claim.reasonCode === "crab_pot_baited" && hasBaitCrabPotCompletionEvidence(claim.detail);
  },
  plant_seed: (claim) => {
    return (
      claim.reasonCode === "seed_planted" &&
      declaredCompletionEvidence(
        claim.detail,
        ["location", "target", "tile", "item", "crop", "inventory_before", "inventory_after"],
        (e) =>
          hasBoundedNonemptyEvidenceValue(e.location) &&
          hasOpaqueIdEvidenceValue(e.target) &&
          hasTileEvidenceValue(e.tile) &&
          hasOpaqueEvidenceValue(e.item) &&
          hasOpaqueEvidenceValue(e.crop) &&
          decremented(e.inventory_before, e.inventory_after),
      )
    );
  },
  move_to_tile: (claim) => {
    return claim.reasonCode === "target_reached" && hasMoveToTileCompletionEvidence(claim.detail);
  },
  travel: (claim) => {
    return claim.reasonCode === "travel_completed" && hasDoorTransitionCompletionEvidence(claim.detail);
  },
  ride_minecart: (claim) => {
    return claim.reasonCode === "minecart_ride_completed" && hasMinecartRideCompletionEvidence(claim.detail);
  },
  enter_exit: (claim) => {
    return claim.reasonCode === "enter_exit_completed" && hasDoorTransitionCompletionEvidence(claim.detail);
  },
  navigate_to_destination: (claim) => {
    return claim.reasonCode === "navigation_completed" && hasNavigationCompletionEvidence(claim.detail);
  },
  pickup_forage: (claim) => {
    return claim.reasonCode === "forage_picked_up" && hasPickupForageCompletionEvidence(claim.detail);
  },
  pickup_item: (claim) => {
    return claim.reasonCode === "item_picked_up" && hasPickupItemCompletionEvidence(claim.detail);
  },
  fertilize_tile: (claim) => {
    return claim.reasonCode === "fertilizer_applied" && hasFertilizeTileCompletionEvidence(claim.detail);
  },
  place_crab_pot: (claim) => {
    return claim.reasonCode === "crab_pot_placed" && hasPlaceCrabPotCompletionEvidence(claim.detail);
  },
  machine_inspect: (claim) => {
    return claim.reasonCode === "machine_inspected" && hasMachineInspectCompletionEvidence(claim.detail);
  },
  machine_load: (claim) => {
    return claim.reasonCode === "machine_coffee_loaded" && hasMachineLoadCompletionEvidence(claim.detail);
  },
  machine_collect_output: (claim) => {
    return claim.reasonCode === "machine_coffee_collected" && hasMachineCollectOutputCompletionEvidence(claim.detail);
  },
  collect_animal_product: (claim) => {
    return claim.reasonCode === "animal_product_collected" && hasCollectAnimalProductCompletionEvidence(claim.detail);
  },
  feed_animal: (claim) => {
    return claim.reasonCode === "hay_placed_in_trough" && hasFeedAnimalCompletionEvidence(claim.detail);
  },
  talk_to_npc: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.npcactions.cs - location;target;npc;tile;
    // native_handled;dialogue_up_before;dialogue_up_after;dialogue_box_after;menu_open_after;
    // talked_to_today_before;talked_to_today_after;points_before;points_after;player_can_move_after.
    // The seam returns bool, so the raw handled flag proves nothing on its own: the rule also
    // requires the dialogue to have come UP - that is the world change - and it reports that the
    // actor is left NOT movable, which is the native end state rather than a hidden failure.
    return (
      claim.reasonCode === "talk_to_npc_talked" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "location",
          "target",
          "npc",
          "tile",
          "native_handled",
          "dialogue_up_before",
          "dialogue_up_after",
          "dialogue_box_after",
          "menu_open_after",
          "talked_to_today_before",
          "talked_to_today_after",
          "points_before",
          "points_after",
          "player_can_move_after",
        ],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          e.native_handled === "true" &&
          e.dialogue_up_before === "false" &&
          e.dialogue_up_after === "true" &&
          e.dialogue_box_after === "true",
      )
    );
  },
  use_item: (claim) => {
    return claim.reasonCode === "item_used" && hasUseItemCompletionEvidence(claim.detail);
  },
  harvest_crop: (claim) => {
    return claim.reasonCode === "crop_harvested" && hasHarvestCropCompletionEvidence(claim.detail);
    // ── The rest of the registered action surface (card CARD-P4-9-COMPLETION-EVIDENCE).
    // Every rule below is transcribed from the Mod site named in its comment: the terminal
    // reasonCode that handler mints and the evidence fields it writes on that exact terminal.
    // Where a handler mints the same completion in more than one place, the sites are listed
    // here and the rule admits exactly those shapes. No key, code or relation is invented.
  },
  select_mine_elevator_floor: (claim) => {
    // farmhandexecutioncontroller.movementactions.cs:611-617 CompleteTravelAfterWarp:
    //   expected=<location>:<x>,<y>;actual=<location>:<x>,<y>[;level=<mineLevel>]
    // Floor 0 targets the mine-entrance MAP, so `level` is absent there; a generated
    // floor lands in a MineShaft and appends it. The landing TILE is native-chosen.
    return claim.reasonCode === "mine_elevator_floor_selected" && hasMineElevatorFloorCompletionEvidence(claim.detail);
  },
  ride_bus: (claim) => {
    // farmhandexecutioncontroller.busactions.cs:200-210 UpdateBusRide. The world owns the
    // departure; this terminal is the arrival it produced, so the two location facts and
    // the fare are the whole contract. `money_after` is read from the actor afterwards and
    // is reported, never asserted (a fare refund/reward may move it either way).
    return (
      claim.reasonCode === "bus_arrived" &&
      declaredCompletionEvidence(
        claim.detail,
        ["origin", "destination", "fare", "money_before", "money_after"],
        (e) =>
          hasBoundedNonemptyEvidenceValue(e.origin) &&
          hasBoundedNonemptyEvidenceValue(e.destination) &&
          e.origin !== e.destination &&
          integerEvidenceValue(e.fare) !== null &&
          integerEvidenceValue(e.money_before) !== null &&
          integerEvidenceValue(e.money_after) !== null,
      )
    );
  },
  use_raft: (claim) => {
    // farmhandexecutioncontroller.transportactions.cs:267-269: the native Raft.DoFunction
    // returns void, so the only proof the launch started is the rafting flag flipping.
    return (
      claim.reasonCode === "raft_launched" &&
      declaredCompletionEvidence(
        claim.detail,
        ["tile", "is_rafting", "stamina_before", "stamina_after"],
        (e) =>
          hasTileEvidenceValue(e.tile) &&
          e.is_rafting === "true" &&
          finiteEvidenceValue(e.stamina_before) !== null &&
          finiteEvidenceValue(e.stamina_after) !== null,
      )
    );
  },
  mount_transport: (claim) => {
    // farmhandexecutioncontroller.cs:1498-1502 UpdateActiveMountTransport. The settle reads
    // the rider's own mount (the native mount removes the horse from the location's
    // characters), so `mounted=true;mounting=false` is the producer's own success state.
    return (
      claim.reasonCode === "horse_mounted" &&
      declaredCompletionEvidence(
        claim.detail,
        ["target", "horse_id", "mounted", "mounting"],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          hasOpaqueIdEvidenceValue(e.horse_id) &&
          e.mounted === "true" &&
          e.mounting === "false",
      )
    );
  },
  enter_mine: (claim) => {
    // Three producers, one meaning (`mine_entered`, the declared/reached level):
    //   farmhandexecutioncontroller.transportactions.cs:194 — ladder descent, synchronous:
    //     level=<level>;tile=<x>,<y>;from_level=<level>
    //   farmhandexecutioncontroller.transportactions.cs:232 — entrance, synchronous:
    //     level=<level>;tile=<x>,<y>
    //   farmhandexecutioncontroller.movementactions.cs:611-617 — the asynchronous Warped
    //     arrival, where the native layout owns the tile: expected=<loc>:<x>,<y>;
    //     actual=<loc>:<x>,<y>;level=<level>
    return claim.reasonCode === "mine_entered" && hasMineEntryCompletionEvidence(claim.detail);
  },
  use_mine_ladder: (claim) => {
    // Two producers, one meaning (`mine_left`, the actor is out of the mine):
    //   farmhandexecutioncontroller.transportactions.cs — the answer performed the warp in the same call:
    //     from=<loc>:<level>;question=ExitMine;response=Leave;ladder=<x>,<y>;actual=<loc>:<x>,<y>
    //   farmhandexecutioncontroller.movementactions.cs — the asynchronous Warped arrival, where the
    //     destination map is the assertion: expected=<loc>:<x>,<y>;actual=<loc>:<x>,<y>
    return claim.reasonCode === "mine_left" && hasMineExitCompletionEvidence(claim.detail);
  },
  express_emote: (claim) => {
    // farmhandexecutioncontroller.expressionactions.cs:82-90: Farmer.doEmote arms the
    // animation synchronously, so `native_dispatched=true` under this terminal is the
    // departure proof. The animation's own completion is not a terminal fact.
    return (
      claim.reasonCode === "emote_started" &&
      declaredCompletionEvidence(
        claim.detail,
        ["emote", "native_dispatched"],
        (e) => hasBoundedNonemptyEvidenceValue(e.emote) && e.native_dispatched === "true",
      )
    );
  },
  face_direction: (claim) => {
    // farmhandexecutioncontroller.movementactions.cs:800-808: the actor re-reads its own
    // FacingDirection, so the emitted direction is the frozen enum spelling.
    return (
      claim.reasonCode === "actor_facing_matches" &&
      declaredCompletionEvidence(
        claim.detail,
        ["direction"],
        (e) => e.direction === "up" || e.direction === "right" || e.direction === "down" || e.direction === "left",
      )
    );
  },
  interact_npc_with_item: (claim) => {
    // Two terminals, both real completions of "offer an item to an NPC"
    // (farmhandexecutioncontroller.machinesanimalsitemsactions.cs):
    //   :768-769 — a matching unsatisfied delivery quest was completed: quest_item_delivered;
    //   :888-889 — otherwise the gift path: gift_given.
    return (
      (claim.reasonCode === "gift_given" && hasGiftGivenCompletionEvidence(claim.detail)) ||
      (claim.reasonCode === "quest_item_delivered" && hasQuestItemDeliveredCompletionEvidence(claim.detail))
    );
  },
  pet_animal: (claim) => {
    // farmhandexecutioncontroller.cs:1524-1529 UpdateActivePet: the native petting callback
    // records the day AND grants friendship, and both are re-read before the terminal.
    return (
      claim.reasonCode === "pet_completed" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "location",
          "target",
          "tile",
          "pet_day",
          "friendship_before",
          "friendship_after",
          "day_recorded",
          "friendship_callback",
        ],
        (e) =>
          hasBoundedNonemptyEvidenceValue(e.location) &&
          hasOpaqueIdEvidenceValue(e.target) &&
          hasTileEvidenceValue(e.tile) &&
          integerEvidenceValue(e.pet_day) !== null &&
          integerEvidenceValue(e.friendship_before) !== null &&
          integerEvidenceValue(e.friendship_after) !== null &&
          e.day_recorded === "true" &&
          e.friendship_callback === "true",
      )
    );
  },
  pet_farm_animal: (claim) => {
    // ExecutePetFarmAnimal: `animal.pet(Game1.player)` mutates synchronously, and the terminal reads the engine's own
    // `wasPet` marker plus the friendship delta before it answers `farm_animal_petted`.
    return (
      claim.reasonCode === "farm_animal_petted" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "location",
          "target",
          "animal",
          "type",
          "tile",
          "friendship_before",
          "friendship_after",
          "friendship_floor",
          "happiness_before",
          "happiness_after",
          "was_auto_pet_before",
          "was_pet",
          "time_of_day",
        ],
        (e) =>
          hasBoundedNonemptyEvidenceValue(e.location) &&
          hasOpaqueIdEvidenceValue(e.target) &&
          integerEvidenceValue(e.animal) !== null &&
          hasBoundedNonemptyEvidenceValue(e.type) &&
          hasTileEvidenceValue(e.tile) &&
          integerEvidenceValue(e.friendship_before) !== null &&
          integerEvidenceValue(e.friendship_after) !== null &&
          integerEvidenceValue(e.friendship_floor) !== null &&
          integerEvidenceValue(e.happiness_before) !== null &&
          integerEvidenceValue(e.happiness_after) !== null &&
          (e.was_auto_pet_before === "true" || e.was_auto_pet_before === "false") &&
          e.was_pet === "true" &&
          integerEvidenceValue(e.time_of_day) !== null,
      )
    );
  },
  sleep: (claim) => {
    // SleepAndAdvanceDayLifecycle.cs:835-853 Finish("passed", "day_advanced", settlement).
    // This terminal is read by field membership, not by the shared key/value parser: the
    // lifecycle's BuildReceiptEvidence (:863-894) appends its settlement block to a base
    // list that already carries `topology`, so the emitted detail has a DUPLICATE key and
    // the duplicate-rejecting parser cannot read it. The rule therefore matches the
    // producer's own terminal markers exactly; `day_started_observed=true` is the one the
    // lifecycle gates the `passed` terminal on (DecideDayStart => Confirmed).
    return claim.reasonCode === "day_advanced" && hasDayAdvancedCompletionEvidence(claim.detail);
  },
  clear_debris: (claim) => {
    // farmhandexecutioncontroller.farmingconstructionactions.cs:847-856: the clump is
    // re-resolved by its own opaque identity and `cleared` is exactly "the clump is gone".
    return (
      claim.reasonCode === "debris_cleared" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "location",
          "target",
          "tile",
          "parent",
          "tool",
          "required_upgrade",
          "health_before",
          "health_after",
          "clump_removed",
          "stamina_before",
          "stamina_after",
          "stamina_delta",
          "expected_stamina_cost",
        ],
        (e) =>
          hasBoundedNonemptyEvidenceValue(e.location) &&
          hasOpaqueIdEvidenceValue(e.target) &&
          hasTileEvidenceValue(e.tile) &&
          integerEvidenceValue(e.parent) !== null &&
          (e.tool === "axe" || e.tool === "pickaxe") &&
          integerEvidenceValue(e.required_upgrade) !== null &&
          finiteEvidenceValue(e.health_before) !== null &&
          finiteEvidenceValue(e.health_after) !== null &&
          e.clump_removed === "true" &&
          hasStaminaConservationEvidence(e),
      )
    );
  },
  break_resource_clump: (claim) => {
    // farmhandexecutioncontroller.farmingconstructionactions.cs ExecuteBreakResourceClump: the clump is re-resolved by
    // its own opaque identity after the swings and `clump_removed` is exactly "it left location.resourceClumps";
    // `drop_observed` is the item-carrying debris the destroying swing left behind. Both are read from the location
    // after the native call, and both are required - a clump that survived the swing cap settles `Uncertain`.
    return claim.reasonCode === "clump_broken" && hasBreakResourceClumpCompletionEvidence(claim.detail);
  },
  npc_relationship: (claim) => {
    // farmhandexecutioncontroller.machinesanimalsitemsactions.cs:574-578: a read-only
    // inspection that mints Succeeded from the live Friendship it just read.
    return (
      claim.reasonCode === "npc_relationship_inspected" &&
      declaredCompletionEvidence(
        claim.detail,
        ["location", "target", "tile", "npc", "points", "status", "talked_to_today", "gifts_today", "gifts_this_week"],
        (e) =>
          hasBoundedNonemptyEvidenceValue(e.location) &&
          hasOpaqueIdEvidenceValue(e.target) &&
          hasTileEvidenceValue(e.tile) &&
          hasOpaqueEvidenceValue(e.npc) &&
          signedIntegerEvidenceValue(e.points) !== null &&
          hasOpaqueEvidenceValue(e.status) &&
          (e.talked_to_today === "true" || e.talked_to_today === "false") &&
          integerEvidenceValue(e.gifts_today) !== null &&
          integerEvidenceValue(e.gifts_this_week) !== null,
      )
    );
  },
  equip_wearable: (claim) => {
    // farmhandexecutioncontroller.actorstateactions.cs:185-190 (a repeat of an already
    // satisfied request) and :257-262 (the swap landed). Both are deterministic
    // successes: append-only `slot/target id` identity plus the body slot's occupant.
    return (
      (claim.reasonCode === "wearable_already_equipped" &&
        declaredCompletionEvidence(
          claim.detail,
          ["body_slot", "source_slot", "requested", "occupant", "moved"],
          (e) =>
            isWearableBodySlot(e.body_slot) &&
            validSlot(e.source_slot) &&
            hasOpaqueEvidenceValue(e.requested) &&
            e.occupant === e.requested &&
            e.moved === "false",
        )) ||
      (claim.reasonCode === "wearable_equipped" &&
        declaredCompletionEvidence(
          claim.detail,
          [
            "body_slot",
            "source_slot",
            "requested",
            "occupant_before",
            "occupant_after",
            "displaced",
            "pack_slot_after",
          ],
          (e) =>
            isWearableBodySlot(e.body_slot) &&
            validSlot(e.source_slot) &&
            hasOpaqueEvidenceValue(e.requested) &&
            isNoneOrOpaqueEvidenceValue(e.occupant_before) &&
            e.occupant_after === e.requested &&
            isNoneOrOpaqueEvidenceValue(e.displaced) &&
            isNoneOrOpaqueEvidenceValue(e.pack_slot_after),
        ))
    );
  },
  unequip_wearable: (claim) => {
    // farmhandexecutioncontroller.actorstateactions.cs:297-303 (the slot is already
    // empty) and :374-379 (the wearable landed in the named destination slot).
    return (
      (claim.reasonCode === "wearable_already_unequipped" &&
        declaredCompletionEvidence(
          claim.detail,
          ["body_slot", "destination_slot", "occupant", "moved"],
          (e) =>
            isWearableBodySlot(e.body_slot) &&
            validSlot(e.destination_slot) &&
            e.occupant === "none" &&
            e.moved === "false",
        )) ||
      (claim.reasonCode === "wearable_unequipped" &&
        declaredCompletionEvidence(
          claim.detail,
          [
            "body_slot",
            "destination_slot",
            "occupant_before",
            "occupant_after",
            "removed",
            "destination_before",
            "destination_after",
            "landed",
          ],
          (e) =>
            isWearableBodySlot(e.body_slot) &&
            validSlot(e.destination_slot) &&
            isNoneOrOpaqueEvidenceValue(e.occupant_before) &&
            e.occupant_after === "none" &&
            hasOpaqueEvidenceValue(e.removed) &&
            e.destination_before === "none" &&
            e.destination_after === e.removed &&
            e.landed === "true",
        ))
    );
  },
  dismount_transport: (claim) => {
    // farmhandexecutioncontroller.actorstateactions.cs:439-446: the frozen postcondition
    // is `!who.isRidingHorse()` re-read after the native Horse.dismount call.
    return (
      claim.reasonCode === "transport_dismounted" &&
      declaredCompletionEvidence(
        claim.detail,
        ["horse_id", "location", "tile", "riding_before", "mounting_before", "riding_after", "mount_after"],
        (e) =>
          hasOpaqueIdEvidenceValue(e.horse_id) &&
          hasBoundedNonemptyEvidenceValue(e.location) &&
          hasTileEvidenceValue(e.tile) &&
          (e.riding_before === "true" || e.riding_before === "false") &&
          (e.mounting_before === "true" || e.mounting_before === "false") &&
          e.riding_after === "false" &&
          e.mount_after === "false",
      )
    );
  },
  use_warp_item: (claim) => {
    // farmhandexecutioncontroller.movementactions.cs:574/589-590: the totem's landing tile
    // is chosen inside the game's own delayed callback, so the reached destination
    // LOCATION is the postcondition — the same rule use_obelisk already follows.
    return (
      claim.reasonCode === "warp_item_arrived" &&
      declaredCompletionEvidence(
        claim.detail,
        ["expected", "actual"],
        (e) =>
          hasOpaqueEvidenceValue(e.expected) &&
          hasOpaqueEvidenceValue(e.actual) &&
          e.expected.split(":")[0] === e.actual.split(":")[0],
      )
    );
  },
  pan_ore: (claim) => {
    // farmhandexecutioncontroller.itemtileactions.cs:531-554: success is the panning site
    // advancing plus the native TimesPanned stat incrementing in the same call.
    return (
      claim.reasonCode === "ore_panned" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "slot",
          "tool",
          "tile",
          "location",
          "site_before",
          "site_after",
          "site_moved",
          "times_panned_before",
          "times_panned_after",
          "pan_output_overflow",
          "inventory_slots_before",
          "inventory_slots_after",
          "inventory_units_before",
          "inventory_units_after",
          "tool_selected",
          "tool_before",
          "slot_before",
          "tool_restored",
        ],
        (e) => {
          const before = integerEvidenceValue(e.times_panned_before);
          const after = integerEvidenceValue(e.times_panned_after);
          return (
            validSlot(e.slot) &&
            hasOpaqueEvidenceValue(e.tool) &&
            hasToolSelectionEvidence(e, "pan") &&
            hasTileEvidenceValue(e.tile) &&
            hasBoundedNonemptyEvidenceValue(e.location) &&
            // The panning site is a live, non-zero tile before the pan (the admission refuses
            // Point.Zero) and the native call clears it afterwards.
            hasTileEvidenceValue(e.site_before) &&
            hasTileEvidenceValue(e.site_after) &&
            e.site_moved === "true" &&
            before !== null &&
            after !== null &&
            after === before + 1 &&
            (e.pan_output_overflow === "true" || e.pan_output_overflow === "false") &&
            integerEvidenceValue(e.inventory_slots_before) !== null &&
            integerEvidenceValue(e.inventory_slots_after) !== null &&
            integerEvidenceValue(e.inventory_units_before) !== null &&
            integerEvidenceValue(e.inventory_units_after) !== null
          );
        },
      )
    );
  },
  claim_mail_attachment: (claim) => {
    // farmhandexecutioncontroller.itemtileactions.cs:785-805: `claimed` is exactly
    // `mail_removed && mail_recorded` (the queue lost this letter and the mail registry
    // holds it). The letter-menu and inventory facts are reported, never asserted.
    return (
      claim.reasonCode === "mail_claimed" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "tile",
          "location",
          "mail_id",
          "mail_content_known",
          "mail_has_attachment",
          "mail_attachment_commands",
          "mail_recorded_natively",
          "pending_before",
          "pending_after",
          "mail_removed",
          "mail_recorded",
          "letter_opened",
          "letter_closed",
          "collection_overflow_pending",
          "mail_salvage_inventory_units",
          "mail_salvage_debris_units",
          "inventory_slots_before",
          "inventory_slots_after",
          "inventory_units_before",
          "inventory_units_after",
        ],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          hasTileEvidenceValue(e.tile) &&
          hasBoundedNonemptyEvidenceValue(e.location) &&
          hasBoundedNonemptyEvidenceValue(e.mail_id) &&
          booleanEvidenceValue(e.mail_content_known) &&
          booleanEvidenceValue(e.mail_has_attachment) &&
          integerEvidenceValue(e.mail_attachment_commands) !== null &&
          booleanEvidenceValue(e.mail_recorded_natively) &&
          integerEvidenceValue(e.pending_before) !== null &&
          integerEvidenceValue(e.pending_after) !== null &&
          e.mail_removed === "true" &&
          e.mail_recorded === "true" &&
          booleanEvidenceValue(e.letter_opened) &&
          booleanEvidenceValue(e.letter_closed) &&
          booleanEvidenceValue(e.collection_overflow_pending) &&
          integerEvidenceValue(e.inventory_slots_before) !== null &&
          integerEvidenceValue(e.inventory_slots_after) !== null &&
          integerEvidenceValue(e.inventory_units_before) !== null &&
          integerEvidenceValue(e.inventory_units_after) !== null,
      )
    );
  },
  water_pet_bowl: (claim) => {
    // farmhandexecutioncontroller.petbowlactions.cs:112-115: the native watering path ran
    // and the bowl's own watered flag flipped. Same embodied-conservation clause as
    // water_crop, because it runs the same native tool path.
    return claim.reasonCode === "pet_bowl_watered" && hasWateringToolCompletionEvidence(claim.detail);
  },
  water_slime_hutch_trough: (claim) => {
    // farmhandexecutioncontroller.slimehutchtroughactions.cs:135-138: same native tool
    // path and same evidence shape as water_pet_bowl.
    return claim.reasonCode === "slime_hutch_trough_watered" && hasWateringToolCompletionEvidence(claim.detail);
  },
  dismiss_modal: (claim) => {
    // farmhandexecutioncontroller.modalactions.cs DescribeDismissalOutcome: the native close ran, and the receipt
    // names what it left behind. `has_more_pages`/`next_modal_type` are OPTIONAL because a dismissal that the
    // engine's own continuation follows (`closeDialogue` invokes `Game1.afterDialogues`, DialogueBox.cs:243-248) is
    // still a success with a different shape, and `text` is optional because only a DialogueBox has anything to
    // quote. `clearing` is the shipping commit's own state: its close is driven inside the menu's outro
    // (ShippingMenu.cs:380-428), so the menu is still mounted when the receipt is minted.
    //
    // AND THE LATCH'S OWN TERMINAL. farmhandexecutioncontroller.modalactions.cs:353-359 answers a SECOND dismiss of a
    // shipping commit already under way with `settlement_commit_in_progress` instead of re-entering `okClicked`,
    // because re-entry re-arms the outro fade. That reason code means "the commit is ALREADY being driven", never
    // "you dismissed something" - which is why `dismissed=false` is REQUIRED there and not merely tolerated: a caller
    // that reads `dismissed` as the answer to its request must see the false. Without this arm the latch's two
    // terminals were readable on only one side, so a receipt-backed re-ask (the recovery path for a dismiss whose
    // response timed out) landed as a succeeded receipt with zero typed transitions.
    return (
      (claim.reasonCode === "modal_dismissed" &&
        declaredCompletionEvidence(
          claim.detail,
          ["modal_type", "dismissed", "cleared_modal", "close_effect"],
          (e) =>
            hasOpaqueEvidenceValue(e.modal_type) &&
            e.dismissed === "true" &&
            e.cleared_modal === e.modal_type &&
            (e.close_effect === "native_dialogue_close" ||
              e.close_effect === "pure_cancel" ||
              e.close_effect === "engine_shipping_commit") &&
            (e.has_more_pages === undefined || booleanEvidenceValue(e.has_more_pages)) &&
            (e.next_modal_type === undefined || hasOpaqueEvidenceValue(e.next_modal_type)),
          ["text", "has_more_pages", "next_modal_type", "clearing"],
        )) ||
      (claim.reasonCode === "settlement_commit_in_progress" &&
        declaredCompletionEvidence(
          claim.detail,
          ["modal_type", "dismissed", "cleared_modal", "close_effect", "commit_already_driven"],
          (e) =>
            hasOpaqueEvidenceValue(e.modal_type) &&
            e.dismissed === "false" &&
            e.cleared_modal === e.modal_type &&
            e.close_effect === "engine_shipping_commit" &&
            e.commit_already_driven === "true" &&
            (e.clearing === undefined || booleanEvidenceValue(e.clearing)),
          ["text", "clearing"],
        ))
    );
  },
  answer_dialogue: (claim) => {
    // farmhandexecutioncontroller.modalactions.cs:255-260: the native answer was accepted
    // and the dialogue's own outro started.
    return (
      claim.reasonCode === "answer_dialogue_answered" &&
      declaredCompletionEvidence(
        claim.detail,
        ["modal_type", "question", "response_key", "native_answered", "outro_started", "postcondition"],
        (e) =>
          e.modal_type === "DialogueBox" &&
          e.question === "true" &&
          hasBoundedNonemptyEvidenceValue(e.response_key) &&
          e.native_answered === "true" &&
          e.outro_started === "true" &&
          e.postcondition === "dialogue_outro_started",
      )
    );
  },
  respond_level_up: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.modalactions.cs:355-516 RequestLocalRespondLevelUp —
    // modal_type;skill;level;is_profession;chosen_profession;remaining_new_levels;pair_settled;
    // profession_settled;menu_closed. The Mod mints `level_up_resolved` only when
    // `pairSettled && professionSettled && !menu.isActive`, and it writes the SAME evidence under
    // `level_up_postcondition_unavailable` when those do not hold — so the terminal code is what
    // separates a resolved menu from an unresolved one, not the shape.
    //
    // All three conjuncts are now readable, which is the point of a completion rule: `menu_closed` is
    // the menu's own active flag re-read after the settlement, and `pair_settled`/`profession_settled`
    // are the engine's own re-reads of the two things the settlement claims to have done
    // (`!actor.newLevels.Contains(pair)`, `!actor.professions.Contains(chosen) || !isProfession`).
    // Before those two were published the rule agreed with the receipt on everything EXCEPT the two
    // facts the success condition turns on — it had to trust the producer for exactly those.
    //
    // What the rule still restates from the shape: the modal was the LevelUpMenu, the settled pair is
    // integral, and the branch the receipt names agrees with the kind of menu it settled
    // (`is_profession=true` names a profession and an ordinary level names `none` — the one reading that
    // would otherwise claim a profession write that never happened).
    //
    // A LevelUpMenu has no pure-cancel path (`cleanupBeforeExit -> okButtonClicked` grants the perk), so
    // `menu_closed` is not decoration: it is the only statement in the receipt that the thing which grants
    // levels stopped showing.
    return (
      claim.reasonCode === "level_up_resolved" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "modal_type",
          "skill",
          "level",
          "is_profession",
          "chosen_profession",
          "remaining_new_levels",
          "pair_settled",
          "profession_settled",
          "menu_closed",
        ],
        (e) =>
          e.modal_type === "LevelUpMenu" &&
          integerEvidenceValue(e.skill) !== null &&
          positiveIntegerEvidence(e.level) !== null &&
          booleanEvidenceValue(e.is_profession) &&
          (e.is_profession === "true"
            ? integerEvidenceValue(e.chosen_profession) !== null
            : e.chosen_profession === "none") &&
          integerEvidenceValue(e.remaining_new_levels) !== null &&
          e.pair_settled === "true" &&
          e.profession_settled === "true" &&
          e.menu_closed === "true",
      )
    );
  },
  chest_store: (claim) => {
    // farmhandexecutioncontroller.containeractions.cs:107-113: the chest took the whole stack,
    // the player slot released that same item, and the chest gained exactly the held stack.
    return (
      claim.reasonCode === "chest_stored" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "location",
          "target",
          "tile",
          "container",
          "item",
          "player_stack_before",
          "player_stack_after",
          "source_consumed",
          "chest_stack_before",
          "chest_stack_after",
          "native_menu_opened",
        ],
        (e) => {
          const playerBefore = integerEvidenceValue(e.player_stack_before);
          const chestBefore = integerEvidenceValue(e.chest_stack_before);
          const chestAfter = integerEvidenceValue(e.chest_stack_after);
          return (
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            isStorageContainerKind(e.container) &&
            hasOpaqueEvidenceValue(e.item) &&
            playerBefore !== null &&
            integerEvidenceValue(e.player_stack_after) !== null &&
            e.source_consumed === "true" &&
            chestBefore !== null &&
            chestAfter !== null &&
            chestAfter === chestBefore + playerBefore &&
            e.native_menu_opened === "false"
          );
        },
      )
    );
  },
  chest_retrieve: (claim) => {
    // farmhandexecutioncontroller.containeractions.cs:192-196: the whole stack left the chest
    // (`leftover is null`) and the same amount entered the backpack. The stack size itself is
    // not in the receipt, so both observed deltas are required and must agree.
    return (
      claim.reasonCode === "chest_retrieved" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "location",
          "target",
          "tile",
          "container",
          "item",
          "chest_stack_before",
          "chest_stack_after",
          "inventory_before",
          "inventory_after",
          "native_menu_opened",
          "leftover_returned",
        ],
        (e) => {
          const chestBefore = integerEvidenceValue(e.chest_stack_before);
          const chestAfter = integerEvidenceValue(e.chest_stack_after);
          const inventoryBefore = integerEvidenceValue(e.inventory_before);
          const inventoryAfter = integerEvidenceValue(e.inventory_after);
          return (
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            isStorageContainerKind(e.container) &&
            hasOpaqueEvidenceValue(e.item) &&
            chestBefore !== null &&
            chestAfter !== null &&
            inventoryBefore !== null &&
            inventoryAfter !== null &&
            chestAfter < chestBefore &&
            inventoryAfter > inventoryBefore &&
            chestBefore - chestAfter === inventoryAfter - inventoryBefore &&
            e.native_menu_opened === "false" &&
            e.leftover_returned === "false"
          );
        },
      )
    );
  },
  chop_stump: (claim) => {
    // farmhandexecutioncontroller.resourcetoolactions.cs:575-584: the native stump fell
    // (health marker -100) or its terrain feature is gone.
    return (
      claim.reasonCode === "stump_cleared" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "type",
          "tree",
          "tool",
          "tool_level",
          "health_before",
          "health_after",
          "swings",
          "stump_removed",
          "stamina_before",
          "stamina_after",
          "stamina_delta",
          "expected_stamina_cost",
          "tool_selected",
          "slot",
          "tool_before",
          "slot_before",
          "tool_restored",
        ],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          e.type === "tree_stump" &&
          hasOpaqueEvidenceValue(e.tree) &&
          e.tool === "axe" &&
          hasToolSelectionEvidence(e, "axe") &&
          integerEvidenceValue(e.tool_level) !== null &&
          finiteEvidenceValue(e.health_before) !== null &&
          hasBoundedNonemptyEvidenceValue(e.health_after) &&
          positiveIntegerEvidence(e.swings) !== null &&
          e.stump_removed === "true" &&
          hasStaminaConservationEvidence(e),
      )
    );
  },
  plant_sapling: (claim) => {
    // farmhandexecutioncontroller.farmingconstructionactions.cs:386-394: the native placement
    // ran, a Tree now stands on the tile, and the backpack lost exactly one sapling.
    return (
      claim.reasonCode === "sapling_planted" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "location",
          "target",
          "tile",
          "item",
          "slot",
          "tree_type",
          "inventory_before",
          "inventory_after",
          "native_placement",
        ],
        (e) =>
          hasBoundedNonemptyEvidenceValue(e.location) &&
          hasOpaqueIdEvidenceValue(e.target) &&
          hasTileEvidenceValue(e.tile) &&
          hasOpaqueEvidenceValue(e.item) &&
          validSlot(e.slot) &&
          e.tree_type !== "none" &&
          hasOpaqueEvidenceValue(e.tree_type) &&
          decremented(e.inventory_before, e.inventory_after) &&
          e.native_placement === "true",
      )
    );
  },
  sweep_scythe: (claim) => {
    // farmhandexecutioncontroller.resourcetoolactions.cs ExecuteSweepScythe: ONE native swing drove the engine's own arc
    // (MeleeWeapon.DoDamage once per animation index) and the named tile moved. The arc counts are a MEASUREMENT of the
    // tiles the six rectangles sampled, never a promise about what the swing would reach, and nothing here claims a
    // monster hit: six evaluations are not vanilla's seven.
    return claim.reasonCode === "scythe_sweep_cut" && hasSweepScytheCompletionEvidence(claim.detail);
  },
  cut_weeds: (claim) => {
    // farmhandexecutioncontroller.resourcetoolactions.cs ExecuteCutWeeds: the native weed branch reported the cut
    // AND the map entry left the world; the handler selected the scythe its own registration claims and put the
    // actor's selection back, which is the only place `tool_restored` is written.
    return (
      claim.reasonCode === "weeds_cut" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "type",
          "tool",
          "tool_selected",
          "slot",
          "tool_before",
          "slot_before",
          "qualified_item_id",
          "health_before",
          "health_after",
          "swings",
          "removed",
          "stamina_before",
          "stamina_after",
          "stamina_delta",
          "expected_stamina_cost",
          "tool_restored",
        ],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          e.type === "weed" &&
          e.tool === "scythe" &&
          hasToolSelectionEvidence(e, "scythe") &&
          hasOpaqueEvidenceValue(e.qualified_item_id) &&
          integerEvidenceValue(e.health_before) !== null &&
          hasBoundedNonemptyEvidenceValue(e.health_after) &&
          positiveIntegerEvidence(e.swings) !== null &&
          e.removed === "true" &&
          hasStaminaConservationEvidence(e),
      )
    );
  },
  cut_grass: (claim) => {
    // farmhandexecutioncontroller.resourcetoolactions.cs ExecuteCutGrass: the tuft is gone from the terrain layer,
    // with the same select-then-restore facts as cut_weeds. The hay roll inside Grass.TryDropItemsOnCut is
    // deliberately not re-derived (the producer records only what actually changed).
    return (
      claim.reasonCode === "grass_cut" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "type",
          "tool",
          "tool_selected",
          "slot",
          "tool_before",
          "slot_before",
          "grass_type",
          "weeds_before",
          "weeds_after",
          "swings",
          "removed",
          "tuft_removed",
          "stamina_before",
          "stamina_after",
          "stamina_delta",
          "expected_stamina_cost",
          "tool_restored",
        ],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          e.type === "grass" &&
          e.tool === "scythe" &&
          hasToolSelectionEvidence(e, "scythe") &&
          integerEvidenceValue(e.grass_type) !== null &&
          integerEvidenceValue(e.weeds_before) !== null &&
          hasBoundedNonemptyEvidenceValue(e.weeds_after) &&
          positiveIntegerEvidence(e.swings) !== null &&
          e.removed === "true" &&
          e.tuft_removed === "true" &&
          hasStaminaConservationEvidence(e),
      )
    );
  },
  clear_cask: (claim) => {
    // farmhandexecutioncontroller.facilityactions.cs:46-52: `postcondition` is the
    // producer's own re-read of the cask tile (gone, or present and emptied).
    return (
      claim.reasonCode === "cask_cleared" &&
      declaredCompletionEvidence(
        claim.detail,
        ["target", "tool", "had_held_object", "held_qualified_item_id", "removed", "postcondition"],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          hasOpaqueEvidenceValue(e.tool) &&
          booleanEvidenceValue(e.had_held_object) &&
          isNoneOrOpaqueEvidenceValue(e.held_qualified_item_id) &&
          booleanEvidenceValue(e.removed) &&
          e.postcondition === "true",
      )
    );
  },
  dress_mannequin: (claim) => {
    // farmhandexecutioncontroller.facilityactions.cs:88-98: the named body field of the
    // mannequin now holds exactly the offered item. Slot/item stay in the identity clause.
    return (
      claim.reasonCode === "mannequin_dressed" &&
      declaredCompletionEvidence(
        claim.detail,
        ["target", "slot", "item", "stored"],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          validSlot(e.slot) &&
          hasOpaqueEvidenceValue(e.item) &&
          e.stored === "true",
      )
    );
  },
  set_sign_display: (claim) => {
    // farmhandexecutioncontroller.facilityactions.cs:129-133: Sign.checkForAction handled the
    // request and the sign's own display slot holds exactly the offered item.
    return (
      claim.reasonCode === "sign_display_set" &&
      declaredCompletionEvidence(
        claim.detail,
        ["target", "slot", "item"],
        (e) => hasOpaqueIdEvidenceValue(e.target) && validSlot(e.slot) && hasOpaqueEvidenceValue(e.item),
      )
    );
  },
  deposit_silo_hay: (claim) => {
    // farmhandexecutioncontroller.facilityactions.cs:169-171: the silo's own hay counter gained
    // exactly what the held stack lost, and the source slot released that much.
    return (
      claim.reasonCode === "silo_hay_deposited" &&
      declaredCompletionEvidence(claim.detail, ["target", "slot", "stored", "hay_before", "hay_after"], (e) => {
        const stored = positiveIntegerEvidence(e.stored);
        const before = integerEvidenceValue(e.hay_before);
        const after = integerEvidenceValue(e.hay_after);
        return (
          hasOpaqueIdEvidenceValue(e.target) &&
          validSlot(e.slot) &&
          stored !== null &&
          before !== null &&
          after !== null &&
          after === before + stored
        );
      })
    );
  },
  toggle_tool_light: (claim) => {
    // farmhandexecutioncontroller.facilityactions.cs:184-189: the native LightSource.DoFunction
    // returns void, so only the lantern's own flag moving proves the toggle.
    return (
      claim.reasonCode === "tool_light_toggled" &&
      declaredCompletionEvidence(
        claim.detail,
        ["slot", "was_on", "is_on"],
        (e) =>
          validSlot(e.slot) && booleanEvidenceValue(e.was_on) && booleanEvidenceValue(e.is_on) && e.was_on !== e.is_on,
      )
    );
  },
  harvest_bush: (claim) => {
    // farmhandexecutioncontroller.treebushactions.cs:67-72: the bush's own harvest state flip
    // is the postcondition across every size. A size-4 bush queues its drop inside the native
    // mutex, so the in-frame debris delta is OBSERVED and deliberately not asserted.
    return (
      claim.reasonCode === "bush_harvested" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "tile",
          "ready_for_harvest_before",
          "ready_for_harvest_after",
          "debris_before",
          "debris_after",
          "item_dropped_in_frame",
        ],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          hasTileEvidenceValue(e.tile) &&
          e.ready_for_harvest_before === "true" &&
          e.ready_for_harvest_after === "false" &&
          integerEvidenceValue(e.debris_before) !== null &&
          integerEvidenceValue(e.debris_after) !== null &&
          booleanEvidenceValue(e.item_dropped_in_frame),
      )
    );
  },
  harvest_fruit_tree: (claim) => {
    // farmhandexecutioncontroller.treebushactions.cs:114-117: Tree.shake produced fruit debris
    // in the same frame, and that debris delta is the whole postcondition.
    return (
      claim.reasonCode === "fruit_tree_harvested" &&
      declaredCompletionEvidence(
        claim.detail,
        ["target", "tile", "debris_before", "debris_after", "fruit_dropped"],
        (e) => {
          const before = integerEvidenceValue(e.debris_before);
          const after = integerEvidenceValue(e.debris_after);
          return (
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            before !== null &&
            after !== null &&
            after > before &&
            e.fruit_dropped === "true"
          );
        },
      )
    );
  },
  shake_tree: (claim) => {
    // farmhandexecutioncontroller.treebushactions.cs:185-188: the seed left the tree AND the
    // native shaken-today lock was recorded, which is exactly the producer's own condition.
    return (
      claim.reasonCode === "tree_shaken" &&
      declaredCompletionEvidence(
        claim.detail,
        ["target", "tile", "has_seed_before", "has_seed_after", "shaken_today"],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          hasTileEvidenceValue(e.tile) &&
          e.has_seed_before === "true" &&
          e.has_seed_after === "false" &&
          e.shaken_today === "true",
      )
    );
  },
  take_pedestal_item: (claim) => {
    // farmhandexecutioncontroller.cs:1326-1331 UpdateActivePedestalTaking: the pedestal's own
    // held object is empty and the backpack gained at least the stack that was on it.
    return (
      claim.reasonCode === "pedestal_item_taken" &&
      declaredCompletionEvidence(
        claim.detail,
        ["location", "target", "item", "stack", "inventory_before", "inventory_after", "held_object_empty"],
        (e) => {
          const stack = positiveIntegerEvidence(e.stack);
          const before = integerEvidenceValue(e.inventory_before);
          const after = integerEvidenceValue(e.inventory_after);
          return (
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasOpaqueIdEvidenceValue(e.target) &&
            hasOpaqueEvidenceValue(e.item) &&
            stack !== null &&
            before !== null &&
            after !== null &&
            after >= before + stack &&
            e.held_object_empty === "true"
          );
        },
      )
    );
  },
  toggle_fence_gate: (claim) => {
    // farmhandexecutioncontroller.pedestalfenceactions.cs:131-135: the gate's own position moved
    // between its two native values (0 closed / 88 open), and `is_open` is derived from it.
    return (
      claim.reasonCode === "fence_gate_toggled" &&
      declaredCompletionEvidence(
        claim.detail,
        ["target", "tile", "gate_position_before", "gate_position_after", "is_open"],
        (e) => {
          const before = integerEvidenceValue(e.gate_position_before);
          const after = integerEvidenceValue(e.gate_position_after);
          return (
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            before !== null &&
            after !== null &&
            ((before === 0 && after === 88) || (before === 88 && after === 0)) &&
            e.is_open === (after === 88 ? "true" : "false")
          );
        },
      )
    );
  },
  scythe_crop: (claim) => {
    // farmhandexecutioncontroller.farmingconstructionactions.cs: the crop left the HoeDirt AND the matching
    // produce debris appeared — the native scythe HARVEST branch never puts anything in the backpack, so
    // inventory growth is not a postcondition here.
    //
    // `dead_crop_cleared` is the engine's OTHER scythe branch (HoeDirt.cs:732-735), which fires for a dead crop
    // alone: `Crop.harvest` refuses a dead crop outright (Crop.cs:484-491), so that branch destroys the crop and
    // drops nothing. Its one guarantee is `crop_removed`, and `crop_dead=true` says which branch ran - without
    // this rule the only action that can free a season-killed tile would record zero typed transitions.
    return (
      (claim.reasonCode === "scythe_crops_harvested" || claim.reasonCode === "dead_crop_cleared") &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "crop",
          "harvested_item",
          "crop_dead",
          "debris_before",
          "debris_after",
          "crop_removed",
          "stamina_before",
          "stamina_after",
          "stamina_delta",
          "expected_stamina_cost",
          "native_scythe",
          "tool_selected",
          "slot",
          "tool_before",
          "slot_before",
          "tool_restored",
        ],
        (e) => {
          const before = integerEvidenceValue(e.debris_before);
          const after = integerEvidenceValue(e.debris_after);
          const cleared = claim.reasonCode === "dead_crop_cleared";
          return (
            hasOpaqueIdEvidenceValue(e.target) &&
            hasBoundedNonemptyEvidenceValue(e.crop) &&
            hasToolSelectionEvidence(e, "scythe") &&
            // A harvest must name the produce it dropped; a clear must name that there is none, because a dead
            // crop yields nothing and "none" is the receipt's own word for that absence.
            (cleared ? e.harvested_item === "none" : hasOpaqueEvidenceValue(e.harvested_item)) &&
            before !== null &&
            after !== null &&
            // The two branches have different debris terminals: the harvest branch must have produced its drop,
            // the dead branch produces none at all.
            (cleared ? after === before : after > before) &&
            e.crop_removed === "true" &&
            e.crop_dead === (cleared ? "true" : "false") &&
            e.native_scythe === (cleared ? "false" : "true") &&
            hasStaminaConservationEvidence(e)
          );
        },
      )
    );
  },
  craft_item: (claim) => {
    // farmhandexecutioncontroller.craftingactions.cs:151-154: the Succeeded terminal is the
    // `remainingStack == 0` branch, i.e. the whole product entered the backpack; the same
    // call also requires exact ingredient consumption, the native craft counter, and no menu.
    return (
      claim.reasonCode === "crafted_item_created" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "location",
          "recipe",
          "output",
          "produced_stack",
          "produced_per_craft",
          "disposition",
          "inventory_gained_stack",
          "dropped_stack",
          "inventory_accepting_before",
          "materials_consumed_exactly",
          "inventory_postcondition",
          "count_before",
          "count_after",
          "count_postcondition",
          "ingredients",
          "dropped_debris",
          "native_menu_opened",
        ],
        (e) => {
          const produced = positiveIntegerEvidence(e.produced_stack);
          const perCraft = positiveIntegerEvidence(e.produced_per_craft);
          const gained = integerEvidenceValue(e.inventory_gained_stack);
          const countBefore = integerEvidenceValue(e.count_before);
          const countAfter = integerEvidenceValue(e.count_after);
          return (
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasOpaqueEvidenceValue(e.recipe) &&
            hasOpaqueEvidenceValue(e.output) &&
            produced !== null &&
            perCraft !== null &&
            (e.disposition === "added_to_inventory" || e.disposition === "granted_without_inventory_space") &&
            gained !== null &&
            gained === produced &&
            e.dropped_stack === "0" &&
            booleanEvidenceValue(e.inventory_accepting_before) &&
            e.materials_consumed_exactly === "true" &&
            e.inventory_postcondition === "true" &&
            countBefore !== null &&
            countAfter !== null &&
            countAfter === countBefore + perCraft &&
            e.count_postcondition === "true" &&
            hasBoundedNonemptyEvidenceValue(e.ingredients) &&
            integerEvidenceValue(e.dropped_debris) !== null &&
            e.native_menu_opened === "false"
          );
        },
      )
    );
  },
  cook_recipe: (claim) => {
    // farmhandexecutioncontroller.cookingactions.cs:244-253 mints two Succeeded terminals:
    //   dish_cooked                    — the whole dish entered the backpack (dropped 0);
    //   dish_cooked_dropped_on_ground  — a full backpack, so the whole dish was dropped.
    // `dish_cooked_output_dropped` is PartiallySucceeded and is refused by the state gate.
    return (
      (claim.reasonCode === "dish_cooked" && hasCookRecipeCompletionEvidence(claim.detail, false)) ||
      (claim.reasonCode === "dish_cooked_dropped_on_ground" && hasCookRecipeCompletionEvidence(claim.detail, true))
    );
  },
  collect_crab_pot_output: (claim) => {
    // farmhandexecutioncontroller.crabpotactions.cs:177-185: the native 714 branch ran and the
    // pot is back to its empty, unbaited 710 state, with the 1..2 native delivery window in the
    // backpack. `numToCatch` is content/state derived (Crabbing book), so the window is the rule.
    return (
      claim.reasonCode === "crab_pot_output_collected" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "location",
          "target",
          "tile",
          "pot",
          "owner",
          "output",
          "stack_delivered",
          "inventory_before",
          "inventory_after",
          "held_after",
          "ready_after",
          "tile_index_after",
          "bait_after",
          "pot_retained",
          "native_handled",
          "native_entry",
          "fishing_experience_before",
          "fishing_experience_after",
        ],
        (e) => {
          const delivered = integerEvidenceValue(e.stack_delivered);
          const before = integerEvidenceValue(e.inventory_before);
          const after = integerEvidenceValue(e.inventory_after);
          return (
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            e.pot === "(O)710" &&
            hasDecimalOwnerIdEvidenceValue(e.owner) &&
            hasOpaqueEvidenceValue(e.output) &&
            delivered !== null &&
            delivered >= 1 &&
            delivered <= 2 &&
            before !== null &&
            after !== null &&
            after === before + delivered &&
            e.held_after === "none" &&
            e.ready_after === "false" &&
            e.tile_index_after === "710" &&
            e.bait_after === "none" &&
            e.pot_retained === "true" &&
            e.native_handled === "true" &&
            e.native_entry === "GameLocation.checkAction,CrabPot.checkForAction" &&
            integerEvidenceValue(e.fishing_experience_before) !== null &&
            integerEvidenceValue(e.fishing_experience_after) !== null
          );
        },
      )
    );
  },
  ship_item: (claim) => {
    // farmhandexecutioncontroller.shippingactions.cs:106-111: the source slot released the
    // stack, the bin gained exactly it, and the native Farm.lastItemShipped is that item.
    return (
      claim.reasonCode === "item_shipped" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "location",
          "target",
          "bin",
          "tile",
          "item",
          "slot",
          "stack",
          "inventory_before",
          "inventory_after",
          "bin_before",
          "bin_after",
          "last_item_shipped_matched",
          "native_menu_opened",
        ],
        (e) => {
          const stack = positiveIntegerEvidence(e.stack);
          const inventoryBefore = integerEvidenceValue(e.inventory_before);
          const inventoryAfter = integerEvidenceValue(e.inventory_after);
          const binBefore = integerEvidenceValue(e.bin_before);
          const binAfter = integerEvidenceValue(e.bin_after);
          return (
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.bin) &&
            hasTileEvidenceValue(e.tile) &&
            hasOpaqueEvidenceValue(e.item) &&
            validSlot(e.slot) &&
            stack !== null &&
            inventoryBefore !== null &&
            inventoryAfter !== null &&
            inventoryAfter === inventoryBefore - stack &&
            binBefore !== null &&
            binAfter !== null &&
            binAfter === binBefore + stack &&
            e.last_item_shipped_matched === "true" &&
            e.native_menu_opened === "false"
          );
        },
      )
    );
  },
  shop_purchase: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.shopactions.cs - the terminal is minted only when the trade
    // moved BOTH sides (`moneyAfter < moneyBefore && gained > 0`), and the receipt carries:
    // shop;owner;entry;item;requested;purchased;unit_price;money_before;money_after;owned_before;owned_after;
    // gained;stock_before;stock_after;owner_tile;menu_closed;clicks;drops.
    //
    // The rule restates the Mod's OWN success condition from the evidence instead of trusting the code: money
    // went down, goods went up, and the menu really closed. `owner` is `none` when the shop is entered through
    // its counter TILE (no NPC owns it), and the two diagnostics are lists whose entries separate their parts
    // with `|`.
    //
    // Both of those shapes are recent: the tile-opened case used to write an EMPTY `owner=`, and the diagnostics
    // used to embed `;` inside their values - either one splits into fields this module cannot read, which is why
    // the action previously had no rule at all (a rule that cannot match the producer's real detail would look
    // like completion coverage while never accepting a success).
    return (
      claim.reasonCode === "item_purchased" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "shop",
          "owner",
          "entry",
          "item",
          "requested",
          "purchased",
          "unit_price",
          "money_before",
          "money_after",
          "owned_before",
          "owned_after",
          "gained",
          "stock_before",
          "stock_after",
          "owner_tile",
          "menu_closed",
          "clicks",
          "drops",
        ],
        (e) =>
          (e.shop?.length ?? 0) > 0 &&
          (e.owner?.length ?? 0) > 0 &&
          (e.entry === "tile_action" || e.entry === "npc_owner") &&
          hasOpaqueEvidenceValue(e.item) &&
          integerEvidenceValue(e.requested) !== null &&
          integerEvidenceValue(e.purchased) !== null &&
          integerEvidenceValue(e.unit_price) !== null &&
          // NOT `decremented`/`incremented`: those are the exact +/-1 helpers for a single-unit transfer, and a
          // purchase of several units moves money and goods by the price and the quantity. The Mod's own success
          // condition is the inequality (`moneyAfter < moneyBefore && gained > 0`), so the rule states it.
          integerEvidenceValue(e.money_before) !== null &&
          integerEvidenceValue(e.money_after) !== null &&
          (integerEvidenceValue(e.money_after) ?? 0) < (integerEvidenceValue(e.money_before) ?? 0) &&
          integerEvidenceValue(e.owned_before) !== null &&
          integerEvidenceValue(e.owned_after) !== null &&
          (integerEvidenceValue(e.owned_after) ?? 0) > (integerEvidenceValue(e.owned_before) ?? 0) &&
          (integerEvidenceValue(e.gained) ?? 0) > 0 &&
          e.menu_closed === "true" &&
          hasTileEvidenceValue(e.owner_tile),
      )
    );
  },
  move_placed_furniture: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.worldobjectactions.cs RequestLocalMovePlacedFurniture —
    // target;location;tile;item;native_stored;removed_from_furniture;carried;inventory_before;inventory_after;
    // carried_tile;carried_rotation;carried_flipped;furniture_in_location.
    //
    // The pickup is three native steps (`piece.performRemoveAction`, `location.furniture.Remove`,
    // `addItemToInventoryBool`) and the only answer any of them gives is the LAST one's bool, so the bool is not
    // the proof: the Mod mints `placed_furniture_picked_up` only when `gone && carried`, and this rule restates
    // both halves from the reading. Furniture is not an object on a tile — it lives in `location.furniture`
    // (GameLocation.cs:452) — so the collection is the authority for the row leaving and the pack for it arriving,
    // and the piece must have left the tile the caller named.
    return (
      claim.reasonCode === "placed_furniture_picked_up" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "location",
          "tile",
          "item",
          "native_stored",
          "removed_from_furniture",
          "carried",
          "inventory_before",
          "inventory_after",
          "carried_tile",
          "carried_rotation",
          "carried_flipped",
          "furniture_in_location",
        ],
        (e) => {
          const rotation = integerEvidenceValue(e.carried_rotation);
          const stillInLocation = integerEvidenceValue(e.furniture_in_location);
          return (
            hasOpaqueIdEvidenceValue(e.target) &&
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasTileEvidenceValue(e.tile) &&
            hasOpaqueEvidenceValue(e.item) &&
            e.native_stored === "true" &&
            e.removed_from_furniture === "true" &&
            e.carried === "true" &&
            incremented(e.inventory_before, e.inventory_after) &&
            e.carried_tile === e.tile &&
            rotation !== null &&
            rotation >= 0 &&
            rotation <= 3 &&
            booleanEvidenceValue(e.carried_flipped) &&
            stillInLocation !== null &&
            stillInLocation >= 0
          );
        },
      )
    );
  },
  rotate_furniture: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.furnituredecorationactions.cs RequestLocalRotateFurniture —
    // target;tile;location;item;rotation_before;rotation_after;rotation_expected;rotations;flipped_before;
    // flipped_after;footprint_before;footprint_after;placeable;turned;standing;furniture_in_location.
    //
    // `Furniture.rotate()` returns void, and below two `rotations` it does nothing at all (Furniture.cs:1155), so
    // there is no native answer to read: the Mod's success is `turned && standing && holdsTheTurn`, all three read
    // AFTER the write and after the occupancy probe. The rule restates them: the piece's own `currentRotation`
    // moved, it still carries the value the native call produced (the probe re-reads `tileLocation` and cannot have
    // turned it back), and the piece is still in `location.furniture` on the tile it was named on.
    return (
      claim.reasonCode === "furniture_rotated" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "tile",
          "location",
          "item",
          "rotation_before",
          "rotation_after",
          "rotation_expected",
          "rotations",
          "flipped_before",
          "flipped_after",
          "footprint_before",
          "footprint_after",
          "placeable",
          "turned",
          "standing",
          "furniture_in_location",
        ],
        (e) => {
          const before = integerEvidenceValue(e.rotation_before);
          const after = integerEvidenceValue(e.rotation_after);
          const produced = integerEvidenceValue(e.rotation_expected);
          const rotations = integerEvidenceValue(e.rotations);
          const inLocation = integerEvidenceValue(e.furniture_in_location);
          return (
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasOpaqueEvidenceValue(e.item) &&
            before !== null &&
            after !== null &&
            produced !== null &&
            before >= 0 &&
            before <= 3 &&
            after >= 0 &&
            after <= 3 &&
            produced >= 0 &&
            produced <= 3 &&
            after !== before &&
            after === produced &&
            rotations !== null &&
            rotations >= 2 &&
            rotations <= 4 &&
            booleanEvidenceValue(e.flipped_before) &&
            booleanEvidenceValue(e.flipped_after) &&
            hasFootprintEvidenceValue(e.footprint_before) &&
            hasFootprintEvidenceValue(e.footprint_after) &&
            e.placeable === "true" &&
            e.turned === "true" &&
            e.standing === "true" &&
            inLocation !== null &&
            inLocation >= 1
          );
        },
      )
    );
  },
  remove_fence: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.furnituredecorationactions.cs ExecuteRemoveFence —
    // target;location;tile;item;is_gate;tool;slot;swings;held_object_before;health_before;max_health;removed;
    // tile_object_after;drops;drop_count;stamina_before;stamina_after.
    //
    // `Fence.performToolAction` returns FALSE on every branch, including the one that destroyed the fence
    // (Fence.cs:473), so a return value here proves nothing at all. Success is the fence GONE from the object
    // collection it stood in, with the drops the swings produced named beside it. A gate is its own native branch
    // (:447-454) that only an Axe or a Pickaxe reaches, so a receipt claiming a gate removed by another tool is
    // not a fence this engine took down.
    //
    // `drops` is `none` when nothing dropped: an EMPTY value splits into a field `parseSemicolonEvidence` must
    // refuse, which would make the first real zero-drop removal unreadable — the same producer bug `shop_purchase`
    // carried with an empty `owner=`.
    return (
      claim.reasonCode === "fence_removed" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "location",
          "tile",
          "item",
          "is_gate",
          "tool",
          "slot",
          "swings",
          "held_object_before",
          "health_before",
          "max_health",
          "removed",
          "tile_object_after",
          "drops",
          "drop_count",
          "stamina_before",
          "stamina_after",
        ],
        (e) => {
          const swings = integerEvidenceValue(e.swings);
          const health = finiteEvidenceValue(e.health_before);
          const maxHealth = finiteEvidenceValue(e.max_health);
          const dropped = integerEvidenceValue(e.drop_count);
          const named = e.drops === "none" ? 0 : (e.drops ?? "").split("|").length;
          return (
            hasOpaqueIdEvidenceValue(e.target) &&
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasTileEvidenceValue(e.tile) &&
            hasOpaqueEvidenceValue(e.item) &&
            booleanEvidenceValue(e.is_gate) &&
            hasBoundedNonemptyEvidenceValue(e.tool) &&
            validSlot(e.slot) &&
            swings !== null &&
            swings >= 1 &&
            swings <= 2 &&
            booleanEvidenceValue(e.held_object_before) &&
            health !== null &&
            maxHealth !== null &&
            maxHealth > 0 &&
            health >= 0 &&
            health <= maxHealth &&
            e.removed === "true" &&
            e.tile_object_after === "none" &&
            dropped !== null &&
            dropped === named &&
            finiteEvidenceValue(e.stamina_before) !== null &&
            finiteEvidenceValue(e.stamina_after) !== null &&
            (e.is_gate === "true" ? e.tool === "axe" || e.tool === "pickaxe" : true)
          );
        },
      )
    );
  },
  put_item_in_fish_tank: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.furnituredecorationactions.cs RequestLocalPutItemInFishTank —
    // target;tile;location;item;slot;native_answered;held_items_before;held_items_after;last_held;carried_before;
    // carried_after;mutex_locked_after.
    //
    // The tank's own `checkForAction` answers TRUE without depositing in two branches (a held mutex, :231-234, and
    // a full category, :237-241), so its bool is not completion. The Mod's success is read after the engine's own
    // `NetMutex.Update` settled the hand-off: the tank's `heldItems` grew by exactly one and the item at the end is
    // this one, and the pack lost exactly one. A deposit the engine took the item for without completing it is put
    // back and reported as `fish_tank_postcondition_not_observed`, never as this terminal.
    return (
      claim.reasonCode === "fish_tank_item_deposited" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "tile",
          "location",
          "item",
          "slot",
          "native_answered",
          "held_items_before",
          "held_items_after",
          "last_held",
          "carried_before",
          "carried_after",
          "mutex_locked_after",
        ],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          hasTileEvidenceValue(e.tile) &&
          hasBoundedNonemptyEvidenceValue(e.location) &&
          hasOpaqueEvidenceValue(e.item) &&
          validSlot(e.slot) &&
          e.native_answered === "true" &&
          incremented(e.held_items_before, e.held_items_after) &&
          e.last_held === e.item &&
          decremented(e.carried_before, e.carried_after) &&
          booleanEvidenceValue(e.mutex_locked_after),
      )
    );
  },
  place_item_on_pedestal: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.furnituredecorationactions.cs ExecutePlaceItemOnPedestal —
    // target;tile;location;item;slot;native_answered;held;match;locked;lock_on_success;carried_before;
    // carried_after.
    //
    // `performObjectDropInAction` answers a bool whose occupied branch KNOCKS the existing item off and then says
    // false (ItemPedestal.cs:97-101), so the bool alone cannot be completion. The Mod's success needs the read
    // after the engine's own `NetMutex.Update` settled the drop: the pedestal's `heldObject` IS the item the
    // request named, and the pack lost exactly one. `match`/`locked` are the pedestal's own flags, written by
    // `UpdateItemMatch` when the item it wanted lands, and they are reported rather than required — a shrine
    // satisfied is a fact about the pedestal, not a condition of placing the item.
    return (
      claim.reasonCode === "pedestal_item_placed" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "target",
          "tile",
          "location",
          "item",
          "slot",
          "native_answered",
          "held",
          "match",
          "locked",
          "lock_on_success",
          "carried_before",
          "carried_after",
        ],
        (e) =>
          hasOpaqueIdEvidenceValue(e.target) &&
          hasTileEvidenceValue(e.tile) &&
          hasBoundedNonemptyEvidenceValue(e.location) &&
          hasOpaqueEvidenceValue(e.item) &&
          validSlot(e.slot) &&
          e.native_answered === "true" &&
          e.held === e.item &&
          booleanEvidenceValue(e.match) &&
          booleanEvidenceValue(e.locked) &&
          booleanEvidenceValue(e.lock_on_success) &&
          decremented(e.carried_before, e.carried_after),
      )
    );
  },
  fish_here: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.fishingactions.cs UpdateFishingCast / SettleFishingCast —
    // location;target;tile;caught_qualified_item_id;display_name;fish_size;quality;pull_outcome;
    // pull_unobserved_field;bite_observed;cast_to_credit_ms;rod_durability_left;bait_before;bait_left;
    // bait_consumed;stamina_before;stamina_after;stamina_delta;inventory_before;inventory_after;
    // fish_caught_before;fish_caught_after;fish_caught_delta;credit.
    //
    // THE CATCH IS THE CREDIT, and the rod cannot answer it: `FishingRod.fishCaught` is set by the win path
    // (:1092) and cleared by the very next settle (:2352). The engine's own saved record is `Farmer.fishCaught`,
    // which `caughtFish` writes inside the win path (:1104) and never clears, so the rule requires that count to
    // have RISEN for the qualified id the receipt names - the pair the Mod reads before the win path runs and
    // after the engine's settle. `credit` restates the pair, so a receipt whose two readings and its own summary
    // disagree is refused. The bar was not played, and the receipt says so (`pull_outcome=not_verified` with the
    // field it could not observe named) - that openness is the Mod's honesty, not a gap this rule may fill.
    return (
      claim.reasonCode === "fish_caught" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "location",
          "target",
          "tile",
          "caught_qualified_item_id",
          "display_name",
          "fish_size",
          "quality",
          "pull_outcome",
          "pull_unobserved_field",
          "bite_observed",
          "cast_to_credit_ms",
          "rod_durability_left",
          "bait_before",
          "bait_left",
          "bait_consumed",
          "stamina_before",
          "stamina_after",
          "stamina_delta",
          "inventory_before",
          "inventory_after",
          "fish_caught_before",
          "fish_caught_after",
          "fish_caught_delta",
          "credit",
        ],
        (e) => {
          const caughtBefore = integerEvidenceValue(e.fish_caught_before);
          const caughtAfter = integerEvidenceValue(e.fish_caught_after);
          const caughtDelta = integerEvidenceValue(e.fish_caught_delta);
          const baitBefore = integerEvidenceValue(e.bait_before);
          const baitLeft = integerEvidenceValue(e.bait_left);
          const staminaBefore = finiteEvidenceValue(e.stamina_before);
          const staminaAfter = finiteEvidenceValue(e.stamina_after);
          const staminaDelta = finiteEvidenceValue(e.stamina_delta);
          const quality = integerEvidenceValue(e.quality);
          return (
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            hasOpaqueEvidenceValue(e.caught_qualified_item_id) &&
            hasBoundedNonemptyEvidenceValue(e.display_name) &&
            integerEvidenceValue(e.fish_size) !== null &&
            quality !== null &&
            quality >= 0 &&
            quality <= 4 &&
            e.pull_outcome === "not_verified" &&
            e.pull_unobserved_field === "BobberBar.distanceFromCatching" &&
            booleanEvidenceValue(e.bite_observed) &&
            integerEvidenceValue(e.cast_to_credit_ms) !== null &&
            signedIntegerEvidenceValue(e.rod_durability_left) !== null &&
            baitBefore !== null &&
            baitLeft !== null &&
            integerEvidenceValue(e.bait_consumed) === baitBefore - baitLeft &&
            staminaBefore !== null &&
            staminaAfter !== null &&
            staminaDelta !== null &&
            Math.abs(staminaAfter - staminaBefore - staminaDelta) <= 0.001 &&
            integerEvidenceValue(e.inventory_before) !== null &&
            integerEvidenceValue(e.inventory_after) !== null &&
            caughtBefore !== null &&
            caughtAfter !== null &&
            caughtDelta !== null &&
            caughtDelta >= 1 &&
            caughtAfter === caughtBefore + caughtDelta &&
            e.credit === `fishCaught:${caughtBefore}->${caughtAfter}`
          );
        },
      )
    );
  },
  open_geode: (claim) => {
    // Evidence literal: farmhandexecutioncontroller.geodeactions.cs CrackGeode — slot;inventory_slots;location;
    // item;geode_stack;geode_owned_before;geode_owned_after;geode_consumed;money_before;money_after;fee;
    // fee_taken;pumped_ms;crack_settled;treasure;treasure_stack;treasure_before;treasure_after;delivered;
    // menu_closed.
    //
    // Four engine facts, none of them a return value: `GeodeMenu.receiveLeftClick` takes a COPY onto the spot and
    // the treasure does not exist until the menu's own `update` mints it (GeodeMenu.cs:373-385) and delivers it
    // (:222-236). So the rule restates the Mod's own success condition: the geode left the pack by exactly one, the
    // fee the menu actually charged is the fee it reports and the purse moved by it, a treasure was minted and the
    // pack gained the whole stack, and the menu this execution opened is closed. `fee` is compared against the FEE
    // TAKEN rather than pinned to a number here, so a change to the game's price is one fact in one place.
    return (
      claim.reasonCode === "geode_opened" &&
      declaredCompletionEvidence(
        claim.detail,
        [
          "slot",
          "inventory_slots",
          "location",
          "item",
          "geode_stack",
          "geode_owned_before",
          "geode_owned_after",
          "geode_consumed",
          "money_before",
          "money_after",
          "fee",
          "fee_taken",
          "pumped_ms",
          "crack_settled",
          "treasure",
          "treasure_stack",
          "treasure_before",
          "treasure_after",
          "delivered",
          "menu_closed",
        ],
        (e) => {
          const moneyBefore = integerEvidenceValue(e.money_before);
          const moneyAfter = integerEvidenceValue(e.money_after);
          const fee = integerEvidenceValue(e.fee);
          const feeTaken = integerEvidenceValue(e.fee_taken);
          const geodeBefore = integerEvidenceValue(e.geode_owned_before);
          const geodeAfter = integerEvidenceValue(e.geode_owned_after);
          const treasureBefore = integerEvidenceValue(e.treasure_before);
          const treasureAfter = integerEvidenceValue(e.treasure_after);
          const delivered = integerEvidenceValue(e.delivered);
          const treasureStack = positiveIntegerEvidence(e.treasure_stack);
          return (
            validSlot(e.slot) &&
            integerEvidenceValue(e.inventory_slots) !== null &&
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasOpaqueEvidenceValue(e.item) &&
            positiveIntegerEvidence(e.geode_stack) !== null &&
            geodeBefore !== null &&
            geodeAfter !== null &&
            integerEvidenceValue(e.geode_consumed) === 1 &&
            geodeBefore - geodeAfter === 1 &&
            moneyBefore !== null &&
            moneyAfter !== null &&
            fee !== null &&
            feeTaken !== null &&
            feeTaken === fee &&
            moneyBefore - moneyAfter === feeTaken &&
            integerEvidenceValue(e.pumped_ms) !== null &&
            e.crack_settled === "true" &&
            hasOpaqueEvidenceValue(e.treasure) &&
            treasureStack !== null &&
            treasureBefore !== null &&
            treasureAfter !== null &&
            delivered !== null &&
            delivered === treasureAfter - treasureBefore &&
            delivered >= treasureStack &&
            e.menu_closed === "true"
          );
        },
      )
    );
  },
} satisfies Record<ExecutionRequest["action"], CompletionContract>);

/**
 * Whether this receipt proves the action completed.
 *
 * A FOLD over `STARDEW_COMPLETION_CONTRACTS`. An id that is not in the table is refused, and the `hasOwn` check is what
 * makes that a refusal rather than a prototype read: `STARDEW_COMPLETION_CONTRACTS["constructor"]` would otherwise hand
 * back a function and call it with the claim, which is a completion verdict nobody declared.
 */
export function hasStardewCompletionEvidence(actionId: string, receipt: IntegrationReceiptEvidence): boolean {
  const detail = receipt.evidence?.detail;
  if (receipt.state !== "succeeded" || typeof detail !== "string" || detail.length === 0 || detail.length > 4_096)
    return false;
  const contract = (STARDEW_COMPLETION_CONTRACTS as Readonly<Record<string, CompletionContract | undefined>>)[actionId];
  if (contract === undefined) return false;
  if (!Object.hasOwn(STARDEW_COMPLETION_CONTRACTS, actionId)) return false;
  return contract({ reasonCode: receipt.reasonCode, detail });
}
