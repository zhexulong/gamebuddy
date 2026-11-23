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
/// </summary>
internal sealed partial class StardewBodyController
{
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
    internal static HashSet<Point>? ReachableTiles(Point actorTile, int maxVisited, Func<Point, bool> canTraverse)
    {
        if (maxVisited <= 0 || !canTraverse(actorTile))
            return null;
        long started = GameThreadCost.BeginSeam();
        var visited = new HashSet<Point> { actorTile };
        var pending = new Queue<Point>();
        pending.Enqueue(actorTile);
        while (pending.Count > 0)
        {
            Point current = pending.Dequeue();
            foreach (Point offset in CardinalOffsets)
            {
                Point next = new(current.X + offset.X, current.Y + offset.Y);
                if (!canTraverse(next) || !visited.Add(next))
                    continue;
                if (visited.Count > maxVisited)
                {
                    GameThreadCost.NoteFlood(started, maxVisited);
                    return null;
                }
                pending.Enqueue(next);
            }
        }
        GameThreadCost.NoteFlood(started, visited.Count);
        return visited;
    }

    /// <summary>
    /// Computes the actor's bounded component using the supplied native-planning
    /// walkability predicate. A null result means the component exceeded the hard
    /// probe budget before it could be exhausted, so no enclosure claim is made.
    /// </summary>
    internal static ReachabilityVerdict? AssessReachability(
        Point actorTile,
        Point targetTile,
        Func<Point, bool> canTraverse,
        int maxVisited,
        bool findClosestReachable = false,
        bool allowAdjacentArrival = false)
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
        }

        // The flood must expand the neighbourhood the NATIVE PLANNER uses, or its verdict describes a
        // different graph. `PathFindController.Directions` is cardinal only (`PathFindController.cs:45-51`:
        // { -1,0 }, { 1,0 }, { 0,1 }, { 0,-1 }), so the planner can never step diagonally. An 8-neighbour
        // flood therefore calls a tile "reachable" that the planner must walk around a corner to reach, and
        // on a cropped field the corner is exactly what is blocked. Measured on the real fixture, actor at
        // 3,9: the cardinal neighbour 3,10 resolves (2-node path at every limit), while the diagonal-only
        // neighbour 4,8 returns null at 10000, 40000 AND 400000 expansions -- the limit is not the variable.
        Point[] neighbours = CardinalOffsets;
        static int Manhattan(Point left, Point right) =>
            Math.Abs(left.X - right.X) + Math.Abs(left.Y - right.Y);
        static int Chebyshev(Point left, Point right) =>
            Math.Max(Math.Abs(left.X - right.X), Math.Abs(left.Y - right.Y));
        // THE ARRIVAL RULE, not a second one. `IsArrivalDelta` accepts the requested tile, and then either ONLY that tile
        // (an exact request) or every Chebyshev-1 tile of it (a request that allows an adjacent arrival) - because
        // `PathFindController` dequeues by `g + manhattan h` and finishes on the first node the predicate accepts, which
        // is a DIAGONAL tile on 4 of 6 sampled unreachable targets. A Manhattan-only ring here asked a different question
        // than the engine's own goal, so a world whose only ring tile in the component was diagonal was vetoed before the
        // engine was ever asked (`native=not_attempted`). The STEP SET stays cardinal - `neighbours` below, and
        // `PathFindController.Directions` - so four-direction walking is still the engine's law; only "is this tile an
        // arrival" widened, and only where the request itself allows one.
        bool IsTargetNeighbour(Point tile) =>
            tile != targetTile
            && (allowAdjacentArrival ? Chebyshev(tile, targetTile) == 1 : Manhattan(tile, targetTile) == 1);
        // The narrower fact `ComponentContainsTarget` has always meant: the planner can step ONTO the target, which needs
        // a CARDINAL neighbour in the component however wide the arrival ring is - a diagonal neighbour is a place the
        // walk may END, never a tile the body can stand on the target from.
        bool IsCardinalNeighbour(Point tile) =>
            tile != targetTile && Manhattan(tile, targetTile) == 1;
        // Two different facts, deliberately kept apart:
        //   * `reachesNeighbourhood` -- the flood VISITED a tile the arrival rule accepts, so the walk can end there.
        //     This is what `TargetEnclosed` denies, and the original contract's question.
        //   * `ComponentContainsTarget` -- the planner can actually STEP ONTO the target, which additionally
        //     requires the target tile itself to be passable. Claiming this without a route is the defect the
        //     live refusal exposed.
        bool reachesNeighbourhood = false;
        bool reachesStep = false;
        bool targetTraversable = canTraverse(targetTile);
        Point? closest = null;
        int? closestSteps = null;
        int closestDistance = Chebyshev(actorTile, targetTile);
        var visited = new HashSet<Point> { actorTile };
        // The queue carries the tile's own depth, because `detour_steps` is a distance the caller weighs against a
        // clear's price and a Manhattan estimate is not that number.
        var pending = new Queue<(Point Tile, int Steps)>();
        pending.Enqueue((actorTile, 0));

        while (pending.Count > 0)
        {
            (Point current, int steps) = pending.Dequeue();
            if (IsTargetNeighbour(current))
            {
                reachesNeighbourhood = true;
                reachesStep |= IsCardinalNeighbour(current);
                if (!findClosestReachable)
                {
                    GameThreadCost.NoteFlood(started, visited.Count);
                    return new ReachabilityVerdict(false, reachesStep && targetTraversable, current, visited.Count, steps);
                }
            }
            foreach (Point offset in neighbours)
            {
                Point next = new(current.X + offset.X, current.Y + offset.Y);
                // The candidate's adjacency counts only once it is a tile the flood actually VISITED: an
                // expansion that was rejected for collision is not "the component reaches the target".
                if (!canTraverse(next) || !visited.Add(next))
                    continue;
                if (IsTargetNeighbour(next))
                {
                    reachesNeighbourhood = true;
                    reachesStep |= IsCardinalNeighbour(next);
                    if (!findClosestReachable)
                    {
                        GameThreadCost.NoteFlood(started, visited.Count);
                        return new ReachabilityVerdict(false, reachesStep && targetTraversable, next, visited.Count, steps + 1);
                    }
                }
                if (next != targetTile)
                {
                    // The closest tile the component offers towards the target: what a staged
                    // approach can aim at when the finder gives up on the far goal.
                    int distance = Chebyshev(next, targetTile);
                    if (distance < closestDistance)
                    {
                        closest = next;
                        closestSteps = steps + 1;
                        closestDistance = distance;
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

        GameThreadCost.NoteFlood(started, visited.Count);
        return new ReachabilityVerdict(!reachesNeighbourhood, reachesStep && targetTraversable, closest, visited.Count, closestSteps);
    }
}
