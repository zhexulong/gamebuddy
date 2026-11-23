using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;

namespace GameBuddy.Stardew;

/// <summary>
/// The props one play-session world lays, and which of them the day cannot do without.
///
/// <para>
/// A family the world budgeted and does not hold is a chore the rotation cannot answer: <c>clear_east_patch</c> addresses
/// <c>weedTargets</c>, <c>grassTargets</c>, <c>rockSourceTargets</c> and <c>treeStumpTargets</c>, <c>forage_and_trees</c>
/// addresses <c>forageTargets</c> and <c>treeChopSourceTargets</c>, and <c>water_and_harvest</c> addresses
/// <c>cropTargets</c> (the tasks and their signatures are <c>tools/lib/multiday-daily-tasks.mjs</c>). So the LAST standing
/// member of each family is LOAD-BEARING - the day loses a target family with it - and every earlier member is SCENERY.
/// </para>
///
/// <para>
/// MEASURED 2026-11-23: a farm whose props chained into a pocket north of the start dropped five of seventeen, and
/// neither the warning (<c>dropped 5 prop(s) a later placement cut off: 8,36;8,35;9,35;9,34;9,33</c>) nor the refusal
/// (<c>dropped=5;kept=12</c>) said whether the day had lost a family or five decorative rocks. The report is per family
/// because the two cases need different repairs, and only the first is a reason to refuse the world.
/// </para>
///
/// <para>
/// WHAT THIS IS NOT: a task list. Which task names which action is the rotation module's fact and is not repeated here;
/// what the fixture owns is its own end of it - the words it lays props with (<see cref="All"/>) and the published family
/// each puts rows in (<see cref="TargetFamilyOf"/>, spelled once through <see cref="TileTargetMint"/>).
/// </para>
/// </summary>
internal static class PlaySessionPropFamilies
{
    internal const string Tree = "tree";

    internal const string Forage = "forage";

    internal const string Weed = "weed";

    internal const string Grass = "grass";

    internal const string Stone = "stone";

    internal const string Crop = "crop";

    /// <summary>Every family the world lays, in the order it lays them: a tree first, because a tree is a wall.</summary>
    internal static readonly IReadOnlyList<string> All = new[] { Tree, Forage, Weed, Grass, Stone, Crop };

    /// <summary>
    /// The published target family one prop family puts rows in - the family the rotation's actions address.
    ///
    /// A word no family lays is refused BY NAME rather than answered null: a family the drop report cannot classify is a
    /// defect in this file, and a default would report it as scenery and let the day lose it in silence.
    /// </summary>
    internal static string TargetFamilyOf(string propFamily) => propFamily switch
    {
        Tree => TileTargetMint.TreeChopSourceTargets,
        Forage => TileTargetMint.ForageTargets,
        Weed => TileTargetMint.WeedTargets,
        Grass => TileTargetMint.GrassTargets,
        Stone => TileTargetMint.RockSourceTargets,
        Crop => TileTargetMint.CropTargets,
        _ => throw new InvalidOperationException($"fixture_native_local_play_session_prop_family_unknown:{propFamily}"),
    };

    /// <summary>One prop the post-placement sweep took off the ground, and whether the day lost a family with it.</summary>
    internal readonly record struct DroppedProp(string Family, Vector2 Tile, bool LoadBearing);

    /// <summary>
    /// The sweep's verdict per dropped tile: SCENERY while the family still has a member standing, LOAD-BEARING for the
    /// member that leaves it with none.
    ///
    /// The population is what was PLACED, and a family's members leave it as each drop is classified - so two dropped
    /// trees read "scenery, then the day's tree", never "two trees" or "no trees". A tile the fixture never placed is
    /// refused by name: a drop the report cannot trace is a sweep that removed something this file does not know about.
    /// </summary>
    internal static IReadOnlyList<DroppedProp> ClassifyDrops(
        IEnumerable<(Vector2 Tile, string Family)> placedProps,
        IEnumerable<Vector2> dropped)
    {
        List<(Vector2 Tile, string Family)> standing = placedProps.ToList();
        List<DroppedProp> classified = new();
        foreach (Vector2 tile in dropped)
        {
            int at = standing.FindIndex(prop => prop.Tile == tile);
            if (at < 0)
                throw new InvalidOperationException(
                    $"fixture_native_local_play_session_dropped_tile_never_placed:{(int)tile.X},{(int)tile.Y}");
            string family = standing[at].Family;
            standing.RemoveAt(at);
            bool anotherStands = standing.Exists(prop => string.Equals(prop.Family, family, StringComparison.Ordinal));
            classified.Add(new DroppedProp(family, tile, LoadBearing: !anotherStands));
        }
        return classified;
    }
}
