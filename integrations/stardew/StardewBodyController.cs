using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Characters;
using StardewValley.Pathfinding;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Policy;

namespace GameBuddy.Stardew;

/// <summary>
/// Answers the target id the published frame carries for the occupant standing on one tile, or null when that frame
/// could not have carried a row for it.
///
/// <para>
/// A delegate rather than a call because the frame is assembled from the `Discover*` projections, which live beside the
/// ExecutionManager that owns the live world and the capability publication - and this controller deliberately holds no
/// discovery, no tool and no action dispatcher (see `TheWalkNeverCallsAClearingAction`). What crosses is one answer
/// about one tile, so an absent lookup is an honest "nothing was published" rather than a second snapshot.
/// </para>
/// <para>
/// The argument is the OCCUPANT and not a family name: which families can carry a row for a weed is a fact about the
/// clearing declarations that clear weeds, so the producer derives it from them rather than being handed a family by a
/// second table here. That table is what left a twig's `worldObjectTargets` row unlooked-at.
/// </para>
/// </summary>
internal delegate string? PublishedTargetIdLookup(Farmer localPlayer, string occupant, int x, int y);

/// <summary>
/// Client-local, game-thread controller for the native Farmhand represented by
/// this process' Game1.player. It deliberately has no remote-player, teleport,
/// or world-goal API. ExecutionManager is its sole owner.
/// </summary>
    // What the cardinal flood concluded about one goal. `ClosestToTargetSteps` is how many STEPS the flood took to
    // reach `ClosestToTarget` - its own depth, not a Manhattan estimate - and it is published as `detour_steps`, so
    // "go around it" carries a number a caller can weigh against a clear's stamina charge and one dispatched turn.
    internal readonly record struct ReachabilityVerdict(
        bool TargetEnclosed,
        bool ComponentContainsTarget = false,
        Point? ClosestToTarget = null,
        int ComponentTiles = 0,
        int? ClosestToTargetSteps = null);

internal sealed partial class StardewBodyController
{
    private readonly Action<ExecutionState, string, string?> transition;
    /// <summary>Where a blocker's published identity comes from, or null when no frame is reachable from here.</summary>
    private readonly PublishedTargetIdLookup? publishedTargetId;
    private LocalMoveSpec? active;
    private PathFindController? pathController;
    private Vector2 lastTile;
    private int lastProgressTick;
    private bool hasEmittedStalledWaiting;
    private bool isStallWaiting;
    private int stallWaitStartedTick;

    /// <summary>
    /// Where the last refused move COULD have gone, when the flood found a tile closer to the goal.
    ///
    /// <para>
    /// Set on the branch that refuses with `no_native_path`, so the terminal result can carry it as the node's `Hint`.
    /// Null means the flood found nothing closer - an honest "nowhere better from here", which is a different answer
    /// from "no hint was computed".
    /// </para>
    /// </summary>
    private string? reachabilityHint;

    /// <summary>Navigation L2 watchdog: native movement must show progress before
    /// this many game ticks have elapsed. Stardew's native update loop is 60 FPS,
    /// so the frozen 2 second blocker diagnostic window is 120 ticks
    /// (blocker-and-navigation-diagnostics.md §5.3).</summary>
    private const int StallDetectionTicks = 120;

    /// <summary>Navigation L2 quiet recovery window. After the first two-second
    /// stall, native movement is halted so a Pet/NPC can move away without being
    /// pushed. Sixty native ticks is the frozen one-second lower bound of the
    /// design's one-to-one-and-a-half second waiting window.</summary>
    private const int StallWaitTicks = 60;

    /// <summary>Navigation L2 watchdog hard budget. The 5 second bound is 300
    /// native 60 FPS ticks, measured from the last observed progress tick.</summary>
    private const int StallTimeoutTicks = 300;

    /// <summary>
    /// The refusal for a target tile that is not a PLACE: the map admits neither the tile itself (the body may stand on
    /// it) nor any of its four cardinal neighbours (<see cref="ExecutionManager.IsTargetTileAddressable"/>, the admission
    /// every published target row passes). Nothing can be undone and nothing can be cleared - a Buildings tile is not a
    /// lock - so it is not a route question, and calling it `no_native_path` told a live companion the road was closed
    /// about a cell that does not exist as ground (measured `round78`: four `move_to_tile` requests, every one
    /// `target_standable=false` with its four neighbours `buildings_tile:blocked`).
    ///
    /// <para>
    /// THIS CODE IS THE CELL, NOT THE COORDINATE. Two different facts used to share it and both are addressability
    /// answers, so the three `target_not_addressable` refusals of `round84` could not say which one they were: the
    /// coordinate is not a tile of this map at all (<see cref="TargetOffMapReasonCode"/> - the number came from another
    /// map, or from arithmetic on one), or the cell exists and no body can be at or beside it (this code - a wall, a
    /// building footprint, an interior partition). The remedies differ: the first is answered by re-reading the map the
    /// body is actually on, the second by walking to a published target instead of a guessed cell.
    /// </para>
    /// </summary>
    internal const string TargetNotAddressableReasonCode = "target_not_addressable";

    /// <summary>
    /// The refusal for a coordinate that is not a tile of the map the body is standing on: the number names no cell
    /// here, so no walk, no route and no approach can exist for it.
    ///
    /// <para>
    /// Apart from <see cref="TargetNotAddressableReasonCode"/> because a wall is a fact about the GROUND and this is a
    /// fact about the ADDRESS: `target_on_map=false` in the evidence is this code, and `target_on_map=true` with no
    /// admissible ring is the other one. Measured `round84`: three `move_to_tile` refusals answered one code for both,
    /// and the receipt could not tell "that is a wall" from "that number belongs to another map" - which is the one
    /// thing the caller has to know, because only the first has a neighbouring tile to walk to.
    /// </para>
    /// </summary>
    internal const string TargetOffMapReasonCode = "target_off_map";

    /// <summary>
    /// Upper bound for the derived reachability probe. A target is reported as
    /// enclosed only after the actor's whole component has been enumerated, and an
    /// open map's component is as large as the map itself (the target version's
    /// Farm is roughly 80x65 tiles), so the budget must cover a full location or
    /// the claim would be undecidable in exactly the case it exists for. 8000 stays
    /// below the native finder's own 10000-node limit, and only the already-failing
    /// no_native_path path pays for it.
    /// </summary>
    private const int ReachabilityProbeLimit = 8000;

    /// <summary>WIA §4.4 wall-clock anchor (Unix ms) of the transient window. 0 =
    /// not armed; every non-transient frame resets it, so a fresh lock starts a
    /// fresh window. Only the transient window logic reads or writes it.</summary>
    private long transientSinceMs;

    public StardewBodyController(Action<ExecutionState, string, string?> transition, PublishedTargetIdLookup? publishedTargetId = null)
    {
        this.transition = transition;
        this.publishedTargetId = publishedTargetId;
    }

    public bool HasActiveExecution => this.active is not null;

    /// <summary>
    /// The one reason a route the engine cannot walk is refused with: no native path exists.
    ///
    /// Named once because two callers read it - the refusal itself, and the move action's decision to offer the
    /// route's first clear step instead of refusing - and a second spelling would let them disagree about when a
    /// step applies.
    /// </summary>
    internal const string NoNativePathReasonCode = "no_native_path";

    /// <summary>
    /// The refusal for a target tile a PERSON is standing on, when there is no tile beside it to work from.
    ///
    /// <para>
    /// Separate from <see cref="NoNativePathReasonCode"/> because the two are different worlds: `no_native_path` says the
    /// map has no road to that tile, and this says the road is there and a body is on the end of it. Told apart, they
    /// lead to different next steps - replan a route versus wait, or work from the other side - and the measured failure
    /// was the two collapsed: a villager standing on `24,22` for a whole run read as "the road does not exist", and the
    /// companion hand-planned a two-map detour with guessed coordinates.
    /// </para>
    /// </summary>
    internal const string TargetTileOccupiedReasonCode = "target_tile_occupied";

    /// <summary>
    /// The refusal for a walk a CHARACTER is standing in the middle of. Its subject is the person, and its remedy is to
    /// wait for them to move or to aim somewhere else - never a route that does not exist.
    /// </summary>
    internal const string PathBlockedByCharacterReasonCode = "path_blocked_by_character";

    /// <summary>
    /// The refusal code for a walk that failed, given the layer that refused it.
    ///
    /// One mapping for both refusal branches (the cardinal flood's verdict and the native finder's null path), so a
    /// character in the way cannot be reported as a map verdict by one of them and correctly by the other. Any other
    /// layer keeps the reachability verdict.
    /// </summary>
    internal static string WalkRefusalCode(RefusalLayerToken blocked, string unreachableCode) =>
        blocked.Layer == RefusalLayerKind.Character
            ? $"{TargetTileOccupiedReasonCode}:{RefusalProbe.ReasonCodeToken(blocked)}"
            : unreachableCode;

    /// <summary>
    /// The refusal code for a walk that stalled, given what the body loop found in front of the actor.
    ///
    /// `DescribeStallBlocker` answers `character:&lt;name&gt;@&lt;tile&gt;` when a body is in the way and otherwise the world
    /// layer that refused the next step (`location_constraint:railroadAreaBlocked@9,4`), so the same fact decides both the
    /// code and the evidence: a person who does not move turns a 5-second no-progress window into a named blocker the
    /// caller can wait out, instead of `native_path_ended`, which reads as the walk itself being broken.
    /// </summary>
    internal static string StallRefusalCode(string stalledBy)
    {
        const string prefix = "character:";
        if (!stalledBy.StartsWith(prefix, StringComparison.Ordinal))
            return "native_path_ended";
        string name = stalledBy.Substring(prefix.Length).Split('@')[0];
        return name.Length == 0
            ? PathBlockedByCharacterReasonCode
            : $"{PathBlockedByCharacterReasonCode}:{RefusalProbe.ReasonCodeToken(name)}";
    }

    public string? ActiveExecutionId => this.active?.ExecutionId;

    /// <summary>
    /// What opening a route to one tile costs, and the FIRST step it implies, over the live world.
    ///
    /// One resolution for two callers: the refusal that DESCRIBES the step, and the move action that WALKS it.
    /// Keeping one resolution means the step an Agent is told about and the step the Mod walks cannot drift -
    /// which they would if the evidence and the walk each built their own plan.
    /// </summary>
    private sealed record ClearingToReach(
        ClearingPlan Plan,
        FirstClearStep Step,
        IReadOnlyDictionary<Point, string> Kinds)
    {
        public string? KindAt((int X, int Y) tile) =>
            this.Kinds.TryGetValue(new Point(tile.X, tile.Y), out string? kind) ? kind : null;
    }

    /// <summary>
    /// The clearing plan and its first step for <paramref name="target"/>, or null when nothing can be said
    /// (no location, or no tile the cost table prices - a wall is not a bill).
    /// </summary>
    private static ClearingToReach? ResolveClearingToReach(Farmer localPlayer, Vector2 target)
    {
        StardewValley.GameLocation? location = localPlayer.currentLocation;
        if (location is null)
            return null;
        var layer = location.map.Layers[0];
        Point actor = new((int)localPlayer.Tile.X, (int)localPlayer.Tile.Y);
        Point targetTile = new((int)target.X, (int)target.Y);

        // The walkable set is the planner's own predicate, so the search agrees with the engine about what a
        // step is. It is bounded by the same budget the reachability probe uses.
        var walkable = new HashSet<Point>();
        for (int x = 0; x < layer.LayerWidth; x += 1)
            for (int y = 0; y < layer.LayerHeight; y += 1)
            {
                if (IsWalkableTile(location, localPlayer, new Vector2(x, y)))
                    walkable.Add(new Point(x, y));
            }

        var clearable = new Dictionary<Point, int>();
        var kinds = new Dictionary<Point, string>();
        CollectClearableTiles(location, localPlayer, clearable, kinds);
        if (clearable.Count == 0)
            return null;

        HashSet<(int X, int Y)> walkableTiles = walkable.Select(tile => (tile.X, tile.Y)).ToHashSet();
        ClearingPlan plan = ClearingPlanner.Plan(
            (actor.X, actor.Y),
            (targetTile.X, targetTile.Y),
            walkableTiles,
            clearable.ToDictionary(entry => (entry.Key.X, entry.Key.Y), entry => entry.Value));
        FirstClearStep step = ClearStepPlanner.Resolve((actor.X, actor.Y), plan, walkableTiles);
        return new ClearingToReach(plan, step, kinds);
    }

    /// <summary>
    /// The first clear that opens a route to <paramref name="targetTile"/>, as the step AND the receipt wording
    /// that names it - or null when no single step resolves.
    ///
    /// It answers for the `already_in_reach` case too, because the caller that ACTS on it must be able to tell
    /// "the blocker is still there" from "it is gone"; refusing to answer would read as the latter.
    /// </summary>
    internal ClearStepOffer? ResolveClearStep(Farmer localPlayer, Vector2 targetTile)
    {
        try
        {
            if (ResolveClearingToReach(localPlayer, targetTile) is not { } resolution)
                return null;
            FirstClearStep step = resolution.Step;
            if (!step.Reachable || step.BlockerTile is null || step.ApproachTile is null)
                return null;
            if (ClearingEvidence.DescribeFirstStep(step, resolution.KindAt) is not { } evidence)
                return null;
            return new ClearStepOffer(step, evidence);
        }
        catch
        {
            // A derived plan must never break the refusal it decorates, and it must never start a walk on a
            // half-read world: the native verdict stays authoritative.
            return null;
        }
    }

    /// <summary>What opens a route the engine cannot walk: the first clear, as the receipt names it.</summary>
    internal sealed record ClearStepOffer(FirstClearStep Step, string Evidence);

    /// <summary>
    /// The named refusal for "walked to the blocker and it is still there".
    ///
    /// Distinct from <see cref="NoNativePathReasonCode"/> on purpose: the route existed and was walked, and what
    /// stands in the way is one specific tile the caller can clear if it decides to. Collapsing the two would tell
    /// the caller nothing happened.
    /// </summary>
    internal const string ClearStepBlockedReasonCode = "clear_step_blocked";

    /// <summary>Whether the blocker a clear-approach walk was started for is still in the way.</summary>
    internal enum ClearApproachArrival
    {
        BlockerGone,
        BlockerStillPresent,
    }

    /// <summary>
    /// A walk to a blocker's <c>stand_at</c> tile, and the request it was started for.
    ///
    /// Controller state rather than a `LocalMoveSpec` field on purpose: which move is a clear approach is not a
    /// property of the request the caller made, and the request must not have to carry the Mod's clearing
    /// vocabulary to be served.
    /// </summary>
    internal sealed record ClearApproach(LocalMoveSpec Requested, (int X, int Y) BlockerTile);

    private ClearApproach? clearApproach;

    /// <summary>
    /// The walk a blocked route earns, decided without touching the native finder: the spec to walk, the blocker
    /// it is for, and the evidence that names the step - or null with <paramref name="refusal"/> saying why there
    /// is no walk.
    ///
    /// Separate from arming it (<see cref="TryStartClearApproach"/>) so the decision is testable against a real
    /// world without a native path controller, and so no test has to stand in for the engine.
    /// </summary>
    internal ClearApproachWalk? PlanClearApproachWalk(LocalMoveSpec requested, Farmer localPlayer, out string? refusal)
    {
        refusal = null;
        if (this.ResolveClearStep(localPlayer, requested.TargetTile) is not { } offer)
        {
            refusal = "clear_step_walk=no_step";
            return null;
        }
        if (offer.Step.ApproachTile is not { } approach || offer.Step.BlockerTile is not { } blocker)
        {
            refusal = $"{offer.Evidence};clear_step_walk=no_step";
            return null;
        }

        (int X, int Y) actor = ((int)localPlayer.Tile.X, (int)localPlayer.Tile.Y);
        if (approach == actor)
        {
            // Zero-length walk: the actor is already beside the blocker, so the remaining act is a SWING - which is
            // the caller's decision, not this walk's. Issuing a move to the tile they are standing on is not one.
            refusal = $"{offer.Evidence};clear_step_walk=none;already_in_reach=true";
            return null;
        }

        LocalMoveSpec candidate = requested with
        {
            TargetTile = new Vector2(approach.X, approach.Y),
            // Exact arrival: the approach tile is where a swing reaches from, so stopping one tile short would
            // arrive out of reach of the very blocker this walk exists for.
            AllowAdjacentArrival = false,
            RequestedTile = null,
            StagedApproach = false,
            StagedSteps = 0,
        };
        return new ClearApproachWalk(
            candidate,
            blocker,
            $"{offer.Evidence};clear_step_walk={approach.X},{approach.Y};requested={FormatTile(requested.TargetTile)}");
    }

    /// <summary>The walk a blocked route earns: the spec, the blocker it is for, and the evidence naming the step.</summary>
    internal sealed record ClearApproachWalk(LocalMoveSpec Walk, (int X, int Y) BlockerTile, string Evidence);

    /// <summary>
    /// Arms the walk <see cref="PlanClearApproachWalk"/> decided on. False means no walk was armed, with
    /// <paramref name="evidence"/> saying why (no step, or the native finder has no path to the approach tile).
    /// </summary>
    internal bool TryStartClearApproach(LocalMoveSpec requested, Farmer localPlayer, int tick, out string? evidence)
    {
        evidence = null;
        if (this.active is not null)
            return false;
        if (this.PlanClearApproachWalk(requested, localPlayer, out evidence) is not { } planned)
            return false;

        PathFindController path = this.BuildNativePath(planned.Walk, localPlayer);
        if (path.pathToEndPoint is not { Count: > 0 })
        {
            evidence = $"{planned.Evidence};clear_step_walk=unroutable;stand_at={planned.Walk.TargetTile.X},{planned.Walk.TargetTile.Y}";
            return false;
        }

        this.InstallStagedStep(planned.Walk, path, localPlayer, tick);
        this.clearApproach = new ClearApproach(requested, planned.BlockerTile);
        evidence = planned.Evidence;
        return true;
    }

