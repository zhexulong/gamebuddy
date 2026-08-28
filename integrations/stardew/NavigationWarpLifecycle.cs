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
    }
}
