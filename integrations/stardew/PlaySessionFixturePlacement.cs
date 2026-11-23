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

    /// <summary>
    /// How many steps each tile of a walkable piece sits from that piece's own edge: 1 for a tile with a neighbour
    /// outside the piece, one more for each step inward. A pocket's floor answers 1 or 2; the body of a field answers
    /// several times that.
    ///
    /// <para>
    /// MEASURED 2026-11-23: the day's last forage prop stood at 8,35 in the pocket north of the start, a later
    /// placement cut the pocket off, and <c>forage_and_trees</c> was left addressing an empty <c>forageTargets</c>. The
    /// pocket was the NEAREST ground there is, so the near-first sweep walked straight into it. This map is how a
    /// RESERVED prop asks for open ground instead - the one question the sweep cannot ask for itself.
    /// </para>
    ///
    /// <para>
    /// Chebyshev steps and a Moore neighbourhood, the same metric <see cref="OrderByDistanceFrom"/> orders by: two
    /// rules that agree about what one tile is cannot disagree about which tile is more open. An UNMEASURED piece
    /// (<paramref name="piece"/> null, the flood gave up) answers nothing, and nothing means "no tile is more open than
    /// another", so a caller keeps the near-first order rather than inventing a wall.
    /// </para>
    /// </summary>
    internal static IReadOnlyDictionary<Point, int> ClearanceFromPieceEdge(IReadOnlySet<Point>? piece)
    {
        Dictionary<Point, int> clearance = new();
        if (piece is null || piece.Count == 0)
            return clearance;
        Queue<Point> frontier = new();
        foreach (Point tile in piece)
        {
            if (MooreNeighbours(tile).All(piece.Contains))
                continue;
            clearance[tile] = 1;
            frontier.Enqueue(tile);
        }
        while (frontier.Count > 0)
        {
            Point tile = frontier.Dequeue();
            foreach (Point neighbour in MooreNeighbours(tile))
            {
                if (!piece.Contains(neighbour) || clearance.ContainsKey(neighbour))
                    continue;
                clearance[neighbour] = clearance[tile] + 1;
                frontier.Enqueue(neighbour);
            }
        }
        // EVERY tile of the piece has a clearance, or this is not the piece the caller measured. A missing entry would
        // read as 0 below and sort LAST, which is the one answer a defect here must not look like: it would send the
        // reserved member into the least open ground while the report called it open.
        if (clearance.Count != piece.Count)
            throw new InvalidOperationException(
                $"play_session_clearance_incomplete:piece={piece.Count};measured={clearance.Count}");
        return clearance;
    }

    /// <summary>
    /// The tiles a RESERVED prop may take, in the order it must try them: the openest ground first, and among tiles
    /// that are equally open the one nearest the actor before a farther one.
    ///
    /// <para>
    /// The second key is what keeps this a variant of the near-first rule rather than a different world: a reserved
    /// member still lands beside the actor when it can, it is only never the floor of a pocket. With no clearance to
    /// read (an unmeasured piece) the order is exactly <see cref="PlaceableCandidates"/>, which is the property that
    /// lets one search serve both the reservation and the sweep.
    /// </para>
    /// </summary>
    internal static IEnumerable<Point> ReservedCandidates(
        IEnumerable<Point> allTiles,
        Point start,
        IReadOnlyDictionary<Point, int> clearance,
        IReadOnlySet<Point>? held = null) =>
        PropsMayUse(allTiles, start, held)
            .OrderByDescending(tile => clearance.TryGetValue(tile, out int steps) ? steps : 0)
            .ThenBy(tile => Math.Max(Math.Abs(tile.X - start.X), Math.Abs(tile.Y - start.Y)))
            .ThenBy(tile => tile.Y)
            .ThenBy(tile => tile.X);

    /// <summary>The eight tiles one Moore step from <paramref name="tile"/>: the neighbourhood the clearance is in.</summary>
    private static IEnumerable<Point> MooreNeighbours(Point tile)
    {
        for (int offsetX = -1; offsetX <= 1; offsetX++)
        {
            for (int offsetY = -1; offsetY <= 1; offsetY++)
            {
                if (offsetX == 0 && offsetY == 0)
                    continue;
                yield return new Point(tile.X + offsetX, tile.Y + offsetY);
            }
        }
    }
}
