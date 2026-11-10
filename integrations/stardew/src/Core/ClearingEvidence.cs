using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Policy;

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
    /// The step's other half: WHAT stands there, the id the frame published for it, and what it costs to get rid of it.
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
    /// EVERY clearer is named with ITS OWN cost - the tool the swing needs, the turns it takes, and the engine's stamina
    /// charge for the occupant's clear kind - because "clear it" and "go around it" are two prices and only one of them
    /// used to be published. The charge is per OCCUPANT (it is the engine's formula for the kind standing there), so one
    /// number is quoted for every clearer of that occupant; what differs per row is the tool and the turn.
    /// </para>
    /// <para>
    /// The absence of a clearing action is stated in the same shape: <c>no_published_action_clears:&lt;kind&gt;</c>, so
    /// "nothing we have removes this" is one word a caller can branch on instead of a missing key it must guess at. It
    /// is the right answer for a bush: `harvest_bush` declares no `Clears`, because harvesting a bush is not a way
    /// through one.
    /// </para>
    /// </summary>
    /// <param name="occupant">The engine's own name for what stands on the tile.</param>
    /// <param name="blockerTile">The tile it stands on, so the fact is a place and not just a kind.</param>
    /// <param name="targetId">The id the frame published for that occupant, or null when it published no row.</param>
    /// <param name="clearers">Every published action whose declaration removes the occupant, with its own price.</param>
    /// <param name="staminaCharge">
    /// The engine's stamina charge for one swing at this occupant, or null when it could not be decided from the live
    /// tool and skill - which is published as <see cref="Undecided"/> rather than as a free swing.
    /// </param>
    /// <param name="detourFacts">
    /// <see cref="DescribeDetour"/>'s half of the same decision (what going around costs), or null when this receipt has
    /// no goal to measure against.
    /// </param>
    public static string DescribeBlocker(
        string occupant,
        (int X, int Y) blockerTile,
        string? targetId,
        IReadOnlyList<FarmhandClearingOffer> clearers,
        int? staminaCharge,
        string? detourFacts)
    {
        ArgumentNullException.ThrowIfNull(occupant);
        ArgumentNullException.ThrowIfNull(clearers);
        string clears = clearers.Count == 0
            ? $"{NoPublishedActionClears}:{occupant}"
            : string.Join(",", clearers.Select(offer => $"{offer.ActionId}({DescribeCost(offer.Cost, staminaCharge)})"));
        string described = $"{Occupant(occupant, blockerTile)};clears_with={clears};blocker_target={targetId ?? BlockerNotPublished}";
        return string.IsNullOrEmpty(detourFacts) ? described : $"{described};{detourFacts}";
    }

    /// <summary>
    /// The SAME two facts in the HINT's size, for the one channel a settled failure keeps.
    ///
    /// <para>
    /// The hint is bounded (<see cref="GameBuddy.Stardew.Core.BodyPrograms.BodyProgramValidation.MaximumNodeHintLength"/>)
    /// and it is the ONLY fact that reaches the model after a failure settles (ADR-006 withholds a settled failure's
    /// evidence), so it carries the obstruction and the clearer but not the price: `clears_with=cut_weeds`, not
    /// `cut_weeds(stamina:0,tool:scythe,turns:1)`. Measured `round41`: a 19-tile route closed by one weed was refused
    /// eleven times and every hint named a `closest=` tile and not the weed, so she lost 76 seconds and escaped by
    /// cutting weeds nothing had named.
    /// </para>
    /// </summary>
    public static string DescribeBlockerBrief(string occupant, (int X, int Y) blockerTile, IReadOnlyList<FarmhandClearingOffer> clearers)
    {
        ArgumentNullException.ThrowIfNull(occupant);
        ArgumentNullException.ThrowIfNull(clearers);
        string clears = clearers.Count == 0
            ? $"{NoPublishedActionClears}:{occupant}"
            : string.Join(",", clearers.Select(offer => offer.ActionId));
        return $"{Occupant(occupant, blockerTile)};clears_with={clears}";
    }

    /// <summary>The occupant token both shapes share: the engine's name AND the tile it stands on.</summary>
    private static string Occupant(string occupant, (int X, int Y) tile) =>
        $"blocker_occupant={occupant}@{tile.X.ToString(CultureInfo.InvariantCulture)},{tile.Y.ToString(CultureInfo.InvariantCulture)}";

    /// <summary>
    /// The OTHER branch of the same decision: what it costs to leave the obstruction alone.
    ///
    /// <para>
    /// The number is the steps from where the actor stands to the nearest tile she can actually reach
    /// (<paramref name="reachable"/>), which is the flood's own depth - not a Manhattan estimate. `detour_steps=none`
    /// means the flood reached NOTHING closer than where she stands: the obstruction is not merely in the way, it is the
    /// end of the road, and clearing is the only way through.
    /// </para>
    /// <para>
    /// It is published beside a clear PRICE precisely so the two can be compared. Measured `round40`: a refusal that
    /// named only the clear made the price look mandatory, and the Agent swung at a weed it could have walked around.
    /// </para>
    /// </summary>
    public static string DescribeDetour((int X, int Y)? reachable, int? steps) =>
        reachable is { } tile && steps is int count
            ? $"reachable={tile.X.ToString(CultureInfo.InvariantCulture)},{tile.Y.ToString(CultureInfo.InvariantCulture)};detour_steps={count.ToString(CultureInfo.InvariantCulture)}"
            : "detour_steps=none";

    /// <summary>
    /// The route facts a SETTLED body refusal keeps, projected out of the receipt's own evidence.
    ///
    /// <para>
    /// A settled failure's evidence is withheld (ADR-006), so the hint is the only channel that reaches the caller, and
    /// a refusal that computed its answer and filed it where nobody reads has computed nothing. Measured `round41`,
    /// 19:04:10-19:05:26: a `clear_step_blocked` whose receipt held
    /// `clear_step=weed@40,9;stand_at=41,8;remaining_clears=1` reached the model as `Hint=null`, the run's session
    /// contained `clear_step` 0 times, and 76 seconds went into re-aiming at a corridor one weed closed.
    /// </para>
    /// <para>
    /// A PROJECTION rather than a second rendering: the fields named here are read out of the one evidence string the
    /// receipt keeps, so a value cannot disagree with itself. <paramref name="prefix"/> is the caller's own leading
    /// fact and is counted against <see cref="BodyProgramValidation.MaximumNodeHintLength"/> because the journal refuses
    /// a longer hint. Fields are dropped WHOLE from the tail, in declaration order, so a hint is never cut mid-token.
    /// </para>
    /// </summary>
    public static string? DescribeRouteHint(string? evidence, string? prefix = null)
    {
        if (string.IsNullOrEmpty(evidence))
            return prefix;
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string entry in evidence.Split(';'))
        {
            int equals = entry.IndexOf('=');
            if (equals <= 0)
                continue;
            values.TryAdd(entry[..equals], entry[(equals + 1)..]);
        }

        var parts = new List<string>();
        int length = prefix?.Length ?? 0;
        foreach (string field in RouteHintFields)
        {
            if (!values.TryGetValue(field, out string? value))
                continue;
            string entry = $"{field}={value}";
            int added = parts.Count == 0 ? entry.Length : entry.Length + 1;
            if (length + added > BodyProgramValidation.MaximumNodeHintLength)
                continue;
            parts.Add(entry);
            length += added;
        }

        if (parts.Count == 0)
            return prefix;
        return prefix is null ? string.Join(";", parts) : $"{prefix};{string.Join(";", parts)}";
    }

    /// <summary>
    /// The evidence fields a route refusal puts in the hint, in the order a reader needs them: the size of the route
    /// and its verdict, what stands on the frontier and where, what opens it and the id the frame published for it,
    /// where to stand, the other branch, and - when nothing on the rim can be opened - the word for what the rim is.
    /// </summary>
    private static readonly string[] RouteHintFields =
    {
        "component_tiles", "target_enclosed", "blocker_occupant", "clears_with", "blocker_target", "stand_at",
        "detour_steps", "remaining_clears", "no_cuttable_blocker",
    };

    private static string DescribeCost(FarmhandClearingCost cost, int? staminaCharge) =>
        $"stamina:{(staminaCharge is int charge ? charge.ToString(CultureInfo.InvariantCulture) : Undecided)},tool:{cost.Tool},turns:{cost.Turns.ToString(CultureInfo.InvariantCulture)}";

    /// <summary>What the evidence says when the engine's stamina charge could not be decided from live state.</summary>
    public const string Undecided = "undecided";

    /// <summary>What the evidence says when the frame published no row for the blocker's tile.</summary>
    public const string BlockerNotPublished = "blocker_not_published";

    /// <summary>What the evidence says when no published action declares it can remove the occupant.</summary>
    public const string NoPublishedActionClears = "no_published_action_clears";
}
