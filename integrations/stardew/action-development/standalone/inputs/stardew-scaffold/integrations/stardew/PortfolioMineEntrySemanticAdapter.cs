using System.Security.Cryptography;
using System.Text;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

/// <summary>
/// Target-version semantic edge for the bounded M8 mine-entry action. All
/// facts and the native call are owned by the game thread; the bridge supplies
/// only the immutable execution authority tuple.
/// </summary>
internal sealed class PortfolioMineEntrySemanticAdapter : IPortfolioMineEntrySemanticAdapter, IPortfolioMineEntryPendingOwner
{
    private readonly PortfolioConfig config;
    private readonly Func<bool> isBindingCurrent;
    private readonly Func<long> nextRevision;
    private readonly Func<PortfolioMineEntryTransitionStartedObservation, bool> observeTransitionStarted;
    private readonly Func<PortfolioMineEntryPostconditionObservation, PortfolioMineEntryActionReceipt> observePostcondition;
    private readonly Func<string, string, string, string, long, PortfolioScope, PortfolioMineEntryActionReceipt> fail;
    private readonly Func<string, bool> armNativeTransition;
    private PendingExecution? pending;

    internal PortfolioMineEntrySemanticAdapter(
        PortfolioConfig config,
        Func<bool> isBindingCurrent,
        Func<long> nextRevision,
        Func<PortfolioMineEntryTransitionStartedObservation, bool> observeTransitionStarted,
        Func<PortfolioMineEntryPostconditionObservation, PortfolioMineEntryActionReceipt> observePostcondition,
        Func<string, string, string, string, long, PortfolioScope, PortfolioMineEntryActionReceipt> fail,
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

    internal PortfolioMineEntryFreshObservation CreateFreshObservation(
        PortfolioMineEntryActionRequest request,
        PortfolioScope scope,
        long revision)
    {
        bool playerAvailable = Game1.player is not null
            && Game1.player.UniqueMultiplayerID.ToString() == scope.LocalPlayerId;
        bool worldReady = Context.IsWorldReady && Game1.hasLoadedGame;
        bool singlePlayer = !Context.IsMultiplayer && Game1.IsMasterGame
            && Game1.getAllFarmers().Count() == 1
            && Game1.player is not null
            && Game1.player.UniqueMultiplayerID == Game1.MasterPlayer.UniqueMultiplayerID;
        bool policyAllowed = this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineEntryAction);
        int currentFloor = 0;
        int lowestMineLevel = 0;
        // The typed action's Given is the ordinary Mine exterior. The map's
        // Action=Mine checkAction ingress is provenance for normal player UI,
        // not a precondition of the direct Game1.enterMine(1) native seam.
        bool mineEntryObserved = worldReady && singlePlayer && Game1.player is not null
            && IsOrdinaryMineExterior(Game1.player);
        if (worldReady && singlePlayer && Game1.player is not null)
            lowestMineLevel = MineShaft.lowestLevelReached;
        int targetFloor = PortfolioBridgeProtocol.MineEntryMinimumFloor;
        bool checkpointValid = PortfolioMineEntryProjection.IsSelectableCheckpoint(targetFloor);
        bool targetUnlocked = mineEntryObserved && checkpointValid;
        string opaqueCorrelationId = BuildOpaqueCorrelationId(
            request.RequestId, request.TraceId, scope, revision, targetFloor,
            currentFloor, lowestMineLevel);
        return new PortfolioMineEntryFreshObservation(
            request.RequestId, request.TraceId, revision, scope,
            Fresh: true,
            PlayerAvailable: playerAvailable && singlePlayer,
            WorldReady: worldReady,
            PolicyAllowed: policyAllowed,
            MineEntryObserved: mineEntryObserved,
            CurrentFloor: currentFloor,
            LowestMineLevel: lowestMineLevel,
            UnlockedLevelObserved: mineEntryObserved && checkpointValid,
            TargetUnlocked: targetUnlocked,
            OpaqueEntryTarget: opaqueCorrelationId,
            TargetFloor: targetFloor);
    }

    internal bool TryReadTerminalFreshFloor(PortfolioMineEntryFreshFloorRequest request, PortfolioScope scope,
        int targetFloor, long currentRevision, out PortfolioMineEntryFreshFloor? floor)
    {
        floor = null;
        if (request is null || !request.IsValid || !request.Scope.Equals(scope)
            || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= request.DeadlineMs
            || !this.TryReadLiveFacts(scope, targetFloor, allowSelectedFloor: true, out int currentFloor, out int lowestMineLevel)
            || currentFloor != targetFloor
            || currentRevision <= request.ExpectedRevision)
            return false;
        floor = new PortfolioMineEntryFreshFloor(request.RequestId, request.TraceId, request.ExecutionId,
            scope, currentRevision, Fresh: true, currentFloor, lowestMineLevel);
        return true;
    }

