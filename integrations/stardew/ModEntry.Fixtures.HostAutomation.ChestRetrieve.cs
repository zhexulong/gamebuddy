using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private void InitializeNativeChestRetrieveFixture(StardewValley.Farm farm)
    {
        // Pre-attachment fixture only, on the Host side of the LAN topology: one
        // owned ordinary Chest on an empty Farm tile with a standable neighbor,
        // containing one item, and the bound Farmhand's backpack able to accept
        // it. Production alone removes the exact target through the native chest
        // take data path and owns all receipt/postcondition evidence.
        Farmer farmhand = this.ResolveHostAutomationFarmhand(farm);
        const string retrieveItemId = "(O)24";
        Vector2 farmArrival = ResolveHostAutomationFarmArrival(farmhand, farm, "chest_retrieve");
        // Keep the target inside the production discovery radius of the arrival
        // the attached Farmhand lands on, and require a separate passable
        // approach tile. A missing legal placement stays a bounded fixture
        // blocker instead of an excuse to widen the action's own range.
        const int placementRadius = 6;
        Vector2? target = Enumerable.Range(-placementRadius, placementRadius * 2 + 1)
            .SelectMany(offsetX => Enumerable.Range(-placementRadius, placementRadius * 2 + 1)
                .Select(offsetY => new Vector2(farmArrival.X + offsetX, farmArrival.Y + offsetY)))
            .Where(tile => tile != farmArrival
                && farm.isTileOnMap(tile)
                && farm.isTilePassable(tile)
                && !farm.objects.ContainsKey(tile)
                && !farm.terrainFeatures.ContainsKey(tile))
            .Where(tile => new[]
            {
                tile + new Vector2(1f, 0f),
                tile + new Vector2(-1f, 0f),
                tile + new Vector2(0f, 1f),
                tile + new Vector2(0f, -1f),
            }.Any(standing => farm.isTileOnMap(standing)
                && farm.isTilePassable(standing)
                && !farm.IsTileOccupiedBy(standing, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false)))
            .OrderBy(tile => Math.Max(Math.Abs(tile.X - farmArrival.X), Math.Abs(tile.Y - farmArrival.Y)))
            .ThenBy(tile => Math.Abs(tile.X - farmArrival.X) + Math.Abs(tile.Y - farmArrival.Y))
            .Cast<Vector2?>()
            .FirstOrDefault();
        if (target is null)
            throw new InvalidOperationException($"fixture_native_chest_retrieve_placement_missing:arrival={(int)farmArrival.X},{(int)farmArrival.Y}");
        StardewValley.Objects.Chest chest = new(playerChest: true, target.Value);
        StardewValley.Object contained = ItemRegistry.Create<StardewValley.Object>(retrieveItemId, 1);
        if (chest.addItem(contained) is not null)
            throw new InvalidOperationException("fixture_native_chest_retrieve_fill_failed");
        if (!farmhand.couldInventoryAcceptThisItem(contained))
            throw new InvalidOperationException("fixture_farmhand_chest_retrieve_inventory_unavailable");
        farm.objects.Add(target.Value, chest);
        // Chest.GetItemsForPlayer() with no GlobalInventoryId and no special
        // chest type returns the plain Items list (Chest.cs:972-994), so the same
        // single stack production will remove is the one validated here.
        if (!IsFixtureOwnedOrdinaryChest(chest) || chest.GetItemsForPlayer().Count(item => item is not null) != 1)
            throw new InvalidOperationException("fixture_native_chest_retrieve_placement_failed");
        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy HostAutomation initialized native chest-retrieve v1 fixture before attachment: Cabin retained; farmhand={farmhand.UniqueMultiplayerID}; item={retrieveItemId}; chest={chest.QualifiedItemId}; target={(int)target.Value.X},{(int)target.Value.Y}; farm_arrival={(int)farmArrival.X},{(int)farmArrival.Y}; inventory_slots={farmhand.MaxItems}; production alone invokes the native chest take path and emits receipt.", LogLevel.Info);
    }
}