    /// <summary>
    /// The arrival ruling for a clear-approach walk: is the blocker this walk was started for still in the way?
    ///
    /// This is the whole of the arrival decision, as arithmetic, and it is deliberately the only thing an arrival
    /// decides. `BlockerStillPresent` refuses by name; anything else continues to the target. Neither swings:
    /// clearing is the caller's action, with its own tool, stamina cost and policy question.
    /// </summary>
    internal static ClearApproachArrival AssessClearApproachArrival((int X, int Y) blockerWalkedTo, FirstClearStep? freshStep)
    {
        // A fresh plan that no longer asks for THAT tile is the blocker being gone. A plan that asks for a
        // DIFFERENT tile is also "gone" for this walk: one clear per request, and the next step belongs to a fresh
        // decision rather than to a chain this walk was never authorised to promise.
        return freshStep is { Reachable: true, BlockerTile: var blocker } && blocker == blockerWalkedTo
            ? ClearApproachArrival.BlockerStillPresent
            : ClearApproachArrival.BlockerGone;
    }

    /// <summary>
    /// What stands on the blocker's tile, which of our actions clears it and what that dispatch costs, the id the
    /// published frame carries for it, and - when <paramref name="goalTile"/> is given - what it costs to leave it
    /// alone.
    ///
    /// <para>
    /// Empty only when the tile holds nothing this walk can name. It runs on the arrival re-plan's own read of the
    /// world, through the SAME <see cref="OccupantAt"/> the plan was made with, so the occupant it names and the blocker
    /// the plan resolved cannot be two different things.
    /// </para>
    /// <para>
    /// The two prices are the point. `clears_with=<action>(stamina:N,tool:T,turns:1)` is one branch and
    /// `detour_steps=none` is the other: before this, a refusal published only the clear, so the only thing a caller
    /// could do with it was swing. Measured `round40`: one weed, a four-way corridor, and the Agent swung rather than
    /// walked because nothing said how far 'around' was.
    /// </para>
    /// <para>
    /// It decides nothing. Which action to dispatch, and whether to dispatch one at all, stays the caller's - this
    /// only stops the caller having to guess.
    /// </para>
    /// </summary>
    internal string DescribeBlocker(Farmer localPlayer, (int X, int Y) blockerTile, Vector2? goalTile = null)
    {
        if (localPlayer.currentLocation is not { } location)
            return string.Empty;
        if (OccupantAt(location, localPlayer, new Vector2(blockerTile.X, blockerTile.Y)) is not { } occupancy)
            return string.Empty;
        return this.DescribeObstruction(
            localPlayer,
            occupancy,
            blockerTile,
            goalTile is { } goal ? DescribeDetourFacts(localPlayer, goal) : null,
            goalTile);
    }

    /// <summary>
    /// The named obstruction on the FRONTIER of the actor's own walkable component, nearest <paramref name="goalTile"/>,
    /// with the same facts <see cref="DescribeBlocker"/> publishes - as a `;`-prefixed evidence suffix, or the empty
    /// string when the component only ever touches walls and open ground.
    ///
    /// <para>
    /// This is the refusal shape a clearing PLAN cannot reach. A priced blocker resolves to a clear step and is walked
    /// to; a bush never does - no priced tool removes it, so the plan is `unreachable` and the receipt used to answer
    /// with `blocked_by=none` about a tile the caller could not get past, which reads as "nothing is in the way". The
    /// frontier is the honest answer without a plan: the tiles the actor can stand on, and the named thing just beyond
    /// the last of them.
    /// </para>
    /// <para>
    /// Nearest TO THE GOAL rather than to the actor, because the caller's question is about the route it asked for, and
    /// a deterministic tie-break (`Y`, then `X`) because two runs over one world have to produce one receipt.
    /// </para>
    /// </summary>
    internal string DescribeFrontierBlocker(Farmer localPlayer, Vector2 goalTile, string? detourFacts)
    {
        if (localPlayer.currentLocation is not { } location)
            return string.Empty;
        if (FindFrontierObstruction(localPlayer, goalTile) is not { } obstruction)
            return string.Empty;
        string facts = this.DescribeObstruction(localPlayer, obstruction.Occupant, obstruction.Tile, detourFacts, goalTile);
        return facts.Length == 0 ? string.Empty : $";{facts}";
    }

    /// <summary>
    /// One named obstruction, priced or not, as the receipt words it. The one place those words are assembled, so the
    /// blocker a walk arrived at and the blocker a walk never started for cannot be described differently.
    /// </summary>
    private string DescribeObstruction(
        Farmer localPlayer,
        Occupancy occupancy,
        (int X, int Y) tile,
        string? detourFacts,
        Vector2? goalTile = null)
    {
        IReadOnlyList<FarmhandClearingOffer> clearers = ClearingActionSurface.ClearersOf(occupancy.Occupant, FarmhandActionCatalog.Registrations);
        string? targetId = this.publishedTargetId?.Invoke(localPlayer, occupancy.Occupant, tile.X, tile.Y);
        return ClearingEvidence.DescribeBlocker(
            occupancy.Occupant,
            tile,
            targetId,
            clearers,
            occupancy.StaminaCharge,
            detourFacts,
            this.DescribeTargetStep(localPlayer, targetId, tile, clearers, goalTile));
    }

    /// <summary>
    /// The `next_steps` sentence for a blocker whose clearing family published NO row for its tile - or null when the
    /// frame published the id (so the step is the cut, not a walk) and when where to walk could not be measured.
    ///
    /// <para>
    /// The recovery this replaces was `stand_at`, and `stand_at`'s own contract ("move into its reach") is the walk the
    /// refusal had just answered with a no. Measured `round78`: `blocker_target=unpublished:weedTargets` beside
    /// `stand_at=40,10`, six times in ten minutes, and the run walked to `reachable=34,6` instead - because nothing said
    /// that walking to a particular tile is what makes the family publish the missing row. This composes that sentence
    /// from the tile <see cref="PublishTileFor"/> proves the caller can reach, so the first step it names is a
    /// `move_to_tile` the caller can dispatch with the frame it already holds.
    /// </para>
    /// </summary>
    private string? DescribeTargetStep(
        Farmer localPlayer,
        string? targetId,
        (int X, int Y) blockerTile,
        IReadOnlyList<FarmhandClearingOffer> clearers,
        Vector2? goalTile)
    {
        if (targetId is { Length: > 0 } || clearers.Count == 0)
            return null;
        // The family's WINDOW can only be why the row is missing while the blocker is OUTSIDE it. A family that publishes
        // nothing for a tile the actor already stands beside is refusing on its own admission - a clump no tool in her pack
        // can break, a row past a cap - and no walk fixes that: measured `ClearStepBlockerNamingTests`' unpriced
        // `quarry_boulder`, where "walk here and the row appears" would be advice the frame had already disproved.
        int toBlocker = Math.Max(
            Math.Abs((int)localPlayer.Tile.X - blockerTile.X),
            Math.Abs((int)localPlayer.Tile.Y - blockerTile.Y));
        if (toBlocker <= ExecutionManager.TargetDiscoveryRadius)
            return null;
        PublishTile publish = PublishTileFor(localPlayer, blockerTile);
        if (!publish.Measured)
            return null;
        return ClearingEvidence.DescribeNextSteps(
            publish.Tile,
            blockerTile,
            clearers[0],
            goalTile is { } goal ? ((int)goal.X, (int)goal.Y) : null);
    }

    /// <summary>
    /// What <see cref="PublishTileFor"/> found: a tile, a measured absence of one, or no claim at all.
    ///
    /// <para>
    /// The third state is the one that must not be spelled as the second: a component that exceeded the flood's budget is
    /// not a component in which nothing publishes the row, and a refusal that said `next_steps=none` there would be
    /// claiming a measurement it never finished.
    /// </para>
    /// </summary>
    private readonly record struct PublishTile((int X, int Y)? Tile, bool Measured);

    /// <summary>
    /// The tile the actor can ALREADY walk to from which the family that clears <paramref name="blockerTile"/> would
    /// publish a row for it.
    ///
    /// <para>
    /// Not a guess, and not a constant: a family publishes a row for a tile when the ACTOR is inside
    /// <see cref="ExecutionManager.TargetDiscoveryRadius"/> of it (`IsPublishedTargetTileInRadius` - the one predicate
    /// every family's discovery filters through), so "a tile that publishes this row" is "a tile of the actor's own
    /// walkable component within that Chebyshev radius". The component is the same cardinal flood every reachability
    /// claim in this file uses, with the same predicate and the same budget, and the answer is its tile nearest the
    /// blocker (fewest steps when two are equally near), so a swing from it lands whenever the ring is walkable at all.
    /// </para>
    /// <para>
    /// The third state is <see cref="PublishTile.Measured"/> false: the component exceeded its budget, so no claim at all
    /// is made and the caller publishes nothing here.
    /// </para>
    /// </summary>
    private static PublishTile PublishTileFor(Farmer localPlayer, (int X, int Y) blockerTile)
    {
        GameLocation? location = localPlayer.currentLocation;
        if (location?.map is null || location.map.Layers.Count == 0)
            return new PublishTile(null, false);
        var layer = location.map.Layers[0];
        Point blocker = new(blockerTile.X, blockerTile.Y);
        Point actor = new((int)localPlayer.Tile.X, (int)localPlayer.Tile.Y);
        Point? best = null;
        int bestDistance = int.MaxValue;
        int bestSteps = int.MaxValue;
        var visited = new HashSet<Point> { actor };
        var pending = new Queue<(Point Tile, int Steps)>();
        pending.Enqueue((actor, 0));
        while (pending.Count > 0)
        {
            (Point tile, int steps) = pending.Dequeue();
            int distance = Math.Max(Math.Abs(tile.X - blocker.X), Math.Abs(tile.Y - blocker.Y));
            // Standing ON the blocker is not standing where its row publishes: the tile is occupied, so a walk there is
            // refused and the distance is zero only when the occupant's own tile is somehow walkable.
            if (distance > 0 && distance <= ExecutionManager.TargetDiscoveryRadius)
            {
                bool better = distance < bestDistance
                    || (distance == bestDistance && steps < bestSteps)
                    || (distance == bestDistance && steps == bestSteps
                        && (best is not { } incumbent || Before(tile, (incumbent.X, incumbent.Y))));
                if (better)
                {
                    best = tile;
                    bestDistance = distance;
                    bestSteps = steps;
                }
            }

            foreach (Point offset in CardinalOffsets)
            {
                Point next = new(tile.X + offset.X, tile.Y + offset.Y);
                if (next.X < 0 || next.Y < 0 || next.X >= layer.LayerWidth || next.Y >= layer.LayerHeight)
                    continue;
                if (!IsWalkableTile(location, localPlayer, new Vector2(next.X, next.Y)) || !visited.Add(next))
                    continue;
                if (visited.Count > ReachabilityProbeLimit)
                    return new PublishTile(null, false);
                pending.Enqueue((next, steps + 1));
            }
        }

        return new PublishTile(best is { } found ? (found.X, found.Y) : null, true);
    }

    /// <summary>
    /// The refusal's HINT: everything a settled failure keeps. The evidence above is withheld once a failure settles
    /// (ADR-006), so this is the only channel that reaches the model.
    ///
    /// <para>
    /// Measured `round41`, 19:04-19:05: a navigation warped the actor to the Farm's north exit, whose only land route
    /// was an 18-tile corridor closed at its far end by ONE weed. Eleven `move_to_tile` refusals followed in 59 seconds
    /// and every hint said `closest=40,7;closest_distance=30` - a coordinate she adopted as her own position ("I'm stuck
    /// at 40,7") - while `component_tiles`, `target_enclosed` and the weed's own name appeared in her session 0 times.
    /// She lost 76 seconds and escaped by cutting weeds nothing had named.
    /// </para>
    /// <para>
    /// So the hint carries the size of the route, the verdict, WHAT closes it and where, the action that opens it (or
    /// the word that no action does), the tile a swing reaches it from, and what walking instead would cost. It is
    /// composed in that order under the journal's own bound
    /// (<see cref="BodyProgramValidation.MaximumNodeHintLength"/>): a hint longer than that is refused by the wire AND
    /// the journal, which would make the refusal silent again - so the least important segment is dropped rather than
    /// the whole field.
    /// </para>
    /// </summary>
    private string DescribeRouteHint(
        Farmer localPlayer,
        LocalMoveSpec specification,
        ReachabilityVerdict verdict,
        string blockedBy)
    {
        var segments = new List<string>
        {
            // The pinned two answers of `RefusalHint`: the closest tile the flood reached, or the layer that refused
            // the destination - and only the first of them when the verdict says a walk ARRIVES from there. When it does
            // not, the flood's nearest tile is the end of a dead end, and publishing it as `closest=` is a step a caller
            // will take (measured `round78`: `closest=34,6;closest_distance=6` beside `stand_at=40,10`, 46 steps to
            // nowhere). `progress=none` is that answer, and the layer still travels with it.
            RouteExists(verdict, specification.AllowAdjacentArrival)
                ? RefusalHint(verdict.ClosestToTarget, specification.TargetTile, blockedBy)
                : $"{ClearingEvidence.NoProgress};blocked_by={blockedBy}",
            $"component_tiles={verdict.ComponentTiles.ToString(System.Globalization.CultureInfo.InvariantCulture)}",
            $"target_enclosed={verdict.TargetEnclosed.ToString().ToLowerInvariant()}",
        };
        // The step a swing would take, and the thing it would hit, through the SAME resolvers the receipt uses.
        if (this.ResolveClearStep(localPlayer, specification.TargetTile) is { Step.ApproachTile: { } approach })
            segments.Add($"stand_at={approach.X.ToString(System.Globalization.CultureInfo.InvariantCulture)},{approach.Y.ToString(System.Globalization.CultureInfo.InvariantCulture)}");
        if (FindFrontierObstruction(localPlayer, specification.TargetTile) is { } obstruction)
        {
            IReadOnlyList<FarmhandClearingOffer> clearers =
                ClearingActionSurface.ClearersOf(obstruction.Occupant.Occupant, FarmhandActionCatalog.Registrations);
            segments.Add(ClearingEvidence.DescribeBlockerBrief(obstruction.Occupant.Occupant, obstruction.Tile, clearers));
            // Its OWN segment, in the hint's own order: the thing in the way first, then - when the frame published no row
            // for it - WHERE to walk so the family publishes one. Composed by the same formatter the receipt uses, minus
            // its last step: the goal is the request the caller itself made, and the journal's 256-character bound is what
            // the hint has to buy. A separate segment so the ordering is what a too-long hint drops, never the blocker.
            if (this.DescribeTargetStep(
                    localPlayer,
                    this.publishedTargetId?.Invoke(localPlayer, obstruction.Occupant.Occupant, obstruction.Tile.X, obstruction.Tile.Y),
                    obstruction.Tile,
                    clearers,
                    goalTile: null) is { } targetStep)
            {
                segments.Add(targetStep);
            }
        }
        // The other branch of the same decision, in the words the flood's own verdict earns: with the target's
        // neighbourhood outside her component there is no way round, and `detour_steps=46` about a dead end is a route a
        // caller will walk (measured round78).
        segments.Add(RouteExists(verdict, specification.AllowAdjacentArrival)
            ? ClearingEvidence.DescribeDetour(
                verdict.ClosestToTarget is Point reachable ? (reachable.X, reachable.Y) : null,
                verdict.ClosestToTargetSteps)
            : ClearingEvidence.DescribeNoDetour(
                verdict.ClosestToTarget is Point dead ? (dead.X, dead.Y) : null,
                verdict.ClosestToTargetSteps));
        return JoinWithinHintBound(segments);
    }

    /// <summary>
    /// The segments joined by `;`, stopping before the journal's bound - the same bounded walk
    /// `RouteReenteringBodyProgramExecutor` performs when it appends to a hint, so the Mod cannot mint a hint the wire
    /// will refuse.
    /// </summary>
    private static string JoinWithinHintBound(IReadOnlyList<string> segments)
    {
        var text = new System.Text.StringBuilder();
        foreach (string segment in segments)
        {
            int added = (text.Length == 0 ? 0 : 1) + segment.Length;
            if (text.Length + added > BodyProgramValidation.MaximumNodeHintLength)
                break;
            if (text.Length > 0)
                text.Append(';');
            text.Append(segment);
        }
        return text.ToString();
    }

    /// <summary>What going around costs, from the flood's OWN depth - the number a caller weighs the clear against.</summary>
    private static string DescribeDetourFacts(Farmer localPlayer, Vector2 goalTile)
    {
        GameLocation? location = localPlayer.currentLocation;
        if (location?.map is null || location.map.Layers.Count == 0)
            return ClearingEvidence.DescribeDetour(null, null);
        var layer = location.map.Layers[0];
        ReachabilityVerdict? verdict = AssessReachability(
            new Point((int)localPlayer.Tile.X, (int)localPlayer.Tile.Y),
            new Point((int)goalTile.X, (int)goalTile.Y),
            tile => tile.X >= 0
                && tile.Y >= 0
                && tile.X < layer.LayerWidth
                && tile.Y < layer.LayerHeight
                && IsWalkableTile(location, localPlayer, new Vector2(tile.X, tile.Y)),
            ReachabilityProbeLimit,
            findClosestReachable: true);
        return verdict is ReachabilityVerdict assessed
            ? ClearingEvidence.DescribeDetour(
                assessed.ClosestToTarget is Point reachable ? (reachable.X, reachable.Y) : null,
                assessed.ClosestToTargetSteps)
            : ClearingEvidence.DescribeDetour(null, null);
    }

