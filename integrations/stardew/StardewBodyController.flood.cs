using Microsoft.Xna.Framework;
using GameBuddy.Stardew.Core.Diagnostics;

namespace GameBuddy.Stardew;

/// <summary>
/// The two bounded cardinal floods the body controller decides reachability with, in their own file.
///
/// <para>
/// WHY THEY ARE SEPARATE. <c>StardewBodyController.cs</c> was 3,063 lines against a 2,000-line ceiling, and every
/// thing added to it grows a file the ratchet only lets shrink. These two members are the one part of it that is a
/// PROBE rather than a walk: they take a walkability predicate and answer a question about the map, so they are also
/// the two places the Mod's cost meter has to stand to say what a flood costs on the game thread
/// (<see cref="GameThreadCost"/>). Moving them here is where that seam can be measured without growing a pinned file.
/// </para>
///
/// <para>
/// THE CLASS IS ONE TYPE. This is a partial of <see cref="StardewBodyController"/> and not a second type: the
/// neighbourhood, the budget and every member the floods read stay shared, and no call site changed.
/// </para>
///
/// <para>
/// ONE QUESTION PER CELL, AND THAT IS THE COST MODEL. <c>isCollidingPosition</c> is ~0.4 µs on the game thread, and a
/// flood that asked it once per (cell, neighbour) pair rather than once per CELL spent 13-20 ms of an ordinary farm's
/// 16.67 ms frame - four engine queries for every tile it had already settled. The membership test therefore comes
/// FIRST in every loop below, so the predicate is asked about each distinct cell exactly once and the source of truth
/// is still the engine's own collision test, not a cached verdict about it.
/// </para>
/// </summary>
internal sealed partial class StardewBodyController
{
    /// <summary>
    /// ONE flood's answer: the tiles it settled, in the order it settled them, each with its own step count from the
    /// origin.
    ///
    /// <para>
    /// THE ORDER IS PART OF THE ANSWER. A verdict's <c>closest</c> tile is decided by a strict improvement over the
    /// order the flood settled tiles in, so two tiles at the same distance are told apart by which one the flood
    /// reached first. A caller that already holds a component can therefore answer the SAME verdict without walking
    /// the map again - the two answers are one reading rather than two that agree today.
    /// </para>
    /// </summary>
    internal sealed class WalkableComponent
    {
        private readonly HashSet<Point> tiles;
        private readonly List<(Point Tile, int Steps)> discovered;

        internal WalkableComponent(HashSet<Point> tiles, List<(Point Tile, int Steps)> discovered)
        {
            this.tiles = tiles;
            this.discovered = discovered;
        }

        /// <summary>The tile the flood started from - the actor's own, and the first entry of <see cref="Discovered"/>.</summary>
        internal Point Origin => this.discovered[0].Tile;

        /// <summary>How many tiles the component holds, the origin included.</summary>
        internal int Count => this.tiles.Count;

        /// <summary>The tiles themselves, for a caller that needs the set rather than one lookup.</summary>
        internal IReadOnlySet<Point> Tiles => this.tiles;

        internal bool Contains(Point tile) => this.tiles.Contains(tile);

        /// <summary>The tiles in the order the flood settled them, the origin first, each with its depth from it.</summary>
        internal IReadOnlyList<(Point Tile, int Steps)> Discovered => this.discovered;
    }

    /// <summary>
    /// The actor's walkable component, as a set — or <c>null</c> when it exceeded the budget, in which case the
    /// caller must make no claim at all. One flood answers reachability for every scene affordance; the alternative
    /// (one flood per target) is the version that does not scale.
    ///
    /// <para>
    /// It shares the planner's cardinal neighbourhood and the same collision predicate as
    /// <see cref="AssessReachability"/>; the difference is that this returns the tiles themselves, because a caller
    /// asking "can I act on THIS target" needs a lookup, not a verdict about one goal.
    /// </para>
    /// </summary>
    internal static WalkableComponent? ReachableTiles(Point actorTile, int maxVisited, Func<Point, bool> canTraverse)
    {
        if (maxVisited <= 0 || !canTraverse(actorTile))
            return null;
        long started = GameThreadCost.BeginSeam();
        WalkableComponent? component = Flood(actorTile, maxVisited, canTraverse);
        GameThreadCost.NoteFlood(started, component?.Count ?? maxVisited);
        return component;
    }

