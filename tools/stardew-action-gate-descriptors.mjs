/**
 * Published-action gate metadata used only for consistency checks and
 * verification planning. It does not generate Mod execution logic, grant
 * capabilities, or stand in for a live native receipt/postcondition gate.
 */
export const STARDEW_PUBLISHED_ACTION_GATES = Object.freeze([
  gate("move_to_tile", "run-stardew-move-probe.mjs", "target_reached"),
  gate("equip_tool", "run-stardew-equip-tool-smoke.mjs", "tool_selected"),
  gate("travel", "run-stardew-travel-smoke.mjs", "travel_completed"),
  gate("enter_exit", "run-stardew-enter-exit-smoke.mjs", "enter_exit_completed"),
  gate("till_soil", "run-stardew-till-soil-fixture-smoke.mjs", "soil_tilled", "native_till_soil_v1"),
  gate("pickup_forage", "run-stardew-pickup-forage-fixture-smoke.mjs", "forage_picked_up", "native_pickup_forage_v1"),
  gate("pickup_item", "run-stardew-pickup-item-fixture-smoke.mjs", "item_picked_up", "native_pickup_item_v1"),
  gate("water_crop", "run-stardew-water-crop-smoke.mjs", "crop_watered", "native_water_crop_v1"),
  gate("plant_seed", "run-stardew-plant-seed-fixture-smoke.mjs", "seed_planted", "native_plant_seed_v1"),
  gate("fertilize_tile", "run-stardew-fertilize-tile-smoke.mjs", "fertilizer_applied", "native_fertilize_tile_v1"),
  gate("machine_inspect", "run-stardew-machine-inspect-fixture-smoke.mjs", "machine_inspected", "native_machine_inspect_v1"),
  gate("collect_animal_product", "run-stardew-collect-animal-product-smoke.mjs", "animal_product_collected", "native_animal_product_v2"),
  gate("feed_animal", "run-stardew-feed-animal-smoke.mjs", "hay_placed_in_trough", "native_feed_animal_v1"),
  gate("use_item", "run-stardew-use-item-smoke.mjs", "item_used", "native_use_item_v1"),
  gate("harvest_crop", "run-stardew-harvest-crop-fixture-smoke.mjs", "crop_harvested", "native_harvest_crop_v1"),
]);

function gate(actionId, runner, terminalReasonCode, fixtureScenario = null) {
  return Object.freeze({ actionId, runner, terminalReasonCode, fixtureScenario });
}
