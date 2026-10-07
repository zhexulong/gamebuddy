/**
 * Published-action gate metadata used only for consistency checks and
 * verification planning. It does not generate Mod execution logic, grant
 * capabilities, or stand in for a live native receipt/postcondition gate.
 *
 * Coverage is "every action with native live evidence", which since
 * design/10 section 3.1.1 means both `published` and `live_verified`. The table
 * is NOT lifecycle authority: an action's lifecycle lives in the Mod catalog
 * (FarmhandActionDefinition), and promotion to `published` requires an
 * independent review the live run alone cannot supply.
 */
export const STARDEW_PUBLISHED_ACTION_GATES = Object.freeze([
  gate("move_to_tile", 1, "run-stardew-native-local-player-move-smoke.mjs", "target_reached"),
  gate("equip_tool", 1, "run-stardew-native-local-player-equip-tool-smoke.mjs", "tool_equipped"),
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
  // Pure embodied-actor mutations with no world precondition: Farmer.doEmote and
  // Farmer.faceDirection need no object, inventory slot or prior navigation, so
  // both share one runner and one fixture scenario. They are live_verified rather
  // than published (see design/10 section 3.1.1): the live run exists, the
  // independent publication review does not yet.
  gate("express_emote", 1, "run-stardew-native-local-player-expression-smoke.mjs", "emote_started", "native_express_emote_v1"),
  gate(
    "face_direction",
    1,
    "run-stardew-native-local-player-expression-smoke.mjs",
    "actor_facing_matches",
    "native_express_emote_v1",
  ),
  // Promoted to live_verified: a real target-version live run produced a native
  // receipt and action-specific postcondition, but no independent publication
  // review has happened yet (design/10 3.1.1).
  //
  // `pet_animal` earns the shared-world rung: the +12 friendship is gated on the
  // single per-pet `grantedFriendshipForPet` flag, so a second farmer's pet in the
  // same day grants 0. Verified in the real Host-LAN + AI-Farmhand topology
  // (pet_completed, friendship 0->12, day_recorded, friendship_callback).
  gate("pet_animal", 1, "run-stardew-native-local-player-pet-animal-smoke.mjs", "pet_completed", "native_pet_animal_v1"),
  // Two native branches, so the descriptor names the one the live run proved:
  // the quest-delivery branch is checked first and short-circuits the gift path.
  gate(
    "interact_npc_with_item",
    1,
    "run-stardew-native-local-player-interact-npc-with-item-smoke.mjs",
    "quest_item_delivered",
    "native_interact_npc_with_item_v1",
  ),
  // The cross-day lifecycle. Its fixture scenario is the ordinary move-only
  // world: the action owns its own route to the actor's bed and its own native
  // sleep-answer/observation, so there is no precondition to provision. It earns
  // the shared-world rung: startSleep forks on Game1.IsMultiplayer, so a
  // single-player pass cannot stand in for the co-op ready barrier.
  gate("advance_day", 1, "run-stardew-native-local-player-advance-day-smoke.mjs", "day_advanced"),
  // Promoted to live_verified (Group B). Each entry records the action's own
  // target-version live run terminal: these runners produced a native receipt
  // and an action-specific postcondition, without an independent publication
  // review yet (design/10 3.1.1).
  gate("clear_debris", 1, "run-stardew-native-local-player-clear-debris-smoke.mjs", "debris_cleared", "native_clear_debris_resource_clump_v1"),
  gate("npc_relationship", 1, "run-stardew-native-local-player-npc-relationship-smoke.mjs", "npc_relationship_inspected", "native_npc_relationship_v1"),
  gate("water_pet_bowl", 1, "run-stardew-native-local-player-water-pet-bowl-smoke.mjs", "pet_bowl_watered", "native_water_pet_bowl_v1"),
  gate(
    "water_slime_hutch_trough",
    1,
    "run-stardew-native-local-player-water-slime-hutch-trough-smoke.mjs",
    "slime_hutch_trough_watered",
    "native_water_slime_hutch_trough_v1",
  ),
  gate("chest_store", 1, "run-stardew-native-local-player-chest-store-smoke.mjs", "chest_stored", "native_chest_store_v1"),
  gate("chest_retrieve", 1, "run-stardew-native-local-player-chest-retrieve-smoke.mjs", "chest_retrieved", "native_chest_retrieve_v1"),
  gate("chop_stump", 1, "run-stardew-native-local-player-chop-stump-smoke.mjs", "stump_cleared", "native_chop_stump_v1"),
  gate("plant_sapling", 1, "run-stardew-native-local-player-plant-sapling-smoke.mjs", "sapling_planted", "native_plant_sapling_v1"),
  gate("cut_weeds", 1, "run-stardew-native-local-player-cut-weeds-smoke.mjs", "weeds_cut", "native_cut_weeds_v1"),
  gate("scythe_crop", 1, "run-stardew-native-local-player-scythe-crop-smoke.mjs", "scythe_crops_harvested", "native_scythe_crop_v1"),
  gate("craft_item", 1, "run-stardew-native-local-player-craft-item-smoke.mjs", "crafted_item_created", "native_craft_item_v1"),
  gate("cook_recipe", 1, "run-stardew-native-local-player-cook-recipe-smoke.mjs", "dish_cooked", "native_cook_recipe_v1"),
  gate(
    "collect_crab_pot_output",
    1,
    "run-stardew-native-local-player-crab-pot-collect-smoke.mjs",
    "crab_pot_output_collected",
    "native_crab_pot_collect_v1",
  ),
  gate("ship_item", 1, "run-stardew-native-local-player-ship-item-smoke.mjs", "item_shipped", "native_ship_item_v1"),
  // Promoted to live_verified: a real target-version native-local run produced
  // `succeeded/minecart_ride_completed` on the recorded fixture scenario
  // (station Farm (2,9), network Default, destination Town). The run settles
  // the 700ms freezePause window rather than sampling once; publication review
  // is still owed (design/10 3.1.1).
  gate("ride_minecart", 1, "run-stardew-native-local-player-ride-minecart-smoke.mjs", "minecart_ride_completed", "native_ride_minecart_v1"),
  // The bus is a typed transport action over the game's own ticket interaction,
  // not a fixture-authored warp: the runner proves the native terminal
  // (bus_arrived), the fare actually deducted, and the world moving the actor to
  // the desert. Live evidence: fixtures/stardew/RUNBOOK.md §35.
  gate("ride_bus", 1, "run-stardew-native-local-player-ride-bus-smoke.mjs", "bus_arrived", "native_ride_bus_v1"),
  // Promoted 2026-10-06 after their native-local live gates passed on a rebuilt fixture environment.
  gate("withdraw_silo_hay", 1, "run-stardew-native-local-player-withdraw-silo-hay-smoke.mjs", "silo_hay_taken", "native_withdraw_silo_hay_v1"),
  gate("use_obelisk", 1, "run-stardew-native-local-player-use-obelisk-smoke.mjs", "obelisk_arrived", "native_use_obelisk_v1"),

  // Buying is the transaction only; the action refuses if the owner is out of reach so a
  // walk failure can never be reported as a trade failure. The runner also proves the two
  // world facts a receipt cannot: the purse really paid, and the goods really arrived.
  // Live evidence: fixtures/stardew/RUNBOOK.md 37.
  gate("shop_purchase", 1, "run-stardew-native-local-player-shop-purchase-smoke.mjs", "item_purchased", "native_shop_purchase_v1"),

  // The elevator's floor selection only exists inside MineElevatorMenu's click
  // handler, so it is its own action rather than an `enter_mine` argument (Lane L3
  // card 3.7: a level-taking enter_mine would bypass lowestLevelReached). The
  // runner proves the terminal, the world arriving on the requested LEVEL, and the
  // floor-set projection following. Live evidence: fixtures/stardew/RUNBOOK.md 36.
  gate("select_mine_elevator_floor", 1, "run-stardew-native-local-player-mine-elevator-smoke.mjs", "mine_elevator_floor_selected", "native_mine_elevator_v1"),
  // Promoted to live_verified (2026-10-04): each of these produced a real
  // target-version native-local run with its own receipt and fresh postcondition
  // in the loop-closure wave. Publication review is a separate, optional marker
  // (architecture/game-action-model.md 'lifecycle 与发布终点'), so live_verified is
  // the release endpoint and these are now part of the published set.
  gate("cut_grass", 1, "run-stardew-native-local-player-cut-grass-smoke.mjs", "grass_cut", "native_cut_grass_v1"),
  gate("harvest_bush", 1, "run-stardew-native-local-player-harvest-bush-smoke.mjs", "bush_harvested", "native_harvest_bush_v1"),
  gate("harvest_fruit_tree", 1, "run-stardew-native-local-player-harvest-fruit-tree-smoke.mjs", "fruit_tree_harvested", "native_harvest_fruit_tree_v1"),
  gate("shake_tree", 1, "run-stardew-native-local-player-shake-tree-smoke.mjs", "tree_shaken", "native_shake_tree_v1"),
  gate("take_pedestal_item", 1, "run-stardew-native-local-player-take-pedestal-item-smoke.mjs", "pedestal_item_taken", "native_take_pedestal_item_v1"),
  gate("toggle_fence_gate", 1, "run-stardew-native-local-player-toggle-fence-gate-smoke.mjs", "fence_gate_toggled", "native_toggle_fence_gate_v1"),
  gate("clear_cask", 1, "run-stardew-native-local-player-clear-cask-smoke.mjs", "cask_cleared", "native_clear_cask_v1"),
  gate("dress_mannequin", 1, "run-stardew-native-local-player-dress-mannequin-smoke.mjs", "mannequin_dressed", "native_dress_mannequin_v1"),
  gate("set_sign_display", 1, "run-stardew-native-local-player-set-sign-display-smoke.mjs", "sign_display_set", "native_set_sign_display_v1"),
  gate("deposit_silo_hay", 1, "run-stardew-native-local-player-deposit-silo-hay-smoke.mjs", "silo_hay_deposited", "native_deposit_silo_hay_v1"),
  gate("toggle_tool_light", 1, "run-stardew-native-local-player-toggle-tool-light-smoke.mjs", "tool_light_toggled", "native_toggle_tool_light_v1"),
  gate("use_raft", 1, "run-stardew-native-local-player-use-raft-smoke.mjs", "raft_launched", "native_use_raft_v1"),
  gate("mount_transport", 1, "run-stardew-native-local-player-mount-transport-smoke.mjs", "horse_mounted", "native_mount_transport_v1"),
  gate("enter_mine", 1, "run-stardew-native-local-player-enter-mine-smoke.mjs", "mine_entered", "native_enter_mine_v1"),
  // WIA §4.2: the two modal-handling primitives. Promoted to live_verified on owner ruling
  // (2026-10-06) after both crossed the live gate: a real native-local run each, with its own
  // receipt (RUNBOOK 32 dismiss-chain, 33 answer-question). They stay Experimental in name
  // nowhere — the reason the promotion matters is that WIA's whole design is interrupt ->
  // breakpoint -> self-healing continuation, and an Agent that cannot answer or dismiss a
  // modal is DEADLOCKED by any NPC conversation that interrupts its work. Each runner drives a
  // three-phase chain (interrupt, handle, resume), and the terminal below is the ACTION's
  // receipt, which is what the harness joins to the dispatch; the chain's own completion code
  // is the runner's verdict, not the action's terminal.
  gate("dismiss_modal", 1, "run-stardew-native-local-player-wia-modal-dismiss-chain-smoke.mjs", "modal_dismissed", "native_wia_modal_dismiss_chain_v1"),
  gate("answer_dialogue", 1, "run-stardew-native-local-player-wia-answer-question-smoke.mjs", "answer_dialogue_answered", "native_wia_answer_question_v1"),
]);