    /// <summary>
    /// Computes the actor's bounded component using the supplied native-planning
    /// walkability predicate. A null result means the component exceeded the hard
    /// probe budget before it could be exhausted, so no enclosure claim is made.
    ///
    /// <para>
    /// <paramref name="reuseComponent"/> is how a caller that ALREADY holds this map's component says so: the supplier
    /// answers the component (flooding only when it must, and accounting for that flood itself) and the verdict is
    /// derived from it, so one approach leg cannot pay for the same 3,700-tile walk twice. No supplier - or a supplier
    /// that answers nothing - floods here.
    /// </para>
    /// </summary>
    internal static ReachabilityVerdict? AssessReachability(
        Point actorTile,
        Point targetTile,
        Func<Point, bool> canTraverse,
        int maxVisited,
        bool findClosestReachable = false,
        bool allowAdjacentArrival = false,
        Func<WalkableComponent?>? reuseComponent = null)
    {
        if (maxVisited <= 0)
            return null;
        long started = GameThreadCost.BeginSeam();
        if (actorTile == targetTile)
        {
            GameThreadCost.NoteFlood(started, 1);
            return new ReachabilityVerdict(false, true, null, 1);
        }
        if (!findClosestReachable)
        {
            // The one case that needs no enumeration at all: the actor is ALREADY adjacent to the target, so
            // the planner has one step left to take and the only question is whether that step is possible.
            //
            // The earlier shortcut asked a different question -- `canTraverse(targetTile)`, "is the target
            // tile itself passable" -- and answered it as if a route had been verified. A live refusal read
            // exactly that as `route_exists=true ... path_search=native_budget_exhausted` for a destination
            // whose cardinal approaches were both blocked, while a measurement at 10000, 40000 and 400000
            // expansions returned null identically. A tile's own collision test says nothing about whether
            // anything can walk to it, so it is no longer used to claim a route.
            foreach (Point offset in CardinalOffsets)
            {
                if (new Point(targetTile.X + offset.X, targetTile.Y + offset.Y) != actorTile)
                    continue;
                GameThreadCost.NoteFlood(started, 1);
                return new ReachabilityVerdict(false, canTraverse(targetTile), null, 1);
            }

            // THE EARLY-EXIT WALK, kept as its own loop because it STOPS: the question is "is the target's arrival
            // ring inside the component", and the first settled tile that answers yes settles it without walking the
            // rest of the map. The full component is the other question, below.
            Point? nearest = null;
            int? nearestSteps = null;
            int nearestDistance = ChebyshevDistance(actorTile, targetTile);
            var visited = new HashSet<Point> { actorTile };
            var pending = new Queue<(Point Tile, int Steps)>();
            pending.Enqueue((actorTile, 0));
            while (pending.Count > 0)
            {
                (Point current, int steps) = pending.Dequeue();
                if (IsTargetNeighbour(current, targetTile, allowAdjacentArrival))
                {
                    GameThreadCost.NoteFlood(started, visited.Count);
                    return new ReachabilityVerdict(false, IsCardinalNeighbour(current, targetTile) && canTraverse(targetTile), current, visited.Count, steps);
                }
                foreach (Point offset in CardinalOffsets)
                {
                    Point next = new(current.X + offset.X, current.Y + offset.Y);
                    // The candidate's adjacency counts only once it is a tile the flood actually VISITED: an
                    // expansion that was rejected for collision is not "the component reaches the target".
                    if (visited.Contains(next) || !canTraverse(next))
                        continue;
                    visited.Add(next);
                    if (IsTargetNeighbour(next, targetTile, allowAdjacentArrival))
                    {
                        GameThreadCost.NoteFlood(started, visited.Count);
                        return new ReachabilityVerdict(false, IsCardinalNeighbour(next, targetTile) && canTraverse(targetTile), next, visited.Count, steps + 1);
                    }
                    if (next != targetTile)
                    {
                        // The closest tile the component offers towards the target: what a staged
                        // approach can aim at when the finder gives up on the far goal.
                        int distance = ChebyshevDistance(next, targetTile);
                        if (distance < nearestDistance)
                        {
                            nearest = next;
                            nearestSteps = steps + 1;
                            nearestDistance = distance;
                        }
                    }
                    if (visited.Count > maxVisited)
                    {
                        GameThreadCost.NoteFlood(started, maxVisited);
                        return null;
                    }
                    pending.Enqueue((next, steps + 1));
                }
            }

            // The walk exhausted the component without settling on an accepted arrival, so no route ends anywhere: the
            // verdict's whole content is the nearest tile it DID reach and what reaching it cost.
            GameThreadCost.NoteFlood(started, visited.Count);
            return new ReachabilityVerdict(true, false, nearest, visited.Count, nearestSteps);
        }

        WalkableComponent? component;
        if (reuseComponent is not null)
        {
            // The supplier either reused a flood or made one, and it is the one that reports it: accounting here as
            // well would bill the same walk twice.
            component = reuseComponent();
        }
        else
        {
            component = Flood(actorTile, maxVisited, canTraverse);
            GameThreadCost.NoteFlood(started, component?.Count ?? maxVisited);
        }
        return component is null ? null : Within(component, actorTile, targetTile, canTraverse(targetTile), allowAdjacentArrival);
    }