    /// <summary>
    /// The tile just past the actor's walkable component that is nearest <paramref name="goalTile"/>, and what stands on
    /// it - the named occupant when it holds one, the ENGINE's word for the wall when it does not. Null only when the
    /// component has no frontier on the map at all.
    ///
    /// <para>
    /// THE NEAREST TILE DECIDES, not the nearest tile that happens to have a name. The read used to skip every wall and
    /// keep looking for a named entity, so measured `round78` a refusal for `22,31` published
    /// <c>blocker_occupant=bush@28,16</c> - twenty-one tiles along the rim, closing nothing on the route the caller
    /// asked about - because the tile actually closing THAT route was map wall and had no name to give. A rim is what the
    /// nearest tile says it is; a name further along belongs to a different route, and naming it here made the caller walk
    /// to it.
    /// </para>
    /// </summary>
    private static FrontierObstruction? FindFrontierObstruction(Farmer localPlayer, Vector2 goalTile)
    {
        GameLocation? location = localPlayer.currentLocation;
        if (location?.map is null || location.map.Layers.Count == 0)
            return null;
        var layer = location.map.Layers[0];
        HashSet<Point>? component = ReachableTiles(
            new Point((int)localPlayer.Tile.X, (int)localPlayer.Tile.Y),
            ReachabilityProbeLimit,
            tile => tile.X >= 0
                && tile.Y >= 0
                && tile.X < layer.LayerWidth
                && tile.Y < layer.LayerHeight
                && IsWalkableTile(location, localPlayer, new Vector2(tile.X, tile.Y)));
        if (component is null)
            return null;

        FrontierObstruction? best = null;
        int bestDistance = int.MaxValue;
        foreach (Point tile in component)
        {
            foreach (Point offset in CardinalOffsets)
            {
                Point candidate = new(tile.X + offset.X, tile.Y + offset.Y);
                if (component.Contains(candidate))
                    continue;
                if (!location.isTileOnMap(new Vector2(candidate.X, candidate.Y)))
                    continue;
                int distance = Math.Abs(candidate.X - (int)goalTile.X) + Math.Abs(candidate.Y - (int)goalTile.Y);
                bool better = best is not { } incumbent
                    || distance < bestDistance
                    || (distance == bestDistance && Before(candidate, incumbent.Tile));
                if (!better)
                    continue;
                best = new FrontierObstruction(
                    (candidate.X, candidate.Y),
                    FrontierOccupancy(location, localPlayer, new Vector2(candidate.X, candidate.Y)));
                bestDistance = distance;
            }
        }

        return best;
    }

    /// <summary>
    /// What one frontier tile is, in the words a refusal publishes: the occupant the walk can price or name, and
    /// otherwise the engine's own layer for the wall it is (<c>buildings_tile</c>, <c>back_tile</c>,
    /// <c>location_constraint</c>, <c>water</c>).
    ///
    /// <para>
    /// A wall is an ANSWER and not a reason to keep looking. <see cref="OccupantAt"/> deliberately returns null for
    /// everything it cannot price or name - an unpriceable clump, a building footprint, the map's own water - so a
    /// frontier read that only accepted its answers could only ever describe rims built of bushes and boulders, and said
    /// nothing at all about the far more common rim of map. The layer word is the one <c>blocked_by=</c> and
    /// <c>approaches=</c> already publish for the same tile, so nothing here is a new vocabulary.
    /// </para>
    /// </summary>
    private static Occupancy FrontierOccupancy(GameLocation location, Farmer localPlayer, Vector2 tile)
    {
        if (OccupantAt(location, localPlayer, tile) is { } occupant)
            return occupant;
        string wall = DescribeTargetOccupant(location, tile, localPlayer).Layer.ToWireValue();
        return new Occupancy(wall, null, wall, null);
    }

    /// <summary>The deterministic tie-break between two equally distant frontier obstacles: north-most, then west-most.</summary>
    private static bool Before(Point candidate, (int X, int Y) current) =>
        candidate.Y < current.Y || (candidate.Y == current.Y && candidate.X < current.X);

    /// <summary>What stands on the frontier: an occupant the walk can price or name, or the engine's word for the wall.</summary>
    private readonly record struct FrontierObstruction((int X, int Y) Tile, Occupancy Occupant);

    /// <summary>
    /// Handles the tick a clear-approach walk reaches <c>stand_at</c>, or says false when this tick is not one.
    /// </summary>
    private bool TryCompleteClearApproach(LocalMoveSpec walk, Vector2 currentTile, Farmer localPlayer, int tick)
    {
        if (this.clearApproach is not { } arrived || arrived.Requested.ExecutionId != walk.ExecutionId)
            return false;

        localPlayer.Halt();
        localPlayer.controller = null;
        this.pathController = null;
        this.CompleteClearApproachArrival(arrived, currentTile, localPlayer, tick);
        return true;
    }

    /// <summary>
    /// The arrival re-plan: blocker still there means refuse by name with the step attached again; blocker gone
    /// means continue to the tile the caller actually asked for.
    /// </summary>
    internal void CompleteClearApproachArrival(ClearApproach arrived, Vector2 currentTile, Farmer localPlayer, int tick)
    {
        this.clearApproach = null;
        ClearStepOffer? fresh = this.ResolveClearStep(localPlayer, arrived.Requested.TargetTile);
        if (AssessClearApproachArrival(arrived.BlockerTile, fresh?.Step) == ClearApproachArrival.BlockerStillPresent)
        {
            // The blocker is still there, so this walk achieved nothing but a better position. Naming the step
            // again - with the whole idea's size - is what lets the caller decide whether to clear it. Clearing
            // from here would be the walk making a destructive decision it was never given.
            //
            // The step alone was not enough to decide WITH: measured `round40` attempt 2, one weed on a four-way route
            // was the run's only failed action, and a receipt that named the tile and the price but not which action
            // swings at a weed ended it. `DescribeBlocker` adds the engine's name for the occupant, the action of ours
            // whose declared kind accepts it, what that dispatch costs, and how far around it is instead - so the
            // caller's next plan can weigh the two. The refusal is still a refusal: nothing was swung at, removed or
            // persisted.
            string blockerFacts = this.DescribeBlocker(localPlayer, arrived.BlockerTile, arrived.Requested.TargetTile);
            this.Fail(
                ClearStepBlockedReasonCode,
                $"tile={FormatTile(currentTile)};requested={FormatTile(arrived.Requested.TargetTile)};clear_step_walk=arrived;blocker={arrived.BlockerTile.X},{arrived.BlockerTile.Y};{fresh!.Evidence}"
                    + (blockerFacts.Length == 0 ? string.Empty : $";{blockerFacts}"));
            return;
        }

        PathFindController resumed = this.BuildNativePath(arrived.Requested, localPlayer);
        if (resumed.pathToEndPoint is not { Count: > 0 })
        {
            // The blocker this walk was started for is gone, yet the engine still has no route. That is a fact
            // about the world; the fresh plan is offered when one resolves, and no second clear is implied.
            string next = fresh is null ? string.Empty : $";{fresh.Evidence}";
            // The ONE `no_native_path` refusal that used to omit the field: every other mint site carried it, so this one
            // read as "nothing is in the way" about a world the caller had just failed to walk through.
            RefusalLayerToken resumedBlocker = RefusalProbe.Describe(
                action: null,
                localPlayer.currentLocation,
                arrived.Requested.TargetTile,
                localPlayer);
            string blockedBy = resumedBlocker.Format();
            // WHERE the walk it just tried could still go. This branch used to carry the layer and nothing a caller could
            // dispatch: the blocker this walk was for is gone and the engine still has no route, so `clear_step=...` (when
            // a fresh plan resolves one) was the only tile in it and `blocked_by=none` read as "nothing is in the way" about
            // a world it had just failed to walk through. The tile is named only when the verdict says the walk ARRIVES
            // from it, from the same probe every other reachability claim here uses - here the engine has already refused
            // the route, so a `closest=` off a dead end would be the strongest kind of misleading.
            string reachable = AssessNativeReachability(localPlayer, arrived.Requested, findClosestReachable: true) is { } afterClear
                ? $";{DescribeWalkTarget(afterClear, arrived.Requested.TargetTile, arrived.Requested.AllowAdjacentArrival)}"
                : string.Empty;
            this.Fail(
                WalkRefusalCode(resumedBlocker, NoNativePathReasonCode),
                $"from={FormatTile(currentTile)};to={FormatTile(arrived.Requested.TargetTile)};location={localPlayer.currentLocation?.NameOrUniqueName ?? "unknown"};native=attempted;clear_step_cleared=true;blocked_by={blockedBy}{next}{reachable}");
            return;
        }

        this.InstallStagedStep(arrived.Requested, resumed, localPlayer, tick);
    }

    /// <summary>
/// Starts a local move, and on refusal says where the caller CAN go.
///
/// <para>
/// The hint is filled from `reachabilityHint`, which the refusal branches set. It is a separate out-parameter rather
/// than a slice of `evidence` because the two travel to different places: evidence goes into the receipt and the world
/// fact and is refused for a failed node, while the hint goes into the node's `Hint` and reaches the model.
/// </para>
/// </summary>
    public bool TryStart(LocalMoveSpec specification, Farmer localPlayer, int tick, out string reasonCode, out string? evidence, out string? hint)
    {
        bool started = this.TryStartCore(specification, localPlayer, tick, out reasonCode, out evidence);
        hint = started ? null : this.reachabilityHint;
        return started;
    }

    /// <summary>
    /// The same start, for a caller with nowhere to put a hint.
    ///
    /// <para>
    /// Three call sites do not mint a Body Program node - a staged approach leg and two gathering handlers - so they have no
    /// node to hang a `Hint` on. Discarding it here is honest: they never needed it. A caller that DOES settle a node uses
    /// the overload above, which is what carries the hint to the model.
    /// </para>
    /// </summary>
    public bool TryStart(LocalMoveSpec specification, Farmer localPlayer, int tick, out string reasonCode, out string? evidence) =>
        this.TryStart(specification, localPlayer, tick, out reasonCode, out evidence, out _);

    private bool TryStartCore(LocalMoveSpec specification, Farmer localPlayer, int tick, out string reasonCode, out string? evidence)
    {
        // Cleared per call. `reachabilityHint` is instance state, and a stale hint from the previous refusal would
        // otherwise attach to a refusal that computed nothing - a `closest=` pointing at a tile from an unrelated walk.
        this.reachabilityHint = null;
        evidence = null;
        // Asked once and shared by the evidence and the hint, in both branches that can refuse. It is a pure read of the
        // map and the entity lists, so a second call would only risk a second answer.
        //
        // No action row: a WALK declares no tool, no item and no approach, so the layers that can honestly answer are the
        // world ones (a character or an object on the tile, then the map). Passing the caller's action here would let
        // `blocked_by` blame its inventory for a route the planner refused.
        RefusalLayerToken blockedLayer = RefusalProbe
            .Describe(action: null, localPlayer.currentLocation, specification.TargetTile, localPlayer);
        string blockedBy = blockedLayer.Format();
        if (this.active is not null)
        {
            // The body controller can hold exactly one ownership: an in-flight local move. It names it through the
            // manager's single owner table rather than its own literal, so the code and the evidence cannot drift.
            (reasonCode, evidence) = ExecutionManager.LocalMoveOwner(this.active.ExecutionId);
            return false;
        }

        // The body-environment ruling comes from the SHARED authority, not from a third copy of it: this
        // used to be `!CanMove || menu != null || eventUp`, which agreed with admission only by accident and
        // could not say WHY the actor is held. Reading the disposition makes movement and admission decide
        // the same way, and the refusal names the holder (WorldModel is the one place the closed set of
        // holds maps to wire codes).
        ActorWorldFacts movementFacts = WorldModel.ReadFacts(localPlayer);
        ActorDisposition movementDisposition = WorldModel.Classify(movementFacts);
        if (movementDisposition.Kind != ActorDispositionKind.Idle || !localPlayer.CanMove)
        {
            // A movement lock the facts cannot name further (a knockback, the `NetMutex`-deferred upgrade at
            // ParrotUpgradePerch.cs:797) reads as Idle, so the `!CanMove` tail is what makes it a hold here. WHO holds
            // her is not this method's answer: `WorldModel.DescribeCurrentHeldBody` names the native countdown that is
            // running (`body_pause:noMovementPause`, with what is left of it) or, when nothing is running, the dead end
            // by the one engine field that reported it - and the step that ends each.
            //
            // MEASURED `round86`: this branch answered `transient_kind=movement_lock;retry_window_ms=2000;can_move=false`
            // sixteen times while the game clock stood still for four minutes at day 7 16:40, because a sentence that
            // names no holder and publishes a 2 s window reads as "wait and it clears" - and the engine stops the clock
            // while `!CanMove`, so the lock owned the world too.
            (string holdCode, string holdEvidence) = WorldModel.DescribeCurrentHeldBody(localPlayer);
            reasonCode = holdCode;
            evidence = holdEvidence;
            return false;
        }
        if (localPlayer.controller is not null)
        {
            reasonCode = "native_controller_owned";
            evidence = $"tile={(int)localPlayer.Tile.X},{(int)localPlayer.Tile.Y}";
            return false;
        }
        if (localPlayer.currentLocation is null)
        {
            reasonCode = "location_unavailable";
            return false;
        }

        // A COORDINATE IS NOT A PLACE. Measured `round78`: four `move_to_tile` requests named tiles whose own ground the
        // map refuses AND whose four neighbours read `buildings_tile:blocked` - no body could ever be there or beside
        // one of them, so no target family could have published them and they came from the model reading the map. The
        // walk answered `no_native_path`, which reads as "the road is closed" about a cell that is not a place at all, and
        // the caller re-aimed at neighbours of a wall. This question needs no flood and no engine: it is the map's own
        // answer, and it is the same admission every published target row passes
        // (<see cref="ExecutionManager.IsTargetTileAddressable"/>) widened by the one case a walk to the tile itself needs -
        // the body may stand ON the tile.
        //
        // It does NOT go through <see cref="WalkRefusalCode"/>: that mapping exists so a character standing in the way is
        // never reported as an absent route, and no character and no wait can make a wall a place. The tile the body is
        // ALREADY standing on is exempt for the same reason - a body is standing on it, which settles the question.
        if ((int)localPlayer.Tile.X != (int)specification.TargetTile.X
            || (int)localPlayer.Tile.Y != (int)specification.TargetTile.Y)
        {
            if (!IsAddressableTile(localPlayer.currentLocation, specification.TargetTile))
            {
                // WHICH HALF OF THE ADDRESSABILITY ANSWER FAILED, named: the coordinate is not a cell of this map, or
                // the cell is and its ground admits no body. The evidence spelled `target_on_map=` for both and the code
                // did not, so `round84`'s three refusals read as one fact (see TargetOffMapReasonCode).
                bool onMap = localPlayer.currentLocation.isTileOnMap(specification.TargetTile);
                reasonCode = onMap ? TargetNotAddressableReasonCode : TargetOffMapReasonCode;
                evidence = $"from={(int)localPlayer.Tile.X},{(int)localPlayer.Tile.Y};to={(int)specification.TargetTile.X},{(int)specification.TargetTile.Y};location={localPlayer.currentLocation.NameOrUniqueName};native=not_attempted;target_on_map={(onMap ? "true" : "false")};target_passable={(onMap && localPlayer.currentLocation.isTilePassable(specification.TargetTile) ? "true" : "false")};approaches={DescribeTargetApproaches(localPlayer, localPlayer.currentLocation, specification.TargetTile)};blocked_by={blockedBy}";
                this.reachabilityHint = JoinWithinHintBound(new[]
                {
                    reasonCode,
                    $"target_on_map={(onMap ? "true" : "false")}",
                    $"approaches={DescribeTargetApproaches(localPlayer, localPlayer.currentLocation, specification.TargetTile)}",
                });
                return false;
            }
        }

        // ASK THE CHEAP QUESTION FIRST.
        //
        // The engine finder below searches synchronously on the game thread with a 40 000-node budget, and a target
        // with no route at all makes it spend that whole budget before returning null - tens of seconds of frozen
        // frames, or worse. That is the shape the multi-day runs die in: every frozen log ends at a dequeued
        // navigation execution (measured 2026-10-19), i.e. inside this method.
        //
        // The Mod already owns a bounded cardinal flood that answers the cheaper question - is the target's
        // neighbourhood even in the actor's walkable component - and it is the same probe the refusal evidence below
        // already reports. Asking it first costs a bounded flood and keeps the engine call for the cases that can
        // actually succeed.
        if (AssessNativeReachability(localPlayer, specification, findClosestReachable: true) is { } unreachable
            && !RouteExists(unreachable, specification.AllowAdjacentArrival))
        {
            // The verdict, DERIVED. This branch used to publish the literal `route_exists_cardinal=false`, in a branch that
            // could only be entered when the flood had not found the target ON the actor's side - so a target whose
            // walkable neighbour WAS reached and whose own tile was not read exactly like a target twenty tiles away behind
            // a wall. `DescribeRouteClaim` is the one place those two claims are derived, and the engine branch below uses
            // it too, so the two mint sites cannot disagree about one verdict.
            reasonCode = WalkRefusalCode(blockedLayer, NoNativePathReasonCode);
            evidence = $"from={(int)localPlayer.Tile.X},{(int)localPlayer.Tile.Y};to={(int)specification.TargetTile.X},{(int)specification.TargetTile.Y};location={localPlayer.currentLocation.NameOrUniqueName};native=not_attempted;probe=cardinal_flood;{DescribeRouteClaim(unreachable, specification.AllowAdjacentArrival)};component_tiles={unreachable.ComponentTiles};gate=reachability_flood"
                // ALWAYS, on this branch: it is entered only when the walk cannot end on the target tile, so the four
                // approaches ARE the answer - and their absence was half of what made the round78 receipt unreadable.
                + $";approaches={DescribeTargetApproaches(localPlayer, localPlayer.currentLocation, specification.TargetTile)}"
                + $";target_standable={(IsStandableTile(localPlayer.currentLocation, localPlayer, specification.TargetTile) ? "true" : "false")}"
                + $";target_walkable={(IsWalkableTile(localPlayer.currentLocation, localPlayer, specification.TargetTile) ? "true" : "false")}"
                + $";blocked_by={blockedBy}"
                // The staging hint belongs on THIS path too, and its absence here was the whole reason the model could not act.
                //
                // Measured 2026-11-01 (`round21`): nine `move_to_tile` refusals in Mountain, each carrying 284 bytes of evidence
                // that the model never saw - `component_tiles`, `target_enclosed` and `route_exists_cardinal` appear 0 times in
                // its session, `no_native_path` 26. The flood had already computed the one tile that would have ended the loop
                // and `FormatReachableHint` was only wired into the branch below, so this branch published the verdict without
                // the escape. The hint is now on both branches, from the same `ClosestToTarget` the flood already filled.
                //
                // `closest=` only when the verdict says a walk ARRIVES from that tile, and `progress=none` when it does
                // not: the tile this branch computes is the nearest tile of a component that cannot reach the target, and
                // naming it "closest" is what sent a live companion 46 steps to a dead end (`round78`).
                + $";{DescribeWalkTarget(unreachable, specification.TargetTile, specification.AllowAdjacentArrival)}"
                + DescribeClearToReach(localPlayer, specification)
                // WHAT is in the way, when a clearing plan has no step to offer. Without this branch a bush - which no
                // published action removes, so the plan is `unreachable` - refused with `blocked_by=none` about a tile
                // the caller could not get past, and the two prices of the decision were both missing.
                + this.DescribeFrontierBlocker(
                    localPlayer,
                    specification.TargetTile,
                    // NOT a detour: this branch's own verdict is that the target's neighbourhood is outside her
                    // component, so the flood's depth is how far the walk gets and not a way round (round78's
                    // `reachable=34,6;detour_steps=46` beside `route_exists_cardinal=false`).
                    ClearingEvidence.DescribeNoDetour(
                        unreachable.ClosestToTarget is Point frontierGoal ? (frontierGoal.X, frontierGoal.Y) : null,
                        unreachable.ClosestToTargetSteps));
            this.reachabilityHint = this.DescribeRouteHint(localPlayer, specification, unreachable, blockedBy);
            return false;
        }

        PathFindController plannedPath = this.BuildNativePath(specification, localPlayer);
        if (plannedPath.pathToEndPoint is null || plannedPath.pathToEndPoint.Count == 0)
        {
            reasonCode = WalkRefusalCode(blockedLayer, NoNativePathReasonCode);
            evidence = $"from={(int)localPlayer.Tile.X},{(int)localPlayer.Tile.Y};to={(int)specification.TargetTile.X},{(int)specification.TargetTile.Y};location={localPlayer.currentLocation.NameOrUniqueName}";
            // A refusal is only actionable if it names WHY. The bare verdict plus a probe field
            // that can contradict it sent a live agent into ten blind re-aims at neighbouring
            // occupied tiles, which it then described as a maze. So the receipt carries the
            // occupancy cause, whether the PLANNER would stand on the tile, and the probe's own
            // reading — plus, below, the two facts the native null path conflates.
            evidence += $";target_standable={(IsStandableTile(localPlayer.currentLocation, localPlayer, specification.TargetTile) ? "true" : "false")}";
            evidence += $";target_walkable={(IsWalkableTile(localPlayer.currentLocation, localPlayer, specification.TargetTile) ? "true" : "false")}";
            evidence += $";blocked_by={blockedBy}";
            // The native finder returned null. That is TWO different facts, and the receipt
            // must not collapse them:
            //   * the planner's own (cardinal) component does not contain the target's
            //     neighbourhood -- no route the planner can walk; or
            //   * it DOES contain it and the finder still returned null, which is the only
            //     case where a budget/limit explanation is even possible.
            // The probe below therefore floods with the PLANNER's neighbourhood. An earlier
            // version flooded with all eight neighbours and reported the first case as the
            // second: a live refusal read `route_exists=true ... path_search=native_budget_exhausted`
            // for a destination whose cardinal approaches were both blocked, and a measurement at
            // 10000 / 40000 / 400000 expansions returned null identically, so the budget it named
            // was never the cause. What it called a route was a diagonal one the planner cannot
            // walk, and what it called budget exhaustion was a label it had not measured at all.
            string searchOutcome;
            ReachabilityVerdict? verdict = AssessNativeReachability(localPlayer, specification, findClosestReachable: true)
                ?? AssessNativeReachability(localPlayer, specification);
            if (verdict is ReachabilityVerdict assessed)
            {
                bool routeExists = RouteExists(assessed, specification.AllowAdjacentArrival);
                // `probe_says_reachable` states the disagreement explicitly
                // instead of leaving a reader to derive it from target_enclosed.
                evidence += $";{DescribeRouteClaim(assessed, specification.AllowAdjacentArrival)};derived=true;probe=cardinal_flood;probe_says_reachable={(assessed.TargetEnclosed ? "false" : "true")}";
                evidence += $";component_tiles={assessed.ComponentTiles}";
                // The target's own approaches whenever the walk cannot END on its tile: the verdict and the ring are two
                // facts about one world, and a receipt that carries only the first reads as a contradiction.
                if (!assessed.ComponentContainsTarget)
                    evidence += $";approaches={DescribeTargetApproaches(localPlayer, localPlayer.currentLocation, specification.TargetTile)}";
                // Where it CAN go - when the verdict says the walk arrives from there.
                evidence += $";{DescribeWalkTarget(assessed, specification.TargetTile, specification.AllowAdjacentArrival)}";
                searchOutcome = routeExists
                    ? "planner_null_with_cardinal_route"
                    : "no_cardinal_route";
                // The native API exposes only a null path, not whether its bound was exhausted. Keep the
                // configured bound visible, but never publish it as a measured cause: an earlier version
                // reported `native_budget_exhausted` here, and a measurement at 10000, 40000 and 400000
                // expansions returned null identically — the limit was never the variable.
                evidence += $";measurement=cardinal_flood;path_search={searchOutcome};budget=undecided";
                // A staging step must be inside the component the PLANNER can walk, so prefer the tile the
                // cardinal flood itself reports as the closest one it reached, and fall back to the cardinal
                // neighbour scan only when the flood offers nothing. Measured reason: an eight-neighbour
                // heuristic can pick a diagonally-adjacent tile the cardinal planner cannot reach either, which
                // is how a staged approach ended at `did_not_arrive` after a step the actor never took.
                Point? floodStaging = assessed.ClosestToTarget;
                if (!assessed.TargetEnclosed && floodStaging is Point fromFlood)
                {
                    LocalMoveSpec floodStep = specification with
                    {
                        TargetTile = new Vector2(fromFlood.X, fromFlood.Y),
                        AllowAdjacentArrival = true,
                        RequestedTile = specification.TargetTile,
                        StagedApproach = true,
                        StagedSteps = specification.StagedSteps + 1,
                    };
                    PathFindController floodPath = this.BuildNativePath(floodStep, localPlayer);
                    if (floodPath.pathToEndPoint is { Count: > 1 })
                    {
                        evidence += $";staged_approach=true;staged_target={fromFlood.X},{fromFlood.Y};staged_source=cardinal_flood;staged_steps={floodStep.StagedSteps};requested={(int)specification.TargetTile.X},{(int)specification.TargetTile.Y}";
                        this.InstallStagedStep(floodStep, floodPath, localPlayer, tick);
                        reasonCode = "accepted";
                        return true;
                    }
                    evidence += ";cardinal_flood_step_unroutable=true";
                }
                if (!assessed.TargetEnclosed
                    && this.TryStageTowards(specification, specification.TargetTile, localPlayer, out LocalMoveSpec staged, out PathFindController stagedPath, out string stagedEvidence))
                {
                    // The native finder does the moving; only the DESTINATION differs, and the receipt names both
                    // so the caller can see the difference. One productive step is what turns "unreachable far
                    // goal" into progress the companion can build on: its next observation is closer.
                    evidence += $";staged_approach=true;staged_target={FormatTile(staged.TargetTile)};{stagedEvidence}";
                    this.InstallStagedStep(staged, stagedPath, localPlayer, tick);
                    reasonCode = "accepted";
                    return true;
                }
                else if (!assessed.TargetEnclosed)
                {
                    evidence += ";staged_approach_failed=true";
                }
            }
            else
            {
                // The probe abandoned its own claim (component beyond its budget), so no
                // reachability statement is made and the native verdict stands alone.
                evidence += ";path_search=undecided";
            }
            // THE HINT BELONGS ON THIS BRANCH TOO, and its absence here is why every live run since the hint was
            // written still refused with a bare reason code.
            //
            // Measured 2026-11-02 (`round24`, first day, `go_mining`): 27 `move_to_tile` refusals in Mountain, the
            // model's session containing `closest=` 0 times and `blocked_by` 0 times, while every receipt carried
            // `reason=no_native_path` and nothing else. The first branch below (the cardinal flood saying the target's
            // component is unreachable) set this field; THIS branch - native finder returned null - did not, and that
            // is the branch a walk through Mountain's landslide takes.
            //
            // Filled only when the flood actually found something: `ClosestToTarget` is null when it found nothing
            // closer, and `FormatReachableHint` already renders that as the empty string rather than a false claim.
            if (verdict is ReachabilityVerdict hintSource)
            {
                this.reachabilityHint = this.DescribeRouteHint(localPlayer, specification, hintSource, blockedBy);
            }
            return false;
        }

        this.active = specification;
        this.pathController = plannedPath;
        localPlayer.controller = plannedPath;
        this.lastTile = localPlayer.Tile;
        this.lastProgressTick = tick;
        this.hasEmittedStalledWaiting = false;
        this.isStallWaiting = false;
        this.stallWaitStartedTick = 0;
        this.transientSinceMs = 0;
        reasonCode = "accepted";
        return true;
    }

