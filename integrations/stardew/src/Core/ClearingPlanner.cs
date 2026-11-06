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
    /// How many distinct targets one plan may expand. A field full of weeds is a chain of clearable tiles, and
    /// `FinishWithTargetClear` asks `Plan` for each clearable neighbour, so the search is recursive by
    /// construction: without a bound it walks that chain one stack frame per tile.
    ///
    /// <para>
    /// Measured 2026-11-06: a live run died with `STATUS_STACK_OVERFLOW` (exit 0xC00000FD) inside
    /// `ClearingPlanner.FinishWithTargetClear` while picking up an item across a weedy field - the game process
    /// was gone and the run reported `night_watched_over_a_dead_bridge:pipe_closed`, which named nothing.
    /// </para>
    /// <para>
    /// Exceeding the budget answers `Unreachable`, which is the honest answer available here ("I did not find a
    /// route within what I will pay to look"); it is NOT a claim that no route exists, and the caller says so.
    /// </para>
    /// </summary>
    private const int ExpansionBudget = 256;

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
        var memo = new Dictionary<(int X, int Y), ClearingPlan>();
        var expanding = new HashSet<(int X, int Y)>();
        int budget = ExpansionBudget;
        return PlanCore(actor, target, walkable, clearable, memo, expanding, ref budget);
    }

    private static ClearingPlan PlanCore(
        (int X, int Y) actor,
        (int X, int Y) target,
        IReadOnlySet<(int X, int Y)> walkable,
        IReadOnlyDictionary<(int X, int Y), int> clearable,
        Dictionary<(int X, int Y), ClearingPlan> memo,
        HashSet<(int X, int Y)> expanding,
        ref int budget)
    {
        if (actor == target)
            return new ClearingPlan(true, Array.Empty<(int X, int Y)>(), 0);
        if (memo.TryGetValue(target, out ClearingPlan? cached) && cached is not null)
            return cached;

        // A target already on the expansion path cannot be part of a cheaper route: clearing A to reach B to
        // reach A again costs strictly more than the prefix it repeats.
        if (!expanding.Add(target))
            return ClearingPlan.Unreachable;

        try
        {
            if (budget <= 0)
                return ClearingPlan.Unreachable;
            budget -= 1;

            ClearingPlan result = Expand(actor, target, walkable, clearable, memo, expanding, ref budget);
            memo[target] = result;
            return result;
        }
        finally
        {
            expanding.Remove(target);
        }
    }

    private static ClearingPlan Expand(
        (int X, int Y) actor,
        (int X, int Y) target,
        IReadOnlySet<(int X, int Y)> walkable,
        IReadOnlyDictionary<(int X, int Y), int> clearable,
        Dictionary<(int X, int Y), ClearingPlan> memo,
        HashSet<(int X, int Y)> expanding,
        ref int budget)
    {
        // The target may itself be the thing to clear: a rock is a legitimate destination for a swing.
        //
        // It is also the one tile where "walkable" and "clearable" can both be true - the tile under a
        // rock is ground an actor could stand on once the rock is gone - so reaching it always charges the
        // clear. That is the honest reading: bounding over the rock is not reaching it.
        bool targetIsClearable = clearable.ContainsKey(target);
        if (!walkable.Contains(target) && !targetIsClearable)
            return ClearingPlan.Unreachable;
        if (targetIsClearable)
            return FinishWithTargetClear(actor, target, walkable, clearable, memo, expanding, ref budget);

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
        IReadOnlyDictionary<(int X, int Y), int> clearable,
        Dictionary<(int X, int Y), ClearingPlan> memo,
        HashSet<(int X, int Y)> expanding,
        ref int budget)
    {
        int targetCost = clearable[target];

        // Nearest standable neighbour that is walkable at all: the actor swings from there.
        ClearingPlan best = ClearingPlan.Unreachable;
        foreach ((int dx, int dy) in Cardinal)
        {
            (int X, int Y) from = (target.X + dx, target.Y + dy);
            if (!walkable.Contains(from) && !clearable.ContainsKey(from))
                continue;
            ClearingPlan approach = PlanCore(actor, from, walkable, clearable, memo, expanding, ref budget);
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
