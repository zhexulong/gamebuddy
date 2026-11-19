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
    ///
    /// <para>
    /// A SETTLEMENT (<see cref="Settled"/>) is the third answer, and it is neither of those: the target is not there to
    /// act on BECAUSE the state the request asked for already holds. A rock the plan meant to break but an earlier
    /// settlement already broke, a modal that is already closed - the question "is it in the state I wanted" is
    /// answered yes, and refusing it costs the caller a turn to re-observe a world that already agrees with it. Measured
    /// `round77`: seven `break_rock` nodes of `plan_619` named the seven tiles `plan_562` had broken nine seconds
    /// earlier, and one more named tile `34,9`, broken four facts before it; all eight were refused and all eight were
    /// already done. The gate mints the terminal because it is the only half that can read the live world, and the seam
    /// mints no walk to a tile there is nothing left to do on.
    /// </para>
    /// </summary>
    /// <param name="Footprint">
    /// Every tile the resolved target occupies, when its gate knows them. `<see cref="X"/>, <see cref="Y"/>` stays the
    /// anchor the action's own reach predicate is asked about, so a multi-tile subject answers both questions and the
    /// approach leg can stand beside the face it can work. Null means the target is the one tile the anchor names.
    /// </param>
    private readonly record struct TileTargetGate(
        int X,
        int Y,
        TileTargetRefusal? Refusal,
        TileTargetSettlement? Settlement = null,
        (int X, int Y)[]? Footprint = null)
    {
        /// <summary>The target resolved: the actor must reach this tile to act on it.</summary>
        internal static TileTargetGate Resolved(int x, int y) => new(x, y, null);

        /// <summary>
        /// The target resolved as a piece covering <paramref name="footprint"/> tiles, of which <paramref name="x"/>,
        /// <paramref name="y"/> is the anchor.
        /// </summary>
        internal static TileTargetGate Resolved(int x, int y, (int X, int Y)[] footprint) => new(x, y, null, null, footprint);

        /// <summary>The target cannot be acted on: this is the refusal the action owes, and no tile is walked to.</summary>
        internal static TileTargetGate Refused(TileTargetRefusal refusal) => new(0, 0, refusal);

        /// <summary>
        /// The target is already in the state the request asked for: this terminal, and no refusal and no walk.
        /// </summary>
        internal static TileTargetGate Settled(ExecutionState state, string reasonCode, string evidence) =>
            new(0, 0, null, new TileTargetSettlement(state, reasonCode, evidence));
    }

    /// <summary>One gate's answer that the request's own outcome already holds, ready to be minted as the terminal.</summary>
    private readonly record struct TileTargetSettlement(ExecutionState State, string ReasonCode, string Evidence);

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
        if (answer.Settlement is TileTargetSettlement settled)
            return this.RememberTerminal(requestId, executionId, settled.State, settled.ReasonCode, settled.Evidence);
        if (answer.Refusal is TileTargetRefusal refusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, refusal.ReasonCode, refusal.Evidence);
        if (!(inReach ?? IsTileWithinNativeReach)(Game1.player, answer.X, answer.Y))
            return this.TryBeginToolApproach(requestId, executionId, actionId, location, (answer.X, answer.Y), answer.Footprint ?? new[] { (answer.X, answer.Y) }, expectedTargetId, execute, nowMs, requestedDeadlineMs);
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
