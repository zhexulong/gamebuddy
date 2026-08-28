using System.Globalization;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;
using StardewValley.Characters;

namespace GameBuddy.Stardew;

// Native handler bodies remain action/family-owned. All parts share the one
// FarmhandExecutionController game-thread ledger, receipt store, snapshot, and cancel state.
internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalRefillWateringCan(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Context.IsMultiplayer || !Game1.IsMasterGame || Game1.server is not null || Game1.player is null || Game1.getAllFarmers().Count() != 1 || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "native_local_player_required", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", null);
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not WateringCan wateringCan || !ReferenceEquals(Game1.player.CurrentTool, wateringCan))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "watering_can_not_equipped_in_requested_slot", $"slot={slot}");
        if (wateringCan.IsBottomless || wateringCan.WaterLeft >= wateringCan.waterCanMax)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "watering_can_not_refillable", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        if (!location.CanRefillWateringCanOnTile(targetX, targetY) || !string.Equals(BuildRefillWateringCanTargetId(location, targetX, targetY), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "refill_target_changed", $"target={targetX},{targetY}");
        int before = wateringCan.WaterLeft;
        int max = wateringCan.waterCanMax;
        wateringCan.DoFunction(location, targetX * 64 + 32, targetY * 64 + 32, 0, Game1.player);
        int after = wateringCan.WaterLeft;
        bool succeeded = ReferenceEquals(Game1.player.Items[slot], wateringCan) && before < max && after == max;
        string evidence = $"target={expectedTargetId};slot={slot};can={wateringCan.QualifiedItemId};water_before={before};water_after={after};water_max={max}";
        return this.RememberTerminal(requestId, executionId, succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain, succeeded ? "watering_can_refilled" : "watering_can_refill_postcondition_unavailable", evidence);
    }

    public LocalExecutionReceipt RequestLocalWaterCrop(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!IsCropTargetInRange(Game1.player, targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
            || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
            || dirt.crop is null
            || !dirt.needsWatering()
            || dirt.isWatered())
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "crop_target_unavailable", $"target={targetX},{targetY}");
        if (!string.Equals(BuildCropTargetId(location, targetX, targetY, dirt.crop.netSeedIndex.Value, dirt.crop.indexOfHarvest.Value), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "crop_target_changed", $"target={targetX},{targetY}");
        if (Game1.player.CurrentTool is not WateringCan wateringCan)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "watering_can_not_equipped", null);
        if (wateringCan.WaterLeft <= 0 && !Game1.player.hasWateringCanEnchantment)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "watering_can_empty", null);

        LocalCropWateringSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId, dirt.crop.netSeedIndex.Value ?? dirt.crop.indexOfHarvest.Value ?? "unknown", this.revision, requestedDeadlineMs);
        bool beforeWatered = dirt.isWatered();
        int beforeWater = wateringCan.WaterLeft;
        wateringCan.DoFunction(location, targetX * 64 + 32, targetY * 64 + 32, 0, Game1.player);
        bool afterWatered = dirt.isWatered();
        bool waterConsumed = wateringCan.IsBottomless || wateringCan.WaterLeft < beforeWater || Game1.player.hasWateringCanEnchantment;
        ExecutionState state = !beforeWatered && afterWatered ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = state == ExecutionState.Succeeded ? "crop_watered" : "crop_water_postcondition_unavailable";
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision,
            $"location={specification.Location};target={expectedTargetId};tile={targetX},{targetY};before_watered={beforeWatered.ToString().ToLowerInvariant()};after_watered={afterWatered.ToString().ToLowerInvariant()};water_before={beforeWater};water_after={wateringCan.WaterLeft};water_consumed={waterConsumed.ToString().ToLowerInvariant()}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    /// <summary>Native crop harvest limited to ready, ordinary Grab crops.</summary>
    public LocalExecutionReceipt RequestLocalHarvestCrop(string requestId, int targetX, int targetY, string expectedQualifiedHarvestItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!IsCropTargetInRange(Game1.player, targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
            || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
            || dirt.crop is null
            || dirt.crop.forageCrop.Value
            || !dirt.readyForHarvest()
            || dirt.crop.GetHarvestMethod() != StardewValley.GameData.Crops.HarvestMethod.Grab
            || !string.Equals(BuildCropTargetId(location, targetX, targetY, dirt.crop.netSeedIndex.Value, dirt.crop.indexOfHarvest.Value), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "harvest_target_unavailable", $"target={targetX},{targetY}");

        StardewValley.Crop crop = dirt.crop;
        // HoeDirt.performUseAction promotes a Golden Scythe to a scythe
        // harvest even for a crop whose data says Grab. This narrow action
        // exposes only the ordinary native Grab path, so reject that override.
        if (Game1.player.CurrentTool is StardewValley.Tool selectedTool
            && selectedTool.isScythe()
            && string.Equals(selectedTool.ItemId, "66", StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "golden_scythe_grab_override", null);

        StardewValley.Item harvestItem;
        try
        {
            harvestItem = StardewValley.ItemRegistry.Create(crop.indexOfHarvest.Value, 1);
        }
        catch (Exception)
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "harvest_item_unavailable", $"target={targetX},{targetY}");
        }
        if (!string.Equals(harvestItem.QualifiedItemId, expectedQualifiedHarvestItemId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "harvest_target_changed", $"target={targetX},{targetY}");
        if (!Game1.player.couldInventoryAcceptThisItem(harvestItem))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", $"item={expectedQualifiedHarvestItemId}");

        bool regrowsAfterHarvest = crop.RegrowsAfterHarvest();
        string cropId = crop.netSeedIndex.Value ?? crop.indexOfHarvest.Value ?? "unknown";
        int inventoryBefore = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedHarvestItemId ? item.Stack : 0);
        int phaseBefore = crop.currentPhase.Value;
        int dayOfPhaseBefore = crop.dayOfCurrentPhase.Value;
        LocalCropHarvestingSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId, cropId, expectedQualifiedHarvestItemId, regrowsAfterHarvest, this.revision, requestedDeadlineMs);
        // HoeDirt.performUseAction is the target-version native grab-harvest
        // route. It dispatches Crop.harvest and, only when that native method
        // says the crop is non-regrowing, invokes native destroyCrop itself.
        // Do not reproduce either inventory or terrain mutation here.
        // This outer native wrapper returns true only when it destroyed a
        // non-regrowing crop. A successful regrow harvest deliberately falls
        // through to its pre-harvest readiness result (normally false), so its
        // receipt must rely on the separate inventory and phase postconditions.
        bool nativePathReturn = dirt.performUseAction(tile);

        int inventoryAfter = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedHarvestItemId ? item.Stack : 0);
        bool inventoryGained = inventoryAfter > inventoryBefore;
        bool cropStillPresent = location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? afterFeature)
            && afterFeature is StardewValley.TerrainFeatures.HoeDirt afterDirt
            && afterDirt.crop is not null;
        StardewValley.Crop? cropAfter = cropStillPresent
            ? ((StardewValley.TerrainFeatures.HoeDirt)afterFeature!).crop
            : null;
        bool regrowAdvanced = regrowsAfterHarvest && cropAfter is not null
            && cropAfter.dayOfCurrentPhase.Value > dayOfPhaseBefore
            && cropAfter.currentPhase.Value >= phaseBefore;
        bool cropPostcondition = regrowsAfterHarvest ? cropStillPresent && regrowAdvanced : !cropStillPresent;
        bool nativeAccepted = inventoryGained && cropPostcondition && (regrowsAfterHarvest || nativePathReturn);
        ExecutionState state = nativeAccepted ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = state == ExecutionState.Succeeded ? "crop_harvested" : "crop_harvest_postcondition_unavailable";
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision,
            $"location={specification.Location};target={expectedTargetId};tile={targetX},{targetY};crop={cropId};item={expectedQualifiedHarvestItemId};native_path_return={nativePathReturn.ToString().ToLowerInvariant()};native_accepted={nativeAccepted.ToString().ToLowerInvariant()};regrows={regrowsAfterHarvest.ToString().ToLowerInvariant()};phase_before={phaseBefore};phase_after={cropAfter?.currentPhase.Value.ToString() ?? "none"};day_of_phase_before={dayOfPhaseBefore};day_of_phase_after={cropAfter?.dayOfCurrentPhase.Value.ToString() ?? "none"};regrow_advanced={regrowAdvanced.ToString().ToLowerInvariant()};inventory_before={inventoryBefore};inventory_after={inventoryAfter};inventory_gained={inventoryGained.ToString().ToLowerInvariant()};crop_present_after={cropStillPresent.ToString().ToLowerInvariant()}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    public LocalExecutionReceipt RequestLocalPlantSeed(string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!IsCropTargetInRange(Game1.player, targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object seed || seed.Category != StardewValley.Object.SeedsCategory)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "seed_not_owned_in_slot", $"slot={slot}");
        if (!string.Equals(seed.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "seed_slot_changed", $"slot={slot}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
            || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
            || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot)
            || dirt.crop is not null
            || !dirt.canPlantThisSeedHere(seed.ItemId, isFertilizer: false)
            || !string.Equals(BuildSeedTargetId(location, slot, targetX, targetY, seed.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "seed_target_unavailable", $"target={targetX},{targetY}");

        int beforeCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        int previousSlot = Game1.player.CurrentToolIndex;
        LocalSeedPlantingSpec specification = new(executionId, requestId, location.NameOrUniqueName, slot, targetX, targetY, expectedTargetId, expectedQualifiedItemId, this.revision, requestedDeadlineMs);
        bool placementHandled;
        try
        {
            Game1.player.CurrentToolIndex = slot;
            placementHandled = seed.placementAction(location, targetX * 64 + 32, targetY * 64 + 32, Game1.player);
            if (placementHandled)
                Game1.player.reduceActiveItemByOne();
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }

        StardewValley.TerrainFeatures.HoeDirt? plantedDirt = location.GetHoeDirtAtTile(tile);
        string? plantedCropId = plantedDirt?.crop?.netSeedIndex.Value ?? plantedDirt?.crop?.indexOfHarvest.Value;
        int afterCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        bool cropCreated = plantedDirt?.crop is not null && !string.IsNullOrWhiteSpace(plantedCropId);
        bool inventoryDecremented = afterCount == beforeCount - 1;
        ExecutionState state = placementHandled && cropCreated && inventoryDecremented ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = state == ExecutionState.Succeeded ? "seed_planted" : "seed_plant_postcondition_unavailable";
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision,
            $"location={specification.Location};target={expectedTargetId};tile={targetX},{targetY};item={expectedQualifiedItemId};crop={plantedCropId ?? "none"};inventory_before={beforeCount};inventory_after={afterCount}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    public LocalExecutionReceipt RequestLocalPlaceWoodFence(string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is not Farm farm)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "farm_required", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId ?? this.activeItemPickup?.ExecutionId);
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (expectedQualifiedItemId != "(O)322")
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "unsupported_fence_item", $"item={expectedQualifiedItemId}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object source || !IsQualifiedWoodFenceSource(source) || source.Stack <= 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "wood_fence_not_owned_in_slot", $"slot={slot}");

        Vector2 tile = new(targetX, targetY);
        if (!string.Equals(BuildWoodFenceTargetId(farm, slot, targetX, targetY), expectedTargetId, StringComparison.Ordinal)
            || farm.objects.ContainsKey(tile)
            || !Utility.playerCanPlaceItemHere(farm, source, targetX * 64 + 32, targetY * 64 + 32, Game1.player)
            || !source.canBePlacedHere(farm, tile))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "wood_fence_target_unavailable", $"target={targetX},{targetY}");

        int beforeCount = CountQualifiedItem(Game1.player, "(O)322");
        bool sourceEmptyBefore = !farm.objects.ContainsKey(tile);
        int previousSlot = Game1.player.CurrentToolIndex;
        LocalWoodFencePlacementSpec specification = new(executionId, requestId, farm.NameOrUniqueName, slot, targetX, targetY, expectedTargetId, "(O)322", beforeCount, this.revision, requestedDeadlineMs);
        bool placementHandled;
        try
        {
            Game1.player.CurrentToolIndex = slot;
            // Target 1.6.15's Object.placementAction has the closed IsFenceItem branch
            // that constructs Fence for this exact source. This private wrapper is not a
            // generic item-action surface: it rechecks the finite (O)322 Fence source.
            placementHandled = PlaceQualifiedWoodFenceNative(farm, targetX, targetY, source, Game1.player);
            if (placementHandled)
                Game1.player.reduceActiveItemByOne();
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }

        bool isFence = farm.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Fence;
        StardewValley.Fence? fence = placed as StardewValley.Fence;
        bool isGate = fence?.isGate.Value ?? true;
        float health = fence?.health.Value ?? 0f;
        float maxHealth = fence?.maxHealth.Value ?? 0f;
        int afterCount = CountQualifiedItem(Game1.player, "(O)322");
        bool inventoryDecremented = afterCount == beforeCount - 1;
        bool validFenceHealth = float.IsFinite(health) && float.IsFinite(maxHealth) && health > 0f && maxHealth >= health;
        bool succeeded = placementHandled && sourceEmptyBefore && isFence && !isGate && validFenceHealth && inventoryDecremented;
        ExecutionState state = succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = succeeded ? "wood_fence_placed" : "wood_fence_postcondition_unavailable";
        if (succeeded)
        {
            this.woodFenceResultTarget = new BridgeWoodFenceResultTarget(expectedTargetId, specification.Location, slot, targetX, targetY, "(O)322", IsFence: true, IsGate: false, health, maxHealth);
            this.woodFenceResultExecutionId = executionId;
            this.woodFenceResultRequestId = requestId;
            this.woodFenceResultRevision = this.revision;
            this.woodFenceResultDay = Game1.Date.TotalDays;
        }
        string evidence = $"source=(O)322;location={specification.Location};x={targetX};y={targetY};target={expectedTargetId};item=(O)322;slot={slot};source_empty_before={sourceEmptyBefore.ToString().ToLowerInvariant()};is_fence={isFence.ToString().ToLowerInvariant()};is_gate={isGate.ToString().ToLowerInvariant()};health={health.ToString(CultureInfo.InvariantCulture)};max_health={maxHealth.ToString(CultureInfo.InvariantCulture)};inventory_before={beforeCount};inventory_after={afterCount}";
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision, evidence);
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    public LocalExecutionReceipt RequestLocalPlaceCrabPot(string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is not Farm farm)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "farm_required", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId ?? this.activeItemPickup?.ExecutionId);
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (expectedQualifiedItemId != "(O)710")
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "unsupported_crab_pot_item", $"item={expectedQualifiedItemId}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object source || source.QualifiedItemId != "(O)710" || source.Stack <= 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "crab_pot_not_owned_in_slot", $"slot={slot}");

        Vector2 tile = new(targetX, targetY);
        if (!string.Equals(BuildCrabPotTargetId(farm, slot, targetX, targetY), expectedTargetId, StringComparison.Ordinal)
            || !StardewValley.Objects.CrabPot.IsValidCrabPotLocationTile(farm, targetX, targetY)
            || farm.objects.ContainsKey(tile))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "crab_pot_target_unavailable", $"target={targetX},{targetY}");

        int beforeCount = CountQualifiedItem(Game1.player, "(O)710");
        int previousSlot = Game1.player.CurrentToolIndex;
        LocalCrabPotPlacementSpec specification = new(executionId, requestId, farm.NameOrUniqueName, slot, targetX, targetY, expectedTargetId, "(O)710", beforeCount, this.revision, requestedDeadlineMs);
        bool placementHandled;
        try
        {
            Game1.player.CurrentToolIndex = slot;
            placementHandled = source.placementAction(farm, targetX * 64 + 32, targetY * 64 + 32, Game1.player);
            if (placementHandled)
                Game1.player.reduceActiveItemByOne();
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }

        StardewValley.Object? placed = farm.objects.TryGetValue(tile, out StardewValley.Object? candidate) ? candidate : null;
        StardewValley.Objects.CrabPot? crabPot = placed as StardewValley.Objects.CrabPot;
        int afterCount = CountQualifiedItem(Game1.player, "(O)710");
        // Native CrabPot.updateOffset legitimately leaves directionOffset at
        // Vector2.Zero for an all-water neighborhood. Finiteness, ownership,
        // and target-bound overlay facts are the observable placement contract;
        // nonzero offset is not a source-proven universal postcondition.
        bool validOffset = crabPot is not null && float.IsFinite(crabPot.directionOffset.Value.X) && float.IsFinite(crabPot.directionOffset.Value.Y);
        IReadOnlyList<BridgeCrabPotOverlayTile> overlayTiles = crabPot is null
            ? Array.Empty<BridgeCrabPotOverlayTile>()
            : BuildCrabPotOverlayFacts(crabPot);
        bool succeeded = placementHandled && crabPot is not null && crabPot.QualifiedItemId == "(O)710"
            && crabPot.owner.Value == Game1.player.UniqueMultiplayerID && validOffset && afterCount == beforeCount - 1;
        ExecutionState state = succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = succeeded ? "crab_pot_placed" : "crab_pot_postcondition_unavailable";
        if (succeeded)
        {
            this.crabPotResultTarget = new BridgeCrabPotResultTarget(expectedTargetId, specification.Location, slot, targetX, targetY, "(O)710", crabPot!.owner.Value, crabPot.directionOffset.Value.X, crabPot.directionOffset.Value.Y, overlayTiles);
            this.crabPotResultExecutionId = executionId;
            this.crabPotResultRequestId = requestId;
            this.crabPotResultRevision = this.revision;
            this.crabPotResultDay = Game1.Date.TotalDays;
        }
        string evidence = $"source=(O)710;location={specification.Location};x={targetX};y={targetY};target={expectedTargetId};item=(O)710;slot={slot};source_empty_before=true;is_crab_pot={(crabPot is not null).ToString().ToLowerInvariant()};owner={crabPot?.owner.Value ?? 0};offset_x={crabPot?.directionOffset.Value.X.ToString(CultureInfo.InvariantCulture) ?? "none"};offset_y={crabPot?.directionOffset.Value.Y.ToString(CultureInfo.InvariantCulture) ?? "none"};overlay_tiles={string.Join("|", overlayTiles.Select(tile => $"{tile.X},{tile.Y}:{tile.Count}"))};inventory_before={beforeCount};inventory_after={afterCount}";
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision, evidence);
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    public LocalExecutionReceipt RequestLocalBaitCrabPot(string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player?.currentLocation is null) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.controller.HasActiveExecution) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", null);
        Farmer player = Game1.player;
        if (!IsTileWithinChebyshevRadius(player, targetX, targetY, 1)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (expectedQualifiedItemId != "(O)685") return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "unsupported_bait_item", $"item={expectedQualifiedItemId}");
        if (slot < 0 || slot >= player.Items.Count || player.Items[slot] is not StardewValley.Object bait || bait.QualifiedItemId != "(O)685" || bait.Stack <= 0) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "bait_not_owned_in_slot", $"slot={slot}");
        GameLocation location = player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? placed) || placed is not StardewValley.Objects.CrabPot crabPot || crabPot.QualifiedItemId != "(O)710" || crabPot.owner.Value != player.UniqueMultiplayerID || crabPot.bait.Value is not null || !string.Equals(BuildBaitCrabPotTargetId(location, slot, targetX, targetY), expectedTargetId, StringComparison.Ordinal)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "bait_crab_pot_target_unavailable", $"target={targetX},{targetY}");
        int beforeCount = CountQualifiedItem(player, "(O)685");
        int previousSlot = player.CurrentToolIndex;
        bool handled;
        try { player.CurrentToolIndex = slot; handled = location.checkAction(new xTile.Dimensions.Location(targetX, targetY), Game1.viewport, player); }
        finally { player.CurrentToolIndex = previousSlot; }
        int afterCount = CountQualifiedItem(player, "(O)685");
        bool succeeded = handled && crabPot.bait.Value?.QualifiedItemId == "(O)685" && crabPot.owner.Value == player.UniqueMultiplayerID && afterCount == beforeCount - 1;
        ExecutionState state = succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = succeeded ? "crab_pot_baited" : "bait_crab_pot_postcondition_unavailable";
        if (succeeded) { this.baitCrabPotResultTarget = new BridgeBaitCrabPotResultTarget(expectedTargetId, location.NameOrUniqueName, slot, targetX, targetY, "(O)710", "(O)685", crabPot.owner.Value.ToString(System.Globalization.CultureInfo.InvariantCulture), 1); this.baitCrabPotResultExecutionId = executionId; this.baitCrabPotResultRequestId = requestId; this.baitCrabPotResultRevision = this.revision; this.baitCrabPotResultDay = Game1.Date.TotalDays; }
        string evidence = $"source=(O)685;location={location.NameOrUniqueName};x={targetX};y={targetY};target={expectedTargetId};pot=(O)710;slot={slot};owner={crabPot.owner.Value};bait_before=none;bait_after={crabPot.bait.Value?.QualifiedItemId ?? "none"};inventory_before={beforeCount};inventory_after={afterCount};actionable={(player.CanMove && Game1.activeClickableMenu is null && !Game1.eventUp).ToString().ToLowerInvariant()};active_execution=null";
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision, evidence); this.Remember(receipt); this.AddTrace(receipt); return receipt;
    }

    public LocalExecutionReceipt RequestLocalFertilizeTile(string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!IsCropTargetInRange(Game1.player, targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object fertilizer || fertilizer.Category != StardewValley.Object.fertilizerCategory)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "fertilizer_not_owned_in_slot", $"slot={slot}");
        if (!string.Equals(fertilizer.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "fertilizer_slot_changed", $"slot={slot}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
            || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
            || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot)
            || !dirt.CanApplyFertilizer(fertilizer.QualifiedItemId)
            || !string.Equals(BuildFertilizerTargetId(location, slot, targetX, targetY, fertilizer.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "fertilizer_target_unavailable", $"target={targetX},{targetY}");

        int beforeCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        string? beforeFertilizer = dirt.fertilizer.Value;
        int previousSlot = Game1.player.CurrentToolIndex;
        LocalFertilizerApplicationSpec specification = new(executionId, requestId, location.NameOrUniqueName, slot, targetX, targetY, expectedTargetId, expectedQualifiedItemId, this.revision, requestedDeadlineMs);
        bool placementHandled;
        try
        {
            Game1.player.CurrentToolIndex = slot;
            placementHandled = fertilizer.placementAction(location, targetX * 64 + 32, targetY * 64 + 32, Game1.player);
            if (placementHandled)
                Game1.player.reduceActiveItemByOne();
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }

        StardewValley.TerrainFeatures.HoeDirt? appliedDirt = location.GetHoeDirtAtTile(tile);
        string? afterFertilizer = appliedDirt?.fertilizer.Value;
        int afterCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        bool fertilizerApplied = string.Equals(afterFertilizer, expectedQualifiedItemId, StringComparison.Ordinal);
        bool inventoryDecremented = afterCount == beforeCount - 1;
        ExecutionState state = placementHandled && fertilizerApplied && inventoryDecremented ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = state == ExecutionState.Succeeded ? "fertilizer_applied" : "fertilizer_postcondition_unavailable";
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision,
            $"location={specification.Location};target={expectedTargetId};tile={targetX},{targetY};item={expectedQualifiedItemId};fertilizer_before={beforeFertilizer ?? "none"};fertilizer_after={afterFertilizer ?? "none"};inventory_before={beforeCount};inventory_after={afterCount}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    public LocalExecutionReceipt RequestLocalClearDebris(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not Tool tool)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tool_not_owned_in_slot", $"slot={slot}");
        StardewValley.GameLocation location = Game1.player.currentLocation;
        StardewValley.TerrainFeatures.ResourceClump? clump = FindDebrisTarget(location, targetX, targetY, expectedTargetId, out int clumpIndex);
        if (clump is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "debris_target_changed", $"target={targetX},{targetY}");
        // ResourceClumps span multiple tiles. Require an ordinary one-tile
        // interaction radius from any footprint tile, while retaining the
        // opaque clump-origin identity as the freshness binding.
        if (!IsDebrisTargetWithinPlayerRadius(clump, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (!IsValidDebrisTool(clump, tool, out string toolKind, out int requiredUpgrade))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "debris_tool_unavailable", $"target={targetX},{targetY};parent={clump.parentSheetIndex.Value}");

        int parentSheetIndex = clump.parentSheetIndex.Value;
        float healthBefore = clump.health.Value;
        int previousSlot = Game1.player.CurrentToolIndex;
        Game1.player.CurrentToolIndex = slot;
        try
        {
            if (Game1.player.CurrentTool is not Tool activeTool)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tool_not_equipped", $"slot={slot}");
            Vector2 hitTile = clump.Tile;
            activeTool.DoFunction(location, (int)hitTile.X * 64 + 32, (int)hitTile.Y * 64 + 32, 0, Game1.player);
            // Tool.endUsing normally advances this native swing identity after
            // the animation. This direct game-thread adapter advances it after
            // the one bounded native hit so a retry is a distinct swing.
            activeTool.swingTicker++;
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }

        StardewValley.TerrainFeatures.ResourceClump? remaining = FindDebrisTarget(location, targetX, targetY, expectedTargetId, out _);
        float healthAfter = remaining?.health.Value ?? 0f;
        bool cleared = remaining is null;
        LocalExecutionReceipt receipt = new(
            executionId,
            requestId,
            cleared ? ExecutionState.Succeeded : ExecutionState.PartiallySucceeded,
            cleared ? "debris_cleared" : "debris_hit",
            this.revision,
            $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};parent={parentSheetIndex};tool={toolKind};required_upgrade={requiredUpgrade};health_before={healthBefore:0.##};health_after={healthAfter:0.##};clump_removed={cleared.ToString().ToLowerInvariant()}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    private static StardewValley.TerrainFeatures.ResourceClump? FindDebrisTarget(StardewValley.GameLocation location, int targetX, int targetY, string expectedTargetId, out int clumpIndex)
    {
        clumpIndex = -1;
        for (int index = 0; index < location.resourceClumps.Count; index++)
        {
            StardewValley.TerrainFeatures.ResourceClump clump = location.resourceClumps[index];
            Point tile = new((int)clump.Tile.X, (int)clump.Tile.Y);
            string targetId = BuildDebrisTargetId(location, index, clump);
            // Identity matching is deliberately independent from player range.
            // The caller applies the footprint-aware radius predicate after it
            // resolves this exact source-bound object, so discovery and
            // execution cannot disagree for multi-tile ResourceClumps.
            if (tile.X == targetX && tile.Y == targetY && string.Equals(targetId, expectedTargetId, StringComparison.Ordinal))
            {
                clumpIndex = index;
                return clump;
            }
        }
        return null;
    }

    private static string BuildDebrisTargetId(StardewValley.GameLocation location, int index, StardewValley.TerrainFeatures.ResourceClump clump)
    {
        string raw = $"{location.NameOrUniqueName}:{index}:{(int)clump.Tile.X},{(int)clump.Tile.Y}:{clump.parentSheetIndex.Value}:{clump.width.Value}x{clump.height.Value}";
        return $"debris_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static bool IsValidDebrisTool(StardewValley.TerrainFeatures.ResourceClump clump, Tool tool, out string toolKind, out int requiredUpgrade)
    {
        toolKind = clump.parentSheetIndex.Value switch
        {
            600 or 602 => "axe",
            148 or 622 or 672 or 752 or 754 or 756 or 758 => "pickaxe",
            _ => "unsupported",
        };
        requiredUpgrade = clump.parentSheetIndex.Value switch
        {
            600 => 1,
            602 => 2,
            148 or 622 => 3,
            672 => 2,
            _ => 0,
        };
        return (toolKind == "axe" && tool is Axe && tool.UpgradeLevel >= requiredUpgrade)
            || (toolKind == "pickaxe" && tool is Pickaxe && tool.UpgradeLevel >= requiredUpgrade);
    }

    /// <summary>
    /// Load exactly five Coffee Beans into one idle, empty Keg through the
    /// version-locked normal GameLocation.checkAction ingress. The bridge
    /// never invokes PlaceInMachine or Object.performObjectDropInAction: those
    /// are downstream helpers; checkAction owns target routing, probe, commit,
    /// and the native active-item consumption boundary.
    /// </summary>
}
