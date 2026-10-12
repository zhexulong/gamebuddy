using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.GameData.Buildings;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// build_farm_building pre-attachment Given: one commission site the product itself accepts —
    /// the current location is buildable, the actor can afford the type's declared cost and
    /// materials, a free footprint exists for it, and the actor stands one Chebyshev step from
    /// that footprint.
    ///
    /// Only that declared Given is established. The build itself — the native
    /// <c>GameLocation.buildStructure</c> call, the new <c>Building</c> and the debited money and
    /// materials — belongs to production, and this fixture emits no receipt.
    ///
    /// WHY THE MONEY AND MATERIALS ARE GRANTED HERE RATHER THAN FOUND: the action spends them, so
    /// the starting state has to be known and sufficient. A save that happens to hold enough gold
    /// and wood is reused; otherwise the fixture grants exactly what the game's own
    /// <c>Data/Buildings</c> entry declares, resolved through <c>ItemRegistry.Create</c> exactly as
    /// <c>CarpenterMenu</c> resolves it, and then asserts the Given THROUGH THE PRODUCT'S OWN
    /// predicate (<c>ExecutionManager.TryDescribeBuildFarmBuildingSite</c> plus the same discovery
    /// the snapshot publishes) so the fixture and the product cannot disagree.
    /// </summary>
    private void InitializeNativeLocalBuildFarmBuildingFixture(Farmer player, GameLocation location)
    {
        if (!location.IsBuildableLocation())
            throw new InvalidOperationException($"fixture_native_local_build_farm_building_location_not_buildable:{location.NameOrUniqueName}");
        if (Game1.buildingData is null || Game1.buildingData.Count == 0)
            throw new InvalidOperationException("fixture_native_local_build_farm_building_data_unreadable");

        // The commission the fixture establishes: the first building type the game declares that
        // is not upgrade-only and for which a free footprint exists near the actor. Nothing is
        // hardcoded — the list is the game's own Data/Buildings table.
        string? buildingType = null;
        Vector2 site = Vector2.Zero;
        foreach (KeyValuePair<string, BuildingData> entry in Game1.buildingData)
        {
            BuildingData data = entry.Value;
            if (string.IsNullOrEmpty(entry.Key) || data is null || data.Size.X <= 0 || data.Size.Y <= 0) continue;
            if (!string.IsNullOrEmpty(data.BuildingToUpgrade)) continue;
            Vector2? found = FindNativeLocalBuildFarmBuildingSite(player, location, data);
            if (found is null) continue;
            buildingType = entry.Key;
            site = found.Value;
            break;
        }
        if (buildingType is null)
            throw new InvalidOperationException("fixture_native_local_build_farm_building_site_missing");

        BuildingData commission = Game1.buildingData[buildingType];

        // The Given, made true explicitly: the actor can pay the declared cost and holds the
        // declared materials. A save that already can is left alone.
        if (player.Money < commission.BuildCost + 1000)
            player.Money = commission.BuildCost + 1000;
        foreach (BuildingMaterial material in commission.BuildMaterials ?? new List<BuildingMaterial>())
        {
            if (material is null || string.IsNullOrEmpty(material.ItemId) || material.Amount <= 0) continue;
            Item materialItem = ItemRegistry.Create(material.ItemId, material.Amount);
            if (player.Items.ContainsId(materialItem.QualifiedItemId, material.Amount)) continue;
            if (player.addItemToInventory(materialItem) is not null)
                throw new InvalidOperationException($"fixture_native_local_build_farm_building_materials_missing:{materialItem.QualifiedItemId}:{material.Amount}");
        }

        // A lawful standing tile one Chebyshev step from the site's own footprint, outside it.
        Vector2? standing = FindNativeLocalBuildFarmBuildingStandingTile(location, commission, (int)site.X, (int)site.Y)
            ?? throw new InvalidOperationException("fixture_native_local_build_farm_building_standing_tile_missing");
        player.warpFarmer(new Warp(0, 0, location.NameOrUniqueName, (int)standing.Value.X, (int)standing.Value.Y, false));

        string targetId = ExecutionManager.BuildFarmBuildingSiteTargetId(location, buildingType, (int)site.X, (int)site.Y);
        if (!ExecutionManager.TryDescribeBuildFarmBuildingSite(location, buildingType, (int)site.X, (int)site.Y, targetId, out string reasonCode))
            throw new InvalidOperationException($"fixture_native_local_build_farm_building_given_not_accepted:{reasonCode}");
        if (!ExecutionManager.DiscoverBuildFarmBuildingTargets(player).Any(candidate => candidate.Kind == "build_site" && candidate.TargetId == targetId))
            throw new InvalidOperationException($"fixture_native_local_build_farm_building_site_not_advertised:{targetId}");

        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player fixture precondition: action=build_farm_building"
                + $";location={location.NameOrUniqueName}"
                + $";target={targetId}"
                + $";tile={(int)site.X},{(int)site.Y}"
                + $";standing={(int)standing.Value.X},{(int)standing.Value.Y}"
                + $";building_type={buildingType}"
                + $";build_cost={commission.BuildCost}"
                + $";build_days={commission.BuildDays}"
                + $";money={player.Money}",
            LogLevel.Info);
    }

    /// <summary>
    /// The first footprint in the actor's disclosure window whose tiles are all buildable and
    /// free, with a lawful human-door tile — the same window and the same checks the product's own
    /// discovery uses.
    /// </summary>
    private static Vector2? FindNativeLocalBuildFarmBuildingSite(Farmer player, GameLocation location, BuildingData data)
    {
        for (int x = player.TilePoint.X - ExecutionManager.TargetDiscoveryRadius; x <= player.TilePoint.X + ExecutionManager.TargetDiscoveryRadius; x++)
        {
            for (int y = player.TilePoint.Y - ExecutionManager.TargetDiscoveryRadius; y <= player.TilePoint.Y + ExecutionManager.TargetDiscoveryRadius; y++)
            {
                if (!IsNativeLocalBuildFarmBuildingFootprintFree(location, data, x, y)) continue;
                if (ChebyshevTileDistance(new Vector2(x, y), new Vector2(player.TilePoint.X, player.TilePoint.Y)) > ExecutionManager.TargetDiscoveryRadius) continue;
                return new Vector2(x, y);
            }
        }
        return null;
    }

    /// <summary>
    /// A walkable tile one Chebyshev step from the site's top-left tile and outside its whole
    /// footprint — the exact reach horizon `build_farm_building` admits on.
    /// </summary>
    private static Vector2? FindNativeLocalBuildFarmBuildingStandingTile(GameLocation location, BuildingData data, int x, int y)
    {
        Vector2[] ring =
        {
            new(x, y - 1), new(x - 1, y), new(x + data.Size.X, y), new(x, y + data.Size.Y),
            new(x - 1, y - 1), new(x + data.Size.X, y - 1), new(x - 1, y + data.Size.Y), new(x + data.Size.X, y + data.Size.Y),
        };

        return ring
            .Where(tile => !NativeLocalBuildFarmBuildingFootprintCovers(data, x, y, (int)tile.X, (int)tile.Y)
                && !location.buildings.Any(other => other is not null && other.occupiesTile((int)tile.X, (int)tile.Y))
                && IsFixtureWalkableFarmTile(location, tile))
            .Cast<Vector2?>()
            .FirstOrDefault();
    }

    private static bool IsNativeLocalBuildFarmBuildingFootprintFree(GameLocation location, BuildingData data, int x, int y)
    {
        for (int offsetX = 0; offsetX < data.Size.X; offsetX++)
        {
            for (int offsetY = 0; offsetY < data.Size.Y; offsetY++)
            {
                Vector2 tile = new(x + offsetX, y + offsetY);
                if (!location.isTileOnMap(tile) || !location.isBuildable(tile)) return false;
                if (location.buildings.Any(building => building is not null && building.occupiesTile((int)tile.X, (int)tile.Y))) return false;
                if (Game1.player.GetBoundingBox().Intersects(new Rectangle((x + offsetX) * 64, (y + offsetY) * 64, 64, 64))) return false;
            }
        }

        if (data.HumanDoor != new Point(-1, -1))
        {
            Vector2 door = new(x + data.HumanDoor.X, y + data.HumanDoor.Y + 1);
            if (!location.isTileOnMap(door) || (!location.isBuildable(door, onlyNeedsToBePassable: true) && !location.isPath(door))) return false;
        }

        return true;
    }

    private static bool NativeLocalBuildFarmBuildingFootprintCovers(BuildingData data, int x, int y, int tileX, int tileY) =>
        tileX >= x && tileX < x + data.Size.X && tileY >= y && tileY < y + data.Size.Y;
}
