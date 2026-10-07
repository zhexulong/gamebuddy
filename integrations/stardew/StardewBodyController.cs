using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Characters;
using StardewValley.Pathfinding;

namespace GameBuddy.Stardew;

/// <summary>
/// Client-local, game-thread controller for the native Farmhand represented by
/// this process' Game1.player. It deliberately has no remote-player, teleport,
/// or world-goal API. ExecutionManager is its sole owner.
/// </summary>
    internal readonly record struct ReachabilityVerdict(
        bool TargetEnclosed,
        bool ComponentContainsTarget = false,
        Point? ClosestToTarget = null,
        int ComponentTiles = 0);

internal sealed class StardewBodyController
{
    private readonly Action<ExecutionState, string, string?> transition;
    private LocalMoveSpec? active;
    private PathFindController? pathController;
    private Vector2 lastTile;
    private int lastProgressTick;
    private bool hasEmittedRunning;
    private bool hasEmittedStalledWaiting;
    private bool isStallWaiting;
    private int stallWaitStartedTick;

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

    /// <summary>WIA §4.4 transient self-healing window: a short-lived body lock
    /// (freezePause, tool animation) keeps the execution running while inside it
    /// and only falls through to the regular rulings once it expires.</summary>
    private const int TransientWindowMs = 2000;

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

    public StardewBodyController(Action<ExecutionState, string, string?> transition)
    {
        this.transition = transition;
    }

    public bool HasActiveExecution => this.active is not null;

    public string? ActiveExecutionId => this.active?.ExecutionId;

