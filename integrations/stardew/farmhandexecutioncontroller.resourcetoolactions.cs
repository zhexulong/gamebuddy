using System.Globalization;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;
using StardewValley.Characters;
using GameBuddy.Stardew.Core;

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
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Axe axe || !ReferenceEquals(Game1.player.CurrentTool, axe) || axe.UpgradeLevel != 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "basic_axe_not_equipped_in_requested_slot", DescribeRequestedSlot(Game1.player.Items, slot, Game1.player.CurrentToolIndex, "chop_tree_source"));
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature) || feature is not StardewValley.TerrainFeatures.Tree tree
            || tree.stump.Value || tree.growthStage.Value < StardewValley.TerrainFeatures.Tree.treeStage || tree.hasMoss.Value || tree.tapped.Value || tree.health.Value != 1f
            || !string.Equals(BuildTreeChopSourceTargetId(location, targetX, targetY, tree), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tree_chop_target_changed", $"target={targetX},{targetY}");
        // 5.2: outside the native interaction radius (Chebyshev-1), the action
        // begins an approach leg instead of rejecting. The native click path
        // requires the same radius (Game1.cs:11509 checkAction gate; GetToolLocation
        // hits the tile in front when the click is farther), so walking is the
        // player-equivalent behaviour, not a Mod convenience. The tool and target
        // are validated above (position-independent), the world is re-validated
        // after the approach settles (inside the closure), and the walk uses the
        // arrival predicate.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1) || IsToolTargetUnderActor(Game1.player, targetX, targetY))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "chop_tree_source",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteChopTreeSource(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteChopTreeSource(executionId, requestId, slot, targetX, targetY, expectedTargetId);
    }

    /// <summary>
    /// Executes chop_tree_source against the current world, re-validating the tool
    /// and the target first because an approach leg may have taken several ticks and
    /// either can have changed while walking. Terminal receipts are minted here so
    /// the in-range path and the post-approach path share one execution body.
    /// </summary>
    private LocalExecutionReceipt ExecuteChopTreeSource(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Axe axe || !ReferenceEquals(Game1.player.CurrentTool, axe) || axe.UpgradeLevel != 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "basic_axe_not_equipped_in_requested_slot", DescribeRequestedSlot(Game1.player.Items, slot, Game1.player.CurrentToolIndex, "chop_tree_source"));
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
        if (ResolveDeclaredTool(Game1.player.Items, "break_rock_source").RefusalCode is { } toolRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusal, $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? rock) || !NativeItemPredicates.IsOneHitBreakableStone(rock) || !string.Equals(BuildRockSourceTargetId(location, targetX, targetY, rock), expectedTargetId, StringComparison.Ordinal)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "rock_target_changed", $"target={targetX},{targetY}");
        // 5.2: out of the native radius, walk in rather than refuse. Position-independent
        // checks above; the target is re-validated after the walk inside the closure.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1) || IsToolTargetUnderActor(Game1.player, targetX, targetY))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "break_rock_source",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteBreakRockSource(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteBreakRockSource(executionId, requestId, slot, targetX, targetY, expectedTargetId);
    }

    /// <summary>
    /// Executes break_rock_source against the current world, re-validating the target because an approach leg may have
    /// taken several ticks. The tool is not the caller's to name: the action's own registration claims `tool:pickaxe`,
    /// so this selects the best owned pickaxe it needs and restores the actor's own selection afterwards. Shared by the
    /// in-range path and the post-approach path so the two cannot drift.
    /// </summary>
    private LocalExecutionReceipt ExecuteBreakRockSource(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
        if (!TrySelectDeclaredTool(Game1.player, "break_rock_source", out DeclaredToolSelection selection, out string toolRefusalCode))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusalCode, $"slot={slot}");
        Dictionary<string, string> evidence = ToolActionEvidence.SelectionFacts(selection);
        ExecutionState state;
        string reasonCode;
        try
        {
            if (selection.Tool is not Pickaxe pickaxe)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, $"tool_not_selected:{selection.Category}", $"slot={selection.Slot}");
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
            evidence["target"] = expectedTargetId;
            evidence["tool"] = "pickaxe";
            evidence["qualified_item_id"] = rock.QualifiedItemId;
            evidence["durability_before"] = before.ToString(CultureInfo.InvariantCulture);
            evidence["durability_after"] = removed ? "removed" : afterRock!.MinutesUntilReady.ToString(CultureInfo.InvariantCulture);
            evidence["removed"] = removed.ToString().ToLowerInvariant();
            evidence["stamina_before"] = staminaBefore.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["stamina_after"] = staminaAfter.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["stamina_delta"] = staminaDelta.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["expected_stamina_cost"] = expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture);
            state = removed ? ExecutionState.Succeeded : ExecutionState.Uncertain;
            reasonCode = removed ? "rock_source_broken" : "rock_source_postcondition_unavailable";
        }
        finally
        {
            RestoreToolSelection(Game1.player, selection);
            evidence["tool_restored"] = DescribeToolCategory(Game1.player.CurrentTool);
        }
        return this.RememberTerminal(requestId, executionId, state, reasonCode, ToolActionEvidence.Compose(ToolActionEvidence.BreakRockSource, evidence));
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
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Hoe hoe || !ReferenceEquals(Game1.player.CurrentTool, hoe) || hoe.UpgradeLevel != 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "basic_hoe_not_equipped_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.isTileOnMap(tile)
            || !location.objects.TryGetValue(tile, out StardewValley.Object? probeSpot)
            || !NativeItemPredicates.IsArtifactSpot(probeSpot)
            || !string.Equals(BuildArtifactSpotTargetId(location, targetX, targetY, probeSpot.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "artifact_spot_target_changed", $"target={targetX},{targetY}");
        // Position-independent checks are done; the target is re-validated after the
        // walk inside the closure, because the world can change while walking.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1) || IsToolTargetUnderActor(Game1.player, targetX, targetY))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "dig_artifact_spot",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteDigArtifactSpot(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteDigArtifactSpot(executionId, requestId, slot, targetX, targetY, expectedTargetId);
    }

    /// <summary>
    /// Executes dig_artifact_spot against the current world, re-validating the tool and
    /// the target because an approach leg may have taken several ticks. Shared by the
    /// in-range path and the post-approach path so the two cannot drift.
    /// </summary>
    private LocalExecutionReceipt ExecuteDigArtifactSpot(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
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
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Pickaxe probePickaxe || !ReferenceEquals(Game1.player.CurrentTool, probePickaxe) || probePickaxe.UpgradeLevel != 0) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "basic_pickaxe_not_equipped_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature) || feature is not StardewValley.TerrainFeatures.HoeDirt dirt || dirt.crop is not null || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot) || !string.Equals(BuildClearHoeDirtTargetId(location, targetX, targetY), expectedTargetId, StringComparison.Ordinal)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "clear_hoedirt_target_changed", $"target={targetX},{targetY}");
        // Position-independent checks are done; the target is re-validated after the walk.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1) || IsToolTargetUnderActor(Game1.player, targetX, targetY))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "clear_hoedirt",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteClearHoeDirt(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteClearHoeDirt(executionId, requestId, slot, targetX, targetY, expectedTargetId);
    }

    /// <summary>
    /// Executes clear_hoedirt against the current world, re-validating the tool and the
    /// target because an approach leg may have taken several ticks. Shared by the
    /// in-range path and the post-approach path so the two cannot drift.
    /// </summary>
    private LocalExecutionReceipt ExecuteClearHoeDirt(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
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
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity) in the one authority, in that same order: the
        // refusal now NAMES the hold (actor_held_by_modal / cutscene_active /
        // actor_passed_out / transient_busy) where the three split guards
        // reported player_menu_open / player_event_active / player_cannot_move.
        // Geometry, target identity and the postcondition stay action-specific.
        // Physical: tilling drives the Hoe.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is { } admissionRefusal)
            return admissionRefusal;
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1) || IsToolTargetUnderActor(Game1.player, targetX, targetY))
        {
            // Distinguish "wrong tile" from "right tile, too far to act on". A
            // non-diggable tile means pick a different target and stays refused at any
            // distance; a diggable one means walk there first, which is exactly what the
            // native click path requires the player to do (Game1.cs:11509 gates
            // checkAction on tileWithinRadiusOfPlayer(grabTile, 1)).
            string distance = ChebyshevDistance(Game1.player, targetX, targetY).ToString(System.Globalization.CultureInfo.InvariantCulture);
            StardewValley.GameLocation distantLocation = Game1.player.currentLocation;
            if (!IsDiggableSoilTile(distantLocation, targetX, targetY))
            {
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    "target_out_of_range",
                    $"target={targetX},{targetY};distance={distance}");
            }

            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "till_soil",
                distantLocation,
                targetX,
                targetY,
                $"till_soil_{targetX}_{targetY}",
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteTillSoil(arrivalExecutionId, arrivalRequestId, targetX, targetY, requestedDeadlineMs),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteTillSoil(executionId, requestId, targetX, targetY, requestedDeadlineMs);
    }

    /// <summary>
    /// Executes till_soil against the current world, re-validating the tool and the
    /// tile because an approach leg may have taken several ticks. Shared by the
    /// in-range path and the post-approach path so the two cannot drift.
    /// </summary>
    private LocalExecutionReceipt ExecuteTillSoil(string executionId, string requestId, int targetX, int targetY, long requestedDeadlineMs)
    {
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
    public LocalExecutionReceipt RequestLocalEquipTool(string requestId, string? requestedTool, long requestedDeadlineMs)
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
        // Shared mechanical admission (identity -> actionability -> deadline -> body exclusivity). The three
        // separate guards this replaces (`player_menu_open` / `player_event_active` / `player_cannot_move`)
        // were the same fork with its own reason codes; the refusal is now the authority's NAMED hold.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is { } admissionRefusal)
            return admissionRefusal;
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

    /// <summary>
    /// The ONE mapping between a native tool and the category word an action's own `tool:&lt;category&gt;` claim uses
    /// (<see cref="FarmhandActionCatalog.ToolEnum"/>), or null when this Mod has no word for the tool. Every reading of
    /// "which category is this tool" goes through it - <see cref="MatchesToolCategory"/> (does this tool satisfy that
    /// claim?), <see cref="DescribeToolCategory"/> (what did the handler take and put back?) and the slot list's
    /// published category - so a claim, a receipt and the snapshot can never name the same tool two different ways.
    /// A scythe is a MeleeWeapon, so it is tested before `weapon`; the words partition the vocabulary, which is what
    /// makes `weapon` mean "a weapon that is not a scythe".
    /// </summary>
    internal static string? ToolCategory(Tool? tool) => tool switch
    {
        Axe => "axe",
        Pickaxe => "pickaxe",
        Hoe => "hoe",
        WateringCan => "watering_can",
        FishingRod => "fishing_rod",
        Shears => "shears",
        MilkPail => "milk_pail",
        Pan => "pan",
        MeleeWeapon weapon when weapon.isScythe() => "scythe",
        MeleeWeapon or Slingshot => "weapon",
        _ => null,
    };

    /// <summary>Whether a tool satisfies a `tool:&lt;category&gt;` claim, asked of the one category mapping.</summary>
    private static bool MatchesToolCategory(Tool item, string tool) =>
        string.Equals(ToolCategory(item), tool, StringComparison.Ordinal);

    /// <summary>
    /// The tool one action's own registration declares: the category from `tool:&lt;category&gt;` and the upgrade tier
    /// from that claim's value. Reading it from the registration rather than from a table in the handler is what keeps
    /// "which tool" a published fact - `cut_weeds` needs the scythe because its registration claims one, not because
    /// this file remembers it.
    /// </summary>
    private static FarmhandActionResourceTemplateClaim? DeclaredToolClaim(string actionId)
    {
        FarmhandActionRegistration? registration = FarmhandActionCatalog.Registrations
            .FirstOrDefault(candidate => string.Equals(candidate.ActionId, actionId, StringComparison.Ordinal));
        return registration?.Descriptor?.ResourceTemplate
            .FirstOrDefault(claim => claim.Key.StartsWith("tool:", StringComparison.Ordinal));
    }

    /// <summary>
    /// The upgrade-level range one claim value permits: `BasicOnly` is exactly the basic tool, and every other word -
    /// `AnyUpgrade` today - is every level. A word this Mod does not know says nothing about level, which is the same
    /// reading the Host publishes for the claim.
    ///
    /// <para>
    /// NO ACTION DECLARES `BasicOnly` ANY MORE, and the reason is worth keeping here: its old docblock said the native
    /// handlers "refuse an upgraded one by name". Checked against the game, that is backwards - `Pickaxe` refuses
    /// `UpgradeLevel &lt; 2` (it demands more than basic, and only for boulder tiles the target predicate excludes) and
    /// `Axe` refuses no upgrade level at all. So the range admitted exactly the tier the game rejects. The value is kept
    /// because the BodyProgram wire vocabulary carries it (`BodyProgramResourceTemplateValue.ToolBasicOnly`), so a
    /// persisted journal from a build that emitted it still reads; nothing produces it now.
    /// </para>
    /// </summary>
    private static (int Minimum, int Maximum) DeclaredToolUpgradeBounds(FarmhandResourceTemplateValue requirement) =>
        requirement switch
        {
            FarmhandResourceTemplateValue.BasicOnly => (0, 0),
            _ => (0, int.MaxValue),
        };

    /// <summary>
    /// Resolves one action's declared tool against the pack it is GIVEN: the slot whose tool satisfies the claim, or the
    /// NAMED reason nothing does. It reads the pack and never the held tool - holding an axe is not a reason a scythe
    /// action cannot run - and it mutates nothing, so a test can ask the same question with a synthetic pack.
    /// </summary>
    private static DeclaredToolResolution ResolveDeclaredTool(IList<Item?> items, string actionId)
    {
        FarmhandActionResourceTemplateClaim? claim = DeclaredToolClaim(actionId);
        if (claim is null)
            return new DeclaredToolResolution(string.Empty, -1, $"tool_requirement_undeclared:{actionId}");
        string category = claim.Key["tool:".Length..];
        (int minimum, int maximum) = DeclaredToolUpgradeBounds(claim.Value);
        int bestSlot = -1;
        int bestLevel = -1;
        int ownedLevel = -1;
        for (int slot = 0; slot < items.Count; slot++)
        {
            if (items[slot] is not Tool tool || !MatchesToolCategory(tool, category))
                continue;
            ownedLevel = Math.Max(ownedLevel, tool.UpgradeLevel);
            // The claim's tier decides which owned tool satisfies it; among those, the best one wins and ties go to the
            // smallest slot, which is the same ranking equip_tool resolves a category with.
            if (tool.UpgradeLevel < minimum || tool.UpgradeLevel > maximum)
                continue;
            if (tool.UpgradeLevel > bestLevel || (tool.UpgradeLevel == bestLevel && (bestSlot < 0 || slot < bestSlot)))
            {
                bestSlot = slot;
                bestLevel = tool.UpgradeLevel;
            }
        }
        if (bestSlot >= 0)
            return new DeclaredToolResolution(category, bestSlot, null);
        if (ownedLevel < 0)
            return new DeclaredToolResolution(category, -1, $"tool_not_owned:{category}");
        // Owned, but not at a level the claim permits: `need` is the claim's own floor and `have` the best owned one.
        return new DeclaredToolResolution(
            category,
            -1,
            $"tool_upgrade_insufficient:{category}:{minimum.ToString(CultureInfo.InvariantCulture)}:{ownedLevel.ToString(CultureInfo.InvariantCulture)}");
    }

    /// <summary>
    /// Takes the tool the action's registration declares as the actor's current INPUT, and saves the index that was
    /// held. Equipping in Stardew is input selection, not an action: `Farmer.CurrentTool` is `Items[CurrentToolIndex] as
    /// Tool`, so the native building-chest load already does exactly this - save `CurrentToolIndex`, hold the slot for
    /// the call, restore it afterwards (farmhandexecutioncontroller.buildingchestactions.cs:246-270). It spends no
    /// stamina, advances no time and mutates no world state, so its only failures are the pack's own.
    /// </summary>
    private static bool TrySelectDeclaredTool(
        Farmer farmer,
        string actionId,
        out DeclaredToolSelection selection,
        out string refusalCode)
    {
        selection = default;
        refusalCode = string.Empty;
        DeclaredToolResolution resolution = ResolveDeclaredTool(farmer.Items, actionId);
        if (resolution.RefusalCode is not null)
        {
            refusalCode = resolution.RefusalCode;
            return false;
        }
        Tool tool = (Tool)farmer.Items[resolution.Slot]!;
        int previousSlot = farmer.CurrentToolIndex;
        Tool? previousTool = previousSlot >= 0 && previousSlot < farmer.Items.Count ? farmer.Items[previousSlot] as Tool : null;
        farmer.CurrentToolIndex = resolution.Slot;
        // The switch's own postcondition: a handler must never swing whatever the switch left in hand.
        if (!ReferenceEquals(farmer.CurrentTool, tool))
        {
            farmer.CurrentToolIndex = previousSlot;
            refusalCode = $"tool_not_selected:{resolution.Category}";
            return false;
        }
        selection = new DeclaredToolSelection(tool, resolution.Category, resolution.Slot, previousSlot, previousTool);
        return true;
    }

    /// <summary>Puts the actor's own tool selection back: every exit after a selection restores it exactly once.</summary>
    private static void RestoreToolSelection(Farmer farmer, DeclaredToolSelection selection) =>
        farmer.CurrentToolIndex = selection.PreviousSlot;

    /// <summary>
    /// The category of whatever the actor is holding, in the vocabulary a `tool:&lt;category&gt;` claim speaks, or
    /// `none` when nothing is held or the held thing is not a tool this Mod can name - the one literal the Host
    /// accepts for the absent equipped tool.
    /// </summary>
    internal static string DescribeToolCategory(Tool? tool) => ToolCategory(tool) ?? "none";

    /// <summary>
    /// The evidence one refused `slot`-named tool request carries: the slot the caller named, what that slot ACTUALLY
    /// holds, what the actor is holding, and the slot the action's own claim selects (with that claim's refusal when
    /// nothing satisfies it). The refusal condition below collapses six different realities - no such index, an empty
    /// slot, a non-axe, an axe the actor is not holding, an upgraded axe, a held axe at another index - and the whole
    /// detail used to be `slot=N`, so the refused caller could not tell which of them to repair and had only another
    /// guess. Naming the four facts is the receipt's whole job here: the action still does not equip anything.
    /// </summary>
    private static string DescribeRequestedSlot(IList<Item?> items, int requestedSlot, int heldSlot, string actionId)
    {
        DeclaredToolResolution resolution = ResolveDeclaredTool(items, actionId);
        return $"slot={requestedSlot.ToString(CultureInfo.InvariantCulture)}"
            + $";holds={DescribeSlotOccupant(items, requestedSlot)}"
            + $";held={DescribeSlotOccupant(items, heldSlot)}"
            + $";tool_slot={(resolution.Slot >= 0 ? resolution.Slot.ToString(CultureInfo.InvariantCulture) : "none")}"
            + $";tool_refusal={resolution.RefusalCode ?? "none"}";
    }

    /// <summary>
    /// What one pack slot holds, in the vocabulary the published tool slots speak: a tool's claim category, a
    /// non-tool item's identity, `none` for an empty slot, and `out_of_range` for an index the pack does not have -
    /// "there is no slot 12" is a different repair from "slot 12 is empty".
    /// </summary>
    private static string DescribeSlotOccupant(IList<Item?> items, int slot)
    {
        if (slot < 0 || slot >= items.Count)
            return "out_of_range";
        return items[slot] switch
        {
            null => "none",
            Tool tool => ToolCategory(tool) ?? DescribeTool(tool) ?? "tool",
            Item item => item.QualifiedItemId,
        };
    }

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
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Axe axe || !ReferenceEquals(Game1.player.CurrentTool, axe))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "basic_axe_not_equipped_in_requested_slot", DescribeRequestedSlot(Game1.player.Items, slot, Game1.player.CurrentToolIndex, "chop_stump"));
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature) || feature is not StardewValley.TerrainFeatures.Tree tree
            || !tree.stump.Value
            || !string.Equals(BuildTreeStumpTargetId(location, targetX, targetY, tree), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "stump_target_changed", $"target={targetX},{targetY}");
        // 5.2: out of the native radius, walk in rather than refuse. Position-independent
        // checks above; the target is re-validated after the walk inside the closure.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1) || IsToolTargetUnderActor(Game1.player, targetX, targetY))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "chop_stump",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteChopStump(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteChopStump(executionId, requestId, slot, targetX, targetY, expectedTargetId);
    }

    /// <summary>
    /// Executes chop_stump against the current world, re-validating the tool and the
    /// target because an approach leg may have taken several ticks. Shared by the
    /// in-range path and the post-approach path so the two cannot drift.
    /// </summary>
    private LocalExecutionReceipt ExecuteChopStump(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Axe axe || !ReferenceEquals(Game1.player.CurrentTool, axe))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "basic_axe_not_equipped_in_requested_slot", DescribeRequestedSlot(Game1.player.Items, slot, Game1.player.CurrentToolIndex, "chop_stump"));
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
        // The stamina floor, checked BEFORE the first swing.
        //
        // The loop below cannot know how many swings it will need - a stump falls when its health reaches zero,
        // not when a budget says so - so the worst case it is willing to spend is the cap itself, and that is what
        // gets priced. Refusing when the worst case does not fit is the honest answer: the alternative is letting
        // the actor swing through to the engine's -15 pass-out, which halves next day's stamina and ends a multi-day
        // routine outright (`Game1.cs:6452`).
        ToolStaminaVerdict stamina = ToolStaminaGuard.Check(
            Game1.player.Stamina,
            ToolStaminaGuard.EstimatedCost(maximumSwingCount, Game1.player.ForagingLevel, axe.IsEfficient));
        if (!stamina.Allowed)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                stamina.ReasonCode,
                $"target={targetX},{targetY};tree_type={treeType};{stamina.Evidence};swings_worst_case={maximumSwingCount}");

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
        // Ask before walking: a pack that cannot satisfy the action's claim is refused now rather than after an approach
        // leg the action could never finish.
        if (ResolveDeclaredTool(Game1.player.Items, "cut_weeds").RefusalCode is { } toolRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusal, $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? probeWeed) || !probeWeed.IsWeeds()
            || !string.Equals(BuildWeedTargetId(location, targetX, targetY, probeWeed), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "weed_target_changed", $"target={targetX},{targetY}");
        // 5.2: out of the native radius, walk in rather than refuse. Position-independent
        // checks above; the target is re-validated after the walk inside the closure.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1) || IsToolTargetUnderActor(Game1.player, targetX, targetY))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "cut_weeds",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteCutWeeds(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteCutWeeds(executionId, requestId, slot, targetX, targetY, expectedTargetId);
    }

    /// <summary>
    /// Cut one grass tuft (the TerrainFeature `Grass`, not the Object-layer weeds)
    /// with an equipped scythe through the native
    /// <c>Grass.performToolAction(Tool, explosion, tile)</c> chain
    /// (<c>Grass.cs:365</c>), which deducts <c>numberOfWeeds</c> to zero and, on
    /// death, runs <c>TryDropItemsOnCut</c> (<c>Grass.cs:455</c>): grassType 1/7
    /// feeds Hay into a silo via <c>GameLocation.StoreHayInAnySilo</c>
    /// (<c>GameLocation.cs:16511</c>, 0 = fully stored, &gt;0 = silo-full remainder),
    /// grassType 6 drops rare items. The target tuft must remain the requested
    /// grass and the scythe must be the current tool; a removed tuft is the only
    /// success postcondition. No other TerrainFeature class is touched.
    /// </summary>
    public LocalExecutionReceipt RequestLocalCutGrass(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (ResolveDeclaredTool(Game1.player.Items, "cut_grass").RefusalCode is { } toolRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusal, $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? probeFeature) || probeFeature is not StardewValley.TerrainFeatures.Grass probeGrass
            || !string.Equals(BuildGrassTargetId(location, targetX, targetY, probeGrass), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "grass_target_changed", $"target={targetX},{targetY}");
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1) || IsToolTargetUnderActor(Game1.player, targetX, targetY))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "cut_grass",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteCutGrass(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteCutGrass(executionId, requestId, slot, targetX, targetY, expectedTargetId);
    }

    /// <summary>
    /// Executes cut_grass against the current world, re-validating the target because an approach leg may have taken
    /// several ticks. The tool is not the caller's to name: the action's own registration claims `tool:scythe`, so this
    /// selects the scythe it needs and restores the actor's own selection afterwards. Shared by the in-range path and
    /// the post-approach path so the two cannot drift.
    /// </summary>
    private LocalExecutionReceipt ExecuteCutGrass(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
        if (!TrySelectDeclaredTool(Game1.player, "cut_grass", out DeclaredToolSelection selection, out string toolRefusalCode))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusalCode, $"slot={slot}");
        Dictionary<string, string> evidence = ToolActionEvidence.SelectionFacts(selection);
        ExecutionState state;
        string reasonCode;
        try
        {
            if (selection.Tool is not MeleeWeapon weapon)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, $"tool_not_selected:{selection.Category}", $"slot={selection.Slot}");
            GameLocation location = Game1.player.currentLocation;
            Vector2 tile = new(targetX, targetY);
            if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature) || feature is not StardewValley.TerrainFeatures.Grass grass
                || !string.Equals(BuildGrassTargetId(location, targetX, targetY, grass), expectedTargetId, StringComparison.Ordinal))
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "grass_target_changed", $"target={targetX},{targetY}");

            int weedsBefore = grass.numberOfWeeds.Value;
            int grassType = grass.grassType.Value;
            float staminaBefore = Game1.player.Stamina;
            // A grass tuft usually holds 4 weeds; each native swing deducts 1 (basic
            // scythe (W)47), 2 ((W)53) or 4 ((W)66), and only the final swing that
            // crosses zero runs TryDropItemsOnCut and returns true. Keep swinging the
            // same equipped scythe on the same tuft until it is removed, the bounded
            // safety cap is reached, or the tuft leaves an unhandled state. Every swing
            // runs the native grass path (sound, shake, sprites, deductions).
            const int maximumSwingCount = 8;
            ToolStaminaVerdict grassStamina = ToolStaminaGuard.Check(
                Game1.player.Stamina,
                ToolStaminaGuard.PerSwingCharge(Game1.player.ForagingLevel, weapon.IsEfficient) * maximumSwingCount);
            if (!grassStamina.Allowed)
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    grassStamina.ReasonCode,
                    $"target={targetX},{targetY};{grassStamina.Evidence};swings_worst_case={maximumSwingCount}");
            int swingCount = 0;
            bool removed = false;
            while (!removed && swingCount < maximumSwingCount)
            {
                bool cut = grass.performToolAction(weapon, 0, tile);
                swingCount++;
                if (cut)
                {
                    location.terrainFeatures.Remove(tile);
                    removed = true;
                }
                else
                {
                    removed = !location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? afterFeature)
                        || !ReferenceEquals(afterFeature, grass);
                }
            }
            float staminaAfter = Game1.player.Stamina;
            float staminaDelta = staminaAfter - staminaBefore;
            // The scythe is a MeleeWeapon: no native code path deducts stamina for a
            // melee swing (only Axe/Hoe/Pickaxe/WateringCan/MilkPail/Shears do), so the
            // expected embodied cost is exactly zero, same as cut_weeds.
            float expectedStaminaCost = 0f;
            // Hay accounting is deliberately NOT recomputed here. This used to call
            // GameLocation.StoreHayInAnySilo to "observe" the cut — but that method is a
            // WRITE (GameLocation.cs:16511 does currentLocation.tryToAddHay(count) and
            // increments piecesOfHay), and the native cut already stored the hay inside
            // Grass.TryDropItemsOnCut (Grass.cs:489). Calling it again added 1-2 hay to a
            // silo on every successful cut — and added it even when the native probability
            // roll did not — silently polluting durable world state.
            //
            // The outcome of that roll is not observable from here without re-deriving it,
            // so the receipt reports only what actually changed and is true: the tuft is
            // gone (and the evidence key below says exactly that).
            evidence["target"] = expectedTargetId;
            evidence["type"] = "grass";
            evidence["tool"] = "scythe";
            evidence["grass_type"] = grassType.ToString(CultureInfo.InvariantCulture);
            evidence["weeds_before"] = weedsBefore.ToString(CultureInfo.InvariantCulture);
            evidence["weeds_after"] = removed
                ? "removed"
                : location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? remainingFeature) && remainingFeature is StardewValley.TerrainFeatures.Grass remainingGrass
                    ? remainingGrass.numberOfWeeds.Value.ToString(CultureInfo.InvariantCulture)
                    : "missing";
            evidence["swings"] = swingCount.ToString(CultureInfo.InvariantCulture);
            evidence["removed"] = removed.ToString().ToLowerInvariant();
            evidence["tuft_removed"] = removed.ToString().ToLowerInvariant();
            evidence["stamina_before"] = staminaBefore.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["stamina_after"] = staminaAfter.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["stamina_delta"] = staminaDelta.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["expected_stamina_cost"] = expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture);
            state = removed ? ExecutionState.Succeeded : ExecutionState.Uncertain;
            reasonCode = removed ? "grass_cut" : "grass_cut_postcondition_unavailable";
        }
        finally
        {
            RestoreToolSelection(Game1.player, selection);
            evidence["tool_restored"] = DescribeToolCategory(Game1.player.CurrentTool);
        }
        return this.RememberTerminal(requestId, executionId, state, reasonCode, ToolActionEvidence.Compose(ToolActionEvidence.CutGrass, evidence));
    }

    /// <summary>
    /// Executes cut_weeds against the current world, re-validating the target because an approach leg may have taken
    /// several ticks. The tool is not the caller's to name: the action's own registration claims `tool:scythe`, so this
    /// selects the scythe it needs and restores the actor's own selection afterwards. Shared by the in-range path and
    /// the post-approach path so the two cannot drift.
    /// </summary>
    private LocalExecutionReceipt ExecuteCutWeeds(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
        if (!TrySelectDeclaredTool(Game1.player, "cut_weeds", out DeclaredToolSelection selection, out string toolRefusalCode))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusalCode, $"slot={slot}");
        Dictionary<string, string> evidence = ToolActionEvidence.SelectionFacts(selection);
        ExecutionState state;
        string reasonCode;
        try
        {
            if (selection.Tool is not MeleeWeapon weapon)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, $"tool_not_selected:{selection.Category}", $"slot={selection.Slot}");
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
            // Scythe work is free (`PerSwingCharge` returns 0 for a scythe-like tool only when efficient), but the
            // guard is still asked: a future tool change that starts charging must not silently skip the floor, and
            // the answer costs nothing when the charge is zero.
            ToolStaminaVerdict weedStamina = ToolStaminaGuard.Check(
                Game1.player.Stamina,
                ToolStaminaGuard.PerSwingCharge(Game1.player.FarmingLevel, weapon.IsEfficient) * maximumSwingCount);
            if (!weedStamina.Allowed)
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    weedStamina.ReasonCode,
                    $"target={targetX},{targetY};{weedStamina.Evidence};swings_worst_case={maximumSwingCount}");
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
            evidence["target"] = expectedTargetId;
            evidence["type"] = "weed";
            evidence["tool"] = "scythe";
            evidence["qualified_item_id"] = weed.QualifiedItemId;
            evidence["health_before"] = healthBefore.ToString(CultureInfo.InvariantCulture);
            evidence["health_after"] = removed
                ? "removed"
                : location.objects.TryGetValue(tile, out StardewValley.Object? remainingWeed) && remainingWeed is not null
                    ? remainingWeed.MinutesUntilReady.ToString(CultureInfo.InvariantCulture)
                    : "missing";
            evidence["swings"] = swingCount.ToString(CultureInfo.InvariantCulture);
            evidence["removed"] = removed.ToString().ToLowerInvariant();
            evidence["stamina_before"] = staminaBefore.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["stamina_after"] = staminaAfter.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["stamina_delta"] = staminaDelta.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["expected_stamina_cost"] = expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture);
            state = handled && removed ? ExecutionState.Succeeded : ExecutionState.Uncertain;
            reasonCode = handled && removed ? "weeds_cut" : "weed_cut_postcondition_unavailable";
        }
        finally
        {
            RestoreToolSelection(Game1.player, selection);
            evidence["tool_restored"] = DescribeToolCategory(Game1.player.CurrentTool);
        }
        return this.RememberTerminal(requestId, executionId, state, reasonCode, ToolActionEvidence.Compose(ToolActionEvidence.CutWeeds, evidence));
    }

    private static int ItemRankForWeapon(Tool item)
    {
        if (item is MeleeWeapon melee)
            return melee.getItemLevel();
        return item is Slingshot ? 1 : 0;
    }

    /// <summary>
    /// Begins the shared approach leg for a tool-family action whose target is
    /// outside the native interaction radius.
    ///
    /// Why walking is the player-equivalent behaviour and not a Mod convenience:
    /// the native click path gates interaction on the same Chebyshev-1 radius
    /// (<c>Game1.cs:11509</c> requires <c>tileWithinRadiusOfPlayer(grabTile, 1)</c>
    /// before <c>checkAction</c>; <c>GameLocation.cs:14233</c> dims the cursor for a
    /// reachable-but-out-of-range target; <c>Character.GetToolLocation</c>
    /// (<c>:1218-1228</c>) only returns the clicked tile when it is within that
    /// radius, otherwise it swings at the tile in front). A real player therefore
    /// must walk into range; this leg does exactly that.
    ///
    /// The walk uses the arrival predicate with <c>AllowAdjacentArrival: true</c>,
    /// so it stops on any Chebyshev-1 tile and the subsequent tool call re-enters
    /// the same native path a standing player would use. The completion pass in
    /// <see cref="Update"/> re-validates the world (the target may be gone or the
    /// tool may have changed while walking) before executing anything, and reports
    /// the unchanged <c>target_out_of_reach</c> refusal when the walk cannot be
    /// planned at all.
    /// </summary>
    /// <summary>
    /// Begins an approach leg for an action that found itself outside the native interaction radius, and returns the
    /// honest `Accepted` receipt. Works for a target of one tile or of several.
    ///
    /// The action has already validated everything that does not depend on position (its tool, its target identity),
    /// so this owns only the geometry and the ownership bookkeeping. `onArrival` runs later from the completion pass
    /// and mints the action's terminal; it must re-validate, because the walk can take several ticks.
    ///
    /// <para>
    /// <paramref name="footprint"/> is the full occupied tile set and is used for exactly ONE decision: which tile the
    /// actor stands on. The anchor alone was not enough, because a 2x2 clump at (5,5) is worked from (5,7) - the tile
    /// a farmer standing SOUTH of it occupies - and that tile is outside the anchor's eight-neighbour ring, so the
    /// south face was unreachable by construction and the walk went round behind the obstacle.
    /// </para>
    /// <para>
    /// The walk is dispatched to the footprint tile the chosen standing tile reaches, not to the anchor, because
    /// arrival is re-checked against the native Chebyshev-1 interaction radius. From (5,7) the tile reached is (5,6);
    /// measured against the anchor (5,5) the same arrival reads Chebyshev-2 and is refused `target_out_of_reach`
    /// after a walk that landed exactly where it was sent.
    /// </para>
    /// </summary>
    /// <param name="actionId">The wire action id, republished in snapshots.</param>
    private LocalExecutionReceipt TryBeginToolApproach(
        string requestId,
        string executionId,
        string actionId,
        GameLocation location,
        (int X, int Y) anchor,
        System.Collections.Generic.IReadOnlyList<(int X, int Y)> footprint,
        string expectedTargetId,
        Func<string, string, LocalExecutionReceipt> onArrival,
        long nowMs,
        long requestedDeadlineMs)
    {
        int deadlineTicks = Math.Max(1, (int)Math.Ceiling((requestedDeadlineMs - nowMs) * 60d / 1000d));
        // WHERE the actor stands is decided BEFORE the walk is committed.
        //
        // This used to hand the target tile itself to the native finder with
        // `adjacentArrival`, i.e. ask it to discover one of the eight neighbours for us: a
        // four-way search, hard-capped at 10 000 expansions, that on a large farm exhausts
        // and answers `no_native_path` for a target whose free approach was two steps away.
        // Measured 2026-10-25: five such refusals in one run, one of them followed by a
        // 57-second gap between the refusal and the next executable action.
        //
        // The two predicates are separate because they answer different questions: "is this tile
        // free" and "is it in the actor's own walkable component".
        Func<(int X, int Y), bool> isStandable = tile =>
            // OBJECT occupancy, not walkability. `IsWalkableTile` asks whether an actor may cross a tile, and a rock is an
            // object on a walkable tile - so it answered yes for the rock's own tile and the approach walk stood ON the target.
            // Measured 2026-10-26: 28 of 28 approach receipts read `tile === target`.
            //
            // A warp tile is not standable EITHER, and that is the one place design §3.1.1 forbids it: crossing one
            // is legal and `enter_exit` targeting one is legal, but an actor who buffers here is warped the moment
            // its box reaches the tile - so a step-out that chose one would teleport the companion instead of
            // moving it half a step. Excluding it from THIS predicate keeps the rule in one place: every walk this
            // seam dispatches stops somewhere a body may actually stop.
            StardewBodyController.IsStandableTile(location, Game1.player, new Vector2(tile.X, tile.Y))
            && !IsWarpBufferTile(location, tile);
        (int X, int Y) actor = ((int)Game1.player.Tile.X, (int)Game1.player.Tile.Y);
        // The hollow ring: the actor is standing ON the target, so there is no tile to swing at - the swing would
        // land on the body's own tile. A step-out is the correction, and its destination is chosen by the same
        // selector as any other approach. Single-tile targets only: a multi-tile footprint needs "the actor stands on
        // ANY occupied tile", which is a separate change with its own acceptance.
        bool actorOnTarget = footprint.Count == 1 && actor == footprint[0];
        (int X, int Y)? standingTile = SelectToolApproachTile(
            footprint,
            actor,
            isStandable,
            // An undecided component (the flood exceeded its budget) must not be read as
            // "nothing is reachable": that would refuse a walk the planner would have made.
            // Undecided keeps the geometry deciding and lets the finder answer.
            StardewBodyController.BuildWalkableComponent(location, Game1.player) is { } component
                ? tile => component(new Vector2(tile.X, tile.Y))
                : _ => true);
        if (standingTile is null)
        {
            if (actorOnTarget)
            {
                // Acceptance (b): nowhere to step out. Every ring tile is occupied or is a warp buffer, so the honest
                // answer is a refusal that names the HOLLOW RING. It must not be `no_reachable_approach` (which would
                // tell the agent the target is unreachable while it is in fact underfoot) and it must not be a forced
                // move onto an occupied or warping tile.
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    "hollow_ring_no_step_out",
                    DescribeNoReachableApproach(anchor, actor, isStandable, footprint).Evidence
                        + ";hollow_ring=true;step_out=none");
            }

            // Nothing is dispatched: no walk is committed for a placement the actor cannot
            // reach, so the refusal arrives before the engine spends its search budget.
            (string refusalCode, string refusalEvidence) = DescribeNoReachableApproach(
                anchor, actor, isStandable, footprint);
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, refusalCode, refusalEvidence);
        }
        (int X, int Y) goal = standingTile.Value;
        // The tile the arrival must be measured against: for a single-tile target the target itself, so every existing
        // caller dispatches exactly the coordinate it always did. See SelectReachTile for why a multi-tile target's
        // anchor is the wrong measurement.
        (int X, int Y) reach = footprint.Count == 1 ? footprint[0] : SelectReachTile(footprint, goal);
        int targetX = reach.X;
        int targetY = reach.Y;
        LocalMoveSpec approach = new(
            executionId,
            requestId,
            new Vector2(goal.X, goal.Y),
            // Exact arrival on the chosen tile, not adjacency to it: the tile is standable and
            // reachable by construction, so a plan to it exists, and finishing anywhere in its
            // ring could leave the actor Chebyshev-2 from the target — outside the native
            // interaction radius this walk exists to satisfy.
            false,
            this.revision,
            this.tick + deadlineTicks,
            requestedDeadlineMs);
        this.activeToolApproach = new LocalApproachSpec(
            executionId,
            requestId,
            actionId,
            location.NameOrUniqueName,
            targetX,
            targetY,
            expectedTargetId,
            onArrival,
            this.revision,
            requestedDeadlineMs);
        this.active = approach;
        if (!this.controller.TryStart(approach, Game1.player, this.tick, out string reasonCode, out string? approachEvidence))
        {
            this.active = null;
            this.activeToolApproach = null;
            // A target the native planner cannot even approach keeps the same
            // honest refusal the in-range path would produce: the tile exists but
            // the actor cannot get to it. `target_out_of_reach` is already the
            // vocabulary the tool family uses for "reachable in principle, too far
            // right now", and a failed route is exactly that fact.
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                reasonCode == "no_native_path" ? "target_out_of_reach" : reasonCode,
                approachEvidence ?? $"target={targetX},{targetY};reach=1");
        }

        string distance = ChebyshevDistance(Game1.player, targetX, targetY).ToString(CultureInfo.InvariantCulture);
        // `tile` is the footprint tile the arrival is measured against, which for a multi-tile target is not the
        // anchor the caller named. Say so here rather than leaving a reader to wonder why the two differ; the
        // anchor inside `target` is the opaque clump identity's own business.
        string reached = footprint.Count == 1
            ? string.Empty
            : $";anchor={anchor.X},{anchor.Y};reached=footprint";
        // A step-out is advertised as one. Both ends are named, so a reader can tell a correction from a walk that
        // happened to begin beside the target - and so the L1 fixture can assert the actor actually moved.
        string steppedOut = actorOnTarget
            ? $";stepped_out_from={actor.X},{actor.Y};stepped_out_to={goal.X},{goal.Y}"
            : string.Empty;
        LocalExecutionReceipt accepted = new(
            executionId,
            requestId,
            ExecutionState.Accepted,
            "accepted",
            this.revision,
            $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};distance={distance};reach=1;approach=adjacent;standing={goal.X},{goal.Y}{reached}{steppedOut}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    /// <summary>
    /// The one-tile form every other family calls: the target is its own footprint. Written after the multi-tile body
    /// so the body the approach tests locate by its own signature stays the first match in this file.
    /// </summary>
    private LocalExecutionReceipt TryBeginToolApproach(
        string requestId,
        string executionId,
        string actionId,
        GameLocation location,
        int targetX,
        int targetY,
        string expectedTargetId,
        Func<string, string, LocalExecutionReceipt> onArrival,
        long nowMs,
        long requestedDeadlineMs) =>
        this.TryBeginToolApproach(
            requestId,
            executionId,
            actionId,
            location,
            (targetX, targetY),
            new[] { (targetX, targetY) },
            expectedTargetId,
            onArrival,
            nowMs,
            requestedDeadlineMs);

    /// <summary>
    /// Completes a tool-family approach: re-validates the world and then runs the
    /// kind-specific native call.
    ///
    /// Called from the Update pass only once the body is free
    /// (<c>this.active is null &amp;&amp; !controller.HasActiveExecution</c>). Every
    /// kind performs the same three steps: re-check that the actor is actually in
    /// range (the walk may have been interrupted), re-validate the target identity
    /// (it may have been removed or replaced), then execute. A target that no
    /// longer matches settles as the kind's own `*_target_changed` refusal rather
    /// than silently doing nothing.
    /// </summary>
    private void CompleteToolApproach(LocalApproachSpec specification)
    {
        this.activeToolApproach = null;

        GameLocation? location = Game1.player.currentLocation;
        bool sameLocation = location is not null
            && string.Equals(location.NameOrUniqueName, specification.Location, StringComparison.Ordinal);
        if (!sameLocation)
        {
            this.revision++;
            LocalExecutionReceipt moved = new(specification.ExecutionId, specification.RequestId, ExecutionState.Rejected, "tool_approach_location_changed", this.revision,
                $"target={specification.ExpectedTargetId};expected={specification.Location};actual={location?.NameOrUniqueName ?? "none"}");
            this.Remember(moved);
            this.AddTrace(moved);
            this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            return;
        }

        if (!IsTileWithinChebyshevRadius(Game1.player, specification.TargetX, specification.TargetY, 1))
        {
            this.revision++;
            LocalExecutionReceipt short_ = new(specification.ExecutionId, specification.RequestId, ExecutionState.Rejected, "target_out_of_reach", this.revision,
                $"target={specification.TargetX},{specification.TargetY};distance={ChebyshevDistance(Game1.player, specification.TargetX, specification.TargetY).ToString(CultureInfo.InvariantCulture)};reach=1;approach=did_not_arrive");
            this.Remember(short_);
            this.AddTrace(short_);
            this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            return;
        }

        // The hollow ring again, now that the walk is over. Reach alone cannot answer this: distance ZERO is
        // inside the native radius, so a step-out that did not move - a blocked ring resolved by a superseded
        // walk, an actor shoved back onto the target by a passing NPC - would be admitted and swing at its own
        // feet. The step-out either moved the body or this refuses by the name of that failure.
        if (IsToolTargetUnderActor(Game1.player, specification.TargetX, specification.TargetY))
        {
            this.revision++;
            LocalExecutionReceipt unmoved = new(specification.ExecutionId, specification.RequestId, ExecutionState.Rejected, "hollow_ring_step_out_failed", this.revision,
                $"target={specification.TargetX},{specification.TargetY};tile={FormatTile(Game1.player.Tile)};reach=1;approach=did_not_arrive;hollow_ring=true;step_out=failed");
            this.Remember(unmoved);
            this.AddTrace(unmoved);
            this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            return;
        }

        // The action's own terminal step. It re-validates its tool and target and
        // mints the receipt, so the post-approach path and the in-range path share
        // one execution body per action.
        _ = specification.Execute(specification.ExecutionId, specification.RequestId);
    }

}

