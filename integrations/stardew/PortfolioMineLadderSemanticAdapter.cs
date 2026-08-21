using System.Security.Cryptography;
using System.Text;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

/// <summary>
/// Direct semantic edge for the bounded M8 mine-ladder action. The action
/// observes an existing ladder facility but never drives the player's UI pose
/// or movement; only the game thread owns the native transition.
/// </summary>
internal sealed class PortfolioMineLadderSemanticAdapter : IPortfolioMineLadderSemanticAdapter, IPortfolioMineLadderPendingOwner
{
    private readonly PortfolioConfig config;
    private readonly Func<bool> isBindingCurrent;
    private readonly Func<long> nextRevision;
    private readonly Func<PortfolioMineLadderTransitionStartedObservation, bool> observeTransitionStarted;
    private readonly Func<PortfolioMineLadderPostconditionObservation, PortfolioMineLadderActionReceipt> observePostcondition;
    private readonly Func<string, string, string, string, long, PortfolioScope, PortfolioMineLadderActionReceipt> fail;
    private readonly Func<string, bool> armNativeTransition;
    private PendingExecution? pending;

    internal PortfolioMineLadderSemanticAdapter(
        PortfolioConfig config,
        Func<bool> isBindingCurrent,
        Func<long> nextRevision,
        Func<PortfolioMineLadderTransitionStartedObservation, bool> observeTransitionStarted,
        Func<PortfolioMineLadderPostconditionObservation, PortfolioMineLadderActionReceipt> observePostcondition,
        Func<string, string, string, string, long, PortfolioScope, PortfolioMineLadderActionReceipt> fail,
        Func<string, bool> armNativeTransition)
    {
        this.config = config;
        this.isBindingCurrent = isBindingCurrent;
        this.nextRevision = nextRevision;
        this.observeTransitionStarted = observeTransitionStarted;
        this.observePostcondition = observePostcondition;
        this.fail = fail;
        this.armNativeTransition = armNativeTransition;
    }

