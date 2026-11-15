using System.Collections.Generic;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// The names this code uses for what stands on a farm, and the mapping from the engine's three
/// containers onto them.
///
/// A tile can hold a member of one of three native containers - <c>resourceClumps</c> (boulders, stumps),
/// <c>objects</c> (stones, weeds, placed items) and <c>terrainFeatures</c> (grass, a crop on dirt). The
/// caller reads whichever one answers and passes the answer here; this type never touches the world, so
/// the mapping is testable without a game.
///
/// Only the six kinds in <see cref="ClearCostTable"/> are named. A building, water, the map edge - all
/// absent, which the search reads as a wall. That asymmetry is the point: a clear plan may never claim
/// that a wall can be paid for.
/// </summary>
public static class ClearableKind
{
    /// <summary>
    /// Map one occupant to a clear kind, or null when it cannot be cleared.
    ///
    /// <paramref name="detail"/> is the occupant's own word for itself: the resource clump's tool demand
    /// (`axe`/`pickaxe`, which is already the one table the Mod owns), the object's identity in the vocabulary every
    /// clearing declaration is written in (`TileOccupantKind.Stone`/`Weed`/`Twig`, or the residual `object`), or the
    /// terrain feature's type (`grass`/`crop`/`water`).
    ///
    /// <para>
    /// TWIG IS ITS OWN ROW because the tool that removes it is its own: `Object.IsTwig()` is the axe branch
    /// (`Object.cs:1182`) that `remove_placed_item` admits on, the way `stone` is the pickaxe branch `break_rock`
    /// admits on. Before it, twig litter had no word at all and a strip of it was priced as a wall.
    /// </para>
    /// </summary>
    public static string? Map(string container, string detail) =>
        (container, detail) switch
        {
            ("resourceClump", "axe") => "stump",
            ("resourceClump", "pickaxe") => "rock",
            ("object", TileOccupantKind.Stone) => "rock",
            ("object", TileOccupantKind.Weed) => "weed",
            ("object", TileOccupantKind.Twig) => "twig",
            ("terrain", "grass") => "grass",
            ("terrain", "crop") => "crop",
            _ => null,
        };
}
