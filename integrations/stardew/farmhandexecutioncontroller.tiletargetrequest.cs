using StardewValley;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    /// <summary>
    /// The refusal a tile-target action owes when the tile no longer holds the target its caller named: the action's own
    /// reason code and the evidence that names the tile, so the reason vocabulary stays with the action that publishes it.
    /// </summary>
    private readonly record struct TileTargetRefusal(string ReasonCode, string Evidence);

    /// <summary>
    /// The request half of a reach-and-execute action, which five of them answered with the same four statements: admit
    /// the request, read the actor's location, resolve the target on the tile (refusing it by name when it is not the one
    /// the caller named), and walk in when it is out of the native reach before running the action's own body.
    ///
    /// <para>
    /// What an action owns is the two things that actually differ: <paramref name="gate"/>, which resolves its own
    /// target and answers the refusal it owes (null when the caller's target is standing there), and
    /// <paramref name="execute"/>, its own body. <paramref name="actionId"/> is its wire identity, which the approach
    /// leg republishes in snapshots.
    /// </para>
    /// </summary>
    private LocalExecutionReceipt RequestLocalTileTarget(
        string actionId,
        string requestId,
        int targetX,
        int targetY,
        string expectedTargetId,
        long requestedDeadlineMs,
        Func<GameLocation, TileTargetRefusal?> gate,
        Func<string, string, LocalExecutionReceipt> execute)
    {
        if (this.AdmitLocalExecution(requestId, requestedDeadlineMs, AdmissionActionabilityProfile.General, out string executionId, out long nowMs) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        GameLocation location = Game1.player.currentLocation;
        if (gate(location) is TileTargetRefusal refusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, refusal.ReasonCode, refusal.Evidence);
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.TryBeginToolApproach(requestId, executionId, actionId, location, targetX, targetY, expectedTargetId, execute, nowMs, requestedDeadlineMs);
        return execute(executionId, requestId);
    }
}
