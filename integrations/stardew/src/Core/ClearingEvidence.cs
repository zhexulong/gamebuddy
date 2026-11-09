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

    /// <summary>
    /// The same plan, plus where the actor must stand and which single tile it will hit first.
    ///
    /// The tile list alone leaves the caller with the hard part: a rock is removed from an adjacent tile, and
    /// that tile is often not where the actor already is. Measured on a live run, an Agent holding
    /// `clear_to_reach=rock@53,14` re-aimed at neighbouring tiles and described the result as a maze - it had
    /// been told the price but not the step.
    ///
    /// Only the head is resolved, because the executor clears one obstacle and then re-plans against a world
    /// that has changed. `remaining_clears` reports the whole idea's size without authorising a chain.
    /// </summary>
    public static string? DescribeFirstStep(FirstClearStep step, Func<(int X, int Y), string?> kindAt)
    {
        if (!step.Reachable || step.BlockerTile is not { } blocker || step.ApproachTile is not { } approach)
            return null;

        string kind = kindAt(blocker) ?? "unknown";
        return $"clear_step={kind}@{blocker.X},{blocker.Y};stand_at={approach.X},{approach.Y};remaining_clears={step.RemainingClears}";
    }

    /// <summary>
    /// The step's other half: WHAT stands there, the id the frame published for it, and which of our actions removes it.
    ///
    /// <para>
    /// <see cref="DescribeFirstStep"/> names the tile and where to hit it from, in the clearing SEARCH's own words -
    /// `rock`, `weed`, a price. That is enough to describe a cost and not enough to act: measured `round40` attempt 2,
    /// one weed on a four-way route was the run's only failed action, and the refusal that ended it said
    /// `clear_step=weed@40,9;stand_at=39,9` and nothing about which action swings at a weed. The Agent abandoned the
    /// tile instead of clearing it.
    /// </para>
    /// <para>
    /// <paramref name="occupant"/> is the engine's own name for the thing on the tile, so a caller reading it is reading
    /// what the game calls it rather than what the costing table calls it - the two differ exactly where the caller
    /// needs them to (a `quarry_boulder` is priced as a `rock`). <paramref name="targetId"/> is null when the frame the
    /// caller's plan was compiled against carried no row for that tile, and that absence is stated as
    /// <see cref="BlockerNotPublished"/> rather than filled with a rebuilt hash: an id only exists for what a frame
    /// published, and an invented one would be an identity the caller can never satisfy.
    /// </para>
    /// <para>
    /// The absence of a clearing action is stated too, and in the same shape: <c>no_published_action_clears:&lt;kind&gt;</c>,
    /// so "nothing we have removes this" is one word a caller can branch on instead of a missing key it must guess at.
    /// </para>
    /// </summary>
    public static string DescribeBlocker(string occupant, string? targetId, IReadOnlyList<string> clearingActions)
    {
        ArgumentNullException.ThrowIfNull(occupant);
        ArgumentNullException.ThrowIfNull(clearingActions);
        string clears = clearingActions.Count == 0
            ? $"{NoPublishedActionClears}:{occupant}"
            : string.Join(",", clearingActions);
        return $"blocker_occupant={occupant};clears_with={clears};blocker_target={targetId ?? BlockerNotPublished}";
    }

    /// <summary>What the evidence says when the frame published no row for the blocker's tile.</summary>
    public const string BlockerNotPublished = "blocker_not_published";

    /// <summary>What the evidence says when no published action declares it can remove the occupant.</summary>
    public const string NoPublishedActionClears = "no_published_action_clears";
}
