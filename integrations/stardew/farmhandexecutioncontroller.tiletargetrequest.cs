using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    private readonly record struct TileTargetRefusal(string ReasonCode, string? Evidence);

    /// <summary>
    /// What one action's own gate answers about the target it was asked for: the tile the actor must be able to reach to
    /// act on it, or the refusal the action owes when that target is not there to act on.
    ///
    /// <para>
    /// WHICH TILE IS THE GATE'S ANSWER, NOT THE REQUEST'S, and that is the one fact that separates the two shapes this
    /// seam serves. A target that stands where the caller said it stands - a machine, a bush, a fence gate - is addressed
    /// by the request's own <c>x, y</c>, so its gate answers with that same tile. A subject that WALKS - a Pet, a
    /// FarmAnimal, a villager - is addressed by its opaque id and stands wherever it stands on the game thread NOW, so
    /// only the lookup knows the tile, and the tile a snapshot published is where the subject used to be.
    /// </para>
    ///
    /// <para>
    /// A refusal carries no tile (<see cref="Refused"/> writes none, and the seam returns the refusal before it reads
    /// one) because there is nothing to walk to: the target is gone or cannot be acted on, which is a different answer
    /// from "walk closer".
    /// </para>
    /// </summary>
    private readonly record struct TileTargetGate(int X, int Y, TileTargetRefusal? Refusal)
    {
        /// <summary>The target resolved: the actor must reach this tile to act on it.</summary>
        internal static TileTargetGate Resolved(int x, int y) => new(x, y, null);

        /// <summary>The target cannot be acted on: this is the refusal the action owes, and no tile is walked to.</summary>
        internal static TileTargetGate Refused(TileTargetRefusal refusal) => new(0, 0, refusal);
    }

    private LocalExecutionReceipt RequestLocalTileTarget(
        string actionId,
        string requestId,
        string expectedTargetId,
        long requestedDeadlineMs,
        AdmissionActionabilityProfile profile,
        Func<GameLocation, TileTargetGate> gate,
        Func<string, string, LocalExecutionReceipt> execute,
        Func<TileTargetRefusal?>? authorize,
        Func<Farmer, int, int, bool>? inReach = null)
    {
        if (this.BeginLocalExecution(requestId, out string executionId, out long nowMs) is LocalExecutionReceipt replay)
            return replay;
        if (authorize?.Invoke() is TileTargetRefusal unauthorized)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, unauthorized.ReasonCode, unauthorized.Evidence);
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, profile) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        GameLocation location = Game1.player.currentLocation;
        TileTargetGate answer = gate(location);
        if (answer.Refusal is TileTargetRefusal refusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, refusal.ReasonCode, refusal.Evidence);
        if (!(inReach ?? IsTileWithinNativeReach)(Game1.player, answer.X, answer.Y))
            return this.TryBeginToolApproach(requestId, executionId, actionId, location, answer.X, answer.Y, expectedTargetId, execute, nowMs, requestedDeadlineMs);
        return execute(executionId, requestId);
    }

    private LocalExecutionReceipt RequestLocalTileTarget(
        string actionId,
        string requestId,
        string expectedTargetId,
        long requestedDeadlineMs,
        AdmissionActionabilityProfile profile,
        Func<GameLocation, TileTargetGate> gate,
        Func<string, string, LocalExecutionReceipt> execute) =>
        this.RequestLocalTileTarget(actionId, requestId, expectedTargetId, requestedDeadlineMs, profile, gate, execute, this.AuthorizeActorOnReadyWorld);

    private LocalExecutionReceipt RequestLocalTileTarget(
        string actionId,
        string requestId,
        int targetX,
        int targetY,
        string expectedTargetId,
        long requestedDeadlineMs,
        AdmissionActionabilityProfile profile,
        Func<GameLocation, TileTargetRefusal?>? gate,
        Func<Farmer, int, int, bool> inReach,
        Func<string, string, LocalExecutionReceipt> execute,
        Func<TileTargetRefusal?>? authorize = null) =>
        this.RequestLocalTileTarget(
            actionId,
            requestId,
            expectedTargetId,
            requestedDeadlineMs,
            profile,
            location => gate?.Invoke(location) is TileTargetRefusal refusal
                ? TileTargetGate.Refused(refusal)
                : TileTargetGate.Resolved(targetX, targetY),
            execute,
            authorize,
            inReach);

    private TileTargetRefusal? AuthorizeActorOnReadyWorld()
    {
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return new TileTargetRefusal(scopeReason, null);
        return Context.IsWorldReady && Game1.player is not null && Game1.player.currentLocation is not null
            ? null
            : new TileTargetRefusal("world_not_ready", null);
    }

    private TileTargetRefusal? AuthorizeActorOnFarmstead()
    {
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return new TileTargetRefusal(scopeReason, null);
        return Context.IsWorldReady && Game1.player is not null && Game1.player.currentLocation is Farm
            ? null
            : new TileTargetRefusal("farm_required", $"location={(Game1.player?.currentLocation?.NameOrUniqueName ?? "none")}");
    }

    private static bool IsTileWithinNativeReach(Farmer actor, int x, int y) => IsTileWithinChebyshevRadius(actor, x, y, 1);
}