    public bool TryStart(LocalMoveSpec specification, Farmer localPlayer, int tick, out string reasonCode, out string? evidence)
    {
        evidence = null;
        if (this.active is not null)
        {
            reasonCode = "body_owned";
            evidence = $"execution={this.active.ExecutionId}";
            return false;
        }

        // The body-environment ruling comes from the SHARED authority, not from a third copy of it: this
// used to be `!CanMove || menu != null || eventUp`, which agreed with admission only by accident and
// could not say WHY the actor is held. Reading the disposition makes movement and admission decide
// the same way, and the refusal below can then name the holder.
LocalDispositionKind movementDisposition = ClassifyLocalDisposition(localPlayer);
if (movementDisposition != LocalDispositionKind.Idle)
        {
            reasonCode = "player_not_actionable";
            evidence = $"can_move={localPlayer.CanMove.ToString().ToLowerInvariant()};menu={(Game1.activeClickableMenu is not null).ToString().ToLowerInvariant()};event_up={Game1.eventUp.ToString().ToLowerInvariant()}";
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

        PathFindController plannedPath = this.BuildNativePath(specification, localPlayer);
        if (plannedPath.pathToEndPoint is null || plannedPath.pathToEndPoint.Count == 0)
        {
            reasonCode = "no_native_path";
            evidence = $"from={(int)localPlayer.Tile.X},{(int)localPlayer.Tile.Y};to={(int)specification.TargetTile.X},{(int)specification.TargetTile.Y};location={localPlayer.currentLocation.NameOrUniqueName}";
            // A refusal is only actionable if it names WHY. The bare verdict plus a probe field
            // that can contradict it sent a live agent into ten blind re-aims at neighbouring
            // occupied tiles, which it then described as a maze. So the receipt carries the
            // occupancy cause, whether the PLANNER would stand on the tile, and the probe's own
            // reading — plus, below, the two facts the native null path conflates.
            evidence += $";target_standable={(IsStandableTile(localPlayer.currentLocation, localPlayer, specification.TargetTile) ? "true" : "false")}";
            evidence += $";target_walkable={(IsWalkableTile(localPlayer.currentLocation, localPlayer, specification.TargetTile) ? "true" : "false")}";
            evidence += $";blocked_by={DescribeTargetOccupant(localPlayer.currentLocation, specification.TargetTile)}";
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
                // `probe_says_reachable` states the disagreement explicitly
                // instead of leaving a reader to derive it from target_enclosed.
                evidence += $";target_enclosed={assessed.TargetEnclosed.ToString().ToLowerInvariant()};derived=true;probe=cardinal_flood;probe_says_reachable={(assessed.TargetEnclosed ? "false" : "true")}";
                evidence += $";route_exists_cardinal={assessed.ComponentContainsTarget.ToString().ToLowerInvariant()};component_tiles={assessed.ComponentTiles}";
                searchOutcome = assessed.ComponentContainsTarget
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
            return false;
        }

        this.active = specification;
        this.pathController = plannedPath;
        localPlayer.controller = plannedPath;
        this.lastTile = localPlayer.Tile;
        this.lastProgressTick = tick;
        this.hasEmittedRunning = false;
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
        this.hasEmittedRunning = false;
        this.hasEmittedStalledWaiting = false;
        this.isStallWaiting = false;
        this.stallWaitStartedTick = 0;
        this.transientSinceMs = 0;
    }

    public void Update(int tick)
    {
        LocalMoveSpec? specification = this.active;
        if (specification is null)
            return;

        Farmer localPlayer = Game1.player;
        PathFindController? pathController = this.pathController;
        if (!this.hasEmittedRunning)
        {
            this.hasEmittedRunning = true;
            this.transition(ExecutionState.Running, "controller_started", $"target={FormatTile(specification.TargetTile)}{FormatStagedMarker(specification)}");
        }

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
        LocalDispositionKind disposition = ClassifyLocalDisposition(localPlayer);

        switch (disposition)
        {
            case LocalDispositionKind.Transient:
                // WIA §4.4: a transient body lock keeps the execution running and
                // reports no new reasonCode while inside the window; a lock that
                // outlives the window falls through to the regular rulings below
                // (modal/event/pass-out/non-actionable) instead of earning a
                // transient-specific terminal of its own.
                if (this.KeepRunningWithinTransientWindow(nowMs))
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
        if (this.isStallWaiting)
        {
            if (!HasStallWaitElapsed(tick, this.stallWaitStartedTick, StallWaitTicks))
                return;

            PathFindController resumedPath = this.BuildNativePath(specification, localPlayer);
            if (resumedPath.pathToEndPoint is null || resumedPath.pathToEndPoint.Count == 0)
            {
                this.Fail("native_path_ended", FormatStallEvidence(localPlayer, specification, tick));
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
                this.Fail("native_path_ended", FormatStallEvidence(localPlayer, specification, tick));
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
                this.Fail("player_not_actionable", "movement lock became active");
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
            this.lastTile = currentTile;
            this.lastProgressTick = tick;
            this.hasEmittedStalledWaiting = false;
            this.transition(ExecutionState.MeaningfulProgress, "tile_advanced", $"tile={FormatTile(currentTile)};path=stardew_native");
            return;
        }

        StallWatchdogAction stallAction = AssessStall(tick, this.lastProgressTick, this.hasEmittedStalledWaiting);
        if (stallAction == StallWatchdogAction.TimedOut)
        {
            this.Fail("native_path_ended", FormatStallEvidence(localPlayer, specification, tick));
            return;
        }

        if (stallAction == StallWatchdogAction.Waiting)
        {
            this.hasEmittedStalledWaiting = true;
            this.isStallWaiting = true;
            this.stallWaitStartedTick = tick;
            this.HaltNativeMovement(localPlayer);
            int stalledTicks = Math.Max(0, tick - this.lastProgressTick);
            this.transition(ExecutionState.Running, "stalled_waiting", $"reason=entity_block;tile={FormatTile(currentTile)};target={FormatTile(specification.TargetTile)};stalled_ticks={stalledTicks};wait_ticks={StallWaitTicks}{FormatStagedMarker(specification)}");
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
        return new PathFindController(
            localPlayer,
            location,
            // The native goal remains a predicate on every re-plan. Re-planning
            // after the quiet window must not turn an adjacent approach back into
            // an exact-coordinate request.
            this.IsArrivalTile(specification),
            -1,
            null,
            NativePathNodeBudget,
            new Point((int)specification.TargetTile.X, (int)specification.TargetTile.Y));
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
        return $"tile={FormatTile(localPlayer.Tile)};target={FormatTile(specification.TargetTile)};stalled_ticks={stalledTicks};stopped_by={DetectStalledBy(localPlayer)}";
    }

    /// <summary>
    /// Can the actor stand on this tile? The same predicate the native planner uses
    /// (<c>isCollidingPosition</c> with <c>pathfinding: true</c> and collision effects
    /// skipped), so "the planner can walk there" and "we may substitute an approach
    /// there" cannot disagree. A stricter, object-occupancy test would refuse tiles the
    /// farmer can legally walk on -- a cropped HoeDirt is exactly that, and the Mod's own
    /// reachability probe already reports those as reachable (probe_says_reachable=true).
    /// </summary>
    /// <summary>
    /// The planner's own step set: cardinal only (`PathFindController.cs:45-51`). Shared so the reachability
    /// flood and the cardinal-neighbour tests cannot drift from the graph the native finder actually searches.
    /// </summary>
    /// <summary>
    /// How many single-tile staged steps one walk may take. Strictly-decreasing distance already terminates a
    /// walk, so this is the bound that keeps a pathological field from re-planning indefinitely.
    /// </summary>
    private const int MaxStagedSteps = 24;

    private static readonly Point[] CardinalOffsets =
    {
        new(0, -1), new(1, 0), new(0, 1), new(-1, 0),
    };

    internal static bool IsWalkableTile(GameLocation location, Farmer? actor, Vector2 tile)
    {
        if (actor is null || !location.isTileOnMap(tile))
            return false;
        // The actor's own tile is walkable by definition: they are standing on it, and
        // asking the collision test about the character's own footprint is the one case
        // where its answer cannot be trusted to mean "someone else is in the way".
        if (actor.Tile == tile)
            return true;
        return !location.isCollidingPosition(
            new Microsoft.Xna.Framework.Rectangle((int)tile.X * 64 + 1, (int)tile.Y * 64 + 1, 62, 62),
            Game1.viewport,
            actor is Farmer,
            0,
            glider: false,
            actor,
            pathfinding: true,
            skipCollisionEffects: true);
    }

    /// <summary>
    /// The standable-tile test shared by the move handler and this controller: on
    /// the map, natively passable, and not occupied by anything else. The actor's
    /// own tile counts as standable -- it is where they already are. This is the
    /// stricter, OBJECT-occupancy reading, kept for evidence: it says "the tile is
    /// free", which is a different (and more demanding) fact than
    /// <see cref="IsWalkableTile"/>'s "the planner will walk there".
    /// </summary>
    internal static bool IsStandableTile(GameLocation location, Farmer? actor, Vector2 tile)
    {
        if (!location.isTileOnMap(tile))
            return false;
        if (actor is not null && actor.Tile == tile)
            return true;
        return location.isTilePassable(tile)
            && !location.IsTileOccupiedBy(tile, (CollisionMask)255, (CollisionMask)0, false);
    }

    /// <summary>
    /// Names what stands on a refused destination tile, so the refusal is
    /// actionable: <c>&lt;qualifiedItemId&gt;@x,y</c> for an object,
    /// <c>terrain:&lt;type&gt;</c> for a terrain feature, or <c>none</c>.
    /// </summary>
    internal static string DescribeTargetOccupant(GameLocation location, Vector2 tile)
    {
        Point point = new((int)tile.X, (int)tile.Y);
        if (location.objects.TryGetValue(tile, out StardewValley.Object? item) && item is not null)
            return $"{item.QualifiedItemId}@{point.X},{point.Y}";
        if (location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature) && feature is not null)
            return $"terrain:{feature.GetType().Name}@{point.X},{point.Y}";
        return "none";
    }

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
                findClosestReachable);
        }
        catch
        {
            // A missing/invalid live map cannot support a derived claim. The
            // native failure and its existing evidence remain authoritative.
            return null;
        }
    }

