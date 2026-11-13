using System.Globalization;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalHarvestBush(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        return this.RequestLocalTileTarget(
            "harvest_bush", requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs,
            AdmissionActionabilityProfile.General,
            authorize: null,
            gate: location =>
            {
                if (!TryGetHarvestableBush(location, targetX, targetY, expectedTargetId, out StardewValley.TerrainFeatures.Bush? bush))
                    return new TileTargetRefusal("bush_target_changed", $"target={targetX},{targetY}");
                // The native "you may shake now" gate, re-derived instead of assumed.
                // Bush.shake returns immediately while the bush is still animating
                // (Bush.cs:396-399, the private `maxShake` field), and the player's own
                // ingress Bush.performUseAction does not even reach that call until
                // `shakeTimer` has elapsed (Bush.cs:341-353). Only the public `shakeTimer`
                // can be read here, so it is the half of the native gate this admission
                // re-derives; the shake itself is then dispatched through
                // performUseAction, which keeps the remaining private gate native rather
                // than re-implemented. A bush that cannot be shaken right now is refused
                // for that reason, not reported as a changed target.
                if (bush!.shakeTimer > 0f)
                    return new TileTargetRefusal("bush_still_settling", $"target={targetX},{targetY};shake_timer={bush.shakeTimer.ToString("0.##", CultureInfo.InvariantCulture)}");
                return null;
            },
            inReach: IsTileWithinNativeReach,
            execute: (executionId, admittedRequestId) => this.ExecuteHarvestBush(executionId, admittedRequestId, targetX, targetY, expectedTargetId));
    }

    private LocalExecutionReceipt ExecuteHarvestBush(string executionId, string requestId, int targetX, int targetY, string expectedTargetId)
    {
        GameLocation location = Game1.player.currentLocation;
        if (!TryGetHarvestableBush(location, targetX, targetY, expectedTargetId, out StardewValley.TerrainFeatures.Bush? bush))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "bush_target_changed", $"target={targetX},{targetY}");
        if (bush!.shakeTimer > 0f)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "bush_still_settling", $"target={targetX},{targetY};shake_timer={bush.shakeTimer.ToString("0.##", CultureInfo.InvariantCulture)}");

        bool readyBefore = bush.readyForHarvest();
        int debrisBefore = location.debris.Count;
        // The player's own ingress (GameLocation.performUseAction dispatches here):
        // it owns the shakeTimer gate and reaches Bush.shake itself. Its bool
        // return is unconditional (Bush.cs:354), so it is not a postcondition.
        bush.performUseAction(new Vector2(targetX, targetY));
        bool readyAfter = bush.readyForHarvest();
        int debrisAfter = location.debris.Count;
        // The bush's own harvest state (tileSheetOffset, read through
        // readyForHarvest()) is cleared synchronously by the drop branch for every
        // bush size (Bush.cs:403-411), so that state flip is the postcondition.
        // The ITEM is native, but NOT synchronous for a size-4 bush: that branch
        // queues Game1.createItemDebris inside uniqueSpawnMutex.RequestLock
        // (Bush.cs:412-420), whose callback only runs on a later Bush.tickUpdate
        // (Bush.cs:363-366). The same-frame debris delta is therefore OBSERVED and
        // never asserted: a size-4 harvest is a success on the state flip with its
        // drop still in flight.
        bool harvested = readyBefore && !readyAfter;
        bool droppedInFrame = debrisAfter > debrisBefore
            && location.debris.Skip(debrisBefore).Any(entry => entry?.item is not null);
        string evidence = $"target={expectedTargetId};tile={targetX},{targetY};ready_for_harvest_before={readyBefore.ToString().ToLowerInvariant()};ready_for_harvest_after={readyAfter.ToString().ToLowerInvariant()};debris_before={debrisBefore};debris_after={debrisAfter};item_dropped_in_frame={droppedInFrame.ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, harvested ? ExecutionState.Succeeded : ExecutionState.Uncertain,
            harvested ? "bush_harvested" : "bush_harvest_postcondition_unavailable", evidence);
    }

    private static bool TryGetHarvestableBush(GameLocation location, int x, int y, string expectedTargetId, out StardewValley.TerrainFeatures.Bush? bush)
    {
        bush = null;
        if (!TryGetBushAt(location, new Vector2(x, y), out StardewValley.TerrainFeatures.Bush? candidate)
            || !IsReadyBush(candidate!)
            || !string.Equals(BuildBushTargetId(location, x, y, candidate!), expectedTargetId, StringComparison.Ordinal))
            return false;
        bush = candidate;
        return true;
    }

    /// <summary>
    /// The bush standing on one tile, from whichever collection holds it.
    ///
    /// A bush is a `LargeTerrainFeature` placed by a map property (`GameLocation.cs:17403-17421`: 24/25/26/33 add
    /// `new Bush(...)` to `largeTerrainFeatures`) as well as a `TerrainFeature` from older saves. Resolving only
    /// `terrainFeatures` would publish a bush that this action then refuses `bush_target_changed`, so both lookups
    /// read both collections.
    /// </summary>
    private static bool TryGetBushAt(GameLocation location, Vector2 tile, out StardewValley.TerrainFeatures.Bush? bush)
    {
        bush = null;
        if (location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
            && feature is StardewValley.TerrainFeatures.Bush inFeatures)
        {
            bush = inFeatures;
            return true;
        }
        foreach (StardewValley.TerrainFeatures.LargeTerrainFeature large in location.largeTerrainFeatures)
        {
            if (large is StardewValley.TerrainFeatures.Bush inLarge && inLarge.Tile == tile)
            {
                bush = inLarge;
                return true;
            }
        }
        return false;
    }

    /// <summary>The one harvestability rule, shared by the discovery, the lookup and the postcondition read.</summary>
    private static bool IsReadyBush(StardewValley.TerrainFeatures.Bush bush)
    {
        return bush.tileSheetOffset.Value == 1 && bush.inBloom() && bush.readyForHarvest();
    }

    public LocalExecutionReceipt RequestLocalHarvestFruitTree(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        return this.RequestLocalTileTarget(
            "harvest_fruit_tree", requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs,
            AdmissionActionabilityProfile.General,
            authorize: null,
            gate: location => TryGetHarvestableFruitTree(location, targetX, targetY, expectedTargetId, out _)
                ? null
                : new TileTargetRefusal("fruit_tree_target_changed", $"target={targetX},{targetY}"),
            inReach: IsTileWithinNativeReach,
            execute: (executionId, admittedRequestId) => this.ExecuteHarvestFruitTree(executionId, admittedRequestId, targetX, targetY, expectedTargetId));
    }

    private LocalExecutionReceipt ExecuteHarvestFruitTree(string executionId, string requestId, int targetX, int targetY, string expectedTargetId)
    {
        GameLocation location = Game1.player.currentLocation;
        if (!TryGetHarvestableFruitTree(location, targetX, targetY, expectedTargetId, out StardewValley.TerrainFeatures.FruitTree? tree))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "fruit_tree_target_changed", $"target={targetX},{targetY}");
        int debrisBefore = location.debris.Count;
        tree!.shake(new Vector2(targetX, targetY), doEvenIfStillShaking: false);
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
        return this.RequestLocalTileTarget(
            "shake_tree", requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs,
            AdmissionActionabilityProfile.General,
            authorize: null,
            gate: location => TryGetShakeableTree(location, targetX, targetY, expectedTargetId, out _)
                ? null
                : new TileTargetRefusal("shake_tree_target_changed", $"target={targetX},{targetY}"),
            inReach: IsTileWithinNativeReach,
            execute: (executionId, admittedRequestId) => this.ExecuteShakeTree(executionId, admittedRequestId, targetX, targetY, expectedTargetId));
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
        tree.shake(new Vector2(targetX, targetY), doEvenIfStillShaking: false);
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

    /// <summary>
    /// Every harvestable bush around the actor, from BOTH collections a bush can stand in.
    ///
    /// A bush is a `LargeTerrainFeature` placed by a map property (`GameLocation.cs:17403-17421`: 24/25/26/33 add
    /// `new Bush(...)` to `largeTerrainFeatures`) and a `TerrainFeature` in older saves, so reading one collection
    /// would hide half the bushes. Both loops publish through the same filter.
    /// </summary>
    private static IReadOnlyList<BridgeBushTarget> DiscoverBushTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeBushTarget>();
        List<BridgeBushTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs)
            PublishBushTarget(location, player, pair.Key, pair.Value, result);
        foreach (StardewValley.TerrainFeatures.LargeTerrainFeature large in location.largeTerrainFeatures)
            PublishBushTarget(location, player, large.Tile, large, result);
        return result;
    }

    /// <summary>
    /// One bush candidate: the single filter and the single publisher the discovery uses, so a published target
    /// cannot be a target the harvest refuses.
    /// </summary>
    private static void PublishBushTarget(GameLocation location, Farmer player, Vector2 tile, StardewValley.TerrainFeatures.TerrainFeature feature, List<BridgeBushTarget> published)
    {
        if (published.Count >= 32) return;
        if (feature is not StardewValley.TerrainFeatures.Bush bush || !IsReadyBush(bush)) return;
        if ((int)tile.X < 0 || (int)tile.X > 1000 || (int)tile.Y < 0 || (int)tile.Y > 1000) return;
        if (!IsTileWithinChebyshevRadius(player, (int)tile.X, (int)tile.Y, TargetDiscoveryRadius)) return;
        // ONE TILE, ONE BUSH. A save can hold the same bush in both collections (an old one in `terrainFeatures`, a
        // new one in `largeTerrainFeatures`), and the id is a function of location and tile - so publishing twice
        // would hand the model two ids for one target and let a plan act on a bush it already harvested.
        if (published.Any(existing => existing.X == (int)tile.X && existing.Y == (int)tile.Y)) return;
        published.Add(new BridgeBushTarget(BuildBushTargetId(location, (int)tile.X, (int)tile.Y, bush),
            location.NameOrUniqueName, (int)tile.X, (int)tile.Y));
    }

    private static string BuildBushTargetId(GameLocation location, int x, int y, StardewValley.TerrainFeatures.Bush bush)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:bush:{bush.tileSheetOffset.Value}:{bush.size.Value}";
        return $"bush_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }
}
