using GameBuddy.Stardew.Navigation;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

/// <summary>
/// The pre-attachment scenario fixtures: one row per scenario, and the world each row's initializer declares.
///
/// These were one `if` chain of 2,900 lines in `ModEntry.Fixtures.cs` - 971 of cognitive complexity, so which branch
/// ran for a scenario was whatever a reader could reconstruct by walking down to it. The chain's last branch carried no
/// guard at all (it was the `else`), which made an unhandled scenario build THAT world: arming
/// `native_farmhand_chat_v1` created dry unwatered crops on the Farm and logged a water-crop initialisation. The table
/// has no default - a scenario without a row is refused by name - and every row says which stage of the fixture
/// sequence its Given runs in, because the produced world depends on it.
///
/// THE POPULATION IS THE CONFIG'S. `NativeLocalPlayerFixtureConfig.NativeLocalFixtureScenarios` is the closed set this
/// build understands; `NativeLocalFixtureScenarioPopulationTests` holds it against this table's keys, so a scenario
/// added there without a row here fails that test instead of quietly building a neighbour's world.
///
/// The fixture still captures `Game1`/`netWorldState` statics through `HeadlessGameWorld.CaptureStatics`/`RestoreStatics`
/// before it touches the world: a row here may write `Game1.currentLocation` for the duration of one native command
/// (as `SpreadDirt`/`RemoveDirt` require) and always restores it, and no row replaces the world.
/// </summary>
public sealed partial class ModEntry
{

    /// <summary>
    /// Where in the fixture's fixed sequence a scenario's Given runs. The three stages are not a preference: they are
    /// the order the branch chain evaluated them in, and each one decides what the scenario can see and in which world
    /// it lands.
    /// </summary>
    private enum NativeLocalFixtureStage
    {
        /// <summary>
        /// Before the actor/world guard and outside the setup try: the Given is the world as it loaded, so an ineligible
        /// world (no sole native master local Player, no Farm) must not turn the scenario into a refusal.
        /// </summary>
        Worldless,

        /// <summary>
        /// Inside the setup try, after the guard bound the actor, against the actor EXACTLY as the save loaded it: the
        /// fixture has not opened the backpack to every slot the actor can have. These scenarios were written against
        /// the starter backpack and are the ones whose Given is the actor itself or a world it was born into.
        /// </summary>
        ActorAsLoaded,

        /// <summary>
        /// Inside the setup try, after the fixture opened the actor's backpack to every slot it can have - the standard
        /// actor every other scenario places its items into.
        /// </summary>
        ActorPrepared,
    }

    /// <summary>
    /// One scenario's declaration: the name the fixture config carries and the world that name builds.
    ///
    /// There are two initializer shapes because the sequence has two kinds of stage and a row in the earlier one never
    /// sees a bound actor. Exactly one of the two is set, and the three factories are the only way to build a row, so
    /// the fold below can assert that pairing once instead of every dispatch re-deciding it.
    /// </summary>

