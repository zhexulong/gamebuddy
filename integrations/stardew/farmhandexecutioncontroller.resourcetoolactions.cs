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
    public LocalExecutionReceipt RequestLocalChopTreeSource(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity), behavior-equivalent to the inline sequence it
        // replaced: identical reasonCodes, identical order. Geometry, target
        // identity and the postcondition stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
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
        float staminaBefore = Game1.player.Stamina;
        UseNativeToolOnTile(axe, location, targetX, targetY, Game1.player, staminaBefore);
        float staminaAfter = Game1.player.Stamina;
        float staminaDelta = staminaAfter - staminaBefore;
        float expectedStaminaCost = axe.IsEfficient ? 0f : 2f - (Game1.player.ForagingLevel * 0.1f);
        bool sameTree = location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? afterFeature) && ReferenceEquals(afterFeature, tree);
        float after = sameTree ? tree.health.Value : float.NaN;
        bool stumpAfter = sameTree && tree.stump.Value;
        bool succeeded = sameTree && after == 5f && !stumpBefore && stumpAfter;
        string evidence = $"target={expectedTargetId};tool=axe;slot={slot};tree={tree.treeType.Value};health_before={before.ToString("0.##", CultureInfo.InvariantCulture)};health_after={(float.IsFinite(after) ? after.ToString("0.##", CultureInfo.InvariantCulture) : "missing")};stump_before={stumpBefore.ToString().ToLowerInvariant()};stump_after={stumpAfter.ToString().ToLowerInvariant()};source_transformed={succeeded.ToString().ToLowerInvariant()};stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture)}";
        return this.RememberTerminal(requestId, executionId, succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain, succeeded ? "tree_source_chopped" : "tree_source_chop_postcondition_unavailable", evidence);
    }

    public LocalExecutionReceipt RequestLocalBreakRockSource(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity), behavior-equivalent to the inline sequence it
        // replaced: identical reasonCodes, identical order. Geometry, target
        // identity and the postcondition stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Pickaxe pickaxe || !ReferenceEquals(Game1.player.CurrentTool, pickaxe) || pickaxe.UpgradeLevel != 0) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "basic_pickaxe_not_equipped_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? rock) || !NativeItemPredicates.IsOneHitBreakableStone(rock) || !string.Equals(BuildRockSourceTargetId(location, targetX, targetY, rock), expectedTargetId, StringComparison.Ordinal)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "rock_target_changed", $"target={targetX},{targetY}");
        int before = rock.MinutesUntilReady;
        float staminaBefore = Game1.player.Stamina;
        UseNativeToolOnTile(pickaxe, location, targetX, targetY, Game1.player, staminaBefore);
        float staminaAfter = Game1.player.Stamina;
        float staminaDelta = staminaAfter - staminaBefore;
        // Pickaxe covers power with who.toolPower.Value before deducting; a plain
        // tap holds toolPower at 0 (pressUseToolButton resets it), so a basic
        // pickaxe tap costs 2*(0+1) - Mining*0.1 = 2 - Mining*0.1.
        float expectedStaminaCost = pickaxe.IsEfficient ? 0f : 2f - (Game1.player.MiningLevel * 0.1f);
        bool removed = !location.objects.TryGetValue(tile, out StardewValley.Object? afterRock);
        bool succeeded = removed;
        string evidence = $"target={expectedTargetId};tool=pickaxe;slot={slot};qualified_item_id={rock.QualifiedItemId};durability_before={before};durability_after={(removed ? "removed" : afterRock!.MinutesUntilReady.ToString(CultureInfo.InvariantCulture))};removed={removed.ToString().ToLowerInvariant()};stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture)}";
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
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity), behavior-equivalent to the inline sequence it
        // replaced: identical reasonCodes, identical order. Geometry, target
        // identity and the postcondition stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Hoe hoe || !ReferenceEquals(Game1.player.CurrentTool, hoe) || hoe.UpgradeLevel != 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "basic_hoe_not_equipped_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.isTileOnMap(tile)
            || !location.objects.TryGetValue(tile, out StardewValley.Object? artifactSpot)
            || !NativeItemPredicates.IsArtifactSpot(artifactSpot)
            || !string.Equals(BuildArtifactSpotTargetId(location, targetX, targetY, artifactSpot.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "artifact_spot_target_changed", $"target={targetX},{targetY}");
        bool sourcePresentBefore = true;
        bool hoeDirtPresentBefore = location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? beforeFeature) && beforeFeature is StardewValley.TerrainFeatures.HoeDirt;
        if (hoeDirtPresentBefore)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "artifact_spot_hoedirt_present_before", $"target={targetX},{targetY};hoedirt_present_before=true");
        float staminaBefore = Game1.player.Stamina;
        UseNativeToolOnTile(hoe, location, targetX, targetY, Game1.player, staminaBefore);
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
        string evidence = $"location={location.NameOrUniqueName};target={expectedTargetId};result_target={resultTargetId ?? "none"};tile={targetX},{targetY};tool=hoe;slot={slot};stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture)};qualified_item_id={artifactSpot.QualifiedItemId};source_present_before={sourcePresentBefore.ToString().ToLowerInvariant()};source_present_after={sourcePresentAfter.ToString().ToLowerInvariant()};hoedirt_present_before={hoeDirtPresentBefore.ToString().ToLowerInvariant()};hoedirt_present_after={hoeDirtPresentAfter.ToString().ToLowerInvariant()};source_removed={(!sourcePresentAfter).ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain, succeeded ? "artifact_spot_dug" : "artifact_spot_postcondition_unavailable", evidence);
    }

    public LocalExecutionReceipt RequestLocalClearHoeDirt(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity), behavior-equivalent to the inline sequence it
        // replaced: identical reasonCodes, identical order. Geometry, target
        // identity and the postcondition stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Pickaxe pickaxe || !ReferenceEquals(Game1.player.CurrentTool, pickaxe) || pickaxe.UpgradeLevel != 0) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "basic_pickaxe_not_equipped_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature) || feature is not StardewValley.TerrainFeatures.HoeDirt dirt || dirt.crop is not null || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot) || !string.Equals(BuildClearHoeDirtTargetId(location, targetX, targetY), expectedTargetId, StringComparison.Ordinal)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "clear_hoedirt_target_changed", $"target={targetX},{targetY}");
        float staminaBefore = Game1.player.Stamina;
        UseNativeToolOnTile(pickaxe, location, targetX, targetY, Game1.player, staminaBefore);
        float staminaAfter = Game1.player.Stamina;
        float staminaDelta = staminaAfter - staminaBefore;
        // Pickaxe covers power with toolPower.Value (tap => 0), so a basic
        // pickaxe tap costs 2*(0+1) - Mining*0.1 = 2 - Mining*0.1.
        float expectedStaminaCost = pickaxe.IsEfficient ? 0f : 2f - (Game1.player.MiningLevel * 0.1f);
        bool hoeDirtPresentAfter = location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? afterFeature) && afterFeature is StardewValley.TerrainFeatures.HoeDirt;
        bool removed = !hoeDirtPresentAfter;
        string evidence = $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};tool=pickaxe;slot={slot};crop_before=false;hoedirt_present_before=true;hoedirt_present_after={hoeDirtPresentAfter.ToString().ToLowerInvariant()};removed={removed.ToString().ToLowerInvariant()};stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture)}";
        return this.RememberTerminal(requestId, executionId, removed ? ExecutionState.Succeeded : ExecutionState.Uncertain, removed ? "hoedirt_cleared" : "clear_hoedirt_postcondition_unavailable", evidence);
    }

    public LocalExecutionReceipt RequestLocalTillSoil(string requestId, int targetX, int targetY, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

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
        {
            // Distinguish "wrong tile" from "right tile, too far to act on". The
            // distinction is actionable for the Agent: an out-of-reach diggable
            // tile means walk there first, whereas a non-diggable tile means pick
            // a different target. Both stay rejected before any native ingress.
            string distance = ChebyshevDistance(Game1.player, targetX, targetY).ToString(System.Globalization.CultureInfo.InvariantCulture);
            bool diggableFromHere = IsDiggableSoilTile(Game1.player.currentLocation, targetX, targetY);
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                diggableFromHere ? "target_out_of_reach" : "target_out_of_range",
                diggableFromHere
                    ? $"target={targetX},{targetY};distance={distance};reach=1"
                    : $"target={targetX},{targetY};distance={distance}");
        }

        Vector2 tile = new(targetX, targetY);
        StardewValley.GameLocation location = Game1.player.currentLocation;
        if (location.GetHoeDirtAtTile(tile) is not null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "soil_already_tilled", $"target={targetX},{targetY}");
        if (!IsDiggableSoilTile(location, targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "soil_not_diggable", $"target={targetX},{targetY}");
        if (Game1.player.CurrentTool is not Hoe hoe)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "hoe_not_equipped", null);

        LocalSoilTillingSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, this.revision, requestedDeadlineMs);
        string before = "none";
        float staminaBefore = Game1.player.Stamina;
        UseNativeToolOnTile(hoe, location, targetX, targetY, Game1.player, staminaBefore);
        float staminaAfter = Game1.player.Stamina;
        float staminaDelta = staminaAfter - staminaBefore;
        float expectedStaminaCost = hoe.IsEfficient ? 0f : 2f - (Game1.player.FarmingLevel * 0.1f);
        bool tilled = location.GetHoeDirtAtTile(tile) is not null;
        LocalExecutionReceipt receipt = new(executionId, requestId, tilled ? ExecutionState.Succeeded : ExecutionState.Uncertain, tilled ? "soil_tilled" : "soil_postcondition_unavailable", this.revision, $"location={specification.Location};target={targetX},{targetY};before={before};after={(tilled ? "HoeDirt" : "none")};stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture)}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    /// <summary>
    /// equip_tool/v2: resolves one canonical semantic tool category to the
    /// deterministically best owned item on the game thread, switches to that
    /// slot, and proves it with a ReferenceEquals postcondition. slot stays
    /// Mod-private and is never accepted from the wire.
    /// </summary>
    public LocalExecutionReceipt RequestLocalEquipTool(string requestId, string? requestedTool)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

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
        if (requestedTool is null || !FarmhandActionCatalog.ToolEnum.Contains(requestedTool, StringComparer.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_tool_selector", requestedTool is null ? null : $"tool={requestedTool}");

        int? slot = SelectToolSlot(Game1.player, requestedTool);
        if (slot is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tool_not_found", $"tool={requestedTool}");
        Tool? selectedTool = Game1.player.Items[slot.Value] as Tool;
        if (selectedTool is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tool_not_found", $"tool={requestedTool};slot={slot.Value}");

        // already_equipped is a deterministic success when the resolved best
        // item is already the held tool: no further switch is required.
        if (ReferenceEquals(Game1.player.CurrentTool, selectedTool))
        {
            string? heldToolName = DescribeTool(Game1.player.CurrentTool);
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "already_equipped", $"tool={requestedTool};before={heldToolName ?? "none"};expected={heldToolName ?? "none"};after={heldToolName ?? "none"}");
        }

        string? expectedTool = DescribeTool(selectedTool);
        string? previousTool = DescribeTool(Game1.player.CurrentTool);
        Game1.player.CurrentToolIndex = slot.Value;
        string? currentTool = DescribeTool(Game1.player.CurrentTool);
        if (!string.Equals(currentTool, expectedTool, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "tool_selection_postcondition_unavailable", $"tool={requestedTool};before={previousTool ?? "none"};expected={expectedTool ?? "none"};actual={currentTool ?? "none"}");

        return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "tool_equipped", $"tool={requestedTool};before={previousTool ?? "none"};expected={expectedTool};after={currentTool}");
    }

    /// <summary>
    /// Deterministic game-thread selection of the best owned item for one
    /// canonical tool category. Regular tools and scythe pick the highest
    /// UpgradeLevel (ties to the smallest slot); weapons pick the highest
    /// MeleeWeapon.getItemLevel(). Returns null when no item matches.
    /// </summary>
    private static int? SelectToolSlot(Farmer player, string tool)
    {
        int bestSlot = -1;
        int bestRank = -1;
        for (int slot = 0; slot < player.Items.Count; slot++)
        {
            if (player.Items[slot] is not Tool item)
                continue;
            if (!MatchesToolCategory(item, tool))
                continue;
            int rank = tool == "weapon" ? ItemRankForWeapon(item) : item.UpgradeLevel;
            if (rank > bestRank || (rank == bestRank && (bestSlot < 0 || slot < bestSlot)))
            {
                bestRank = rank;
                bestSlot = slot;
            }
        }
        return bestSlot < 0 ? null : bestSlot;
    }

    private static bool MatchesToolCategory(Tool item, string tool) => tool switch
    {
        "axe" => item is Axe,
        "pickaxe" => item is Pickaxe,
        "hoe" => item is Hoe,
        "watering_can" => item is WateringCan,
        "fishing_rod" => item is FishingRod,
        "weapon" => item is MeleeWeapon or Slingshot,
        "scythe" => item is MeleeWeapon weapon && weapon.isScythe(),
        "shears" => item is Shears,
        "milk_pail" => item is MilkPail,
        "pan" => item is Pan,
        _ => false,
    };

    /// <summary>
    /// Chop exactly one TerrainFeature Tree stump (stump.Value == true) with an
    /// equipped Axe of any upgrade level. ResourceClump stumps (600/602) are
    /// NOT this action's targets: they belong exclusively to clear_debris, per
    /// the target-entity orthogonality decision (2026-09-23). The one native
    /// Axe.DoFunction swing settles the action; a missing/unchanged stump is a
    /// fresh postcondition failure, never a claimed success.
    /// </summary>
    public LocalExecutionReceipt RequestLocalChopStump(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity), behavior-equivalent to the inline sequence it
        // replaced: identical reasonCodes, identical order. Geometry, target
        // identity and the postcondition stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Axe axe || !ReferenceEquals(Game1.player.CurrentTool, axe))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "basic_axe_not_equipped_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature) || feature is not StardewValley.TerrainFeatures.Tree tree
            || !tree.stump.Value
            || !string.Equals(BuildTreeStumpTargetId(location, targetX, targetY, tree), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "stump_target_changed", $"target={targetX},{targetY}");
        float before = tree.health.Value;
        string treeType = tree.treeType.Value;
        int axeLevel = axe.UpgradeLevel;
        // A stump carries 5 health and a basic axe deals 1 damage per
        // native swing (Tree.performToolAction upgradeLevel 0 => 1f). One
        // DoFunction call is never enough; keep swinging the same equipped
        // axe on the same tile until the stump falls (health <= 0 triggers
        // native performTreeFall, which marks -100 and drops wood) or the
        // bounded safety cap stops us. This mirrors the repeated native
        // seam a holding player executes; no menu, no direct world write,
        // and every swing runs the native damage/debris path.
        const int maximumSwingCount = 12;
        int swingCount = 0;
        float staminaBefore = Game1.player.Stamina;
        while (tree.health.Value > 0f && swingCount < maximumSwingCount)
        {
            UseNativeToolOnTile(axe, location, targetX, targetY, Game1.player, staminaBefore);
            swingCount++;
        }
        float staminaAfter = Game1.player.Stamina;
        float staminaDelta = staminaAfter - staminaBefore;
        float perSwingStaminaCost = axe.IsEfficient ? 0f : 2f - (Game1.player.ForagingLevel * 0.1f);
        float expectedStaminaCost = perSwingStaminaCost * swingCount;
        // native Tree.performTreeFall() on a stump sets health = -100 (the
        // destroyed marker) and the terrainFeature is then removed by the
        // native tick (destroy.Value). Accept either the immediate -100
        // marker or a removed terrainFeature as the fresh postcondition.
        bool removed = tree.health.Value <= -100f;
        bool terrainGone = !location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? afterFeature)
            || !ReferenceEquals(afterFeature, tree);
        string healthAfterText = removed ? "destroyed" : terrainGone ? "removed"
            : afterFeature is StardewValley.TerrainFeatures.Tree afterTree
                ? afterTree.health.Value.ToString("0.##", CultureInfo.InvariantCulture)
                : "missing";
        string evidence = $"target={expectedTargetId};type=tree_stump;tree={treeType};tool=axe;tool_level={axeLevel};health_before={before.ToString("0.##", CultureInfo.InvariantCulture)};health_after={healthAfterText};swings={swingCount};stump_removed={(removed || terrainGone).ToString().ToLowerInvariant()};stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture)}";
        if (removed || terrainGone)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "stump_cleared", evidence);
        return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "stump_clear_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// Cut exactly one adjacent Weed object with an equipped scythe through the
    /// native Object.performToolAction weeds branch (target version 1.6). The
    /// scythe must be the current tool and the target object must still be the
    /// requested weed; a removed weed is the only success postcondition. No
    /// other litter class is touched (stones stay in break_rock_source, debris
    /// clumps in clear_debris).
    /// </summary>
    public LocalExecutionReceipt RequestLocalCutWeeds(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity), behavior-equivalent to the inline sequence it
        // replaced: identical reasonCodes, identical order. Geometry, target
        // identity and the postcondition stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not MeleeWeapon weapon || !weapon.isScythe() || !ReferenceEquals(Game1.player.CurrentTool, weapon))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "scythe_not_equipped_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? weed) || !weed.IsWeeds()
            || !string.Equals(BuildWeedTargetId(location, targetX, targetY, weed), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "weed_target_changed", $"target={targetX},{targetY}");

        int healthBefore = weed.MinutesUntilReady;
        float staminaBefore = Game1.player.Stamina;
        // A common weed (O)313 carries 2 health and the basic scythe (W)47
        // deals exactly 1 damage per native swing (Object.performToolAction
        // weeds branch: damage = 1, only a non-basic scythe deals 2). One
        // swing therefore never triggers native cutWeed; keep swinging the
        // same equipped scythe on the same object until it is removed, the
        // bounded safety cap is reached, or the weed leaves an unhandled
        // state. Every swing runs the native damage/debris path.
        const int maximumSwingCount = 8;
        int swingCount = 0;
        bool handled = false;
        bool removed = false;
        while (!removed && swingCount < maximumSwingCount)
        {
            // Native Object.performToolAction weeds branch decrements the
            // weed health only while shakeTimer <= 0 and then arms that 200ms
            // cooldown; the scythe caller (MeleeWeapon.DoFunction AoE sweep)
            // also removes the object from the map only when the action
            // returns true. Mirror both halves of that native swing here:
            // reset the shake cooldown as if the next swing started after it
            // elapsed, call the same native action, and remove the map entry
            // exactly when the native action reports the weed was cut.
            weed.shakeTimer = 0;
            bool cut = weed.performToolAction(weapon);
            swingCount++;
            if (cut)
            {
                handled = true;
                location.objects.Remove(tile);
                removed = true;
            }
            else
            {
                removed = !location.objects.TryGetValue(tile, out StardewValley.Object? afterWeed)
                    || !ReferenceEquals(afterWeed, weed);
            }
        }
        float staminaAfter = Game1.player.Stamina;
        float staminaDelta = staminaAfter - staminaBefore;
        // The scythe is a MeleeWeapon: no native code path deducts stamina for
        // a melee swing (only Axe/Hoe/Pickaxe/WateringCan/MilkPail/Shears do),
        // so the expected embodied cost is exactly zero. Reporting it as an
        // explicit zero is the fact the Agent needs ("this family is free").
        float expectedStaminaCost = 0f;
        string evidence = $"target={expectedTargetId};type=weed;tool=scythe;qualified_item_id={weed.QualifiedItemId};health_before={healthBefore};health_after={(removed ? "removed" : location.objects.TryGetValue(tile, out StardewValley.Object? remainingWeed) && remainingWeed is not null ? remainingWeed.MinutesUntilReady.ToString(CultureInfo.InvariantCulture) : "missing")};swings={swingCount};removed={removed.ToString().ToLowerInvariant()};stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture)}";
        if (handled && removed)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "weeds_cut", evidence);
        return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "weed_cut_postcondition_unavailable", evidence);
    }

    private static int ItemRankForWeapon(Tool item)
    {
        if (item is MeleeWeapon melee)
            return melee.getItemLevel();
        return item is Slingshot ? 1 : 0;
    }

}
