using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.TerrainFeatures;

namespace GameBuddy.Stardew;

/// <summary>
/// The word for whatever stands on a tile, in the ONE vocabulary a caller may filter on: the occupants
/// <see cref="FarmhandActionDescriptor.Clears"/> is declared in (`weed`, `stone`, `crop`, `grass`, `tree`,
/// `tree_stump`, a resource clump's own name, `object`, `terrain`, or <see cref="FarmhandForEachHealing.NoOccupant"/>).
///
/// <para>
/// TWO READERS, ONE PRODUCER. The rectangle query publishes this as a row's <c>occupantKind</c>, and the pass that
/// decides `where: [{ occupant: ... }]` reads it through the same function
/// (<see cref="FarmhandForEachFarmWorld.ReadRow"/>), because a filter written against one answer has to claim the rows
/// the other filter claims. It is a different question from <c>ExecutionManager.DescribeTileOccupant</c>, which names
/// the engine's runtime TYPE: there a weed is an `Object`, a crop tile is `none` because the soil is not an occupant,
/// and a stump is still a `Tree`.
/// </para>
/// <para>
/// The containers are visited in the order a tile's contents live in - <c>resourceClumps</c>, then <c>objects</c>, then
/// <c>terrainFeatures</c> - so a tile holds at most one of the three and the first answer is the answering one. A clump
/// is named on the tile its origin sits on, which is the tile a swing can be addressed to.
/// </para>
/// </summary>
internal static class TileOccupancy
{
    internal static string Of(GameLocation location, int x, int y)
    {
        Vector2 tile = new(x, y);
        foreach (ResourceClump clump in location.resourceClumps)
            if (clump.Tile == tile)
                return StardewBodyController.ClumpOccupant(clump.parentSheetIndex.Value);

        if (location.objects.TryGetValue(tile, out StardewValley.Object? item) && item is not null)
        {
            // The object's own word for itself: `(O)2` is the engine's stone and `Object.IsWeeds()` the engine's weed
            // (Object.cs:6117). An object this function cannot name is `object`, and no declaration clears that word, so
            // a refusal on such a tile names it instead of guessing at a neighbour.
            string detail = item.QualifiedItemId == "(O)2" ? "stone" : item.IsWeeds() ? "weed" : string.Empty;
            return detail.Length > 0 ? detail : "object";
        }

        if (location.terrainFeatures.TryGetValue(tile, out TerrainFeature? feature) && feature is not null)
        {
            // A TREE is the one terrain feature whose two phases are two published actions, so the two words here are
            // the two `Clears` occupants those actions declare: a standing tree and its stump.
            return feature switch
            {
                Grass => "grass",
                HoeDirt dirt => dirt.crop is null ? FarmhandForEachHealing.NoOccupant : "crop",
                Tree tree => tree.stump.Value ? "tree_stump" : "tree",
                _ => "terrain",
            };
        }

        return FarmhandForEachHealing.NoOccupant;
    }
}