    /// <summary>
    /// Every scenario this fixture can build, one row each. Order is the order the branch chain evaluated them in; the
    /// stages partition it, and within a stage no two rows can match the same scenario.
    /// </summary>
    private static readonly NativeLocalFixtureScenarioRow[] NativeLocalFixtureScenarioDeclarations =
    {
        NativeLocalFixtureScenarioRow.Worldless("", null),
        NativeLocalFixtureScenarioRow.Worldless("navigation_read_only_v1", null),
        NativeLocalFixtureScenarioRow.Worldless("native_express_emote_v1", static (mod, _) => mod.InitializeNativeLocalExpressEmoteFixture()),
        NativeLocalFixtureScenarioRow.Worldless("navigation_mutation_v1", static (mod, fixture) => mod.InitializeNativeLocalNavigationMutationFixture(fixture)),
        NativeLocalFixtureScenarioRow.ActorAsLoaded("native_multi_day_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalMultiDayFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorAsLoaded("native_level_up_branch_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalMultiDayFixture(player, farm, armProfessionMilestone: true)),
        NativeLocalFixtureScenarioRow.ActorAsLoaded("native_npc_relationship_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalNpcRelationshipFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorAsLoaded("native_interact_npc_with_item_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalInteractNpcWithItemFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorAsLoaded("native_pet_animal_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalPetFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorAsLoaded("native_move_stall_probe_pet_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalMoveStallProbeFixture(player, farm, useHorseBlock: false)),
        NativeLocalFixtureScenarioRow.ActorAsLoaded("native_move_stall_probe_npc_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalMoveStallProbeFixture(player, farm, useHorseBlock: true)),
        NativeLocalFixtureScenarioRow.ActorAsLoaded("native_move_ladder_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalMoveLadderFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorAsLoaded("native_pass_out_v1", static (mod, player, _, _) => mod.InitializeNativeLocalPassOutFixture(player)),
        NativeLocalFixtureScenarioRow.ActorAsLoaded("native_wia_pass_out_v1", static (mod, player, farm, _) =>
        {
            mod.InstallWiaInterruptionFixture(player, farm, WiaInterruptionFixtureKind.PassOut);
            mod.nativeLocalPlayerFixtureInitialized = true;
        }),
        NativeLocalFixtureScenarioRow.ActorAsLoaded("native_wia_eat_interrupt_v1", static (mod, player, farm, _) =>
        {
            mod.InstallWiaEatInterruptionFixture(player);
            mod.nativeLocalPlayerFixtureInitialized = true;
        }),
        NativeLocalFixtureScenarioRow.ActorAsLoaded("native_wia_answer_question_v1", static (mod, player, farm, _) =>
        {
            mod.InstallWiaAnswerQuestionFixture(player, farm);
            mod.nativeLocalPlayerFixtureInitialized = true;
        }),
        NativeLocalFixtureScenarioRow.ActorAsLoaded("native_wia_tool_approach_interrupt_v1", static (mod, player, farm, _) =>
        {
            mod.InstallWiaToolApproachInterruptionFixture(player, farm);
            mod.nativeLocalPlayerFixtureInitialized = true;
        }),
        NativeLocalFixtureScenarioRow.ActorAsLoaded("native_wia_animal_product_interrupt_v1", static (mod, player, farm, _) =>
        {
            mod.InstallWiaAnimalProductInterruptionFixture(player, farm);
            mod.nativeLocalPlayerFixtureInitialized = true;
        }),
        NativeLocalFixtureScenarioRow.ActorAsLoaded("native_wia_item_pickup_interrupt_v1", static (mod, player, farm, _) =>
        {
            mod.InstallWiaItemPickupInterruptionFixture(player, farm);
            mod.nativeLocalPlayerFixtureInitialized = true;
        }),
        NativeLocalFixtureScenarioRow.ActorAsLoaded("native_wia_modal_interrupt_v1", static (mod, player, farm, _) =>
        {
            mod.InstallWiaInterruptionFixture(player, farm, WiaInterruptionFixtureKind.ModalInterrupt);
            mod.nativeLocalPlayerFixtureInitialized = true;
        }),
        NativeLocalFixtureScenarioRow.ActorAsLoaded("native_wia_modal_dismiss_chain_v1", static (mod, player, farm, _) =>
        {
            mod.InstallWiaInterruptionFixture(player, farm, WiaInterruptionFixtureKind.ModalInterrupt);
            mod.nativeLocalPlayerFixtureInitialized = true;
        }),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_machine_navigate_ab_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalMachineNavigateAbFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_till_soil_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalTillSoilFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_stamina_recovery_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalStaminaRecoveryFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_place_wood_fence_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalPlaceWoodFenceFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_bait_crab_pot_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalBaitCrabPotFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_place_crab_pot_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalPlaceCrabPotFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_plant_seed_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalPlantSeedFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_crop_research_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalCropResearchFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_fertilize_tile_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalFertilizeTileFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_harvest_crop_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalHarvestCropFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_harvest_crop_inventory_full_recovery_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalHarvestCropInventoryFullRecoveryFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_jodi_harvest_deliver_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalJodiHarvestDeliverFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_strawberry_covenant_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalStrawberryCovenantFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_multi_day_play_session_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalMultiDayPlaySessionFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_play_session_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalPlaySessionFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_pickup_forage_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalPickupForageFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_pickup_item_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalPickupItemFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_machine_inspect_v1", static (mod, player, _, fixture) => mod.InitializeNativeLocalMachinePreconditionFixture(player, fixture)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_machine_coffee_load_v1", static (mod, player, _, fixture) => mod.InitializeNativeLocalMachinePreconditionFixture(player, fixture)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_machine_coffee_collect_v1", static (mod, player, _, fixture) => mod.InitializeNativeLocalMachinePreconditionFixture(player, fixture)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_dig_artifact_spot_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalDigArtifactSpotFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_clear_hoedirt_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalClearHoeDirtFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_break_rock_source_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalBreakRockSourceFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_clear_debris_resource_clump_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalClearDebrisResourceClumpFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_chop_tree_source_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalChopTreeSourceFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_use_item_v1", static (mod, player, _, _) => mod.InitializeNativeLocalUseItemFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_chest_store_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalChestStoreFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_chest_retrieve_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalChestRetrieveFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_fridge_store_v1", static (mod, player, _, fixture) => mod.InitializeNativeLocalFridgePreconditionFixture(player, fixture)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_fridge_retrieve_v1", static (mod, player, _, fixture) => mod.InitializeNativeLocalFridgePreconditionFixture(player, fixture)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_water_pet_bowl_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalWaterPetBowlFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_water_slime_hutch_trough_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalWaterSlimeHutchTroughFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_ship_item_island_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalShipItemIslandFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_chop_stump_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalChopStumpFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_plant_sapling_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalPlantSaplingFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_harvest_bush_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalHarvestBushFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_harvest_fruit_tree_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalHarvestFruitTreeFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_shake_tree_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalShakeTreeFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_take_pedestal_item_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalTakePedestalItemFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_toggle_fence_gate_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalToggleFenceGateFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_clear_cask_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalClearCaskFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_dress_mannequin_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalDressMannequinFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_set_sign_display_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalSetSignDisplayFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_talk_to_npc_v1", static (mod, player, farm, _) => mod.InstallNativeLocalTalkToNpcFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_talk_to_npc_multi_page_v1", static (mod, player, farm, _) => mod.InstallNativeLocalTalkToNpcFixture(player, requireMultiPage: true)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_mine_use_ladder_exit_v1", static (mod, player, farm, _) => mod.InstallNativeLocalUseMineLadderFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_mine_enter_ladder_v1", static (mod, player, farm, _) => mod.InstallNativeLocalEnterMineLadderFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_enter_exit_warp_action_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalEnterExitWarpActionFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_clear_fish_pond_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalClearFishPondFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_accept_daily_quest_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalAcceptDailyQuestFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_color_placed_object_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalColorPlacedObjectFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_rotate_furniture_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalRotateFurnitureFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_remove_fence_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalRemoveFenceFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_accept_special_order_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalAcceptSpecialOrderFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_claim_museum_reward_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalClaimMuseumRewardFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_name_entity_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalNameEntityFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_prize_ticket_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalRedeemPrizeTicketFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_toggle_animal_door_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalToggleAnimalDoorFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_tailoring_v1", static (mod, player, farm, _) => mod.InstallNativeLocalTailoringFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_world_object_v1", static (mod, player, farm, _) => mod.InstallNativeLocalWorldObjectFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_build_farm_building_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalBuildFarmBuildingFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_use_warp_item_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalUseWarpItemFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_pan_ore_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalPanOreFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_fish_here_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalFishHereFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_claim_mail_attachment_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalClaimMailAttachmentFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_building_chest_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalBuildingChestFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_building_chest_multistack_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalBuildingChestMultiStackFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_withdraw_silo_hay_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalWithdrawSiloHayFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_use_obelisk_v1", static (mod, player, farm, _) => mod.InstallNativeLocalUseObeliskFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_deposit_silo_hay_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalDepositSiloHayFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_toggle_tool_light_v1", static (mod, player, _, _) => mod.InitializeNativeLocalToggleToolLightFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_cut_grass_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalCutGrassFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_cut_weeds_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalCutWeedsFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_scythe_crop_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalScytheCropFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_feed_animal_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalFeedAnimalFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_collect_animal_product_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalCollectAnimalProductFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_pet_farm_animal_v1", static (mod, player, farm, _) => mod.InstallNativeLocalPetFarmAnimalFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_refill_watering_can_v1", static (mod, player, _, _) => mod.InitializeNativeLocalRefillWateringCanFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_ship_item_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalShipItemFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_craft_item_v1", static (mod, player, _, _) => mod.InitializeNativeLocalCraftItemFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_craft_item_partial_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalCraftItemPartialFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_cook_recipe_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalCookRecipeFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_use_raft_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalUseRaftFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_mount_transport_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalMountTransportFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_enter_mine_v1", static (mod, player, _, _) => mod.InitializeNativeLocalEnterMineFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_mine_elevator_v1", static (mod, player, farm, _) => mod.InstallNativeLocalMineElevatorFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_shop_purchase_v1", static (mod, player, farm, _) => mod.InstallNativeLocalShopPurchaseFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_open_geode_v1", static (mod, player, farm, _) => mod.InstallNativeLocalOpenGeodeFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_ride_bus_v1", static (mod, player, farm, _) => mod.InstallNativeLocalRideBusFixture(player)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_ride_minecart_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalRideMinecartFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_crab_pot_collect_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalCrabPotCollectFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_water_crop_empty_can_recovery_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalWaterCropEmptyCanRecoveryFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_equip_wearable_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalEquipWearableFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_unequip_wearable_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalUnequipWearableFixture(player, farm, inventoryFull: false)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_unequip_wearable_inventory_full_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalUnequipWearableFixture(player, farm, inventoryFull: true)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_dismount_transport_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalDismountTransportFixture(player, farm)),
        NativeLocalFixtureScenarioRow.ActorPrepared("native_water_crop_v1", static (mod, player, farm, _) => mod.InitializeNativeLocalWaterCropFixture(player, farm)),
    };

    /// <summary>
    /// The declarations folded into the lookup the dispatch performs under, so that dispatch is one lookup rather than
    /// one comparison per scenario.
    /// </summary>
    private static readonly Dictionary<string, NativeLocalFixtureScenarioRow> NativeLocalFixtureScenarioRows =
        FoldNativeLocalFixtureScenarioDeclarations(NativeLocalFixtureScenarioDeclarations);

    /// <summary>
    /// The declared scenario names, for the population test that holds them against the config's own list
    /// (`NativeLocalPlayerFixtureConfig.NativeLocalFixtureScenarios`).
    /// </summary>
    internal static IReadOnlyCollection<string> NativeLocalFixtureScenarioNames => NativeLocalFixtureScenarioRows.Keys;

    private sealed record NativeLocalFixtureScenarioRow(
        string Scenario,
        NativeLocalFixtureStage Stage,
        Action<ModEntry, NativeLocalPlayerFixtureConfig>? WorldlessInitialize,
        Action<ModEntry, Farmer, Farm, NativeLocalPlayerFixtureConfig>? ActorInitialize)
    {
        /// <summary>
        /// A scenario whose Given is the world as it loaded. <paramref name="initialize"/> is null for the two scenarios
        /// whose Given is nothing at all - the move-only profile (`""`) and `navigation_read_only_v1` - which the
        /// dispatch completes without touching the world.
        /// </summary>
        public static NativeLocalFixtureScenarioRow Worldless(
            string scenario,
            Action<ModEntry, NativeLocalPlayerFixtureConfig>? initialize) =>
            new(scenario, NativeLocalFixtureStage.Worldless, initialize, ActorInitialize: null);

        /// <summary>A scenario whose Given lives on the actor or the world, run against the actor as the save loaded it.</summary>
        public static NativeLocalFixtureScenarioRow ActorAsLoaded(
            string scenario,
            Action<ModEntry, Farmer, Farm, NativeLocalPlayerFixtureConfig> initialize) =>
            new(scenario, NativeLocalFixtureStage.ActorAsLoaded, WorldlessInitialize: null, initialize);

        /// <summary>A scenario whose Given lives on the actor or the world, run after the fixture prepared the actor.</summary>
        public static NativeLocalFixtureScenarioRow ActorPrepared(
            string scenario,
            Action<ModEntry, Farmer, Farm, NativeLocalPlayerFixtureConfig> initialize) =>
            new(scenario, NativeLocalFixtureStage.ActorPrepared, WorldlessInitialize: null, initialize);
    }

    /// <summary>
    /// Folds the declared rows into the lookup, refusing the two ways a table like this goes wrong: a scenario declared
    /// twice (which world it builds would depend on insertion order) and a row whose stage and initializer shape
    /// disagree (the dispatch reads the shape the stage names, and would silently skip the other one).
    /// </summary>
    private static Dictionary<string, NativeLocalFixtureScenarioRow> FoldNativeLocalFixtureScenarioDeclarations(
        NativeLocalFixtureScenarioRow[] declarations)
    {
        var byScenario = new Dictionary<string, NativeLocalFixtureScenarioRow>(declarations.Length, StringComparer.Ordinal);
        foreach (NativeLocalFixtureScenarioRow row in declarations)
        {
            bool worldless = row.Stage == NativeLocalFixtureStage.Worldless;
            if (worldless == (row.ActorInitialize is not null))
                throw new InvalidOperationException($"fixture_scenario_row_disagrees_with_its_stage:{row.Scenario}");
            if (!byScenario.TryAdd(row.Scenario, row))
                throw new InvalidOperationException($"fixture_scenario_declared_twice:{row.Scenario}");
        }
        return byScenario;
    }

    /// <summary>
    /// Whether a pre-attachment transition is live. A fixture warp completes through the native lifecycle and its
    /// `OnWarped` handler finalizes the spatial precondition, so no scenario setup may rerun while one is pending.
    /// </summary>
    private bool HasPendingNativeLocalFixtureTransition() =>
        this.nativeLocalFeedFixturePending is not null
        || this.nativeLocalCollectAnimalProductFixturePending is not null
        || this.nativeLocalClearHoeDirtFixturePending is not null
        || this.nativeLocalDigArtifactSpotFixturePending is not null
        || this.nativeLocalPlaceCrabPotFixturePending is not null
        || this.nativeLocalBaitCrabPotFixturePending is not null
        || this.nativeLocalMoveStallProbePending is not null
        || this.nativeLocalUseObeliskFixturePending is not null;

    /// <summary>
    /// Refuses the scenario by name, and says which of the two facts is true: the scenario belongs to the
    /// host-automation dispatcher, which owns its Given, or no native-local initializer exists for it at all. The
    /// refusal is terminal because a fixture that cannot build its Given must not attach as if it had.
    /// </summary>
    private void RejectNativeLocalPlayerFixtureScenario(NativeLocalPlayerFixtureConfig fixture)
    {
        this.nativeLocalPlayerFixtureTerminal = true;
        string reason = fixture.IsHostAutomationOwnedScenario
            ? "the host-automation dispatcher owns this scenario's Given (ResolveHostAutomationFixtureRegistration), and the native-local fixture has no initializer for it"
            : "the native-local fixture has no initializer for it";
        this.Monitor.Log($"GameBuddy native-local-player fixture rejected an unsupported or unavailable pre-attachment scenario: {reason}.", LogLevel.Error);
    }

    private void InitializeNativeLocalExpressEmoteFixture()
    {
        // express_emote and face_direction are pure embodied-actor mutations:
        // Farmer.doEmote and Farmer.faceDirection need no world object, no
        // inventory slot and no prior action, so this scenario creates no
        // fixture fact at all. The named scenario exists so the run records
        // which fixture intent produced the evidence; production alone
        // performs the native mutation and emits the receipt.
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log("GameBuddy native-local-player initialized expression fixture before bridge attachment: no world fact required; production alone performs native emote/facing and emits receipts.", LogLevel.Info);
    }

    private void InitializeNativeLocalNavigationMutationFixture(NativeLocalPlayerFixtureConfig fixture)
    {
        // Select one reachable target from the same production destination,
        // topology, and route-planning authorities used by execution. This
        // writes only transaction-owned fixture configuration; it creates no
        // player/world fact and grants no product capability.
        string? deriveReason = null;
        DerivedDestinationSet? destinations = null;
        if (fixture.NavigationMutationTargetLabel.Length != 0)
        {
            this.nativeLocalPlayerFixtureTerminal = true;
            this.Monitor.Log("GameBuddy Navigation mutation fixture target already set.", LogLevel.Error);
            return;
        }
        if (!DerivedDestinationSet.TryCreateCurrent("stardew", out destinations, out deriveReason)
            || Game1.player?.currentLocation?.NameOrUniqueName is not string currentSource)
        {
            this.nativeLocalPlayerFixtureTerminal = true;
            this.Monitor.Log($"GameBuddy Navigation mutation fixture could not derive a fresh target (derive_reason={deriveReason ?? "unknown"};current={Game1.player?.currentLocation?.NameOrUniqueName ?? "none"};searchable={destinations?.SearchDestinations.Count ?? 0})", LogLevel.Error);
            return;
        }

        var source = new Game1NavigationWorldSource();
        var planner = new NavigationRoutePlanner();
        NavigationDestination? selected = destinations!.SearchDestinations.FirstOrDefault(destination =>
        {
            if (destination.CanonicalIdentity == currentSource
                || destination.CanonicalLabel.Length is < 1 or > 128)
                return false;
            int labelMatches = destinations.SearchDestinations.Count(candidate =>
                candidate.CanonicalLabel == destination.CanonicalLabel
                || (candidate.ExplicitAliases is not null && candidate.ExplicitAliases.Contains(destination.CanonicalLabel, StringComparer.Ordinal)));
            if (labelMatches != 1)
                return false;
            var binding = new NavigationDestinationBinding("stardew", destination.CanonicalIdentity, destinations.Generation, 0);
            if (!source.TryCreateCurrentOrdinaryWarpTopology(binding, out NavigationOrdinaryWarpTopology? topology, out string topologyReason))
                return false;
            return planner.Plan(topology!, currentSource, binding).Kind == NavigationRoutePlanKind.NextEdge;
        });
        if (selected is null)
        {
            this.nativeLocalPlayerFixtureTerminal = true;
            this.Monitor.Log("GameBuddy Navigation mutation fixture found no reachable non-current target.", LogLevel.Error);
            return;
        }

        fixture.NavigationMutationTargetLabel = selected.CanonicalLabel;
        this.Helper.WriteConfig(this.config);
        this.nativeLocalPlayerFixtureInitialized = true;
    }

    private void InitializeNativeLocalPassOutFixture(Farmer player)
    {
        // Establish ONLY a legal live precondition and let the native
        // gate fire by itself: Game1.cs:6452 reads
        // `timeOfDay >= 2600 || player.stamina <= -15f`. Nothing here
        // starts the pass-out, calls a trigger, or touches the actor
        // again - the lifecycle under test must yield to whatever the
        // native pipeline does next. The player already stands inside
        // the FarmHouse, so no placement is needed.
        player.stamina = -20;
        this.nativeLocalPlayerFixtureInitialized = true;
    }

    private void InitializeNativeLocalMultiDayPlaySessionFixture(Farmer player, Farm farm)
    {
        // Lane G0. Two declared Givens in one world, and nothing else:
        //   (a) the multi-day precondition - pinned clock/season, the actor standing in its own
        //       home with a real bed, exactly one shippable object in the bin (so the FIRST
        //       rollover raises ShippingMenu and no later one does), and no pending level-up;
        //   (b) the play-session affordances - tools, seeds, weeds/grass/stone and a few mature
        //       crops around an open crossroads, so each new day still has work worth doing.
        // Without (b) a multi-day run could only show that days pass; without (a) the rollover
        // itself is not the Given. The fixture performs no sleep and dispatches no action:
        // production alone ends the night and alone harvests, cuts and plants.
        InitializeNativeLocalMultiDayFixture(player, farm);
        // The play session must begin somewhere it can WALK HOME from, so the door is passed in as the tile the
        // start has to reach. Choosing a start in a different piece of the Farm is what stranded run g4; the
        // assertion below then re-checks the composed world, so neither the choice nor the check is assumed.
        Point doorStandingSpot = NativeLocalMultiDayDoorStandingSpot(player, farm);
        InitializeNativeLocalPlaySessionFixture(
        player,
        farm,
        new Vector2(doorStandingSpot.X, doorStandingSpot.Y),
        // The composed world IS a day: it begins in bed and ends in bed. A field start is what the plain
        // play-session lane does, and what this branch used to inherit by accident.
        startAtHome: true);
        // (c) The composed world must let the companion GO HOME.
        //
        // Lane G0's whole point is that the companion ends its own day, and `advance_day` only begins a
        // night from inside a farmhouse. The multi-day Given puts the actor there at arm time, but the
        // play-session fixture then moves it to the Farm crossroads and places props - so the composed
        // world is only usable if the farmhouse is still reachable from where the session starts. Each
        // given is fine alone; measured 2026-10-17, the composition was not: the actor's cardinal component
        // was 28 tiles with the door outside it, so eleven `move_to_tile` attempts came back
        // `no_native_path` and `enter_exit` said `door_out_of_range`, and the night could never begin.
        //
        // Refused HERE, by name and with numbers, instead of burning a turn on a world that cannot be
        // finished. It asserts the DIRECTION? no - it asserts reachability only: how the companion gets home
        // is still its own decision.
        AssertNativeLocalMultiDayHomeReachable(player, farm);
    }

    private void InitializeNativeLocalPickupForageFixture(Farmer player, Farm farm)
    {
        // Resolve the Farm target from this actual local Player's live
        // FarmHouse warp without relying on another actor or building.
        if (player.currentLocation is not StardewValley.Locations.FarmHouse farmHouse)
            throw new InvalidOperationException("fixture_native_local_pickup_forage_farmhouse_missing");
        StardewValley.Warp? farmWarp = farmHouse.warps.FirstOrDefault(warp => !warp.npcOnly.Value
            && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
        if (farmWarp is null || farmWarp.TargetX < 0 || farmWarp.TargetY < 0)
            throw new InvalidOperationException("fixture_native_local_pickup_forage_farm_warp_missing");
        Vector2 farmArrival = new(farmWarp.TargetX, farmWarp.TargetY);
        // Arrival geometry is target-version map data, not a fixture
        // contract. Search a bounded radius for a legal setup location,
        // while leaving final placement authority to native dropObject.
        const int placementRadius = 8;
        Vector2[] candidateTiles = Enumerable.Range(-placementRadius, placementRadius * 2 + 1)
            .SelectMany(offsetX => Enumerable.Range(-placementRadius, placementRadius * 2 + 1)
                .Select(offsetY => new Vector2(farmArrival.X + offsetX, farmArrival.Y + offsetY)))
            .Where(tile => tile != farmArrival
                && farm.isTileOnMap(tile)
                && !farm.objects.ContainsKey(tile))
            .Where(tile => new[]
            {
                tile + new Vector2(1f, 0f),
                tile + new Vector2(-1f, 0f),
                tile + new Vector2(0f, 1f),
                tile + new Vector2(0f, -1f),
            }.Any(approach => farm.isTileOnMap(approach)
                && farm.isTilePassable(approach)
                && !farm.IsTileOccupiedBy(approach, CollisionMask.All, CollisionMask.None, useFarmerTile: true)))
            .OrderBy(tile => Math.Max(Math.Abs(tile.X - farmArrival.X), Math.Abs(tile.Y - farmArrival.Y)))
            .ThenBy(tile => Math.Abs(tile.X - farmArrival.X) + Math.Abs(tile.Y - farmArrival.Y))
            .ToArray();
        string[] forageIds = new[] { "(O)399", "(O)396", "(O)398", "(O)16", "(O)18", "(O)20", "(O)22" };
        Vector2 placedTile = Vector2.Zero;
        StardewValley.Object? placedForage = null;
        foreach (Vector2 tile in candidateTiles)
        {
            foreach (string forageId in forageIds)
            {
                StardewValley.Object forage = ItemRegistry.Create<StardewValley.Object>(forageId, 1);
                if (!forage.isForage())
                    continue;
                if (!player.couldInventoryAcceptThisItem(forage))
                    throw new InvalidOperationException("fixture_native_local_pickup_forage_inventory_unavailable");
                if (!farm.dropObject(forage, tile * 64f, Game1.viewport, initialPlacement: true))
                    continue;
                if (farm.objects.TryGetValue(tile, out StardewValley.Object? actual)
                    && ReferenceEquals(actual, forage)
                    && actual.QualifiedItemId == forageId
                    && actual.isForage()
                    && actual.IsSpawnedObject)
                {
                    placedTile = tile;
                    placedForage = actual;
                    break;
                }
                throw new InvalidOperationException("fixture_native_local_pickup_forage_placement_validation_failed");
            }
            if (placedForage is not null)
                break;
        }
        if (placedForage is null)
            throw new InvalidOperationException("fixture_native_local_pickup_forage_placement_missing");
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized pickup-forage precondition before bridge attachment: forage={placedForage.QualifiedItemId}; tile={(int)placedTile.X},{(int)placedTile.Y}; spawned={placedForage.IsSpawnedObject}.", LogLevel.Info);
    }

    private void InitializeNativeLocalPickupItemFixture(Farmer player, Farm farm)
    {
        // Derive this local-only drop from the current Player's actual
        // FarmHouse→Farm warp. createItemDebris owns native chunk setup;
        // no collection, removal, or inventory outcome is performed here.
        if (player.currentLocation is not StardewValley.Locations.FarmHouse itemFarmHouse)
            throw new InvalidOperationException("fixture_native_local_pickup_item_farmhouse_missing");
        StardewValley.Warp? itemFarmWarp = itemFarmHouse.warps.FirstOrDefault(warp => !warp.npcOnly.Value
            && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
        if (itemFarmWarp is null || itemFarmWarp.TargetX < 0 || itemFarmWarp.TargetY < 0)
            throw new InvalidOperationException("fixture_native_local_pickup_item_farm_warp_missing");
        Vector2 itemArrival = new(itemFarmWarp.TargetX, itemFarmWarp.TargetY);
        // Discovery is bounded to six tiles by the production bridge;
        // place within that native-local discovery radius, while the
        // production pickup still drives its own native approach.
        Vector2? itemTile = FindNativeLocalFarmFixtureTile(farm, itemArrival, 6, requireEmptyObjectTile: true);
        if (itemTile is null)
            throw new InvalidOperationException("fixture_native_local_pickup_item_placement_missing");
        const string itemId = "(O)388";
        StardewValley.Object item = ItemRegistry.Create<StardewValley.Object>(itemId, 1);
        if (!player.couldInventoryAcceptThisItem(item))
            throw new InvalidOperationException("fixture_native_local_pickup_item_inventory_unavailable");
        int debrisBefore = farm.debris.Count;
        StardewValley.Debris debris = Game1.createItemDebris(item, itemTile.Value * 64f + new Vector2(32f, 32f), 2, farm, (int)(itemTile.Value.Y * 64f + 32f));
        if (farm.debris.Count != debrisBefore + 1 || !farm.debris.Contains(debris)
            || debris.debrisType.Value != StardewValley.Debris.DebrisType.OBJECT || debris.Chunks.Count == 0
            || debris.item is null || debris.item.QualifiedItemId != itemId || debris.item.Stack != 1)
            throw new InvalidOperationException("fixture_native_local_pickup_item_debris_setup_missing");
        // No dropped-by identity/grace override is used in this topology:
        // it would encode an actor assumption rather than a setup fact.
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized pickup-item precondition before bridge attachment: item={itemId}; tile={(int)itemTile.Value.X},{(int)itemTile.Value.Y}; debris_type={debris.debrisType.Value}; chunks={debris.Chunks.Count}.", LogLevel.Info);
    }

    private void InitializeNativeLocalUseItemFixture(Farmer player)
    {
        if (player.MaxItems < 36)
            player.increaseBackpackSize(36 - player.MaxItems);
        const string foodId = "(O)216";
        StardewValley.Object? food = player.Items.OfType<StardewValley.Object>().FirstOrDefault(candidate => candidate.QualifiedItemId == foodId && candidate.Stack > 0);
        if (food is null)
        {
            StardewValley.Object suppliedFood = ItemRegistry.Create<StardewValley.Object>(foodId, 1);
            if (player.addItemToInventory(suppliedFood) is not null)
                throw new InvalidOperationException("fixture_native_local_use_item_inventory_full");
            food = player.Items.OfType<StardewValley.Object>().FirstOrDefault(candidate => candidate.QualifiedItemId == foodId && candidate.Stack > 0);
        }
        if (food is null || food.Edibility < 0 || (Game1.objectData.TryGetValue(food.ItemId, out var foodData) && foodData.IsDrink))
            throw new InvalidOperationException("fixture_native_local_use_item_food_missing");
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized use-item precondition before bridge attachment: food={food.QualifiedItemId}; stack={food.Stack}; edibility={food.Edibility}; inventory_slots={player.MaxItems}.", LogLevel.Info);
    }

    private void InitializeNativeLocalWaterPetBowlFixture(Farmer player, Farm farm)
    {
        // Pre-attachment fixture only: the naturally-loaded Farm already owns
        // its built-in Pet Bowl building on the template save (PetBowl is a
        // Building, not an Object, so it never appears in location.objects).
        // Establish only the declared Given: one charged Watering Can in the
        // backpack and the local player standing on a lawful adjacent tile, so
        // the fresh production snapshot can discover the bowl. Equipping and
        // walking stay independently receipted production actions; the fixture
        // must not perform a step a receipt is supposed to prove. Production
        // alone calls the native watering path and emits the receipt; the
        // fixture never waters the bowl, never writes PetBowl.watered, and
        // emits no receipt.
        foreach (Item? ownedItem in player.Items.Where(item => item is WateringCan).ToArray())
            player.Items.Remove(ownedItem);
        WateringCan suppliedCan = new();
        suppliedCan.WaterLeft = Math.Max(1, suppliedCan.waterCanMax - 1);
        if (player.addItemToInventory(suppliedCan) is not null)
            throw new InvalidOperationException("fixture_native_water_pet_bowl_can_missing");
        if (!player.Items.OfType<WateringCan>().Any())
            throw new InvalidOperationException("fixture_native_water_pet_bowl_can_missing");
        StardewValley.Buildings.PetBowl? bowl = farm.buildings.OfType<StardewValley.Buildings.PetBowl>()
            .FirstOrDefault(candidate => candidate.daysOfConstructionLeft.Value <= 0);
        if (bowl is null)
            throw new InvalidOperationException("fixture_native_water_pet_bowl_bowl_missing");
        if (bowl.watered.Value)
            throw new InvalidOperationException("fixture_native_water_pet_bowl_already_watered");
        // The template's shipped Pet Bowl stands where none of its waterable
        // tile's neighbours is walkable (three are the bowl's own footprint and
        // the rest are impassable), so no player could ever stand adjacent and
        // water it. The declared Given ("actor stands on a lawful adjacent
        // tile") is therefore unsatisfiable for THAT placement, so relocate this
        // same bowl onto clear ground that does have a lawful standing tile
        // beside its own waterable tile. The bowl keeps its identity (id,
        // petGuid) through the move, and production still performs the watering
        // and emits the receipt.
        Vector2? placement = null;
        Vector2 bowlStanding = Vector2.Zero;
        int previousX = bowl.tileX.Value;
        int previousY = bowl.tileY.Value;
        int mapWidth = farm.map.Layers[0].LayerWidth;
        int mapHeight = farm.map.Layers[0].LayerHeight;
        for (int x = 1; x < mapWidth - bowl.tilesWide.Value - 1 && placement is null; x++)
        {
            for (int y = 1; y < mapHeight - bowl.tilesHigh.Value - 1 && placement is null; y++)
            {
                // Park the bowl off-map first: occupancy and passability must be
                // judged against the terrain, and a bowl standing on its own candidate
                // footprint would otherwise report that footprint as occupied by itself.
                bowl.tileX.Value = -1000;
                bowl.tileY.Value = -1000;
                List<Vector2> footprint = new();
                for (int footprintX = x; footprintX < x + bowl.tilesWide.Value; footprintX++)
                {
                    for (int footprintY = y; footprintY < y + bowl.tilesHigh.Value; footprintY++)
                    {
                        footprint.Add(new Vector2(footprintX, footprintY));
                    }
                }
                bool footprintClear = footprint.All(tile => farm.isTileOnMap(tile)
                    && farm.isTilePassable(tile)
                    && !farm.IsTileOccupiedBy(tile, CollisionMask.All, CollisionMask.None, useFarmerTile: false));
                if (!footprintClear) continue;
                // Now place the bowl at the candidate so its own relative tile-property
                // data maps onto the right absolute tiles.
                bowl.tileX.Value = x;
                bowl.tileY.Value = y;
                Vector2? waterable = ExecutionManager.PetBowlWaterableTiles(bowl).Cast<Vector2?>().FirstOrDefault();
                if (waterable is null) continue;
                int waterableX = (int)waterable.Value.X;
                int waterableY = (int)waterable.Value.Y;
                Vector2[] neighbours =
                {
                    new(waterableX, waterableY - 1), new(waterableX - 1, waterableY),
                    new(waterableX + 1, waterableY), new(waterableX, waterableY + 1),
                    new(waterableX - 1, waterableY - 1), new(waterableX + 1, waterableY - 1),
                    new(waterableX - 1, waterableY + 1), new(waterableX + 1, waterableY + 1),
                };
                Vector2? standing = neighbours
                    .Where(tile => !footprint.Contains(tile)
                        && farm.isTileOnMap(tile)
                        && farm.isTilePassable(tile)
                        && !farm.IsTileOccupiedBy(tile, CollisionMask.All, CollisionMask.None, useFarmerTile: false))
                    .Cast<Vector2?>()
                    .FirstOrDefault();
                if (standing is null) continue;
                placement = new Vector2(x, y);
                bowlStanding = standing.Value;
            }
        }
        if (placement is null)
        {
            // Never leave the bowl somewhere unusable after a failed fixture.
            bowl.tileX.Value = previousX;
            bowl.tileY.Value = previousY;
            throw new InvalidOperationException("fixture_native_water_pet_bowl_placement_missing");
        }
        int bowlX = bowl.tileX.Value;
        int bowlY = bowl.tileY.Value;
        Vector2 standingTile = bowlStanding;
        string waterableTile = string.Join(
            "|",
            ExecutionManager.PetBowlWaterableTiles(bowl).Select(tile => $"{(int)tile.X},{(int)tile.Y}"));
        // The runner equips the can through its own receipted equip_tool; this
        // warp only places the actor on a lawful adjacent tile. Fixture starting
        // state, not an action receipt.
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)standingTile.X, (int)standingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized water-pet-bowl precondition before bridge attachment: can_water={suppliedCan.WaterLeft}; can_max={suppliedCan.waterCanMax}; bowl={bowlX},{bowlY}; waterable={waterableTile}; standing={(int)standingTile.X},{(int)standingTile.Y}; watered={bowl.watered.Value}; production alone equips, waters and emits receipts.", LogLevel.Info);
    }

    private void InitializeNativeLocalWaterSlimeHutchTroughFixture(Farmer player, Farm farm)
    {
        // Pre-attachment fixture only: the template save has no Slime Hutch
        // building and no SlimeHutch interior, so this scenario must create the
        // real building through target-version native construction and then enter
        // its lazily-created interior. `Build` (DebugCommands.cs:1420-1446) calls
        // `currentLocation.buildStructure(type, tile, player, out constructed, ...)`
        // and then sets `daysOfConstructionLeft = 0`, so the building is COMPLETE;
        // the interior is created on data load via Building.createIndoors
        // (Building.cs:1873-1920) using the building data's IndoorMapType.
        //
        // Establish only the declared Given: one charged Watering Can in the
        // backpack and the local player standing on a lawful tile adjacent to one of
        // the fixed trough coordinates `SlimeHutch.performToolAction` accepts
        // (`x == 16`, `y in 6..9`, SlimeHutch.cs:154-161). Production alone equips,
        // waters and emits the receipt; the fixture never waters a spot, never
        // writes `waterSpots`, and emits no receipt.
        StardewValley.SlimeHutch? existing = farm.buildings
            .Select(candidate => candidate.GetIndoors())
            .OfType<StardewValley.SlimeHutch>()
            .FirstOrDefault();
        StardewValley.SlimeHutch? hutch = existing;
        if (hutch is null)
        {
            GameLocation? previousLocation = Game1.currentLocation;
            StardewValley.Buildings.Building? constructed = null;
            try
            {
                Game1.currentLocation = farm;
                // Candidate tiles are scanned in map order; `Build` refuses an
                // illegal placement and logs a warning, so the first success wins.
                int mapWidth = farm.map.Layers[0].LayerWidth;
                int mapHeight = farm.map.Layers[0].LayerHeight;
                for (int x = 1; x < mapWidth - 2 && constructed is null; x++)
                {
                    for (int y = 1; y < mapHeight - 2 && constructed is null; y++)
                    {
                        if (Game1.game1.parseDebugInput($"Build \"Slime Hutch\" {x} {y}", null)
                            && farm.buildings.Select(candidate => candidate.GetIndoors()).OfType<StardewValley.SlimeHutch>().Any())
                        {
                            constructed = farm.buildings.LastOrDefault();
                        }
                    }
                }
            }
            finally { Game1.currentLocation = previousLocation; }
            if (constructed is null)
                throw new InvalidOperationException("fixture_native_water_slime_hutch_trough_build_unavailable");
            hutch = constructed.GetIndoors() as StardewValley.SlimeHutch;
        }

        if (hutch is null)
            throw new InvalidOperationException("fixture_native_water_slime_hutch_trough_interior_unavailable");

        // First unwatered trough tile with a lawful adjacent standing tile.
        Vector2? troughTile = null;
        Vector2 troughStanding = Vector2.Zero;
        for (int y = 6; y <= 9 && troughTile is null; y++)
        {
            if (hutch.waterSpots[y - 6]) continue;
            Vector2[] neighbours =
            {
                new(17, y), new(15, y), new(16, y - 1), new(16, y + 1),
                new(17, y - 1), new(17, y + 1), new(15, y - 1), new(15, y + 1),
            };
            Vector2? standing = neighbours
                .Where(tile => hutch.isTileOnMap(tile)
                    && hutch.isTilePassable(tile)
                    && !hutch.IsTileOccupiedBy(tile, CollisionMask.All, CollisionMask.None, useFarmerTile: false))
                .Cast<Vector2?>()
                .FirstOrDefault();
            if (standing is null) continue;
            troughTile = new Vector2(16, y);
            troughStanding = standing.Value;
        }
        if (troughTile is null)
            throw new InvalidOperationException("fixture_native_water_slime_hutch_trough_approach_missing");

        foreach (Item? ownedItem in player.Items.Where(item => item is WateringCan).ToArray())
            player.Items.Remove(ownedItem);
        WateringCan suppliedTroughCan = new();
        suppliedTroughCan.WaterLeft = Math.Max(1, suppliedTroughCan.waterCanMax - 1);
        if (player.addItemToInventory(suppliedTroughCan) is not null)
            throw new InvalidOperationException("fixture_native_water_slime_hutch_trough_can_missing");
        if (!player.Items.OfType<WateringCan>().Any())
            throw new InvalidOperationException("fixture_native_water_slime_hutch_trough_can_missing");

        // Enter through the normal warp lifecycle (the same shape the AnimalHouse
        // fixture uses), not a raw currentLocation assignment.
        player.warpFarmer(new StardewValley.Warp(0, 0, hutch.NameOrUniqueName, (int)troughStanding.X, (int)troughStanding.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized water-slime-hutch-trough precondition before bridge attachment: can_water={suppliedTroughCan.WaterLeft}; can_max={suppliedTroughCan.waterCanMax}; interior={hutch.NameOrUniqueName}; trough={(int)troughTile.Value.X},{(int)troughTile.Value.Y}; standing={(int)troughStanding.X},{(int)troughStanding.Y}; production alone equips, waters and emits receipts.", LogLevel.Info);
    }

    private void InitializeNativeLocalHarvestBushFixture(Farmer player, Farm farm)
    {
        (Vector2 TargetTile, Vector2 StandingTile)? spot = FindNativeLocalWeedFixtureSpot(farm);
        // A bush is a `LargeTerrainFeature`, and `largeTerrainFeatures` is the only collection the engine
        // puts one in (GameLocation.cs:17403-17421), so the fixture places it there.
        if (spot is null || farm.terrainFeatures.ContainsKey(spot.Value.TargetTile)
            || farm.largeTerrainFeatures.Any(existing => existing.Tile == spot.Value.TargetTile))
            throw new InvalidOperationException("fixture_native_harvest_bush_target_missing");
        if (Game1.currentSeason != "spring")
            Game1.currentSeason = "spring";
        if (Game1.dayOfMonth is < 15 or > 18)
            Game1.dayOfMonth = 15;
        StardewValley.TerrainFeatures.Bush bush = new(spot.Value.TargetTile, 1, farm);
        bush.tileSheetOffset.Value = 1;
        bush.shakeTimer = 0f;
        farm.largeTerrainFeatures.Add(bush);
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
    }

    private void InitializeNativeLocalHarvestFruitTreeFixture(Farmer player, Farm farm)
    {
        (Vector2 TargetTile, Vector2 StandingTile)? spot = FindNativeLocalWeedFixtureSpot(farm);
        if (spot is null || farm.terrainFeatures.ContainsKey(spot.Value.TargetTile)) throw new InvalidOperationException("fixture_native_harvest_fruit_tree_target_missing");
        if (Game1.currentSeason != "spring")
            Game1.currentSeason = "spring";
        if (Game1.dayOfMonth is < 15 or > 18)
            Game1.dayOfMonth = 15;
        StardewValley.TerrainFeatures.FruitTree tree = new("629", 4);
        tree.growthStage.Value = 4;
        tree.GreenHouseTileTree = false;
        tree.fruit.Add(ItemRegistry.Create<StardewValley.Object>("(O)638"));
        farm.terrainFeatures.Add(spot.Value.TargetTile, tree);
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy harvest-fruit-tree diagnostics: tree_tile={spot.Value.TargetTile.X},{spot.Value.TargetTile.Y};standing={spot.Value.StandingTile.X},{spot.Value.StandingTile.Y};season={Game1.season};day={Game1.dayOfMonth};in_season={tree.IsInSeasonHere()};data_null={tree.GetData() is null};tree_id={tree.treeId.Value};keys={string.Join(",", Game1.fruitTreeData.Keys.Take(6))};fruit_count={tree.fruit.Count};tree_stage={tree.growthStage.Value};seed_ready={farm.terrainFeatures.ContainsKey(spot.Value.TargetTile)}", LogLevel.Info);
    }

    private void InitializeNativeLocalShakeTreeFixture(Farmer player, Farm farm)
    {
        (Vector2 TargetTile, Vector2 StandingTile)? spot = FindNativeLocalWeedFixtureSpot(farm);
        if (spot is null || farm.terrainFeatures.ContainsKey(spot.Value.TargetTile)) throw new InvalidOperationException("fixture_native_shake_tree_target_missing");
        StardewValley.TerrainFeatures.Tree tree = new("1", 5);
        tree.hasSeed.Value = true;
        tree.stump.Value = false;
        tree.wasShakenToday.Value = false;
        player.foragingLevel.Value = Math.Max(player.foragingLevel.Value, 1);
        farm.terrainFeatures.Add(spot.Value.TargetTile, tree);
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
    }

    private void InitializeNativeLocalTakePedestalItemFixture(Farmer player, Farm farm)
    {
        (Vector2 TargetTile, Vector2 StandingTile)? spot = FindNativeLocalWeedFixtureSpot(farm);
        if (spot is null || farm.objects.ContainsKey(spot.Value.TargetTile)) throw new InvalidOperationException("fixture_native_take_pedestal_target_missing");
        StardewValley.Objects.ItemPedestal pedestal = new(spot.Value.TargetTile, null, false, Microsoft.Xna.Framework.Color.White);
        pedestal.heldObject.Value = ItemRegistry.Create<StardewValley.Object>("(O)388", 3);
        farm.objects.Add(spot.Value.TargetTile, pedestal);
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
    }

    private void InitializeNativeLocalToggleFenceGateFixture(Farmer player, Farm farm)
    {
        (Vector2 TargetTile, Vector2 StandingTile)? spot = FindNativeLocalWeedFixtureSpot(farm);
        if (spot is null || farm.objects.ContainsKey(spot.Value.TargetTile) || farm.objects.ContainsKey(spot.Value.TargetTile + Vector2.UnitY))
            throw new InvalidOperationException("fixture_native_toggle_fence_gate_target_missing");
        StardewValley.Fence neighbor = new(spot.Value.TargetTile + Vector2.UnitY, "322", isGate: false);
        StardewValley.Fence gate = new(spot.Value.TargetTile, "325", isGate: true);
        farm.objects.Add(spot.Value.TargetTile + Vector2.UnitY, neighbor);
        farm.objects.Add(spot.Value.TargetTile, gate);
        if (!gate.isGate.Value || gate.getDrawSum() == 0)
            throw new InvalidOperationException("fixture_native_toggle_fence_gate_connection_missing");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
    }

    private void InitializeNativeLocalClearCaskFixture(Farmer player, Farm farm)
    {
        (Vector2 TargetTile, Vector2 StandingTile)? spot = FindNativeLocalChestFixtureSpot(farm);
        if (spot is null) throw new InvalidOperationException("fixture_native_local_clear_cask_target_missing");
        StardewValley.Objects.Cask cask = new(spot.Value.TargetTile);
        if (farm.objects.ContainsKey(spot.Value.TargetTile)) throw new InvalidOperationException("fixture_native_local_clear_cask_occupied");
        farm.objects.Add(spot.Value.TargetTile, cask);
        if (!farm.objects.TryGetValue(spot.Value.TargetTile, out StardewValley.Object? placed) || !ReferenceEquals(placed, cask))
            throw new InvalidOperationException("fixture_native_local_clear_cask_placement_failed");
        if (player.Items.OfType<Axe>().FirstOrDefault() is null && player.addItemToInventory(new Axe()) is not null)
            throw new InvalidOperationException("fixture_native_local_clear_cask_axe_inventory_full");
        if (!player.Items.OfType<Axe>().Any()) throw new InvalidOperationException("fixture_native_local_clear_cask_axe_missing");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized clear-cask precondition before bridge attachment: cask=empty; tool=axe; standing={spot.Value.StandingTile.X},{spot.Value.StandingTile.Y}; production alone invokes Cask.performToolAction and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalDressMannequinFixture(Farmer player, Farm farm)
    {
        (Vector2 TargetTile, Vector2 StandingTile)? spot = FindNativeLocalChestFixtureSpot(farm);
        if (spot is null) throw new InvalidOperationException("fixture_native_local_dress_mannequin_tile_missing");
        StardewValley.Objects.Mannequin mannequin = new("Mannequin");
        farm.objects.Add(spot.Value.TargetTile, mannequin);
        if (!farm.objects.TryGetValue(spot.Value.TargetTile, out StardewValley.Object? placed) || !ReferenceEquals(placed, mannequin)) throw new InvalidOperationException("fixture_native_local_dress_mannequin_placement_failed");
        Item clothing = ItemRegistry.Create("(H)0", 1);
        if (player.addItemToInventory(clothing) is not null) throw new InvalidOperationException("fixture_native_local_dress_mannequin_item_inventory_full");
        int clothingSlot = player.Items.IndexOf(clothing);
        if (clothingSlot < 0) throw new InvalidOperationException("fixture_native_local_dress_mannequin_clothing_slot_missing");
        player.CurrentToolIndex = clothingSlot;
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log("GameBuddy native-local-player initialized mannequin precondition before bridge attachment; production alone dresses and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalSetSignDisplayFixture(Farmer player, Farm farm)
    {
        (Vector2 TargetTile, Vector2 StandingTile)? spot = FindNativeLocalChestFixtureSpot(farm);
        if (spot is null) throw new InvalidOperationException("fixture_native_local_set_sign_tile_missing");
        StardewValley.Objects.Sign sign = new(spot.Value.TargetTile, "Sign");
        farm.objects.Add(spot.Value.TargetTile, sign);
        Item display = ItemRegistry.Create("(O)388", 1);
        if (player.addItemToInventory(display) is not null) throw new InvalidOperationException("fixture_native_local_set_sign_item_inventory_full");
        int displaySlot = player.Items.IndexOf(display);
        if (displaySlot < 0) throw new InvalidOperationException("fixture_native_local_set_sign_display_slot_missing");
        player.CurrentToolIndex = displaySlot;
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log("GameBuddy native-local-player initialized Sign display precondition before bridge attachment; production alone sets display and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalFeedAnimalFixture(Farmer player, Farm farm)
    {
        // This disposable native-local branch may use the pinned
        // target-version SetupBigFarm entrypoint solely to construct an
        // AnimalHouse/world entry precondition. It neither invokes
        // the native feed ingress nor fills a trough, consumes Hay,
        // creates a receipt, or changes feed_animal's postcondition.
        GameLocation? feedSetupPreviousLocation = Game1.currentLocation;
        try
        {
            Game1.currentLocation = farm;
            if (!Game1.game1.parseDebugInput("SetupBigFarm", null))
                throw new InvalidOperationException("fixture_native_feed_animal_setup_unavailable");
        }
        finally { Game1.currentLocation = feedSetupPreviousLocation; }

        StardewValley.Buildings.Building[] animalBuildings = farm.buildings
            .Where(building => building.GetIndoors() is StardewValley.AnimalHouse)
            .ToArray();
        // The pinned target-version SetupBigFarm source places Deluxe
        // Barns at (16,9) and (3,16). Building interiors are instanced,
        // so NameOrUniqueName is deliberately not a stable selector.
        // Select only the source-defined first Deluxe Barn placement;
        // do not guess a generated interior name or mutate the other
        // native buildings.
        StardewValley.Buildings.Building[] configuredBarns = animalBuildings
            .Where(building => string.Equals(building.buildingType.Value, "Deluxe Barn", StringComparison.Ordinal)
                && building.tileX.Value == 16
                && building.tileY.Value == 9)
            .ToArray();
        if (configuredBarns.Length != 1 || configuredBarns[0].GetIndoors() is not StardewValley.AnimalHouse animalHouse)
            throw new InvalidOperationException("fixture_native_feed_animal_house_missing_or_ambiguous");
        Microsoft.Xna.Framework.Point entryPoint = configuredBarns[0].getPointForHumanDoor();
        StardewValley.Warp? entryWarp = farm.getWarpFromDoor(entryPoint, player);
        if (entryWarp is null || !string.Equals(entryWarp.TargetName, animalHouse.NameOrUniqueName, StringComparison.Ordinal)
            || entryPoint.X < 0 || entryPoint.Y < 0 || !farm.isTileOnMap(new Vector2(entryPoint.X, entryPoint.Y))
            || entryWarp.TargetX < 0 || entryWarp.TargetY < 0 || !animalHouse.isTileOnMap(new Vector2(entryWarp.TargetX, entryWarp.TargetY)))
            throw new InvalidOperationException("fixture_native_feed_animal_entry_unresolvable");
        xTile.Layers.Layer? backLayer = animalHouse.map.GetLayer("Back");
        if (backLayer is null)
            throw new InvalidOperationException("fixture_native_feed_animal_trough_layer_missing");
        Vector2[] emptyTroughs = Enumerable.Range(0, backLayer.LayerWidth)
            .SelectMany(x => Enumerable.Range(0, backLayer.LayerHeight).Select(y => new Vector2(x, y)))
            .Where(tile => animalHouse.doesTileHaveProperty((int)tile.X, (int)tile.Y, "Trough", "Back") is not null
                && !animalHouse.objects.ContainsKey(tile))
            .OrderBy(tile => tile.Y).ThenBy(tile => tile.X)
            .ToArray();
        if (emptyTroughs.Length == 0)
            throw new InvalidOperationException("fixture_native_feed_animal_empty_trough_missing");
        Vector2 trough = emptyTroughs[0];
        Vector2[] standingCandidates = new[]
        {
            trough + new Vector2(0f, 1f), trough + new Vector2(-1f, 0f),
            trough + new Vector2(1f, 0f), trough + new Vector2(0f, -1f),
        };
        Vector2? standingTile = standingCandidates
            .Where(candidate => animalHouse.isTileOnMap(candidate)
                && animalHouse.isTilePassable(candidate)
                && !animalHouse.IsTileOccupiedBy(candidate, CollisionMask.All, CollisionMask.None, useFarmerTile: false))
            .Cast<Vector2?>()
            .FirstOrDefault();
        if (standingTile is null)
            throw new InvalidOperationException("fixture_native_feed_animal_trough_approach_missing");
        // The fixture SetupBigFarm call is already running on the
        // game-thread pre-attachment seam. Complete the exact native
        // Farm→AnimalHouse warp lifecycle now; this positions only the
        // local Player and does not interact with the Trough.
        player.warpFarmer(new StardewValley.Warp(
            entryPoint.X,
            entryPoint.Y,
            animalHouse.NameOrUniqueName,
            (int)standingTile.Value.X,
            (int)standingTile.Value.Y,
            false));
        // `warpFarmer` begins a native transition; retain the fixture
        // target facts and finish the local-player position only after
        // that transition has completed in a later game tick.
        this.nativeLocalFeedFixturePending = new NativeLocalFeedFixturePending(
            animalHouse.NameOrUniqueName,
            trough,
            standingTile.Value);
    }

    private void InitializeNativeLocalCollectAnimalProductFixture(Farmer player, Farm farm)
    {
        // SetupBigFarm is a target-version pre-attachment setup route
        // for an adult animal with a ready product. It does not invoke
        // either collection tool, clear product, add produce, or emit a
        // receipt; the typed production action remains the sole ingress.
        GameLocation? productSetupPreviousLocation = Game1.currentLocation;
        try
        {
            Game1.currentLocation = farm;
            if (!Game1.game1.parseDebugInput("SetupBigFarm", null))
                throw new InvalidOperationException("fixture_native_collect_animal_product_setup_unavailable");
        }
        finally { Game1.currentLocation = productSetupPreviousLocation; }

        (StardewValley.AnimalHouse House, FarmAnimal Animal, Tool Tool, string ToolKind)? compatible = farm.buildings
            .Select(building => building.GetIndoors())
            .OfType<StardewValley.AnimalHouse>()
            .SelectMany(house => house.animals.Values.Select(animal => (House: house, Animal: animal)))
            .Where(candidate => candidate.Animal.isAdult() && candidate.Animal.currentProduce.Value is not null)
            .Select(candidate => candidate.Animal.CanGetProduceWithTool(new MilkPail())
                ? (candidate.House, candidate.Animal, Tool: (Tool)new MilkPail(), ToolKind: "milk_pail")
                : candidate.Animal.CanGetProduceWithTool(new Shears())
                    ? (candidate.House, candidate.Animal, Tool: (Tool)new Shears(), ToolKind: "shears")
                    : ((StardewValley.AnimalHouse House, FarmAnimal Animal, Tool Tool, string ToolKind)?)null)
            .FirstOrDefault(candidate => candidate is not null);
        if (compatible is null)
            throw new InvalidOperationException("fixture_native_collect_animal_product_ready_animal_missing");
        Vector2? standingTile = new[]
        {
            compatible.Value.Animal.Tile + new Vector2(0f, 1f), compatible.Value.Animal.Tile + new Vector2(-1f, 0f),
            compatible.Value.Animal.Tile + new Vector2(1f, 0f), compatible.Value.Animal.Tile + new Vector2(0f, -1f),
        }.Where(tile => compatible.Value.House.isTileOnMap(tile) && compatible.Value.House.isTilePassable(tile)
            && !compatible.Value.House.IsTileOccupiedBy(tile, CollisionMask.All, CollisionMask.None, useFarmerTile: false))
            .Cast<Vector2?>().FirstOrDefault();
        if (standingTile is null)
            throw new InvalidOperationException("fixture_native_collect_animal_product_approach_missing");
        if (!player.Items.OfType<Tool>().Any(tool => tool.GetType() == compatible.Value.Tool.GetType())
            && player.addItemToInventory(compatible.Value.Tool) is not null)
            throw new InvalidOperationException("fixture_native_collect_animal_product_tool_inventory_full");
        if (!player.Items.OfType<Tool>().Any(tool => tool.GetType() == compatible.Value.Tool.GetType()))
            throw new InvalidOperationException("fixture_native_collect_animal_product_tool_missing_after_add");
        player.warpFarmer(new StardewValley.Warp(0, 0, compatible.Value.House.NameOrUniqueName,
            (int)standingTile.Value.X, (int)standingTile.Value.Y, false));
        this.nativeLocalCollectAnimalProductFixturePending = new NativeLocalCollectAnimalProductFixturePending(
            compatible.Value.House.NameOrUniqueName, compatible.Value.Animal.myID.Value, compatible.Value.Animal.Tile,
            compatible.Value.Animal.currentProduce.Value, compatible.Value.ToolKind);
    }

    private void InitializeNativeLocalUseRaftFixture(Farmer player, Farm farm)
    {
        if (!player.Items.OfType<StardewValley.Tools.Raft>().Any())
        {
            StardewValley.Tools.Raft raft = new();
            if (player.addItemToInventory(raft) is not null)
                throw new InvalidOperationException("fixture_native_use_raft_inventory_full");
        }
        int raftSlot = -1;
        for (int i = 0; i < player.Items.Count; i++)
            if (player.Items[i] is StardewValley.Tools.Raft) { raftSlot = i; break; }
        if (raftSlot < 0)
            throw new InvalidOperationException("fixture_native_use_raft_raft_missing");
        StardewValley.Tools.Raft equippedRaft = (StardewValley.Tools.Raft)player.Items[raftSlot]!;
        player.CurrentToolIndex = raftSlot;
        if (!ReferenceEquals(player.CurrentTool, equippedRaft))
            throw new InvalidOperationException("fixture_native_use_raft_equip_failed");
        // The actor starts indoors (FarmHouse), so the water edge must be
        // located on the Farm map itself before the raft can be aimed.
        Vector2? waterEdge = FindNativeRaftFixtureWaterEdge(farm);
        if (waterEdge is null)
            throw new InvalidOperationException("fixture_native_use_raft_water_tile_missing");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)waterEdge.Value.X, (int)waterEdge.Value.Y, false));
        // warpFarmer does not move the actor synchronously, so read the
        // water geometry from the pre-warp edge tile (waterEdge is the
        // land tile adjacent to water) and stand there.
        Vector2 raftStanding = waterEdge.Value;
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)raftStanding.X, (int)raftStanding.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized use-raft precondition before bridge attachment: standing={raftStanding.X},{raftStanding.Y};slot={raftSlot};production alone launches.", LogLevel.Info);
    }

    private void InitializeNativeLocalMountTransportFixture(Farmer player, Farm farm)
    {
        StardewValley.Characters.Horse? horse = farm.characters.OfType<StardewValley.Characters.Horse>().FirstOrDefault(candidate => !string.IsNullOrWhiteSpace(candidate.Name) && !string.Equals(candidate.Name, "Horse", StringComparison.Ordinal));
        if (horse is null)
        {
            Vector2 horseTile = new(player.Tile.X + 1, player.Tile.Y);
            horse = new StardewValley.Characters.Horse(System.Guid.NewGuid(), (int)horseTile.X, (int)horseTile.Y);
            horse.Name = "GameBuddyFixtureHorse";
            farm.characters.Add(horse);
        }
        horse.Name = string.IsNullOrWhiteSpace(horse.Name) || horse.Name == "Horse" ? "GameBuddyFixtureHorse" : horse.Name;
        Vector2 standing = new(horse.Tile.X - 1, horse.Tile.Y);
        if (!farm.isTileOnMap(standing) || !farm.isTilePassable(standing))
            throw new InvalidOperationException("fixture_native_mount_transport_standing_tile_missing");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)standing.X, (int)standing.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized mount-transport precondition: horse={horse.Name};tile={horse.Tile.X},{horse.Tile.Y};standing={standing.X},{standing.Y};production alone mounts.", LogLevel.Info);
    }

    private void InitializeNativeLocalEnterMineFixture(Farmer player)
    {
        StardewValley.GameLocation? mineMap = Game1.getLocationFromName("Mine");
        Vector2? entrance = mineMap is null ? null : FindNativeMineEntranceFixtureTarget(mineMap, player);
        if (entrance is null) throw new InvalidOperationException("fixture_native_enter_mine_entrance_missing");
        // The bridge reads the same "Mine" Action tile on the player's
        // current map. The real entrance lives on the "Mine" map (reached
        // from Mountain by warp), so place the actor adjacent to it.
        Vector2 mineStanding = entrance.Value;
        Vector2[] mineNeighbours = new[] {
            mineStanding + new Vector2(0, -1), mineStanding + new Vector2(1, 0),
            mineStanding + new Vector2(0, 1), mineStanding + new Vector2(-1, 0),
        };
        Vector2? stand = mineNeighbours.FirstOrDefault(candidate =>
            candidate.X >= 0 && candidate.Y >= 0
            && candidate.X < mineMap!.map.Layers[0].LayerWidth
            && candidate.Y < mineMap.map.Layers[0].LayerHeight
            && mineMap.isTilePassable(candidate));
        if (stand is null) throw new InvalidOperationException("fixture_native_enter_mine_standing_missing");
        // Warping into the Mine entrance plays event 100162 (first-entry
        // cutscene) once; mark it seen so the fixture is not blocked by it.
        player.eventsSeen.Add("100162");  // NetHashSet.Add is idempotent
        player.warpFarmer(new StardewValley.Warp(0, 0, mineMap!.NameOrUniqueName, (int)stand.Value.X, (int)stand.Value.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized enter-mine precondition: entrance={entrance.Value.X},{entrance.Value.Y}; production alone enters.", LogLevel.Info);
        this.Monitor.Log($"GameBuddy enter-mine event-probe: event_up={Game1.eventUp};event_id={Game1.CurrentEvent?.id};tile={player.Tile}", LogLevel.Info);
    }

    private void InitializeNativeLocalRideMinecartFixture(Farmer player, Farm farm)
    {
        // Pre-attachment fixture only: a minecart station the bridge can discover.
        //
        // The station tile property is map data, never code: the decompiled
        // game only READS it (`GameLocation.performAction` case
        // "MinecartTransport" at GameLocation.cs:9790, reached through
        // `GameLocation.cs:14201` reading `Action` from the Buildings layer).
        // The game's own unlock mechanic is the mail flag
        // (`ccBoilerRoom` for the community-center Boiler Room, or the Joja
        // equivalent), so the fixture establishes exactly that end state --
        // the same shape as the island fixture setting `farmhouseRestored`.
        //
        // Every other fact is real: the network, its destinations and their
        // conditions all come from the live `Data/Minecarts` the Mod reads, and
        // the ride itself is the native `GameLocation.MinecartWarp`. The fixture
        // never calls MinecartWarp, never picks a destination and emits no
        // receipt -- production alone discovers, resolves and rides.
        // The network's real unlock condition is the game's own data, so the
        // fixture evaluates THAT instead of inventing a query string. The
        // community-center Boiler Room is the vanilla unlock
        // (`ccBoilerRoom` on the MasterPlayer, which the game checks with
        // PLAYER_HAS_MAIL ... received); the Joja route sets the same flag.
        IReadOnlyDictionary<string, StardewValley.GameData.Minecarts.MinecartNetworkData>? networks = null;
        try
        {
            networks = DataLoader.Minecarts(Game1.content);
        }
        catch
        {
            networks = null;
        }
        if (networks is null || !networks.TryGetValue("Default", out StardewValley.GameData.Minecarts.MinecartNetworkData? defaultNetwork))
            throw new InvalidOperationException("fixture_native_minecart_network_data_missing");

        player.mailReceived.Add("ccBoilerRoom");
        if (Game1.MasterPlayer is not null)
            Game1.MasterPlayer.mailReceived.Add("ccBoilerRoom");

        bool networkUnlocked = string.IsNullOrWhiteSpace(defaultNetwork.UnlockCondition)
            || GameStateQuery.CheckConditions(defaultNetwork.UnlockCondition, farm);
        if (!networkUnlocked)
            throw new InvalidOperationException("fixture_native_minecart_network_unlock_failed");

        xTile.Layers.Layer? buildingsLayer = farm.map.GetLayer("Buildings");
        if (buildingsLayer is null)
            throw new InvalidOperationException("fixture_native_minecart_buildings_layer_missing");

        Vector2? stationTile = null;
        Vector2 stationStanding = Vector2.Zero;
        int mapWidth = farm.map.Layers[0].LayerWidth;
        int mapHeight = farm.map.Layers[0].LayerHeight;
        for (int x = 1; x < mapWidth - 1 && stationTile is null; x++)
        {
            for (int y = 1; y < mapHeight - 1 && stationTile is null; y++)
            {
                xTile.Tiles.Tile? candidate = buildingsLayer.Tiles[x, y];
                if (candidate is null) continue;
                Vector2 tile = new(x, y);
                // Buildings win over the map layer in `doesTileHaveProperty`, so
                // the station must not sit under a placed building.
                if (farm.buildings.Any(building => building.occupiesTile(tile, applyTilePropertyRadius: true)))
                    continue;
                if (farm.objects.ContainsKey(tile) || farm.terrainFeatures.ContainsKey(tile))
                    continue;
                Vector2[] neighbours = { new(x - 1, y), new(x + 1, y), new(x, y - 1), new(x, y + 1) };
                Vector2? standing = neighbours
                    .Where(neighbour => farm.isTileOnMap(neighbour)
                        && farm.isTilePassable(neighbour)
                        && !farm.IsTileOccupiedBy(neighbour, CollisionMask.All, CollisionMask.None, useFarmerTile: false))
                    .Cast<Vector2?>()
                    .FirstOrDefault();
                if (standing is null) continue;
                stationTile = tile;
                stationStanding = standing.Value;
            }
        }
        if (stationTile is null)
            throw new InvalidOperationException("fixture_native_minecart_station_tile_missing");

        // The native selector text, exactly the grammar `performAction` parses
        // with `ArgUtility.Get(action, 1)` -- network "Default" is the vanilla
        // four-destination network.
        buildingsLayer.Tiles[(int)stationTile.Value.X, (int)stationTile.Value.Y]
            .Properties["Action"] = "MinecartTransport Default";
        string? written = farm.doesTileHaveProperty(
            (int)stationTile.Value.X, (int)stationTile.Value.Y, "Action", "Buildings");
        if (!string.Equals(written, "MinecartTransport Default", StringComparison.Ordinal))
            throw new InvalidOperationException("fixture_native_minecart_station_property_rejected");

        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)stationStanding.X, (int)stationStanding.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized ride-minecart precondition before bridge attachment: network=Default; station={(int)stationTile.Value.X},{(int)stationTile.Value.Y}; standing={(int)stationStanding.X},{(int)stationStanding.Y}; unlocked=ccBoilerRoom; production alone discovers, resolves and rides.", LogLevel.Info);
    }

    private static int CountDryCrops(Farm farm) => farm.terrainFeatures.Pairs.Count(pair =>
        pair.Value is StardewValley.TerrainFeatures.HoeDirt { crop: not null } dirt && dirt.needsWatering() && !dirt.isWatered());

    /// <summary>
    /// The refill half: the first of the four tiles around the crop that the game's own refill predicate accepts as a water
    /// source. The property is written and then WITHDRAWN when the predicate refuses the tile, so a rejected candidate
    /// leaves no half-claimed water behind.
    /// </summary>
    private Vector2 ClaimWaterSourceBeside(Farm farm, Vector2 onlyCropTile)
    {
        xTile.Layers.Layer? farmBackLayer = farm.map.GetLayer("Back");
        foreach (Vector2 candidate in new[]
        {
            new Vector2(onlyCropTile.X, onlyCropTile.Y + 1), new Vector2(onlyCropTile.X, onlyCropTile.Y - 1),
            new Vector2(onlyCropTile.X + 1, onlyCropTile.Y), new Vector2(onlyCropTile.X - 1, onlyCropTile.Y),
        })
        {
            if (farm.terrainFeatures.ContainsKey(candidate)) continue;
            if (farm.objects.ContainsKey(candidate)) continue;
            if (!farm.isTileOnMap(candidate) || !farm.isTilePassable(candidate)) continue;
            if (farm.IsTileOccupiedBy(candidate, CollisionMask.All, CollisionMask.None, useFarmerTile: false)) continue;
            if (farmBackLayer?.Tiles[(int)candidate.X, (int)candidate.Y] is null) continue;
            farmBackLayer.Tiles[(int)candidate.X, (int)candidate.Y].Properties["WaterSource"] = "GameBuddyNativeLocalFixture";
            if (farm.CanRefillWateringCanOnTile((int)candidate.X, (int)candidate.Y))
                return candidate;
            farmBackLayer.Tiles[(int)candidate.X, (int)candidate.Y].Properties.Remove("WaterSource");
        }
        throw new InvalidOperationException("fixture_native_local_water_crop_empty_can_source_missing");
    }
}
