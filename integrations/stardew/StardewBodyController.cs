using Microsoft.Xna.Framework;
using StardewValley;

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
    private Vector2 lastTile;
    private int lastProgressTick;
    private int blockedTicks;
    private bool recoveryAttempted;
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

        this.active = specification;
        this.lastTile = localPlayer.Tile;
        this.lastProgressTick = tick;
        this.blockedTicks = 0;
        this.recoveryAttempted = false;
        this.hasEmittedRunning = false;
        reasonCode = "accepted";
        return true;
    }

    public void Cancel(string reasonCode) => this.Stop(ExecutionState.Cancelled, reasonCode, "local_controller_halted");

    public void Invalidate(string reasonCode) => this.Stop(ExecutionState.Invalidated, reasonCode, "lifecycle_or_world_change");

    public void Update(int tick)
    {
        LocalMoveSpec? specification = this.active;
        if (specification is null)
            return;

        Farmer localPlayer = Game1.player;
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
        if (Game1.eventUp)
        {
            this.Invalidate("event_started");
            return;
        }
        if (!localPlayer.CanMove)
        {
            this.Fail("player_not_actionable", "movement lock became active");
            return;
        }

        Vector2 currentTile = localPlayer.Tile;
        if (Vector2.DistanceSquared(currentTile, specification.TargetTile) <= 0.04f)
        {
            localPlayer.Halt();
            this.transition(ExecutionState.Succeeded, "target_reached", $"tile={FormatTile(currentTile)}");
            this.active = null;
            return;
        }

        // This controller owns no planner: it attempts only the next local
        // cardinal segment. After one bounded stall it tries the alternate
        // axis once, then emits a factual terminal failure rather than wander.
        int direction = DirectionToward(currentTile, specification.TargetTile, this.recoveryAttempted);
        SetMovement(localPlayer, direction);

        if (currentTile != this.lastTile)
        {
            this.lastTile = currentTile;
            this.lastProgressTick = tick;
            this.blockedTicks = 0;
            this.transition(ExecutionState.MeaningfulProgress, "tile_advanced", $"tile={FormatTile(currentTile)}");
            return;
        }

        if (tick - this.lastProgressTick >= 90)
        {
            this.blockedTicks++;
            this.lastProgressTick = tick;
            if (this.blockedTicks >= 2)
            {
                this.Fail("locally_blocked", $"no tile progress after bounded recovery; tile={FormatTile(currentTile)};target={FormatTile(specification.TargetTile)}");
                return;
            }

            this.recoveryAttempted = true;
            this.transition(ExecutionState.Blocked, "locally_blocked_recovering", $"tile={FormatTile(currentTile)};target={FormatTile(specification.TargetTile)};strategy=alternate_axis_once");
        }
    }

    private void Fail(string reasonCode, string evidence) => this.Stop(ExecutionState.Failed, reasonCode, evidence);

    private void Expire(string reasonCode, string evidence) => this.Stop(ExecutionState.Expired, reasonCode, evidence);

    private void Stop(ExecutionState state, string reasonCode, string evidence)
    {
        if (this.active is null)
            return;

        Game1.player.Halt();
        // Clear local ownership before the manager callback. A replacement
        // directive may only start after this old route is truly inert.
        this.active = null;
        this.recoveryAttempted = false;
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

    private static void SetMovement(Farmer player, int direction)
    {
        player.Halt();
        switch (direction)
        {
            case Game1.up:
                player.SetMovingUp(true);
                break;
            case Game1.right:
                player.SetMovingRight(true);
                break;
            case Game1.down:
                player.SetMovingDown(true);
                break;
            case Game1.left:
                player.SetMovingLeft(true);
                break;
            default:
                throw new InvalidOperationException($"Unsupported Stardew direction {direction}.");
        }
    }

    private static string FormatTile(Vector2 tile) => $"{tile.X:0.##},{tile.Y:0.##}";
}
