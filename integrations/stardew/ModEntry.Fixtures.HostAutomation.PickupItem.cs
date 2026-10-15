using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private void InitializeNativePickupItemFixture(StardewValley.Farm farm)
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

        StardewValley.Warp? farmWarp = farmhand.currentLocation?.warps.FirstOrDefault(warp => !warp.npcOnly.Value && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
        farmWarp ??= Game1.locations
            .OfType<StardewValley.Locations.Cabin>()
            .SelectMany(cabin => cabin.warps)
            .FirstOrDefault(warp => !warp.npcOnly.Value && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
        if (farmWarp is null || farmWarp.TargetX < 0 || farmWarp.TargetY < 0)
            throw new InvalidOperationException("fixture_native_pickup_item_farm_warp_missing");
        Vector2 farmArrival = new(farmWarp.TargetX, farmWarp.TargetY);

        // Debris is a target-version network object and is intentionally not
        // written to the save payload. The HostAutomation initializer recreates
        // it after every native host restart, before the final attachment. The
        // production action only guides the Farmhand into native magnetic
        // range; Debris.updateChunks itself owns Debris.collect.
        Vector2 hostTile = Game1.player.currentLocation == farm ? Game1.player.Tile : farmArrival;
        Vector2[] candidateTiles = Enumerable.Range(-4, 9)
            .SelectMany(offsetX => Enumerable.Range(-4, 9)
                .Select(offsetY => new Vector2(farmArrival.X + offsetX, farmArrival.Y + offsetY)))
            .Where(tile => Math.Max(Math.Abs(tile.X - farmArrival.X), Math.Abs(tile.Y - farmArrival.Y)) == 4
                && Math.Max(Math.Abs(tile.X - hostTile.X), Math.Abs(tile.Y - hostTile.Y)) >= 4
                && farm.isTileOnMap(tile)
                && farm.isTilePassable(tile)
                && !farm.IsTileOccupiedBy(tile, CollisionMask.All, CollisionMask.None, useFarmerTile: true))
            .Where(tile => new[]
            {
                tile + new Vector2(1f, 0f),
                tile + new Vector2(-1f, 0f),
                tile + new Vector2(0f, 1f),
                tile + new Vector2(0f, -1f),
            }.Any(approach => farm.isTileOnMap(approach)
                && farm.isTilePassable(approach)
                && !farm.IsTileOccupiedBy(approach, CollisionMask.All, CollisionMask.None, useFarmerTile: true)))
            .OrderBy(tile => tile.X)
            .ThenBy(tile => tile.Y)
            .ToArray();
        if (candidateTiles.Length == 0)
            throw new InvalidOperationException($"fixture_native_pickup_item_placement_missing:arrival={(int)farmArrival.X},{(int)farmArrival.Y}");

        const string qualifiedItemId = "(O)388";
        StardewValley.Object item = ItemRegistry.Create<StardewValley.Object>(qualifiedItemId, 1);
        if (!farmhand.couldInventoryAcceptThisItem(item))
            throw new InvalidOperationException("fixture_farmhand_pickup_item_inventory_full");

        Vector2 placedTile = candidateTiles[0];
        int beforeDebrisCount = farm.debris.Count;
        StardewValley.Debris placedDebris = Game1.createItemDebris(
            item,
            new Vector2(placedTile.X * 64f + 32f, placedTile.Y * 64f + 32f),
            2,
            farm,
            (int)(placedTile.Y * 64f + 32f));
        if (farm.debris.Count != beforeDebrisCount + 1
            || !farm.debris.Contains(placedDebris)
            || placedDebris.debrisType.Value != StardewValley.Debris.DebrisType.OBJECT
            || placedDebris.Chunks.Count == 0
            || placedDebris.item is null
            || !string.Equals(placedDebris.item.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal))
            throw new InvalidOperationException("fixture_native_pickup_item_debris_postcondition_missing");

        // Keep the disposable drop outside both the master and Farmhand's
        // initial magnetic radius. This native dropped-by grace period is only
        // a short handoff guard; it is not the action's success mechanism.
        placedDebris.DroppedByPlayerID.Value = farmhandId;

        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy HostAutomation initialized native pickup-item v1 fixture before attachment: Cabin retained; farm_arrival={(int)farmArrival.X},{(int)farmArrival.Y}; item={qualifiedItemId}; stack={placedDebris.item.Stack}; tile={(int)placedTile.X},{(int)placedTile.Y}; debris_type={placedDebris.debrisType.Value}; chunks={placedDebris.Chunks.Count}; dropped_by={farmhandId}; production must guide the Farmhand into range and prove target-version automatic Debris.collect, chunk removal, and inventory delivery.", LogLevel.Info);
    }
}