    public void Cancel(string reasonCode) => this.Stop(ExecutionState.Cancelled, reasonCode, "local_controller_halted");

    public void Invalidate(string reasonCode) => this.Stop(ExecutionState.Invalidated, reasonCode, "lifecycle_or_world_change");

    /// <summary>
    /// World-change interruption with its own evidence (e.g. the WIA intent
    /// breakpoint). The single-argument overload keeps the generic lifecycle
    /// marker for callers that have no further facts to attach.
    /// </summary>
    public void Invalidate(string reasonCode, string evidence) => this.Stop(ExecutionState.Invalidated, reasonCode, evidence);

    public void Halt()
    {
        if (ReferenceEquals(Game1.player?.controller, this.pathController))
        {
            if (Game1.player is not null)
                Game1.player.controller = null;
        }
        Game1.player?.Halt();
        this.active = null;
        this.pathController = null;
        this.clearApproach = null;
        this.hasEmittedStalledWaiting = false;
        this.isStallWaiting = false;
        this.stallWaitStartedTick = 0;
        this.transientSinceMs = 0;
    }

    /// <summary>
    /// The last step this controller entered, and how many ticks it has been entered on.
    ///
    /// Why it exists: four multi-day runs died with the game thread inside `Executions.Update()` - the Mod log
    /// simply stopped, with no exception and no watchdog line, while the process kept a core busy. The stage marker
    /// can only say "inside the executions update", and this controller calls INTO the engine from there (the native
    /// pathfinder is constructed synchronously), so the question is which of those engine calls never returned. The
    /// heartbeat prints both fields, so the last heartbeat of a frozen run answers it without a debugger.
    /// </summary>
    internal static string LastPhase { get; private set; } = "idle";

    /// <summary>Ticks this controller has entered; a frozen count next to a frozen heartbeat is a hang, not a pause.</summary>
    internal static long EnteredTicks { get; private set; }

    private static void MarkBodyPhase(string phase) => LastPhase = phase;

    public void Update(int tick)
    {
        EnteredTicks += 1;
        // Everything below this line runs on the game thread and may call into the engine.
        MarkBodyPhase("update_begin");
        LocalMoveSpec? specification = this.active;
        if (specification is null)
            return;

        Farmer localPlayer = Game1.player;
        PathFindController? pathController = this.pathController;

        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (tick > specification.DeadlineTick || nowMs >= specification.DeadlineMs)
        {
            this.Expire("deadline_expired", "authoritative deadline reached");
            return;
        }

        // WIA §4.1: the body state is projected ONCE per tick and every ruling
        // below consumes that projection; no branch re-checks the menu/event/
        // movement trio itself. The projection is currently this class's local
        // equivalent of Lane A's WorldModel.ComputeDisposition (wia-contract
         // frozen type), computed here through the shared WorldModel.Classify
         // authority; no local disposition precedence is maintained in this loop.
        LocalDispositionKind disposition = ClassifyLocalDisposition(localPlayer, out ActorTransientKind? transient);

        switch (disposition)
        {
            case LocalDispositionKind.Transient:
                // WIA §4.4: a transient body lock keeps the execution running and
                // reports no new reasonCode while inside the window; a lock that
                // outlives it falls through to the regular rulings below. The window
                // is the classified KIND's own, so this loop waits exactly what the
                // refusal published to the Agent (`freezePause` is guarded for 20 s).
                if (this.KeepRunningWithinTransientWindow(nowMs, transient))
                    return;
                break;
            case LocalDispositionKind.Modal:
                // WIA §1.1/§4.1 ② -- world-change interruption: an external modal
                // (DialogueBox/LetterViewer/ReadyCheck/GameMenu) interrupts the
                // action and fully releases the body lease. The receipt carries the
                // intent breakpoint the Agent needs to replan -- interrupted_by /
                // target_tile / interrupted_at / remaining_distance -- plus the
                // request-bound revision. (The receipt's authoritative Revision
                // field, stamped by ExecutionManager after this transition, carries
                // the post-disposition-change revision per the WIA planning-revision
                // binding; the controller cannot read the manager's live counter.)
                this.Invalidate("modal_interrupted",
                    FormatModalInterruptedEvidence(
                        Game1.activeClickableMenu?.GetType().Name ?? "menu",
                        specification.TargetTile,
                        localPlayer.Tile,
                        Vector2.Distance(localPlayer.Tile, specification.TargetTile),
                        specification.RouteRevision));
                return;
            case LocalDispositionKind.Event:
                // WIA §4.3 world-change family: a cutscene absorbs the actor, so
                // the action terminates with the existing event_started
                // classification rather than an action fault.
                this.Invalidate("event_started");
                return;
            case LocalDispositionKind.PassOut:
                // WIA §2-6/§4.3 world-change family: timeOfDay>=2600 or stamina<=-15
                // (imminent native pass-out) is a world fact, not an action fault.
                // The receipt carries the body facts -- stamina / time / tile -- so
                // the Agent schedules the eat/rest recovery instead of treating this
                // as a retryable failure.
                this.Invalidate("pass_out",
                    FormatPassOutEvidence(localPlayer.Stamina, Game1.timeOfDay, localPlayer.Tile, specification.RouteRevision));
                return;
            default:
                this.transientSinceMs = 0;
                break;
        }

        Vector2 currentTile = localPlayer.Tile;
        bool exactArrival = Vector2.DistanceSquared(currentTile, specification.TargetTile) <= 0.04f;
        bool adjacentArrival = specification.AllowAdjacentArrival
            && IsChebyshevAdjacent(Math.Abs((int)currentTile.X - (int)specification.TargetTile.X), Math.Abs((int)currentTile.Y - (int)specification.TargetTile.Y));

        // A clear-approach walk ends where a swing would reach from, and what happens there is a RE-PLAN rather than
        // a swing: the blocker may have been removed by someone else (or never been the only obstacle), and clearing
        // is the caller's action with its own tool, stamina cost and policy question. This is checked before the
        // ordinary arrival branches because its arrival is not success for the caller's request.
        if (exactArrival && this.TryCompleteClearApproach(specification, currentTile, localPlayer, tick))
            return;
        if (this.isStallWaiting)
        {
            if (!HasStallWaitElapsed(tick, this.stallWaitStartedTick, StallWaitTicks))
                return;

            PathFindController resumedPath = this.BuildNativePath(specification, localPlayer);
            if (resumedPath.pathToEndPoint is null || resumedPath.pathToEndPoint.Count == 0)
            {
                this.Fail(StallRefusalCode(DescribeStallBlocker(localPlayer.currentLocation, localPlayer, specification.TargetTile)), FormatStallEvidence(localPlayer, specification, tick));
                return;
            }

            this.pathController = resumedPath;
            localPlayer.controller = resumedPath;
            this.isStallWaiting = false;
            return;
        }

        if (!ReferenceEquals(localPlayer.controller, pathController))
        {
            if (exactArrival || adjacentArrival)
            {
                // A staged step stops at a tile the caller never asked for: only continue (or finish) when the
                // actor can now act on the REQUESTED tile.
                if (this.TryAdvanceStagedApproach(specification, currentTile, localPlayer, tick, out string advanced))
                    return;
                if (specification is { StagedApproach: true, RequestedTile: Vector2 stagedGoal }
                    && !IsWithinRequestedReach(currentTile, stagedGoal))
                {
                    this.Fail(
                        "target_out_of_reach",
                        $"tile={FormatTile(currentTile)};requested={FormatTile(stagedGoal)};reach=1;approach=did_not_arrive;{advanced}");
                    return;
                }
                localPlayer.Halt();
                this.transition(ExecutionState.Succeeded, "target_reached", $"tile={FormatTile(currentTile)};target={FormatTile(specification.TargetTile)};arrival={(exactArrival ? "exact" : "warp_adjacent")};path=stardew_native{FormatStagedMarker(specification)}");
                this.active = null;
                this.pathController = null;
            }
            else
            {
                this.Fail(StallRefusalCode(DescribeStallBlocker(localPlayer.currentLocation, localPlayer, specification.TargetTile)), FormatStallEvidence(localPlayer, specification, tick));
            }
            return;
        }
        if (!localPlayer.CanMove)
        {
            // Stardew briefly reports the Farmhand as non-actionable while a
            // native path controller settles at a doorway/warp approach tile.
            // Keep ownership until the native controller ends; the final tile
            // or path-ended result remains authoritative.
            if (Vector2.DistanceSquared(currentTile, specification.TargetTile) > 1.01f)
            {
                // WHAT happened and WHO holds her, in one sentence. This answered the bare prose `movement lock became
                // active`: no holder, no step, so the caller could only walk into the same lock again. The code stays
                // `player_not_actionable` (`RefusalFacts` declares it for `move_to_tile` as this engine flag), and the
                // holder comes from the one authority that names holds.
                this.Fail(
                    "player_not_actionable",
                    $"tile={FormatTile(currentTile)};target={FormatTile(specification.TargetTile)};{WorldModel.DescribeCurrentNavigationHold(localPlayer)}");
                return;
            }
        }
        if (exactArrival || adjacentArrival)
        {
            if (this.TryAdvanceStagedApproach(specification, currentTile, localPlayer, tick, out string advanced))
                return;
            if (specification is { StagedApproach: true, RequestedTile: Vector2 stagedGoal }
                && !IsWithinRequestedReach(currentTile, stagedGoal))
            {
                this.Fail(
                    "target_out_of_reach",
                    $"tile={FormatTile(currentTile)};requested={FormatTile(stagedGoal)};reach=1;approach=did_not_arrive;{advanced}");
                return;
            }
            localPlayer.Halt();
            localPlayer.controller = null;
            this.pathController = null;
            this.transition(ExecutionState.Succeeded, "target_reached", $"tile={FormatTile(currentTile)};target={FormatTile(specification.TargetTile)};arrival={(exactArrival ? "exact" : "warp_adjacent")};path=stardew_native{FormatStagedMarker(specification)}");
            this.active = null;
            return;
        }

        if (currentTile != this.lastTile)
        {
            // WHERE THE BODY IS, NOT WHAT HAPPENED. A tile of movement is body state: the fact stream carries the
            // settlement (or the terminal receipt) that says how far this got, and the snapshot carries the tile. One
            // receipt per tile made 130 of a run's 401 facts say "she moved", twice each, so the pump assembled 134
            // batches and discarded 126 of them.
            this.lastTile = currentTile;
            this.lastProgressTick = tick;
            this.hasEmittedStalledWaiting = false;
            return;
        }

        StallWatchdogAction stallAction = AssessStall(tick, this.lastProgressTick, this.hasEmittedStalledWaiting);
        if (stallAction == StallWatchdogAction.TimedOut)
        {
            this.Fail(StallRefusalCode(DescribeStallBlocker(localPlayer.currentLocation, localPlayer, specification.TargetTile)), FormatStallEvidence(localPlayer, specification, tick));
            return;
        }

        if (stallAction == StallWatchdogAction.Waiting)
        {
            // The wait itself is body state. What the caller needs is its ending, and that is the refusal this
            // watchdog mints a few seconds later (`StallTimeoutTicks`), not a receipt per no-progress window.
            this.hasEmittedStalledWaiting = true;
            this.isStallWaiting = true;
            this.stallWaitStartedTick = tick;
            this.HaltNativeMovement(localPlayer);
        }
    }

