namespace GameBuddy.Stardew;

/// <summary>Pure projection of the native ladder interaction facts.</summary>
internal static class PortfolioMineLadderProjection
{
    internal const int MinimumFloor = 1;
    internal const int MaximumFloor = 120;
    internal static bool IsSelectableCheckpoint(int floor) => floor >= MinimumFloor && floor <= MaximumFloor;
    // Pre-effect admission mirrors MineShaft.checkAction case 173. The target
    // floor is current + 1; lowestLevelReached is a post-warp fact, not an
    // unlock prerequisite for the first descent.
    internal static bool IsLadderTarget(int lowestLevelReached, int targetFloor) => lowestLevelReached >= 0 && IsSelectableCheckpoint(targetFloor);
    internal static bool IsAccessibleLadderInteraction(bool isLocalPlayer, bool grabTileReachable, int mineLevel, int buildingsTileIndex)
        => isLocalPlayer && grabTileReachable && mineLevel >= 0 && mineLevel < MaximumFloor && buildingsTileIndex == 173;
}
