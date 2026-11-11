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

    private void InitializeNativeLocalTillSoilFixture(Farmer player, Farm farm)
    {
        if (!player.Items.OfType<Hoe>().Any() && player.addItemToInventory(new Hoe()) is not null)
            throw new InvalidOperationException("fixture_native_local_hoe_inventory_full");
        if (!player.Items.OfType<Hoe>().Any())
            throw new InvalidOperationException("fixture_native_local_hoe_missing_after_add");
        GameLocation? previousLocation = Game1.currentLocation;
        try
        {
            Game1.currentLocation = farm;
            if (!Game1.game1.parseDebugInput("RemoveDirt", null))
                throw new InvalidOperationException("fixture_native_remove_dirt_command_unavailable");
        }
        finally { Game1.currentLocation = previousLocation; }
        bool groundExists = Enumerable.Range(0, farm.map.Layers[0].LayerWidth)
            .SelectMany(x => Enumerable.Range(0, farm.map.Layers[0].LayerHeight).Select(y => new Vector2(x, y)))
            .Any(tile => farm.GetHoeDirtAtTile(tile) is null
                && farm.doesTileHaveProperty((int)tile.X, (int)tile.Y, "Diggable", "Back") is not null
                && !farm.isWaterTile((int)tile.X, (int)tile.Y));
        if (!groundExists)
            throw new InvalidOperationException("fixture_native_tillable_soil_missing");
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log("GameBuddy native-local-player initialized native till-soil fixture before bridge attachment: Hoe equipped candidate available; production alone creates HoeDirt and receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalStaminaRecoveryFixture(Farmer player, Farm farm)
    {
        // Lane G low-stamina recovery precondition. Establishes only the
        // declared Given: a Hoe, bare diggable soil, one edible Object, and a LOW
        // but SAFE starting stamina.
        //
        // Stamina is a continuous fact, not a rejection gate: the tool handlers
        // drain it and report `stamina_before/after/delta/expected_stamina_cost`
        // on every receipt, and there is no `insufficient_stamina` reasonCode. So
        // this chain's breakpoint is the READING in the first receipt, not a
        // rejected terminal. The native pass-out fires at
        // `timeOfDay >= 2600 || player.stamina <= -15f` (Game1.cs:6452-6460), so the
        // starting value stays low AND comfortably above that floor. Setting
        // `player.stamina` directly is the established precondition technique for
        // this (see `native_pass_out_v1`); it does not till, eat, or emit a receipt.
        if (!player.Items.OfType<Hoe>().Any() && player.addItemToInventory(new Hoe()) is not null)
            throw new InvalidOperationException("fixture_native_local_stamina_hoe_inventory_full");
        if (!player.Items.OfType<Hoe>().Any())
            throw new InvalidOperationException("fixture_native_local_stamina_hoe_missing_after_add");
        const string staminaFoodId = "(O)216";
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == staminaFoodId && item.Stack > 0)
            && player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(staminaFoodId, 1)) is not null)
            throw new InvalidOperationException("fixture_native_local_stamina_food_inventory_full");
        StardewValley.Object? staminaFood = player.Items.OfType<StardewValley.Object>()
            .FirstOrDefault(item => item.QualifiedItemId == staminaFoodId && item.Stack > 0);
        if (staminaFood is null || staminaFood.Edibility == -300
            || (Game1.objectData.TryGetValue(staminaFood.ItemId, out var staminaFoodData) && staminaFoodData.IsDrink))
            throw new InvalidOperationException("fixture_native_local_stamina_food_missing_after_add");
        GameLocation? staminaSetupPreviousLocation = Game1.currentLocation;
        try
        {
            Game1.currentLocation = farm;
            if (!Game1.game1.parseDebugInput("RemoveDirt", null))
                throw new InvalidOperationException("fixture_native_remove_dirt_command_unavailable");
        }
        finally { Game1.currentLocation = staminaSetupPreviousLocation; }
        bool staminaGroundExists = Enumerable.Range(0, farm.map.Layers[0].LayerWidth)
            .SelectMany(x => Enumerable.Range(0, farm.map.Layers[0].LayerHeight).Select(y => new Vector2(x, y)))
            .Any(tile => farm.GetHoeDirtAtTile(tile) is null
                && farm.doesTileHaveProperty((int)tile.X, (int)tile.Y, "Diggable", "Back") is not null
                && !farm.isWaterTile((int)tile.X, (int)tile.Y));
        if (!staminaGroundExists)
            throw new InvalidOperationException("fixture_native_tillable_soil_missing");
        // Below the runner's low-stamina threshold, well above the -15 pass-out floor.
        player.stamina = 12f;
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized stamina-recovery precondition before bridge attachment: stamina={player.stamina.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)}; hoe=true; food={staminaFood.QualifiedItemId}; actor=unwarped; production alone tills, eats, and tills again.", LogLevel.Info);
    }

    private void InitializeNativeLocalPlaceWoodFenceFixture(Farmer player, Farm farm)
    {
        const string fenceId = "(O)322";
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == fenceId && item.Stack > 0)
            && player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(fenceId, 1)) is not null)
            throw new InvalidOperationException("fixture_native_local_wood_fence_inventory_full");
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == fenceId && item.Stack > 0))
            throw new InvalidOperationException("fixture_native_local_wood_fence_missing_after_add");
        bool targetExists = player.Items.Select((item, slot) => (item, slot)).Any(pair => pair.item is StardewValley.Object source
            && source.QualifiedItemId == fenceId && source.Stack > 0
            && Enumerable.Range(Math.Max(0, player.TilePoint.X - 1), 3).SelectMany(x => Enumerable.Range(Math.Max(0, player.TilePoint.Y - 1), 3).Select(y => new Vector2(x, y)))
                .Any(tile => farm.isTileOnMap(tile) && !farm.objects.ContainsKey(tile) && farm.isTilePassable(tile)
                    && new[] { tile + new Vector2(1f, 0f), tile + new Vector2(-1f, 0f), tile + new Vector2(0f, 1f), tile + new Vector2(0f, -1f) }.Any(stance => farm.isTileOnMap(stance) && farm.isTilePassable(stance))));
        if (!targetExists)
            throw new InvalidOperationException("fixture_native_local_wood_fence_target_missing");
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized wood-fence fixture before bridge attachment: item={fenceId}; production alone invokes native placement, consumes one item, and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalPlantSeedFixture(Farmer player, Farm farm)
    {
        // This setup creates only a legal, empty HoeDirt target and a
        // normal seed stack. The typed production action alone
        // consumes the seed, creates the crop, and emits evidence.
        // The event-free template is Spring 1 Year 1, so this must be
        // an in-season seed; canPlantThisSeedHere remains authoritative.
        const string seedId = "(O)472";
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == seedId && item.Stack > 0)
            && player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(seedId, 2)) is not null)
            throw new InvalidOperationException("fixture_native_local_seed_inventory_full");
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == seedId && item.Stack > 0))
            throw new InvalidOperationException("fixture_native_local_seed_missing_after_add");
        GameLocation? seedSetupPreviousLocation = Game1.currentLocation;
        int eligibleDirtCount;
        try
        {
            // Both target-version debug setup and HoeDirt's native
            // season/location predicate are Farm-context operations.
            // Restore the actual player location before bridge attach.
            Game1.currentLocation = farm;
            if (!Game1.game1.parseDebugInput("RemoveDirt", null) || !Game1.game1.parseDebugInput("SpreadDirt", null))
                throw new InvalidOperationException("fixture_native_local_empty_dirt_command_unavailable");
            // The actual Farmer remains in FarmHouse until the
            // separately receipted travel prerequisite. Do not call
            // canPlantThisSeedHere here: target-version evaluates it
            // against the live actor/location. Require only empty
            // native dirt now; the production snapshot and action
            // revalidate plantability after the Farmer reaches Farm.
            eligibleDirtCount = farm.terrainFeatures.Pairs.Count(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt
                && dirt.crop is null
                && !(farm.objects.TryGetValue(pair.Key, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot));
        }
        finally { Game1.currentLocation = seedSetupPreviousLocation; }
        if (eligibleDirtCount == 0)
            throw new InvalidOperationException("fixture_native_local_seed_target_missing");
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized native plant-seed fixture before bridge attachment: seed={seedId}; eligible_empty_dirt_count={eligibleDirtCount}; production alone plants, consumes, creates crop, and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalCropResearchFixture(Farmer player, Farm farm)
    {
        // Ladder 3: Jodi's Request (Spring 19 mail quest) — the player
        // must grow a cauliflower and bring it to her. This fixture
        // reproduces the beginning of that task: the player is inside
        // FarmHouse at Spring start with a Hoe, a filled Watering Can
        // and cauliflower seeds; the Farm has untouched tillable soil.
        // No tilling, planting, watering or harvest happens here — the
        // Agent plans and performs every step through production
        // actions (prepare soil -> plant -> water -> later harvest).
        if (!player.Items.OfType<Hoe>().Any() && player.addItemToInventory(new Hoe()) is not null)
            throw new InvalidOperationException("fixture_native_local_crop_research_hoe_inventory_full");
        if (!player.Items.OfType<Hoe>().Any())
            throw new InvalidOperationException("fixture_native_local_crop_research_hoe_missing_after_add");
        WateringCan? cropResearchCan = player.Items.OfType<WateringCan>().FirstOrDefault(candidate => candidate.WaterLeft > 0);
        if (cropResearchCan is null)
        {
            if (player.addItemToInventory(new WateringCan()) is not null)
                throw new InvalidOperationException("fixture_native_local_crop_research_watering_can_inventory_full");
            cropResearchCan = player.Items.OfType<WateringCan>().FirstOrDefault(candidate => candidate.WaterLeft > 0);
        }
        if (cropResearchCan is null)
            throw new InvalidOperationException("fixture_native_local_crop_research_watering_can_missing_after_add");
        const string cauliflowerSeedId = "(O)474";
        // CRAFTING MATERIALS, because one of the daily tasks is "build a machine and use it".
        //
        // `craft_item` is a real bounded native recipe transaction (no menu, no heldItem - see
        // `farmhandexecutioncontroller.craftingactions.cs:48-58`), so a machine does not have to be placed by the
        // fixture: the companion can make one if it has the ingredients. Stone x20 and copper ore x5 is one Furnace
        // with change, which is the smallest machine that has a visible production step.
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == "(O)390" && item.Stack >= 25)
        && player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>("(O)390", 25)) is not null)
        throw new InvalidOperationException("fixture_native_local_play_session_stone_inventory_full");
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == "(O)378" && item.Stack >= 5)
        && player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>("(O)378", 5)) is not null)
        throw new InvalidOperationException("fixture_native_local_play_session_copper_inventory_full");
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == cauliflowerSeedId && item.Stack > 0)
            && player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(cauliflowerSeedId, 8)) is not null)
            throw new InvalidOperationException("fixture_native_local_crop_research_seed_inventory_full");
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == cauliflowerSeedId && item.Stack > 0))
            throw new InvalidOperationException("fixture_native_local_crop_research_seed_missing_after_add");
        GameLocation? cropResearchPreviousLocation = Game1.currentLocation;
        bool tillableSoilExists;
        try
        {
            // Spring start has natural untilled ground; remove any
            // leftover debug dirt so a genuine till_soil is required.
            Game1.currentLocation = farm;
            if (!Game1.game1.parseDebugInput("RemoveDirt", null))
                throw new InvalidOperationException("fixture_native_local_crop_research_remove_dirt_command_unavailable");
            tillableSoilExists = Enumerable.Range(0, farm.map.Layers[0].LayerWidth)
                .SelectMany(x => Enumerable.Range(0, farm.map.Layers[0].LayerHeight).Select(y => new Vector2(x, y)))
                .Any(tile => farm.GetHoeDirtAtTile(tile) is null
                    && farm.doesTileHaveProperty((int)tile.X, (int)tile.Y, "Diggable", "Back") is not null
                    && !farm.isWaterTile((int)tile.X, (int)tile.Y));
        }
        finally { Game1.currentLocation = cropResearchPreviousLocation; }
        if (!tillableSoilExists)
            throw new InvalidOperationException("fixture_native_local_crop_research_tillable_soil_missing");
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized crop-research (Jodi's Request) fixture before bridge attachment: hoe=true; watering_can_water={cropResearchCan.WaterLeft}; seed={cauliflowerSeedId}; tillable_soil=true; production alone tills, plants, waters and later harvests.", LogLevel.Info);
    }

    private void InitializeNativeLocalFertilizeTileFixture(Farmer player, Farm farm)
    {
        // Supply only the normal fertilizer stack and native, empty
        // HoeDirt. Applying fertilizer remains exclusively production.
        const string fertilizerId = "(O)368";
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == fertilizerId && item.Stack > 0)
            && player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(fertilizerId, 2)) is not null)
            throw new InvalidOperationException("fixture_native_local_fertilizer_inventory_full");
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == fertilizerId && item.Stack > 0))
            throw new InvalidOperationException("fixture_native_local_fertilizer_missing_after_add");
        GameLocation? fertilizerSetupPreviousLocation = Game1.currentLocation;
        int eligibleDirtCount;
        try
        {
            Game1.currentLocation = farm;
            if (!Game1.game1.parseDebugInput("RemoveDirt", null) || !Game1.game1.parseDebugInput("SpreadDirt", null))
                throw new InvalidOperationException("fixture_native_local_fertilizer_dirt_command_unavailable");
            eligibleDirtCount = farm.terrainFeatures.Pairs.Count(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt
                && dirt.crop is null
                && dirt.CanApplyFertilizer(fertilizerId)
                && !(farm.objects.TryGetValue(pair.Key, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot));
        }
        finally { Game1.currentLocation = fertilizerSetupPreviousLocation; }
        if (eligibleDirtCount == 0)
            throw new InvalidOperationException("fixture_native_local_fertilizer_target_missing");
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized native fertilize-tile fixture before bridge attachment: fertilizer={fertilizerId}; eligible_empty_dirt_count={eligibleDirtCount}; production alone applies fertilizer and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalHarvestCropFixture(Farmer player, Farm farm)
    {
        // Target-version commands create a ready ordinary crop only;
        // production alone performs use/harvest and changes inventory.
        GameLocation? harvestSetupPreviousLocation = Game1.currentLocation;
        try
        {
            Game1.currentLocation = farm;
            if (!Game1.game1.parseDebugInput("RemoveDirt", null)
                || !Game1.game1.parseDebugInput("SpreadDirt", null)
            || !Game1.game1.parseDebugInput("SpreadSeeds 472", null)
                || !Game1.game1.parseDebugInput("GrowCrops 6", null))
                throw new InvalidOperationException("fixture_native_local_harvest_crop_setup_unavailable");
        }
        finally { Game1.currentLocation = harvestSetupPreviousLocation; }
        KeyValuePair<Vector2, StardewValley.TerrainFeatures.HoeDirt>? selected = farm.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt
                && dirt.crop is not null
                && !dirt.crop.forageCrop.Value
                && dirt.readyForHarvest()
                && dirt.crop.GetHarvestMethod() == StardewValley.GameData.Crops.HarvestMethod.Grab
                && !string.IsNullOrWhiteSpace(dirt.crop.indexOfHarvest.Value))
            .Select(pair => new KeyValuePair<Vector2, StardewValley.TerrainFeatures.HoeDirt>(pair.Key, (StardewValley.TerrainFeatures.HoeDirt)pair.Value))
            .Cast<KeyValuePair<Vector2, StardewValley.TerrainFeatures.HoeDirt>?>()
            .FirstOrDefault();
        if (selected is null || selected.Value.Value.crop is null)
            throw new InvalidOperationException("fixture_native_local_ready_grab_crop_missing");
        StardewValley.Item harvestItem;
        try { harvestItem = ItemRegistry.Create(selected.Value.Value.crop.indexOfHarvest.Value, 1); }
        catch (Exception) { throw new InvalidOperationException("fixture_native_local_harvest_item_missing"); }
        if (!player.couldInventoryAcceptThisItem(harvestItem))
            throw new InvalidOperationException("fixture_native_local_harvest_inventory_unavailable");
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized native harvest-crop fixture before bridge attachment: selected={selected.Value.Value.crop.netSeedIndex.Value ?? "unknown"}@{(int)selected.Value.Key.X},{(int)selected.Value.Key.Y}; harvest={harvestItem.QualifiedItemId}; ready=true; production alone harvests and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalHarvestCropInventoryFullRecoveryFixture(Farmer player, Farm farm)
    {
        // Lane G container-full recovery precondition. Establishes only the
        // declared Given: one READY ordinary grab-harvest crop on the Farm, a
        // FULL backpack, and one owned ordinary Chest beside that crop. The
        // chain is then driven entirely by production actions
        // (`harvest_crop` rejected/inventory_full -> `chest_store` -> retry
        // `harvest_crop` on the SAME target).
        //
        // Readiness setup uses the same target-version command sequence the
        // shipped harvest fixture uses; the backpack fill is plain inventory
        // placement and never harvests, stores, or emits a receipt.
        GameLocation? fullBagSetupPreviousLocation = Game1.currentLocation;
        try
        {
            Game1.currentLocation = farm;
            if (!Game1.game1.parseDebugInput("RemoveDirt", null)
                || !Game1.game1.parseDebugInput("SpreadDirt", null)
            || !Game1.game1.parseDebugInput("SpreadSeeds 472", null)
                || !Game1.game1.parseDebugInput("GrowCrops 6", null))
                throw new InvalidOperationException("fixture_native_local_harvest_full_bag_setup_unavailable");
        }
        finally { Game1.currentLocation = fullBagSetupPreviousLocation; }

        KeyValuePair<Vector2, StardewValley.TerrainFeatures.HoeDirt>? fullBagSelected = farm.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt
                && dirt.crop is not null
                && !dirt.crop.forageCrop.Value
                && dirt.readyForHarvest()
                && dirt.crop.GetHarvestMethod() == StardewValley.GameData.Crops.HarvestMethod.Grab
                && !string.IsNullOrWhiteSpace(dirt.crop.indexOfHarvest.Value))
            .Select(pair => new KeyValuePair<Vector2, StardewValley.TerrainFeatures.HoeDirt>(pair.Key, (StardewValley.TerrainFeatures.HoeDirt)pair.Value))
            .Cast<KeyValuePair<Vector2, StardewValley.TerrainFeatures.HoeDirt>?>()
            .FirstOrDefault();
        if (fullBagSelected is null || fullBagSelected.Value.Value.crop is null)
            throw new InvalidOperationException("fixture_native_local_ready_grab_crop_missing");
        // Resolve the Farm warp-in the actor will actually use, so the kept crop can be
        // anchored near it rather than at the field's first scan-order tile.
        StardewValley.Warp? fullBagFarmWarp = player.currentLocation is StardewValley.Locations.FarmHouse fullBagFarmHouse
            ? fullBagFarmHouse.warps.FirstOrDefault(warp => !warp.npcOnly.Value
                && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal)
                && warp.TargetX >= 0 && warp.TargetY >= 0)
            : null;
        if (fullBagFarmWarp is null)
            throw new InvalidOperationException("fixture_native_local_harvest_full_bag_farm_warp_missing");
        Vector2 farmArrival = new(fullBagFarmWarp.TargetX, fullBagFarmWarp.TargetY);
        StardewValley.Item fullBagHarvestItem;
        try { fullBagHarvestItem = ItemRegistry.Create(fullBagSelected.Value.Value.crop.indexOfHarvest.Value, 1); }
        catch (Exception) { throw new InvalidOperationException("fixture_native_local_harvest_item_missing"); }

        // Keep exactly ONE ready crop, and keep the one CLOSEST to the farm's
        // FarmHouse warp-in. Scan order picks the top-left tile of a ~1700-crop
        // field, which can sit ~60 tiles from where the actor arrives; the runner's
        // bounded approach search cannot cross that, so it walks the whole map and
        // fails. Anchoring on the arrival neighbourhood makes the single ready crop
        // reachable without a long march, and `harvest_crop` still binds one exact
        // target because the field is reduced to one.
        Vector2 fullBagArrival = farmArrival;
        Vector2 fullBagKeep = fullBagSelected.Value.Key;
        int fullBagBestDistance = int.MaxValue;
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in farm.terrainFeatures.Pairs.ToArray())
        {
            if (pair.Value is not StardewValley.TerrainFeatures.HoeDirt { crop: not null } readyDirt
                || !readyDirt.readyForHarvest()
                || readyDirt.crop.GetHarvestMethod() != StardewValley.GameData.Crops.HarvestMethod.Grab)
                continue;
            int distance = (int)(Math.Abs(pair.Key.X - fullBagArrival.X) + Math.Abs(pair.Key.Y - fullBagArrival.Y));
            if (distance < fullBagBestDistance)
            {
                fullBagBestDistance = distance;
                fullBagKeep = pair.Key;
            }
        }
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in farm.terrainFeatures.Pairs.ToArray())
        {
            if (pair.Key == fullBagKeep) continue;
            if (pair.Value is StardewValley.TerrainFeatures.HoeDirt { crop: not null } otherDirt
                && otherDirt.readyForHarvest()
                && otherDirt.crop.GetHarvestMethod() == StardewValley.GameData.Crops.HarvestMethod.Grab)
                farm.terrainFeatures.Remove(pair.Key);
        }
        fullBagSelected = new KeyValuePair<Vector2, StardewValley.TerrainFeatures.HoeDirt>(
            fullBagKeep, (StardewValley.TerrainFeatures.HoeDirt)farm.terrainFeatures[fullBagKeep]);

        // Fill every backpack slot so the harvest cannot be accepted.
        //
        // The filler must not stack with the harvest item: `couldInventoryAcceptThisItem`
        // accepts if ANY slot can take it, and the parsnip harvest is itself (O)24.
        // Filling with (O)24 would therefore let the harvest stack and destroy the
        // breakpoint. Slot 0 holds one DIFFERENT ordinary object (the item the chain
        // stores, so `chest_store` has an Object to move) and every other slot holds a
        // Tool, which is not an `Object` and so can never stack an Object.
        player.Items.Clear();
        player.Items.Add(ItemRegistry.Create<StardewValley.Object>("(O)390", 1));
        while (player.Items.Count < player.MaxItems)
        {
            Tool fillerTool = player.Items.Count % 2 == 0 ? new Axe() : new Pickaxe();
            player.Items.Add(fillerTool);
        }
        if (Game1.player.couldInventoryAcceptThisItem(fullBagHarvestItem))
            throw new InvalidOperationException("fixture_native_local_harvest_full_bag_inventory_still_accepts");

        (Vector2 TargetTile, Vector2 StandingTile)? fullBagChestSpot = FindNativeLocalHarvestFullBagChestSpot(farm, fullBagSelected.Value.Key);
        if (fullBagChestSpot is null)
            throw new InvalidOperationException("fixture_native_local_harvest_full_bag_chest_target_missing");
        if (farm.objects.ContainsKey(fullBagChestSpot.Value.TargetTile))
            throw new InvalidOperationException("fixture_native_local_harvest_full_bag_chest_occupied");
        StardewValley.Objects.Chest fullBagChest = new(playerChest: true, fullBagChestSpot.Value.TargetTile);
        farm.objects.Add(fullBagChestSpot.Value.TargetTile, fullBagChest);
        if (!farm.objects.TryGetValue(fullBagChestSpot.Value.TargetTile, out StardewValley.Object? fullBagPlaced)
            || fullBagPlaced is not StardewValley.Objects.Chest placedFullBagChest
            || !ReferenceEquals(placedFullBagChest, fullBagChest))
            throw new InvalidOperationException("fixture_native_local_harvest_full_bag_chest_placement_failed");

        // Deliberately NO warp here. The shipped harvest fixture also leaves the
        // actor where the template put it (FarmHouse) and lets the runner travel to
        // the Farm; warping directly onto a crop-adjacent tile can land in a
        // landlocked pocket (measured live: Farm 4,13 rejected every move with
        // no_native_path). Travel and movement stay independently receipted
        // production steps.
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized harvest inventory-full recovery precondition before bridge attachment: crop={fullBagSelected.Value.Key.X},{fullBagSelected.Value.Key.Y}; harvest_item={fullBagHarvestItem.QualifiedItemId}; backpack_full=true; chest={fullBagChest.QualifiedItemId}@{fullBagChestSpot.Value.TargetTile.X},{fullBagChestSpot.Value.TargetTile.Y}; actor=unwarped; production alone travels, rejects, stores, and harvests.", LogLevel.Info);
    }

    private void InitializeNativeLocalClearHoeDirtFixture(Farmer player, Farm farm)
    {
        // Establish only one intact, empty ground HoeDirt and exactly
        // one Basic Pickaxe before bridge attachment. Production alone
        // invokes Pickaxe.DoFunction and proves terrain removal.
        foreach (Item? ownedItem in player.Items.Where(item => item is Pickaxe).ToArray()) player.Items.Remove(ownedItem);
        if (player.addItemToInventory(new Pickaxe()) is not null || player.Items.OfType<Pickaxe>().Count() != 1) throw new InvalidOperationException("fixture_native_local_clear_hoedirt_pickaxe_missing_or_ambiguous");
        // The FarmHouse→Farm native warp arrives at 64,15, but actual
        // map passability/content determines a lawful source and its
        // adjacent standing tile. Positioning is a pre-attachment fact
        // only: production alone hits/removes the HoeDirt, changes no
        // inventory, and emits the authoritative receipt.
        Vector2 fixtureArrival = new(64f, 15f);
        Vector2? dirtTile = FindNativeLocalFarmFixtureTile(farm, fixtureArrival, 12, requireEmptyObjectTile: true,
            extraPredicate: candidate => !farm.terrainFeatures.ContainsKey(candidate) && farm.doesTileHaveProperty((int)candidate.X, (int)candidate.Y, "Diggable", "Back") is not null && !farm.isWaterTile((int)candidate.X, (int)candidate.Y));
        if (dirtTile is null) throw new InvalidOperationException("fixture_native_local_clear_hoedirt_placement_missing");
        Vector2[] standingCandidates = new[]
        {
            dirtTile.Value + new Vector2(-1f, 0f), dirtTile.Value + new Vector2(1f, 0f),
            dirtTile.Value + new Vector2(0f, -1f), dirtTile.Value + new Vector2(0f, 1f),
        };
        Vector2? standingTile = standingCandidates
            .Where(candidate => farm.isTileOnMap(candidate) && farm.isTilePassable(candidate)
                && !farm.IsTileOccupiedBy(candidate, CollisionMask.All, CollisionMask.None, useFarmerTile: false))
            .Cast<Vector2?>()
            .FirstOrDefault();
        if (standingTile is null) throw new InvalidOperationException("fixture_native_local_clear_hoedirt_approach_missing");
        StardewValley.TerrainFeatures.HoeDirt dirt = new();
        farm.terrainFeatures.Add(dirtTile.Value, dirt);
        if (!farm.terrainFeatures.TryGetValue(dirtTile.Value, out StardewValley.TerrainFeatures.TerrainFeature? placedFeature) || !ReferenceEquals(placedFeature, dirt) || dirt.crop is not null || (farm.objects.TryGetValue(dirtTile.Value, out StardewValley.Object? placedObject) && placedObject is StardewValley.Objects.IndoorPot)) throw new InvalidOperationException("fixture_native_local_clear_hoedirt_placement_validation_failed");
        // Complete the normal FarmHouse→Farm warp first. Its later
        // OnWarped continuation validates this exact lawful approach
        // and adjusts only the Player position; it never hits/removes
        // the target, changes inventory, or creates a receipt.
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)standingTile.Value.X, (int)standingTile.Value.Y, false));
        this.nativeLocalClearHoeDirtFixturePending = new NativeLocalClearHoeDirtFixturePending(farm.NameOrUniqueName, dirtTile.Value, standingTile.Value);
    }

    private void InitializeNativeLocalBreakRockSourceFixture(Farmer player, Farm farm)
    {
        foreach (Item? ownedItem in player.Items.Where(item => item is Pickaxe).ToArray()) player.Items.Remove(ownedItem);
        if (player.addItemToInventory(new Pickaxe()) is not null || player.Items.OfType<Pickaxe>().Count() != 1) throw new InvalidOperationException("fixture_native_local_basic_pickaxe_missing_or_ambiguous");
        Vector2? rockTile = FindNativeLocalFarmFixtureTile(farm, new Vector2(64f, 15f), 12, requireEmptyObjectTile: true);
        if (rockTile is null || farm.objects.ContainsKey(rockTile.Value)) throw new InvalidOperationException("fixture_native_local_rock_placement_missing");
        StardewValley.Object rock = ItemRegistry.Create<StardewValley.Object>("(O)2", 1);
        rock.MinutesUntilReady = 1;
        farm.objects.Add(rockTile.Value, rock);
        if (!farm.objects.TryGetValue(rockTile.Value, out StardewValley.Object? placed) || !ReferenceEquals(placed, rock) || placed.QualifiedItemId != "(O)2" || !placed.IsBreakableStone() || placed.MinutesUntilReady != 1) throw new InvalidOperationException("fixture_native_local_rock_placement_validation_failed");
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized break-rock-source precondition before bridge attachment: tile={(int)rockTile.Value.X},{(int)rockTile.Value.Y}; item=(O)2; durability=1; production alone invokes exactly one Pickaxe hit and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalClearDebrisResourceClumpFixture(Farmer player, Farm farm)
    {
        // This narrow pre-attachment recipe mirrors the target-version
        // GameLocation placement lifecycle: it establishes one intact,
        // default-health mine rock. Production alone performs every
        // Pickaxe hit, all health decrements/removal, and its receipt.
        const int debrisParentSheetIndex = 752;
        const int debrisWidth = 2;
        const int debrisHeight = 2;
        const int debrisDefaultHealth = 8;
        foreach (Item? ownedItem in player.Items.Where(item => item is Pickaxe).ToArray())
            player.Items.Remove(ownedItem);
        if (player.addItemToInventory(new Pickaxe()) is not null || player.Items.OfType<Pickaxe>().Count() != 1)
            throw new InvalidOperationException("fixture_native_local_debris_pickaxe_missing_or_ambiguous");
        // The versioned template owns this exact origin and the three
        // reviewed outside interaction anchors in its runner. Never
        // search for a substitute tile: unavailable/occupied fixture
        // geometry blocks the run before bridge attachment.
        Vector2 debrisTile = new(62f, 17f);
        if (!Enumerable.Range(0, debrisWidth).SelectMany(footprintX => Enumerable.Range(0, debrisHeight)
            .Select(footprintY => new Vector2(debrisTile.X + footprintX, debrisTile.Y + footprintY)))
            .All(footprint => farm.CanItemBePlacedHere(footprint, itemIsPassable: false, CollisionMask.All, CollisionMask.None, useFarmerTile: true)))
            throw new InvalidOperationException("fixture_native_local_debris_fixed_placement_unavailable");
        if (farm.resourceClumps.Any(existing => existing.parentSheetIndex.Value == debrisParentSheetIndex))
            throw new InvalidOperationException("fixture_native_local_debris_parent_already_present");
        int clumpsBefore = farm.resourceClumps.Count;
        // addResourceClumpAndRemoveUnderlyingTerrain is the pinned
        // target-version placement API; no direct list insertion or
        // health mutation is permitted in this fixture.
        farm.addResourceClumpAndRemoveUnderlyingTerrain(debrisParentSheetIndex, debrisWidth, debrisHeight, debrisTile);
        if (farm.resourceClumps.Count != clumpsBefore + 1
            || farm.resourceClumps[clumpsBefore] is not StardewValley.TerrainFeatures.ResourceClump clump
            || clump.parentSheetIndex.Value != debrisParentSheetIndex
            || clump.width.Value != debrisWidth || clump.height.Value != debrisHeight
            || clump.Tile != debrisTile || clump.health.Value != debrisDefaultHealth)
            throw new InvalidOperationException("fixture_native_local_debris_placement_validation_failed");
        // The fixture transaction owns the empty template. It does not
        // move the Player, hit a clump, select a tool, emit a receipt,
        // or create a production postcondition.
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized clear-debris precondition before bridge attachment: parent={debrisParentSheetIndex}; tile={(int)debrisTile.X},{(int)debrisTile.Y}; size={debrisWidth}x{debrisHeight}; health={clump.health.Value:0}; pickaxe_upgrade=0; production alone invokes the finite native Pickaxe-hit sequence, removes the clump, and emits receipts.", LogLevel.Info);
    }

    private void InitializeNativeLocalChopTreeSourceFixture(Farmer player, Farm farm)
    {
        foreach (Item? ownedItem in player.Items.Where(item => item is Axe).ToArray())
            player.Items.Remove(ownedItem);
        if (player.addItemToInventory(new Axe()) is not null)
            throw new InvalidOperationException("fixture_native_local_axe_inventory_full");
        if (player.Items.OfType<Axe>().Count() != 1)
            throw new InvalidOperationException("fixture_native_local_axe_missing_or_ambiguous_after_add");
        // The runner requires exactly one fresh full-health tree source
        // after it approaches this setup tile. Exclude every existing
        // tree from the Chebyshev-2 neighborhood: any legal adjacent
        // approach tile then sees only this tree within discovery radius.
        Vector2? treeTile = FindNativeLocalFarmFixtureTile(
            farm,
            new Vector2(64f, 15f),
            12,
            requireEmptyObjectTile: false,
            extraPredicate: candidate => !farm.terrainFeatures.Pairs.Any(pair => pair.Value is StardewValley.TerrainFeatures.Tree
                && Math.Max(Math.Abs(pair.Key.X - candidate.X), Math.Abs(pair.Key.Y - candidate.Y)) <= 2f));
        if (treeTile is null || farm.terrainFeatures.ContainsKey(treeTile.Value))
            throw new InvalidOperationException("fixture_native_local_tree_placement_missing");
        StardewValley.TerrainFeatures.Tree tree = new("1", StardewValley.TerrainFeatures.Tree.treeStage);
        float fixtureHealth = 1f;
        tree.health.Value = fixtureHealth;
        farm.terrainFeatures.Add(treeTile.Value, tree);
        if (!farm.terrainFeatures.TryGetValue(treeTile.Value, out StardewValley.TerrainFeatures.TerrainFeature? placed)
            || !ReferenceEquals(placed, tree) || tree.stump.Value || tree.growthStage.Value < StardewValley.TerrainFeatures.Tree.treeStage
            || tree.hasMoss.Value || tree.tapped.Value || tree.health.Value != fixtureHealth)
            throw new InvalidOperationException("fixture_native_local_tree_placement_validation_failed");
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized chop-tree-source precondition before bridge attachment: tile={(int)treeTile.Value.X},{(int)treeTile.Value.Y}; health={fixtureHealth:0}; moss=false; tapped=false; production alone invokes exactly one Axe hit and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalChopStumpFixture(Farmer player, Farm farm)
    {
        // Pre-attachment fixture only: one target-version Tree stump
        // (stump.Value == true) on an empty Farm tile with a standable
        // neighbor. Production alone swings the Axe and owns all
        // receipt/postcondition evidence. ResourceClump stumps stay
        // exclusively in the clear_debris fixture world.
        StardewValley.TerrainFeatures.Tree stumpTree = new("1", 5);
        stumpTree.stump.Value = true;
        (Vector2 TargetTile, Vector2 StandingTile)? spot = FindNativeLocalTreeStumpFixtureSpot(farm);
        if (spot is null) throw new InvalidOperationException("fixture_native_local_chop_stump_target_missing");
        if (farm.terrainFeatures.ContainsKey(spot.Value.TargetTile))
            throw new InvalidOperationException("fixture_native_local_chop_stump_occupied");
        farm.terrainFeatures.Add(spot.Value.TargetTile, stumpTree);
        if (!farm.terrainFeatures.TryGetValue(spot.Value.TargetTile, out StardewValley.TerrainFeatures.TerrainFeature? placed) || !ReferenceEquals(placed, stumpTree) || !stumpTree.stump.Value)
            throw new InvalidOperationException("fixture_native_local_chop_stump_placement_failed");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized chop-stump precondition before bridge attachment: stump={stumpTree.treeType.Value}; standing={spot.Value.StandingTile.X},{spot.Value.StandingTile.Y}; production alone swings the Axe and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalPlantSaplingFixture(Farmer player, Farm farm)
    {
        // Pre-attachment fixture only: one wild-tree sapling item
        // (Acorn (O)309) in the backpack and a legally plantable Farm
        // tile. Production alone calls Object.placementAction and owns
        // all receipt/postcondition evidence.
        const string saplingId = "(O)309";
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == saplingId && item.Stack > 0)
            && player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(saplingId, 1)) is not null)
            throw new InvalidOperationException("fixture_native_local_plant_sapling_inventory_full");
        if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == saplingId && item.Stack > 0))
            throw new InvalidOperationException("fixture_native_local_plant_sapling_item_missing_after_add");
        (Vector2 TargetTile, Vector2 StandingTile)? spot = FindNativeLocalSaplingFixtureSpot(farm);
        if (spot is null) throw new InvalidOperationException("fixture_native_local_plant_sapling_target_missing");
        if (farm.objects.ContainsKey(spot.Value.TargetTile) || farm.terrainFeatures.ContainsKey(spot.Value.TargetTile))
            throw new InvalidOperationException("fixture_native_local_plant_sapling_occupied");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized plant-sapling precondition before bridge attachment: item={saplingId}; standing={spot.Value.StandingTile.X},{spot.Value.StandingTile.Y}; production alone invokes Object.placementAction and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalCutGrassFixture(Farmer player, Farm farm)
    {
        // Pre-attachment fixture only: one native Grass tuft
        // (TerrainFeature, grassType 1 -> Hay into a silo) on an empty
        // Farm tile with a standable neighbor and a Scythe in the
        // backpack. Production alone invokes Grass.performToolAction
        // and owns all receipt/postcondition evidence.
        const string scytheId = "(W)47";
        (Vector2 TargetTile, Vector2 StandingTile)? spot = FindNativeLocalWeedFixtureSpot(farm);
        if (spot is null) throw new InvalidOperationException("fixture_native_local_cut_grass_target_missing");
        if (farm.terrainFeatures.ContainsKey(spot.Value.TargetTile))
            throw new InvalidOperationException("fixture_native_local_cut_grass_occupied");
        StardewValley.TerrainFeatures.Grass grass = new(1, 4);
        farm.terrainFeatures.Add(spot.Value.TargetTile, grass);
        if (!farm.terrainFeatures.TryGetValue(spot.Value.TargetTile, out StardewValley.TerrainFeatures.TerrainFeature? placedGrass) || !ReferenceEquals(placedGrass, grass))
            throw new InvalidOperationException("fixture_native_local_cut_grass_placement_failed");
        if (!player.Items.OfType<StardewValley.Tool>().Any(tool => tool.QualifiedItemId == scytheId)
            && player.addItemToInventory(ItemRegistry.Create(scytheId, 1)) is not null)
            throw new InvalidOperationException("fixture_native_local_cut_grass_scythe_inventory_full");
        if (!player.Items.OfType<StardewValley.Tool>().Any(tool => tool.QualifiedItemId == scytheId))
            throw new InvalidOperationException("fixture_native_local_cut_grass_scythe_missing_after_add");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized cut-grass precondition before bridge attachment: grass=grassType1; scythe={scytheId}; standing={spot.Value.StandingTile.X},{spot.Value.StandingTile.Y}; production alone invokes Grass.performToolAction and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalCutWeedsFixture(Farmer player, Farm farm)
    {
        // Pre-attachment fixture only: one native Weed object on an
        // empty Farm tile (standable neighbor) and a Scythe in the
        // backpack. Production alone invokes Object.performToolAction
        // and owns all receipt/postcondition evidence.
        const string scytheId = "(W)47";
        (Vector2 TargetTile, Vector2 StandingTile)? spot = FindNativeLocalWeedFixtureSpot(farm);
        if (spot is null) throw new InvalidOperationException("fixture_native_local_cut_weeds_target_missing");
        if (farm.objects.ContainsKey(spot.Value.TargetTile))
            throw new InvalidOperationException("fixture_native_local_cut_weeds_occupied");
        StardewValley.Object weed = ItemRegistry.Create<StardewValley.Object>("(O)313", 1);
        if (!weed.IsWeeds())
            throw new InvalidOperationException("fixture_native_local_cut_weeds_not_weed");
        farm.objects.Add(spot.Value.TargetTile, weed);
        if (!farm.objects.TryGetValue(spot.Value.TargetTile, out StardewValley.Object? placedWeed) || !ReferenceEquals(placedWeed, weed) || !placedWeed.IsWeeds())
            throw new InvalidOperationException("fixture_native_local_cut_weeds_placement_failed");
        if (!player.Items.OfType<StardewValley.Tool>().Any(tool => tool.QualifiedItemId == scytheId)
            && player.addItemToInventory(ItemRegistry.Create(scytheId, 1)) is not null)
            throw new InvalidOperationException("fixture_native_local_cut_weeds_scythe_inventory_full");
        if (!player.Items.OfType<StardewValley.Tool>().Any(tool => tool.QualifiedItemId == scytheId))
            throw new InvalidOperationException("fixture_native_local_cut_weeds_scythe_missing_after_add");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized cut-weeds precondition before bridge attachment: weed=(O)313; scythe={scytheId}; standing={spot.Value.StandingTile.X},{spot.Value.StandingTile.Y}; production alone invokes Object.performToolAction and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalScytheCropFixture(Farmer player, Farm farm)
    {
        // Pre-attachment fixture only: one ready Scythe-method crop
        // (wheat (O)483 -> harvest (O)271) on native HoeDirt and a
        // Scythe in the backpack. Production alone invokes
        // HoeDirt.performToolAction and owns all receipt/postcondition
        // evidence. growCompletely() sets currentPhase to the last
        // phase but does NOT set fullyGrown for seeds that do not
        // regrow; readyForHarvest() additionally requires dayOfCurrent
        // Phase <= 0 only when fullyGrown, and currentPhase >= last.
        const string scytheId = "(W)47";
        (Vector2 TargetTile, Vector2 StandingTile)? spot = FindNativeLocalScytheCropFixtureSpot(farm);
        if (spot is null) throw new InvalidOperationException("fixture_native_local_scythe_crop_target_missing");
        StardewValley.TerrainFeatures.HoeDirt dirt = farm.terrainFeatures.TryGetValue(spot.Value.TargetTile, out var maybeDirt)
            ? (StardewValley.TerrainFeatures.HoeDirt)maybeDirt!
            : new StardewValley.TerrainFeatures.HoeDirt();
        if (!farm.terrainFeatures.ContainsKey(spot.Value.TargetTile))
        {
            farm.terrainFeatures.Add(spot.Value.TargetTile, dirt);
        }
        StardewValley.Crop wheat = new("483", (int)spot.Value.TargetTile.X, (int)spot.Value.TargetTile.Y, farm);
        dirt.crop = wheat;
        wheat.growCompletely();
        // dayOfCurrentPhase is 0 after growCompletely, but
        // readyForHarvest requires crop.currentPhase >= phaseDays-1;
        // force the last-phase marker explicitly and re-check.
        wheat.currentPhase.Value = wheat.phaseDays.Count - 1;
        wheat.dayOfCurrentPhase.Value = 0;
        if (!dirt.readyForHarvest() || dirt.crop.GetHarvestMethod() != StardewValley.GameData.Crops.HarvestMethod.Scythe)
            throw new InvalidOperationException("fixture_native_local_scythe_crop_not_ready");
        if (!player.Items.OfType<StardewValley.Tool>().Any(tool => tool.QualifiedItemId == scytheId)
            && player.addItemToInventory(ItemRegistry.Create(scytheId, 1)) is not null)
            throw new InvalidOperationException("fixture_native_local_scythe_crop_scythe_inventory_full");
        if (!player.Items.OfType<StardewValley.Tool>().Any(tool => tool.QualifiedItemId == scytheId))
            throw new InvalidOperationException("fixture_native_local_scythe_crop_scythe_missing_after_add");
        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)spot.Value.StandingTile.X, (int)spot.Value.StandingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized scythe-crop precondition before bridge attachment: crop=wheat; scythe={scytheId}; standing={spot.Value.StandingTile.X},{spot.Value.StandingTile.Y}; production alone invokes HoeDirt.performToolAction and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalRefillWateringCanFixture(Farmer player)
    {
        // This fixture establishes only a single ordinary, partially
        // filled can and a disposable-working-save map precondition.
        // The pinned GameLocation predicate accepts a Back-layer
        // WaterSource property, so mark the local player's current
        // FarmHouse tile and verify that predicate before attachment.
        // This never invokes the watering can or creates a receipt.
        if (player.currentLocation is not StardewValley.Locations.FarmHouse farmHouse)
            throw new InvalidOperationException("fixture_native_local_refill_farmhouse_missing");
        foreach (Item? ownedItem in player.Items.Where(item => item is WateringCan).ToArray())
            player.Items.Remove(ownedItem);
        WateringCan suppliedCan = new();
        suppliedCan.WaterLeft = Math.Max(1, suppliedCan.waterCanMax - 1);
        if (player.addItemToInventory(suppliedCan) is not null || player.Items.OfType<WateringCan>().Count() != 1)
            throw new InvalidOperationException("fixture_native_local_refill_watering_can_missing_or_ambiguous");
        Point sourceTile = player.TilePoint;
        xTile.Layers.Layer? backLayer = farmHouse.map.GetLayer("Back");
        if (backLayer is null || sourceTile.X < 0 || sourceTile.Y < 0 || sourceTile.X >= backLayer.LayerWidth || sourceTile.Y >= backLayer.LayerHeight || backLayer.Tiles[sourceTile.X, sourceTile.Y] is null)
            throw new InvalidOperationException("fixture_native_local_refill_source_tile_unavailable");
        backLayer.Tiles[sourceTile.X, sourceTile.Y].Properties["WaterSource"] = "GameBuddyNativeLocalFixture";
        if (!string.Equals(farmHouse.doesTileHaveProperty(sourceTile.X, sourceTile.Y, "WaterSource", "Back"), "GameBuddyNativeLocalFixture", StringComparison.Ordinal)
            || !farmHouse.CanRefillWateringCanOnTile(sourceTile.X, sourceTile.Y))
            throw new InvalidOperationException("fixture_native_local_refill_source_creation_failed");
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized refill-watering-can precondition before bridge attachment: water={suppliedCan.WaterLeft}; max={suppliedCan.waterCanMax}; fixture_farmhouse_water_source={sourceTile.X},{sourceTile.Y}; production alone refills and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalWaterCropEmptyCanRecoveryFixture(Farmer player, Farm farm)
    {
        // Lane G resource-depletion recovery precondition. Establishes
        // only the declared Given: dry unwatered crops on the Farm, exactly
        // ONE EMPTY Watering Can, and a reachable native refill tile. The
        // chain itself is driven entirely by production actions
        // (`equip_tool` -> `water_crop` rejected/watering_can_empty ->
        // `refill_watering_can` -> `water_crop` on the same target).
        //
        // The water source is created with the SAME target-version
        // technique the shipped `native_refill_watering_can_v1` fixture
        // uses: write the Back-layer `WaterSource` property on a tile and
        // let the verified `GameLocation.CanRefillWateringCanOnTile`
        // predicate accept it. It is placed on the FARM (not the
        // FarmHouse) so the whole chain stays in one location with the
        // crops: `water_crop` needs the actor beside a HoeDirt crop, and
        // `refill_watering_can` needs the actor beside the source tile, so
        // splitting them across two maps would add a travel leg that this
        // chain is not meant to exercise. No save XML is edited.
        WateringCan suppliedEmptyCan = SupplyExactlyOneEmptyWateringCan(player);
        Vector2 onlyCropTile = SpreadExactlyOneDryCropOnTheFarm(farm);
        Vector2 sourceTile = ClaimWaterSourceBeside(farm, onlyCropTile);
        int dryCropCount = CountDryCrops(farm);

        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)sourceTile.X, (int)sourceTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized water-crop empty-can recovery precondition before bridge attachment: can_water=0; can_max={suppliedEmptyCan.waterCanMax}; unwatered_crop_count={dryCropCount}; farm_water_source={(int)sourceTile.X},{(int)sourceTile.Y}; production alone equips, rejects, refills, and waters.", LogLevel.Info);
    }

    /// <summary>
    /// The can half of the empty-can recovery Given: exactly one Watering Can, empty. Every other can is removed first, so
    /// `equip_tool` cannot pick a full one and make the rejection under test impossible.
    /// </summary>
    private WateringCan SupplyExactlyOneEmptyWateringCan(Farmer player)
    {
        foreach (Item? ownedCan in player.Items.Where(item => item is WateringCan).ToArray())
            player.Items.Remove(ownedCan);
        WateringCan emptyCan = new()
        {
            WaterLeft = 0,
        };
        if (player.addItemToInventory(emptyCan) is not null)
            throw new InvalidOperationException("fixture_native_local_water_crop_empty_can_inventory_full");
        WateringCan? suppliedEmptyCan = player.Items.OfType<WateringCan>().FirstOrDefault();
        if (suppliedEmptyCan is null || suppliedEmptyCan.WaterLeft != 0)
            throw new InvalidOperationException("fixture_native_local_water_crop_empty_can_missing");
        if (player.Items.OfType<WateringCan>().Count() != 1)
            throw new InvalidOperationException("fixture_native_local_water_crop_empty_can_ambiguous");
        return suppliedEmptyCan;
    }

    /// <summary>
    /// The crop half: one dry unwatered crop on native HoeDirt, and the tile it stands on. SpreadDirt+SpreadSeeds fills the
    /// whole farm (~1700 crops), so the rest are removed - `water_crop` binds the single adjacent unwatered crop, and
    /// standing inside a dense field makes that binding ambiguous. This is fixture-only world setup (the same class as the
    /// shipped SpreadDirt/SetupBigFarm initializers), never an action call.
    /// </summary>
    private Vector2 SpreadExactlyOneDryCropOnTheFarm(Farm farm)
    {
        GameLocation? emptyCanSetupPreviousLocation = Game1.currentLocation;
        try
        {
            Game1.currentLocation = farm;
            if (!Game1.game1.parseDebugInput("SpreadDirt", null))
                throw new InvalidOperationException("fixture_native_spread_dirt_command_unavailable");
            if (!Game1.game1.parseDebugInput("SpreadSeeds 472", null))
                throw new InvalidOperationException("fixture_native_spread_seeds_command_unavailable");
        }
        finally { Game1.currentLocation = emptyCanSetupPreviousLocation; }

        if (CountDryCrops(farm) == 0)
            throw new InvalidOperationException("fixture_native_local_water_crop_empty_can_unwatered_crop_missing");
        Vector2? keptCrop = null;
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in farm.terrainFeatures.Pairs.ToArray())
        {
            if (pair.Value is not StardewValley.TerrainFeatures.HoeDirt { crop: not null } dryDirt
                || !dryDirt.needsWatering() || dryDirt.isWatered())
                continue;
            if (keptCrop is null)
            {
                keptCrop = pair.Key;
                continue;
            }
            farm.terrainFeatures.Remove(pair.Key);
        }
        if (keptCrop is null)
            throw new InvalidOperationException("fixture_native_local_water_crop_empty_can_unwatered_crop_missing");
        if (CountDryCrops(farm) != 1)
            throw new InvalidOperationException("fixture_native_local_water_crop_empty_can_crop_count_unexpected");
        return keptCrop.Value;
    }

    private void InitializeNativeLocalWaterCropFixture(Farmer player, Farm farm)
    {
        WateringCan? availableCan = player.Items.OfType<WateringCan>().FirstOrDefault(candidate => candidate.WaterLeft > 0);
        if (availableCan is null)
        {
            WateringCan suppliedCan = new();
            if (player.addItemToInventory(suppliedCan) is not null)
                throw new InvalidOperationException("fixture_native_local_watering_can_inventory_full");
            availableCan = player.Items.OfType<WateringCan>().FirstOrDefault(candidate => candidate.WaterLeft > 0);
        }
        if (availableCan is null)
            throw new InvalidOperationException("fixture_native_local_watering_can_missing_after_add");
        GameLocation? cropSetupPreviousLocation = Game1.currentLocation;
        try
        {
            Game1.currentLocation = farm;
            // Target-version SpreadSeeds populates only existing HoeDirt.
            // The event-free native-local template starts without dirt, so
            // establish empty native dirt before spreading the dry crop.
            if (!Game1.game1.parseDebugInput("SpreadDirt", null))
                throw new InvalidOperationException("fixture_native_spread_dirt_command_unavailable");
            if (!Game1.game1.parseDebugInput("SpreadSeeds 472", null))
                throw new InvalidOperationException("fixture_native_spread_seeds_command_unavailable");
        }
        finally { Game1.currentLocation = cropSetupPreviousLocation; }
        int dryCropCount = farm.terrainFeatures.Pairs.Count(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt { crop: not null } dirt
            && dirt.needsWatering() && !dirt.isWatered());
        if (dryCropCount == 0)
            throw new InvalidOperationException("fixture_native_local_unwatered_crop_missing");
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized native water-crop fixture before bridge attachment: watering_can_water={availableCan.WaterLeft}; unwatered_crop_count={dryCropCount}; production alone waters and emits receipt.", LogLevel.Info);
    }
}
