using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.TerrainFeatures;

namespace GameBuddy.Stardew;

/// <summary>
/// The word for whatever stands on a tile, in the ONE vocabulary a caller may filter on: the occupants
/// <see cref="FarmhandActionDescriptor.Clears"/> is declared in (<see cref="TileOccupantKind"/>).
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
/// THE OBJECT LAYER ANSWERS WITH THE PREDICATE AN ACTION ADMITS ON, never with a word of its own invention:
/// <see cref="NativeItemPredicates.IsBreakableStone"/> is what <c>break_rock</c> re-checks, <c>Object.IsWeeds()</c> is
/// what <c>cut_weeds</c> re-checks, and <see cref="NativeItemPredicates.IsTwigLitter"/> is the engine's own
/// <c>Object.IsTwig</c> that lets an axe remove the litter. It used to answer `stone` for `(O)2` alone - one id where the
/// engine's category is the fact - and `object` for everything else, which is how a strip of twig litter reached a
/// planner as a word no action answers (`round58`).
/// </para>
/// <para>
/// The containers are visited in the order a tile's contents live in - <c>resourceClumps</c>, then <c>objects</c>, then
/// <c>terrainFeatures</c>, then <c>largeTerrainFeatures</c> - so a tile holds at most one of them and the first answer
/// is the answering one. A clump is named on the tile its origin sits on, which is the tile a swing can be addressed to.
/// </para>
/// </summary>
internal static class TileOccupancy
{
    internal static string Of(GameLocation location, int x, int y)
    {
        Vector2 tile = new(x, y);
        foreach (ResourceClump clump in location.resourceClumps)
            if (clump.Tile == tile)
                return ClumpOccupant(clump.parentSheetIndex.Value);

        if (location.objects.TryGetValue(tile, out StardewValley.Object? item) && item is not null)
            return ObjectKind(item);

        if (location.terrainFeatures.TryGetValue(tile, out TerrainFeature? feature) && feature is not null)
        {
            // A TREE is the one terrain feature whose two phases are two published actions, so the two words here are
            // the two `Clears` occupants those actions declare: a standing tree and its stump. A fruit tree is NOT that
            // tree - `chop_tree` addresses a `Tree` and no action fells a `FruitTree` - so it is named apart instead of
            // borrowing a word whose action would refuse it.
            return feature switch
            {
                Grass => TileOccupantKind.Grass,
                HoeDirt dirt => dirt.crop is null ? TileOccupantKind.None : TileOccupantKind.Crop,
                Tree tree => tree.stump.Value ? TileOccupantKind.TreeStump : TileOccupantKind.Tree,
                FruitTree => TileOccupantKind.FruitTree,
                _ => TileOccupantKind.Terrain,
            };
        }

        // A bush is the one LARGE terrain feature the route refusal already names (`no_published_action_clears:bush`).
        // Reading it here too is what keeps the rectangle's word and the refusal's word the same word: a bush tile
        // answered `none` from the rectangle and `bush` from the walk, which is two answers to one question.
        foreach (LargeTerrainFeature large in location.largeTerrainFeatures)
            if (large.getBoundingBox().Contains(x * 64 + 32, y * 64 + 32))
                return large is Bush ? TileOccupantKind.Bush : TileOccupantKind.Terrain;

        return TileOccupantKind.None;
    }

    /// <summary>
    /// The objects layer's word, from the three predicates the clearing actions themselves ask - and the fourth answer
    /// for the objects none of them names.
    ///
    /// <para>
    /// ORDER IS THE NATIVE ONE. A stone is the engine's category (`Object.IsBreakableStone`, `Object.cs:6082`), a weed is
    /// its name (`Object.IsWeeds`, `Object.cs:6117`), and twig litter is its id family (<c>Object.IsTwig</c>, the four
    /// ids `GameLocation.cs:15351` spawns) - so the pickaxe's own admission is asked before the axe's, and an object that
    /// is both is answered by the tool that reaches it first.
    /// </para>
    /// <para>
    /// The last answer is <see cref="TileOccupantKind.OtherObject"/>, and it is a DECLARED unclearable kind rather than a
    /// shrug: <see cref="TileOccupantKind.Unclearable"/> carries the reason, so the caller is told what a tile carrying
    /// it needs instead of being told nothing.
    /// </para>
    /// </summary>
    internal static string ObjectKind(StardewValley.Object item) =>
        NativeItemPredicates.IsBreakableStone(item) ? TileOccupantKind.Stone
        : item.IsWeeds() ? TileOccupantKind.Weed
        : NativeItemPredicates.IsTwigLitter(item) ? TileOccupantKind.Twig
        : TileOccupantKind.OtherObject;

    /// <summary>
    /// The ENGINE's own name for one resource clump, from the constants its own type declares
    /// (<c>ResourceClump.cs:15-35</c>): <c>stumpIndex</c>, <c>hollowLogIndex</c>, <c>meteoriteIndex</c>,
    /// <c>boulderIndex</c>, <c>quarryBoulderIndex</c> and the four <c>mineRock*Index</c> rows.
    ///
    /// <para>
    /// Named from the engine rather than from the costing table because the two answer different questions and a
    /// refusal has to answer the caller's: `rock` is what a quarry boulder COSTS to remove, and "a quarry boulder" is
    /// what is standing there. Written against the constants, not their values, so a target-version change to the
    /// native table lands here as a compile-time rename rather than as a silently wrong word.
    /// </para>
    /// <para>
    /// The fallback is unreachable for a PRICED clump (<c>TryGetDebrisToolRequirement</c> prices exactly these nine),
    /// and it is kept because the honest answer to "a clump was priced but this function has no name for it" is a word
    /// no action declares - which the refusal reports as `no_published_action_clears:resource_clump` - rather than a
    /// name borrowed from a neighbour. A future engine constant therefore announces itself instead of lying.
    /// </para>
    /// </summary>
    internal static string ClumpOccupant(int parentSheetIndex) => parentSheetIndex switch
    {
        ResourceClump.stumpIndex => TileOccupantKind.ClumpStump,
        ResourceClump.hollowLogIndex => TileOccupantKind.HollowLog,
        ResourceClump.meteoriteIndex => TileOccupantKind.Meteorite,
        ResourceClump.boulderIndex => TileOccupantKind.Boulder,
        ResourceClump.quarryBoulderIndex => TileOccupantKind.QuarryBoulder,
        ResourceClump.mineRock1Index => TileOccupantKind.MineRock1,
        ResourceClump.mineRock2Index => TileOccupantKind.MineRock2,
        ResourceClump.mineRock3Index => TileOccupantKind.MineRock3,
        ResourceClump.mineRock4Index => TileOccupantKind.MineRock4,
        _ => TileOccupantKind.ResourceClump,
    };
}
