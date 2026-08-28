/**
 * Published-action gate metadata used only for consistency checks and
 * verification planning. It does not generate Mod execution logic, grant
 * capabilities, or stand in for a live native receipt/postcondition gate.
 */
export const STARDEW_PUBLISHED_ACTION_GATES = Object.freeze([
  gate("move_to_tile", 1, "run-stardew-native-local-player-move-smoke.mjs", "target_reached"),
  gate("equip_tool", 1, "run-stardew-native-local-player-equip-tool-smoke.mjs", "tool_selected"),
  gate("travel", 1, "run-stardew-native-local-player-travel-smoke.mjs", "travel_completed"),
  gate("enter_exit", 1, "run-stardew-native-local-player-enter-exit-smoke.mjs", "enter_exit_completed"),
  gate("till_soil", 1, "run-stardew-native-local-player-till-soil-smoke.mjs", "soil_tilled", "native_till_soil_v1"),
  gate(
    "pickup_forage",
    1,
    "run-stardew-native-local-player-pickup-forage-smoke.mjs",
    "forage_picked_up",
    "native_pickup_forage_v1",
  ),
  gate(
    "pickup_item",
    1,
    "run-stardew-native-local-player-pickup-item-smoke.mjs",
    "item_picked_up",
    "native_pickup_item_v1",
  ),
  gate("water_crop", 1, "run-stardew-native-local-player-water-crop-smoke.mjs", "crop_watered", "native_water_crop_v1"),
  gate("plant_seed", 1, "run-stardew-native-local-player-plant-seed-smoke.mjs", "seed_planted", "native_plant_seed_v1"),
  gate(
    "fertilize_tile",
    1,
    "run-stardew-native-local-player-fertilize-tile-smoke.mjs",
    "fertilizer_applied",
    "native_fertilize_tile_v1",
  ),
  gate(
    "machine_inspect",
    1,
    "run-stardew-native-local-player-machine-inspect-smoke.mjs",
    "machine_inspected",
    "native_machine_inspect_v1",
  ),
  gate(
    "machine_load",
    1,
    "run-stardew-native-local-player-machine-load-smoke.mjs",
    "machine_coffee_loaded",
    "native_machine_coffee_load_v1",
  ),
  gate(
    "machine_collect_output",
    1,
    "run-stardew-native-local-player-machine-collect-output-smoke.mjs",
    "machine_coffee_collected",
    "native_machine_coffee_load_v1",
  ),
  gate(
    "collect_animal_product",
    1,
    "run-stardew-native-local-player-collect-animal-product-smoke.mjs",
    "animal_product_collected",
    "native_collect_animal_product_v1",
  ),
  gate(
    "feed_animal",
    1,
    "run-stardew-native-local-player-feed-animal-smoke.mjs",
    "hay_placed_in_trough",
    "native_feed_animal_v1",
  ),
  gate("use_item", 1, "run-stardew-native-local-player-use-item-smoke.mjs", "item_used", "native_use_item_v1"),
  gate(
    "harvest_crop",
    1,
    "run-stardew-native-local-player-harvest-crop-smoke.mjs",
    "crop_harvested",
    "native_harvest_crop_v1",
  ),
  gate(
    "refill_watering_can",
    1,
    "run-stardew-native-local-player-refill-watering-can-smoke.mjs",
    "watering_can_refilled",
    "native_refill_watering_can_v1",
  ),
  gate(
    "break_rock_source",
    1,
    "run-stardew-native-local-player-break-rock-source-smoke.mjs",
    "rock_source_broken",
    "native_break_rock_source_v1",
  ),
  gate(
    "clear_hoedirt",
    1,
    "run-stardew-native-local-player-clear-hoedirt-smoke.mjs",
    "hoedirt_cleared",
    "native_clear_hoedirt_v1",
  ),
  gate(
    "dig_artifact_spot",
    1,
    "run-stardew-native-local-player-dig-artifact-spot-smoke.mjs",
    "artifact_spot_dug",
    "native_dig_artifact_spot_v1",
  ),
  gate(
    "chop_tree_source",
    1,
    "run-stardew-native-local-player-chop-tree-source-smoke.mjs",
    "tree_source_chopped",
    "native_chop_tree_source_v1",
  ),
  gate(
    "place_wood_fence",
    1,
    "run-stardew-native-local-player-place-wood-fence-smoke.mjs",
    "wood_fence_placed",
    "native_place_wood_fence_v1",
  ),
  gate(
    "place_crab_pot",
    1,
    "run-stardew-native-local-player-place-crab-pot-smoke.mjs",
    "crab_pot_placed",
    "native_place_crab_pot_v1",
  ),
  gate(
    "bait_crab_pot",
    1,
    "run-stardew-native-local-player-bait-crab-pot-smoke.mjs",
    "crab_pot_baited",
    "native_bait_crab_pot_v1",
  ),
]);

function gate(actionId, identityVersion, runner, terminalReasonCode, fixtureScenario = null) {
  return Object.freeze({ actionId, identityVersion, runner, terminalReasonCode, fixtureScenario });
}
