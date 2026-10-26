using System;
using System.Collections.Generic;
using System.Linq;

namespace GameBuddy.Stardew.Core;

/// <summary>One step of a soft-cost path: the tile to occupy, and whether occupying it costs a clear.</summary>
public sealed record SoftPathStep((int X, int Y) Tile, bool RequiresClear, int Cost);

/// <summary>
/// A route that prices walking and clearing in the SAME unit, so "go around it" and "deal with it" can be
/// compared instead of the second one being silently impossible.
///
/// <see cref="Steps"/> never contains the actor's starting tile: step 0 is the first tile moved onto.
/// </summary>
public sealed record SoftCostPath(
    bool Reachable,
    IReadOnlyList<SoftPathStep> Steps,
    int TotalCost,
    string ReasonCode)
{
    public static SoftCostPath Unreachable(string reasonCode) =>
        new(false, Array.Empty<SoftPathStep>(), 0, reasonCode);

    /// <summary>
    /// The first step that has to be cleared away, or null when the route is pure walking.
    ///
    /// Only the FIRST one is reported as an action, because the executor clears exactly one obstacle and
    /// then re-plans against a fresh world. A plan that promised a second clear would be promising a world
    /// that no longer exists.
    /// </summary>
    public SoftPathStep? FirstClear =>
        Steps.FirstOrDefault(step => step.RequiresClear);

    /// <summary>The tiles walked before the first clear. Pure walking by construction.</summary>
    public IReadOnlyList<(int X, int Y)> WalkToFirstClear =>
        Steps.TakeWhile(step => !step.RequiresClear).Select(step => step.Tile).ToArray();

    /// <summary>
    /// How many clears the whole route would need. The executor performs at most one and re-plans; this is
    /// reported so a caller can see the price of the whole idea, not to authorise a chain.
    /// </summary>
    public int ClearCount => Steps.Count(step => step.RequiresClear);
}

/// <summary>
/// Forward soft-cost path search: A* over walkable tiles plus CLEARABLE ones that become walkable once paid
/// for, with both priced in steps.
///
/// Why this exists at all: the engine's finder treats every occupied tile as a wall, so a rock on the only
/// route reads as "unreachable" and the caller is told `no_native_path`. A player in that situation does not
/// experience "unreachable"; they experience two options with different prices. This search produces those
/// options and prices, and nothing else - it does not decide whether to take one.
///
/// Deliberately NOT the engine's plan: the final authority on whether a walk is possible stays
/// `PathFindController`. A caller must still ask the engine to build the walk to
/// <see cref="SoftCostPath.WalkToFirstClear"/>'s last tile, and treat a disagreement as a fact to report
/// rather than a fallback to hide.
///
/// Costs: a walking step costs 1, a clear costs whatever <c>clearCostAt</c> returns, and those units match
/// by construction (<see cref="ClearCostTable"/>'s allowance is expressed in steps). Ties break by cost,
/// then lowest y, then lowest x, so one world always yields one path.
/// </summary>
public static class SoftCostPathPlanner
{
    /// <summary>The engine's own step set: cardinal only, the same four neighbours `PathFindController` searches.</summary>
    private static readonly (int Dx, int Dy)[] Cardinal = { (0, -1), (0, 1), (-1, 0), (1, 0) };

    /// <summary>A walking step, in the same unit as a clear's price.</summary>
    public const int WalkStepCost = 1;

    /// <summary>
    /// The bounded search. A caller that hits the cap gets a named refusal, never a partial path: an
    /// incomplete route presented as complete is the failure mode this exists to prevent.
    /// </summary>
    public const int DefaultMaxExpansions = 4096;

    public static SoftCostPath Plan(
        (int X, int Y) actor,
        (int X, int Y) target,
        Func<(int X, int Y), bool> isWalkable,
        Func<(int X, int Y), int?> clearCostAt,
        int maxExpansions = DefaultMaxExpansions)
    {
        ArgumentNullException.ThrowIfNull(isWalkable);
        ArgumentNullException.ThrowIfNull(clearCostAt);
        if (actor == target)
            return new SoftCostPath(true, Array.Empty<SoftPathStep>(), 0, "already_there");

        // Cost paid to arrive at a tile, and the route that got there. Both keyed by tile.
        var costTo = new Dictionary<(int X, int Y), int> { [actor] = 0 };
        var routeTo = new Dictionary<(int X, int Y), IReadOnlyList<SoftPathStep>>
        {
            [actor] = Array.Empty<SoftPathStep>(),
        };
        var frontier = new List<((int X, int Y) Tile, int Cost)> { (actor, 0) };
        int expansions = 0;

        while (frontier.Count > 0)
        {
            if (expansions >= maxExpansions)
                return SoftCostPath.Unreachable("search_budget_exhausted");
            expansions += 1;

            int pick = Cheapest(frontier);
            ((int X, int Y) tile, int cost) = frontier[pick];
            frontier.RemoveAt(pick);

            if (cost > costTo.GetValueOrDefault(tile, int.MaxValue))
                continue;

            if (tile == target)
                return new SoftCostPath(true, routeTo[tile], cost, "planned");

            foreach ((int dx, int dy) in Cardinal)
            {
                (int X, int Y) next = (tile.X + dx, tile.Y + dy);
                int stepCost;
                bool requiresClear;
                if (isWalkable(next))
                {
                    stepCost = WalkStepCost;
                    requiresClear = false;
                }
                else if (clearCostAt(next) is int clearPrice)
                {
                    stepCost = clearPrice;
                    requiresClear = true;
                }
                else
                {
                    continue;
                }

                int nextCost = cost + stepCost;
                if (nextCost >= costTo.GetValueOrDefault(next, int.MaxValue))
                    continue;

                SoftPathStep[] route = routeTo[tile].Append(new SoftPathStep(next, requiresClear, stepCost)).ToArray();
                costTo[next] = nextCost;
                routeTo[next] = route;
                frontier.Add((next, nextCost));
            }
        }

        return SoftCostPath.Unreachable("no_route_even_with_clearing");
    }

    /// <summary>
    /// Linear scan for the cheapest frontier entry, ties broken by lowest y then lowest x so the same world
    /// always produces the same route.
    /// </summary>
    private static int Cheapest(List<((int X, int Y) Tile, int Cost)> frontier)
    {
        int pick = 0;
        for (int index = 1; index < frontier.Count; index += 1)
        {
            (int X, int Y) candidateTile = frontier[index].Tile;
            int candidateCost = frontier[index].Cost;
            (int X, int Y) bestTile = frontier[pick].Tile;
            int bestCost = frontier[pick].Cost;
            if (candidateCost > bestCost) continue;
            if (candidateCost == bestCost && (candidateTile.Y > bestTile.Y || (candidateTile.Y == bestTile.Y && candidateTile.X > bestTile.X)))
                continue;
            pick = index;
        }

        return pick;
    }
}