/**
 * Experimental-action native-local runner map. These actions are registered in
 * the Mod catalog as `FarmhandActionLifecycle.Experimental` and are therefore
 * deliberately absent from `STARDEW_PUBLISHED_ACTION_GATES`, which by contract
 * is exactly the published action set. This map exists only so the disposable
 * native-local launcher can resolve an experimental action's shared-harness
 * runner; it grants no capability, changes no lifecycle, and is not a
 * publication or success claim. Only experimental actions that actually have a
 * native-local smoke runner appear here.
 */
export const STARDEW_EXPERIMENTAL_ACTION_RUNNERS = Object.freeze({
  // The loop-closure pilot: cut grass tufts (TerrainFeature Grass) through the
  // native scythe seam. Registered as Experimental in the Mod catalog until its
  // live gate passes; the runner is the scythe-family contract shape.
  // Promoted actions (clear_debris, npc_relationship, water_pet_bowl,
  // water_slime_hutch_trough, chest_store, chest_retrieve, chop_stump,
  // plant_sapling, cut_weeds, scythe_crop, craft_item, cook_recipe,
  // collect_crab_pot_output, ship_item) are live_verified and now appear in
  // STARDEW_PUBLISHED_ACTION_GATES with their runner and terminal.
  // Same container store/take capability over the built-in kitchen fridge. The
  // fridge IS a Chest and advertises through the same chest targets, so the
  // runner is identical; only the fixture scenario (kitchen instead of a placed
  // chest) and the resulting evidence identity differ.
  fridge_store: "run-stardew-native-local-player-chest-store-smoke.mjs",
  fridge_retrieve: "run-stardew-native-local-player-chest-retrieve-smoke.mjs",
  // Same ship_item capability over IslandWest's island bin. The runner is
  // identical because the action advertises through the same shippingBinTargets
  // channel; only the fixture scenario (island house upgraded) differs.
  ship_item_island: "run-stardew-native-local-player-ship-item-smoke.mjs",
  // Lane G recovery-chain harness: drives breakpoint rejected -> equip recovery
  // -> retry succeeded within one native-local session over the till_soil
  // fixture. Not a new action; it grants no capability.
  tool_recovery_chain: "run-stardew-native-local-player-tool-recovery-chain-smoke.mjs",
  // Lane G resource-depletion recovery-chain harness: drives breakpoint
  // rejected/watering_can_empty -> refill_watering_can recovery -> water_crop
  // retry succeeded on the same target within one native-local session over the
  // empty-can fixture. Not a new action; it grants no capability.
  water_crop_resource_recovery_chain:
    "run-stardew-native-local-player-water-crop-resource-recovery-chain-smoke.mjs",
  // Lane G container-full recovery-chain harness: drives breakpoint
  // rejected/inventory_full -> chest_store recovery -> harvest_crop retry
  // succeeded on the same target within one native-local session over the
  // full-backpack fixture. Not a new action; it grants no capability.
  harvest_inventory_full_recovery_chain:
    "run-stardew-native-local-player-harvest-inventory-full-recovery-chain-smoke.mjs",
  // Lane G low-stamina recovery-chain harness: the fixture sets stamina low and the
  // chain reads the drop from the first till receipt, eats, then tills again. Low
  // stamina is a fact, not a reasonCode, so this chain is fact-triggered. Not a new
  // action; it grants no capability.
  stamina_recovery_chain: "run-stardew-native-local-player-stamina-recovery-chain-smoke.mjs",
  // Lane G partial-completion recovery-chain harness: the fixture fills the
  // backpack with 998 Bait beside two Bug Meat, so the native Bait recipe (one Bug
  // Meat -> five Bait, max stack 999) can only retain one and must drop four. The
  // chain reads the honest `partially_succeeded/crafted_item_created` receipt,
  // stores the retained stack so the native debris homing can deliver the dropped
  // remainder, then re-crafts the SAME recipe to a full success. Not a new action;
  // it grants no capability.
  craft_partial_recovery_chain: "run-stardew-native-local-player-craft-partial-recovery-chain-smoke.mjs",
  // Tool-family approach harness (design 5.2). `chop_tree_source` is a published
  // action whose gate runner proves the in-range chop; this harness proves the
  // OTHER half of the same contract -- that a request from outside the native
  // interaction radius is admitted with an approach leg, announces
  // `tool_approach_completed`, and still reaches the same terminal. The action and
  // the fixture scenario are both unchanged; the runner drives the published
  // action from farther away. Not a new action; it grants no capability.
  chop_tree_approach: "run-stardew-native-local-player-chop-tree-approach-smoke.mjs",
  // Move-stall probe: drives the SAME published move_to_tile action over a fixture
  // that stands a native blocker (Pet or parked Horse) on the route, measuring
  // whether the native pushing/pass-through mechanisms resolve the block before
  // the 5000ms path-cancel (design 5.3 observation). Not a new action; it grants
  // no capability. Two harness labels select the blocker kind.
  move_stall_probe_pet: "run-stardew-native-local-player-move-stall-probe-smoke.mjs",
  move_stall_probe_npc: "run-stardew-native-local-player-move-stall-probe-smoke.mjs",
  // WIA world-interruption live proofs (world-interruption-arbitration.md
  // §4.1 ② / §4.3): drive the SAME published move_to_tile action over fixtures
  // that stage a world-change mid-move, measuring that the running body loop
  // classifies it as invalidated/pass_out (body facts) or
  // invalidated/modal_interrupted (intent breakpoint) instead of an opaque
  // action fault. Not a new action; they grant no capability.
  wia_pass_out: "run-stardew-native-local-player-wia-passout-smoke.mjs",
  wia_modal_interrupt: "run-stardew-native-local-player-wia-modal-interrupt-smoke.mjs",
  // WIA §4.2 full modal-handling chain: interrupt -> dismiss (Modal admission
  // half-loop) -> same-intent resume, the 全链路闭环 evidence.
  wia_modal_dismiss_chain: "run-stardew-native-local-player-wia-modal-dismiss-chain-smoke.mjs",
  // WIA §4.2 answer_dialogue live proof: move interrupted by a native question
  // modal, answered with the native answerDialogue seam.
  wia_answer_question: "run-stardew-native-local-player-wia-answer-question-smoke.mjs",
  wia_eat_interrupt: "run-stardew-native-local-player-wia-eat-interrupt-smoke.mjs",
  // The other three WIA slots: each holds a body-holding execution whose
  // interruption is measured while that slot is live (the tool-approach leg,
  // the asynchronous animal-product animation, and the magnetic pickup window).
  wia_tool_approach_interrupt: "run-stardew-native-local-player-wia-tool-approach-smoke.mjs",
  wia_animal_product_interrupt: "run-stardew-native-local-player-wia-animal-product-smoke.mjs",
  wia_item_pickup_interrupt: "run-stardew-native-local-player-wia-item-pickup-smoke.mjs",
  // ride_bus was listed here as well until it was promoted; the entry is removed because a key
  // present in BOTH this map and STARDEW_PUBLISHED_ACTION_GATES makes
  // resolve-stardew-action-gate-runner.test.mjs fail ('ride_bus must not enter the published
  // gate list') while check-stardew-action-promotion.mjs stays green. Promotion is therefore
  // three edits, not one: the gate list, this map, and the descriptor test's two frozen lists.
  // The fixture already puts the actor beside the shop owner inside trading hours, so
  // the runner's contract is the purchase itself.
  // Loop-closure wave (2026-10-04): the 14 lane actions are Experimental until
  // each earns its live gate; every runner is the dedicated smoke runner in tools/.
});

function gate(actionId, identityVersion, runner, terminalReasonCode, fixtureScenario = null) {
  return Object.freeze({ actionId, identityVersion, runner, terminalReasonCode, fixtureScenario });
}
