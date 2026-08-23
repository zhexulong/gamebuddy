import type { ActionRegistration } from "./protocol.js";

/**
 * Test-only authenticated Mod catalog. This explicit fixture deliberately does
 * not derive from Host adapters: the Mod owns action membership and metadata.
 */
export const TEST_MOD_REGISTRATIONS: readonly ActionRegistration[] =
  Object.freeze(
    [
      ["move_to_tile", "movement_navigation"],
      ["equip_tool", "body_tools"],
      ["travel", "transport_warps"],
      ["enter_exit", "movement_navigation"],
      ["till_soil", "farming_crops"],
      ["pickup_forage", "resource_gathering"],
      ["pickup_item", "inventory_items"],
      ["water_crop", "farming_crops"],
      ["refill_watering_can", "farming_crops"],
      ["plant_seed", "farming_crops"],
      ["fertilize_tile", "farming_crops"],
      ["place_wood_fence", "buildings_farm_management"],
      ["place_crab_pot", "buildings_farm_management"],
      ["bait_crab_pot", "buildings_farm_management"],
      ["machine_inspect", "machines_processing"],
      ["machine_load", "machines_processing"],
      ["machine_collect_output", "machines_processing"],
      ["collect_animal_product", "animals_pets"],
      ["feed_animal", "animals_pets"],
      ["use_item", "inventory_items"],
      ["harvest_crop", "farming_crops"],
      ["break_rock_source", "resource_gathering"],
      ["clear_hoedirt", "farming_crops"],
      ["dig_artifact_spot", "resource_gathering"],
      ["chop_tree_source", "resource_gathering"],
    ].map(([actionId, familyId]) =>
      Object.freeze({
        actionId,
        familyId,
        identityVersion: 1,
        lifecycle: "published" as const,
      }),
    ),
  );