    internal enum StallWatchdogAction
    {
        None,
        Waiting,
        TimedOut,
    }

    /// <summary>Evaluates the L2 watchdog after disposition and arrival checks.
    /// A tile change resets <paramref name="lastProgressTick"/> before this method
    /// is called. The waiting notification is emitted once per no-progress window;
    /// the timeout remains bounded at the frozen five-second native budget.</summary>
    internal static StallWatchdogAction AssessStall(int tick, int lastProgressTick, bool waitingAlreadyEmitted)
    {
        int stalledTicks = Math.Max(0, tick - lastProgressTick);
        if (stalledTicks >= StallTimeoutTicks)
            return StallWatchdogAction.TimedOut;
        if (stalledTicks >= StallDetectionTicks && !waitingAlreadyEmitted)
            return StallWatchdogAction.Waiting;
        return StallWatchdogAction.None;
    }

    /// <summary>Returns whether the quiet blocker window has elapsed. Keeping this
    /// as arithmetic makes its one-second boundary independently testable.</summary>
    internal static bool HasStallWaitElapsed(int tick, int waitStartedTick, int waitTicks) =>
        Math.Max(0, tick - waitStartedTick) >= waitTicks;

    /// <summary>
    /// Node-expansion budget handed to the native finder. The game's own default is 10000
    /// (`PathFindController.cs:74`, used for a player's click), and the finder returns a null
    /// path the moment it exhausts it (`PathFindController.cs:232`). A DENSE field needs more
    /// expansions than a click on open ground: a live play session on a cropped plot had the
    /// finder give up on a free, walkable tile that the walkable component still contained.
    /// 40000 bounds one search on the game thread while covering that field, and the receipt
    /// records the budget so a future failure of this kind is attributable.
    /// </summary>
    private const int NativePathNodeBudget = 40000;

    private PathFindController BuildNativePath(LocalMoveSpec specification, Farmer localPlayer)
    {
        GameLocation location = localPlayer.currentLocation!;
        // The engine's finder runs its search INSIDE this constructor, on the game thread, bounded by the node
        // budget below: it is the one place here that can hold the tick for a long time, so it gets its own phase.
        MarkBodyPhase("native_path_build");
        PathFindController built = new PathFindController(
            localPlayer,
            location,
            this.IsArrivalTile(specification),
            -1,
            null,
            NativePathNodeBudget,
            new Point((int)specification.TargetTile.X, (int)specification.TargetTile.Y));
        MarkBodyPhase("native_path_built");
        return built;
    }

    private void HaltNativeMovement(Farmer localPlayer)
    {
        if (ReferenceEquals(localPlayer.controller, this.pathController))
            localPlayer.controller = null;
        // Halt clears the native movement intent. In particular, do not leave the
        // PathFindController installed while waiting: Farmer collision handling
        // would continue pushing the entity that caused this stall.
        localPlayer.Halt();
    }

    private string FormatStallEvidence(Farmer localPlayer, LocalMoveSpec specification, int tick)
    {
        int stalledTicks = Math.Max(0, tick - this.lastProgressTick);
        return $"tile={FormatTile(localPlayer.Tile)};target={FormatTile(specification.TargetTile)};stalled_ticks={stalledTicks};stopped_by={DescribeStallBlocker(localPlayer.currentLocation, localPlayer, specification.TargetTile)}";
    }

    /// <summary>
    /// The planner's own step set: cardinal only (`PathFindController.cs:45-51`). Shared so the reachability
    /// flood and the cardinal-neighbour tests cannot drift from the graph the native finder actually searches.
    /// </summary>
    /// <summary>
    /// How many single-tile staged steps one walk may take. Strictly-decreasing distance already terminates a
    /// walk, so this is the bound that keeps a pathological field from re-planning indefinitely.
    /// </summary>
    private const int MaxStagedSteps = 24;

    internal static readonly Point[] CardinalOffsets =
    {
        new(0, -1), new(1, 0), new(0, 1), new(-1, 0),
    };

    /// <summary>
    /// THE tile-admission rule. This file asks "may the body be on this tile?" in exactly one place, because the
    /// engine asks it in exactly one place: <c>PathFindController</c> admits a step only when this same call is false
    /// (<c>PathFindController.cs:222</c>, on a 62x62 box at <c>tile * 64 + 1</c>, with <c>pathfinding: true</c>).
    ///
    /// <para>
    /// Why it has to be this call and not a cheaper reading: <c>isTilePassable</c> reads the map's Back and Buildings
    /// layers and nothing else, so it answers "passable ground" about a tile holding a boulder, a chest or a chair,
    /// and it counts a trellis crop as open ground the planner refuses. Two readings of one tile meant "the planner
    /// will walk there" and "we may stand there" could both be true and disagree. Collision <i>effects</i> are
    /// skipped because this is a question, not a step: asking must not shake a crop or shove an animal.
    /// </para>
    /// </summary>
    private static bool IsPlannerAdmissibleTile(GameLocation location, Farmer actor, Vector2 tile) =>
        !location.isCollidingPosition(
            StepBox(tile),
            Game1.viewport,
            actor is Farmer,
            0,
            glider: false,
            actor,
            pathfinding: true,
            skipCollisionEffects: true);

    /// <summary>
    /// The pixel box one tile's step occupies, and the ONE spelling of it: the planner admits a step with a 62x62 box
    /// inset by one pixel (<c>PathFindController.cs:222</c>), while a 64x64 square at <c>tile * 64</c> also covers the
    /// first column and row of the tiles next door. Measured `round41`: an ordinary Farm tile directly north of the
    /// farmhouse read <c>blocked_by=location_constraint:blocked@64,14</c> - a constraint the map never made, over its
    /// neighbour's boundary.
    /// </summary>
    private static Microsoft.Xna.Framework.Rectangle StepBox(Vector2 tile) =>
        new((int)tile.X * 64 + 1, (int)tile.Y * 64 + 1, 62, 62);

    /// <summary>
    /// The on-map and own-tile guards both entry points share. The actor's own tile is admitted without asking the
    /// collision test: they are already standing on it, and the one thing that question reliably reports about your
    /// own tile is your own footprint.
    /// </summary>
    private static bool IsTileAdmittedForBody(GameLocation location, Farmer actor, Vector2 tile) =>
        location.isTileOnMap(tile)
        && (actor.Tile == tile || IsPlannerAdmissibleTile(location, actor, tile));

    /// <summary>
    /// "The planner will walk there" -- the traversal reading, for choosing a walk.
    /// </summary>
    internal static bool IsWalkableTile(GameLocation location, Farmer? actor, Vector2 tile)
    {
        return actor is not null && IsTileAdmittedForBody(location, actor, tile);
    }

    /// <summary>
    /// What actually stops a farmer standing on a tile, over and above the native step test.
    ///
    /// <para>
    /// Two things keep this list narrow. <c>CollisionMask.All</c> (255) includes <c>TerrainFeatures</c>, where grass,
    /// tilled soil and crops live, so a full mask reported ordinary farm ground as "occupied", the approach ring
    /// around a rock lost its near face, and the companion walked round the far side of a rock to break it. Standing
    /// among terrain features is the job; the scythe and the hoe exist for them.
    /// </para>
    /// <para>
    /// The second is that this list is a SECOND PASS, never the rule. A resource clump -- the boulder, stump and
    /// hollow-log family -- is stored in <c>terrainFeatures</c>, which is exactly what the list must ignore, so no
    /// mask membership can refuse a boulder's own tile. <see cref="IsPlannerAdmissibleTile"/> refuses it, because the
    /// planner will not step onto it either. This layer exists only for the occupants that test can still admit: it
    /// checks the tile itself rather than a 62x62 box, and it honours the natives' own passability (a floor path, a
    /// torch or a doorway is occupied and still walkable).
    /// </para>
    /// </summary>
    private const CollisionMask StopsStanding =
        CollisionMask.Buildings
        | CollisionMask.Characters
        | CollisionMask.Furniture
        | CollisionMask.Objects
        | CollisionMask.LocationSpecific;

    /// <summary>
    /// "The body may stop here": the same rule as <see cref="IsWalkableTile"/>, plus the occupants that native
    /// step test can still admit. Because admission is required first, a standable tile is always a walkable one --
    /// the two can no longer disagree about a tile the planner would refuse, which is the state that made the
    /// approach selector hand the finder a destination it would not enter.
    /// </summary>
    internal static bool IsStandableTile(GameLocation location, Farmer? actor, Vector2 tile)
    {
        if (actor is null || !IsTileAdmittedForBody(location, actor, tile))
            return false;
        return actor.Tile == tile
            || !location.IsTileOccupiedBy(tile, StopsStanding, ignorePassables: StopsStanding, useFarmerTile: false);
    }

    /// <summary>
    /// Whether a body can end up AT <paramref name="tile"/> or BESIDE it: the map admits the tile itself (the body may
    /// stand on it, which is what an exact-arrival walk needs), or one of its four cardinal neighbours
    /// (<see cref="ExecutionManager.IsTargetTileAddressable"/>, the admission every published target row passes).
    ///
    /// <para>
    /// Both halves are the map's own reading and not the occupancy list: an entity on a tile is something a caller can
    /// wait out or clear, while a Buildings tile is not. <paramref name="tile"/> off the map answers false - a coordinate
    /// nothing can be at.
    /// </para>
    /// </summary>
    internal static bool IsAddressableTile(GameLocation? location, Vector2 tile)
    {
        if (location is null || !location.isTileOnMap(tile))
            return false;
        return location.isTilePassable(tile)
            || FarmhandTargetDiscovery.IsTargetTileAddressable(location, (int)tile.X, (int)tile.Y);
    }

    /// <summary>
    /// The actionable half of a refusal: the reachable tile nearest the goal, as one bounded token.
    ///
    /// The flood already computes this while deciding enclosure, and the refusal published only the verdict --
    /// `target_enclosed=true` -- which tells the caller "you cannot get there" and nothing about where it CAN go.
    /// An audited live session spent 63% of its turn re-aiming inside a 28-tile pocket, and the one fact that would
    /// have ended the loop (a tile it could actually reach, closer to what it wanted) was computed and thrown away.
    /// `closest=none` is honest: it means the flood found no visited tile closer than where the actor already is.
    /// </summary>
    /// <summary>
    /// The one line a refused move carries to the model.
    ///
    /// <para>
    /// A refusal always says SOMETHING. An empty hint is indistinguishable from "there is nothing to say" - the model then
    /// receives `{"failureCode":"no_native_path"}` and nothing else, which is what produced nine blind re-aims in
    /// `round21` and twenty-nine refusals with an empty hint in `round26`.
    /// </para>
    /// <para>
    /// When there IS a closer tile, its coordinates are the most useful thing that can be said. When there is not - an
    /// enclosed target, where the flood never reaches the neighbourhood - the useful fact is WHAT blocks, which is the
    /// layer `DescribeTargetOccupant` named. `Mountain.landslide` is the canonical case: a `NetBool(DaysPlayed < 5)`
    /// over (50,4)-(52,8) that no entity query can see and that reports as `location_constraint`.
    /// </para>
    /// <para>
    /// The second answer is chosen by whether the flood found a tile, NOT by whether `FormatReachableHint` rendered an empty
    /// string: it renders `closest=none` for the no-tile case, so a test on its length made the `blocked_by` half
    /// unreachable and every enclosed target reached its node's ledger as `closest=none` - the verdict without the blocker.
    /// </para>
    /// </summary>
    internal static string RefusalHint(Point? closest, Vector2 targetTile, string blockedBy) =>
        closest is Point ? FormatReachableHint(closest, new Point((int)targetTile.X, (int)targetTile.Y)) : $"no_route;blocked_by={blockedBy}";

    internal static string FormatReachableHint(Point? closest, Point target)
    {
        if (closest is not Point tile)
            return "closest=none";
        int distance = Math.Max(Math.Abs(tile.X - target.X), Math.Abs(tile.Y - target.Y));
        return $"closest={tile.X},{tile.Y};closest_distance={distance}";
    }

    /// <summary>
    /// What stands on one tile, in the order the ENGINE asks it, as the layer `blocked_by` names.
    ///
    /// <para>
    /// The order is the point, not the detail. `GameLocation.isTilePassable` (GameLocation.cs:2898) reads the Back tile,
    /// then the Buildings tile; a location that blocks more than tiles overrides `isCollidingPosition` (Mountain.cs:352 for
    /// `landslide` and `railroadAreaBlocked`). This method used to enumerate ENTITIES only - objects, terrain features,
    /// clumps, large features, buildings - so a constraint that is none of those reported `none`.
    /// </para>
    /// <para>
    /// Measured 2026-11-01 (`round23`): 25 `no_native_path` refusals in Mountain, every one carrying `blocked_by=none`,
    /// while the companion re-aimed at nine coordinates. The mine entrance is behind `landslide`, which is
    /// `DaysPlayed &lt; 5` (Mountain.cs:34) over tiles (50,4)-(52,8) (Mountain.cs:36). It is a NetBool, not an object, so
    /// enumerating entity types could never name it.
    /// </para>
    /// <para>
    /// The extra collections are why it is layered at all: a live refusal reported `blocked_by=none` for tiles the planner
    /// refuses, which reads as "nothing is in the way" about a wall. Resource clumps, large terrain features and buildings
    /// live in their own collections, so asking only the first two answered `none` for a real obstacle. Furniture lives in
    /// its own collection too (`GameLocation.furniture`), which is why a sofa used to read as empty floor.
    /// </para>
    /// <para>
    /// This reports the LAYER that refuses, not the field that makes the layer refuse. `location_constraint` says the map
    /// itself is blocking, which is the distinction the caller needs: "you aimed wrong" versus "this map will not let you
    /// through right now". Naming `landslide` specifically would require reading a private `NetBool`, and that is a separate
    /// decision - this answers the question without it.
    /// </para>
    /// </summary>
    internal static RefusalLayerToken DescribeTargetOccupant(GameLocation location, Vector2 tile, Farmer? player = null)
    {
        Point point = new((int)tile.X, (int)tile.Y);
        RefusalLayerToken tileLayer = DescribeTileLayer(location, point);
        if (tileLayer.Refused)
            return tileLayer;
        RefusalLayerToken constraint = DescribeLocationConstraint(location, tile, player);
        if (constraint.Refused)
            return constraint;
        RefusalLayerToken occupying = RefusalProbe.ObjectOn(location, tile);
        if (occupying.Refused)
            return occupying;
        return DescribeFeatureLayer(location, tile);
    }

    /// <summary>
    /// The same world question WITHOUT the object layer, for a caller that asks about objects at its own point in the
    /// order (<see cref="RefusalProbe"/>): one reading of a tile's object, composed where each caller needs it.
    /// </summary>
    internal static RefusalLayerToken DescribeTerrainLayer(GameLocation location, Vector2 tile, Farmer? player = null)
    {
        Point point = new((int)tile.X, (int)tile.Y);
        RefusalLayerToken tileLayer = DescribeTileLayer(location, point);
        if (tileLayer.Refused)
            return tileLayer;
        RefusalLayerToken constraint = DescribeLocationConstraint(location, tile, player);
        if (constraint.Refused)
            return constraint;
        return DescribeFeatureLayer(location, tile);
    }

    /// <summary>The engine's own two tile tests, in its own order. Asking `isTilePassable` would collapse them.</summary>
    private static RefusalLayerToken DescribeTileLayer(GameLocation location, Point point)
    {
        xTile.Tiles.Tile? backTile = location.map?.GetLayer("Back")?.Tiles[point.X, point.Y];
        if (backTile is not null && backTile.TileIndexProperties.ContainsKey("Passable"))
            return new RefusalLayerToken(RefusalLayerKind.BackTile, $"Passable@{point.X},{point.Y}");

        xTile.Tiles.Tile? buildingTile = location.map?.GetLayer("Buildings")?.Tiles[point.X, point.Y];
        if (buildingTile is not null
            && !buildingTile.TileIndexProperties.ContainsKey("Shadow")
            && !buildingTile.TileIndexProperties.ContainsKey("Passable"))
            return new RefusalLayerToken(RefusalLayerKind.BuildingsTile, $"blocked@{point.X},{point.Y}");
        return RefusalLayerToken.None;
    }