    /// <summary>
    /// The verdict one COMPONENT answers about one target: which of its tiles the arrival rule accepts, and the tile
    /// nearest the target with the depth the flood took to reach it.
    ///
    /// <para>
    /// It is the whole derivation, in one place, because two callers now hold a component - the probe that flooded it
    /// and the approach leg that already had it - and two spellings of "what does this map say about that tile" is how
    /// the receipt and the walk start disagreeing.
    /// </para>
    /// </summary>
    internal static ReachabilityVerdict Within(
        WalkableComponent component,
        Point actorTile,
        Point targetTile,
        bool targetTraversable,
        bool allowAdjacentArrival)
    {
        // Two different facts, deliberately kept apart:
        //   * `reachesNeighbourhood` -- the flood VISITED a tile the arrival rule accepts, so the walk can end there.
        //     This is what `TargetEnclosed` denies, and the original contract's question.
        //   * `ComponentContainsTarget` -- the planner can actually STEP ONTO the target, which additionally
        //     requires the target tile itself to be passable. Claiming this without a route is the defect the
        //     live refusal exposed.
        bool reachesNeighbourhood = false;
        bool reachesStep = false;
        foreach ((Point tile, _) in component.Discovered)
        {
            if (!IsTargetNeighbour(tile, targetTile, allowAdjacentArrival))
                continue;
            reachesNeighbourhood = true;
            reachesStep |= IsCardinalNeighbour(tile, targetTile);
        }

        // The closest tile the component offers towards the target, in the flood's OWN order so two equally distant
        // tiles resolve exactly as the breadth-first walk resolved them. The origin never wins: it is exactly the
        // starting distance, and only a STRICT improvement replaces it.
        Point? closest = null;
        int? closestSteps = null;
        int closestDistance = ChebyshevDistance(actorTile, targetTile);
        foreach ((Point tile, int steps) in component.Discovered)
        {
            if (tile == targetTile)
                continue;
            int distance = ChebyshevDistance(tile, targetTile);
            if (distance < closestDistance)
            {
                closest = tile;
                closestSteps = steps;
                closestDistance = distance;
            }
        }

        return new ReachabilityVerdict(
            !reachesNeighbourhood,
            reachesStep && targetTraversable,
            closest,
            component.Count,
            closestSteps);
    }

