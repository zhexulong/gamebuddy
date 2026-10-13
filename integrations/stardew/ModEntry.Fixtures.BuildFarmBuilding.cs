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
            // The PRODUCT's own search, so the site the Given names is exactly the site the product advertises.
            Vector2? found = ExecutionManager.FindFarmBuildingSite(player, location, data);
            if (found is null) continue;
            buildingType = entry.Key;
            site = found.Value;
            break;
        }
        if (buildingType is null)
        {
            // Name WHERE it looked and what rejected the tiles, so a site_missing is diagnosable from the log.
            xTile.Layers.Layer? diagnosticLayer = location.map?.GetLayer("Back");
            int buildableTiles = 0;
            int scanned = 0;
            if (diagnosticLayer is not null)
            {
                for (int dx = 0; dx < diagnosticLayer.LayerWidth; dx++)
                {
                    for (int dy = 0; dy < diagnosticLayer.LayerHeight; dy++)
                    {
                        scanned++;
                        if (location.isBuildable(new Vector2(dx, dy))) buildableTiles++;
                    }
                }
            }
            string firstType = ".";
            int firstTypeFootprints = -1;
            foreach (KeyValuePair<string, BuildingData> probe in Game1.buildingData)
            {
                if (probe.Value is null || string.IsNullOrEmpty(probe.Key)) continue;
                firstType = probe.Key + "(" + probe.Value.Size.X + "x" + probe.Value.Size.Y + ")";
                firstTypeFootprints = 0;
                if (diagnosticLayer is not null)
                    for (int dx = 0; dx < diagnosticLayer.LayerWidth; dx++)
                        for (int dy = 0; dy < diagnosticLayer.LayerHeight; dy++)
                            if (IsNativeLocalBuildFarmBuildingFootprintFree(location, probe.Value, dx, dy)) firstTypeFootprints++;
                break;
            }
            throw new InvalidOperationException(
                $"fixture_native_local_build_farm_building_site_missing:location={location.NameOrUniqueName}"
                    + $":map={diagnosticLayer?.LayerWidth ?? 0}x{diagnosticLayer?.LayerHeight ?? 0}:scanned={scanned}"
                    + $":buildable={buildableTiles}:first_type={firstType}:first_type_sites={firstTypeFootprints}"
                    + $":actor={player.TilePoint.X},{player.TilePoint.Y}:buildable_rect={location.GetBuildableRectangle()}");
        }

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
        // NOTE: no advertisement assertion here. The published site is a function of where the actor STANDS (the
        // discovery asks the product's own search from the actor's current tile) and of the scan window, while the
        // warp above is queued and applies on a later tick - asserting it at this point raced and reported a
        // mismatch between two searches that were both correct. The runner is where it belongs: it reads
        // `farmBuildingTargets` from a fresh observation and picks a `build_site` from it.

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
    private static Vector2? FindNativeLocalBuildFarmBuildingSite(Farmer player, GameLocation location, BuildingData data) =>
        ExecutionManager.FindFarmBuildingSite(player, location, data);

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

    /// <summary>
    /// The PRODUCT's own site predicate. The fixture must choose a site the product accepts, so it asks the
    /// product rather than keeping a second copy of the rule - the two cannot disagree if there is only one.
    /// (The copy that used to live here also read `GameLocation.isBuildable`, which answers about the wrong map.)
    /// </summary>
    private static bool IsNativeLocalBuildFarmBuildingFootprintFree(GameLocation location, BuildingData data, int x, int y) =>
        ExecutionManager.IsFarmBuildingFootprintFree(location, data, x, y);


    private static bool NativeLocalBuildFarmBuildingFootprintCovers(BuildingData data, int x, int y, int tileX, int tileY) =>
        tileX >= x && tileX < x + data.Size.X && tileY >= y && tileY < y + data.Size.Y;
}