/// <summary>What one action's pack answers for its declared tool, before anything is switched.</summary>
internal readonly record struct DeclaredToolResolution(string Category, int Slot, string? RefusalCode);

/// <summary>
/// The actor's tool selection while one action runs: the tool taken, the category it satisfies, the index it
/// replaced, and the tool that index held - which is what every exit restores and what the receipt reports.
/// </summary>
internal readonly record struct DeclaredToolSelection(Tool Tool, string Category, int Slot, int PreviousSlot, Tool? PreviousTool);

/// <summary>
/// The receipt-detail key set of each tool action, stated ONCE per action.
///
/// The Host pins every one of these sets EXACTLY (`host/src/stardew-game-integration-adapter.ts`: the `cut_weeds` and
/// `cut_grass` branches, `hasWaterCropCompletionEvidence`, `hasBreakRockSourceCompletionEvidence`), so a success with
/// an unexpected key - or without one - is a success the Host does not recognise.
///
/// The tool-selection keys are written by the side that performs the fact: `ToolActionEvidence.SelectionFacts` states
/// what the handler took while that tool is in hand, and `tool_restored` is written only after
/// `RestoreToolSelection` has actually run. A run that dies between the two emits no `tool_restored` rather than
/// claiming a restore it did not perform.
/// </summary>
internal static class ToolActionEvidence
{
    internal static readonly IReadOnlyList<string> CutWeeds = Array.AsReadOnly(new[]
    {
        "target", "type", "tool", "tool_selected", "slot", "tool_before", "slot_before", "qualified_item_id",
        "health_before", "health_after", "swings", "removed", "stamina_before", "stamina_after", "stamina_delta",
        "expected_stamina_cost", "tool_restored",
    });

