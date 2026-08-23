using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Handlers;

internal static class ActionPreconditionGuard
{
    public static bool TryValidateBasicPreconditions(
        string requestId,
        string executionId,
        long revision,
        long deadlineMs,
        out LocalExecutionReceipt? failureReceipt)
    {
        failureReceipt = null;

        if (!Context.IsWorldReady || Game1.player is null)
        {
            failureReceipt = new LocalExecutionReceipt(executionId, requestId, ExecutionState.Blocked, "world_not_ready", revision, null);
            return false;
        }

        if (Game1.activeClickableMenu is not null || !Game1.player.CanMove)
        {
            failureReceipt = new LocalExecutionReceipt(executionId, requestId, ExecutionState.Blocked, "player_not_actionable", revision, null);
            return false;
        }

        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (deadlineMs > 0 && deadlineMs <= nowMs)
        {
            failureReceipt = new LocalExecutionReceipt(executionId, requestId, ExecutionState.Expired, "deadline_passed", revision, null);
            return false;
        }

        return true;
    }

    public static bool IsWithinChebyshevDistance(Vector2 a, Vector2 b, int maxDistance = 1)
    {
        return Math.Max(Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y)) <= maxDistance;
    }
}
