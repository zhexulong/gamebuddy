using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private void InitializeNativePickupForageFixture(StardewValley.Farm farm)
    {
        long farmhandId = this.ResolveBoundFarmhandId();
        Farmer? farmhand = Game1.GetPlayer(farmhandId, onlyOnline: false);
        if (farmhand is null)
            throw new InvalidOperationException("fixture_bound_farmhand_missing");
        if (!farm.buildings
            .Select(building => building.GetIndoors())
            .OfType<StardewValley.Locations.Cabin>()
            .Any(cabin => cabin.OwnerId == farmhandId))
            throw new InvalidOperationException("fixture_bound_farmhand_cabin_missing");

        // Resolve the target-version Farm arrival from the retained Cabin warp;
        // never hard-code a map coordinate or put the forage object outside the
        // map. The object is created only as an automation fixture precondition.
        StardewValley.Warp? farmWarp = farmhand.currentLocation?.warps.FirstOrDefault(warp => !warp.npcOnly.Value && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
        farmWarp ??= Game1.locations
            .OfType<StardewValley.Locations.Cabin>()
            .SelectMany(cabin => cabin.warps)
            .FirstOrDefault(warp => !warp.npcOnly.Value && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
        if (farmWarp is null || farmWarp.TargetX < 0 || farmWarp.TargetY < 0)
            throw new InvalidOperationException("fixture_native_pickup_forage_farm_warp_missing");
        Vector2 farmArrival = new(farmWarp.TargetX, farmWarp.TargetY);

        // Keep the target within the first discovery radius of the native warp
        // arrival, but require a separate passable approach tile. This makes a
        // missing legal placement a bounded fixture blocker rather than an
        // excuse to widen the production action's range.
        Vector2[] candidateTiles = Enumerable.Range(-1, 3)
            .SelectMany(offsetX => Enumerable.Range(-1, 3)
                .Select(offsetY => new Vector2(farmArrival.X + offsetX, farmArrival.Y + offsetY)))
            .Where(tile => tile != farmArrival
                && farm.isTileOnMap(tile)
                && farm.isTilePassable(tile)
                && !farm.objects.ContainsKey(tile)
                && farm.CanItemBePlacedHere(tile))
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
        if (candidateTiles.Length == 0)
            throw new InvalidOperationException($"fixture_native_pickup_forage_placement_missing:arrival={(int)farmArrival.X},{(int)farmArrival.Y}");

        // These are ordinary target-version forage objects. `dropObject` is
        // deliberately used instead of objects.Add: it applies the native map
        // placement checks and marks IsSpawnedObject, which is required by
        // GameLocation.checkAction's forage pickup branch. This remains
        // HostAutomation-only setup; the bridge never exposes object creation.
        string[] forageIds = new[] { "(O)399", "(O)396", "(O)398", "(O)16", "(O)18", "(O)20", "(O)22" };
        Vector2 placedTile = Vector2.Zero;
        StardewValley.Object? placedForage = null;
        foreach (Vector2 tile in candidateTiles)
        {
            foreach (string qualifiedItemId in forageIds)
            {
                StardewValley.Object forage = ItemRegistry.Create<StardewValley.Object>(qualifiedItemId, 1);
                if (!forage.isForage())
                    continue;
                if (!farm.dropObject(forage, tile * 64f, Game1.viewport, initialPlacement: true))
                    continue;
                if (farm.objects.TryGetValue(tile, out StardewValley.Object? actual)
                    && ReferenceEquals(actual, forage)
                    && actual.IsSpawnedObject
                    && actual.isForage())
                {
                    placedTile = tile;
                    placedForage = actual;
                    break;
                }
            }
            if (placedForage is not null)
                break;
        }
        if (placedForage is null)
            throw new InvalidOperationException("fixture_native_pickup_forage_object_placement_failed");

        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy HostAutomation initialized native pickup-forage v1 fixture before attachment: Cabin retained; farm_arrival={(int)farmArrival.X},{(int)farmArrival.Y}; forage={placedForage.QualifiedItemId}; stack={placedForage.Stack}; tile={(int)placedTile.X},{(int)placedTile.Y}; spawned={placedForage.IsSpawnedObject}; native checkAction plus inventory/removal postconditions are still required.", LogLevel.Info);
    }
}
