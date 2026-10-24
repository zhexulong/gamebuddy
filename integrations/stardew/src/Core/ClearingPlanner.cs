using System;
using System.Collections.Generic;
using System.Linq;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// What must be cleared for a target to become reachable, and what that costs.
/// </summary>
public sealed record ClearingPlan(bool Reachable, IReadOnlyList<(int X, int Y)> Clear, int Cost)
{
    public static readonly ClearingPlan Unreachable = new(false, Array.Empty<(int X, int Y)>(), 0);
}

/// <summary>
/// Decides which tiles count as walkable when some obstacles can be cleared, and at what price.
///
/// This is NOT a replacement for path planning, and it must not become one. The engine already plans
/// correctly on a known walkable graph (`PathFindController.findPath`: uniform step cost, collision
/// excludes the tile). What it cannot express is that a rock is different from a wall - every occupied
/// tile is simply excluded - so a player's own farm, where a rock or a crop often stands on the only
/// route, reads as permanently unreachable and the agent is told only `no_native_path`.
///
/// So the missing piece is the INPUT to planning, not the planning: which tiles become walkable once you
/// pay to clear them, and which clears are worth it. The cheapest set of clears that opens a route is
/// this type's OUTPUT, not its subject - it exists because "clear these and the way opens" is the fact a
/// bare `no_native_path` withholds.
///
/// Costs are in the caller's unit (see the clear-cost table), ties break by the lexicographic order of the
/// cleared tiles so a replay of the same world clears the same things, and nothing here decides WHETHER
/// to clear: that stays the caller's call, and this type only reports the options with their prices.
/// </summary>
public static class ClearingPlanner
{
    private static readonly (int Dx, int Dy)[] Cardinal = { (0, -1), (0, 1), (-1, 0), (1, 0) };

    /// <summary>
    /// The cheapest set of clears that opens a route from <paramref name="actor"/> to
    /// <paramref name="target"/>, searching over walkable tiles plus clearable ones.
    ///
    /// A clearable tile is traversable at its own clearing cost <em>and</em> counts as removed once
    /// paid, which is exactly how the world behaves: you swing once, then walk through where the rock
    /// was. Tiles that are neither walkable nor clearable are walls.
    /// </summary>
    public static ClearingPlan Plan(
        (int X, int Y) actor,
        (int X, int Y) target,
        IReadOnlySet<(int X, int Y)> walkable,
        IReadOnlyDictionary<(int X, int Y), int> clearable)
    {
        if (actor == target)
            return new ClearingPlan(true, Array.Empty<(int X, int Y)>(), 0);

        // The target may itself be the thing to clear: a rock is a legitimate destination for a swing.
        //
        // It is also the one tile where "walkable" and "clearable" can both be true - the tile under a
        // rock is ground an actor could stand on once the rock is gone - so reaching it always charges the
        // clear. That is the honest reading: bounding over the rock is not reaching it.
        bool targetIsClearable = clearable.ContainsKey(target);
        if (!walkable.Contains(target) && !targetIsClearable)
            return ClearingPlan.Unreachable;
        if (targetIsClearable)
            return FinishWithTargetClear(actor, target, walkable, clearable);

        var best = new Dictionary<(int X, int Y), int> { [actor] = 0 };
        var clearedBy = new Dictionary<(int X, int Y), List<(int X, int Y)>> { [actor] = new() };
        var pending = new List<((int X, int Y) Tile, int Cost)> { (actor, 0) };

        while (pending.Count > 0)
        {
            // Small graphs: a linear scan for the cheapest frontier entry is clear and deterministic.
            int pick = 0;
            for (int i = 1; i < pending.Count; i += 1)
                if (pending[i].Cost < pending[pick].Cost)
                    pick = i;
            ((int X, int Y) tile, int cost) = pending[pick];
            pending.RemoveAt(pick);

            if (cost > best.GetValueOrDefault(tile, int.MaxValue))
                continue;

            if (tile == target)
                return new ClearingPlan(true, clearedBy[tile].ToList(), cost);

            foreach ((int dx, int dy) in Cardinal)
            {
                (int X, int Y) next = (tile.X + dx, tile.Y + dy);
                int step;
                bool clears = false;
                if (walkable.Contains(next))
                {
                    step = 0;
                }
                else if (clearable.TryGetValue(next, out int clearCost))
                {
                    step = clearCost;
                    clears = true;
                }
                else
                {
                    continue;
                }

                int nextCost = cost + step;
                if (nextCost >= best.GetValueOrDefault(next, int.MaxValue))
                    continue;

                best[next] = nextCost;
                List<(int X, int Y)> path = new(clearedBy[tile]);
                if (clears)
                    path.Add(next);
                clearedBy[next] = path;
                pending.Add((next, nextCost));
            }
        }

        return ClearingPlan.Unreachable;
    }

    /// <summary>
    /// The target is itself clearable, so the route to it plus its own clear is the answer.
    ///
    /// Its tile is not traversable on the way in - an actor does not walk through a rock - so the route
    /// is computed to any cardinal neighbour and the target's own cost is added once.
    /// </summary>
    private static ClearingPlan FinishWithTargetClear(
        (int X, int Y) actor,
        (int X, int Y) target,
        IReadOnlySet<(int X, int Y)> walkable,
        IReadOnlyDictionary<(int X, int Y), int> clearable)
    {
        int targetCost = clearable[target];

        // Nearest standable neighbour that is walkable at all: the actor swings from there.
        ClearingPlan best = ClearingPlan.Unreachable;
        foreach ((int dx, int dy) in Cardinal)
        {
            (int X, int Y) from = (target.X + dx, target.Y + dy);
            if (!walkable.Contains(from) && !clearable.ContainsKey(from))
                continue;
            ClearingPlan approach = Plan(actor, from, walkable, clearable);
            if (!approach.Reachable)
                continue;
            var clears = new List<(int X, int Y)>(approach.Clear);
            if (!clears.Contains(target))
                clears.Add(target);
            int cost = approach.Cost + targetCost;
            if (best.Reachable && best.Cost <= cost)
                continue;
            best = new ClearingPlan(true, clears, cost);
        }

        return best;
    }
}