    /// <summary>
    /// A location-level constraint is invisible to every entity query: it is a rectangle test inside a virtual the
    /// location overrides (Mountain's `landslide`), so it is probed the way a walking character would, over the tile's
    /// own step box. `blocked` is the relation word rather than a bare position: the field says WHICH relation failed.
    ///
    /// <para>
    /// The box is the PLANNER's own (<see cref="StepBox"/>), because a 64x64 square at `tile * 64` reaches the first
    /// pixel column of the tile's neighbour and so declares a constraint on behalf of a map that never made one.
    /// And a step the NAMED layers already explain is not this layer's to claim: a building footprint, a clump,
    /// furniture or an object refuses the same box, and answering `location_constraint` for it would hide the thing the
    /// caller can walk around or clear behind a verdict with no countermeasure.
    /// </para>
    /// </summary>
    private static RefusalLayerToken DescribeLocationConstraint(GameLocation location, Vector2 tile, Farmer? player)
    {
        if (player is null)
            return RefusalLayerToken.None;
        if (!location.isCollidingPosition(
            StepBox(tile), Game1.viewport, isFarmer: true, damagesFarmer: 0, glider: false, player))
            return RefusalLayerToken.None;
        // A terrain feature alone does not stop a body - grass, tilled soil and crops are where the scythe and the hoe
        // are meant to reach - so only the occupying members of the feature layer decline this one.
        RefusalLayerToken feature = DescribeFeatureLayer(location, tile);
        if (RefusalProbe.ObjectOn(location, tile).Refused
            || (feature.Refused && feature.Layer != RefusalLayerKind.Terrain))
            return RefusalLayerToken.None;
        Point point = new((int)tile.X, (int)tile.Y);
        return new RefusalLayerToken(RefusalLayerKind.LocationConstraint, $"blocked@{point.X},{point.Y}");
    }

