import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { STARDEW_ACTION_ADAPTERS } from "./action-registry.js";
import { STARDEW_COMPLETION_CONTRACTS } from "./stardew-completion-contracts.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The completion-evidence coverage invariant.
 *
 * One rule per registered action id, each rule grounded in the Mod handler that mints the
 * terminal: a real `succeeded` receipt whose `reasonCode` and evidence keys match that handler
 * must be accepted, and nothing else may be. Before this file the adapter's switch covered 36
 * of the registered actions and every other action fell to `default: return false`, so a real
 * success was recorded as zero typed transitions with no test to notice.
 *
 * The per-action fixtures below are the Mod's own success shapes. They give the coverage claim
 * teeth: remove a rule from the adapter switch and this file goes red on the coverage test;
 * rename a rule's required key and it goes red on that action's missing-key case.
 */

const completionEvidence = (actionId: string, reasonCode: string, detail: string): boolean =>
  STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(actionId, {
    state: "succeeded",
    reasonCode,
    evidence: { detail },
  });

type CompletionFixture = Readonly<{
  reasonCode: string;
  fields: readonly (readonly [string, string])[];
  /** Fields whose removal must be refused; defaults to every field. */
  requiredFields?: readonly string[];
}>;

const detail = (fields: readonly (readonly [string, string])[]): string =>
  fields.map(([key, value]) => `${key}=${value}`).join(";");

/**
 * Actions deliberately left without a rule, each needing a measured reason.
 *
 * EMPTY, and the two entries that were here are worth recording because they were both producer bugs, not
 * review choices: `shop_purchase` could not be read at all, because
 * `farmhandexecutioncontroller.shopactions.cs` embedded the field separator inside the `clicks`/`drops` values
 * (each diagnostic entry is itself `key=value;key=value`) and wrote an EMPTY `owner=` for a tile-opened shop.
 * Both shapes split into fields `parseSemicolonEvidence` must refuse, so a rule could never match a real
 * success - it would have looked like coverage while accepting nothing. The producer now writes `owner=none` and
 * separates diagnostic parts with `|`, so the action has a rule and the A/B for those two shapes is pinned
 * below.
 */
const actionsWithoutCompletionRule: readonly string[] = [];