    public bool IsAvailable => this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineEntryAction)
        && Context.IsWorldReady && Game1.hasLoadedGame && this.isBindingCurrent();

    public bool RequestMineEntry(
        PortfolioMineEntryAdapterContext context,
        out PortfolioMineEntryAdapterResult? result)
    {
        result = null;
        PendingExecution? existing = this.pending;
        if (existing is not null && !Matches(existing, context))
            return false;
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= context.DeadlineMs
            || !this.TryReadLiveFacts(context.Scope, context.TargetFloor, allowSelectedFloor: false, out _, out _))
            return false;

        Farmer player = Game1.player!;
        GameLocation oldLocation = player.currentLocation;
        PendingExecution candidate = existing ?? new PendingExecution(
            context.RequestId, context.TraceId, context.Scope, context.OpaqueEntryTarget,
            context.TargetFloor, context.ExpectedRevision, context.DeadlineMs,
            context.CancellationToken,
            player, oldLocation, oldLocation.Name, -1, EdgeGeneration: 0) { ExecutionId = context.ExecutionId };
        candidate = candidate with { ExecutionId = context.ExecutionId };

        this.pending = candidate;
        if (!this.TryIssueNativeTransition(candidate, context, out _))
        {
            this.DiscardPending(context.ExecutionId);
            return false;
        }
        result = new PortfolioMineEntryAdapterResult(
            context.RequestId, context.TraceId, context.ExecutionId, context.Scope,
            context.ExpectedRevision, context.OpaqueEntryTarget, context.TargetFloor,
            TransitionArmed: true);
        return true;
    }

    private bool TryIssueNativeTransition(PendingExecution candidate, PortfolioMineEntryAdapterContext context, out bool edgeIssued)
    {
        edgeIssued = false;
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= context.DeadlineMs
            || !this.TryReadLiveFacts(context.Scope, context.TargetFloor, allowSelectedFloor: false, out _, out _)
            || !ReferenceEquals(Game1.currentLocation, candidate.Player.currentLocation))
            return false;

        LocationRequest? previousRequest = Game1.locationRequest;
        PendingExecution beforeArm = candidate with { NativeCallInProgress = true };
        this.pending = beforeArm;
        if (!this.armNativeTransition(candidate.ExecutionId))
            return false;
        // ArmNativeTransition may synchronously re-enter cancellation or
        // invalidation. Never reconstruct pending state after that callback:
        // only the exact still-owned, un-cancelled execution may cross the
        // native call boundary. Once arm succeeded, any failed re-check is
        // uncertain because the coordinator has reserved the native edge.
        edgeIssued = true;
        PendingExecution? armedBeforeNative = this.pending;
        if (armedBeforeNative is null
            || !Matches(armedBeforeNative, context)
            || armedBeforeNative.ExecutionId != candidate.ExecutionId
            || !armedBeforeNative.NativeCallInProgress
            || armedBeforeNative.EdgeIssued
            || !this.isBindingCurrent())
            return false;

        candidate = armedBeforeNative with
        {
            EdgeGeneration = armedBeforeNative.EdgeGeneration + 1,
            EdgeIssuedTick = Game1.ticks
        };
        this.pending = candidate;
        try
        {
            // This is the complete native edge for M8: no menu, input,
            // dispatcher, direct warp, reflection, or save mutation.
            Game1.currentLocation.playSound("stairsdown");
            Game1.enterMine(PortfolioBridgeProtocol.MineEntryMinimumFloor);
        }
        catch
        {
            return false;
        }

        // enterMine only schedules the native LocationRequest. Do not publish a
        // transition phase until that exact request reports its own completion.
        PendingExecution? armed = this.pending;
        LocationRequest? request = Game1.locationRequest;
        if (armed is null || !Matches(armed, context)
            || armed.EdgeGeneration != candidate.EdgeGeneration
            || armed.EdgeIssuedTick > Game1.ticks
            || request is null || ReferenceEquals(request, previousRequest)
            || !MatchesExpectedRequest(request, context.TargetFloor)
            || !ReferenceEquals(Game1.locationRequest, request))
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
        if (current is null || !ReferenceEquals(current, candidate)
            || !Matches(current, new PortfolioMineEntryAdapterContext(
                candidate.RequestId, candidate.TraceId, candidate.ExecutionId, candidate.CancellationToken,
                candidate.Scope, candidate.OpaqueTarget, candidate.TargetFloor,
                candidate.ExpectedRevision, candidate.DeadlineMs))
            || current.NativeRequestCompleted || !ReferenceEquals(current.NativeRequest, request))
            return;

        bool retainedForWarped = false;
        try
        {
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= current.DeadlineMs
                || !this.isBindingCurrent()
                || Game1.player is null
                || !ReferenceEquals(Game1.locationRequest, request)
                || !MatchesExpectedRequest(request, current.TargetFloor)
                || request.Location is not MineShaft target
                || !ReferenceEquals(Game1.player.currentLocation, target))
            {
                TryFail(current);
                return;
            }

            current = current with { NativeRequestCompleted = true, TransitionRevision = this.nextRevision() };
            this.pending = current;
            PortfolioMineEntryTransitionStartedObservation transition = new(
                current.RequestId, current.TraceId, current.ExecutionId, current.TransitionRevision, current.Scope,
                Fresh: true, PlayerAvailable: true, WorldReady: true, PolicyAllowed: true,
                MineEntryObserved: true, NativeEntryTransitionObserved: true,
                current.OpaqueTarget, current.TargetFloor);
            bool observed;
            try
            {
                observed = this.observeTransitionStarted(transition);
            }
            catch
            {
                TryFail(current);
                return;
            }
            if (!observed)
            {
                TryFail(current);
                return;
            }
            retainedForWarped = true;
        }
        finally
        {
            // Detach only after the coordinator has observed the transition (or
            // terminalized its rejection), while the exact correlation is still
            // available to that callback.
            request.OnWarp -= handler;
            if (retainedForWarped && this.pending is PendingExecution retained
                && retained.ExecutionId == current.ExecutionId)
                this.pending = retained with { NativeRequestHandler = null };
            else if (!retainedForWarped)
                DiscardPending(current.ExecutionId);
        }
    }

    /// <summary>Bounded game-thread watchdog for an armed native edge.</summary>
    internal void Watchdog(long nowMs)
    {
        PendingExecution? candidate = this.pending;
        if (candidate is null || nowMs < candidate.DeadlineMs)
            return;
        TryFail(candidate);
        if (this.pending is PendingExecution current && current.ExecutionId == candidate.ExecutionId)
            DiscardPending(candidate.ExecutionId);
    }

    /// <summary>Consumes only the later SMAPI Player.Warped event.</summary>
    internal void ObserveWarped(WarpedEventArgs args)
    {
        PendingExecution? candidate = this.pending;
        if (candidate is null)
            return;
        if (!candidate.NativeRequestCompleted)
            return;

        // Unrelated or early Warped events are not watchdog signals. Only the
        // later event correlated to this exact native edge may advance or fail it.
        if (!MatchesWarp(candidate, args))
            return;

        try
        {
            if (!this.TryReadLiveFacts(candidate.Scope, candidate.TargetFloor, allowSelectedFloor: true, out int actualFloor, out int lowestMineLevel)
                || actualFloor != candidate.TargetFloor
                || lowestMineLevel < candidate.TargetFloor
                || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= candidate.DeadlineMs)
            {
                TryFail(candidate);
                return;
            }

            PortfolioMineEntryPostconditionObservation postcondition = new(
                candidate.RequestId, candidate.TraceId, candidate.ExecutionId, this.nextRevision(), candidate.Scope,
                Fresh: true, PlayerAvailable: true, WorldReady: true, PolicyAllowed: true,
                MineEntryObserved: true, ActualCurrentFloor: actualFloor,
                LowestMineLevel: lowestMineLevel, LowestMineLevelObserved: true,
                candidate.OpaqueTarget, candidate.TargetFloor);
            try
            {
                _ = this.observePostcondition(postcondition);
            }
            catch
            {
                TryFail(candidate);
            }
        }
        finally
        {
            DiscardPending(candidate.ExecutionId);
        }
    }

    private bool TryReadLiveFacts(PortfolioScope scope, int targetFloor, bool allowSelectedFloor,
        out int currentFloor, out int lowestMineLevel)
    {
        currentFloor = 0;
        lowestMineLevel = 0;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineEntryAction)
            || !this.isBindingCurrent() || !Context.IsWorldReady || !Game1.hasLoadedGame
            || Context.IsMultiplayer || !Game1.IsMasterGame
            || Game1.getAllFarmers().Count() != 1 || Game1.player is null
            || Game1.player.UniqueMultiplayerID != Game1.MasterPlayer.UniqueMultiplayerID
            || Game1.player.UniqueMultiplayerID.ToString() != scope.LocalPlayerId
            || Game1.CurrentEvent is not null || Game1.eventUp || Game1.dialogueUp
            || Game1.activeClickableMenu is not null || !Game1.player.CanMove)
            return false;

        if (allowSelectedFloor)
        {
            if (Game1.player.currentLocation is not MineShaft mine)
                return false;
            currentFloor = mine.mineLevel;
        }
        else if (!IsOrdinaryMineExterior(Game1.player))
        {
            return false;
        }
        lowestMineLevel = MineShaft.lowestLevelReached;
        if (!PortfolioMineEntryProjection.IsSelectableCheckpoint(targetFloor)
            || currentFloor < 0 || currentFloor > PortfolioBridgeProtocol.MineEntryMaximumFloor
            || lowestMineLevel < currentFloor)
            return false;
        return allowSelectedFloor
            ? currentFloor == targetFloor && lowestMineLevel >= targetFloor
            : PortfolioMineEntryProjection.IsEntryTarget(targetFloor);
    }

    private static bool IsOrdinaryMineExterior(Farmer player)
    {
        GameLocation location = Game1.currentLocation;
        return location is not MineShaft
            && ReferenceEquals(location, player.currentLocation)
            && String.Equals(location.NameOrUniqueName, "Mine", StringComparison.Ordinal);
    }

    private void TryFail(PendingExecution candidate)
    {
        try
        {
            string reasonCode = candidate.EdgeIssued
                ? "native_operation_uncertain"
                : "native_operation_failed";
            _ = this.fail(candidate.RequestId, candidate.TraceId, candidate.ExecutionId,
                reasonCode, this.nextRevision(), candidate.Scope);
        }
        catch
        {
            // The caller still detaches the exact handler and clears the
            // correlation state when terminalization itself throws.
        }
    }

    internal void DiscardPendingForInvalidation()
    {
        PendingExecution? candidate = this.pending;
        if (candidate is null)
            return;
        if (candidate.NativeRequest is LocationRequest request && candidate.NativeRequestHandler is LocationRequest.Callback handler)
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
        => request.Name == MineShaft.GetLevelName(targetFloor)
            && request.Location is MineShaft target
            && target.mineLevel == targetFloor;

    private static bool Matches(PendingExecution candidate, PortfolioMineEntryAdapterContext context) =>
        candidate.RequestId == context.RequestId
        && candidate.TraceId == context.TraceId
        && candidate.Scope.Equals(context.Scope)
        && candidate.OpaqueTarget == context.OpaqueEntryTarget
        && candidate.TargetFloor == context.TargetFloor
        && candidate.ExpectedRevision == context.ExpectedRevision
        && candidate.DeadlineMs == context.DeadlineMs
        && candidate.CancellationToken == context.CancellationToken;

    private static bool MatchesWarp(PendingExecution candidate, WarpedEventArgs args) =>
        candidate.EdgeIssued
        && args.Player == candidate.Player
        && candidate.OldLocation is not MineShaft
        && candidate.OldLocationName == candidate.OldLocation.Name
        && args.OldLocation == candidate.OldLocation
        && args.NewLocation == candidate.NativeRequest?.Location
        && args.NewLocation is MineShaft mine
        && mine.mineLevel == candidate.TargetFloor
        && args.Player.currentLocation == args.NewLocation
        && candidate.EdgeIssuedTick <= Game1.ticks;

    private static string BuildOpaqueCorrelationId(
        string requestId,
        string traceId,
        PortfolioScope scope,
        long revision,
        int targetFloor,
        int currentFloor,
        int lowestMineLevel)
    {
        string canonicalFacts = string.Join("\n", new[]
        {
            "requestId=" + requestId,
            "traceId=" + traceId,
            "scope.integrationId=" + scope.IntegrationId,
            "scope.topology=" + scope.Topology,
            "scope.saveId=" + scope.SaveId,
            "scope.worldId=" + scope.WorldId,
            "scope.localPlayerId=" + scope.LocalPlayerId,
            "scope.companionId=" + scope.CompanionId,
            "scope.bindingGeneration=" + scope.BindingGeneration,
            "scope.bindingHash=" + scope.BindingHash,
            "revision=" + revision,
            "targetFloor=" + targetFloor,
            "currentFloor=" + currentFloor,
            "lowestMineLevel=" + lowestMineLevel
        });
        return "enter_mine_correlation_"
            + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalFacts))).ToLowerInvariant();
    }

    private sealed record PendingExecution(
        string RequestId,
        string TraceId,
        PortfolioScope Scope,
        string OpaqueTarget,
        int TargetFloor,
        long ExpectedRevision,
        long DeadlineMs,
        string CancellationToken,
        Farmer Player,
        GameLocation OldLocation,
        string OldLocationName,
        int EdgeIssuedTick,
        long EdgeGeneration)
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
