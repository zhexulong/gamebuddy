using System.Globalization;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;
using StardewValley.Characters;

namespace GameBuddy.Stardew;

// Native handler bodies remain action/family-owned. All parts share the one
// ExecutionManager game-thread ledger, receipt store, snapshot, and cancel state.
internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalChopTreeSource(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
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
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Axe axe || !ReferenceEquals(Game1.player.CurrentTool, axe) || axe.UpgradeLevel != 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "basic_axe_not_equipped_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature) || feature is not StardewValley.TerrainFeatures.Tree tree
            || tree.stump.Value || tree.growthStage.Value < StardewValley.TerrainFeatures.Tree.treeStage || tree.hasMoss.Value || tree.tapped.Value || tree.health.Value != 1f
            || !string.Equals(BuildTreeChopSourceTargetId(location, targetX, targetY, tree), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tree_chop_target_changed", $"target={targetX},{targetY}");
        float before = tree.health.Value;
        bool stumpBefore = tree.stump.Value;
        axe.DoFunction(location, targetX * 64 + 32, targetY * 64 + 32, 0, Game1.player);
        bool sameTree = location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? afterFeature) && ReferenceEquals(afterFeature, tree);
        float after = sameTree ? tree.health.Value : float.NaN;
        bool stumpAfter = sameTree && tree.stump.Value;
        bool succeeded = sameTree && after == 5f && !stumpBefore && stumpAfter;
        string evidence = $"target={expectedTargetId};tool=axe;slot={slot};tree={tree.treeType.Value};health_before={before.ToString("0.##", CultureInfo.InvariantCulture)};health_after={(float.IsFinite(after) ? after.ToString("0.##", CultureInfo.InvariantCulture) : "missing")};stump_before={stumpBefore.ToString().ToLowerInvariant()};stump_after={stumpAfter.ToString().ToLowerInvariant()};source_transformed={succeeded.ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain, succeeded ? "tree_source_chopped" : "tree_source_chop_postcondition_unavailable", evidence);
    }

    public LocalExecutionReceipt RequestLocalBreakRockSource(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Context.IsMultiplayer || !Game1.IsMasterGame || Game1.server is not null || Game1.player is null || Game1.getAllFarmers().Count() != 1 || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "native_local_player_required", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.controller.HasActiveExecution) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", null);
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Pickaxe pickaxe || !ReferenceEquals(Game1.player.CurrentTool, pickaxe) || pickaxe.UpgradeLevel != 0) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "basic_pickaxe_not_equipped_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? rock) || rock.QualifiedItemId != "(O)2" || !rock.IsBreakableStone() || rock.MinutesUntilReady != 1 || !string.Equals(BuildRockSourceTargetId(location, targetX, targetY, rock), expectedTargetId, StringComparison.Ordinal)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "rock_target_changed", $"target={targetX},{targetY}");
        int before = rock.MinutesUntilReady;
        pickaxe.DoFunction(location, targetX * 64 + 32, targetY * 64 + 32, 0, Game1.player);
        bool removed = !location.objects.TryGetValue(tile, out StardewValley.Object? afterRock);
        bool succeeded = removed;
        string evidence = $"target={expectedTargetId};tool=pickaxe;slot={slot};qualified_item_id={rock.QualifiedItemId};durability_before={before};durability_after={(removed ? "removed" : afterRock!.MinutesUntilReady.ToString(CultureInfo.InvariantCulture))};removed={removed.ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain, succeeded ? "rock_source_broken" : "rock_source_postcondition_unavailable", evidence);
    }

    /// <summary>One native Basic Pickaxe use removes exactly one fresh adjacent empty ground HoeDirt; crops, IndoorPots, drops, and collection are outside this action.</summary>
    public LocalExecutionReceipt RequestLocalDigArtifactSpot(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.InvalidateArtifactSpotResult();
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Context.IsMultiplayer || !Game1.IsMasterGame || Game1.server is not null || Game1.player is null || Game1.getAllFarmers().Count() != 1 || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "native_local_player_required", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove || Game1.player.UsingTool || Game1.player.toolPower.Value != 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", null);
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Hoe hoe || !ReferenceEquals(Game1.player.CurrentTool, hoe) || hoe.UpgradeLevel != 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "basic_hoe_not_equipped_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.isTileOnMap(tile)
            || !location.objects.TryGetValue(tile, out StardewValley.Object? artifactSpot)
            || artifactSpot.QualifiedItemId != "(O)590"
            || !string.Equals(BuildArtifactSpotTargetId(location, targetX, targetY), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "artifact_spot_target_changed", $"target={targetX},{targetY}");
        bool sourcePresentBefore = true;
        bool hoeDirtPresentBefore = location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? beforeFeature) && beforeFeature is StardewValley.TerrainFeatures.HoeDirt;
        if (hoeDirtPresentBefore)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "artifact_spot_hoedirt_present_before", $"target={targetX},{targetY};hoedirt_present_before=true");
        float staminaBefore = Game1.player.Stamina;
        hoe.DoFunction(location, targetX * 64 + 32, targetY * 64 + 32, 1, Game1.player);
        Game1.player.lastClick = Vector2.Zero;
        Game1.player.checkForExhaustion(staminaBefore);
        float staminaAfter = Game1.player.Stamina;
        float staminaDelta = staminaAfter - staminaBefore;
        float expectedStaminaCost = hoe.IsEfficient ? 0f : 2f - (Game1.player.FarmingLevel * 0.1f);
        bool sourcePresentAfter = location.objects.TryGetValue(tile, out _);
        bool hoeDirtPresentAfter = location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? afterFeature)
            && afterFeature is StardewValley.TerrainFeatures.HoeDirt afterDirt
            && afterDirt.crop is null
            && !(location.objects.TryGetValue(tile, out StardewValley.Object? placedAfter) && placedAfter is StardewValley.Objects.IndoorPot);
        bool succeeded = !hoeDirtPresentBefore && !sourcePresentAfter && hoeDirtPresentAfter;
        string? resultTargetId = succeeded ? BuildArtifactSpotResultTargetId(location, targetX, targetY) : null;
        if (succeeded)
        {
            this.artifactSpotResultTarget = new BridgeArtifactSpotResultTarget(resultTargetId!, location.NameOrUniqueName, targetX, targetY, Crop: false, Ground: true);
            this.artifactSpotResultExecutionId = executionId;
            this.artifactSpotResultRequestId = requestId;
            this.artifactSpotResultRevision = this.revision;
            this.artifactSpotResultDay = Game1.Date.TotalDays;
        }
        string evidence = $"location={location.NameOrUniqueName};target={expectedTargetId};result_target={resultTargetId ?? "none"};tile={targetX},{targetY};tool=hoe;slot={slot};stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture)};qualified_item_id=(O)590;source_present_before={sourcePresentBefore.ToString().ToLowerInvariant()};source_present_after={sourcePresentAfter.ToString().ToLowerInvariant()};hoedirt_present_before={hoeDirtPresentBefore.ToString().ToLowerInvariant()};hoedirt_present_after={hoeDirtPresentAfter.ToString().ToLowerInvariant()};source_removed={(!sourcePresentAfter).ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain, succeeded ? "artifact_spot_dug" : "artifact_spot_postcondition_unavailable", evidence);
    }

    public LocalExecutionReceipt RequestLocalClearHoeDirt(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Context.IsMultiplayer || !Game1.IsMasterGame || Game1.server is not null || Game1.player is null || Game1.getAllFarmers().Count() != 1 || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "native_local_player_required", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.controller.HasActiveExecution) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", null);
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Pickaxe pickaxe || !ReferenceEquals(Game1.player.CurrentTool, pickaxe) || pickaxe.UpgradeLevel != 0) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "basic_pickaxe_not_equipped_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature) || feature is not StardewValley.TerrainFeatures.HoeDirt dirt || dirt.crop is not null || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot) || !string.Equals(BuildClearHoeDirtTargetId(location, targetX, targetY), expectedTargetId, StringComparison.Ordinal)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "clear_hoedirt_target_changed", $"target={targetX},{targetY}");
        pickaxe.DoFunction(location, targetX * 64 + 32, targetY * 64 + 32, 0, Game1.player);
        bool hoeDirtPresentAfter = location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? afterFeature) && afterFeature is StardewValley.TerrainFeatures.HoeDirt;
        bool removed = !hoeDirtPresentAfter;
        string evidence = $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};tool=pickaxe;slot={slot};crop_before=false;hoedirt_present_before=true;hoedirt_present_after={hoeDirtPresentAfter.ToString().ToLowerInvariant()};removed={removed.ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, removed ? ExecutionState.Succeeded : ExecutionState.Uncertain, removed ? "hoedirt_cleared" : "clear_hoedirt_postcondition_unavailable", evidence);
    }

    public LocalExecutionReceipt RequestLocalTillSoil(string requestId, int targetX, int targetY, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_menu_open", null);
        if (Game1.eventUp)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_event_active", null);
        if (!Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_cannot_move", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");

        Vector2 tile = new(targetX, targetY);
        StardewValley.GameLocation location = Game1.player.currentLocation;
        if (location.GetHoeDirtAtTile(tile) is not null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "soil_already_tilled", $"target={targetX},{targetY}");
        if (location.doesTileHaveProperty(targetX, targetY, "Diggable", "Back") is null || location.isWaterTile(targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "soil_not_diggable", $"target={targetX},{targetY}");
        if (Game1.player.CurrentTool is not Hoe hoe)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "hoe_not_equipped", null);

        LocalSoilTillingSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, this.revision, requestedDeadlineMs);
        string before = "none";
        hoe.DoFunction(location, targetX * 64 + 32, targetY * 64 + 32, 0, Game1.player);
        bool tilled = location.GetHoeDirtAtTile(tile) is not null;
        LocalExecutionReceipt receipt = new(executionId, requestId, tilled ? ExecutionState.Succeeded : ExecutionState.Uncertain, tilled ? "soil_tilled" : "soil_postcondition_unavailable", this.revision, $"location={specification.Location};target={targetX},{targetY};before={before};after={(tilled ? "HoeDirt" : "none")}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    public LocalExecutionReceipt RequestLocalEquipTool(string requestId, int slot)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_menu_open", null);
        if (Game1.eventUp)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_event_active", null);
        if (!Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_cannot_move", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (slot < 0 || slot >= Game1.player.Items.Count)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_tool_slot", null);
        Tool? selectedTool = Game1.player.Items[slot] as Tool;
        if (selectedTool is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tool_not_owned_in_slot", $"slot={slot}");

        string? expectedTool = DescribeTool(selectedTool);
        string? previousTool = DescribeTool(Game1.player.CurrentTool);
        Game1.player.CurrentToolIndex = slot;
        string? currentTool = DescribeTool(Game1.player.CurrentTool);
        if (!string.Equals(currentTool, expectedTool, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "tool_selection_postcondition_unavailable", $"before={previousTool ?? "none"};expected={expectedTool ?? "none"};actual={currentTool ?? "none"}");

        return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "tool_selected", $"slot={slot};before={previousTool ?? "none"};expected={expectedTool};after={currentTool}");
    }

}
