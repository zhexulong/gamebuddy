using System;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Buildings;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>The obelisk building type the fixture places (route A).</summary>
    private const string UseObeliskFixtureBuildingType = "Desert Obelisk";
    /// <summary>Preferred origin tile; moved right on the first free one if taken.</summary>
    private const int UseObeliskFixtureTileX = 30;
    private const int UseObeliskFixtureTileY = 12;

    /// <summary>
    /// use_obelisk pre-attachment Given: one finished obelisk BUILDING on the farm
    /// and the actor standing in its interaction ring.
    ///
    /// The declared Givens are exactly two things the action does not itself
    /// produce: the structure exists (you can only click an obelisk you built) and
    /// the actor is within reach of it. Nothing here touches the destination, the
    /// wand effect, the control freeze, the delayed warp or the arrival: the native
    /// seam owns all of those, and this fixture emits no receipt. It fails loudly
    /// rather than arming a world in which the action could never succeed.
    ///
    /// Route B is deliberately NOT staged. IslandWest's own "FarmObelisk" tile
    /// requires a save with the island unlocked AND the island obelisk upgrade
    /// applied (`IslandWest.farmObelisk`, which applies the Island_W_Obelisk
    /// override at IslandWest.cs:425-440) plus an actor standing on IslandWest --
    /// a different, much heavier Given than this lane declares. Route B is
    /// implemented, admitted in its own native terms and covered offline; its live
    /// Given is a separate stage that this fixture does not claim.
    /// </summary>
    private void InstallNativeLocalUseObeliskFixture(Farmer player)
    {
        StardewValley.GameLocation? farm = Game1.getFarm();
        if (farm is null)
            throw new InvalidOperationException("fixture_native_local_use_obelisk_farm_missing");

        Building? obelisk = farm.buildings.FirstOrDefault(
            candidate => candidate is not null
                && candidate.buildingType.Value == UseObeliskFixtureBuildingType
                && candidate.daysOfConstructionLeft.Value <= 0);

        if (obelisk is null)
        {
            // Occupancy, not origin equality: a building covers a RECTANGLE, so comparing origins
            // alone can land the obelisk inside an existing footprint. Live evidence of that exact
            // failure: the placement succeeded on paper while the actor resolved
            // building_type=Greenhouse at the very tile the obelisk claimed.
            Vector2 origin = new(UseObeliskFixtureTileX, UseObeliskFixtureTileY);
            while (farm.buildings.Any(candidate => candidate is not null
                && candidate.occupiesTile((int)origin.X, (int)origin.Y, applyTilePropertyRadius: true)))
                origin += new Vector2(4, 0);
            if (!farm.isTileOnMap(origin) || !farm.isTilePassable(origin))
                throw new InvalidOperationException("fixture_native_local_use_obelisk_origin_blocked");

            // A freshly constructed building carries its BuildDays, and the native
            // obelisk path only warps for a finished one (Building.doAction :937
            // draws "under construction" instead), so the Given includes finishing it.
            obelisk = new Building(UseObeliskFixtureBuildingType, origin);
            obelisk.daysOfConstructionLeft.Value = 0;
            farm.buildings.Add(obelisk);
            farm.updateLayout();
        }

        if (obelisk is null)
            throw new InvalidOperationException("fixture_native_local_use_obelisk_building_missing");
        if (obelisk.daysOfConstructionLeft.Value > 0)
            throw new InvalidOperationException("fixture_native_local_use_obelisk_under_construction");
        // The same mapping the action admits against, so the fixture and the product
        // cannot disagree about what counts as an obelisk.
        if (!ExecutionManager.TryGetObeliskWarp(obelisk.buildingType.Value, out _, out _, out _, out _))
            throw new InvalidOperationException("fixture_native_local_use_obelisk_type_not_an_obelisk");

        // A standing tile inside the building's interaction ring: one step outside
        // the footprint, on the map, passable and not occupied by any building.
        Vector2? standing = null;
        for (int dx = -1; dx <= obelisk.tilesWide.Value && standing is null; dx++)
        {
            for (int dy = -1; dy <= obelisk.tilesHigh.Value && standing is null; dy++)
            {
                Vector2 candidate = new(obelisk.tileX.Value + dx, obelisk.tileY.Value + dy);
                if (!farm.isTileOnMap(candidate) || !farm.isTilePassable(candidate))
                    continue;
                if (farm.buildings.Any(building => building.occupiesTile((int)candidate.X, (int)candidate.Y)))
                    continue;
                standing = candidate;
            }
        }
        if (standing is null)
            throw new InvalidOperationException("fixture_native_local_use_obelisk_standing_tile_missing");

        // HAND-OFF, not warp-and-hope. Building the obelisk and warping in the same breath does
        // not survive: the warp reloads the destination location, and a building added to the
        // pre-reload instance is simply gone by the time an action resolves against
        // player.currentLocation. That is exactly what happened live — the snapshot advertised the
        // obelisk (discovery scanned the current instance) and moments later the action could not
        // resolve it, which reads as 'obelisk_not_an_obelisk' even though the type mapping is
        // correct. OnWarped is where the location is final, so the structure is placed there and
        // the initialization is only claimed once it verifies. Same shape as the crab-pot and
        // clear-hoedirt fixtures.
        this.nativeLocalUseObeliskFixturePending = new NativeLocalUseObeliskFixturePending(
            farm.NameOrUniqueName,
            obelisk.buildingType.Value,
            new Vector2(obelisk.tileX.Value, obelisk.tileY.Value),
            standing.Value);
        player.warpFarmer(new Warp(0, 0, farm.NameOrUniqueName, (int)standing.Value.X, (int)standing.Value.Y, false));
    }
}
