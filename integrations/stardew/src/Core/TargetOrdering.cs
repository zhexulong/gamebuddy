using System;
using System.Collections.Generic;
using System.Linq;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// A target family row as ordering needs to see it: a tile, and whatever made it unique.
/// </summary>
public readonly record struct TargetCandidate(int X, int Y, int Slot);

/// <summary>
/// The order an addressable target family is published in, when the family is larger than one plan can consume.
///
/// <para>
/// `MAX_PLAN_NODES` is 16, so one script names at most sixteen rows, while the seed and sapling families publish up to
/// 64 each. Measured 2026-10-29 (`round7`): those two families were 6.8 KB and 7.2 KB of a 32.8 KB observation, and the
/// iteration order - inventory slot, then x, then y - put whichever tile the loops reached first at the front, so the
/// sixteen a script could reach soonest were scattered through a list of sixty-four.
/// </para>
/// <para>
/// Trimming is NOT available here, and that is the constraint that shaped this file: `ExecutePlantSeed` recomputes
/// `BuildSeedTargetId` from slot and tile and refuses the dispatch on a mismatch, so a row the model was never shown is
/// a target it can never name. Ordering changes which sixteen are cheapest to use and removes nothing.
/// </para>
/// </summary>
public static class TargetOrdering
{
    /// <summary>
    /// Nearest first by Chebyshev distance from the actor, then by slot, then by tile.
    ///
    /// <para>
    /// Chebyshev, not Manhattan: the same metric every range check in the execution manager uses
    /// (`ChebyshevDistance`, `IsTileWithinChebyshevRadius`), so "nearest" here means nearest by the rule that will
    /// decide whether the dispatch is in range at all.
    /// </para>
    /// <para>
    /// The two tie-breaks exist so one unchanged world cannot produce two orders. A dictionary-backed source has no
    /// order of its own, and a list that reshuffles between two observations teaches the model that the ids are
    /// unstable.
    /// </para>
    /// </summary>
    public static IReadOnlyList<T> NearestFirstByChebyshev<T>(
        IEnumerable<T> candidates,
        int actorX,
        int actorY,
        Func<T, TargetCandidate> project
    ) =>
        candidates
            .OrderBy(candidate =>
            {
                TargetCandidate row = project(candidate);
                return Math.Max(Math.Abs(row.X - actorX), Math.Abs(row.Y - actorY));
            })
            .ThenBy(candidate => project(candidate).Slot)
            .ThenBy(candidate => project(candidate).Y)
            .ThenBy(candidate => project(candidate).X)
            .ToArray();
}