const completionFixtures: Readonly<Record<string, CompletionFixture>> = {
  select_mine_elevator_floor: {
    reasonCode: "mine_elevator_floor_selected",
    fields: [
      ["expected", "UndergroundMine10:6,6"],
      ["actual", "UndergroundMine10:8,4"],
      ["level", "10"],
    ],
    // `level` is OPTIONAL for this rule: `hasMineElevatorFloorCompletionEvidence` also accepts the two-key
    // `expected`/`actual` shape, and then it is the destination prefix that carries the floor. So the
    // load-bearing pair here is the two locations, not the third key.
    requiredFields: ["expected", "actual"],
  },
  ride_bus: {
    reasonCode: "bus_arrived",
    fields: [
      ["origin", "BusStop"],
      ["destination", "Desert"],
      ["fare", "500"],
      ["money_before", "5000"],
      ["money_after", "4500"],
    ],
  },
  use_raft: {
    reasonCode: "raft_launched",
    fields: [
      ["tile", "12,33"],
      ["is_rafting", "true"],
      ["stamina_before", "100"],
      ["stamina_after", "99"],
    ],
  },
  mount_transport: {
    reasonCode: "horse_mounted",
    fields: [
      ["target", "horse_0123456789abcdef"],
      ["horse_id", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
      ["mounted", "true"],
      ["mounting", "false"],
    ],
  },
  enter_mine: {
    reasonCode: "mine_entered",
    fields: [
      ["level", "11"],
      ["tile", "6,6"],
      ["from_level", "10"],
    ],
    // Same shape of statement: `hasMineEntryCompletionEvidence` accepts the three-key form here and the
    // two-key `level`/`tile` form elsewhere, so `from_level` is a bonus rather than a requirement - and the
    // level and the landing tile are what the rule actually reads.
    requiredFields: ["level", "tile"],
  },
  express_emote: {
    reasonCode: "emote_started",
    fields: [
      ["emote", "happy"],
      ["native_dispatched", "true"],
    ],
  },
  face_direction: {
    reasonCode: "actor_facing_matches",
    // `moving` is the walk's own effect on the facing (`movementactions.cs:1388-1396`), published beside the direction
    // because a facing applied mid-walk is the walk's on the next step.
    fields: [
      ["direction", "up"],
      ["moving", "false"],
    ],
  },
  // The substituted arrival (`DescribeMoveArrival`, farmhandexecutioncontroller.movementactions.cs:56-61): the tile
  // the caller named held the thing it wanted to touch, so the body walked to a standable neighbour inside the
  // native interaction radius and the receipt names all three facts. Seven of these in one day of round77 read as
  // nothing until the row learned the shape, which is why the fixture is the ADJACENT form and not the walk's own.
  move_to_tile: {
    reasonCode: "target_reached",
    fields: [
      ["reached", "adjacent"],
      ["requested", "3,12"],
      ["actor", "3,11"],
      ["within_range_of_request", "true"],
    ],
  },
  interact_npc_with_item: {
    reasonCode: "gift_given",
    fields: [
      ["location", "Farm"],
      ["target", "npc_relationship_0123456789abcdef"],
      ["tile", "3,4"],
      ["npc", "Pierre"],
      ["item", "(O)72"],
      ["slot", "4"],
      ["stack_before", "3"],
      ["points_before", "0"],
      ["gifts_today_before", "0"],
      ["gifts_this_week_before", "0"],
      ["quest_25_completed_before", "true"],
      ["stack_after", "2"],
      ["points_after", "80"],
      ["gifts_today_after", "1"],
      ["gifts_this_week_after", "1"],
      ["quest_25_completed_after", "true"],
      ["update_gift_limit", "true"],
      ["showed_response", "false"],
      ["gift_recorded", "true"],
      ["points_changed", "true"],
      ["spouse_jealousy", "false"],
      ["spouse_points_before", "-1"],
      ["spouse_points_after", "-1"],
      ["menu_open_after", "false"],
      ["dialogue_open_after", "false"],
    ],
  },
  pet_animal: {
    reasonCode: "pet_completed",
    fields: [
      ["location", "Farm"],
      ["target", "pet_0123456789abcdef"],
      ["tile", "4,5"],
      ["pet_day", "120"],
      ["friendship_before", "10"],
      ["friendship_after", "15"],
      ["day_recorded", "true"],
      ["friendship_callback", "true"],
    ],
  },
  pet_farm_animal: {
    reasonCode: "farm_animal_petted",
    fields: [
      ["location", "Barn"],
      ["target", "farm_animal_0123456789abcdef"],
      ["animal", "41"],
      ["type", "White Chicken"],
      ["tile", "4,5"],
      ["friendship_before", "120"],
      ["friendship_after", "135"],
      ["friendship_floor", "135"],
      ["happiness_before", "60"],
      ["happiness_after", "90"],
      ["was_auto_pet_before", "false"],
      ["was_pet", "true"],
      ["time_of_day", "900"],
    ],
  },
  sleep: {
    reasonCode: "day_advanced",
    // The producer's own shape, duplicate `topology` included: the base list
    // (SleepAndAdvanceDayLifecycle.cs:865-874) and the settlement block (:835-852) both write it.
    // The rule reads the three terminal markers; the rest of the block is the lifecycle's own
    // settlement report and is deliberately not required.
    requiredFields: ["state", "reason", "day_started_observed"],
    fields: [
      ["state", "passed"],
      ["reason", "day_advanced"],
      ["topology", "single_player"],
      ["entered_via", "native_sleep"],
      ["day_before", "100"],
      ["days_before", "99"],
      ["day_after", "101"],
      ["days_after", "100"],
      ["saving_observed", "true"],
      ["saved_observed", "true"],
      ["day_started_observed", "true"],
      ["enteredVia", "native_sleep"],
      ["topology", "single_player"],
      ["dayBefore", "100"],
      ["dayAfter", "101"],
      ["daysPlayedBefore", "99"],
      ["daysPlayedAfter", "100"],
      ["savingObserved", "true"],
      ["savedObserved", "true"],
      ["dayStartedObserved", "true"],
      ["readyCheckObserved", "false"],
    ],
  },
  clear_debris: {
    reasonCode: "debris_cleared",
    fields: [
      ["location", "Farm"],
      ["target", "debris_0123456789abcdef"],
      ["tile", "8,9"],
      ["parent", "600"],
      ["tool", "axe"],
      ["required_upgrade", "1"],
      ["health_before", "2"],
      ["health_after", "0"],
      ["clump_removed", "true"],
      ["stamina_before", "100"],
      ["stamina_after", "98"],
      ["stamina_delta", "-2"],
      ["expected_stamina_cost", "2"],
    ],
  },
  break_resource_clump: {
    // farmhandexecutioncontroller.farmingconstructionactions.cs ExecuteBreakResourceClump, composed from
    // ToolActionEvidence.BreakResourceClump: a 2x2 boulder (672) cleared with the steel pickaxe its own native branch
    // demands (`ResourceClump.performToolAction`: 672 needs a Pickaxe at upgrade 2), five swings from 10 health to 0,
    // the clump gone from `location.resourceClumps` and the destroying swing's item drop observed.
    reasonCode: "clump_broken",
    fields: [
      ["location", "Farm"],
      ["target", "debris_0123456789abcdef"],
      ["tile", "8,9"],
      ["parent", "672"],
      ["required_upgrade", "2"],
      ["tool", "pickaxe"],
      ["tool_selected", "pickaxe"],
      ["slot", "3"],
      ["tool_before", "axe"],
      ["slot_before", "0"],
      ["health_before", "10"],
      ["health_after", "0"],
      ["swings", "5"],
      ["clump_removed", "true"],
      ["drop_observed", "true"],
      ["stamina_before", "100"],
      ["stamina_after", "90"],
      ["stamina_delta", "-10"],
      ["expected_stamina_cost", "10"],
      ["tool_restored", "axe"],
    ],
  },
  npc_relationship: {
    reasonCode: "npc_relationship_inspected",
    fields: [
      ["location", "Farm"],
      ["target", "npc_relationship_0123456789abcdef"],
      ["tile", "3,4"],
      ["npc", "Pierre"],
      ["points", "80"],
      ["status", "Friendly"],
      ["talked_to_today", "true"],
      ["gifts_today", "1"],
      ["gifts_this_week", "1"],
    ],
  },
  equip_wearable: {
    reasonCode: "wearable_equipped",
    fields: [
      ["body_slot", "hat"],
      ["slot", "5"],
      ["named_slot", "4"],
      ["requested", "(H)9"],
      ["occupant_before", "(H)8"],
      ["occupant_after", "(H)9"],
      ["displaced", "(H)8"],
      ["pack_slot_after", "(H)8"],
    ],
  },
  unequip_wearable: {
    reasonCode: "wearable_unequipped",
    fields: [
      ["body_slot", "hat"],
      ["destination_slot", "5"],
      ["occupant_before", "(H)9"],
      ["occupant_after", "none"],
      ["removed", "(H)9"],
      ["destination_before", "none"],
      ["destination_after", "(H)9"],
      ["landed", "true"],
    ],
  },
  dismount_transport: {
    reasonCode: "transport_dismounted",
    fields: [
      ["horse_id", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
      ["location", "Farm"],
      ["tile", "4,5"],
      ["riding_before", "true"],
      ["mounting_before", "false"],
      ["riding_after", "false"],
      ["mount_after", "false"],
    ],
  },
  use_warp_item: {
    reasonCode: "warp_item_arrived",
    fields: [
      ["expected", "Desert:20,10"],
      ["actual", "Desert:21,11"],
    ],
  },
  pan_ore: {
    reasonCode: "ore_panned",
    fields: [
      ["slot", "4"],
      ["tool", "Copper Pan"],
      ["tile", "12,33"],
      ["location", "Beach"],
      ["site_before", "12,33"],
      ["site_after", "0,0"],
      ["site_moved", "true"],
      ["times_panned_before", "3"],
      ["times_panned_after", "4"],
      ["pan_output_overflow", "false"],
      ["inventory_slots_before", "1"],
      ["inventory_slots_after", "2"],
      ["inventory_units_before", "1"],
      ["inventory_units_after", "3"],
      ["tool_selected", "pan"],
      ["tool_before", "axe"],
      ["slot_before", "0"],
      ["tool_restored", "axe"],
    ],
  },
  claim_mail_attachment: {
    reasonCode: "mail_claimed",
    fields: [
      ["target", "mailbox_0123456789abcdef"],
      ["tile", "68,8"],
      ["location", "Farm"],
      ["mail_id", "spring_2"],
      ["mail_content_known", "true"],
      ["mail_has_attachment", "false"],
      ["mail_attachment_commands", "0"],
      ["mail_recorded_natively", "false"],
      ["pending_before", "1"],
      ["pending_after", "0"],
      ["mail_removed", "true"],
      ["mail_recorded", "true"],
      ["letter_opened", "true"],
      ["letter_closed", "true"],
      ["collection_overflow_pending", "false"],
      // The two salvage counters the handler emits after the overflow cleanup was made to salvage rather than
      // discard: this fixture is the Mod's own success shape, so it must carry every field the rule expects.
      ["mail_salvage_inventory_units", "0"],
      ["mail_salvage_debris_units", "0"],
      ["inventory_slots_before", "0"],
      ["inventory_slots_after", "0"],
      ["inventory_units_before", "0"],
      ["inventory_units_after", "0"],
    ],
  },
  // The two area-tool actions. `charge_requested`/`charge_applied` are the charge the caller named and the one the
  // swing was given - equal by construction, because a charge the held tool cannot reach is refused rather than
  // clamped - and `window`/`tiles_changed`/`changed` are the box that was scanned and the tiles that actually entered
  // the postcondition in ONE native use. `charge: 0` is the single named tile, which is why the footprint is one tile.
  till_soil: {
    reasonCode: "soil_tilled",
    fields: [
      ["location", "Farm"],
      ["target", "37,18"],
      ["tool_selected", "hoe"],
      ["slot", "3"],
      ["tool_before", "none"],
      ["slot_before", "0"],
      ["before", "none"],
      ["after", "HoeDirt"],
      ["charge_requested", "0"],
      ["charge_applied", "0"],
      ["window", "32,13:42,23"],
      ["tiles_changed", "1"],
      ["changed", "37:18"],
      ["stamina_before", "100"],
      ["stamina_after", "98"],
      ["stamina_delta", "-2"],
      ["expected_stamina_cost", "2"],
      ["tool_restored", "none"],
    ],
  },
  water_crop: {
    reasonCode: "crop_watered",
    fields: [
      ["location", "Farm"],
      ["target", "crop_abcdef0123456789"],
      ["tile", "38,18"],
      ["tool_selected", "watering_can"],
      ["slot", "2"],
      ["tool_before", "axe"],
      ["slot_before", "0"],
      ["before_watered", "false"],
      ["after_watered", "true"],
      ["water_before", "40"],
      ["water_after", "39"],
      ["water_consumed", "true"],
      // THE ENGINE SPENDS WATER BY THE CHARGE, NOT BY THE TILE: `WaterLeft -= power + 1` (WateringCan.cs:189-191), so
      // a charge-4 watering of eighteen tiles costs five units. `charge: 0` is one tile and one unit.
      ["water_expected_cost", "1"],
      ["charge_requested", "0"],
      ["charge_applied", "0"],
      ["window", "33,13:43,23"],
      ["tiles_changed", "1"],
      ["changed", "38:18"],
      ["stamina_before", "100"],
      ["stamina_after", "98"],
      ["stamina_delta", "-2"],
      ["expected_stamina_cost", "2"],
      ["tool_restored", "axe"],
    ],
  },
  water_pet_bowl: {
    reasonCode: "pet_bowl_watered",
    fields: [
      ["location", "Farm"],
      ["target", "pet_bowl_0123456789abcdef"],
      ["tile", "5,5"],
      ["before_watered", "false"],
      ["after_watered", "true"],
      ["water_before", "39"],
      ["water_after", "38"],
      ["water_consumed", "true"],
      ["stamina_before", "100"],
      ["stamina_after", "98"],
      ["stamina_delta", "-2"],
      ["expected_stamina_cost", "2"],
      ["native_menu_opened", "false"],
      ["tool_selected", "watering_can"],
      ["slot", "3"],
      ["tool_before", "none"],
      ["slot_before", "0"],
      ["tool_restored", "none"],
    ],
  },
  water_slime_hutch_trough: {
    reasonCode: "slime_hutch_trough_watered",
    fields: [
      ["location", "SlimeHutch"],
      ["target", "slime_hutch_trough_0123456789abcdef"],
      ["tile", "6,5"],
      ["before_watered", "false"],
      ["after_watered", "true"],
      ["water_before", "39"],
      ["water_after", "38"],
      ["water_consumed", "true"],
      ["stamina_before", "100"],
      ["stamina_after", "98"],
      ["stamina_delta", "-2"],
      ["expected_stamina_cost", "2"],
      ["native_menu_opened", "false"],
      ["tool_selected", "watering_can"],
      ["slot", "3"],
      ["tool_before", "none"],
      ["slot_before", "0"],
      ["tool_restored", "none"],
    ],
  },
  dismiss_modal: {
    reasonCode: "modal_dismissed",
    fields: [
      ["modal_type", "DialogueBox"],
      ["dismissed", "true"],
      ["cleared_modal", "DialogueBox"],
      ["close_effect", "native_dialogue_close"],
      // `text` is the box's own line, which the Mod quotes whenever it could read one before the close
      // (`farmhandexecutioncontroller.modalactions.cs` BoundedModalText). It is OPTIONAL: a box with no readable
      // text (or a non-dialogue menu) publishes no such key, and neither shape may be refused for that.
      ["text", "明天的天气预报：大雨"],
    ],
    requiredFields: ["modal_type", "dismissed", "cleared_modal", "close_effect"],
  },
  answer_dialogue: {
    reasonCode: "answer_dialogue_answered",
    fields: [
      ["modal_type", "DialogueBox"],
      ["question", "true"],
      ["response_key", "Yes"],
      ["native_answered", "true"],
      ["outro_started", "true"],
      ["postcondition", "dialogue_outro_started"],
    ],
  },
  // The modal family's third action. An ordinary level is the shape the common case takes; the profession
  // chooser is the SAME terminal's other branch, and it is pinned with its own A/B at the bottom of this file.
  respond_level_up: {
    reasonCode: "level_up_resolved",
    fields: [
      ["modal_type", "LevelUpMenu"],
      ["skill", "2"],
      ["level", "3"],
      ["is_profession", "false"],
      ["chosen_profession", "none"],
      ["remaining_new_levels", "0"],
      ["pair_settled", "true"],
      ["profession_settled", "true"],
      ["menu_closed", "true"],
    ],
  },
  chest_store: {
    reasonCode: "chest_stored",
    fields: [
      ["location", "Farm"],
      ["target", "chest_0123456789abcdef"],
      ["tile", "3,4"],
      ["container", "chest"],
      ["item", "(O)388"],
      // The backpack slot the stack came from: the action takes the FIRST stack of the item id, so the receipt is the
      // only place that names which one moved (`FarmhandActionDefinitions.ChestStoreItemMeaning`).
      ["source_slot", "4"],
      ["player_stack_before", "5"],
      ["player_stack_after", "0"],
      ["source_consumed", "true"],
      ["chest_stack_before", "0"],
      ["chest_stack_after", "5"],
      ["native_menu_opened", "false"],
    ],
  },
  chest_retrieve: {
    reasonCode: "chest_retrieved",
    fields: [
      ["location", "Farm"],
      ["target", "chest_0123456789abcdef"],
      ["tile", "3,4"],
      ["container", "chest"],
      ["item", "(O)388"],
      ["chest_stack_before", "5"],
      ["chest_stack_after", "0"],
      ["inventory_before", "0"],
      ["inventory_after", "5"],
      ["leftover_returned", "false"],
      ["native_menu_opened", "false"],
    ],
  },
  chop_stump: {
    reasonCode: "stump_cleared",
    fields: [
      ["target", "tree_stump_0123456789abcdef"],
      ["type", "tree_stump"],
      ["tree", "1"],
      ["tool", "axe"],
      ["tool_level", "0"],
      ["health_before", "5"],
      ["health_after", "destroyed"],
      ["swings", "5"],
      ["stump_removed", "true"],
      ["stamina_before", "100"],
      ["stamina_after", "90"],
      ["stamina_delta", "-10"],
      ["expected_stamina_cost", "10"],
      ["tool_selected", "axe"],
      ["slot", "3"],
      ["tool_before", "axe"],
      ["slot_before", "0"],
      ["tool_restored", "axe"],
    ],
  },
  plant_sapling: {
    reasonCode: "sapling_planted",
    fields: [
      ["location", "Farm"],
      ["target", "tree_sapling_0123456789abcdef"],
      ["tile", "6,7"],
      ["item", "(O)628"],
      ["slot", "4"],
      ["tree_type", "2"],
      ["inventory_before", "3"],
      ["inventory_after", "2"],
      ["native_placement", "true"],
    ],
  },
  plant_seed: {
    // `round80`'s own success, field for field (`timeline.jsonl` index 50, request `022b0f2f8c7347e5b6ff4f7bcacd7a1a`,
    // revision 87): a Parsnip seed left the pack at Farm 12,37. The handler also printed `slot`/`named_slot` there, which
    // no reader takes, and a receipt carrying an undeclared field is refused WHOLE - so this run minted two
    // `seed_planted` successes, counted `succeeded/seed_planted` in its day record, and never admitted `plant_seed`.
    // The pair was deleted from the producer; the seven keys below are what it prints now.
    reasonCode: "seed_planted",
    fields: [
      ["location", "Farm"],
      ["target", "seed_6bf4e600e1b7abd5"],
      ["tile", "12,37"],
      ["item", "(O)474"],
      ["crop", "474"],
      ["inventory_before", "2"],
      ["inventory_after", "1"],
    ],
  },
  sweep_scythe: {
    // `round80`'s own success (`timeline.jsonl` index 22, request `384b3bc023674af298b6e819687218da`): ONE swing put the
    // engine's arc over eleven tiles, three of them carried a weed, and all three moved. `after_occupant=none` is the
    // named tile EMPTY after the cut, which is this action's success - and the rule refused it until its after-side
    // reader learned the word this Mod spells empty with. The live receipt also carried `steps=2;folded=…` (the
    // settlement envelope, declared once in `STARDEW_SETTLEMENT_ENVELOPE_FIELDS` and stripped before any row reads it),
    // which is why no fixture here lists it.
    reasonCode: "scythe_sweep_cut",
    fields: [
      ["location", "Farm"],
      ["target", "40,9"],
      ["before_occupant", "weed"],
      ["after_occupant", "none"],
      ["named_moved", "true"],
      ["arc_tiles", "11"],
      ["arc_sweepable", "3"],
      ["arc_clear", "5"],
      ["changed", "40:8:weed|40:9:weed|39:10:weed"],
      ["tiles_changed", "3"],
      ["tool_selected", "scythe"],
      ["slot", "4"],
      ["tool_before", "axe"],
      ["slot_before", "0"],
      ["stamina_before", "270"],
      ["stamina_after", "270"],
      ["stamina_delta", "0"],
      ["expected_stamina_cost", "0"],
      ["tool_restored", "axe"],
    ],
  },
  cut_weeds: {
    reasonCode: "weeds_cut",
    fields: [
      ["target", "weed_0123456789abcdef"],
      ["type", "weed"],
      ["tool", "scythe"],
      ["tool_selected", "scythe"],
      ["slot", "1"],
      ["tool_before", "axe"],
      ["slot_before", "0"],
      ["qualified_item_id", "(O)313"],
      ["health_before", "2"],
      ["health_after", "removed"],
      ["swings", "2"],
      ["removed", "true"],
      ["stamina_before", "100"],
      ["stamina_after", "100"],
      ["stamina_delta", "0"],
      ["expected_stamina_cost", "0"],
      ["tool_restored", "axe"],
    ],
  },
  cut_grass: {
    reasonCode: "grass_cut",
    fields: [
      ["target", "grass_0123456789abcdef"],
      ["type", "grass"],
      ["tool", "scythe"],
      ["tool_selected", "scythe"],
      ["slot", "1"],
      ["tool_before", "none"],
      ["slot_before", "0"],
      ["grass_type", "1"],
      ["weeds_before", "4"],
      ["weeds_after", "removed"],
      ["swings", "4"],
      ["removed", "true"],
      ["tuft_removed", "true"],
      ["stamina_before", "100"],
      ["stamina_after", "100"],
      ["stamina_delta", "0"],
      ["expected_stamina_cost", "0"],
      ["tool_restored", "none"],
    ],
  },
  clear_cask: {
    reasonCode: "cask_cleared",
    fields: [
      ["target", "cask_0123456789abcdef"],
      ["tool", "Axe"],
      ["had_held_object", "true"],
      ["held_qualified_item_id", "(O)348"],
      ["removed", "true"],
      ["postcondition", "true"],
    ],
  },
  dress_mannequin: {
    reasonCode: "mannequin_dressed",
    fields: [
      ["target", "mannequin_0123456789abcdef"],
      ["slot", "4"],
      ["item", "(H)9"],
      ["stored", "true"],
    ],
  },
  set_sign_display: {
    reasonCode: "sign_display_set",
    fields: [
      ["target", "sign_0123456789abcdef"],
      ["slot", "4"],
      ["item", "(O)388"],
    ],
  },
  deposit_silo_hay: {
    reasonCode: "silo_hay_deposited",
    fields: [
      ["target", "silo_0123456789abcdef"],
      ["slot", "4"],
      ["stored", "1"],
      ["hay_before", "10"],
      ["hay_after", "11"],
    ],
  },
  toggle_tool_light: {
    reasonCode: "tool_light_toggled",
    fields: [
      ["slot", "4"],
      ["was_on", "false"],
      ["is_on", "true"],
    ],
  },
  harvest_bush: {
    reasonCode: "bush_harvested",
    fields: [
      ["target", "bush_0123456789abcdef"],
      ["tile", "7,8"],
      ["ready_for_harvest_before", "true"],
      ["ready_for_harvest_after", "false"],
      ["debris_before", "0"],
      ["debris_after", "1"],
      ["item_dropped_in_frame", "true"],
    ],
  },
  harvest_fruit_tree: {
    reasonCode: "fruit_tree_harvested",
    fields: [
      ["target", "fruit_tree_0123456789abcdef"],
      ["tile", "7,8"],
      ["debris_before", "0"],
      ["debris_after", "1"],
      ["fruit_dropped", "true"],
    ],
  },
  shake_tree: {
    reasonCode: "tree_shaken",
    fields: [
      ["target", "shake_tree_0123456789abcdef"],
      ["tile", "7,8"],
      ["has_seed_before", "true"],
      ["has_seed_after", "false"],
      ["shaken_today", "true"],
    ],
  },
  take_pedestal_item: {
    reasonCode: "pedestal_item_taken",
    fields: [
      ["location", "ArchaeologyHouse"],
      ["target", "pedestal_0123456789abcdef"],
      ["item", "(O)74"],
      ["stack", "1"],
      ["inventory_before", "0"],
      ["inventory_after", "1"],
      ["held_object_empty", "true"],
    ],
  },
  toggle_fence_gate: {
    reasonCode: "fence_gate_toggled",
    fields: [
      ["target", "fence_gate_0123456789abcdef"],
      ["tile", "9,9"],
      ["gate_position_before", "0"],
      ["gate_position_after", "88"],
      ["is_open", "true"],
    ],
  },
  scythe_crop: {
    reasonCode: "scythe_crops_harvested",
    fields: [
      ["target", "scythe_crop_0123456789abcdef"],
      ["crop", "472"],
      ["harvested_item", "(O)472"],
      ["crop_dead", "false"],
      ["debris_before", "0"],
      ["debris_after", "1"],
      ["crop_removed", "true"],
      ["stamina_before", "100"],
      ["stamina_after", "100"],
      ["stamina_delta", "0"],
      ["expected_stamina_cost", "0"],
      ["native_scythe", "true"],
      ["tool_selected", "scythe"],
      ["slot", "3"],
      ["tool_before", "none"],
      ["slot_before", "0"],
      ["tool_restored", "none"],
    ],
  },
  craft_item: {
    reasonCode: "crafted_item_created",
    fields: [
      ["location", "Farm"],
      ["recipe", "Torch"],
      ["output", "(O)93"],
      ["produced_stack", "1"],
      ["produced_per_craft", "1"],
      ["disposition", "added_to_inventory"],
      ["inventory_gained_stack", "1"],
      ["dropped_stack", "0"],
      ["inventory_accepting_before", "true"],
      ["materials_consumed_exactly", "true"],
      ["inventory_postcondition", "true"],
      ["count_before", "0"],
      ["count_after", "1"],
      ["count_postcondition", "true"],
      ["ingredients", "388:5>4|390:1>0"],
      ["dropped_debris", "0"],
      ["native_menu_opened", "false"],
    ],
  },
  cook_recipe: {
    reasonCode: "dish_cooked",
    fields: [
      ["location", "FarmHouse"],
      ["recipe", "Fried Egg"],
      ["station", "kitchen@3,4"],
      ["crafted", "(O)194"],
      ["crafted_stack", "1"],
      ["quality", "0"],
      ["seasoning_used", "False"],
      ["space_prechecked", "true"],
      ["inventory_before", "0"],
      ["inventory_after", "1"],
      ["delivered", "1"],
      ["dropped", "0"],
      ["disposition", "inventory"],
      ["recipes_cooked_before", "0"],
      ["recipes_cooked_after", "1"],
      ["count_incremented", "true"],
      ["native_menu_opened", "false"],
      ["native_entry", "CraftingRecipe.consumeIngredients,Farmer.cookedRecipe"],
    ],
  },
  collect_crab_pot_output: {
    reasonCode: "crab_pot_output_collected",
    fields: [
      ["location", "Beach"],
      ["target", "collect_crab_pot_0123456789abcdef"],
      ["tile", "12,33"],
      ["pot", "(O)710"],
      ["owner", "123456789012345678"],
      ["output", "(O)372"],
      ["stack_delivered", "2"],
      ["inventory_before", "0"],
      ["inventory_after", "2"],
      ["held_after", "none"],
      ["ready_after", "false"],
      ["tile_index_after", "710"],
      ["bait_after", "none"],
      ["pot_retained", "true"],
      ["native_handled", "true"],
      ["native_entry", "GameLocation.checkAction,CrabPot.checkForAction"],
      ["fishing_experience_before", "0"],
      ["fishing_experience_after", "3"],
    ],
  },
  ship_item: {
    reasonCode: "item_shipped",
    fields: [
      ["location", "Farm"],
      ["target", "shipping_bin_0123456789abcdef"],
      ["bin", "71,14"],
      ["tile", "71,14"],
      ["item", "(O)388"],
      ["slot", "4"],
      ["stack", "5"],
      ["inventory_before", "10"],
      ["inventory_after", "5"],
      ["bin_before", "0"],
      ["bin_after", "5"],
      ["last_item_shipped_matched", "true"],
      ["native_menu_opened", "false"],
    ],
  },

  // The prize-ticket exchange: BOTH halves of the postcondition live in the receipt, and the level it
  // names must be the stat it read, so the fixture carries coherent numbers rather than plausible ones.
  redeem_prize_ticket: {
    reasonCode: "prize_ticket_redeemed",
    fields: [
      ["prize_level", "4"],
      ["prize_item_id", "(O)770"],
      ["prize_stack", "10"],
      ["prize_held_before", "0"],
      ["prize_held_after", "10"],
      ["ticket_item_id", "(O)PrizeTicket"],
      ["tickets_before", "1"],
      ["tickets_after", "0"],
      ["prizes_claimed_before", "4"],
      ["prizes_claimed_after", "5"],
      ["prize_delivered", "true"],
    ],
  },
  // The sewing-machine pair. Each fixture is the Mod handler's OWN success shape: every emitted key, in
  // the shape `farmhandexecutioncontroller.tailoringactions.cs` writes it.
  tailor_clothing: {
    reasonCode: "clothing_tailored",
    fields: [
      ["target", "tailoring_recipe_0123456789abcdef"],
      ["left_slot", "3"],
      ["right_slot", "4"],
      ["location", "Farm"],
      ["left", "(O)428"],
      ["right", "(O)684"],
      ["output", "(H)1004"],
      ["left_before", "3"],
      ["left_after", "2"],
      ["right_before", "3"],
      ["right_after", "2"],
      ["right_spent", "true"],
      ["output_before", "0"],
      ["output_after", "1"],
      ["delivered", "1"],
      ["dropped", "0"],
      ["disposition", "inventory"],
      ["dropped_debris", "0"],
    ],
  },
  dye_clothing_with_item: {
    reasonCode: "clothing_dyed",
    fields: [
      ["target", "tailoring_dye_0123456789abcdef"],
      ["garment_slot", "3"],
      ["dye_slot", "4"],
      ["location", "Farm"],
      ["garment", "(S)1001"],
      ["dye", "(O)684"],
      ["colour_before", "255,0,0"],
      ["colour_expected", "255,255,255"],
      ["colour_after", "255,255,255"],
      ["strength", "1"],
      ["strength_source", "context_tag_dye_strong"],
      ["colour_changed", "true"],
      ["prismatic_after", "false"],
      ["dye_before", "3"],
      ["dye_after", "2"],
      ["dye_spent", "true"],
      ["colour_route", "TailoringMenu.GetDyeColor"],
    ],
  },
  color_placed_object: {
    reasonCode: "placed_object_recolored",
    fields: [
      ["target", "color_0123456789abcdef"],
      ["tile", "12,9"],
      ["location", "Farm"],
      ["color_selection", "2"],
      ["color_before", "85,85,255"],
      ["color_after", "119,191,255"],
      ["color_changed", "true"],
    ],
  },
  shop_purchase: {
    reasonCode: "item_purchased",
    fields: [
      ["shop", "SeedShop"],
      ["owner", "Pierre"],
      ["entry", "npc_owner"],
      ["item", "(O)472"],
      ["requested", "1"],
      ["purchased", "1"],
      ["unit_price", "20"],
      ["money_before", "500"],
      ["money_after", "480"],
      ["owned_before", "0"],
      ["owned_after", "1"],
      ["gained", "1"],
      ["stock_before", "5"],
      ["stock_after", "4"],
      ["owner_tile", "1,6"],
      ["menu_closed", "true"],
      // The two list-valued fields: parts separated by `|`, entries by `||`, and NO `;` anywhere inside - that
      // is what makes the whole diagnostic one readable field.
      ["clicks", "1[click0:button=0|at=412,544|addressed=True|held_after=(O)472]"],
      ["drops", "1[drop0:empty_slot=0|at=412,544|held=(O)472->(O)472]"],
    ],
    // A purchase of SEVERAL units moves money and goods by more than one, so only the inequality is required;
    // `stock_before`/`stock_after` are diagnostics of the offer and are not part of the world fact.
    requiredFields: [
      "shop",
      "owner",
      "item",
      "money_before",
      "money_after",
      "owned_before",
      "owned_after",
      "gained",
      "menu_closed",
    ],
  },
  // The seven world-mutation actions below were registered, dispatched and refused on nothing: their Mod handlers
  // already read the world after the native call and mint `*_postcondition_not_observed` when it disagrees, but this
  // switch had no arm for any of them, so `hasStardewCompletionEvidence` fell to `default: return false` and every
  // real success they produced was recorded as zero typed transitions. The shapes are the Mod's own evidence literals,
  // key for key, with the before/after pairs those handlers read.
  move_placed_furniture: {
    reasonCode: "placed_furniture_picked_up",
    fields: [
      ["target", "furniture_0123456789abcdef"],
      ["location", "Farmhouse"],
      ["tile", "12,7"],
      ["item", "(F)1120"],
      ["native_stored", "true"],
      ["removed_from_furniture", "true"],
      ["carried", "true"],
      ["inventory_before", "0"],
      ["inventory_after", "1"],
      ["carried_tile", "12,7"],
      ["carried_rotation", "0"],
      ["carried_flipped", "false"],
      ["furniture_in_location", "3"],
    ],
  },
  rotate_furniture: {
    reasonCode: "furniture_rotated",
    // A two-rotation piece steps 0 -> 2 (`Furniture.rotate`, Furniture.cs:1153-1162), so the turn is visible in the
    // piece's own `currentRotation` and the footprint swaps its axes.
    fields: [
      ["target", "furniture_0123456789abcdef"],
      ["tile", "12,7"],
      ["location", "Farmhouse"],
      ["item", "(F)1120"],
      ["rotation_before", "0"],
      ["rotation_after", "2"],
      ["rotation_expected", "2"],
      ["rotations", "2"],
      ["flipped_before", "false"],
      ["flipped_after", "false"],
      ["footprint_before", "12,7:1x2"],
      ["footprint_after", "12,7:2x1"],
      ["placeable", "true"],
      ["turned", "true"],
      ["standing", "true"],
      ["furniture_in_location", "3"],
    ],
  },
  remove_fence: {
    reasonCode: "fence_removed",
    // A plain wood fence taken down by an axe in ONE swing that produced no drops: the zero-drop case is why the
    // producer spells `drops=none` instead of writing an empty value the Host must refuse.
    fields: [
      ["target", "object_0123456789abcdef"],
      ["location", "Farm"],
      ["tile", "12,7"],
      ["item", "(O)322"],
      ["is_gate", "false"],
      ["tool", "axe"],
      ["slot", "1"],
      ["swings", "1"],
      ["held_object_before", "false"],
      ["health_before", "1"],
      ["max_health", "1"],
      ["removed", "true"],
      ["tile_object_after", "none"],
      ["drops", "none"],
      ["drop_count", "0"],
      ["stamina_before", "100"],
      ["stamina_after", "98"],
    ],
  },
  put_item_in_fish_tank: {
    reasonCode: "fish_tank_item_deposited",
    fields: [
      ["target", "furniture_0123456789abcdef"],
      ["tile", "12,7"],
      ["location", "Farmhouse"],
      ["item", "(O)145"],
      ["slot", "6"],
      ["native_answered", "true"],
      ["held_items_before", "0"],
      ["held_items_after", "1"],
      ["last_held", "(O)145"],
      ["carried_before", "3"],
      ["carried_after", "2"],
      ["mutex_locked_after", "false"],
    ],
  },
  place_item_on_pedestal: {
    reasonCode: "pedestal_item_placed",
    // The pedestal's own `match`/`locked` are reported, not required: this drop happened to satisfy the shrine.
    fields: [
      ["target", "object_0123456789abcdef"],
      ["tile", "12,7"],
      ["location", "Farm"],
      ["item", "(O)74"],
      ["slot", "6"],
      ["native_answered", "true"],
      ["held", "(O)74"],
      ["match", "true"],
      ["locked", "true"],
      ["lock_on_success", "true"],
      ["carried_before", "3"],
      ["carried_after", "2"],
    ],
  },
  fish_here: {
    reasonCode: "fish_caught",
    // The one live-reachable action of the seven. The credit is `Farmer.fishCaught` under the QUALIFIED id, read
    // before the engine's win path and after its settle.
    fields: [
      ["location", "Farm"],
      ["target", "water_0123456789abcdef"],
      ["tile", "41,12"],
      ["caught_qualified_item_id", "(O)136"],
      ["display_name", "Largemouth Bass"],
      ["fish_size", "12"],
      ["quality", "1"],
      ["pull_outcome", "not_verified"],
      ["pull_unobserved_field", "BobberBar.distanceFromCatching"],
      ["bite_observed", "true"],
      ["cast_to_credit_ms", "4200"],
      ["rod_durability_left", "-1"],
      ["bait_before", "5"],
      ["bait_left", "4"],
      ["bait_consumed", "1"],
      ["stamina_before", "100"],
      ["stamina_after", "98"],
      ["stamina_delta", "-2"],
      ["inventory_before", "0"],
      ["inventory_after", "1"],
      ["fish_caught_before", "3"],
      ["fish_caught_after", "4"],
      ["fish_caught_delta", "1"],
      ["credit", "fishCaught:3->4"],
    ],
  },
  open_geode: {
    reasonCode: "geode_opened",
    // The treasure does not exist at click time: it is minted by the menu's own `update` and delivered when its
    // timer expires, so the two readings are the pack's count of it before the delivery and after.
    fields: [
      ["slot", "6"],
      ["inventory_slots", "36"],
      ["location", "Blacksmith"],
      ["item", "(O)82"],
      ["geode_stack", "1"],
      ["geode_owned_before", "4"],
      ["geode_owned_after", "3"],
      ["geode_consumed", "1"],
      ["money_before", "1000"],
      ["money_after", "975"],
      ["fee", "25"],
      ["fee_taken", "25"],
      ["pumped_ms", "2704"],
      ["crack_settled", "true"],
      ["treasure", "(O)66"],
      ["treasure_stack", "1"],
      ["treasure_before", "0"],
      ["treasure_after", "1"],
      ["delivered", "1"],
      ["menu_closed", "true"],
    ],
  },
};

// ---- the invariants the file exists for ------------------------------------------------------

test("every registered action has a row: nothing may fall through the fold", () => {
  // The defect this closes: 44 registered actions fell to the old switch's `default: return false`, so a REAL success
  // receipt was recorded as zero typed transitions and no test noticed. A fixture per action is not enough to prove
  // coverage - 43 fixtures existed while the switch covered 79 - so this compares the TABLE's own key set to the
  // registered set exactly.
  //
  // The population is the table the Host executes, imported rather than parsed: `STARDEW_COMPLETION_CONTRACTS` is the
  // artifact that answers, so a row that exists only in a source comment, or a switch arm the emitter dropped, cannot
  // be scored here. The authoring-time half of the same rule is the table's
  // `satisfies Record<ExecutionRequest["action"], CompletionContract>`, which makes a missing ACTION a compile error.
  const rows = new Set<string>(Object.keys(STARDEW_COMPLETION_CONTRACTS));
  const registered = new Set<string>(STARDEW_ACTION_ADAPTERS.map((entry) => entry.actionId));
  const uncovered = [...registered].filter((id) => !rows.has(id) && !actionsWithoutCompletionRule.includes(id));
  const unknown = [...rows].filter((id) => !registered.has(id));
  assert.deepEqual(uncovered, [], "these actions would fall through the fold and lose their completion evidence");
  assert.deepEqual(unknown, [], "the table names actions that are not registered");
  assert.deepEqual(actionsWithoutCompletionRule, [], "an exclusion has to be argued into this list, not inherited");
  // A fold over an EMPTY table agrees with itself, so the population is printed and refused when empty.
  console.log(`completion contracts: ${String(rows.size)} rows over ${String(registered.size)} registered actions`);
  assert.ok(rows.size > 0, "an empty table refuses every success and measures nothing");
});

test("every fixture's action is registered, and the table has not shrunk", () => {
  const registered = new Set<string>(STARDEW_ACTION_ADAPTERS.map((entry) => entry.actionId));
  for (const actionId of Object.keys(completionFixtures))
    assert.ok(registered.has(actionId), `${actionId} has a fixture but is not registered`);
  // The SOURCE assertion above is what proves every registered action has a rule; this one keeps the fixture table
  // from quietly losing entries.
  assert.ok(Object.keys(completionFixtures).length >= 40, "the fixture table shrank unexpectedly");
});

/**
 * GATE, not a test: every real producer shape is read by its own rule, and a refusal names the member it refused.
 *
 * FAMILY. The contract used to be a key COUNT (`Object.keys(evidence).length === expected.length`), so a producer that
 * published one more true field made its own success unreadable - and the count could not say WHICH field broke it. It
 * shipped twice on the same action: `dismiss_modal` appends `text=` whenever the box has text, and the shipping
 * commit's `close_effect=engine_shipping_commit` was not among the values the rule accepted. Both are ordinary
 * dismissals, so both were recorded as zero typed transitions.
 *
 * POPULATION: every (action, reasonCode) pair this file carries a real producer shape for - the per-action table above,
 * plus the two dismissal shapes that table does not hold (a close the engine's own continuation followed, and the
 * shipping commit). It is printed, and an empty population blocks rather than passes. What it does NOT read is stated
 * rather than implied: the coverage test above requires an ARM for every registered action, not a shape for every arm,
 * so an action with a rule and no fixture is not examined here.
 *
 * PROPERTY: emitted ⊆ required ∪ optional. An undeclared key is found BEHAVIOURALLY - the rule accepts the same shape
 * the moment that one key is removed, so the key whose removal flips the verdict is the undeclared one, and it is
 * named. A shape refused for a reason that is not a key (a value the rule rejects, a width its validator refuses)
 * cannot be blamed on a key by this probe, so it is named as its own finding instead of guessed at - which is the half
 * `close_effect=engine_shipping_commit` failed before the accepted values were widened.
 *
 * red-proof: history  `e6184b16`'s rule restored (count equality, `engine_shipping_commit` not among the accepted
 * values, no declared optional key) -> `evidence_key_not_declared:dismiss_modal:modal_dismissed:text` and
 * `evidence_shape_not_accepted:dismiss_modal:modal_dismissed:modal_type,dismissed,cleared_modal,clearing,close_effect`
 * are the two ordinary successes that shipped unreadable; the same run also names the continuation shape
 * (`...has_more_pages,next_modal_type,text`) and `evidence_key_not_declared:dismiss_modal:settlement_commit_in_progress:clearing`
 * (host/src/stardew-completion-evidence-coverage.test.ts)
 */
test("evidence_key_not_declared: every real producer shape is read by its own rule", () => {
  const shapes: readonly { actionId: string; reasonCode: string; fields: readonly (readonly [string, string])[] }[] = [
    ...Object.entries(completionFixtures).map(([actionId, fixture]) => ({
      actionId,
      reasonCode: fixture.reasonCode,
      fields: fixture.fields,
    })),
    {
      actionId: "dismiss_modal",
      reasonCode: "modal_dismissed",
      fields: [
        ["modal_type", "DialogueBox"],
        ["dismissed", "true"],
        ["cleared_modal", "DialogueBox"],
        ["close_effect", "native_dialogue_close"],
        ["has_more_pages", "true"],
        ["next_modal_type", "DialogueBox"],
        ["text", "..."],
      ],
    },
    {
      actionId: "dismiss_modal",
      reasonCode: "modal_dismissed",
      // The morning-after summary: `okClicked` starts an outro the menu survives (ShippingMenu.cs:380-428), so the
      // receipt carries `clearing` and the commit's own `close_effect`.
      fields: [
        ["modal_type", "ShippingMenu"],
        ["dismissed", "true"],
        ["cleared_modal", "ShippingMenu"],
        ["clearing", "true"],
        ["close_effect", "engine_shipping_commit"],
      ],
    },
    {
      actionId: "dismiss_modal",
      reasonCode: "settlement_commit_in_progress",
      // The latch's idempotent re-ask (farmhandexecutioncontroller.modalactions.cs:353-359): the commit is already
      // under way, so `dismissed` is FALSE and the receipt names the commit it declined to re-enter.
      fields: [
        ["modal_type", "ShippingMenu"],
        ["dismissed", "false"],
        ["cleared_modal", "ShippingMenu"],
        ["clearing", "true"],
        ["close_effect", "engine_shipping_commit"],
        ["commit_already_driven", "true"],
      ],
    },
    {
      actionId: "dismiss_modal",
      reasonCode: "nothing_to_dismiss",
      // Nothing was up to close: the request's own end state, stated as a settlement with the engine field that makes
      // the absence one (`farmhandexecutioncontroller.modalactions.cs`).
      fields: [
        ["modal", "none"],
        ["settled_by", "engine_flag:activeClickableMenu=none"],
      ],
    },
  ];

  const findings: string[] = [];
  for (const shape of shapes) {
    if (completionEvidence(shape.actionId, shape.reasonCode, detail(shape.fields))) continue;
    const offending = shape.fields
      .filter(
        ([key]) =>
          completionEvidence(
            shape.actionId,
            shape.reasonCode,
            detail(shape.fields.filter(([fieldKey]) => fieldKey !== key)),
          ) === true,
      )
      .map(([key]) => key);
    if (offending.length === 0) {
      findings.push(
        `evidence_shape_not_accepted:${shape.actionId}:${shape.reasonCode}:${shape.fields.map(([key]) => key).join(",")}`,
      );
      continue;
    }
    for (const key of offending)
      findings.push(`evidence_key_not_declared:${shape.actionId}:${shape.reasonCode}:${key}`);
  }

  const pairs = new Set(shapes.map((shape) => `${shape.actionId}:${shape.reasonCode}`));
  console.log(`examined ${shapes.length} producer shapes over ${pairs.size} (action, reasonCode) pairs`);
  assert.ok(shapes.length > 0, "an empty population agrees with itself");
  // THE ARMS THIS TABLE WAS EXTENDED FOR STAY IN IT. `plant_seed` and `sweep_scythe` were unreadable for a whole run
  // BECAUSE no shape for them was ever here - the probe agreed with itself while three real successes were refused - so
  // a later edit that drops one of these would take its action back out of the population silently.
  assert.deepEqual(
    ["plant_seed:seed_planted", "sweep_scythe:scythe_sweep_cut", "respond_level_up:level_up_resolved"].filter(
      (name) => !pairs.has(name),
    ),
    [],
    "an arm this table exists for is gone, so the probe no longer examines the receipt it was written for",
  );
  assert.deepEqual(
    findings,
    [],
    "a real success shape the Host refuses: the rule is narrower than the Mod - an undeclared key or an accepted value it was never given",
  );
});

/**
 * The two actions whose success detail is composed OUTSIDE a `ToolActionEvidence` list, each with the reader that pulls
 * its field names out of the Mod's own source: an interpolated literal for `plant_seed`, a declared array for
 * `sweep_scythe`.
 */
const PRODUCER_EVIDENCE_SOURCES: readonly Readonly<{
  actionId: string;
  file: string;
  read: (source: string) => string[];
}>[] = Object.freeze([
  {
    actionId: "plant_seed",
    file: "integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs",
    read: (source) => {
      const body = source.slice(source.indexOf("private LocalExecutionReceipt ExecutePlantSeed("));
      const marker = body.indexOf("inventory_after=");
      assert.ok(marker > 0, "blocked: ExecutePlantSeed no longer prints an inventory count, so nothing was compared");
      // The detail is ONE interpolated literal and its holes may hold quotes (`{plantedCropId ?? "none"}`), so the
      // boundary is a `"` at brace depth zero rather than the next quote character.
      const open = body.lastIndexOf('$"', marker);
      assert.ok(open >= 0, "blocked: the success evidence is no longer an interpolated literal");
      let depth = 0;
      let end = -1;
      for (let index = open + 2; index < body.length; index += 1) {
        const character = body[index];
        if (character === "{") depth += 1;
        else if (character === "}") depth -= 1;
        else if (character === '"' && depth === 0) {
          end = index;
          break;
        }
      }
      assert.ok(end > open, "blocked: the success evidence literal is unterminated");
      return [...body.slice(open + 2, end).matchAll(/(?:^|;)([a-z][a-z0-9_]*)=/gu)].map((match) => match[1] as string);
    },
  },
  {
    actionId: "sweep_scythe",
    file: "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs",
    read: (source) => {
      const at = source.indexOf("internal static readonly IReadOnlyList<string> SweepScythe = Array.AsReadOnly(new[]");
      assert.ok(at >= 0, "blocked: ToolActionEvidence.SweepScythe is no longer where this reads it");
      const close = source.indexOf("});", at);
      assert.ok(close > at, "blocked: ToolActionEvidence.SweepScythe has no closing brace");
      return [...source.slice(at, close).matchAll(/"([a-z][a-z0-9_]*)"/gu)].map((match) => match[1] as string);
    },
  },
]);

test("a_fixture_carries_the_producers_own_fields: the two inline-composed success details still match their fixtures", (t) => {
  // A FIXTURE IS ONLY A PRODUCER SHAPE WHILE IT CARRIES THE PRODUCER'S FIELDS, and a hand-written list cannot notice a
  // handler that grew one back. That is exactly how `round80` lost its planting and its sweep: two `seed_planted`
  // receipts carrying `slot`/`named_slot` and one `scythe_sweep_cut` carrying `after_occupant=none` were refused whole,
  // and this table had no shape for either action, so nothing compared a real success to its rule. So the field NAMES
  // are read from the Mod's source and compared to the fixture that claims the rule accepts them; the sweep's key set
  // is pinned on both sides by `DeclaredToolSelectionTests` as well, and what this adds is the FIXTURE's own honesty.
  for (const source of PRODUCER_EVIDENCE_SOURCES) {
    const fixture = completionFixtures[source.actionId];
    assert.ok(fixture !== undefined, `blocked: ${source.actionId} has no fixture, so nothing was compared`);
    const printed = source.read(readFileSync(join(ROOT, source.file), "utf8"));
    assert.ok(
      printed.length > 0,
      `blocked: ${source.actionId}'s producer detail printed no field, so nothing was judged`,
    );
    t.diagnostic(
      `${source.actionId}: producer fields ${String(printed.length)}, fixture fields ${String(fixture.fields.length)}`,
    );
    assert.deepEqual(
      [...printed].sort(),
      fixture.fields.map(([key]) => key).sort(),
      `${source.actionId}: the fields the Mod prints and the fields this table declares for it are one set - a field on ` +
        "one side and not the other refuses the producer's own success",
    );
  }
});

test("dismiss_modal: the latch's re-ask is a commit already under way, not a dismissal", () => {
  // `e6184b16` answers a SECOND dismiss of a shipping commit that is already under way from the latch rather than by
  // re-entering `okClicked` (a second entry re-arms the outro fade), and receipt-backed recovery is what turns a
  // dismiss whose response timed out into exactly that second request. So this terminal is reachable, it is a success
  // for the request it answers, and the `false` in `dismissed` is REQUIRED: a caller that reads that field as the
  // answer has to see it, or it reports a dismissal nobody performed.
  const reask: readonly (readonly [string, string])[] = [
    ["modal_type", "ShippingMenu"],
    ["dismissed", "false"],
    ["cleared_modal", "ShippingMenu"],
    ["clearing", "true"],
    ["close_effect", "engine_shipping_commit"],
    ["commit_already_driven", "true"],
  ];
  const without = (key: string) => detail(reask.filter(([fieldKey]) => fieldKey !== key));
  const withDismissed = (value: string) =>
    detail(reask.map(([key, fieldValue]) => [key, key === "dismissed" ? value : fieldValue] as const));

  assert.equal(completionEvidence("dismiss_modal", "settlement_commit_in_progress", detail(reask)), true);
  assert.equal(
    completionEvidence("dismiss_modal", "settlement_commit_in_progress", withDismissed("true")),
    false,
    "a re-ask that claims the dismissal happened is the one thing this terminal cannot say",
  );
  assert.equal(
    completionEvidence("dismiss_modal", "settlement_commit_in_progress", without("commit_already_driven")),
    false,
    "without the marker the receipt claims a commit it does not name as already driven",
  );
  const dismissal = completionFixtures.dismiss_modal;
  assert.ok(dismissal !== undefined, "the dismiss_modal fixture must exist");
  assert.equal(
    completionEvidence("dismiss_modal", "settlement_commit_in_progress", detail(dismissal.fields)),
    false,
    "an ordinary dismissal is not readable as the latch's re-ask, and it has its own reason code for that",
  );
});

test("dismiss_modal: a settlement that found nothing is read only when it names its warrant", () => {
  // `round80` counted three real ones as succeeded receipts that proved nothing; `round77` published the other side of
  // the same terminal - `modal=none` on its own, which is the absence being used as its own evidence.
  const warrant: readonly (readonly [string, string])[] = [
    ["modal", "none"],
    ["settled_by", "engine_flag:activeClickableMenu=none"],
  ];
  assert.equal(completionEvidence("dismiss_modal", "nothing_to_dismiss", detail(warrant)), true);
  assert.equal(
    completionEvidence("dismiss_modal", "nothing_to_dismiss", "modal=none"),
    false,
    "an absence with no warrant is not the request's end state, it is an absence",
  );
  assert.equal(
    completionEvidence(
      "dismiss_modal",
      "nothing_to_dismiss",
      detail([
        ["modal", "none"],
        ["settled_by", "engine_flag:activeClickableMenu=DialogueBox"],
      ]),
    ),
    false,
    "a warrant whose value says a modal IS up contradicts the terminal it was minted under",
  );
});

/**
 * THE FOUR SETTLEMENTS `round81` ANSWERED, with the code, the shape and the warrant each one prints.
 *
 * The first three are the run's own receipts, quoted from `timeline.jsonl` at the index beside each; `chop_tree`'s two
 * shapes are the two sites `farmhandexecutioncontroller.resourcetoolactions.cs:65-92` mints, which no run has reached
 * yet. The settle code is the Mod's SECOND way to say the action is done - the world already says so - and the warrant is
 * the whole content of that claim: `engine_flag:` is the engine's own finished state, `consumes:` is the catalogue's
 * declaration that this action's success takes the addressed row out of the world.
 */
const SETTLED_TARGETS: readonly (readonly [string, string, string, string])[] = [
  ["till_soil", "soil_already_tilled", "target=69,20;before=HoeDirt", "engine_flag:hoedirt=present"],
  ["cut_weeds", "weed_target_gone", "target=weed_54f7c4ad3be682f4;named_tile=76,31;tile=none", "consumes:weedTargets"],
  [
    "break_rock",
    "rock_source_gone",
    "target=rock_source_9a2b9a1dfa8a045b;named_tile=76,28;tile=none",
    "consumes:rockSourceTargets",
  ],
  ["chop_tree", "tree_chop_source_gone", "target=tree_chopped0;named_tile=70,26;tile=none", "consumes:treeChopSourceTargets"],
];

test("a settled target is the request's outcome only when the receipt names the warrant that makes it one", () => {
  // `round81` answered 37 of these - 31 tilled tiles, 2 weeds and 4 rocks - and every one was a succeeded receipt the
  // Host refused. The other direction matters as much: an absence with no warrant is an absence, and a warrant the seam
  // never mints is not this request's outcome.
  for (const [actionId, reasonCode, shape, warrant] of SETTLED_TARGETS) {
    assert.equal(
      completionEvidence(actionId, reasonCode, `${shape};settled_by=${warrant}`),
      true,
      `the settlement ${reasonCode} is the state the request asked for: ${shape};settled_by=${warrant}`,
    );
    assert.equal(
      completionEvidence(actionId, reasonCode, shape),
      false,
      "an absence with no warrant is the absence being used as its own evidence, which is what round77 published",
    );
    assert.equal(
      completionEvidence(actionId, reasonCode, `${shape};settled_by=consumes:somebodyElsesTargets`),
      false,
      "a warrant that names another family says the row this request addressed is not the one its work consumes",
    );
    assert.equal(
      completionEvidence(actionId, reasonCode, `${shape};settled_by=${warrant};unknown=value`),
      false,
      "an undeclared field refuses the receipt whole, so the warrant is the only thing holding the claim up",
    );
  }

  // `chop_tree`'s OTHER site: the same identity standing there FELLED, which is the tree rule's own postcondition
  // (`stump_after === "true"`), so a stump the request named is the felling it asked for.
  assert.equal(
    completionEvidence(
      "chop_tree",
      "tree_chop_source_gone",
      "target=tree_chopped0;named_tile=70,26;tree_type=1;stump=true;settled_by=consumes:treeChopSourceTargets",
    ),
    true,
    "a stump at the named identity is the state the request asked for",
  );
  assert.equal(
    completionEvidence(
      "chop_tree",
      "tree_chop_source_gone",
      "target=tree_chopped0;named_tile=70,26;tree_type=1;stump=false;settled_by=consumes:treeChopSourceTargets",
    ),
    false,
    "a tree still standing is not felled, and no warrant makes it so",
  );

  // ONE CODE, ONE ACTION. A settled code is the outcome of the action that minted it and of no other.
  assert.equal(
    completionEvidence("break_rock", "weed_target_gone", "target=weed_54f7c4ad3be682f4;named_tile=76,31;tile=none;settled_by=consumes:weedTargets"),
    false,
    "a weed settlement is not a rock's completion",
  );
});

for (const [actionId, fixture] of Object.entries(completionFixtures)) {
  test(`${actionId}: the Mod's own success shape completes`, () => {
    assert.equal(
      completionEvidence(actionId, fixture.reasonCode, detail(fixture.fields)),
      true,
      `the real success shape must be accepted: ${JSON.stringify(fixture.fields)}`,
    );
  });

  test(`${actionId}: a wrong terminal code is refused`, () => {
    assert.equal(completionEvidence(actionId, "some_other_terminal", detail(fixture.fields)), false);
  });

  test(`${actionId}: every required field is load-bearing`, () => {
    const required = fixture.requiredFields ?? fixture.fields.map(([key]) => key);
    const stillCompletesWith = required.filter(
      (key) =>
        completionEvidence(
          actionId,
          fixture.reasonCode,
          detail(fixture.fields.filter(([fieldKey]) => fieldKey !== key)),
        ) === true,
    );
    assert.deepEqual(stillCompletesWith, [], "removing a required field must not still look like completion");
  });
}

test("till_soil: the selection half is published, and the extended key list is what admits it", () => {
  // The Mod's own shape, key for key. `tool_selected`/`slot`/`tool_before`/`slot_before` are the four facts
  // `ToolActionEvidence.SelectionFacts` states and `tool_restored` is written after the handler put the actor's own
  // selection back; before this pair moved, the handler published NONE of them because this rule pinned the exact key
  // set. Both directions are checked here: without the publication the rule refuses, and with a key the producer does
  // not write the rule refuses too, which is what makes the widened list - not a permissive rule - the thing that
  // admits the selection half.
  const tillSoil = completionFixtures.till_soil;
  assert.ok(tillSoil !== undefined, "the till_soil fixture must exist");
  const shape = tillSoil.fields;
  assert.equal(completionEvidence("till_soil", "soil_tilled", detail(shape)), true);
  // The three facts of the footprint are load-bearing in their own right: a receipt that witnessed no tiles, that
  // claims more tiles than it names, or that names a tile outside the box it scanned, is not a measurement.
  for (const broken of [
    shape.map(([key, value]) => [key, key === "tiles_changed" ? "2" : value] as const),
    shape.map(([key, value]) => [key, key === "changed" ? "99:99" : value] as const),
    shape.map(([key, value]) => [key, key === "charge_applied" ? "4" : value] as const),
  ])
    assert.equal(
      completionEvidence("till_soil", "soil_tilled", detail(broken)),
      false,
      "the changed set, its box and the applied charge are the measurement, not decoration",
    );
  assert.equal(
    completionEvidence("till_soil", "soil_tilled", detail(shape.filter(([key]) => key !== "tool_selected"))),
    false,
    "a run that never published its own selection did not prove it drove the hoe the claim declares",
  );
  assert.equal(
    completionEvidence("till_soil", "soil_tilled", detail(shape.filter(([key]) => key !== "tool_restored"))),
    false,
    "the restore is the half a run that died mid-action cannot report",
  );
  assert.equal(
    completionEvidence("till_soil", "soil_tilled", detail([...shape, ["unknown", "value"]])),
    false,
    "an undeclared key is refused, so the widened list is what admits the selection half",
  );
});

test("shop_purchase: the shapes that made it unreadable are REFUSED, and the readable one is accepted", () => {
  // The A/B that proves the producer fix was necessary and sufficient. Both refusals were real defects: with the
  // old diagnostics (`key=value;key=value` per entry) or an empty `owner=` for a tile-opened shop, the Host cannot
  // parse the detail at all - so NO rule could ever match a real purchase, however the rule was written.
  const shopPurchase = completionFixtures.shop_purchase;
  assert.ok(shopPurchase !== undefined, "the shop_purchase fixture must exist");
  const fields = shopPurchase.fields;
  // REPLACE a field rather than appending a second copy: a duplicate key is itself unreadable, which would make
  // the rule look broken for a reason that has nothing to do with the rule.
  const withField = (key: string, value: string) =>
    fields.map(([fieldKey, fieldValue]) => [fieldKey, fieldKey === key ? value : fieldValue] as const);

  assert.equal(
    completionEvidence("shop_purchase", "item_purchased", detail(withField("clicks", "1[click0:button=0|at=412,544]"))),
    true,
    "the producer's current shape is readable",
  );

  assert.equal(
    completionEvidence("shop_purchase", "item_purchased", detail(withField("clicks", "1[click0:button=0;at=412,544]"))),
    false,
    "a `;` inside a value splits the detail into fields the Host must refuse",
  );

  assert.equal(
    completionEvidence("shop_purchase", "item_purchased", detail(withField("owner", ""))),
    false,
    "an empty value is refused, which is why a tile-opened shop now writes `owner=none`",
  );

  assert.equal(
    completionEvidence("shop_purchase", "item_purchased", detail(withField("owner", "none"))),
    true,
    "a tile-opened shop has no owner and spells it `none`",
  );

  assert.equal(
    completionEvidence("shop_purchase", "item_purchased", detail(withField("entry", "tile_action"))),
    true,
    "both entry kinds are real: the counter tile and an NPC owner",
  );
});

test("shop_purchase: a receipt that spent nothing and gained nothing is not a purchase", () => {
  // The Mod mints `item_purchased` only when `moneyAfter < moneyBefore && gained > 0`; the rule restates that from
  // the evidence, so a receipt with the right code but an unchanged purse cannot complete an action.
  const shopPurchase = completionFixtures.shop_purchase;
  assert.ok(shopPurchase !== undefined, "the shop_purchase fixture must exist");
  const noop = shopPurchase.fields.map(([key, value]) => {
    if (key === "money_after") return [key, "500"] as const;
    if (key === "gained") return [key, "0"] as const;
    return [key, value] as const;
  });
  assert.equal(completionEvidence("shop_purchase", "item_purchased", detail(noop)), false);
});

test("shop_purchase: a tool upgrade is its OWN terminal, and the upgrade facts decide it", () => {
  // The second half of the same action. A tool upgrade is bought through the same route and never enters the pack: the
  // engine charges, `Tool.actionWhenPurchased` records `Farmer.toolBeingUpgraded`/`daysLeftForToolUpgrade` and removes the
  // tool the upgrade consumes (`Tool.cs:875-895`), and the entry is discarded (`ShopMenu.cs:1369-1378`). `gained > 0` is
  // exactly the clause that made a finished upgrade unreadable, so this terminal must not inherit it - and must not be
  // acceptible from a shop that is not the upgrade counter.
  const upgrade: readonly (readonly [string, string])[] = [
    ["shop", "ClintUpgrade"],
    ["owner", "Clint"],
    ["entry", "npc_owner"],
    ["item", "(T)SteelHoe"],
    ["requested", "1"],
    ["purchased", "1"],
    ["unit_price", "5000"],
    ["money_before", "5000"],
    ["money_after", "0"],
    ["owned_before", "0"],
    ["owned_after", "0"],
    ["gained", "0"],
    ["stock_before", "1"],
    ["stock_after", "1"],
    ["owner_tile", "9,5"],
    ["menu_closed", "true"],
    ["clicks", "1[click0:row=0|cursor=0|held_after=none]"],
    ["drops", "0[]"],
    ["tool_upgraded", "(T)SteelHoe"],
    ["days_left", "2"],
    ["required_tool", "(T)CopperHoe"],
    ["required_before", "1"],
    ["required_after", "0"],
    ["purchase_dialogue", "closed"],
  ];
  const withField = (key: string, value: string) =>
    upgrade.map(([fieldKey, fieldValue]) => [fieldKey, fieldKey === key ? value : fieldValue] as const);

  assert.equal(
    completionEvidence("shop_purchase", "tool_upgrade_purchased", detail(upgrade)),
    true,
    "the engine's recorded upgrade is a completion, even though the pack gained nothing",
  );

  assert.equal(
    completionEvidence("shop_purchase", "tool_upgrade_purchased", detail(withField("shop", "SeedShop"))),
    false,
    "no shop but the upgrade counter's own branch can produce this terminal, so any other id is refused by name",
  );

  assert.equal(
    completionEvidence("shop_purchase", "tool_upgrade_purchased", detail(withField("tool_upgraded", "(T)GoldHoe"))),
    false,
    "a tool already at the blacksmith's is not this purchase's upgrade",
  );

  assert.equal(
    completionEvidence("shop_purchase", "tool_upgrade_purchased", detail(withField("required_after", "1"))),
    false,
    "an upgrade that did not consume the tool it upgrades is not a completed upgrade",
  );

  assert.equal(
    completionEvidence("shop_purchase", "tool_upgrade_purchased", detail(withField("days_left", "0"))),
    false,
    "a fresh upgrade is due back in two days, never zero",
  );

  assert.equal(
    completionEvidence("shop_purchase", "tool_upgrade_purchased", detail(withField("gained", "1"))),
    false,
    "the pack did not gain the entry, so a `gained` that disagrees with the counts is unreadable",
  );

  assert.equal(
    completionEvidence("shop_purchase", "item_purchased", detail(upgrade)),
    false,
    "the ordinary terminal refuses the upgrade fields: the two shapes do not blur",
  );
});

test("respond_level_up: the profession branch settles, and a contradicting receipt does not", () => {
  // The rule accepts ONE shape, so the generated cases above - which remove a key at a time - cannot tell its
  // validate clause from `() => true`: removing a required key already fails `declaredCompletionEvidence`'s required-set
  // check. This pins the clause itself, and pins the OTHER branch of the same terminal: a level-5/10 profession
  // chooser, whose choice writes `Farmer.professions` and which the receipt names with a numeric id.
  const profession: readonly (readonly [string, string])[] = [
    ["modal_type", "LevelUpMenu"],
    ["skill", "0"],
    ["level", "5"],
    ["is_profession", "true"],
    ["chosen_profession", "0"],
    ["remaining_new_levels", "0"],
    ["pair_settled", "true"],
    ["profession_settled", "true"],
    ["menu_closed", "true"],
  ];
  const withField = (key: string, value: string): readonly (readonly [string, string])[] =>
    profession.map(([fieldKey, fieldValue]) => [fieldKey, fieldKey === key ? value : fieldValue] as const);

  // Skill 0 at level 5 offers the pair 0/1 (`LevelUpMenu.cs:421-437`), so both branch ids are real ones.
  assert.equal(
    completionEvidence("respond_level_up", "level_up_resolved", detail(profession)),
    true,
    "the left branch of the level-5 pair is a resolution",
  );
  assert.equal(
    completionEvidence("respond_level_up", "level_up_resolved", detail(withField("chosen_profession", "1"))),
    true,
    "the right branch of the same pair is equally real",
  );
  assert.equal(
    completionEvidence("respond_level_up", "level_up_resolved", detail(withField("chosen_profession", "none"))),
    false,
    "a profession settlement that names no profession is not one",
  );
  assert.equal(
    completionEvidence("respond_level_up", "level_up_resolved", detail(withField("is_profession", "false"))),
    false,
    "an ordinary level cannot carry a numeric profession id",
  );
  assert.equal(
    completionEvidence("respond_level_up", "level_up_resolved", detail(withField("menu_closed", "false"))),
    false,
    "a menu that is still active has settled nothing",
  );
  assert.equal(
    completionEvidence("respond_level_up", "level_up_resolved", detail(withField("modal_type", "DialogueBox"))),
    false,
    "another modal is not this action's working precondition",
  );
  assert.equal(
    completionEvidence("respond_level_up", "level_up_resolved", detail(withField("level", "three"))),
    false,
    "the settled pair is integral",
  );
  // The two facts the success condition turns on, which only became readable when the Mod began
  // publishing them: a receipt that says the pair did NOT settle, or the profession did NOT, is not a
  // resolution whatever else it claims - and the terminal code alone cannot say so, because the Mod
  // writes `level_up_resolved` only when both hold.
  assert.equal(
    completionEvidence("respond_level_up", "level_up_resolved", detail(withField("pair_settled", "false"))),
    false,
    "a pair the engine still lists as unlevelled has settled nothing",
  );
  assert.equal(
    completionEvidence("respond_level_up", "level_up_resolved", detail(withField("profession_settled", "false"))),
    false,
    "nor has a profession the actor does not carry",
  );
});

test("scythe_crop: the dead-crop clear branch completes, and a harvest shape claiming it does not", () => {
  // The action has TWO engine branches with different terminals, and the generated cases above only exercise the
  // harvest one. `HoeDirt.performToolAction` (HoeDirt.cs:732-735) destroys a dead crop and drops nothing, because
  // `Crop.harvest` refuses a dead crop outright (Crop.cs:484-491) - so the debris-increase clause the harvest shape
  // requires would refuse the ONLY terminal that can free a season-killed tile.
  const cleared: readonly (readonly [string, string])[] = [
    ["target", "scythe_crop_0123456789abcdef"],
    ["crop", "472"],
    ["harvested_item", "none"],
    ["crop_dead", "true"],
    ["debris_before", "0"],
    ["debris_after", "0"],
    ["crop_removed", "true"],
    ["stamina_before", "100"],
    ["stamina_after", "100"],
    ["stamina_delta", "0"],
    ["expected_stamina_cost", "0"],
    ["native_scythe", "false"],
    ["tool_selected", "scythe"],
    ["slot", "3"],
    ["tool_before", "none"],
    ["slot_before", "0"],
    ["tool_restored", "none"],
  ];
  const withField = (key: string, value: string): readonly (readonly [string, string])[] =>
    cleared.map(([fieldKey, fieldValue]) => [fieldKey, fieldKey === key ? value : fieldValue] as const);

  assert.equal(
    completionEvidence("scythe_crop", "dead_crop_cleared", detail(cleared)),
    true,
    "a dead crop leaving the tile is this action's other real terminal",
  );
  // The two branches must not be able to claim each other's evidence: a clear that reports debris means the harvest
  // branch ran, and a harvest that reports a dead crop means the clear branch did.
  assert.equal(
    completionEvidence("scythe_crop", "dead_crop_cleared", detail(withField("crop_dead", "false"))),
    false,
    "a clear names the dead crop it cleared",
  );
  assert.equal(
    completionEvidence("scythe_crop", "dead_crop_cleared", detail(withField("debris_after", "1"))),
    false,
    "the dead branch produces no debris; a drop means the harvest branch is what ran",
  );
  assert.equal(
    completionEvidence("scythe_crop", "scythe_crops_harvested", detail(withField("crop_dead", "true"))),
    false,
    "a harvest of a dead crop is the impossible one: Crop.harvest refuses a dead crop",
  );
  assert.equal(
    completionEvidence("scythe_crop", "scythe_crops_harvested", detail(cleared)),
    false,
    "the harvest terminal cannot be minted from the clear branch's shape",
  );
});
