namespace GameBuddy.Stardew;

/// <summary>Pure projection of the native ladder interaction facts.</summary>
internal static class PortfolioMineLadderProjection
{
    internal const int MinimumFloor = 1;
    internal const int MaximumFloor = 120;
    internal static bool IsSelectableCheckpoint(int floor) => floor >= MinimumFloor && floor <= MaximumFloor;
    // The target is current + 1; lowestLevelReached is a post-warp fact, not
    // an unlock prerequisite for the first descent.
    internal static bool IsLadderTarget(int lowestLevelReached, int targetFloor) => lowestLevelReached >= 0 && IsSelectableCheckpoint(targetFloor);
}