    /// <summary>
    /// Computes the actor's bounded component using the supplied native-planning
    /// walkability predicate. A null result means the component exceeded the hard
    /// probe budget before it could be exhausted, so no enclosure claim is made.
    /// </summary>
    internal static ReachabilityVerdict? AssessReachability(
        Point actorTile,
        Point targetTile,
        Func<Point, bool> canTraverse,
        int maxVisited,
        bool findClosestReachable = false)
    {
        if (maxVisited <= 0)
            return null;
        if (actorTile == targetTile)
            return new ReachabilityVerdict(false, true, null, 1);
        if (!findClosestReachable)
        {
            // The one case that needs no enumeration at all: the actor is ALREADY adjacent to the target, so
            // the planner has one step left to take and the only question is whether that step is possible.
            //
            // The earlier shortcut asked a different question -- `canTraverse(targetTile)`, "is the target
            // tile itself passable" -- and answered it as if a route had been verified. A live refusal read
            // exactly that as `route_exists=true ... path_search=native_budget_exhausted` for a destination
            // whose cardinal approaches were both blocked, while a measurement at 10000, 40000 and 400000
            // expansions returned null identically. A tile's own collision test says nothing about whether
            // anything can walk to it, so it is no longer used to claim a route.
            foreach (Point offset in CardinalOffsets)
            {
                if (new Point(targetTile.X + offset.X, targetTile.Y + offset.Y) != actorTile)
                    continue;
                return new ReachabilityVerdict(false, canTraverse(targetTile), null, 1);
            }
        }

        // The flood must expand the neighbourhood the NATIVE PLANNER uses, or its verdict describes a
        // different graph. `PathFindController.Directions` is cardinal only (`PathFindController.cs:45-51`:
        // { -1,0 }, { 1,0 }, { 0,1 }, { 0,-1 }), so the planner can never step diagonally. An 8-neighbour
        // flood therefore calls a tile "reachable" that the planner must walk around a corner to reach, and
        // on a cropped field the corner is exactly what is blocked. Measured on the real fixture, actor at
        // 3,9: the cardinal neighbour 3,10 resolves (2-node path at every limit), while the diagonal-only
        // neighbour 4,8 returns null at 10000, 40000 AND 400000 expansions -- the limit is not the variable.
        Point[] neighbours = CardinalOffsets;
        // "Contains the target" means the planner can be NEXT TO it (Manhattan 1) or on it, because that is
        // what makes the target reachable for a cardinal stepper. A Chebyshev ring would count a diagonally
        // adjacent tile, which the planner cannot step across.
        bool IsTargetNeighbour(Point tile) =>
            tile != targetTile
            && Math.Abs(tile.X - targetTile.X) + Math.Abs(tile.Y - targetTile.Y) == 1;
        static int Chebyshev(Point left, Point right) =>
            Math.Max(Math.Abs(left.X - right.X), Math.Abs(left.Y - right.Y));
        // Two different facts, deliberately kept apart:
        //   * `reachesNeighbourhood` -- the flood VISITED a tile adjacent to the target, so the planner can
        //     stand next to it. This is what `TargetEnclosed` denies, and the original contract's question.
        //   * `ComponentContainsTarget` -- the planner can actually STEP ONTO the target, which additionally
        //     requires the target tile itself to be passable. Claiming this without a route is the defect the
        //     live refusal exposed.
        bool reachesNeighbourhood = false;
        bool targetTraversable = canTraverse(targetTile);
        Point? closest = null;
        int closestDistance = Chebyshev(actorTile, targetTile);
        var visited = new HashSet<Point> { actorTile };
        var pending = new Queue<Point>();
        pending.Enqueue(actorTile);

        while (pending.Count > 0)
        {
            Point current = pending.Dequeue();
            if (IsTargetNeighbour(current))
            {
                reachesNeighbourhood = true;
                if (!findClosestReachable)
                    return new ReachabilityVerdict(false, targetTraversable, current, visited.Count);
            }
            foreach (Point offset in neighbours)
            {
                Point next = new(current.X + offset.X, current.Y + offset.Y);
                // The candidate's adjacency counts only once it is a tile the flood actually VISITED: an
                // expansion that was rejected for collision is not "the component reaches the target".
                if (!canTraverse(next) || !visited.Add(next))
                    continue;
                if (IsTargetNeighbour(next))
                {
                    reachesNeighbourhood = true;
                    if (!findClosestReachable)
                        return new ReachabilityVerdict(false, targetTraversable, next, visited.Count);
                }
                if (next != targetTile)
                {
                    // The closest tile the component offers towards the target: what a staged
                    // approach can aim at when the finder gives up on the far goal.
                    int distance = Chebyshev(next, targetTile);
                    if (distance < closestDistance)
                    {
                        closest = next;
                        closestDistance = distance;
                    }
                }
                if (visited.Count > maxVisited)
                    return null;
                pending.Enqueue(next);
            }
        }

        return new ReachabilityVerdict(!reachesNeighbourhood, reachesNeighbourhood && targetTraversable, closest, visited.Count);
    }

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
        this.hasEmittedRunning = false;
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
        this.hasEmittedRunning = false;
        this.hasEmittedStalledWaiting = false;
        this.isStallWaiting = false;
        this.stallWaitStartedTick = 0;
        this.transientSinceMs = 0;
        this.transition(
            ExecutionState.Running,
            "staged_approach_continued",
            $"tile={FormatTile(currentTile)};target={FormatTile(staged.TargetTile)};{evidence}");
        return true;
    }

    private static int ChebyshevDistance(Point left, Point right) =>
        Math.Max(Math.Abs(left.X - right.X), Math.Abs(left.Y - right.Y));

    private static string DetectStalledBy(Farmer localPlayer)
    {
        GameLocation? location = localPlayer.currentLocation;
        if (location is null)
            return "unknown";

        Point frontTile = GetFrontTile(localPlayer);
        try
        {
            if (location.characters.OfType<Pet>().Any(character => IsAtTile(character, frontTile)))
                return "Pet";
            if (location.characters.OfType<Horse>().Any(character => IsAtTile(character, frontTile)))
                return "Horse";
            if (location.characters.OfType<NPC>().Any(character => IsAtTile(character, frontTile)))
                return "Npc";
        }
        catch
        {
            // A world collection can change during a game-thread lifecycle edge;
            // an unknown blocker is honest and keeps the terminal ruling intact.
        }

        return "unknown";
    }

    private static bool IsAtTile(Character character, Point tile) =>
        character.currentLocation is not null
        && character.currentLocation == Game1.player?.currentLocation
        && (int)character.Tile.X == tile.X
        && (int)character.Tile.Y == tile.Y;

    private static Point GetFrontTile(Farmer player)
    {
        Point tile = new((int)player.Tile.X, (int)player.Tile.Y);
        return player.FacingDirection switch
        {
            Game1.up => new Point(tile.X, tile.Y - 1),
            Game1.right => new Point(tile.X + 1, tile.Y),
            Game1.down => new Point(tile.X, tile.Y + 1),
            Game1.left => new Point(tile.X - 1, tile.Y),
            _ => tile,
        };
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
        this.hasEmittedRunning = false;
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
    /// admission saw Modal. Reading the facts removes that divergence at its source.
    /// </summary>
    internal static LocalDispositionKind ClassifyLocalDisposition(Farmer actor)
    {
        LocalDispositionKind disposition = WorldModel.Classify(WorldModel.ReadFacts(actor)).Kind switch
        {
            ActorDispositionKind.Event => LocalDispositionKind.Event,
            ActorDispositionKind.Modal => LocalDispositionKind.Modal,
            ActorDispositionKind.PassOut => LocalDispositionKind.PassOut,
            ActorDispositionKind.Transient => LocalDispositionKind.Transient,
            _ => LocalDispositionKind.Idle,
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
    /// once the window expired, so the caller falls through to the regular rulings.</summary>
    private bool KeepRunningWithinTransientWindow(long nowMs)
    {
        long? anchor = AssessTransientWindow(this.transientSinceMs, nowMs, TransientWindowMs);
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
