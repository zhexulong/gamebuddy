using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Pathfinding;

namespace GameBuddy.Stardew;

/// <summary>
/// Client-local, game-thread controller for the native Farmhand represented by
/// this process' Game1.player. It deliberately has no remote-player, teleport,
/// or world-goal API. ExecutionManager is its sole owner.
/// </summary>
internal sealed class StardewBodyController
{
    private readonly Action<ExecutionState, string, string?> transition;
    private LocalMoveSpec? active;
    private PathFindController? pathController;
    private Vector2 lastTile;
    private int lastProgressTick;
    private bool hasEmittedRunning;
    private bool hasEmittedStalledWaiting;

    /// <summary>Navigation L2 watchdog: native movement must show progress before
    /// this many game ticks have elapsed. Stardew's native update loop is 60 FPS,
    /// so the frozen 2 second blocker diagnostic window is 120 ticks
    /// (blocker-and-navigation-diagnostics.md §5.3).</summary>
    private const int StallDetectionTicks = 120;

    /// <summary>Navigation L2 watchdog hard budget. The 5 second bound is 300
    /// native 60 FPS ticks, measured from the last observed progress tick.</summary>
    private const int StallTimeoutTicks = 300;

    /// <summary>WIA §4.4 transient self-healing window: a short-lived body lock
    /// (freezePause, tool animation) keeps the execution running while inside it
    /// and only falls through to the regular rulings once it expires.</summary>
    private const int TransientWindowMs = 2000;

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

        if (!localPlayer.CanMove || Game1.activeClickableMenu is not null || Game1.eventUp)
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

        PathFindController plannedPath = new(
            localPlayer,
            localPlayer.currentLocation,
            // Native goal PREDICATE, not an exact coordinate. `findPath` tests
            // `isAtEnd` on every dequeue (`PathFindController.cs:199-203`) and
            // enqueues the start node unconditionally (`:194`), so asking "is this
            // a valid arrival tile?" (a) returns a single-node path when the actor
            // already stands somewhere valid, and (b) stops at the nearest valid
            // tile when the requested tile itself cannot be stood on -- instead of
            // returning null for a target a human would simply walk up to.
            //
            // The exact-coordinate constructor (`isAtEndPoint`) asked the wrong
            // question: "can this tile be stood on", which is why an adjacent
            // tile one step away could be rejected outright.
            this.IsArrivalTile(specification),
            -1,
            null,
            10000,
            new Point((int)specification.TargetTile.X, (int)specification.TargetTile.Y));
        if (plannedPath.pathToEndPoint is null || plannedPath.pathToEndPoint.Count == 0)
        {
            // Dead-end rejection: no tile in this location satisfies the arrival
            // predicate, so the target is genuinely unreachable (surrounded, or
            // severed from this component). The evidence names both ends.
            reasonCode = "no_native_path";
            evidence = $"from={(int)localPlayer.Tile.X},{(int)localPlayer.Tile.Y};to={(int)specification.TargetTile.X},{(int)specification.TargetTile.Y};location={localPlayer.currentLocation.NameOrUniqueName}";
            return false;
        }

        this.active = specification;
        this.pathController = plannedPath;
        localPlayer.controller = plannedPath;
        this.lastTile = localPlayer.Tile;
        this.lastProgressTick = tick;
        this.hasEmittedRunning = false;
        this.hasEmittedStalledWaiting = false;
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
            this.transition(ExecutionState.Running, "controller_started", $"target={FormatTile(specification.TargetTile)}");
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
        LocalDispositionKind disposition = ClassifyLocalDisposition(
            Game1.eventUp,
            Game1.activeClickableMenu is not null,
            Game1.timeOfDay,
            localPlayer.Stamina,
            localPlayer.freezePause > 0,
            localPlayer.UsingTool);

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
        if (!ReferenceEquals(localPlayer.controller, pathController))
        {
            if (exactArrival || adjacentArrival)
            {
                localPlayer.Halt();
                this.transition(ExecutionState.Succeeded, "target_reached", $"tile={FormatTile(currentTile)};target={FormatTile(specification.TargetTile)};arrival={(exactArrival ? "exact" : "warp_adjacent")};path=stardew_native");
                this.active = null;
                this.pathController = null;
            }
            else
            {
                int stalledTicks = Math.Max(0, tick - this.lastProgressTick);
                string evidence = $"tile={FormatTile(currentTile)};target={FormatTile(specification.TargetTile)}";
                if (stalledTicks >= StallTimeoutTicks)
                    evidence += $";stalled_ticks={stalledTicks}";
                this.Fail("native_path_ended", evidence);
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
            localPlayer.Halt();
            localPlayer.controller = null;
            this.pathController = null;
            this.transition(ExecutionState.Succeeded, "target_reached", $"tile={FormatTile(currentTile)};target={FormatTile(specification.TargetTile)};arrival={(exactArrival ? "exact" : "warp_adjacent")};path=stardew_native");
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
            int stalledTicks = Math.Max(0, tick - this.lastProgressTick);
            this.Fail("native_path_ended", $"tile={FormatTile(currentTile)};target={FormatTile(specification.TargetTile)};stalled_ticks={stalledTicks}");
            return;
        }

        if (stallAction == StallWatchdogAction.Waiting)
        {
            this.hasEmittedStalledWaiting = true;
            int stalledTicks = Math.Max(0, tick - this.lastProgressTick);
            this.transition(ExecutionState.Running, "stalled_waiting", $"reason=entity_block;tile={FormatTile(currentTile)};target={FormatTile(specification.TargetTile)};stalled_ticks={stalledTicks}");
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
        if (deltaX == 0 && deltaY == 0)
            return true;
        return allowAdjacentArrival && deltaX <= 1 && deltaY <= 1;
    }

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
    internal static LocalDispositionKind ClassifyLocalDisposition(
        bool eventUp, bool menuOpen, int timeOfDay, float stamina, bool freezePaused, bool usingTool)
    {
        ActorDisposition disposition = WorldModel.Classify(
            new ActorWorldFacts(
                EventUp: eventUp,
                MenuType: menuOpen ? "menu" : null,
                DialogueUp: false,
                TimeOfDay: timeOfDay,
                Stamina: stamina,
                FreezePaused: freezePaused,
                Eating: false,
                UsingTool: usingTool,
                ToolCharged: false));
        return disposition.Kind switch
        {
            ActorDispositionKind.Event => LocalDispositionKind.Event,
            ActorDispositionKind.Modal => LocalDispositionKind.Modal,
            ActorDispositionKind.PassOut => LocalDispositionKind.PassOut,
            ActorDispositionKind.Transient => LocalDispositionKind.Transient,
            _ => LocalDispositionKind.Idle,
        };
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

    private static string FormatTile(Vector2 tile) => $"{tile.X.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)},{tile.Y.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)}";
}