    /// <summary>
    /// THE flood: one breadth-first walk of the actor's cardinal component, with its own step count per tile and
    /// nothing measured.
    ///
    /// <para>
    /// It is the only loop, so the two callers that must not pay twice cannot drift: <see cref="ReachableTiles"/>
    /// wraps it with the cost meter and the origin guard, and <see cref="AssessReachability"/> wraps it with the
    /// verdict. The membership test comes before the predicate so an already-settled cell is never a second question
    /// for the engine.
    /// </para>
    /// </summary>
    private static WalkableComponent? Flood(Point actorTile, int maxVisited, Func<Point, bool> canTraverse)
    {
        var settled = new HashSet<Point> { actorTile };
        var discovered = new List<(Point Tile, int Steps)> { (actorTile, 0) };
        var pending = new Queue<(Point Tile, int Steps)>();
        pending.Enqueue((actorTile, 0));
        while (pending.Count > 0)
        {
            (Point current, int steps) = pending.Dequeue();
            foreach (Point offset in CardinalOffsets)
            {
                Point next = new(current.X + offset.X, current.Y + offset.Y);
                if (settled.Contains(next) || !canTraverse(next))
                    continue;
                settled.Add(next);
                discovered.Add((next, steps + 1));
                if (settled.Count > maxVisited)
                    return null;
                pending.Enqueue((next, steps + 1));
            }
        }

        return new WalkableComponent(settled, discovered);
    }

    /// <summary>
    /// THE ARRIVAL RULE, not a second one. <see cref="IsArrivalDelta"/> accepts the requested tile, and then either ONLY
    /// that tile (an exact request) or every Chebyshev-1 tile of it (a request that allows an adjacent arrival) -
    /// because `PathFindController` dequeues by `g + manhattan h` and finishes on the first node the predicate accepts,
    /// which is a DIAGONAL tile on 4 of 6 sampled unreachable targets. A Manhattan-only ring here asked a different
    /// question than the engine's own goal, so a world whose only ring tile in the component was diagonal was vetoed
    /// before the engine was ever asked (`native=not_attempted`).
    ///
    /// <para>
    /// What this WIDENS is 'is this tile an arrival', and only where the request itself allows one; the walk's own step
    /// set stays cardinal. The flood must expand the neighbourhood the NATIVE PLANNER uses or its verdict describes a
    /// different graph - `PathFindController.Directions` is cardinal only (`PathFindController.cs:45-51`), so an
    /// eight-neighbour flood calls a tile reachable that the planner must walk around a corner to reach, and on a
    /// cropped field the corner is exactly what is blocked.
    /// </para>
    /// </summary>
    private static bool IsTargetNeighbour(Point tile, Point targetTile, bool allowAdjacentArrival) =>
        tile != targetTile
        && (allowAdjacentArrival
            ? ChebyshevDistance(tile, targetTile) == 1
            : Math.Abs(tile.X - targetTile.X) + Math.Abs(tile.Y - targetTile.Y) == 1);

    /// <summary>
    /// The narrower fact `ComponentContainsTarget` has always meant: the planner can step ONTO the target, which needs
    /// a CARDINAL neighbour in the component however wide the arrival ring is - a diagonal neighbour is a place the
    /// walk may END, never a tile the body can stand on the target from. The STEP SET stays cardinal
    /// (`PathFindController.Directions`), so four-direction walking is still the engine's law.
    /// </summary>
    private static bool IsCardinalNeighbour(Point tile, Point targetTile) =>
        tile != targetTile
        && Math.Abs(tile.X - targetTile.X) + Math.Abs(tile.Y - targetTile.Y) == 1;
}
