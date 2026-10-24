using System;
using System.Collections.Generic;
using System.Linq;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// The clear plan for one refusal, as the receipt will carry it.
///
/// This is the bridge between "the engine found no path" and the two facts an agent needs to act:
/// WHICH tiles must be cleared, and WHAT that costs. It exists as a separate pure function so the
/// wording of the receipt cannot drift from the search that produced it.
/// </summary>
public static class ClearingEvidence
{
    /// <summary>
    /// Format a plan as `key=value` pairs, or null when nothing can be said.
    ///
    /// Null means either "the target is already reachable" (no clears are needed, so this evidence is
    /// noise) or "no number of clears opens the way" (a wall is not a bill). The caller adds the
    /// distinguishing word, because it also knows whether the engine was asked at all.
    /// </summary>
    public static string? Describe(ClearingPlan plan, Func<(int X, int Y), string?> kindAt)
    {
        if (!plan.Reachable || plan.Clear.Count == 0)
            return null;

        var parts = new List<string>(plan.Clear.Count);
        foreach ((int x, int y) in plan.Clear)
        {
            string? kind = kindAt((x, y));
            // A tile in the plan whose kind cannot be named would be a contradiction: the search only
            // enters tiles it was given a price for. Naming it `<unknown>` rather than guessing keeps the
            // contradiction visible instead of hiding it behind a plausible word.
            parts.Add($"{kind ?? "unknown"}@{x},{y}");
        }

        return $"clear_to_reach={string.Join(",", parts)};clear_tiles={plan.Clear.Count};clear_cost={plan.Cost}";
    }
}
