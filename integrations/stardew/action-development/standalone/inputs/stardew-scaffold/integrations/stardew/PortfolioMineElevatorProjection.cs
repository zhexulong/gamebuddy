namespace GameBuddy.Stardew;

/// <summary>
/// Pure public-state projection of the bounded M8 elevator domain. The adapter
/// reads these facts on the game thread; this helper neither accesses game
/// state nor opens a native interaction route.
/// </summary>
internal static class PortfolioMineElevatorProjection
{
    internal const int MinimumCheckpoint = 5;
    internal const int MaximumCheckpoint = 120;

    internal static bool IsSelectableCheckpoint(int selectedCheckpoint)
        => selectedCheckpoint >= MinimumCheckpoint
            && selectedCheckpoint <= MaximumCheckpoint
            && selectedCheckpoint % 5 == 0;

    internal static bool IsUnlockedSelection(int lowestLevelReached, int selectedCheckpoint)
        => lowestLevelReached >= 0
            && IsSelectableCheckpoint(selectedCheckpoint)
            && lowestLevelReached >= selectedCheckpoint;

}
