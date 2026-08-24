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

    public bool TryStart(LocalMoveSpec specification, Farmer localPlayer, int tick, out string reasonCode)
    {
        if (this.active is not null)
        {
            reasonCode = "body_owned";
            return false;
        }

        if (!localPlayer.CanMove || Game1.activeClickableMenu is not null || Game1.eventUp)
        {
            reasonCode = "player_not_actionable";
            return false;
        }
        if (localPlayer.controller is not null)
        {
            reasonCode = "native_controller_owned";
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
            new Point((int)specification.TargetTile.X, (int)specification.TargetTile.Y),
            -1,
            null,
            10000);
        if (plannedPath.pathToEndPoint is null || plannedPath.pathToEndPoint.Count == 0)
        {
            reasonCode = "no_native_path";
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
                && IsCardinalAdjacent(localPlayer.Tile, specification.TargetTile);
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
            && IsCardinalAdjacent(currentTile, specification.TargetTile);
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

    private static bool IsCardinalAdjacent(Vector2 current, Vector2 target)
    {
        int deltaX = Math.Abs((int)current.X - (int)target.X);
        int deltaY = Math.Abs((int)current.Y - (int)target.Y);
        return deltaX + deltaY == 1;
    }

    private static string FormatTile(Vector2 tile) => $"{tile.X.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)},{tile.Y.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)}";
}
