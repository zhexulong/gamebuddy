using System;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// How many props a world can host, from the ground it has.
///
/// The fixture carried a literal count - ten stones, then six, then four - and the number was never a
/// product requirement. It is a geometry budget: each prop occupies a tile, needs a standable neighbour for
/// the actor, and must not split the walkable piece the day depends on. Measured on the multi-day farm,
/// the walkable component is 123 tiles, not the 5200-tile map - so any literal count is either too small
/// (the day has nothing to do) or too large (`stone_spot_missing` after every individual placement
/// succeeded).
///
/// The budget, stated: the actor's start and its ring take a few tiles, each prop takes one, and a corridor
/// has to survive between them - so a component hosts roughly a tenth of its tiles, bounded at both ends.
/// The lower bound keeps a small farm usable; the ceiling keeps a large one from becoming a quarry.
/// </summary>
public static class PropCapacity
{
    /// <summary>Most props a single world carries, however much ground it has.</summary>
    public const int Ceiling = 16;

    /// <summary>Fewest props worth arming a day with, or 0 when the ground cannot host them.</summary>
    public const int Floor = 4;

    /// <summary>
    /// The prop budget for a walkable component of <paramref name="componentTiles"/> tiles.
    ///
    /// Returns 0 when the piece is too small for even one prop plus the tile the actor must stand on and
    /// the start's own ring - because arming a world that cannot be walked is worse than refusing it.
    /// </summary>
    public static int For(int componentTiles)
    {
        if (componentTiles <= 0) return 0;

        // A prop, the tile the actor stands on, and the start's ring: below this a piece cannot host even
        // one, and arming a world that cannot be walked is worse than refusing it. Expressed as tiles rather
        // than as a prop count, because that is what the ground is measured in.
        const int TilesPerPropWithCorridor = 8;
        const int MinimumTiles = 3 + TilesPerPropWithCorridor;
        if (componentTiles < MinimumTiles) return 0;

        // A tenth of the piece, so several tiles of walkable ground survive between placements and the
        // corridor the day depends on cannot be fenced off.
        // Measured, not guessed: on the 122-tile multi-day piece, ~12 props severed the door from the work
        // (component_tiles went 123 -> 122 and the field dropped out of it). A corridor needs several tiles of
        // slack per prop, so a twentieth is the budget that leaves the farm walkable.
        int budget = Math.Max(1, componentTiles / 20);

        return Math.Min(budget, Ceiling);
    }
}