    internal static readonly IReadOnlyList<string> CutGrass = Array.AsReadOnly(new[]
    {
        "target", "type", "tool", "tool_selected", "slot", "tool_before", "slot_before", "grass_type",
        "weeds_before", "weeds_after", "swings", "removed", "tuft_removed", "stamina_before", "stamina_after",
        "stamina_delta", "expected_stamina_cost", "tool_restored",
    });

    internal static readonly IReadOnlyList<string> BreakRockSource = Array.AsReadOnly(new[]
    {
        "target", "tool", "tool_selected", "slot", "tool_before", "slot_before", "qualified_item_id",
        "durability_before", "durability_after", "removed", "stamina_before", "stamina_after", "stamina_delta",
        "expected_stamina_cost", "tool_restored",
    });

    internal static readonly IReadOnlyList<string> WaterCrop = Array.AsReadOnly(new[]
    {
        "location", "target", "tile", "tool_selected", "slot", "tool_before", "slot_before", "before_watered",
        "after_watered", "water_before", "water_after", "water_consumed", "stamina_before", "stamina_after",
        "stamina_delta", "expected_stamina_cost", "tool_restored",
    });

    /// <summary>
    /// The selection half of one action's detail: the tool the handler took, the slot it came from, and the tool and
    /// slot it displaced. `slot` is the one the SELECTION put in hand, never the number a request carried.
    /// </summary>
    internal static Dictionary<string, string> SelectionFacts(DeclaredToolSelection selection) => new()
    {
        ["tool_selected"] = selection.Category,
        ["slot"] = selection.Slot.ToString(CultureInfo.InvariantCulture),
        ["tool_before"] = ExecutionManager.DescribeToolCategory(selection.PreviousTool),
        ["slot_before"] = selection.PreviousSlot.ToString(CultureInfo.InvariantCulture),
    };

    /// <summary>
    /// One receipt detail from a key list and its values, in the LIST's order: the list is the contract, so a key that
    /// has no value fails here instead of reaching the wire as a half-built detail.
    /// </summary>
    internal static string Compose(IReadOnlyList<string> keys, IReadOnlyDictionary<string, string> values) =>
        string.Join(";", keys.Select(key => $"{key}={values[key]}"));
}
