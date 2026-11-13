using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    /// <summary>
    /// The refusal a request half owes before its body runs: the target is not the one the caller named, or the caller
    /// may not act on it at all. The reason code and the evidence stay the action's own, so each condition is published
    /// by the action that owns it; only the step that turns the refusal into a terminal lives in the seam.
    /// </summary>
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

    /// <summary>
    /// The request half of a reach-and-execute action: mint the execution identity, refuse a caller that may not act,
    /// admit, resolve the target on the tile (refusing it by name when it is not the one the caller named), walk in when
    /// it is out of the native reach, and run the action's own body.
    ///
    /// <para>
    /// FIVE FACTS, FIVE QUESTIONS, and an action that reaches this seam answers all five. <paramref name="profile"/> is
    /// the actionability its admission rules on. <paramref name="authorize"/> proves who is asking and that the world its
    /// body reads is there, and it runs BEFORE the admission: that order is observable, because a caller outside the
    /// execution scope must read <c>execution_scope_mismatch</c> rather than the hold the admission would have named.
    /// Null means the action admits at the top. <paramref name="gate"/> resolves its target and answers the tile it
    /// stands on or the refusal it owes. <paramref name="inReach"/> is the radius its own native call needs; null means
    /// the native interaction radius, one Chebyshev step. <paramref name="execute"/> is its body.
    /// <paramref name="actionId"/> is its wire identity, which the approach leg republishes in snapshots and
    /// <paramref name="requestId"/> the identity the dispatch bound.
    /// </para>
    /// </summary>
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

    /// <summary>
    /// The form an actor-bound action whose subject WALKS takes: it hands the seam its gate and its body, and the
    /// scope-bound actor proof runs before the admission because that proof is part of this shape rather than a
    /// per-action option - every walking subject was resolved only after it, so a request from outside the execution
    /// scope has to read <c>execution_scope_mismatch</c> rather than the hold the admission would have named.
    /// </summary>
    private LocalExecutionReceipt RequestLocalTileTarget(
        string actionId,
        string requestId,
        string expectedTargetId,
        long requestedDeadlineMs,
        AdmissionActionabilityProfile profile,
        Func<GameLocation, TileTargetGate> gate,
        Func<string, string, LocalExecutionReceipt> execute) =>
        this.RequestLocalTileTarget(actionId, requestId, expectedTargetId, requestedDeadlineMs, profile, gate, execute, this.AuthorizeActorOnReadyWorld);

    /// <summary>
    /// The same seam for the actions whose target is placed on the tile the request itself names: the gate answers only
    /// the refusal it owes, the tile the actor must reach is the one the caller addressed, and the reach test reads that
    /// same tile - which is why this form takes the reach predicate rather than inheriting the native radius. Whether the
    /// caller is authorized before the admission is a fact about the action here, not about the shape: <c>null</c> says
    /// it admits at the top.
    /// </summary>
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

    /// <summary>
    /// The authorization half for an actor-bound action whose body reads nothing but the actor's current location: the
    /// scope-bound actor proof, then the world readiness those reads need. Both refusals are the vocabulary this class
    /// already publishes - <c>execution_scope_mismatch</c>/<c>world_not_ready</c> - so the request halves that owe them
    /// cannot spell them differently.
    /// </summary>
    private TileTargetRefusal? AuthorizeActorOnReadyWorld()
    {
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return new TileTargetRefusal(scopeReason, null);
        return Context.IsWorldReady && Game1.player is not null && Game1.player.currentLocation is not null
            ? null
            : new TileTargetRefusal("world_not_ready", null);
    }

    /// <summary>
    /// The same proof for an action that can only run on the actor's own farmstead. The world half is ONE refusal:
    /// <c>farm_required</c> covers a world that is not ready and a location that is not a farm alike, because both leave
    /// the body with nothing to act on and the caller's answer is the same either way.
    /// </summary>
    private TileTargetRefusal? AuthorizeActorOnFarmstead()
    {
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return new TileTargetRefusal(scopeReason, null);
        return Context.IsWorldReady && Game1.player is not null && Game1.player.currentLocation is Farm
            ? null
            : new TileTargetRefusal("farm_required", $"location={(Game1.player?.currentLocation?.NameOrUniqueName ?? "none")}");
    }

    /// <summary>The native interaction radius this seam's approach legs exist to satisfy: one Chebyshev step.</summary>
    private static bool IsTileWithinNativeReach(Farmer actor, int x, int y) => IsTileWithinChebyshevRadius(actor, x, y, 1);
}
