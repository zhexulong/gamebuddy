using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private void InitializeNativeNpcRelationshipFixture(StardewValley.Farm farm)
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
        // Keep the NPC on the native Farm map near the FarmHouse/Cabin warp
        // arrival. A saved offline Farmhand can be inside a Cabin with
        // furniture immediately around its spawn tile, so using
        // farmhand.currentLocation as the fixture location is not a reliable
        // approach precondition. Resolve the exact target-version warp from
        // the retained Cabin instead of guessing a map coordinate.
        GameLocation targetLocation = farm;
        StardewValley.Warp? farmWarp = farmhand.currentLocation?.warps.FirstOrDefault(warp => !warp.npcOnly.Value && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
        farmWarp ??= Game1.locations
            .OfType<StardewValley.Locations.Cabin>()
            .SelectMany(cabin => cabin.warps)
            .FirstOrDefault(warp => !warp.npcOnly.Value && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
        if (farmWarp is null || farmWarp.TargetX < 0 || farmWarp.TargetY < 0)
            throw new InvalidOperationException("fixture_native_npc_relationship_farm_warp_missing");
        Microsoft.Xna.Framework.Vector2 farmArrival = new(farmWarp.TargetX, farmWarp.TargetY);

        StardewValley.NPC? fixtureNpc = null;
        Utility.ForEachVillager(npc =>
        {
            if (string.IsNullOrWhiteSpace(npc.Name) || !farmhand.friendshipData.ContainsKey(npc.Name))
                return true;
            fixtureNpc = npc;
            return false;
        });
        if (fixtureNpc is null)
            throw new InvalidOperationException("fixture_native_npc_relationship_fact_missing");

        // Keep the fixture NPC close enough to the native Farm warp arrival
        // that the production runner can reach it through published movement.
        // Search the full bounded square, not only four cardinal rays: the
        // Cabin/building collision map can block the ray while leaving a
        // diagonal tile reachable. Never fall back to a distant NPC; a missing
        // near-arrival tile is a fixture blocker, not permission to widen the
        // production relationship radius.
        Microsoft.Xna.Framework.Vector2? destination = null;
        const int maximumArrivalOffset = 4;
        IEnumerable<Microsoft.Xna.Framework.Vector2> candidateTiles = Enumerable.Range(-maximumArrivalOffset, maximumArrivalOffset * 2 + 1)
            .SelectMany(offsetX => Enumerable.Range(-maximumArrivalOffset, maximumArrivalOffset * 2 + 1)
                .Select(offsetY => new Microsoft.Xna.Framework.Vector2(farmArrival.X + offsetX, farmArrival.Y + offsetY)))
            .Where(tile => tile != farmArrival)
            .OrderBy(tile => Math.Max(Math.Abs(tile.X - farmArrival.X), Math.Abs(tile.Y - farmArrival.Y)))
            .ThenBy(tile => Math.Abs(tile.X - farmArrival.X) + Math.Abs(tile.Y - farmArrival.Y));
        foreach (Microsoft.Xna.Framework.Vector2 tile in candidateTiles)
        {
            if (!targetLocation.isTilePassable(tile)
                || targetLocation.IsTileOccupiedBy(tile, CollisionMask.All, CollisionMask.None, useFarmerTile: true))
                continue;
            bool hasApproach = new[]
            {
                tile + new Microsoft.Xna.Framework.Vector2(1f, 0f),
                tile + new Microsoft.Xna.Framework.Vector2(-1f, 0f),
                tile + new Microsoft.Xna.Framework.Vector2(0f, 1f),
                tile + new Microsoft.Xna.Framework.Vector2(0f, -1f),
            }.Any(approach => targetLocation.isTilePassable(approach)
                && !targetLocation.IsTileOccupiedBy(approach, CollisionMask.All, CollisionMask.None, useFarmerTile: true));
            if (hasApproach)
            {
                destination = tile;
                break;
            }
        }
        if (destination is null)
            throw new InvalidOperationException($"fixture_native_npc_relationship_approach_missing:location={targetLocation.NameOrUniqueName};arrival={(int)farmArrival.X},{(int)farmArrival.Y};max_offset={maximumArrivalOffset}");

        Game1.warpCharacter(fixtureNpc, targetLocation, destination.Value);
        if (fixtureNpc.currentLocation != targetLocation || Math.Abs((int)fixtureNpc.Tile.X - (int)farmArrival.X) > maximumArrivalOffset || Math.Abs((int)fixtureNpc.Tile.Y - (int)farmArrival.Y) > maximumArrivalOffset)
            throw new InvalidOperationException("fixture_native_npc_relationship_warp_postcondition_missing");

        this.hostAutomationFixtureInitialized = true;
        Friendship relationship = farmhand.friendshipData[fixtureNpc.Name];
        this.Monitor.Log($"GameBuddy HostAutomation initialized native NPC-relationship v1 fixture before attachment: farmhand={farmhandId}; npc={fixtureNpc.Name}; location={fixtureNpc.currentLocation?.NameOrUniqueName}; tile={(int)fixtureNpc.Tile.X},{(int)fixtureNpc.Tile.Y}; farm_arrival={(int)farmArrival.X},{(int)farmArrival.Y}; points={relationship.Points}; status={relationship.Status}; no relationship mutation; a native save/reload plus production bridge reread are still required.", LogLevel.Info);
    }
}