    internal PortfolioMineLadderFreshObservation CreateFreshObservation(
        PortfolioMineLadderActionRequest request, PortfolioScope scope, long revision)
    {
        bool playerAvailable = Game1.player is not null && Game1.player.UniqueMultiplayerID.ToString() == scope.LocalPlayerId;
        bool worldReady = Context.IsWorldReady && Game1.hasLoadedGame;
        bool singlePlayer = !Context.IsMultiplayer && Game1.IsMasterGame && Game1.getAllFarmers().Count() == 1
            && Game1.player is not null && Game1.player.UniqueMultiplayerID == Game1.MasterPlayer.UniqueMultiplayerID;
        bool policyAllowed = this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineLadderAction);
        int currentFloor = 0;
        int lowestMineLevel = 0;
        bool mineEntryObserved = false;
        bool ladderObserved = false;
        if (worldReady && singlePlayer && Game1.player?.currentLocation is MineShaft mine)
        {
            mineEntryObserved = true;
            currentFloor = mine.mineLevel;
            lowestMineLevel = MineShaft.lowestLevelReached;
            ladderObserved = HasLadderFacility(mine);
        }
        int targetFloor = currentFloor + 1;
        bool checkpointValid = PortfolioMineLadderProjection.IsSelectableCheckpoint(targetFloor);
        string opaqueCorrelationId = BuildOpaqueCorrelationId(request.RequestId, request.TraceId, scope, revision,
            targetFloor, currentFloor, lowestMineLevel);
        return new PortfolioMineLadderFreshObservation(
            request.RequestId, request.TraceId, revision, scope, Fresh: true,
            PlayerAvailable: playerAvailable && singlePlayer, WorldReady: worldReady, PolicyAllowed: policyAllowed,
            MineEntryObserved: mineEntryObserved, CurrentFloor: currentFloor, LowestMineLevel: lowestMineLevel,
            UnlockedLevelObserved: mineEntryObserved && checkpointValid,
            TargetUnlocked: mineEntryObserved && lowestMineLevel >= targetFloor,
            LadderObserved: ladderObserved, OpaqueLadderTarget: opaqueCorrelationId, TargetFloor: targetFloor);
    }

    internal bool TryReadTerminalFreshFloor(PortfolioMineLadderFreshFloorRequest request, PortfolioScope scope,
        int targetFloor, long currentRevision, out PortfolioMineLadderFreshFloor? floor)
    {
        floor = null;
        if (request is null || !request.IsValid || !request.Scope.Equals(scope)
            || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= request.DeadlineMs
            || !this.TryReadLiveFacts(scope, targetFloor, allowSelectedFloor: true, requireLadderFacility: false,
                out int currentFloor, out int lowestMineLevel)
            || currentFloor != targetFloor || currentRevision <= request.ExpectedRevision)
            return false;
        floor = new PortfolioMineLadderFreshFloor(request.RequestId, request.TraceId, request.ExecutionId,
            scope, currentRevision, Fresh: true, currentFloor, lowestMineLevel);
        return true;
    }

    public bool IsAvailable => this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineLadderAction)
        && Context.IsWorldReady && Game1.hasLoadedGame && this.isBindingCurrent();

    public bool RequestMineLadder(PortfolioMineLadderAdapterContext context,
        out PortfolioMineLadderAdapterResult? result)
    {
        result = null;
        PendingExecution? existing = this.pending;
        if (existing is not null && !Matches(existing, context))
            return false;
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= context.DeadlineMs
            || !this.TryReadLiveFacts(context.Scope, context.TargetFloor, allowSelectedFloor: false,
                requireLadderFacility: true, out _, out _)
            || Game1.player?.currentLocation is not MineShaft oldMine)
            return false;

        Farmer player = Game1.player!;
        PendingExecution candidate = existing ?? new PendingExecution(context.RequestId, context.TraceId, context.Scope,
            context.OpaqueLadderTarget, context.TargetFloor, context.ExpectedRevision, context.DeadlineMs,
            context.CancellationToken, player, oldMine, oldMine.Name, oldMine.mineLevel, -1, EdgeGeneration: 0)
        { ExecutionId = context.ExecutionId };
        candidate = candidate with { ExecutionId = context.ExecutionId };
        this.pending = candidate;
        if (!this.TryIssueNativeTransition(candidate, context, out bool edgeIssued))
        {
            this.DiscardPending(context.ExecutionId);
            return false;
        }
        result = new PortfolioMineLadderAdapterResult(context.RequestId, context.TraceId, context.ExecutionId,
            context.Scope, context.ExpectedRevision, context.OpaqueLadderTarget, context.TargetFloor, TransitionArmed: true);
        return true;
    }

    private bool TryIssueNativeTransition(PendingExecution candidate, PortfolioMineLadderAdapterContext context, out bool edgeIssued)
    {
        edgeIssued = false;
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= context.DeadlineMs
            || !this.TryReadLiveFacts(context.Scope, context.TargetFloor, allowSelectedFloor: false,
                requireLadderFacility: true, out _, out _)
            || !ReferenceEquals(Game1.currentLocation, candidate.Player.currentLocation)
            || Game1.locationRequest is not null)
            return false;

        PendingExecution beforeArm = candidate with { NativeCallInProgress = true };
        this.pending = beforeArm;
        if (!this.armNativeTransition(candidate.ExecutionId))
            return false;
        edgeIssued = true;
        PendingExecution? armedBeforeNative = this.pending;
        if (armedBeforeNative is null || !Matches(armedBeforeNative, context)
            || armedBeforeNative.ExecutionId != candidate.ExecutionId || !armedBeforeNative.NativeCallInProgress
            || armedBeforeNative.EdgeIssued || !this.isBindingCurrent())
            return false;

        candidate = armedBeforeNative with { EdgeGeneration = armedBeforeNative.EdgeGeneration + 1, EdgeIssuedTick = Game1.ticks };
        this.pending = candidate;
        try
        {
            candidate.OldMine.playSound("stairsdown");
            Game1.enterMine(context.TargetFloor);
        }
        catch { return false; }

        PendingExecution? armed = this.pending;
        LocationRequest? request = Game1.locationRequest;
        if (armed is null || !Matches(armed, context) || armed.EdgeGeneration != candidate.EdgeGeneration
            || armed.EdgeIssuedTick > Game1.ticks || request is null
            || !MatchesExpectedRequest(request, context.TargetFloor) || !ReferenceEquals(Game1.locationRequest, request))
            return false;
        PendingExecution pending = armed with { NativeCallInProgress = false, NativeRequest = request };
        LocationRequest.Callback? handler = null;
        handler = () => this.ObserveNativeRequestWarp(pending, request, handler!);
        pending = pending with { NativeRequestHandler = handler };
        this.pending = pending;
        request.OnWarp += handler;
        return true;
    }

    private void ObserveNativeRequestWarp(PendingExecution candidate, LocationRequest request, LocationRequest.Callback handler)
    {
        PendingExecution? current = this.pending;
        if (current is null || !ReferenceEquals(current, candidate) || current.NativeRequestCompleted
            || !ReferenceEquals(current.NativeRequest, request))
            return;
        bool retainedForWarped = false;
        try
        {
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= current.DeadlineMs || !this.isBindingCurrent()
                || Game1.player is null || !ReferenceEquals(Game1.locationRequest, request)
                || !MatchesExpectedRequest(request, current.TargetFloor) || request.Location is not MineShaft target
                || !ReferenceEquals(Game1.player.currentLocation, target))
            {
                TryFail(current);
                return;
            }
            current = current with { NativeRequestCompleted = true, TransitionRevision = this.nextRevision() };
            this.pending = current;
            PortfolioMineLadderTransitionStartedObservation transition = new(current.RequestId, current.TraceId,
                current.ExecutionId, current.TransitionRevision, current.Scope, Fresh: true, PlayerAvailable: true,
                WorldReady: true, PolicyAllowed: true, MineEntryObserved: true, NativeLadderTransitionObserved: true,
                current.OpaqueTarget, current.TargetFloor);
            if (!this.observeTransitionStarted(transition))
            {
                TryFail(current);
                return;
            }
            retainedForWarped = true;
        }
        catch { TryFail(current); }
        finally
        {
            request.OnWarp -= handler;
            if (retainedForWarped && this.pending is PendingExecution retained && retained.ExecutionId == current.ExecutionId)
                this.pending = retained with { NativeRequestHandler = null };
            else if (!retainedForWarped)
                DiscardPending(current.ExecutionId);
        }
    }

    /// <summary>Settles only an armed native edge whose continuation did not arrive.</summary>
    internal void Watchdog(long nowMs)
    {
        PendingExecution? candidate = this.pending;
        if (candidate is null || nowMs < candidate.DeadlineMs)
            return;
        TryFail(candidate);
        if (this.pending is PendingExecution current && current.ExecutionId == candidate.ExecutionId)
            DiscardPending(candidate.ExecutionId);
    }

    internal void ObserveWarped(WarpedEventArgs args)
    {
        PendingExecution? candidate = this.pending;
        if (candidate is null || !candidate.NativeRequestCompleted || !MatchesWarp(candidate, args))
            return;
        try
        {
            if (!this.TryReadLiveFacts(candidate.Scope, candidate.TargetFloor, allowSelectedFloor: true,
                    requireLadderFacility: false, out int actualFloor, out int lowestMineLevel)
                || actualFloor != candidate.TargetFloor || lowestMineLevel < candidate.TargetFloor
                || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= candidate.DeadlineMs)
            {
                TryFail(candidate);
                return;
            }
            PortfolioMineLadderPostconditionObservation postcondition = new(candidate.RequestId, candidate.TraceId,
                candidate.ExecutionId, this.nextRevision(), candidate.Scope, Fresh: true, PlayerAvailable: true,
                WorldReady: true, PolicyAllowed: true, MineEntryObserved: true, ActualCurrentFloor: actualFloor,
                LowestMineLevel: lowestMineLevel, LowestMineLevelObserved: true, candidate.OpaqueTarget, candidate.TargetFloor);
            _ = this.observePostcondition(postcondition);
        }
        catch { TryFail(candidate); }
        finally { DiscardPending(candidate.ExecutionId); }
    }

    private bool TryReadLiveFacts(PortfolioScope scope, int targetFloor, bool allowSelectedFloor,
        bool requireLadderFacility, out int currentFloor, out int lowestMineLevel)
    {
        currentFloor = 0;
        lowestMineLevel = 0;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineLadderAction)
            || !this.isBindingCurrent() || !Context.IsWorldReady || !Game1.hasLoadedGame
            || Context.IsMultiplayer || !Game1.IsMasterGame || Game1.getAllFarmers().Count() != 1
            || Game1.player is null || Game1.player.UniqueMultiplayerID != Game1.MasterPlayer.UniqueMultiplayerID
            || Game1.player.UniqueMultiplayerID.ToString() != scope.LocalPlayerId
            || !ReferenceEquals(Game1.currentLocation, Game1.player.currentLocation)
            || Game1.player.currentLocation is not MineShaft mine
            || Game1.CurrentEvent is not null || Game1.eventUp || Game1.dialogueUp
            || Game1.activeClickableMenu is not null || !Game1.player.CanMove)
            return false;
        currentFloor = mine.mineLevel;
        lowestMineLevel = MineShaft.lowestLevelReached;
        if (currentFloor < 0 || currentFloor > PortfolioBridgeProtocol.MineLadderMaximumFloor
            || lowestMineLevel < currentFloor || !PortfolioMineLadderProjection.IsSelectableCheckpoint(targetFloor)
            || (requireLadderFacility && !HasLadderFacility(mine)))
            return false;
        return allowSelectedFloor ? currentFloor == targetFloor && lowestMineLevel >= targetFloor
            : targetFloor == currentFloor + 1;
    }

    private static bool HasLadderFacility(MineShaft mine)
    {
        var layer = mine.map?.GetLayer("Buildings");
        if (layer is null)
            return false;
        for (int x = 0; x < layer.LayerWidth; x++)
        for (int y = 0; y < layer.LayerHeight; y++)
            if (mine.getTileIndexAt(new xTile.Dimensions.Location(x, y), "Buildings") == 173)
                return true;
        return false;
    }

    private void TryFail(PendingExecution candidate)
    {
        try { _ = this.fail(candidate.RequestId, candidate.TraceId, candidate.ExecutionId,
            candidate.EdgeIssued ? "native_operation_uncertain" : "native_operation_failed",
            this.nextRevision(), candidate.Scope); }
        catch { }
    }

    internal void DiscardPendingForInvalidation()
    {
        PendingExecution? candidate = this.pending;
        if (candidate?.NativeRequest is LocationRequest request && candidate.NativeRequestHandler is LocationRequest.Callback handler)
            request.OnWarp -= handler;
        this.pending = null;
    }

    public void DiscardPending(string executionId)
    {
        PendingExecution? candidate = this.pending;
        if (candidate is null || candidate.ExecutionId != executionId)
            return;
        if (candidate.NativeRequest is LocationRequest request && candidate.NativeRequestHandler is LocationRequest.Callback handler)
            request.OnWarp -= handler;
        this.pending = null;
    }

    private static bool MatchesExpectedRequest(LocationRequest request, int targetFloor)
        => request.Name == MineShaft.GetLevelName(targetFloor) && request.Location is MineShaft target && target.mineLevel == targetFloor;

    private static bool Matches(PendingExecution candidate, PortfolioMineLadderAdapterContext context)
        => candidate.RequestId == context.RequestId && candidate.TraceId == context.TraceId && candidate.Scope.Equals(context.Scope)
            && candidate.OpaqueTarget == context.OpaqueLadderTarget && candidate.TargetFloor == context.TargetFloor
            && candidate.ExpectedRevision == context.ExpectedRevision && candidate.DeadlineMs == context.DeadlineMs
            && candidate.CancellationToken == context.CancellationToken;

    private static bool MatchesWarp(PendingExecution candidate, WarpedEventArgs args)
        => candidate.EdgeIssued && args.Player == candidate.Player && args.OldLocation == candidate.OldMine
            && args.NewLocation == candidate.NativeRequest?.Location && args.NewLocation is MineShaft mine
            && mine.mineLevel == candidate.TargetFloor && args.Player.currentLocation == args.NewLocation
            && candidate.EdgeIssuedTick <= Game1.ticks;

    private static string BuildOpaqueCorrelationId(string requestId, string traceId, PortfolioScope scope, long revision,
        int targetFloor, int currentFloor, int lowestMineLevel)
    {
        string canonicalFacts = string.Join("\n", new[] { "requestId=" + requestId, "traceId=" + traceId,
            "scope.integrationId=" + scope.IntegrationId, "scope.topology=" + scope.Topology,
            "scope.saveId=" + scope.SaveId, "scope.worldId=" + scope.WorldId,
            "scope.localPlayerId=" + scope.LocalPlayerId, "scope.companionId=" + scope.CompanionId,
            "scope.bindingGeneration=" + scope.BindingGeneration, "scope.bindingHash=" + scope.BindingHash,
            "revision=" + revision, "targetFloor=" + targetFloor, "currentFloor=" + currentFloor,
            "lowestMineLevel=" + lowestMineLevel });
        return "mine_ladder_correlation_" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalFacts))).ToLowerInvariant();
    }

    private sealed record PendingExecution(string RequestId, string TraceId, PortfolioScope Scope, string OpaqueTarget,
        int TargetFloor, long ExpectedRevision, long DeadlineMs, string CancellationToken, Farmer Player, MineShaft OldMine,
        string OldMineName, int OldMineFloor, int EdgeIssuedTick, long EdgeGeneration)
    {
        internal string ExecutionId { get; init; } = string.Empty;
        internal long TransitionRevision { get; init; }
        internal bool NativeCallInProgress { get; init; }
        internal LocationRequest? NativeRequest { get; init; }
        internal LocationRequest.Callback? NativeRequestHandler { get; init; }
        internal bool NativeRequestCompleted { get; init; }
        internal bool EdgeIssued => EdgeGeneration > 0;
    }
}
