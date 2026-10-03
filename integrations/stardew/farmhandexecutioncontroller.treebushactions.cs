using System.Globalization;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalHarvestBush(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        if (!TryGetHarvestableBush(location, targetX, targetY, expectedTargetId, out StardewValley.TerrainFeatures.Bush? bush))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "bush_target_changed", $"target={targetX},{targetY}");
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
        {
            return this.TryBeginToolApproach(requestId, executionId, "harvest_bush", location, targetX, targetY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteHarvestBush(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId), nowMs, requestedDeadlineMs);
        }
        return this.ExecuteHarvestBush(executionId, requestId, targetX, targetY, expectedTargetId);
    }

    private LocalExecutionReceipt ExecuteHarvestBush(string executionId, string requestId, int targetX, int targetY, string expectedTargetId)
    {
        GameLocation location = Game1.player.currentLocation;
        if (!TryGetHarvestableBush(location, targetX, targetY, expectedTargetId, out StardewValley.TerrainFeatures.Bush? bush))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "bush_target_changed", $"target={targetX},{targetY}");

        int debrisBefore = location.debris.Count;
        bush!.shakeTimer = 0f;
        bush.performUseAction(new Vector2(targetX, targetY));
        int debrisAfter = location.debris.Count;
        bool droppedItem = debrisAfter > debrisBefore && location.debris.Skip(debrisBefore).Any(entry => entry?.item is not null);
        string evidence = $"target={expectedTargetId};tile={targetX},{targetY};debris_before={debrisBefore};debris_after={debrisAfter};item_dropped={droppedItem.ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, droppedItem ? ExecutionState.Succeeded : ExecutionState.Uncertain,
            droppedItem ? "bush_harvested" : "bush_harvest_postcondition_unavailable", evidence);
    }

    private static bool TryGetHarvestableBush(GameLocation location, int x, int y, string expectedTargetId, out StardewValley.TerrainFeatures.Bush? bush)
    {
        bush = null;
        Vector2 tile = new(x, y);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
            || feature is not StardewValley.TerrainFeatures.Bush candidate
            || candidate.tileSheetOffset.Value != 1
            || !candidate.inBloom() || !candidate.readyForHarvest()
            || !string.Equals(BuildBushTargetId(location, x, y, candidate), expectedTargetId, StringComparison.Ordinal))
            return false;
        bush = candidate;
        return true;
    }

    public LocalExecutionReceipt RequestLocalHarvestFruitTree(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        GameLocation location = Game1.player.currentLocation;
        if (!TryGetHarvestableFruitTree(location, targetX, targetY, expectedTargetId, out StardewValley.TerrainFeatures.FruitTree? tree))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "fruit_tree_target_changed", $"target={targetX},{targetY}");
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "harvest_fruit_tree", location, targetX, targetY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteHarvestFruitTree(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId), nowMs, requestedDeadlineMs);
        return this.ExecuteHarvestFruitTree(executionId, requestId, targetX, targetY, expectedTargetId);
    }

    private LocalExecutionReceipt ExecuteHarvestFruitTree(string executionId, string requestId, int targetX, int targetY, string expectedTargetId)
    {
        GameLocation location = Game1.player.currentLocation;
        if (!TryGetHarvestableFruitTree(location, targetX, targetY, expectedTargetId, out StardewValley.TerrainFeatures.FruitTree? tree))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "fruit_tree_target_changed", $"target={targetX},{targetY}");
        int debrisBefore = location.debris.Count;
        tree!.performUseAction(new Vector2(targetX, targetY));
        int debrisAfter = location.debris.Count;
        bool fruitDropped = debrisAfter > debrisBefore && location.debris.Skip(debrisBefore).Any(entry => entry?.item is not null);
        string evidence = $"target={expectedTargetId};tile={targetX},{targetY};debris_before={debrisBefore};debris_after={debrisAfter};fruit_dropped={fruitDropped.ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, fruitDropped ? ExecutionState.Succeeded : ExecutionState.Uncertain,
            fruitDropped ? "fruit_tree_harvested" : "fruit_tree_harvest_postcondition_unavailable", evidence);
    }

    private static bool TryGetHarvestableFruitTree(GameLocation location, int x, int y, string expectedTargetId, out StardewValley.TerrainFeatures.FruitTree? tree)
    {
        tree = null;
        Vector2 tile = new(x, y);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
            || feature is not StardewValley.TerrainFeatures.FruitTree fruitTree
            || !fruitTree.IsInSeasonHere()
            || !fruitTree.fruit.Any(item => item is not null)
            || !string.Equals(BuildFruitTreeTargetId(location, x, y, fruitTree), expectedTargetId, StringComparison.Ordinal)) return false;
        tree = fruitTree;
        return true;
    }

    private static IReadOnlyList<BridgeFruitTreeTarget> DiscoverFruitTreeTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeFruitTreeTarget>();
        List<BridgeFruitTreeTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs)
        {
            if (pair.Value is not StardewValley.TerrainFeatures.FruitTree fruitTree ||
                !fruitTree.IsInSeasonHere() || !fruitTree.fruit.Any(item => item is not null)
                || (int)pair.Key.X < 0 || (int)pair.Key.X > 1000 || (int)pair.Key.Y < 0 || (int)pair.Key.Y > 1000
                || !IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)) continue;
            result.Add(new BridgeFruitTreeTarget(BuildFruitTreeTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, fruitTree), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y));
            if (result.Count >= 16) break;
        }
        return result;
    }

    private static string BuildFruitTreeTargetId(GameLocation location, int x, int y, StardewValley.TerrainFeatures.FruitTree tree)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:fruit_tree:{tree.treeId.Value}:{tree.growthStage.Value}:{tree.fruit.Count}";
        return $"fruit_tree_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    public LocalExecutionReceipt RequestLocalShakeTree(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        GameLocation location = Game1.player.currentLocation;
        if (!TryGetShakeableTree(location, targetX, targetY, expectedTargetId, out StardewValley.TerrainFeatures.Tree? tree))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "shake_tree_target_changed", $"target={targetX},{targetY}");
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "shake_tree", location, targetX, targetY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteShakeTree(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId), nowMs, requestedDeadlineMs);
        return this.ExecuteShakeTree(executionId, requestId, targetX, targetY, expectedTargetId);
    }

    private LocalExecutionReceipt ExecuteShakeTree(string executionId, string requestId, int targetX, int targetY, string expectedTargetId)
    {
        GameLocation location = Game1.player.currentLocation;
        if (!TryGetShakeableTree(location, targetX, targetY, expectedTargetId, out StardewValley.TerrainFeatures.Tree? tree))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "shake_tree_target_changed", $"target={targetX},{targetY}");
        bool seedBefore = tree!.hasSeed.Value;
        bool shakenBefore = tree!.wasShakenToday.Value;
        if (!seedBefore || shakenBefore)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tree_not_shakeable_today", $"target={expectedTargetId};has_seed={seedBefore};shaken_today={shakenBefore}");
        tree.performUseAction(new Vector2(targetX, targetY));
        bool seedAfter = tree.hasSeed.Value;
        bool shakenAfter = tree.wasShakenToday.Value;
        bool succeeded = !seedAfter && shakenAfter;
        string evidence = $"target={expectedTargetId};tile={targetX},{targetY};has_seed_before={seedBefore.ToString().ToLowerInvariant()};has_seed_after={seedAfter.ToString().ToLowerInvariant()};shaken_today={shakenAfter.ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain,
            succeeded ? "tree_shaken" : "tree_shake_postcondition_unavailable", evidence);
    }

    private static bool TryGetShakeableTree(GameLocation location, int x, int y, string expectedTargetId, out StardewValley.TerrainFeatures.Tree? tree)
    {
        tree = null;
        Vector2 tile = new(x, y);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
            || feature is not StardewValley.TerrainFeatures.Tree candidate || candidate.stump.Value
            || !candidate.hasSeed.Value || candidate.wasShakenToday.Value
            || !string.Equals(BuildShakeTreeTargetId(location, x, y, candidate), expectedTargetId, StringComparison.Ordinal)) return false;
        tree = candidate;
        return true;
    }

    private static IReadOnlyList<BridgeShakeTreeTarget> DiscoverShakeTreeTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeShakeTreeTarget>();
        List<BridgeShakeTreeTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs)
        {
            if (pair.Value is not StardewValley.TerrainFeatures.Tree tree || tree.stump.Value || !tree.hasSeed.Value || tree.wasShakenToday.Value
                || (int)pair.Key.X < 0 || (int)pair.Key.X > 1000 || (int)pair.Key.Y < 0 || (int)pair.Key.Y > 1000
                || !IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)) continue;
            result.Add(new BridgeShakeTreeTarget(BuildShakeTreeTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, tree), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y));
            if (result.Count >= 16) break;
        }
        return result;
    }

    private static string BuildShakeTreeTargetId(GameLocation location, int x, int y, StardewValley.TerrainFeatures.Tree tree)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:shake_tree:{tree.treeType.Value}:{tree.growthStage.Value}";
        return $"shake_tree_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgeBushTarget> DiscoverBushTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeBushTarget>();
        List<BridgeBushTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs)
        {
            if (result.Count >= 32) break;
            if (pair.Value is not StardewValley.TerrainFeatures.Bush bush
                || bush.tileSheetOffset.Value != 1 || !bush.inBloom() || !bush.readyForHarvest()
                || (int)pair.Key.X < 0 || (int)pair.Key.X > 1000 || (int)pair.Key.Y < 0 || (int)pair.Key.Y > 1000
                || !IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius))
                continue;
            result.Add(new BridgeBushTarget(BuildBushTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, bush),
                location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y));
        }
        return result;
    }

    private static string BuildBushTargetId(GameLocation location, int x, int y, StardewValley.TerrainFeatures.Bush bush)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:bush:{bush.tileSheetOffset.Value}:{bush.size.Value}";
        return $"bush_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }
}
