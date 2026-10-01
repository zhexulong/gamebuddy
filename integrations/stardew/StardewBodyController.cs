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
        reasonCode = "accepted";
        return true;
    }

    public void Cancel(string reasonCode) => this.Stop(ExecutionState.Cancelled, reasonCode, "local_controller_halted");

    public void Invalidate(string reasonCode) => this.Stop(ExecutionState.Invalidated, reasonCode, "lifecycle_or_world_change");

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

        if (tick > specification.DeadlineTick || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= specification.DeadlineMs)
        {
            this.Expire("deadline_expired", "authoritative deadline reached");
            return;
        }

        if (Game1.activeClickableMenu is not null)
        {
            this.Invalidate("menu_opened");
            return;
        }
        if (!ReferenceEquals(localPlayer.controller, pathController))
        {
            bool exactArrival = Vector2.DistanceSquared(localPlayer.Tile, specification.TargetTile) <= 0.04f;
            bool adjacentArrival = specification.AllowAdjacentArrival
                && IsChebyshevAdjacent(Math.Abs((int)localPlayer.Tile.X - (int)specification.TargetTile.X), Math.Abs((int)localPlayer.Tile.Y - (int)specification.TargetTile.Y));
            if (exactArrival || adjacentArrival)
            {
                localPlayer.Halt();
                this.transition(ExecutionState.Succeeded, "target_reached", $"tile={FormatTile(localPlayer.Tile)};target={FormatTile(specification.TargetTile)};arrival={(exactArrival ? "exact" : "warp_adjacent")};path=stardew_native");
                this.active = null;
                this.pathController = null;
            }
            else
            {
                this.Fail("native_path_ended", $"tile={FormatTile(localPlayer.Tile)};target={FormatTile(specification.TargetTile)}");
            }
            return;
        }
        if (Game1.eventUp)
        {
            this.Invalidate("event_started");
            return;
        }
        Vector2 currentTile = localPlayer.Tile;
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
        bool currentTileExact = Vector2.DistanceSquared(currentTile, specification.TargetTile) <= 0.04f;
        bool currentTileAdjacent = specification.AllowAdjacentArrival
            && IsChebyshevAdjacent(Math.Abs((int)currentTile.X - (int)specification.TargetTile.X), Math.Abs((int)currentTile.Y - (int)specification.TargetTile.Y));
        if (currentTileExact || currentTileAdjacent)
        {
            localPlayer.Halt();
            localPlayer.controller = null;
            this.pathController = null;
            this.transition(ExecutionState.Succeeded, "target_reached", $"tile={FormatTile(currentTile)};target={FormatTile(specification.TargetTile)};arrival={(currentTileExact ? "exact" : "warp_adjacent")};path=stardew_native");
            this.active = null;
            return;
        }

        if (currentTile != this.lastTile)
        {
            this.lastTile = currentTile;
            this.lastProgressTick = tick;
            this.transition(ExecutionState.MeaningfulProgress, "tile_advanced", $"tile={FormatTile(currentTile)};path=stardew_native");
        }
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

    private static string FormatTile(Vector2 tile) => $"{tile.X.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)},{tile.Y.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)}";
}
