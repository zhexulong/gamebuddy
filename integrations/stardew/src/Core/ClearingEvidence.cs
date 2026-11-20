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
    /// <see cref="TargetUnpublished"/> with the family that would have carried the row rather than filled with a rebuilt
    /// hash: a caller told WHICH family published nothing can look in that family's rows or move into its reach, while
    /// `blocker_not_published` read as "this tile is nothing" and cost the round77 plan three nodes.
    /// </para>
    /// <para>
    /// EVERY clearer is named with ITS OWN cost - the tool the swing needs, the turns it takes, and the engine's stamina
    /// charge for the occupant's clear kind - because "clear it" and "go around it" are two prices and only one of them
    /// used to be published. The charge is per OCCUPANT (it is the engine's formula for the kind standing there), so one
    /// number is quoted for every clearer of that occupant; what differs per row is the tool and the turn.
    /// </para>
    /// <para>
    /// The absence of a clearing action is stated in the same shape: <c>no_published_action_clears:&lt;kind&gt;</c>, so
    /// "nothing we have removes this" is one word a caller can branch on instead of a missing key it must guess at - and
    /// with the REASON the vocabulary declares for that kind (<c>:engine_keeps_it_standing</c>) beside it, because "nothing
    /// of ours removes it" and "nothing at all can" are two different next steps. It is the right answer for a bush:
    /// `harvest_bush` declares no `Clears`, because harvesting a bush is not a way through one.
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
    /// <param name="targetStepFacts">
    /// <see cref="DescribeNextSteps"/>'s ordered answer for the case <see cref="TargetUnpublished"/> names, or null when
    /// the frame published the id (so the step is the cut itself) or when where to walk could not be decided.
    /// </param>
    public static string DescribeBlocker(
        string occupant,
        (int X, int Y) blockerTile,
        string? targetId,
        IReadOnlyList<FarmhandClearingOffer> clearers,
        int? staminaCharge,
        string? detourFacts,
        string? targetStepFacts = null)
    {
        ArgumentNullException.ThrowIfNull(occupant);
        ArgumentNullException.ThrowIfNull(clearers);
        string clears = clearers.Count == 0
            ? NoPublishedClearer(occupant)
            : string.Join(",", clearers.Select(offer => $"{offer.ActionId}({DescribeCost(offer.Cost, staminaCharge)})"));
        string described = $"{Occupant(occupant, blockerTile)};clears_with={clears};blocker_target={TargetText(targetId, clearers)}";
        if (!string.IsNullOrEmpty(targetStepFacts))
            described = $"{described};{targetStepFacts}";
        return string.IsNullOrEmpty(detourFacts) ? described : $"{described};{detourFacts}";
    }

    /// <summary>
    /// What `clears_with` says when no published action removes the occupant: the occupant, and the reason the vocabulary
    /// declares for it.
    ///
    /// <para>
    /// The reason is appended and never invented: a kind with no declared token answers with the bare word, which the
    /// gate `a_blocker_is_named_by_the_surface_that_clears_it` refuses by name. A surface that guessed its own reason
    /// here would be a second declaration of why a kind cannot be cleared, and the two would drift the first time either
    /// moved.
    /// </para>
    /// </summary>
    private static string NoPublishedClearer(string occupant) =>
        TileOccupantKind.UnclearableCode(occupant) is { } reason
            ? $"{NoPublishedActionClears}:{occupant}:{reason}"
            : $"{NoPublishedActionClears}:{occupant}";

    /// <summary>
    /// What `blocker_target` says: the id to dispatch, or WHICH family published none, or that there is nothing to address
    /// at all.
    ///
    /// <para>
    /// The three answers are three different next steps, so one word cannot carry them: an id is a dispatch, a family with
    /// no row is a plan that has to look in that family (or its radius) before it can name one, and no clearer at all means
    /// no step exists however the frame is re-read. `blocker_not_published` said all three at once, and a weed with both a
    /// published action and a published row count read as unpublished.
    /// </para>
    /// </summary>
    private static string TargetText(string? targetId, IReadOnlyList<FarmhandClearingOffer> clearers) =>
        targetId is { Length: > 0 } id ? id
        : clearers.Count == 0 ? NoClearingAction
        : $"{TargetUnpublished}:{clearers[0].TargetFamily}";

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
            ? NoPublishedClearer(occupant)
            : string.Join(",", clearers.Select(offer => offer.ActionId));
        return $"{Occupant(occupant, blockerTile)};clears_with={clears}";
    }

    /// <summary>
    /// The step that breaks the circle <see cref="TargetUnpublished"/> half-documents: WHERE to walk so the family that
    /// clears the blocker publishes the row the caller's action needs, then that the row appears, then the cut, then the
    /// walk the refusal originally answered.
    ///
    /// <para>
    /// `unpublished:&lt;family&gt;` on its own is an answer a caller cannot act on. Measured `round78`: six refusals in ten
    /// minutes, every one carrying `clears_with=cut_weeds` and `blocker_target=unpublished:weedTargets` beside
    /// `stand_at=40,10` - and the recovery `stand_at`'s own docblock named ("move into its reach") WAS the walk that had
    /// just been refused. The frame publishes a family's rows for tiles inside that family's own discovery radius, and the
    /// actor stood twenty tiles away, so the action was real and its id was not; nothing in the refusal said the walk to
    /// `stand_at` was the step that would publish it, while `reachable=34,6;detour_steps=46` named a dead end.
    /// </para>
    /// <para>
    /// The ORDER is the fact, so it is one value rather than four fields: a caller holding `next_steps=` can see that the
    /// only dispatch it can make today is the first one, and that what it is waiting for is not a better tile but a row.
    /// Each verb is an action id the caller dispatches (`<see cref="WalkAction"/>`, the clearing action's own id) or the
    /// family's publication, which is the precondition between them.
    /// </para>
    /// <para>
    /// The cut is named only when the publish tile is within tool reach of the blocker, because the sentence must not
    /// promise a swing the engine would refuse for range; otherwise the order stops at the publication and the caller's
    /// next plan reads a world that now has the id in it. <paramref name="goalTile"/> is the walk the refusal answered,
    /// and it is omitted when the hint cannot afford it - the caller made that request itself, so it is the one tile in
    /// the sequence that does not have to be told.
    /// </para>
    /// </summary>
    /// <param name="publishFrom">
    /// A tile the caller can walk to today from which the family publishes the row, or null when the search measured that
    /// no such tile exists (never when it could not measure - an unmeasured search says nothing here).
    /// </param>
    /// <param name="blockerTile">The tile the row is about.</param>
    /// <param name="clearer">The published action whose `Clears` declaration removes the occupant, and its family.</param>
    /// <param name="goalTile">Where the refused walk was going, or null to end the sentence at the cut.</param>
    public static string DescribeNextSteps(
        (int X, int Y)? publishFrom,
        (int X, int Y) blockerTile,
        FarmhandClearingOffer clearer,
        (int X, int Y)? goalTile)
    {
        ArgumentNullException.ThrowIfNull(clearer);
        if (publishFrom is not { } from)
            return $"next_steps={NoNextSteps}";
        string steps = $"{WalkAction}@{from.X.ToString(CultureInfo.InvariantCulture)},{from.Y.ToString(CultureInfo.InvariantCulture)}"
            + $">publishes:{clearer.TargetFamily}";
        // A swing lands from Chebyshev 1 only; the planner's own reach is the one this sentence is held to.
        bool inReach = Math.Abs(from.X - blockerTile.X) <= ClearStepPlanner.ToolReach
            && Math.Abs(from.Y - blockerTile.Y) <= ClearStepPlanner.ToolReach;
        if (inReach)
            steps += $">{clearer.ActionId}@{blockerTile.X.ToString(CultureInfo.InvariantCulture)},{blockerTile.Y.ToString(CultureInfo.InvariantCulture)}";
        if (inReach && goalTile is { } goal)
            steps += $">{WalkAction}@{goal.X.ToString(CultureInfo.InvariantCulture)},{goal.Y.ToString(CultureInfo.InvariantCulture)}";
        return $"next_steps={steps}";
    }

    /// <summary>The action a caller issues to walk: its published id, so the ordered step names a dispatch and not a verb.</summary>
    public const string WalkAction = "move_to_tile";

    /// <summary>What `next_steps` says when no tile the caller can walk to brings the blocker inside its family's radius.</summary>
    public const string NoNextSteps = "none";

    /// <summary>
    /// What a refusal says where it used to name a `closest=` tile: no tile the walk reaches opens the route the caller
    /// asked for.
    ///
    /// <para>
    /// The flood's nearest reachable tile is a measurement, and a refusal published it as `closest=` whatever the verdict
    /// said. Measured `round78`: `closest=34,6;closest_distance=6` beside `stand_at=40,10`, and the closer-looking tile was
    /// the end of a dead end - the run spent its day arriving at them. The measurement keeps its own name (`reachable=`,
    /// beside `walk_limit_steps=`), and the tile is only called something to walk to when a walk ARRIVES from it.
    /// </para>
    /// </summary>
    public const string NoProgress = "progress=none";

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
    /// The SAME two numbers when the flood's own verdict is that NO way round exists, under the words that say so.
    ///
    /// <para>
    /// <see cref="DescribeDetour"/> answers "what does leaving it alone cost", and that question has an answer only while
    /// there is somewhere for the walk to come out. When the flood has already established that the target's own
    /// neighbourhood is outside the actor's component, every tile it reached is a tile the target cannot be reached from,
    /// and the depth it reached it at is not a detour - it is how far the walk gets. Measured `round78`: six refusals in
    /// ten minutes carried `reachable=34,6;detour_steps=46` beside their own `route_exists_cardinal=false`, and 46 steps
    /// of walking was the one thing the run could dispatch, so it spent the day arriving at dead ends. The number is kept
    /// (it is how far she CAN get) and the claim is withdrawn: <c>detour_steps=none</c> is this file's existing word for
    /// "clearing is the only way through", which is exactly the verdict beside it.
    /// </para>
    /// </summary>
    public static string DescribeNoDetour((int X, int Y)? reachable, int? steps) =>
        reachable is { } tile && steps is int count
            ? $"reachable={tile.X.ToString(CultureInfo.InvariantCulture)},{tile.Y.ToString(CultureInfo.InvariantCulture)};detour_steps=none;walk_limit_steps={count.ToString(CultureInfo.InvariantCulture)}"
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
    /// and its verdict, what stands on the frontier and where, what opens it and the id the frame published for it (or,
    /// when the frame published none, the ordered walk that makes it publish one), where to stand, the other branch, and
    /// - when nothing on the rim can be opened - the word for what the rim is or for why no rim tile is a step.
    /// </summary>
    private static readonly string[] RouteHintFields =
    {
        "component_tiles", "target_enclosed", "blocker_occupant", "clears_with", "blocker_target", "blocker",
        "next_steps", "progress", "stand_at", "detour_steps", "walk_limit_steps", "remaining_clears",
        "no_cuttable_blocker",
    };

    private static string DescribeCost(FarmhandClearingCost cost, int? staminaCharge) =>
        $"stamina:{(staminaCharge is int charge ? charge.ToString(CultureInfo.InvariantCulture) : Undecided)},tool:{cost.Tool},turns:{cost.Turns.ToString(CultureInfo.InvariantCulture)}";

    /// <summary>What the evidence says when the engine's stamina charge could not be decided from live state.</summary>
    public const string Undecided = "undecided";

    /// <summary>What the evidence says when no published action declares it can remove the occupant.</summary>
    public const string NoPublishedActionClears = "no_published_action_clears";

    /// <summary>What `blocker_target` says when the occupant's own clearing family published no row for its tile.</summary>
    public const string TargetUnpublished = "unpublished";

    /// <summary>
    /// What `blocker_target` says when nothing published removes the occupant at all - so there is no target to address,
    /// however the frame is re-read.
    /// </summary>
    public const string NoClearingAction = "no_clearing_action";

    /// <summary>
    /// What `blocker` says when the rim holds published blockers and NONE of them is a step the refusal may name.
    ///
    /// <para>
    /// A named blocker is advice to WALK, so it is held to the one property that makes it advice: it must be nearer to
    /// her than the refusal's own subject, or walking to it is distance away from the thing she asked for. Measured
    /// `round82`: a refusal for Town `69,42` from `69,51` named `twig@102,43` - thirty-three tiles from the subject,
    /// forty-one from her - because every candidate had priced as "opens nothing" and the ranking had degenerated to
    /// "nearest to the subject" over the whole town's rim. "None of the published blockers is one" is the honest answer
    /// there, and it is not <see cref="NoClearingAction"/>: those tiles DO have clearing actions, they are simply not
    /// on the way.
    /// </para>
    /// </summary>
    public const string NoBlocker = "none_of_the_published";
}