    /// <summary>
    /// The blocking collections that are neither `objects` nor map tiles: a terrain feature, a resource clump, a large
    /// terrain feature's bounding box, or a building footprint.
    /// </summary>
    private static RefusalLayerToken DescribeFeatureLayer(GameLocation location, Vector2 tile)
    {
        Point point = new((int)tile.X, (int)tile.Y);
        if (location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature) && feature is not null)
            return new RefusalLayerToken(RefusalLayerKind.Terrain, $"{feature.GetType().Name}@{point.X},{point.Y}");
        foreach (StardewValley.TerrainFeatures.ResourceClump clump in location.resourceClumps)
        {
            if (clump.occupiesTile(point.X, point.Y))
                return new RefusalLayerToken(RefusalLayerKind.Clump, $"{clump.GetType().Name}@{point.X},{point.Y}");
        }
        foreach (StardewValley.TerrainFeatures.LargeTerrainFeature large in location.largeTerrainFeatures)
        {
            // Large terrain features have a bounding box, not an occupancy query; the tile centre is the honest test.
            if (large.getBoundingBox().Contains(point.X * 64 + 32, point.Y * 64 + 32))
                return new RefusalLayerToken(RefusalLayerKind.Large, $"{large.GetType().Name}@{point.X},{point.Y}");
        }
        foreach (StardewValley.Buildings.Building building in location.buildings)
        {
            if (building.occupiesTile(tile, applyTilePropertyRadius: false))
                return new RefusalLayerToken(RefusalLayerKind.Building, $"{building.buildingType.Value}@{point.X},{point.Y}");
        }
        return RefusalLayerToken.None;
    }

    /// <summary>
    /// Whether a published action exists to clear this occupant, so a refusal can say "the wall is a twig" instead of
    /// only "blocked". Delegates to the native predicates the clearing actions themselves use, so the two cannot
    /// disagree: twig litter (axe), breakable stone (pickaxe), weeds (scythe).
    /// </summary>
    internal static bool IsRemovableLitter(StardewValley.Object item) =>
        item is not null
        && (NativeItemPredicates.IsTwigLitter(item) || NativeItemPredicates.IsBreakableStone(item) || item.IsWeeds());

    /// <summary>
    /// One approach entry, as text. Split out so the four shapes are testable without a live location.
    /// </summary>
    internal static string FormatApproachEntry(string direction, bool walkable, string occupant, bool removable)
    {
        if (walkable)
            return $"{direction}:open";
        if (occupant == "none")
            return $"{direction}:blocked";
        return removable ? $"{direction}:{occupant}[removable]" : $"{direction}:{occupant}";
    }

    /// <summary>What one cardinal ring tile is, to the one predicate that decides the ring.</summary>
    internal enum CardinalRingKind
    {
        /// <summary>The planner admits it AND it is inside the actor's own walkable component.</summary>
        Open,

        /// <summary>Free ground the planner admits, walled off from where the actor stands.</summary>
        Unreachable,

        /// <summary>Off the map, or something the planner will not step onto.</summary>
        Blocked,
    }

    /// <summary>One cardinal ring tile: its direction, its tile, and the two texts the receipts use.</summary>
    internal sealed record CardinalRingEntry(
        string Direction,
        Point Tile,
        CardinalRingKind Kind,
        string Text,
        string Blocker);

    /// <summary>
    /// The four cardinal approaches to one goal, all answered by the ONE predicate the walk enforces, plus the tile
    /// the body approaches from - or none, with the culprit named.
    /// </summary>
    internal sealed record CardinalRing(IReadOnlyList<CardinalRingEntry> Entries, Vector2? Approach, string BlockedBy)
    {
        /// <summary>The four entries as one bounded token, in the declared cardinal order.</summary>
        internal string Evidence => string.Join(",", this.Entries.Select(entry => entry.Text));
    }

    /// <summary>
    /// Whether the actor may stand on <paramref name="tile"/> AND walk there from where it stands: the one answer
    /// both the refusal that DESCRIBES an approach and the leg that WALKS one are built from.
    ///
    /// <para>
    /// They used to be two answers, and a companion spent three map crossings and 40 minutes on the difference.
    /// The refusal described the ring from the planner's LOCAL step test alone, so a free tile walled off from the
    /// actor read `open`; the Navigation approach leg asked a private third predicate - `isTilePassable` plus the
    /// `CollisionMask.All` occupant mask - and answered `approach=unavailable` naming no tile at all. Measured in
    /// one session: `no_native_path` x3 with `approaches=east:open,south:open` beside `route_exists_cardinal=false`
    /// for ring tiles six tiles outside the actor's component, then `navigation_approach_unavailable` x2 with
    /// `phase=approved;approach=unavailable` and nothing else. `All` includes `TerrainFeatures`, the collection
    /// grass and tilled soil live in, so that leg also refused the ordinary farm ground the agent had just been
    /// told to stand on (`stand_at=40,10`).
    /// </para>
    ///
    /// <para>
    /// What `open` therefore means here, and nowhere else: the planner would admit the tile
    /// (<see cref="IsStandableTile"/>, which composes <see cref="IsWalkableTile"/>) and the tile is inside the
    /// actor's own walkable component. A tile that passes the first and fails the second is `unreachable` - the
    /// answer the ring could not give before, and the one that ends a hunt for a door that is not connected.
    /// </para>
    ///
    /// <para>
    /// Bounded by construction: the component flood carries the same <see cref="ReachabilityProbeLimit"/> as every
    /// other probe in this file, and a component that exceeded it is left UNDECIDED (every free tile counts as
    /// reachable) so the native planner rules - an exhausted probe must never be read as "nothing is reachable".
    /// </para>
    /// <para>
    /// <paramref name="isStandable"/> is the caller's own answer to "may a body stand here", when it has one that is
    /// narrower than <see cref="IsStandableTile"/> (the tool approach also refuses a warp buffer). A ring asked with a
    /// different predicate than the sentence beside it would report `open` for a tile that sentence had just counted as
    /// unstandable, which is two answers to one question.
    /// </para>
    /// </summary>
    internal static CardinalRing RingAroundGoal(
        Farmer? actor,
        GameLocation? location,
        Vector2 goalTile,
        Func<Vector2, bool>? isStandable = null)
    {
        Func<Vector2, bool>? reachable = actor is null || location is null
            ? null
            : BuildWalkableComponent(location, actor);
        Func<Vector2, bool> standable = isStandable ?? (tile => location is not null && IsStandableTile(location, actor, tile));
        var entries = new List<CardinalRingEntry>(CardinalOffsets.Length);
        foreach (Point offset in CardinalOffsets)
        {
            Point tile = new((int)goalTile.X + offset.X, (int)goalTile.Y + offset.Y);
            Vector2 tileAsVector = new(tile.X, tile.Y);
            string direction = RingDirection(offset);
            if (location is null || !location.isTileOnMap(tileAsVector))
            {
                entries.Add(new CardinalRingEntry(
                    direction, tile, CardinalRingKind.Blocked, $"{direction}:off_map", $"off_map@{tile.X},{tile.Y}"));
                continue;
            }
            if (!standable(tileAsVector))
            {
                string occupant = DescribeTargetOccupant(location, tileAsVector, actor).Format();
                bool removable = location.objects.TryGetValue(tileAsVector, out StardewValley.Object? blockedItem)
                    && IsRemovableLitter(blockedItem);
                // ONE name for the thing in the way, used by the ring entry AND by the refusal's
                // `approach_blocked_by:`: the clearing vocabulary where it applies, the engine's layer token
                // otherwise. A second spelling here is a second fact for a reader to reconcile.
                string name = ClearableRingName(location, actor, tileAsVector) ?? occupant;
                entries.Add(new CardinalRingEntry(
                    direction,
                    tile,
                    CardinalRingKind.Blocked,
                    FormatApproachEntry(direction, walkable: false, name, removable),
                    name == "none" ? $"blocked@{tile.X},{tile.Y}" : name));
                continue;
            }
            if (reachable is not null && !reachable(tileAsVector))
            {
                entries.Add(new CardinalRingEntry(
                    direction,
                    tile,
                    CardinalRingKind.Unreachable,
                    $"{direction}:unreachable",
                    $"unreachable_ground@{tile.X},{tile.Y}"));
                continue;
            }
            entries.Add(new CardinalRingEntry(
                direction, tile, CardinalRingKind.Open, $"{direction}:open", string.Empty));
        }

        CardinalRingEntry? approach = actor is null
            ? null
            : NearestOpenEntry(entries, new Point((int)actor.Tile.X, (int)actor.Tile.Y));
        Vector2? approachTile = approach is null ? null : new Vector2(approach.Tile.X, approach.Tile.Y);
        return new CardinalRing(entries, approachTile, NamedBlocker(entries));
    }

    /// <summary>
    /// The four cardinal approaches to a tile, each with its blocker, as one bounded token - the token
    /// <see cref="RingAroundGoal"/> decides, so the ring an Agent is told about and the ring the walk enforces cannot
    /// describe different worlds.
    ///
    /// <para>
    /// A refusal that says `target_standable=true; target_walkable=true; blocked_by=none` next to
    /// `target_enclosed=true` reads as a contradiction: the tile is free, yet nothing can walk to it. Both
    /// statements are true, and what the receipt was missing is the middle - each approach can be individually
    /// walled, which leaves a free tile enclosed by its neighbours. This names the wall instead of leaving it to be
    /// guessed, and it names a free-but-walled tile `unreachable` where it used to say `open`.
    /// </para>
    /// </summary>
    internal static string DescribeTargetApproaches(
        Farmer actor,
        GameLocation location,
        Vector2 tile,
        Func<Vector2, bool>? isStandable = null) =>
        RingAroundGoal(actor, location, tile, isStandable).Evidence;

    private static string RingDirection(Point offset) => offset switch
    {
        { X: 0, Y: -1 } => "north",
        { X: 0, Y: 1 } => "south",
        { X: -1, Y: 0 } => "west",
        _ => "east",
    };

    /// <summary>
    /// What stands on a ring tile, in the clearing vocabulary, when it is something a priced tool can remove
    /// (`rock@9,2`, `weed@40,9`) - the word the same receipt's `clear_to_reach` already publishes, and the word an
    /// Agent can act on with the tool it is holding. Null when the occupant is not a clearable object, so the caller
    /// keeps the engine's own layer token (`clump:ResourceClump@x,y`, `buildings_tile:blocked@x,y`), which the
    /// `blocked_by` field has published since the layer probe was written.
    /// </summary>
    internal static string? ClearableRingName(GameLocation location, Farmer? actor, Vector2 tile)
    {
        if (actor is null)
            return null;
        return OccupantAt(location, actor, tile) is { ClearCost: not null } occupancy
            ? $"{occupancy.Kind}@{(int)tile.X},{(int)tile.Y}"
            : null;
    }

    /// <summary>
    /// The open ring tile nearest the actor, ties kept in the declared cardinal order - the rule every other
    /// approach leg uses (<see cref="Core.ApproachTileSelector"/>), so one world state always yields one tile.
    /// </summary>
    private static CardinalRingEntry? NearestOpenEntry(IReadOnlyList<CardinalRingEntry> entries, Point actor)
    {
        CardinalRingEntry? best = null;
        int bestDistance = int.MaxValue;
        foreach (CardinalRingEntry entry in entries)
        {
            if (entry.Kind != CardinalRingKind.Open)
                continue;
            int distance = Math.Abs(entry.Tile.X - actor.X) + Math.Abs(entry.Tile.Y - actor.Y);
            if (distance >= bestDistance)
                continue;
            best = entry;
            bestDistance = distance;
        }
        return best;
    }

    /// <summary>
    /// The culprit a ring with no open tile reports: free-but-walled ground first, because "that tile is free and you
    /// cannot walk to it" is the fact this ring exists to add and the one the receipt could not say before; then a
    /// named obstacle (already published by `blocked_by=` and `clear_to_reach=` in the same receipt); then the map
    /// edge. One rule, so nothing here can grow an exception list.
    /// </summary>
    private static string NamedBlocker(IReadOnlyList<CardinalRingEntry> entries)
    {
        foreach (CardinalRingEntry entry in entries)
        {
            if (entry.Kind == CardinalRingKind.Unreachable)
                return entry.Blocker;
        }
        foreach (CardinalRingEntry entry in entries)
        {
            if (entry.Kind == CardinalRingKind.Blocked
                && !entry.Blocker.StartsWith("off_map@", StringComparison.Ordinal))
                return entry.Blocker;
        }
        return entries[0].Blocker;
    }

    /// <summary>
    /// What would open the way to the target, and what it costs - or the empty string.
    ///
    /// The engine treats every occupied tile the same: collision, therefore excluded. It cannot say
    /// whether the thing in the way is a rock that one swing removes, so its refusal leaves an agent
    /// aiming at neighbouring tiles. This asks the question the engine cannot: with the clearable tiles
    /// priced, what is the cheapest set whose removal opens a route?
    ///
    /// Empty has two meanings, both honest: the target is already reachable (no clears needed), or no
    /// number of clears opens the way (a wall is not a bill). An agent reading the refusal does not need
    /// the difference spelled out - the absence of a promise is the answer in both cases.
    ///
    /// It resolves the plan through the SAME <see cref="ResolveClearingToReach"/> the walk uses, so the step an
    /// Agent is told about and the step the Mod walks cannot describe different worlds. It describes and nothing
    /// more: starting a walk from here would put a mutation in a query.
    /// </summary>
    private static string DescribeClearToReach(Farmer localPlayer, LocalMoveSpec specification)
    {
        try
        {
            Vector2 target = specification.TargetTile;
            if (ResolveClearingToReach(localPlayer, target) is not { } resolution)
                return string.Empty;

            ClearingPlan plan = resolution.Plan;
            FirstClearStep step = resolution.Step;

            // The plan's price, and the STEP it implies. The tile list alone left a live Agent re-aiming at
            // neighbours: a rock is removed from an adjacent tile, and that tile is often not where the actor is.
            var described = new List<string>(2);
            if (ClearingEvidence.Describe(plan, tile => resolution.KindAt(tile)) is { } price) described.Add(price);
            if (ClearingEvidence.DescribeFirstStep(step, tile => resolution.KindAt(tile)) is { } firstStep)
            {
                described.Add(firstStep);
            }
            else if (plan.Reachable)
            {
                // The plan opens the way yet no reachable tile brings the blocker within reach. Naming the
                // reason is the difference between "keep trying" and "this cannot be done in one step".
                described.Add($"clear_step_unavailable={step.ReasonCode}");
            }

            return described.Count == 0 ? string.Empty : ";" + string.Join(";", described);
        }
        catch
        {
            // Derived evidence must never break the refusal it decorates: the native failure and the
            // facts already gathered above remain authoritative.
            return string.Empty;
        }
    }

    /// <summary>
    /// The tiles an actor could pay to clear, with the price, and the kind behind each price.
    ///
    /// One walk over the occupancy containers the engine uses - resourceClumps, objects, terrainFeatures,
    /// largeTerrainFeatures - in that order, because a tile holds at most one of them. Occupants the cost table does
    /// not price (a bush, water, a building, the map edge) are absent by construction: this is the PRICED reading.
    /// </summary>
    private static void CollectClearableTiles(
        StardewValley.GameLocation location,
        Farmer localPlayer,
        Dictionary<Point, int> clearable,
        Dictionary<Point, string> kinds)
    {
        var layer = location.map.Layers[0];
        for (int x = 0; x < layer.LayerWidth; x += 1)
        {
            for (int y = 0; y < layer.LayerHeight; y += 1)
            {
                if (OccupantAt(location, localPlayer, new Vector2(x, y)) is not { } occupancy)
                    continue;
                if (!(occupancy.ClearCost is int price))
                    continue;
                clearable[new Point(x, y)] = price;
                kinds[new Point(x, y)] = occupancy.Kind;
            }
        }
    }

    /// <summary>
    /// One tile's occupant as the engine names it, with what removing it would cost THIS actor's tools and skills -
    /// or null when the tile holds nothing this walk can name.
    ///
    /// <para>
    /// THE one walk over the engine's occupancy containers, read by four callers that must not drift: the clearing
    /// plan behind <c>clear_to_reach</c>, the name a refusal gives the thing in the way (<c>blocker_occupant=bush</c>),
    /// the frontier read that finds that thing without a clearing plan at all, and the rim of an enclosed actor's own
    /// component (`ExecutionManager.DescribeFrontierClearance`, which needs the occupant and which declarations clear
    /// it). A second walker here is how the tile that is priced and the tile that is named become two different tiles.
    /// </para>
    /// <para>
    /// <see cref="Occupancy.ClearCost"/> is null for an occupant that can be NAMED but not cleared - a bush is the one
    /// that matters, because a bush in a corridor is a route no published action opens and the caller has to be told
    /// so in words (`no_published_action_clears:bush:engine_keeps_it_standing`) rather than told the tile is a wall.
    /// Naming it costs nothing and pricing it would be a lie, so the two readings are separate fields of one answer.
    /// </para>
    /// </summary>
    internal static Occupancy? OccupantAt(
        StardewValley.GameLocation location,
        Farmer localPlayer,
        Vector2 tile)
    {
        int toolPower = localPlayer.CurrentTool is { } heldTool ? heldTool.UpgradeLevel + 1 : 1;
        int mining = localPlayer.MiningLevel;
        int foraging = localPlayer.ForagingLevel;
        int farming = localPlayer.FarmingLevel;

        foreach (StardewValley.TerrainFeatures.ResourceClump clump in location.resourceClumps)
        {
            if (clump.Tile != tile)
                continue;
            // A clump the native tool table does not price stays an UNNAMED wall (the corridor's own walls are built
            // from one), so the frontier read cannot mistake a wall for the thing in the way.
            if (!ExecutionManager.TryGetDebrisToolRequirement(clump, out string toolKind, out _))
                return null;
            if (ClearableKind.Map("resourceClump", toolKind) is not { } clumpKind)
                return null;
            if (Price(clumpKind, toolPower, clumpKind == "stump" ? foraging : mining) is not { } clumpPrice)
                return null;
            return new Occupancy(clumpKind, clumpPrice.Cost, TileOccupancy.ClumpOccupant(clump.parentSheetIndex.Value), clumpPrice.Stamina);
        }

        if (location.objects.TryGetValue(tile, out StardewValley.Object? item) && item is not null)
        {
            // The object's own word for itself - the SAME one the rectangle publishes and the same predicates each
            // clearing action's preflight asks (`TileOccupancy.ObjectKind`). A second test here would let the priced tile
            // and the named tile be different tiles, which is what `(O)2`-only used to do to twig litter.
            string detail = TileOccupancy.ObjectKind(item);
            if (ClearableKind.Map("object", detail) is not { } objectKind)
                return null;
            // A twig is AXE work (`Object.cs:1182`) and an axe charges foraging, the way a clump's stump does.
            if (Price(objectKind, toolPower, detail == TileOccupantKind.Twig ? foraging : mining) is not { } objectPrice)
                return null;
            return new Occupancy(objectKind, objectPrice.Cost, detail, objectPrice.Stamina);
        }

        if (location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
            && feature is not null)
        {
            string detail = feature switch
            {
                StardewValley.TerrainFeatures.Grass => "grass",
                StardewValley.TerrainFeatures.HoeDirt dirt when dirt.crop is not null => "crop",
                _ => string.Empty,
            };
            if (ClearableKind.Map("terrain", detail) is not { } terrainKind)
                return null;
            if (Price(terrainKind, toolPower, farming) is not { } terrainPrice)
                return null;
            return new Occupancy(terrainKind, terrainPrice.Cost, detail, terrainPrice.Stamina);
        }

        // LAST, because a bush is the one occupant that blocks a body and that no priced tool removes. It is named so
        // the refusal can say `no_published_action_clears:bush`, and left unpriced so the clearing search still treats
        // it as the wall it is. `largeTerrainFeatures` is the only collection a bush is ever stored in
        // (GameLocation.cs:286; a saved farm never puts one in `terrainFeatures`), and the point test is the one the
        // ENGINE's own collision uses for these features (`isCollidingPosition` intersects the bounding box,
        // GameLocation.cs:2637-2648) as well as the one `DescribeFeatureLayer` uses - so "named here" and "blocks the
        // body" are the same question, not two.
        foreach (StardewValley.TerrainFeatures.LargeTerrainFeature large in location.largeTerrainFeatures)
        {
            if (!large.getBoundingBox().Contains((int)tile.X * 64 + 32, (int)tile.Y * 64 + 32))
                continue;
            if (large is StardewValley.TerrainFeatures.Bush)
                return new Occupancy("bush", null, "bush", null);
        }

        return null;
    }

    /// <summary>
    /// The engine's stamina charge for one swing at <paramref name="kind"/>, and the search's own unit for it, or null
    /// when the kind cannot be cleared at all. One function so the two readings cannot drift: the unit IS the charge
    /// plus the table's allowance.
    /// </summary>
    private static (int Stamina, int Cost)? Price(string kind, int toolPower, int skillLevel) =>
        ClearCostTable.Stamina(kind, toolPower, skillLevel, efficient: false) is int stamina
        && ClearCostTable.Cost(kind, toolPower, skillLevel, efficient: false) is int cost
            ? (stamina, cost)
            : null;

    /// <summary>
    /// One tile's named occupant, its clearing price when it has one, and what removing it costs the body in stamina.
    ///
    /// <para>
    /// <c>ClearCost</c> is the search unit and <c>StaminaCharge</c> is the engine's own charge for one swing; both are
    /// null for an occupant nothing published removes.
    /// </para>
    /// <para>
    /// There is no `TargetFamily` here. Which snapshot family publishes an occupant is declared by the actions whose
    /// `Clears` names it (<see cref="FarmhandClearingOffer.TargetFamily"/>), and a copy beside this walk was a second
    /// spelling that went stale: it listed five families while the catalogue had a sixth (`worldObjectTargets`, for the
    /// twig `remove_placed_item` clears), so a twig blocker answered as if no target existed.
    /// </para>
    /// </summary>
    internal sealed record Occupancy(string Kind, int? ClearCost, string Occupant, int? StaminaCharge);

    private static ReachabilityVerdict? AssessNativeReachability(Farmer localPlayer, LocalMoveSpec specification, bool findClosestReachable = false)
    {
        GameLocation? location = localPlayer.currentLocation;
        if (location is null)
            return null;

        try
        {
            var layer = location.map.Layers[0];
            Point actorTile = new((int)localPlayer.Tile.X, (int)localPlayer.Tile.Y);
            Point targetTile = new((int)specification.TargetTile.X, (int)specification.TargetTile.Y);

            return AssessReachability(
                actorTile,
                targetTile,
                tile => tile.X >= 0
                    && tile.Y >= 0
                    && tile.X < layer.LayerWidth
                    && tile.Y < layer.LayerHeight
                    && !location.isCollidingPosition(
                        new Microsoft.Xna.Framework.Rectangle(tile.X * 64 + 1, tile.Y * 64 + 1, 62, 62),
                        Game1.viewport,
                        localPlayer is Farmer,
                        0,
                        glider: false,
                        localPlayer,
                        pathfinding: true,
                        skipCollisionEffects: true),
                ReachabilityProbeLimit,
                findClosestReachable,
                // THE WALK'S OWN ARRIVAL RULE. The probe exists to answer "can this walk arrive", so it has to be asked
                // with the same geometry the engine's goal predicate uses - otherwise it vetoes a walk the engine would
                // have completed on a diagonal neighbour the request allows (`native=not_attempted` before the engine is
                // ever asked), and it does so silently, because a veto looks exactly like an unreachable world.
                specification.AllowAdjacentArrival);
        }
        catch
        {
            // A missing/invalid live map cannot support a derived claim. The
            // native failure and its existing evidence remain authoritative.
            return null;
        }
    }

    /// <summary>
    /// The actor's walkable component as a membership predicate for one tile, or <c>null</c> when the probe
    /// exceeded its budget and therefore makes no claim.
    ///
    /// <para>
    /// This is the reachability half of choosing where to stand, kept separate from standability because they
    /// are different questions: a tile can be free and still be walled off from where the actor is. Null means
    /// "undecided" and the caller must let the native planner decide rather than treat it as "nothing is
    /// reachable", which would refuse a walk the engine would have made.
    /// </para>
    /// </summary>
    internal static Func<Vector2, bool>? BuildWalkableComponent(GameLocation? location, Farmer? actor, int budget = ReachabilityProbeLimit)
    {
        if (actor is null || location?.map is null || location.map.Layers.Count == 0)
            return null;
        var layer = location.map.Layers[0];
        HashSet<Point>? reachable = ReachableTiles(
            new Point((int)actor.Tile.X, (int)actor.Tile.Y),
            budget,
            tile => tile.X >= 0
                && tile.Y >= 0
                && tile.X < layer.LayerWidth
                && tile.Y < layer.LayerHeight
                && IsWalkableTile(location, actor, new Vector2(tile.X, tile.Y)));
        if (reachable is null)
            return null;
        return tile => reachable.Contains(new Point((int)tile.X, (int)tile.Y));
    }

    /// <summary>
    /// A lookup for one observation: "can the actor act on this tile?" — it can stand on it or beside it, which is
    /// what every interaction's reach means. Returns <c>null</c> when the component exceeded the probe budget, so the
    /// observation publishes undecided rather than guessing.
    /// </summary>
    internal static Func<int, int, bool>? BuildSceneActionability(Farmer? actor, int budget = ReachabilityProbeLimit)
    {
        // `actor` is NULLABLE on purpose: the observation path is also reachable before a player exists (rejected
        // generations, tests that run no game at all), and the suite caught this as 18 NullReferenceExceptions from
        // `TryObserveScene`. A probe helper must answer "no claim" rather than throw, on every headless path.
        if (actor is null)
            return null;
        GameLocation? location = actor.currentLocation;
        if (location is null)
            return null;
        // A location without a usable map (headless, or mid-load) has no walkable component to report. "No claim"
        // is the honest answer, and the live probe fails closed the same way -- the integration suite caught this
        // as a NullReferenceException from a test that runs no game at all.
        if (location.map is null || location.map.Layers.Count == 0)
            return null;
        var layer = location.map.Layers[0];
        HashSet<Point>? reachable = ReachableTiles(
            new Point((int)actor.Tile.X, (int)actor.Tile.Y),
            budget,
            tile => tile.X >= 0
                && tile.Y >= 0
                && tile.X < layer.LayerWidth
                && tile.Y < layer.LayerHeight
                && IsWalkableTile(location, actor, new Vector2(tile.X, tile.Y)));
        if (reachable is null)
            return null;
        return (x, y) =>
        {
            Point tile = new(x, y);
            if (reachable.Contains(tile))
                return true;
            foreach (Point offset in CardinalOffsets)
            {
                if (reachable.Contains(new Point(tile.X + offset.X, tile.Y + offset.Y)))
                    return true;
            }
            return false;
        };
    }

    /// <summary>
    /// Whether a CARDINAL walk can satisfy the request a verdict was asked about: the body ends ON the target tile when
    /// the request wants the exact tile, or on any Chebyshev-1 tile of it when the request allows an adjacent arrival.
    ///
    /// <para>
    /// ONE derivation, because the receipt used to answer this twice and both answers were wrong in one world. The flood
    /// branch published a HARDCODED <c>route_exists_cardinal=false</c>: the value happened to match its only branch, so
    /// it read as a measurement while nothing computed it. The engine branch published
    /// <see cref="ReachabilityVerdict.ComponentContainsTarget"/>, which is the narrower question - can the body STEP
    /// ONTO the tile. Measured `round78`, over a target whose walkable neighbour WAS reached and whose own tile was not:
    /// the receipt said <c>route_exists_cardinal=false</c> about a road that exists.
    /// </para>
    /// <para>
    /// <see cref="ReachabilityVerdict.ComponentContainsTarget"/> stays the first disjunct and is not a copy of it: the
    /// flood's ring is <see cref="IsArrivalDelta"/>'s set, which for an exact request is the target tile alone.
    /// </para>
    /// </summary>
    internal static bool RouteExists(ReachabilityVerdict verdict, bool allowAdjacentArrival) =>
        verdict.ComponentContainsTarget || (allowAdjacentArrival && !verdict.TargetEnclosed);

    /// <summary>
    /// The TWO route claims a receipt publishes, derived from one verdict: whether a cardinal walk satisfies the
    /// request, and whether the target's arrival ring is outside the actor's component.
    ///
    /// <para>
    /// The pair is what tells the two refused worlds apart on the wire. <c>route_exists_cardinal=false</c> beside
    /// <c>target_enclosed=true</c> says the walk reaches the target's neighbourhood nowhere - no route at all. The same
    /// <c>false</c> beside <c>target_enclosed=false</c> says the road is there and the TILE refuses: the body can stand
    /// beside it, and an exact-arrival request cannot be served by any route. Before this one branch published a literal
    /// and the other published the narrower question, so the second world was reported as the first.
    /// </para>
    /// </summary>
    internal static string DescribeRouteClaim(ReachabilityVerdict verdict, bool allowAdjacentArrival) =>
        $"route_exists_cardinal={(RouteExists(verdict, allowAdjacentArrival) ? "true" : "false")};"
        + $"target_enclosed={verdict.TargetEnclosed.ToString().ToLowerInvariant()}";

    /// <summary>
    /// The tile a refusal tells the caller to WALK to, or <c>progress=none</c> when no tile the walk reaches opens the
    /// route it asked for.
    ///
    /// <para>
    /// The flood's nearest reachable tile is a measurement, and it was published as <c>closest=</c> whatever the verdict
    /// said - so a refusal about a route that does not exist named a wilderness tile as the place to go. Measured
    /// `round78`: <c>closest=34,6;closest_distance=6</c> beside <c>stand_at=40,10</c>, and following the closer-looking one
    /// cost 46 steps to a dead end. The measurement keeps its own name (<c>reachable=</c>, from the detour facts); what a
    /// caller reads here is a STEP, so it is published only when the verdict says a walk can arrive from it.
    /// </para>
    /// </summary>
    internal static string DescribeWalkTarget(ReachabilityVerdict verdict, Vector2 targetTile, bool allowAdjacentArrival) =>
        RouteExists(verdict, allowAdjacentArrival)
            ? FormatReachableHint(verdict.ClosestToTarget, new Point((int)targetTile.X, (int)targetTile.Y))
            : ClearingEvidence.NoProgress;

    /// <summary>
    /// The one productive step towards a goal the native finder refused: the actor's own
    /// traversable neighbour that most reduces the distance, so the step is always adjacent (and
    /// therefore always routable) and needs no component enumeration. The caller stages only when
    /// the probe says the target is actually reachable, so this is "get closer and re-plan",
    /// never "wander at a severed target".
    /// </summary>
    /// <summary>
    /// The choice itself, with the world reduced to a walkability predicate, so it can be tested without a live
    /// location: a CARDINAL (Manhattan-1) step that strictly reduces the Chebyshev distance to the target.
    /// </summary>
    internal static bool TrySelectCardinalStagingStep(Point actor, Point target, Func<Point, bool> isWalkable, out Point staging)
    {
        staging = default;
        int bestDistance = ChebyshevDistance(actor, target);
        bool found = false;
        foreach (Point offset in CardinalOffsets)
        {
            Point candidate = new(actor.X + offset.X, actor.Y + offset.Y);
            if (candidate == target)
                continue;
            int distance = ChebyshevDistance(candidate, target);
            if (distance >= bestDistance || !isWalkable(candidate))
                continue;
            staging = candidate;
            bestDistance = distance;
            found = true;
        }
        return found;
    }

    internal static bool TryFindStagingStep(Farmer localPlayer, Vector2 targetTile, out Point staging)
    {
        staging = default;
        GameLocation? location = localPlayer.currentLocation;
        if (location is null)
            return false;

        Point actor = new((int)localPlayer.Tile.X, (int)localPlayer.Tile.Y);
        Point target = new((int)targetTile.X, (int)targetTile.Y);
        // CARDINAL (Manhattan-1) candidates only, because that is the planner's own step set
        // (`PathFindController.cs:45-51`). A cardinal neighbour that is walkable is always reachable in one
        // planner step, which is what makes the step real progress rather than a claim. The previous version
        // scanned the full eight-neighbour ring, so a diagonally-adjacent tile could be chosen by distance and
        // still be unreachable: the staged path was then a single node, the actor never left its tile, and the
        // action refused with `did_not_arrive` after promising an adjacent approach (measured live).
        return TrySelectCardinalStagingStep(
            actor,
            target,
            candidate => IsWalkableTile(location, localPlayer, new Vector2(candidate.X, candidate.Y)),
            out staging);
    }

    /// <summary>Installs a staged step and resets the per-route bookkeeping, so both staging paths share one
    /// shape and cannot drift.</summary>
    private void InstallStagedStep(LocalMoveSpec staged, PathFindController path, Farmer localPlayer, int tick)
    {
        this.active = staged;
        this.pathController = path;
        localPlayer.controller = path;
        this.lastTile = localPlayer.Tile;
        this.lastProgressTick = tick;
        this.hasEmittedStalledWaiting = false;
        this.isStallWaiting = false;
        this.stallWaitStartedTick = 0;
        this.transientSinceMs = 0;
    }

    /// <summary>
    /// Builds the next step of a walk towards <paramref name="requested"/>, or says why there is none.
    ///
    /// The step is only accepted when the native planner produces a path of MORE THAN ONE node: one node means
    /// "already standing there", which is not movement, and the earlier code accepted exactly that as a staged
    /// arrival (the actor stayed put while the receipt claimed an approach).
    /// </summary>
    private bool TryStageTowards(
        LocalMoveSpec specification,
        Vector2 requested,
        Farmer localPlayer,
        out LocalMoveSpec staged,
        out PathFindController path,
        out string evidence)
    {
        staged = specification;
        path = null!;
        if (specification.StagedSteps >= MaxStagedSteps)
        {
            evidence = $"staged_steps_exhausted={specification.StagedSteps}";
            return false;
        }
        if (!TryFindStagingStep(localPlayer, requested, out Point staging))
        {
            evidence = "no_cardinal_staging_step";
            return false;
        }

        LocalMoveSpec candidate = specification with
        {
            TargetTile = new Vector2(staging.X, staging.Y),
            AllowAdjacentArrival = true,
            RequestedTile = requested,
            StagedApproach = true,
            StagedSteps = specification.StagedSteps + 1,
        };
        PathFindController candidatePath = this.BuildNativePath(candidate, localPlayer);
        if (candidatePath.pathToEndPoint is not { Count: > 1 })
        {
            evidence = $"staged_step_not_walkable={staging.X},{staging.Y}";
            return false;
        }

        staged = candidate;
        path = candidatePath;
        evidence = $"staged_step={staging.X},{staging.Y};staged_steps={candidate.StagedSteps}"
            + $";requested={(int)requested.X},{(int)requested.Y}";
        return true;
    }

    /// <summary>
    /// Installs the next staged step when the current one has arrived somewhere the caller cannot act from.
    /// Returns false when the actor is already within reach of <paramref name="requested"/> (the walk is done),
    /// or when no further cardinal step exists.
    /// </summary>
    private bool TryAdvanceStagedApproach(
        LocalMoveSpec specification,
        Vector2 currentTile,
        Farmer localPlayer,
        int tick,
        out string evidence)
    {
        evidence = string.Empty;
        if (specification is not { StagedApproach: true, RequestedTile: Vector2 requested })
            return false;
        if (IsWithinRequestedReach(currentTile, requested))
            return false;
        if (!this.TryStageTowards(specification, requested, localPlayer, out LocalMoveSpec staged, out PathFindController path, out evidence))
            return false;

        this.active = staged;
        this.pathController = path;
        localPlayer.controller = path;
        this.lastTile = localPlayer.Tile;
        this.lastProgressTick = tick;
        this.hasEmittedStalledWaiting = false;
        this.isStallWaiting = false;
        this.stallWaitStartedTick = 0;
        this.transientSinceMs = 0;
        return true;
    }

    private static int ChebyshevDistance(Point left, Point right) =>
        Math.Max(Math.Abs(left.X - right.X), Math.Abs(left.Y - right.Y));

    /// <summary>
    /// What is standing in front of the walking body, as one bounded token: `character:&lt;name&gt;@&lt;tile&gt;`, or
    /// `unknown`.
    ///
    /// <para>
    /// It used to answer the TYPE (`Pet` / `Horse` / `Npc`), which names a class rather than a thing: a model told
    /// `stopped_by=Npc` cannot tell whether the villager in front of it will walk away or which one to ask about. The
    /// token now keeps the same `character:` vocabulary the refusal probe uses (`blocked_by=character:Haley@24,22`), so
    /// the two places that name an occupant spell it the same way and one reader handles both.
    /// </para>
    /// </summary>
    /// <summary>
    /// What stopped a walk that made no progress, as one bounded space-free token - never a bare `unknown`.
    ///
    /// <para>
    /// MEASURED 2026-11-19 (`1795084506`-`1795084512`, Mountain): two `move_to_tile` requests each stalled the full 300
    /// ticks and the refusal said `native_path_ended;stopped_by=unknown`. The thing in the way was a specific rectangle:
    /// `Mountain.railroadAreaBlocked`, the engine's own `NetBool(DaysPlayed &lt; 31)` (`Mountain.cs:32`) over tiles
    /// (8,0)-(11,4). It is neither a character nor an object, so the occupant walk below - which only ever asked
    /// `location.characters` - could never see it, and the one field whose job is to say what is in the way said that
    /// nobody knew.
    /// </para>
    /// <para>
    /// THE ORDER IS THE WALK'S ORDER. A body stands still because it cannot take its NEXT step, so the four cardinal
    /// steps are asked nearest-to-the-target first, through the same layer probe a refusal uses (`RefusalProbe`), which
    /// keeps one spelling of `character:&lt;name&gt;@&lt;tile&gt;` and one vocabulary of `clump` / `building` /
    /// `location_constraint` for both fields. A person is asked about the FACING tile first because that is the body the
    /// caller can wait out or walk around, and because the measured stall this replaced was a villager.
    /// </para>
    /// <para>
    /// THE THIRD ANSWER IS THE PROGRESSION GATE, and it is an answer rather than a shrug: a `location_constraint` is a
    /// map that will not let her through, which is `"the world will not let me yet"` and not `"I could not find out"`.
    /// <see cref="StandingLocationGate"/> names the flag that is holding it where the engine's own location type
    /// declares one, so `roadblock` reads as `location_constraint:railroadAreaBlocked@9,4`.
    /// </para>
    /// <para>
    /// WHEN NOTHING REFUSES, that is said in those words. Four open steps under a body that did not move is a different
    /// condition from a wall - the walk, not the world, ended it - and `none_of_the_four_steps_refuses` keeps it out of
    /// the bucket that means `nobody looked`.
    /// </para>
    /// </summary>
    internal static string DescribeStallBlocker(GameLocation? location, Farmer localPlayer, Vector2 target)
    {
        if (location is null)
            return "unknown:no_location";

        Point body = new((int)localPlayer.Tile.X, (int)localPlayer.Tile.Y);
        Point goal = new((int)target.X, (int)target.Y);
        try
        {
            foreach (Point step in StepsToward(body, goal))
            {
                var tile = new Vector2(step.X, step.Y);
                RefusalLayerToken layer = RefusalProbe.DescribeWorld(null, location, tile, localPlayer.Tile, localPlayer);
                if (!layer.Refused)
                    continue;
                // THE MAP'S OWN GATE IS NAMED, not just the layer: `blocked` says the map refuses and leaves the caller
                // with nothing to wait for, while the engine's flag says which gate it is.
                if (layer.Layer == RefusalLayerKind.LocationConstraint && StandingLocationGate(location) is { } gate)
                    return new RefusalLayerToken(RefusalLayerKind.LocationConstraint, $"{gate}@{step.X},{step.Y}").Format();
                return layer.Format();
            }

            return "none_of_the_four_steps_refuses";
        }
        catch (Exception error)
        {
            // A world collection can change during a game-thread lifecycle edge. The token still says WHY it could not
            // name the blocker, and names the failure rather than folding every one of them into a bare `unknown`.
            return $"unknown:world_read_failed:{error.GetType().Name}";
        }
    }

    /// <summary>
    /// The body's four cardinal steps, nearest-to-the-target first, so the first refusal the probe meets is the step the
    /// walk actually needed. Ordering is by resulting distance and then by the planner's own offset order, so the token
    /// is deterministic for one tile pair and two runs of the same stall read the same.
    ///
    /// A PERSON IS ASKED THE SAME WAY as a wall, through <see cref="RefusalProbe.CharacterOn"/> inside that probe: the
    /// earlier version asked only the tile the ACTOR WAS FACING, which answered about a direction rather than about the
    /// step the walk could not take (and read `Farmer.FacingDirection` for it).
    /// </summary>
    private static IEnumerable<Point> StepsToward(Point body, Point goal) => CardinalOffsets
        .Select(offset => new Point(body.X + offset.X, body.Y + offset.Y))
        .OrderBy(step => ChebyshevDistance(step, goal));

    /// <summary>
    /// The progression flag the LOCATION'S OWN TYPE declares and has set, or null - `railroadAreaBlocked` on the
    /// Mountain, `landslide` before the fifth day.
    ///
    /// <para>
    /// The engine exposes no accessor for these: they are private `NetBool` fields the location's `isCollidingPosition`
    /// override reads (`Mountain.cs:32`, `:34`). `DeclaredOnly` confines the reading to the flags the shipped location
    /// type adds, so `GameLocation`'s own nine (`isFarm`, `isOutdoors`, ...) are never candidates and a wall can never be
    /// reported as a gate that opens on some future day. Reading them is what turns `location_constraint` into an answer
    /// the caller can plan around.
    /// </para>
    /// </summary>
    internal static string? StandingLocationGate(GameLocation location)
    {
        foreach (System.Reflection.FieldInfo field in location.GetType().GetFields(
            System.Reflection.BindingFlags.Instance
            | System.Reflection.BindingFlags.Public
            | System.Reflection.BindingFlags.NonPublic
            | System.Reflection.BindingFlags.DeclaredOnly))
        {
            if (field.FieldType != typeof(Netcode.NetBool))
                continue;
            if (field.GetValue(location) is Netcode.NetBool { Value: true })
                return field.Name;
        }

        return null;
    }

    private void Fail(string reasonCode, string evidence) => this.Stop(ExecutionState.Failed, reasonCode, evidence);

    private void Expire(string reasonCode, string evidence) => this.Stop(ExecutionState.Expired, reasonCode, evidence);

    private void Stop(ExecutionState state, string reasonCode, string evidence)
    {
        if (this.active is null)
            return;

        if (ReferenceEquals(Game1.player.controller, this.pathController))
            Game1.player.controller = null;
        Game1.player.Halt();
        // Clear local ownership before the manager callback. A replacement
        // directive may only start after this old route is truly inert.
        this.active = null;
        this.pathController = null;
        this.clearApproach = null;
        this.hasEmittedStalledWaiting = false;
        this.isStallWaiting = false;
        this.stallWaitStartedTick = 0;
        this.transientSinceMs = 0;
        this.transition(state, reasonCode, evidence);
    }

    private static int DirectionToward(Vector2 from, Vector2 to, bool preferAlternateAxis)
    {
        float horizontal = to.X - from.X;
        float vertical = to.Y - from.Y;
        bool horizontalFirst = Math.Abs(horizontal) >= Math.Abs(vertical);
        if (preferAlternateAxis)
            horizontalFirst = !horizontalFirst;
        if (horizontalFirst && Math.Abs(horizontal) > 0.01f)
            return horizontal >= 0 ? Game1.right : Game1.left;
        if (Math.Abs(vertical) > 0.01f)
            return vertical >= 0 ? Game1.down : Game1.up;
        return horizontal >= 0 ? Game1.right : Game1.left;
    }

    /// <summary>
    /// The native arrival predicate handed to <see cref="PathFindController"/>.
    ///
    /// It answers "is this a valid arrival tile for this directive?", which is
    /// the question the native path finder actually consumes. Two geometries are
    /// expressed, and they are the only two the Mod needs:
    ///
    /// * <see cref="LocalMoveSpec.AllowAdjacentArrival"/> -- the requested tile,
    ///   or any Chebyshev-1 neighbour of it. Used by actions that need to be
    ///   *next to* a target (tools, chests, machines, animals) and by the
    ///   warp-tile case, where a neighbouring tile is the interactable approach.
    /// * otherwise -- the requested tile itself. Used where the caller needs the
    ///   actor standing on that exact tile.
    ///
    /// The predicate accepts the requested tile even when it is not walkable: it
    /// is only consulted for nodes the search already enqueued, and every node
    /// passes the same collision test (`:222`). Accepting it here therefore
    /// cannot place anyone onto an unwalkable tile -- it only means "if you can
    /// reach it, it counts as arrival".
    /// </summary>
    private PathFindController.isAtEnd IsArrivalTile(LocalMoveSpec specification)
    {
        int targetX = (int)specification.TargetTile.X;
        int targetY = (int)specification.TargetTile.Y;
        bool allowAdjacent = specification.AllowAdjacentArrival;
        return (node, _endPoint, _location, _character) =>
            IsArrivalDelta(Math.Abs(node.x - targetX), Math.Abs(node.y - targetY), allowAdjacent);
    }

    /// <summary>
    /// The arrival predicate as pure arithmetic, so its behaviour is testable
    /// directly instead of by reading the source text.
    ///
    /// The requested tile always counts as arrival: it is filtered by the same
    /// collision test as every other node (<c>PathFindController.cs:222</c>), so
    /// accepting it here cannot place the actor on an unwalkable tile -- it only
    /// means "if you can reach it, it counts as arrival".
    ///
    /// Neighbours are Chebyshev-1 (diagonals included) and only when the directive
    /// asked for an adjacent approach. Chebyshev is not a preference: measured on
    /// the target version, A* dequeues by <c>g + manhattan h</c>, so this predicate
    /// ended DIAGONALLY on 4 of 6 sampled unreachable targets. A cardinal-only
    /// neighbourhood would let the planner finish on a tile the arrival test then
    /// rejects.
    /// </summary>
    internal static bool IsArrivalDelta(int deltaX, int deltaY, bool allowAdjacentArrival)
    {
        // Signed deltas are accepted here on purpose: every caller today passes Math.Abs(...), and a future one
        // that forgot would otherwise read `dx = -3` as "within one tile" (`-3 <= 1`), reporting an arrival
        // three tiles away.
        deltaX = Math.Abs(deltaX);
        deltaY = Math.Abs(deltaY);
        if (deltaX == 0 && deltaY == 0)
            return true;
        return allowAdjacentArrival && deltaX <= 1 && deltaY <= 1;
    }

    /// <summary>
    /// True when the actor can act on <paramref name="requested"/> from its current tile: the adjacent-arrival
    /// rule applied to the REQUESTED tile. A staged walk is only finished when this holds, because a staged
    /// step stops at an intermediate tile the caller never asked for.
    /// </summary>
    private static bool IsWithinRequestedReach(Vector2 currentTile, Vector2 requested) =>
        IsArrivalDelta(
            Math.Abs((int)currentTile.X - (int)requested.X),
            Math.Abs((int)currentTile.Y - (int)requested.Y),
            allowAdjacentArrival: true);

    /// <summary>The reach rule a staged walk is finished by, exposed so the contract can be tested directly.</summary>
    internal static bool IsStagedWalkFinished(Point currentTile, Point requested) =>
        IsWithinRequestedReach(new Vector2(currentTile.X, currentTile.Y), new Vector2(requested.X, requested.Y));

    /// <summary>
    /// The runtime arrival test used by <see cref="Update"/>: a neighbouring tile
    /// counts as arrived only when the directive asked for an adjacent approach.
    ///
    /// It delegates to <see cref="IsArrivalDelta"/> so the planner goal and the
    /// arrival test cannot drift -- if they disagree, a completed route is reported
    /// as <c>native_path_ended</c>.
    /// </summary>
    internal static bool IsChebyshevAdjacent(int deltaX, int deltaY) =>
        (deltaX != 0 || deltaY != 0) && IsArrivalDelta(deltaX, deltaY, allowAdjacentArrival: true);

    // ---- WIA disposition projection and rulings (Lane B) ----------------------

    /// <summary>
    /// Goal-agnostic body frame classification consumed by <see cref="Update"/>.
    /// Delegated to the single authority (<see cref="WorldModel.Classify"/>) so
    /// admission, the body loop and the world model can never drift apart; this
    /// wrapper only narrows the kind set (the body loop has no Warped ruling — a
    /// walking body changes tiles by design) and keeps the existing behavioural
    /// pins working.
    /// </summary>
    internal enum LocalDispositionKind
    {
        Idle,
        Modal,
        Event,
        PassOut,
        Transient,
    }

    /// <summary>
    /// The disposition precedence, delegated to the single authority
    /// (<see cref="WorldModel.Classify"/>).
    /// </summary>
    /// <summary>
    /// The body's disposition, read from the SAME facts admission reads. An earlier version delegated
    /// the CLASSIFICATION to <see cref="WorldModel.Classify"/> but pinned two facts to false
    /// (`DialogueUp`, `Eating`) because its caller took loose flags - so a dialogue that outlived its
    /// menu, which is the window <see cref="WorldModel"/> documents, classified as Idle here while
    /// admission saw Modal. Reading the facts removes that divergence at its source. <paramref name="transient"/>
    /// is the transient those same facts named, or null when they named none (the `!CanMove` tail declares no producer
    /// and therefore has no window of its own).
    /// </summary>
    internal static LocalDispositionKind ClassifyLocalDisposition(Farmer actor, out ActorTransientKind? transient)
    {
        ActorDisposition classified = WorldModel.Classify(WorldModel.ReadFacts(actor));
        transient = WorldModel.DeclaredKindOf(classified.TransientKind);
        LocalDispositionKind disposition = classified.Kind switch
        {
            ActorDispositionKind.Event => LocalDispositionKind.Event,
            ActorDispositionKind.Modal => LocalDispositionKind.Modal,
            ActorDispositionKind.PassOut => LocalDispositionKind.PassOut,
            ActorDispositionKind.Transient => LocalDispositionKind.Transient,
            ActorDispositionKind.Idle => LocalDispositionKind.Idle,
        };
        // Any remaining movement lock (knockback, warp transition, an animation the facts cannot name)
        // stays non-Idle exactly as the pre-convergence !CanMove check decided.
        if (disposition == LocalDispositionKind.Idle && !actor.CanMove)
            return LocalDispositionKind.Transient;
        return disposition;
    }

    /// <summary>
    /// WIA §4.4 transient window as pure arithmetic so its crossing behaviour is
    /// pinned directly. Returns the frame's window anchor while the lock may still
    /// self-heal (window just opened, or still inside); null once the window
    /// expired and the regular rulings must apply. A zero anchor opens the window
    /// at the current frame.
    /// </summary>
    internal static long? AssessTransientWindow(long transientSinceMs, long nowMs, int windowMs)
    {
        if (transientSinceMs <= 0)
            return nowMs;
        return nowMs - transientSinceMs >= windowMs ? null : transientSinceMs;
    }

    /// <summary>Applies the WIA §4.4 transient window for one frame. True while
    /// the frame stays inside the window (keep running, no new reasonCode); false
    /// once it expired, so the caller falls through to the regular rulings. The
    /// window is the one the kind declares - the number the refusal publishes.</summary>
    private bool KeepRunningWithinTransientWindow(long nowMs, ActorTransientKind? transient)
    {
        long? anchor = AssessTransientWindow(this.transientSinceMs, nowMs, WorldModel.SettleWindowMs(transient));
        this.transientSinceMs = anchor ?? 0;
        return anchor is not null;
    }

    /// <summary>
    /// WIA §4.1 ② intent-breakpoint evidence for <c>modal_interrupted</c>: what
    /// interrupted, where the body was, how far from the target, on which
    /// (request-bound) revision. The Agent replans from this as a fresh request on
    /// a new revision -- never a replay of the terminated execution.
    /// </summary>
    internal static string FormatModalInterruptedEvidence(
        string interruptedBy, Vector2 targetTile, Vector2 interruptedAt, float remainingDistance, long revision)
        => $"interrupted_by={interruptedBy};target_tile={FormatTile(targetTile)};interrupted_at={FormatTile(interruptedAt)};remaining_distance={remainingDistance.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)};revision={revision.ToString(System.Globalization.CultureInfo.InvariantCulture)}";

    /// <summary>
    /// WIA §4.3 body facts for <c>pass_out</c>: the stamina/time/position the
    /// Agent needs to schedule the eat/rest recovery instead of treating the faint
    /// as a retryable action fault.
    /// </summary>
    internal static string FormatPassOutEvidence(float stamina, int timeOfDay, Vector2 tile, long revision)
        => $"stamina={stamina.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)};time_of_day={timeOfDay.ToString(System.Globalization.CultureInfo.InvariantCulture)};tile={FormatTile(tile)};revision={revision.ToString(System.Globalization.CultureInfo.InvariantCulture)}";

    /// <summary>
    /// Names a staged move inside every receipt that mentions the goal, so a \`target_reached\` on a
    /// staged step can never be read as the requested tile having been reached.
    /// </summary>
    private static string FormatStagedMarker(LocalMoveSpec specification) =>
        specification is { StagedApproach: true, RequestedTile: Vector2 requested }
            ? $";staged_approach=true;requested={FormatTile(requested)}"
            : string.Empty;

    private static string FormatTile(Vector2 tile) => $"{tile.X.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)},{tile.Y.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)}";
}
