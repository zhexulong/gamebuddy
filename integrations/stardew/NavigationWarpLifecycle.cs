namespace GameBuddy.Stardew;

internal static class NavigationWarpLifecycle
{
    internal static void Settle(
        ExecutionManager executions,
        bool isLocalPlayer,
        string? oldLocation,
        string? newLocation,
        int newTileX,
        int newTileY)
    {
        ArgumentNullException.ThrowIfNull(executions);
        executions.CompleteNavigationAfterWarp(
            isLocalPlayer,
            oldLocation,
            newLocation,
            newTileX,
            newTileY);
        executions.CompleteTravelAfterWarp();
        // A plain move is not settled by the warp itself: its native path controller captured the
        // location it was planned against, so a location change releases it by name instead of
        // letting the body keep driving the actor on the old map.
        executions.InvalidateLocalMoveAfterLocationChange(oldLocation, newLocation);
    }
}
