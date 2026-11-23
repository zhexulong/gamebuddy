using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;

namespace GameBuddy.Stardew;

/// <summary>
/// Where the play-session fixture may put its props, as pure rules.
///
/// Both rules exist because of a measured defect: the fixture's probes return the FIRST eligible tile scanning from
/// the map origin, so the props clustered into the Farm's corner and walled the actor into a two-tile pocket
/// (`component_tiles=2` in a live receipt), making targets a few tiles away genuinely unreachable. Placing outward
/// from an open start, and never inside the actor's own ring, is what fixed it (`component_tiles=28`).
///
/// They live here, separate from the fixture that uses them, so the properties can be pinned without a live game:
/// the ordering is what keeps the props beside the actor, and the ring exclusion is what keeps it out of a pocket.
/// </summary>
internal static class PlaySessionFixturePlacement
{
    /// <summary>
    /// Candidate tiles nearest the start first. Ties break on Y then X so the placement is deterministic and two
    /// runs of the same fixture produce the same world.
    /// </summary>
    internal static IEnumerable<Point> OrderByDistanceFrom(IEnumerable<Point> candidates, Point start) =>
        candidates
            .OrderBy(tile => Math.Max(Math.Abs(tile.X - start.X), Math.Abs(tile.Y - start.Y)))
            .ThenBy(tile => tile.Y)
            .ThenBy(tile => tile.X);

    /// <summary>
    /// True when the tile is the start itself or one of its four cardinal neighbours: the actor's own ring, which
    /// props may never occupy because that is exactly how the fixture used to fence the companion in.
    /// </summary>
    internal static bool IsInStartRing(Point tile, Point start) =>
        Math.Abs(tile.X - start.X) + Math.Abs(tile.Y - start.Y) <= 1;

    /// <summary>
    /// The four tiles an actor stands on to use a building's door, one per cardinal step. The door tile itself is a
    /// building tile nobody stands on, so this ring is what "the door can be used" means - asked by the animal
    /// Given's `no_approach` rule and reserved against the props by <see cref="TilesHeldByBuilding"/>.
    /// </summary>
    internal static IReadOnlyList<Point> DoorApproachTiles(Point door) => new[]
    {
        new Point(door.X, door.Y + 1),
        new Point(door.X - 1, door.Y),
        new Point(door.X + 1, door.Y),
        new Point(door.X, door.Y - 1),
    };

    /// <summary>
    /// The tiles a standing building holds against this fixture's props: its own footprint, the ring its door is used
    /// from, and the ROAD the day walks to that door. A prop on any of them is the defect the start-ring rule answers
    /// one layer down - a road the day needs, spent on scenery - and the arm-time assertion can only see it after the
    /// whole day has been laid out.
    ///
    /// <para>
    /// ONE LIST, because the road is held the same way the footprint and its door ring are: the props are handed a set
    /// of tiles they may not take, and whether a tile is under the house, beside its door or on the way there is the
    /// caller's business. <paramref name="road"/> is the walk from the farmhouse to this door, measured with the world's
    /// own predicate before any prop exists (see `ModEntry.NativeLocalMultiDayAnimalPorchRoad`).
    /// </para>
    /// </summary>
    internal static HashSet<Point> TilesHeldByBuilding(
        IEnumerable<Vector2> footprint,
        Point door,
        IEnumerable<Point> road) =>
        footprint
            .Select(tile => new Point((int)tile.X, (int)tile.Y))
            .Concat(DoorApproachTiles(door))
            .Concat(road)
            .ToHashSet();

    /// <summary>
    /// The tiles of a piece a prop may still take: everything except the start's own ring and what a standing building
    /// holds. One predicate, because the budget and the placement search must be about the same ground - a budget
    /// measured over tiles the search then refuses asks for props the world has already promised elsewhere.
    /// </summary>
    internal static IEnumerable<Point> PropsMayUse(
        IEnumerable<Point> walkable,
        Point start,
        IReadOnlySet<Point>? held = null) =>
        walkable.Where(tile => !IsInStartRing(tile, start) && (held is null || !held.Contains(tile)));

    /// <summary>
    /// How much ground is left for props once the reservations are held: the walkable piece the actor starts in, less
    /// the start's own ring and every tile a standing building owns (footprint, door ring and the road to its porch).
    ///
    /// <para>
    /// An UNMEASURED piece (<paramref name="walkable"/> null) answers <see cref="int.MaxValue"/>, the same convention
    /// <c>WalkableComponentSize</c> uses: the placement search still refuses a prop nothing can walk to, so an
    /// over-generous budget cannot arm an unusable world - it can only make the search try harder. Answering 0 here
    /// would refuse a world nobody measured, which is the opposite mistake.
    /// </para>
    /// </summary>
    internal static int FreeTilesForProps(IReadOnlySet<Point>? walkable, Point start, IReadOnlySet<Point>? held = null) =>
        walkable is null ? int.MaxValue : PropsMayUse(walkable, start, held).Count();

    /// <summary>
    /// The tiles a fixture may place a prop on, in the order it must try them. <paramref name="held"/> is what a
    /// building already standing in this world owns; a prop may never take one of those tiles.
    /// </summary>
    internal static IEnumerable<Point> PlaceableCandidates(
        IEnumerable<Point> allTiles,
        Point start,
        IReadOnlySet<Point>? held = null) =>
        OrderByDistanceFrom(PropsMayUse(allTiles, start, held), start);
}
