namespace GameBuddy.Stardew;

/// <summary>Pure projection of the native event-skip interaction facts.</summary>
internal static class PortfolioSkipEventProjection
{
    /// <summary>
    /// Fresh postcondition: the event is fully dismissed, the player can act
    /// freely, and no dialogue box or menu remains open.
    /// </summary>
    internal static bool IsCleanPostEventState(bool hasEvent, bool eventUp, bool dialogueUp, bool hasActiveMenu, bool playerCanMove)
        => !hasEvent && !eventUp && !dialogueUp && !hasActiveMenu && playerCanMove;
}
