using System;
using System.Collections.Generic;
using System.Linq;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// The FIRST clear a route needs, resolved down to where the actor must stand and what it will hit.
///
/// This is the difference between advice and a plan. <see cref="ClearingPlanner"/> already answers "which
/// tiles must go, and what do they cost", but a caller given only a tile list still has to work out how to
/// get to the rock - and the tile it must stand on is often not adjacent to the actor, sometimes not even
/// reachable without another clear first.
///
/// So this resolves exactly one step, deliberately:
///
/// <list type="bullet">
/// <item><see cref="ApproachTile"/> - a tile the actor can WALK to right now (no further clearing) and
/// from which the blocker is within native tool reach;</item>
/// <item><see cref="BlockerTile"/> - the single tile to remove;</item>
/// <item><see cref="RemainingClears"/> - how many the whole original plan wanted, so a caller can see the
/// price of the whole idea without being authorised to chain it.</item>
/// </list>
///
/// Only the first clear is resolved because the executor performs one clear and then re-plans against a
/// world that has changed. A plan that promised a second clear would be promising a world that no longer
/// exists - which is why <see cref="RemainingClears"/> is reported as a count and nothing more.
/// </summary>
public sealed record FirstClearStep(
    bool Reachable,
    (int X, int Y)? BlockerTile,
    (int X, int Y)? ApproachTile,
    int RemainingClears,
    string ReasonCode)
{
    public static FirstClearStep None(string reasonCode) => new(false, null, null, 0, reasonCode);
}

/// <summary>
/// Resolves the first clear of a clearing plan into an actionable step.
///
/// The search is intentionally narrow: a breadth-first walk over the tiles the actor can already reach,
/// ranked by distance to the blocker, stopping at the first tile from which the blocker is within native
/// tool reach. It never routes THROUGH a blocker - that would be the second clear the executor is not
/// authorised to promise.
/// </summary>
public static class ClearStepPlanner
{
    /// <summary>
    /// The native tool reach: a swing hits a tile at Chebyshev distance 1. Named here so the planner and
    /// the action families cannot disagree about what "close enough to hit" means.
    /// </summary>
    public const int ToolReach = 1;

    /// <summary>
    /// The bounded walk. A caller that hits the cap gets a named refusal rather than a guess: an
    /// unverified approach tile is worse than none, because the actor would walk somewhere useless.
    /// </summary>
    public const int DefaultMaxExpansions = 4096;

    public static FirstClearStep Resolve(
        (int X, int Y) actor,
        ClearingPlan plan,
        IReadOnlySet<(int X, int Y)> walkable,
        int maxExpansions = DefaultMaxExpansions)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(walkable);

        if (!plan.Reachable)
            return FirstClearStep.None("plan_unreachable");
        if (plan.Clear.Count == 0)
            return FirstClearStep.None("no_clear_required");

        // The plan is ordered cheapest-first by the search that produced it, so the head is the tile whose
        // removal opens the most for the least - the one worth resolving.
        (int X, int Y) blocker = plan.Clear[0];
        int remaining = plan.Clear.Count;

        // Already adjacent: no walk needed, and reporting an approach tile equal to the actor's own tile
        // would make the caller issue a zero-length move.
        if (WithinToolReach(actor, blocker))
            return new FirstClearStep(true, blocker, actor, remaining, "already_in_reach");

        // Breadth-first from the actor over tiles it can ALREADY walk: the first tile that brings the
        // blocker within reach is the closest such place by construction, so it is also the shortest walk.
        var seen = new HashSet<(int X, int Y)> { actor };
        var queue = new Queue<(int X, int Y)>();
        queue.Enqueue(actor);
        int expansions = 0;

        while (queue.Count > 0)
        {
            if (expansions >= maxExpansions)
                return FirstClearStep.None("approach_search_budget_exhausted");
            expansions += 1;

            (int X, int Y) tile = queue.Dequeue();
            foreach ((int dx, int dy) in Cardinal)
            {
                (int X, int Y) next = (tile.X + dx, tile.Y + dy);
                if (!seen.Add(next))
                    continue;

                // A blocker is not a step. Walking onto it is the second clear this planner must not plan.
                if (Equals(next, blocker))
                    continue;

                // TWO facts, both required, and the order matters: a tile the actor cannot occupy is not
                // an approach tile however close it is. Checking reach first would return a wall, a pond or
                // a building as the place to stand - `TheWalkIsBoundedByTheWalkableSetNotByDistance` failed
                // exactly that way before this line moved.
                if (!walkable.Contains(next))
                    continue;

                if (WithinToolReach(next, blocker))
                    return new FirstClearStep(true, blocker, next, remaining, "approach_found");

                queue.Enqueue(next);
            }
        }

        // The plan says clearing opens the way, yet no tile the actor can already reach brings the
        // blocker within reach. That is a fact about the WORLD, not a search limit: the blocker is
        // reachable only through itself, which is the one thing the executor cannot do in one step.
        return FirstClearStep.None("blocker_unapproachable_without_another_clear");
    }

    private static readonly (int Dx, int Dy)[] Cardinal = { (0, -1), (0, 1), (-1, 0), (1, 0) };

    private static bool WithinToolReach((int X, int Y) a, (int X, int Y) b) =>
        Math.Abs(a.X - b.X) <= ToolReach && Math.Abs(a.Y - b.Y) <= ToolReach;
}
