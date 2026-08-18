namespace GameBuddy.Stardew;

/// <summary>Pure projection of the native entry interaction facts.</summary>
internal static class PortfolioMineEntryProjection
{
    internal const int MinimumFloor = 1;
    internal const int MaximumFloor = 1;
    internal static bool IsSelectableCheckpoint(int floor) => floor >= MinimumFloor && floor <= MaximumFloor;
    // Maps/Mine Buildings Action=Mine omits its optional floor argument, so
    // GameLocation.performAction always enters the fixed native default floor.
    internal static bool IsEntryTarget(int targetFloor) => targetFloor == MinimumFloor;
    internal static bool IsAccessibleEntryInteraction(bool isLocalPlayer, bool grabTileReachable, bool ordinaryMineAction)
        => isLocalPlayer && grabTileReachable && ordinaryMineAction;
}
