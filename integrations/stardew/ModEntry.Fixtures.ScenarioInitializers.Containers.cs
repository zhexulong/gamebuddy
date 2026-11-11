using GameBuddy.Stardew.Core.Routing;
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

    private void InitializeNativeLocalMachineNavigateAbFixture(Farmer player, Farm farm)
    {
        // Ladder 1: real body movement before work. The player stays in
        // the initial FarmHouse; this fixture places one idle Keg on the
        // Bus Stop door landing (Farm→BusStop native warp target) so a
        // real navigate_to_destination("Bus Stop") walk crosses the map
        // and stops one tile from the machine. Coffee Beans stay in the
        // backpack. Production alone navigates, inspects, loads and
        // emits receipts; no travel/inspect/load/result mutation
        // happens here.
        GameLocation? busStop = Game1.locations?.FirstOrDefault(location => location is StardewValley.Locations.BusStop);
        if (busStop is null)
            throw new InvalidOperationException("fixture_native_local_machine_navigate_busstop_missing");
        StardewValley.Warp? busDoorWarp = busStop.warps.FirstOrDefault(warp => !warp.npcOnly.Value
            && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
        if (busDoorWarp is null || busDoorWarp.X < 0 || busDoorWarp.Y < 0)
            throw new InvalidOperationException("fixture_native_local_machine_navigate_busstop_warp_missing");
        // The real navigate_to_destination("Bus Stop") walk lands at the
        // spot native navigation confirmed on this target version (the
        // door warp exists but completion parks the actor on the map's
        // confirmed landing, Bus Stop 11,23 — verified by the live probe
        // and the historical navigation gate tile log). The Keg must sit
        // within its Chebyshev-1 window (IsMachineTargetInRange).
        Vector2 navigateLanding = new(11f, 23f);
        Vector2? kegTile = FindNativeLocalFarmFixtureTile(busStop, navigateLanding, 1, requireEmptyObjectTile: true);
        if (kegTile is null)
            throw new InvalidOperationException("fixture_native_local_machine_navigate_keg_placement_missing");
        StardewValley.Object keg = ItemRegistry.Create<StardewValley.Object>("(BC)12", 1);
        // The Keg may sit beyond the player's dropObject reach from the
        // spawn tile; direct add (as rock/artifact fixtures do) after
        // ItemRegistry creates the full native machine data.
        if (keg.GetMachineData() is null || busStop.objects.ContainsKey(kegTile.Value))
            throw new InvalidOperationException("fixture_native_local_machine_navigate_keg_setup_missing");
        busStop.objects.Add(kegTile.Value, keg);
        if (!busStop.objects.TryGetValue(kegTile.Value, out StardewValley.Object? placedKeg)
            || !ReferenceEquals(keg, placedKeg) || placedKeg.GetMachineData() is null)
            throw new InvalidOperationException("fixture_native_local_machine_navigate_keg_setup_missing");
        StardewValley.Object coffeeBeans = ItemRegistry.Create<StardewValley.Object>("(O)433", 5);
        if (player.addItemToInventory(coffeeBeans) is not null || player.Items.OfType<StardewValley.Object>().Count(item => item.QualifiedItemId == "(O)433" && item.Stack == 5) != 1)
            throw new InvalidOperationException("fixture_native_local_machine_navigate_coffee_input_missing");
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized machine-navigate-ab precondition before bridge attachment: keg={placedKeg.QualifiedItemId}; keg_tile={(int)kegTile.Value.X},{(int)kegTile.Value.Y}; busstop_landing={(int)navigateLanding.X},{(int)navigateLanding.Y}; coffee_stack=5; production alone navigates to Bus Stop, inspects and loads.", LogLevel.Info);
    }

    private void InitializeNativeLocalBaitCrabPotFixture(Farmer player, Farm farm)
    {
        // Pre-attachment fixture only: create one current-player-owned,
        // unbaited (O)710 Crab Pot and one (O)685 Bait. Production alone
        // invokes checkAction and owns all attachment/consumption evidence.
        const string baitId = "(O)685";
        (Vector2 TargetTile, Vector2 StandingTile)? selected = FindNativeLocalCrabPotFixtureTarget(farm);
        if (selected is null) throw new InvalidOperationException("fixture_native_local_bait_crab_pot_target_missing");
        Vector2 targetTile = selected.Value.TargetTile;
        StardewValley.Objects.CrabPot pot = new();
        pot.owner.Value = player.UniqueMultiplayerID;
        farm.objects.Add(targetTile, pot);
        if (player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(baitId, 1)) is not null) throw new InvalidOperationException("fixture_native_local_bait_inventory_full");
        StardewValley.Object? bait = player.Items.OfType<StardewValley.Object>().SingleOrDefault(item => item.QualifiedItemId == baitId && item.Stack == 1);
        if (bait is null || pot.bait.Value is not null || pot.owner.Value != player.UniqueMultiplayerID) throw new InvalidOperationException("fixture_native_local_bait_crab_pot_precondition_failed");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)selected.Value.StandingTile.X, (int)selected.Value.StandingTile.Y, false));
        this.nativeLocalBaitCrabPotFixturePending = new NativeLocalBaitCrabPotFixturePending(farm.NameOrUniqueName, targetTile, selected.Value.StandingTile, pot, bait, player.UniqueMultiplayerID);
    }

    private void InitializeNativeLocalPlaceCrabPotFixture(Farmer player, Farm farm)
    {
        // Supply exactly one untouched (O)710. This branch only scans
        // the live Farm with CrabPot's exact target-version predicate,
        // validates one cardinal stance, and completes a native warp.
        // It performs no target mutation, inventory decrement, output
        // generation, or execution evidence.
        const string crabPotId = "(O)710";
        Item?[] inventoryBefore = player.Items.ToArray();
        int[] inventoryStacksBefore = inventoryBefore.Select(item => item?.Stack ?? -1).ToArray();
        string?[] inventoryIdsBefore = inventoryBefore.Select(item => item?.QualifiedItemId).ToArray();
        StardewValley.Object[] existingCrabPots = inventoryBefore
            .OfType<StardewValley.Object>()
            .Where(item => item.QualifiedItemId == crabPotId)
            .ToArray();
        if (existingCrabPots.Length > 1)
            throw new InvalidOperationException("fixture_native_local_crab_pot_inventory_multiple_stacks");
        if (existingCrabPots.Length == 1 && existingCrabPots[0].Stack != 1)
            throw new InvalidOperationException("fixture_native_local_crab_pot_inventory_stack_must_be_exactly_one");

        // Never remove, rebuild, or replace an existing pot. A missing
        // pot is provisioned only once into a genuinely empty slot in
        // this disposable fresh-save fixture; every other inventory
        // identity and count must remain byte-for-byte equivalent.
        int addedCrabPotSlot = -1;
        if (existingCrabPots.Length == 0)
        {
            int? emptyCrabPotSlot = Enumerable.Range(0, player.Items.Count)
                .Where(slot => player.Items[slot] is null)
                .Select(slot => (int?)slot)
                .FirstOrDefault();
            addedCrabPotSlot = emptyCrabPotSlot ?? -1;
            if (addedCrabPotSlot < 0)
                throw new InvalidOperationException("fixture_native_local_crab_pot_inventory_empty_slot_required");
            if (player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(crabPotId, 1)) is not null)
                throw new InvalidOperationException("fixture_native_local_crab_pot_inventory_add_failed");
        }
        Item?[] inventoryAfter = player.Items.ToArray();
        StardewValley.Object[] crabPotsAfter = inventoryAfter
            .OfType<StardewValley.Object>()
            .Where(item => item.QualifiedItemId == crabPotId && item.Stack > 0)
            .ToArray();
        if (crabPotsAfter.Length != 1
            || crabPotsAfter[0].Stack != 1
            || (existingCrabPots.Length == 1 && !ReferenceEquals(existingCrabPots[0], crabPotsAfter[0]))
            || (addedCrabPotSlot >= 0 && (!ReferenceEquals(inventoryBefore[addedCrabPotSlot], null)
                || !ReferenceEquals(inventoryAfter[addedCrabPotSlot], crabPotsAfter[0]))))
            throw new InvalidOperationException("fixture_native_local_crab_pot_inventory_postcondition_failed");
        StardewValley.Object crabPot = crabPotsAfter[0];
        int crabPotStack = crabPot.Stack;
        // Native inventory insertion may normalize unrelated item object
        // references. Preserve their slot/value facts (qualified ID and
        // stack), while retaining a strict object-identity invariant for
        // any pre-existing Crab Pot itself.
        for (int slot = 0; slot < inventoryBefore.Length; slot++)
        {
            if (slot == addedCrabPotSlot)
                continue;
            if ((inventoryAfter[slot]?.Stack ?? -1) != inventoryStacksBefore[slot]
                || inventoryAfter[slot]?.QualifiedItemId != inventoryIdsBefore[slot])
                throw new InvalidOperationException($"fixture_native_local_crab_pot_inventory_changed:slot={slot};before_id={inventoryIdsBefore[slot] ?? "null"};before_stack={inventoryStacksBefore[slot]};after_id={inventoryAfter[slot]?.QualifiedItemId ?? "null"};after_stack={inventoryAfter[slot]?.Stack ?? -1}");
        }
        if (IsExcludedCrabPotLocation(farm))
            throw new InvalidOperationException("fixture_native_local_crab_pot_location_rejected");
        (Vector2 TargetTile, Vector2 StandingTile)? selected = FindNativeLocalCrabPotFixtureTarget(farm);
        if (selected is null)
            throw new InvalidOperationException("fixture_native_local_crab_pot_target_missing");
        GameLocation? crabPotPreviousLocation = Game1.currentLocation;
        try
        {
            Game1.currentLocation = farm;
            if (!StardewValley.Objects.CrabPot.IsValidCrabPotLocationTile(farm, (int)selected.Value.TargetTile.X, (int)selected.Value.TargetTile.Y))
                throw new InvalidOperationException("fixture_native_local_crab_pot_target_revalidation_failed");
        }
        finally { Game1.currentLocation = crabPotPreviousLocation; }
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)selected.Value.StandingTile.X, (int)selected.Value.StandingTile.Y, false));
        this.nativeLocalPlaceCrabPotFixturePending = new NativeLocalPlaceCrabPotFixturePending(
            farm.NameOrUniqueName,
            selected.Value.TargetTile,
            selected.Value.StandingTile,
            crabPot,
            crabPotStack,
            inventoryAfter,
            inventoryAfter.Select(item => item?.Stack ?? -1).ToArray(),
            inventoryAfter.Select(item => item?.QualifiedItemId).ToArray());
    }

    private void InitializeNativeLocalMachinePreconditionFixture(Farmer player, NativeLocalPlayerFixtureConfig fixture)
    {
        // Machine inspection/loading are local to any loaded GameLocation. Keep this
        // fixture in the initial FarmHouse so its target is fresh and
        // adjacent before attachment; a Farm warp is not a machine
        // precondition and must not become hidden fixture authority.
        GameLocation? machineLocation = player.currentLocation;
        if (machineLocation is null)
            throw new InvalidOperationException("fixture_native_local_machine_location_missing");
        Vector2? machineTile = FindNativeLocalFarmFixtureTile(machineLocation, player.Tile, 1, requireEmptyObjectTile: true);
        if (machineTile is null)
            throw new InvalidOperationException("fixture_native_local_machine_placement_missing");
        StardewValley.Object machine = ItemRegistry.Create<StardewValley.Object>("(BC)12", 1);
        if (machine.GetMachineData() is null || !machineLocation.dropObject(machine, machineTile.Value * 64f, Game1.viewport, initialPlacement: true)
            || !machineLocation.objects.TryGetValue(machineTile.Value, out StardewValley.Object? placedMachine)
            || !ReferenceEquals(machine, placedMachine) || placedMachine.GetMachineData() is null)
            throw new InvalidOperationException("fixture_native_local_machine_setup_missing");
        if (fixture.FixtureScenario == "native_machine_coffee_load_v1")
        {
            // This is only the owned exact-stack input precondition.
            // Production alone invokes the normal machine interaction
            // ingress and proves native consumption/processing.
            StardewValley.Object coffeeBeans = ItemRegistry.Create<StardewValley.Object>("(O)433", 5);
            if (player.addItemToInventory(coffeeBeans) is not null || player.Items.OfType<StardewValley.Object>().Count(item => item.QualifiedItemId == "(O)433" && item.Stack == 5) != 1)
                throw new InvalidOperationException("fixture_native_local_machine_coffee_input_missing");
        }
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized {(fixture.FixtureScenario == "native_machine_coffee_load_v1" ? "machine-coffee-load" : fixture.FixtureScenario == "native_machine_coffee_collect_v1" ? "machine-coffee-collect" : "machine-inspect")} precondition before bridge attachment: machine={placedMachine.QualifiedItemId}; tile={(int)machineTile.Value.X},{(int)machineTile.Value.Y}; ready={placedMachine.readyForHarvest.Value}; minutes_until_ready={placedMachine.MinutesUntilReady}.", LogLevel.Info);
    }

    private void InitializeNativeLocalDigArtifactSpotFixture(Farmer player, Farm farm)
    {
        foreach (Item? ownedItem in player.Items.Where(item => item is Hoe).ToArray()) player.Items.Remove(ownedItem);
        if (player.addItemToInventory(new Hoe()) is not null || player.Items.OfType<Hoe>().Count() != 1 || player.Items.OfType<Hoe>().Single().UpgradeLevel != 0)
            throw new InvalidOperationException("fixture_native_local_artifact_spot_hoe_missing_or_ambiguous");

        // SetupBigFarm may restore zero, one, or many artifact spots.
        // Never remove or pre-consume an existing source: order every Farm
        // source so a reachable one is selected. Invalid or unreachable
        // sources do not get repaired; a valid later source may still be
        // selected.
        //
        // Selection prefers `(O)SeedSpot` on purpose. The engine spawns both
        // ids through one `t is Hoe` branch (`Object.cs:1310`) and picks
        // between them at random at every site (`GameLocation.cs:15233` at
        // 1/6, `Mountain.cs:272` at 0.15). A fixture that took the first
        // source by coordinate would almost always land on `(O)590` and
        // therefore keep passing even if the predicate regressed to a
        // single id, which is exactly the defect this fixture covers.
        KeyValuePair<Vector2, StardewValley.Object>[] existingArtifactSpots = farm.objects.Pairs
            .Where(pair => NativeItemPredicates.IsArtifactSpot(pair.Value))
            .OrderByDescending(pair => pair.Value.QualifiedItemId == "(O)SeedSpot")
            .ThenBy(pair => pair.Key.X)
            .ThenBy(pair => pair.Key.Y)
            .ToArray();
        Vector2 artifactTile;
        Vector2 standingTile;
        // Prefer an existing `(O)SeedSpot` when the save has one. Otherwise
        // place one alongside the existing sources rather than reusing a
        // `(O)590`: the variant is what this fixture must exercise.
        KeyValuePair<Vector2, StardewValley.Object>? preferredSeedSpot = existingArtifactSpots
            .Where(pair => pair.Value.QualifiedItemId == "(O)SeedSpot")
            .Select(pair => FindNativeLocalArtifactSpotStandingTile(farm, pair.Key) is Vector2 approach
                ? (KeyValuePair<Vector2, StardewValley.Object>?)pair
                : null)
            .FirstOrDefault(candidate => candidate is not null);
        if (preferredSeedSpot is { } seedSpot)
        {
            artifactTile = seedSpot.Key;
            standingTile = FindNativeLocalArtifactSpotStandingTile(farm, artifactTile)
                ?? throw new InvalidOperationException("fixture_native_local_artifact_spot_approach_missing");
        }
        else
        {
            Vector2? placedTile = FindNativeLocalFarmFixtureTile(farm, new Vector2(64f, 15f), 12, requireEmptyObjectTile: true,
                extraPredicate: candidate => !farm.terrainFeatures.ContainsKey(candidate));
            if (placedTile is null)
                throw new InvalidOperationException("fixture_native_local_artifact_spot_placement_missing");
            artifactTile = placedTile.Value;
            // Place the variant the engine itself spawns alongside (O)590.
            // Use the engine's own construction path: every artefact-spot
            // spawn site does `objects.Add(tile, ItemRegistry.Create<Object>(
            // "(O)SeedSpot"))` (GameLocation.cs:15233, Mountain.cs:272), never
            // `dropObject`, because this object is not a player-placeable one.
            // A fixture that always places (O)590 would keep passing even if
            // the predicate regressed to a single id, which is the defect
            // this fixture exists to cover.
            StardewValley.Object artifact = ItemRegistry.Create<StardewValley.Object>("(O)SeedSpot", 1);
            farm.objects.Add(artifactTile, artifact);
            if (!farm.objects.TryGetValue(artifactTile, out StardewValley.Object? placed)
                || !ReferenceEquals(artifact, placed) || !NativeItemPredicates.IsArtifactSpot(placed))
                throw new InvalidOperationException("fixture_native_local_artifact_spot_placement_validation_failed");
            standingTile = FindNativeLocalArtifactSpotStandingTile(farm, artifactTile)
                ?? throw new InvalidOperationException("fixture_native_local_artifact_spot_approach_missing");
        }
        int artifactSourceCount = farm.objects.Pairs.Count(pair => NativeItemPredicates.IsArtifactSpot(pair.Value));
        if (artifactSourceCount < 1
            || !farm.objects.TryGetValue(artifactTile, out StardewValley.Object? intactArtifact)
            || !NativeItemPredicates.IsArtifactSpot(intactArtifact)
            || !farm.isTileOnMap(artifactTile)
            || farm.terrainFeatures.ContainsKey(artifactTile)
            || farm.GetHoeDirtAtTile(artifactTile) is not null
            || intactArtifact is StardewValley.Objects.IndoorPot
            || player.Items.OfType<Hoe>().Count() != 1
            || player.Items.OfType<Hoe>().Single().UpgradeLevel != 0)
            throw new InvalidOperationException("fixture_native_local_artifact_spot_postsetup_validation_failed");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)standingTile.X, (int)standingTile.Y, false));
        this.nativeLocalDigArtifactSpotFixturePending = new NativeLocalDigArtifactSpotFixturePending(farm.NameOrUniqueName, artifactTile, standingTile);
    }

    private void InitializeNativeLocalChestStoreFixture(Farmer player, Farm farm)
    {
        // Pre-attachment fixture only: one current-player-owned ordinary
        // Chest on an empty Farm tile with a standable neighbor, plus one
        // ordinary storable item in the backpack. Production alone calls
        // Chest.addItem and owns all receipt/postcondition evidence.
        const string storeItemId = "(O)24";
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == storeItemId && item.Stack > 0)
            && player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(storeItemId, 1)) is not null)
            throw new InvalidOperationException("fixture_native_local_chest_store_inventory_full");
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == storeItemId && item.Stack > 0))
            throw new InvalidOperationException("fixture_native_local_chest_store_item_missing_after_add");
        (Vector2 TargetTile, Vector2 StandingTile)? spot = FindNativeLocalChestFixtureSpot(farm);
        if (spot is null) throw new InvalidOperationException("fixture_native_local_chest_store_target_missing");
        StardewValley.Objects.Chest chest = new(playerChest: true, spot.Value.TargetTile);
        if (farm.objects.TryGetValue(spot.Value.TargetTile, out StardewValley.Object? existingChest))
            throw new InvalidOperationException("fixture_native_local_chest_store_occupied");
        farm.objects.Add(spot.Value.TargetTile, chest);
        if (!IsFixtureOwnedOrdinaryChest(chest))
            throw new InvalidOperationException("fixture_native_local_chest_store_chest_invalid");
        if (!farm.objects.TryGetValue(spot.Value.TargetTile, out StardewValley.Object? placedChest))
            throw new InvalidOperationException("fixture_native_local_chest_store_placement_failed");
        if (placedChest is not StardewValley.Objects.Chest placedChestTyped || !ReferenceEquals(placedChestTyped, chest))
            throw new InvalidOperationException("fixture_native_local_chest_store_placement_failed");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized chest-store precondition before bridge attachment: item={storeItemId}; chest={chest.QualifiedItemId}; standing={spot.Value.StandingTile.X},{spot.Value.StandingTile.Y}; production alone invokes chest.addItem and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalChestRetrieveFixture(Farmer player, Farm farm)
    {
        // Pre-attachment fixture only: one owned ordinary Chest on an
        // empty Farm tile (standable neighbor) containing one item; the
        // backpack must accept that item. Production alone removes the
        // exact target through the native chest take data path and owns
        // all receipt/postcondition evidence.
        const string retrieveItemId = "(O)24";
        (Vector2 TargetTile, Vector2 StandingTile)? spot = FindNativeLocalChestFixtureSpot(farm);
        if (spot is null) throw new InvalidOperationException("fixture_native_local_chest_retrieve_target_missing");
        StardewValley.Objects.Chest chest = new(playerChest: true, spot.Value.TargetTile);
        if (farm.objects.TryGetValue(spot.Value.TargetTile, out StardewValley.Object? existing))
            throw new InvalidOperationException("fixture_native_local_chest_retrieve_occupied");
        StardewValley.Object contained = ItemRegistry.Create<StardewValley.Object>(retrieveItemId, 1);
        if (chest.addItem(contained) is not null)
            throw new InvalidOperationException("fixture_native_local_chest_retrieve_fill_failed");
        if (!player.couldInventoryAcceptThisItem(contained))
            throw new InvalidOperationException("fixture_native_local_chest_retrieve_inventory_unavailable");
        farm.objects.Add(spot.Value.TargetTile, chest);
        if (!IsFixtureOwnedOrdinaryChest(chest) || chest.GetItemsForPlayer().Count(item => item is not null) != 1)
            throw new InvalidOperationException("fixture_native_local_chest_retrieve_placement_failed");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized chest-retrieve precondition before bridge attachment: item={retrieveItemId}; chest={chest.QualifiedItemId}; standing={spot.Value.StandingTile.X},{spot.Value.StandingTile.Y}; production alone invokes the native chest take path and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalFridgePreconditionFixture(Farmer player, NativeLocalPlayerFixtureConfig fixture)
    {
        // Pre-attachment fixture only: the real built-in kitchen fridge is
        // a Chest (FarmHouse.fridge is NetRef<Chest> built with
        // playerChest: true), so it serves the same store/take intent as a
        // placed chest and runs the identical Chest.addItem /
        // GetItemsForPlayer().Remove transaction. The fixture therefore
        // establishes only the native precondition: a kitchen upgrade so
        // the room owns a fridge (GameLocation.GetFridge() returns null
        // while fridgePosition is Point.Zero), one ordinary storable item
        // in the backpack, and a lawful standing tile beside the fridge
        // map tile. Production alone moves the item and emits the receipt.
        bool retrieving = fixture.FixtureScenario == "native_fridge_retrieve_v1";
        const string fridgeItemId = "(O)24";
        if (player.currentLocation is not StardewValley.Locations.FarmHouse home)
            throw new InvalidOperationException("fixture_native_local_fridge_home_missing");
        // The vanilla house has no kitchen at upgrade 0 and FarmHouse.xnb
        // therefore has no fridge tile, so fridgePosition stays Point.Zero
        // and GetFridge() returns null. Use the target-version house route
        // (the same class of native setup as SpreadDirt/SetupBigFarm) to
        // reach the kitchen the fridge belongs to.
        if (home.fridgePosition == Point.Zero)
        {
            Game1.game1.parseDebugInput("HouseUpgrade 1", null);
            if (home.fridgePosition == Point.Zero)
                throw new InvalidOperationException("fixture_native_local_fridge_kitchen_unavailable");
        }
        StardewValley.Objects.Chest? fridge = home.GetFridge();
        if (fridge is null || !fridge.playerChest.Value)
            throw new InvalidOperationException("fixture_native_local_fridge_missing");
        Vector2 fridgeTile = new(home.fridgePosition.X, home.fridgePosition.Y);
        if (retrieving)
        {
            if (fridge.GetItemsForPlayer().Any(item => item is not null))
                throw new InvalidOperationException("fixture_native_local_fridge_retrieve_not_empty");
            StardewValley.Object contained = ItemRegistry.Create<StardewValley.Object>(fridgeItemId, 1);
            if (fridge.addItem(contained) is not null)
                throw new InvalidOperationException("fixture_native_local_fridge_retrieve_fill_failed");
            if (!player.couldInventoryAcceptThisItem(contained))
                throw new InvalidOperationException("fixture_native_local_fridge_retrieve_inventory_unavailable");
        }
        else
        {
            if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == fridgeItemId && item.Stack > 0)
                && player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(fridgeItemId, 1)) is not null)
                throw new InvalidOperationException("fixture_native_local_fridge_store_inventory_full");
            if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == fridgeItemId && item.Stack > 0))
                throw new InvalidOperationException("fixture_native_local_fridge_store_item_missing_after_add");
        }
        Vector2[] approach =
        {
            fridgeTile + new Vector2(0f, 1f), fridgeTile + new Vector2(0f, -1f),
            fridgeTile + new Vector2(-1f, 0f), fridgeTile + new Vector2(1f, 0f),
        };
        Vector2? standingTile = approach
            .Where(candidate => home.isTileOnMap(candidate) && home.isTilePassable(candidate)
                && !home.IsTileOccupiedBy(candidate, CollisionMask.All, CollisionMask.None, useFarmerTile: false))
            .Cast<Vector2?>()
            .FirstOrDefault();
        if (standingTile is null)
            throw new InvalidOperationException("fixture_native_local_fridge_approach_missing");
        player.warpFarmer(new StardewValley.Warp(0, 0, home.NameOrUniqueName, (int)standingTile.Value.X, (int)standingTile.Value.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized fridge precondition before bridge attachment: scenario={fixture.FixtureScenario}; fridge={fridge.QualifiedItemId}; fridge_tile={fridgeTile.X},{fridgeTile.Y}; standing={standingTile.Value.X},{standingTile.Value.Y}; item={fridgeItemId}; production alone runs the native container transaction and emits the receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalShipItemIslandFixture(Farmer player, Farm farm)
    {
        // Pre-attachment fixture only: IslandWest's shipping bin is not a
        // Building. It lives at the location's own `shippingBinPosition` and is
        // admitted only after the island house upgrade (IslandWest.cs:237 and
        // :311 both gate on farmhouseRestored). The game's own island UI path
        // hands `Game1.getFarm().shipItem` to ItemGrabMenu (IslandWest.cs:313),
        // which is exactly the call production makes, so the fixture only
        // establishes the declared Given: the island house restored, one
        // ordinary shippable Object in the backpack, the native bin emptied so
        // the shipped-stack delta is unambiguous, and the local player standing
        // on a lawful tile beside the native bin footprint. Production alone
        // calls Farm.shipItem and owns every postcondition; the fixture never
        // ships the item, never writes bin contents, and emits no receipt.
        if (Game1.getLocationFromName("IslandWest") is not StardewValley.Locations.IslandWest island)
            throw new InvalidOperationException("fixture_native_local_ship_item_island_missing");
        // The island house is restored by the parrot upgrade the save may not have
        // bought yet; setting the native flag is the same end state that upgrade
        // produces (IslandWest.cs:174) and is disposable fixture state only.
        island.farmhouseRestored.Value = true;
        if (!island.farmhouseRestored.Value)
            throw new InvalidOperationException("fixture_native_local_ship_item_island_not_restored");
        const string islandShipItemId = "(O)24";
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == islandShipItemId && item.Stack > 0)
            && player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(islandShipItemId, 1)) is not null)
            throw new InvalidOperationException("fixture_native_local_ship_item_island_inventory_full");
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == islandShipItemId && item.Stack > 0))
            throw new InvalidOperationException("fixture_native_local_ship_item_island_item_missing_after_add");
        // Native bin tile bounds are x in [X, X+1] and y in [Y-1, Y]
        // (IslandWest.cs:241 and :311), so the footprint origin is (X, Y-1) with
        // a 2x2 extent. Exploration candidates ring that footprint, and the
        // handler revalidates the exact target identity and adjacency.
        int binX = island.shippingBinPosition.X;
        int binY = island.shippingBinPosition.Y - 1;
        farm.getShippingBin(player).Clear();
        if (farm.getShippingBin(player).CountItemStacks() != 0)
            throw new InvalidOperationException("fixture_native_local_ship_item_island_bin_not_empty");
        List<Vector2> candidates = new();
        for (int x = binX - 1; x <= binX + 2; x++)
        {
            for (int y = binY - 1; y <= binY + 2; y++)
            {
                Vector2 tile = new(x, y);
                if (!island.isTileOnMap(tile) || !island.isTilePassable(tile))
                    continue;
                if (island.IsTileOccupiedBy(tile, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false))
                    continue;
                candidates.Add(tile);
            }
        }
        Vector2? islandStanding = candidates
            .OrderBy(tile => Math.Max(Math.Abs(tile.X - binX), Math.Abs(tile.Y - binY)))
            .ThenBy(tile => Math.Abs(tile.X - binX) + Math.Abs(tile.Y - binY))
            .Cast<Vector2?>()
            .FirstOrDefault();
        if (islandStanding is null)
            throw new InvalidOperationException("fixture_native_local_ship_item_island_standing_tile_missing");
        player.warpFarmer(new StardewValley.Warp(0, 0, island.NameOrUniqueName, (int)islandStanding.Value.X, (int)islandStanding.Value.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized island ship-item precondition before bridge attachment: item={islandShipItemId}; bin={island.shippingBinPosition.X},{island.shippingBinPosition.Y}; standing={islandStanding.Value.X},{islandStanding.Value.Y}; production alone invokes Farm.shipItem and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalFishHereFixture(Farmer player, Farm farm)
    {
        // The declared Given, and nothing else: a rod that TAKES bait with bait in it, the actor's own stamina,
        // and the actor standing on a tile next to a water tile the ENGINE says a rod may be cast at
        // (`canFishHere` + `isTileFishable`, the pair `FishingRod.DoFunction` gates a cast on, FishingRod.cs:411;
        // the standing half is the body's own rule, the same one discovery uses so it cannot publish a row the
        // walk refuses).
        //
        // NOTHING IS CAST and no fish is placed. Production alone calls `beginUsing`/`DoFunction`; the engine
        // alone decides which fish is here (`getFish`) and alone books the catch (`pullFishFromWater` ->
        // `playerCaughtFishEndFunction` -> `farmer.caughtFish`, then `doneHoldingFish`).
        if (farm.map is null || farm.map.Layers.Count == 0)
            throw new InvalidOperationException("fixture_native_fish_here_map_missing");
        if (!farm.canFishHere())
            throw new InvalidOperationException("fixture_native_fish_here_location_cannot_fish");
        Vector2? castTile = null;
        Vector2 standingTile = Vector2.Zero;
        for (int y = 0; y < farm.map.Layers[0].LayerHeight && castTile is null; y++)
        for (int x = 0; x < farm.map.Layers[0].LayerWidth && castTile is null; x++)
        {
            if (!farm.isTileFishable(x, y)) continue;
            foreach ((int nx, int ny) in new[] { (x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1) })
            {
                Vector2 candidate = new(nx, ny);
                if (!StardewBodyController.IsStandableTile(farm, player, candidate)) continue;
                castTile = new Vector2(x, y);
                standingTile = candidate;
                break;
            }
        }
        if (castTile is not { } water)
            throw new InvalidOperationException("fixture_native_fish_here_cast_tile_missing");
        // One cast of the day's own energy, from a full morning bar: the engine's gate is `Stamina > 1`
        // (FishingRod.cs:1647), so a bar that is full is the world a morning gives.
        player.Stamina = player.MaxStamina;
        FishingRod? rod = player.Items.OfType<FishingRod>().FirstOrDefault();
        if (rod is null)
        {
            // The smallest rod that takes bait (one attachment slot), so the bait half of the Given is real
            // rather than an optional extra: bait consumption is one of the facts the receipt measures.
            rod = ItemRegistry.Create<FishingRod>("(T)FiberglassRod");
            if (player.addItemToInventory(rod) is not null)
                throw new InvalidOperationException("fixture_native_fish_here_rod_inventory_full");
        }
        if (rod.GetBait() is null)
            rod.attach(ItemRegistry.Create<StardewValley.Object>("(O)685", 20));
        if (rod.GetBait() is null)
            throw new InvalidOperationException("fixture_native_fish_here_bait_not_attached");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)standingTile.X, (int)standingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized the fish_here precondition before bridge attachment: "
                + $"location={farm.NameOrUniqueName};cast_tile={water.X},{water.Y};standing={(int)standingTile.X},{(int)standingTile.Y};"
                + $"rod={rod.QualifiedItemId};bait={rod.GetBait()?.Stack ?? 0};stamina={player.Stamina}; production alone casts and the engine alone credits the catch.",
            LogLevel.Info);
    }

    private void InitializeNativeLocalDepositSiloHayFixture(Farmer player, Farm farm)
    {
        StardewValley.Buildings.Building? silo = farm.buildings.FirstOrDefault(building => building.buildingType.Value == "Silo");
        if (silo is null)
        {
            // The bootstrapped stable template has no Silo; the fixture
            // builds one so the native tryToAddHay has a real silo to hit.
            Vector2 siloTile = new(16, 8);
            while (farm.buildings.Any(building => building.tileX.Value == (int)siloTile.X && building.tileY.Value == (int)siloTile.Y))
                siloTile += new Vector2(3, 0);
            silo = new StardewValley.Buildings.Building("Silo", siloTile);
            // A freshly constructed Silo has daysOfConstructionLeft =
            // BuildDays > 0, which makes GetHayCapacity() count it as 0
            // (hay capacity only applies after construction). Finish it.
            silo.daysOfConstructionLeft.Value = 0;
            farm.buildings.Add(silo);
            farm.updateLayout();
        }
        if (silo is null) throw new InvalidOperationException("fixture_native_local_deposit_silo_missing");
        Point door = silo.getPointForHumanDoor();
        if (!farm.isTileOnMap(new Vector2(door.X, door.Y))) throw new InvalidOperationException("fixture_native_local_deposit_silo_door_missing");
        StardewValley.Object hay = ItemRegistry.Create<StardewValley.Object>("(O)178", 4);
        if (player.addItemToInventory(hay) is not null) throw new InvalidOperationException("fixture_native_local_deposit_silo_hay_inventory_full");
        int haySlot = player.Items.IndexOf(hay);
        if (haySlot < 0) throw new InvalidOperationException("fixture_native_local_deposit_silo_hay_slot_missing");
        player.CurrentToolIndex = haySlot;
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, door.X, door.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log("GameBuddy native-local-player initialized Silo/Hay precondition before bridge attachment; production alone deposits Hay and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalToggleToolLightFixture(Farmer player)
    {
        StardewValley.Tools.Lantern lantern = new();
        int lanternSlot = player.Items.IndexOf(null);
        if (lanternSlot < 0) throw new InvalidOperationException("fixture_native_local_toggle_tool_light_inventory_full");
        player.Items[lanternSlot] = lantern;
        player.CurrentToolIndex = lanternSlot;
        if (!ReferenceEquals(player.CurrentTool, lantern)) throw new InvalidOperationException("fixture_native_local_toggle_tool_light_equip_failed");
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log("GameBuddy native-local-player initialized Lantern precondition before bridge attachment; production alone toggles light and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalShipItemFixture(Farmer player, Farm farm)
    {
        // Pre-attachment fixture only: the naturally-loaded Farm keeps
        // its single native "Shipping Bin" building (Farm.cs:173
        // AddDefaultBuilding), and the backpack gains one ordinary
        // shippable Object. Production alone calls Farm.shipItem and
        // owns all receipt/postcondition evidence; the night settlement
        // stays entirely native (Game1.cs:7601-7627 money, :7753 bin
        // clear).
        const string shipItemId = "(O)24";
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == shipItemId && item.Stack > 0)
            && player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(shipItemId, 1)) is not null)
            throw new InvalidOperationException("fixture_native_local_ship_item_inventory_full");
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == shipItemId && item.Stack > 0))
            throw new InvalidOperationException("fixture_native_local_ship_item_missing_after_add");
        StardewValley.Buildings.ShippingBin? bin = farm.buildings.OfType<StardewValley.Buildings.ShippingBin>().FirstOrDefault();
        if (bin is null || bin.daysOfConstructionLeft.Value > 0)
            throw new InvalidOperationException("fixture_native_local_ship_item_bin_missing");
        Vector2? standing = FindNativeLocalShippingBinStandingTile(farm, bin);
        if (standing is null)
            throw new InvalidOperationException("fixture_native_local_ship_item_standing_tile_missing");
        // The native bin must start empty so the shipped-stack delta is
        // unambiguous; this is pre-attachment fixture state only.
        farm.getShippingBin(player).Clear();
        if (farm.getShippingBin(player).CountItemStacks() != 0)
            throw new InvalidOperationException("fixture_native_local_ship_item_bin_not_empty");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)standing.Value.X, (int)standing.Value.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized ship-item precondition before bridge attachment: item={shipItemId}; bin={bin.tileX.Value},{bin.tileY.Value}; standing={standing.Value.X},{standing.Value.Y}; production alone invokes Farm.shipItem and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalCraftItemFixture(Farmer player)
    {
        // Pre-attachment fixture only: learn one concrete vanilla
        // crafting recipe and carry its exact ingredients. Production
        // alone runs the native recipe transaction (learned gate,
        // ingredient consumption, createItem, inventory/drop) and emits
        // the receipt. No crafting menu, no heldItem, no fridge.
        const string craftRecipeKey = "Wood Fence";
        const string craftIngredientId = "(O)388";
        const int craftIngredientStack = 2;
        if (CraftingRecipe.craftingRecipes is null || !CraftingRecipe.craftingRecipes.ContainsKey(craftRecipeKey))
            throw new InvalidOperationException("fixture_native_local_craft_recipe_key_missing");
        Game1.player.craftingRecipes[craftRecipeKey] = 0;
        if (!Game1.player.craftingRecipes.ContainsKey(craftRecipeKey))
            throw new InvalidOperationException("fixture_native_local_craft_recipe_not_learned");
        foreach (StardewValley.Object stale in player.Items.OfType<StardewValley.Object>().Where(item => item.QualifiedItemId == craftIngredientId).ToArray())
            player.removeItemFromInventory(stale);
        if (player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(craftIngredientId, craftIngredientStack)) is not null
            || player.Items.OfType<StardewValley.Object>().Where(item => item.QualifiedItemId == craftIngredientId).Sum(item => item.Stack) != craftIngredientStack)
            throw new InvalidOperationException("fixture_native_local_craft_ingredient_missing");
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized craft-item precondition before bridge attachment: recipe={craftRecipeKey}; ingredient={craftIngredientId}x{craftIngredientStack}; production alone runs the native recipe transaction and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalCraftItemPartialFixture(Farmer player, Farm farm)
    {
        // Pre-attachment fixture only: learn a recipe whose product is
        // larger than the room left in a FULL backpack, so the native
        // recipe transaction must leave part of the product on the
        // ground. Production alone runs the transaction and emits the
        // honest PartiallySucceeded receipt.
        //
        // Bait's data row is "684 1/Home/685 5/false/Fishing 2/": one Bug
        // Meat becomes FIVE Bait. (O)685's native max stack is 999
        // (Object.maximumStackSize returns 1 only for (O)79/842/911 and
        // category -22), so an existing Bait stack of 998 absorbs exactly
        // one of the five and the other four leave the backpack. The Bug
        // Meat is placed with stack 2 so that consuming one leaves a live
        // stack behind: ingredient consumption must NOT free the slot that
        // would otherwise absorb the drop and hide the partial. Every
        // other slot holds a Tool, which is not an Object and can never
        // stack with the product.
        const string partialRecipeKey = "Bait";
        const string partialIngredientId = "(O)684";
        const int partialIngredientStack = 2;
        const string partialProductId = "(O)685";
        const int partialExistingStack = 998;
        const int partialProducedStack = 5;
        if (CraftingRecipe.craftingRecipes is null || !CraftingRecipe.craftingRecipes.ContainsKey(partialRecipeKey))
            throw new InvalidOperationException("fixture_native_local_craft_partial_recipe_key_missing");
        Game1.player.craftingRecipes[partialRecipeKey] = 0;
        if (!Game1.player.craftingRecipes.ContainsKey(partialRecipeKey))
            throw new InvalidOperationException("fixture_native_local_craft_partial_recipe_not_learned");
        if (ItemRegistry.Create<StardewValley.Object>(partialProductId, 1).maximumStackSize() != 999)
            throw new InvalidOperationException("fixture_native_local_craft_partial_product_stack_unexpected");
        player.Items.Clear();
        player.Items.Add(ItemRegistry.Create<StardewValley.Object>(partialProductId, partialExistingStack));
        player.Items.Add(ItemRegistry.Create<StardewValley.Object>(partialIngredientId, partialIngredientStack));
        while (player.Items.Count < player.MaxItems)
            player.Items.Add(player.Items.Count % 2 == 0 ? new Axe() : new Pickaxe());
        if (player.Items.Any(item => item is null))
            throw new InvalidOperationException("fixture_native_local_craft_partial_backpack_has_hole");
        if (player.couldInventoryAcceptThisItem(ItemRegistry.Create<StardewValley.Object>(partialProductId, partialProducedStack)))
            throw new InvalidOperationException("fixture_native_local_craft_partial_backpack_still_accepts_product");

        // One owned ordinary Chest beside a standable Farm tile. The actor
        // is warped onto that standable tile, exactly like the shipped
        // chest_store fixture, so the same session can store the partial
        // product without an extra navigation leg. `craft_item` itself is
        // location-agnostic, so this warp cannot invalidate the craft
        // precondition.
        (Vector2 TargetTile, Vector2 StandingTile)? partialChestSpot = FindNativeLocalChestFixtureSpot(farm);
        if (partialChestSpot is null)
            throw new InvalidOperationException("fixture_native_local_craft_partial_chest_target_missing");
        if (farm.objects.ContainsKey(partialChestSpot.Value.TargetTile))
            throw new InvalidOperationException("fixture_native_local_craft_partial_chest_occupied");
        StardewValley.Objects.Chest partialChest = new(playerChest: true, partialChestSpot.Value.TargetTile);
        farm.objects.Add(partialChestSpot.Value.TargetTile, partialChest);
        if (!IsFixtureOwnedOrdinaryChest(partialChest))
            throw new InvalidOperationException("fixture_native_local_craft_partial_chest_invalid");
        if (!farm.objects.TryGetValue(partialChestSpot.Value.TargetTile, out StardewValley.Object? partialPlaced)
            || !ReferenceEquals(partialPlaced, partialChest))
            throw new InvalidOperationException("fixture_native_local_craft_partial_chest_placement_failed");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)partialChestSpot.Value.StandingTile.X, (int)partialChestSpot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized craft partial-completion precondition before bridge attachment: recipe={partialRecipeKey}; product={partialProductId}@{partialExistingStack}; ingredient={partialIngredientId}x{partialIngredientStack}; chest={partialChest.QualifiedItemId}@{partialChestSpot.Value.TargetTile.X},{partialChestSpot.Value.TargetTile.Y}; standing={partialChestSpot.Value.StandingTile.X},{partialChestSpot.Value.StandingTile.Y}; production alone crafts, stores, and re-crafts.", LogLevel.Info);
    }

    private void InitializeNativeLocalCookRecipeFixture(Farmer player, Farm farm)
    {
        // Pre-attachment fixture only: learn one concrete vanilla
        // cooking recipe, carry its exact ingredient, and stand beside a
        // native cookout kit (BC)278 placed on the Farm. Production alone
        // runs the native cooking transaction and emits the receipt.
        const string cookRecipeKey = "Fried Egg";
        const string cookIngredientId = "(O)176";
        const string cookoutKitId = "(BC)278";
        if (CraftingRecipe.cookingRecipes is null || !CraftingRecipe.cookingRecipes.ContainsKey(cookRecipeKey))
            throw new InvalidOperationException("fixture_native_local_cook_recipe_key_missing");
        Game1.player.cookingRecipes[cookRecipeKey] = 0;
        if (!Game1.player.cookingRecipes.ContainsKey(cookRecipeKey))
            throw new InvalidOperationException("fixture_native_local_cook_recipe_not_learned");
        foreach (StardewValley.Object stale in player.Items.OfType<StardewValley.Object>().Where(item => item.QualifiedItemId == cookIngredientId).ToArray())
            player.removeItemFromInventory(stale);
        if (player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(cookIngredientId, 1)) is not null)
            throw new InvalidOperationException("fixture_native_local_cook_ingredient_missing");
        (Vector2 KitTile, Vector2 StandingTile)? station = FindNativeLocalCookingStationFixtureTarget(farm);
        if (station is null)
            throw new InvalidOperationException("fixture_native_local_cook_station_target_missing");
        farm.objects.Add(station.Value.KitTile, ItemRegistry.Create<StardewValley.Object>(cookoutKitId, 1));
        if (!farm.objects.TryGetValue(station.Value.KitTile, out StardewValley.Object? placedKit) || placedKit.QualifiedItemId != cookoutKitId)
            throw new InvalidOperationException("fixture_native_local_cook_station_placement_failed");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)station.Value.StandingTile.X, (int)station.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized cook-recipe precondition before bridge attachment: recipe={cookRecipeKey}; ingredient={cookIngredientId}; station={cookoutKitId}@{station.Value.KitTile.X},{station.Value.KitTile.Y}; standing={station.Value.StandingTile.X},{station.Value.StandingTile.Y}; production alone cooks and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalCrabPotCollectFixture(Farmer player, Farm farm)
    {
        // Pre-attachment fixture only: one current-player-owned native
        // Crab Pot in the already-mature 714 state (baited, held output,
        // ready) on a valid Farm water tile, with one cardinal standing
        // tile. Production alone invokes the single native collection and
        // emits the receipt; the fixture never calls checkForAction,
        // DayUpdate, or any settle helper.
        const string maturePotId = "(O)710";
        const string matureBaitId = "(O)685";
        const string matureOutputId = "(O)717";
        (Vector2 TargetTile, Vector2 StandingTile)? selected = FindNativeLocalCrabPotFixtureTarget(farm);
        if (selected is null)
            throw new InvalidOperationException("fixture_native_local_crab_pot_collect_target_missing");
        Vector2 potTile = selected.Value.TargetTile;
        StardewValley.Objects.CrabPot pot = new();
        pot.owner.Value = player.UniqueMultiplayerID;
        pot.bait.Value = ItemRegistry.Create<StardewValley.Object>(matureBaitId, 1);
        pot.heldObject.Value = ItemRegistry.Create<StardewValley.Object>(matureOutputId, 1);
        pot.tileIndexToShow = 714;
        pot.readyForHarvest.Value = true;
        farm.objects.Add(potTile, pot);
        if (!farm.objects.TryGetValue(potTile, out StardewValley.Object? placedPot)
            || placedPot is not StardewValley.Objects.CrabPot maturePot
            || maturePot.QualifiedItemId != maturePotId
            || maturePot.owner.Value != player.UniqueMultiplayerID
            || !maturePot.readyForHarvest.Value
            || maturePot.tileIndexToShow != 714
            || maturePot.heldObject.Value is null
            || maturePot.bait.Value is null)
            throw new InvalidOperationException("fixture_native_local_crab_pot_collect_precondition_failed");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)selected.Value.StandingTile.X, (int)selected.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized crab-pot-collect precondition before bridge attachment: pot={maturePotId}@{potTile.X},{potTile.Y}; output={matureOutputId}; tile_index=714; standing={selected.Value.StandingTile.X},{selected.Value.StandingTile.Y}; production alone collects and emits receipt.", LogLevel.Info);
    }
}
