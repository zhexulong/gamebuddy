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
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Axe axe || !ReferenceEquals(Game1.player.CurrentTool, axe) || axe.UpgradeLevel != 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "basic_axe_not_equipped_in_requested_slot", $"slot={slot}");
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
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
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
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Pickaxe pickaxe || !ReferenceEquals(Game1.player.CurrentTool, pickaxe) || pickaxe.UpgradeLevel != 0) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "basic_pickaxe_not_equipped_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? rock) || !NativeItemPredicates.IsOneHitBreakableStone(rock) || !string.Equals(BuildRockSourceTargetId(location, targetX, targetY, rock), expectedTargetId, StringComparison.Ordinal)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "rock_target_changed", $"target={targetX},{targetY}");
        // 5.2: out of the native radius, walk in rather than refuse. Position-independent
        // checks above; the target is re-validated after the walk inside the closure.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
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
    /// Executes break_rock_source against the current world, re-validating the tool
    /// and the target because an approach leg may have taken several ticks. Shared by
    /// the in-range path and the post-approach path so the two cannot drift.
    /// </summary>
    private LocalExecutionReceipt ExecuteBreakRockSource(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
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
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
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
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
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
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not Axe axe || !ReferenceEquals(Game1.player.CurrentTool, axe))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "basic_axe_not_equipped_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature) || feature is not StardewValley.TerrainFeatures.Tree tree
            || !tree.stump.Value
            || !string.Equals(BuildTreeStumpTargetId(location, targetX, targetY, tree), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "stump_target_changed", $"target={targetX},{targetY}");
        // 5.2: out of the native radius, walk in rather than refuse. Position-independent
        // checks above; the target is re-validated after the walk inside the closure.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
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
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not MeleeWeapon probeWeapon || !probeWeapon.isScythe() || !ReferenceEquals(Game1.player.CurrentTool, probeWeapon))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "scythe_not_equipped_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? probeWeed) || !probeWeed.IsWeeds()
            || !string.Equals(BuildWeedTargetId(location, targetX, targetY, probeWeed), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "weed_target_changed", $"target={targetX},{targetY}");
        // 5.2: out of the native radius, walk in rather than refuse. Position-independent
        // checks above; the target is re-validated after the walk inside the closure.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
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
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not MeleeWeapon probeWeapon || !probeWeapon.isScythe() || !ReferenceEquals(Game1.player.CurrentTool, probeWeapon))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "scythe_not_equipped_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? probeFeature) || probeFeature is not StardewValley.TerrainFeatures.Grass probeGrass
            || !string.Equals(BuildGrassTargetId(location, targetX, targetY, probeGrass), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "grass_target_changed", $"target={targetX},{targetY}");
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
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
    /// Executes cut_grass against the current world, re-validating the tool and the
    /// target because an approach leg may have taken several ticks. Shared by the
    /// in-range path and the post-approach path so the two cannot drift.
    /// </summary>
    private LocalExecutionReceipt ExecuteCutGrass(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.CurrentToolIndex != slot || Game1.player.Items[slot] is not MeleeWeapon weapon || !weapon.isScythe() || !ReferenceEquals(Game1.player.CurrentTool, weapon))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "scythe_not_equipped_in_requested_slot", $"slot={slot}");
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
        // StoreHayInAnySilo returns the count it could NOT store (0 = all stored).
        int hayUnstored = 0;
        if (removed && (grassType == 1 || grassType == 7))
        {
            // The native path sampled a probability roll already; this read is the
            // post-cut hay accounting the native player sees via the HUD. We mirror
            // the same silo query the native path uses to report what happened.
            int hayProduced = grassType == 7 ? 2 : 1;
            hayUnstored = GameLocation.StoreHayInAnySilo(hayProduced, location);
        }
        string evidence = $"target={expectedTargetId};type=grass;tool=scythe;grass_type={grassType};weeds_before={weedsBefore};weeds_after={(removed ? "removed" : location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? remainingFeature) && remainingFeature is StardewValley.TerrainFeatures.Grass remainingGrass ? remainingGrass.numberOfWeeds.Value.ToString(CultureInfo.InvariantCulture) : "missing")};swings={swingCount};removed={removed.ToString().ToLowerInvariant()};hay_unstored={hayUnstored};stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture)}";
        return removed
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "grass_cut", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "grass_cut_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// Executes cut_weeds against the current world, re-validating the tool and the
    /// target because an approach leg may have taken several ticks. Shared by the
    /// in-range path and the post-approach path so the two cannot drift.
    /// </summary>
    private LocalExecutionReceipt ExecuteCutWeeds(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
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
    /// Begins an approach leg for an action that found itself outside the native
    /// interaction radius, and returns the honest `Accepted` receipt.
    ///
    /// The action has already validated everything that does not depend on position
    /// (its tool, its target identity), so this only owns the geometry and the
    /// ownership bookkeeping. `onArrival` runs later, from the completion pass, and
    /// mints the action's terminal.
    /// </summary>
    /// <param name="actionId">The wire action id, republished in snapshots.</param>
    /// <param name="onArrival">
    /// Receives (executionId, requestId) and runs the action's terminal step. It must
    /// re-validate the tool and the target, because the walk can take several ticks.
    /// </param>
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
        long requestedDeadlineMs)
    {
        int deadlineTicks = Math.Max(1, (int)Math.Ceiling((requestedDeadlineMs - nowMs) * 60d / 1000d));
        LocalMoveSpec approach = new(
            executionId,
            requestId,
            new Vector2(targetX, targetY),
            true,
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
        LocalExecutionReceipt accepted = new(
            executionId,
            requestId,
            ExecutionState.Accepted,
            "accepted",
            this.revision,
            $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};distance={distance};reach=1;approach=adjacent");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

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

        // The action's own terminal step. It re-validates its tool and target and
        // mints the receipt, so the post-approach path and the in-range path share
        // one execution body per action.
        _ = specification.Execute(specification.ExecutionId, specification.RequestId);
    }

}
