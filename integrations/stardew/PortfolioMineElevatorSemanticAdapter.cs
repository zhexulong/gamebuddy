using System.Security.Cryptography;
using System.Text;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

/// <summary>
/// Direct semantic edge for bounded M8 elevator selection. It observes an
/// existing elevator facility but does not dispatch UI, read a grab tile, or
/// move the player; the selected checkpoint remains typed and bounded.
/// </summary>
internal sealed class PortfolioMineElevatorSemanticAdapter : IPortfolioMineElevatorSemanticAdapter, IPortfolioMineElevatorPendingOwner
{
    private readonly PortfolioConfig config;
    private readonly Func<bool> isBindingCurrent;
    private readonly Func<long> nextRevision;
    private readonly Func<PortfolioMineElevatorTransitionStartedObservation, bool> observeTransitionStarted;
    private readonly Func<PortfolioMineElevatorPostconditionObservation, PortfolioMineElevatorActionReceipt> observePostcondition;
    private readonly Func<string, string, string, string, long, PortfolioScope, PortfolioMineElevatorActionReceipt> fail;
    private readonly Func<string, bool> armNativeTransition;
    private PendingExecution? pending;

    internal PortfolioMineElevatorSemanticAdapter(
        PortfolioConfig config, Func<bool> isBindingCurrent, Func<long> nextRevision,
        Func<PortfolioMineElevatorTransitionStartedObservation, bool> observeTransitionStarted,
        Func<PortfolioMineElevatorPostconditionObservation, PortfolioMineElevatorActionReceipt> observePostcondition,
        Func<string, string, string, string, long, PortfolioScope, PortfolioMineElevatorActionReceipt> fail,
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

    internal PortfolioMineElevatorFreshObservation CreateFreshObservation(
        PortfolioMineElevatorActionRequest request, PortfolioScope scope, long revision)
    {
        bool playerAvailable = Game1.player is not null && Game1.player.UniqueMultiplayerID.ToString() == scope.LocalPlayerId;
        bool worldReady = Context.IsWorldReady && Game1.hasLoadedGame;
        bool singlePlayer = !Context.IsMultiplayer && Game1.IsMasterGame && Game1.getAllFarmers().Count() == 1
            && Game1.player is not null && Game1.player.UniqueMultiplayerID == Game1.MasterPlayer.UniqueMultiplayerID;
        bool policyAllowed = this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineElevatorAction);
        int currentFloor = 0;
        int lowestMineLevel = 0;
        bool mineEntryObserved = false;
        bool elevatorObserved = false;
        if (worldReady && singlePlayer && Game1.player?.currentLocation is MineShaft mine)
        {
            mineEntryObserved = true;
            currentFloor = mine.mineLevel;
            lowestMineLevel = MineShaft.lowestLevelReached;
            elevatorObserved = HasElevatorFacility(mine);
        }
        bool checkpointValid = PortfolioMineElevatorProjection.IsSelectableCheckpoint(request.SelectedCheckpoint);
        bool targetUnlocked = PortfolioMineElevatorProjection.IsUnlockedSelection(lowestMineLevel, request.SelectedCheckpoint);
        string opaqueCorrelationId = BuildOpaqueCorrelationId(request.RequestId, request.TraceId, scope, revision,
            request.SelectedCheckpoint, currentFloor, lowestMineLevel);
        return new PortfolioMineElevatorFreshObservation(request.RequestId, request.TraceId, revision, scope,
            Fresh: true, PlayerAvailable: playerAvailable && singlePlayer, WorldReady: worldReady, PolicyAllowed: policyAllowed,
            MineEntryObserved: mineEntryObserved, CurrentFloor: currentFloor, LowestMineLevel: lowestMineLevel,
            UnlockedLevelObserved: mineEntryObserved && checkpointValid, TargetUnlocked: targetUnlocked,
            ElevatorObserved: elevatorObserved, OpaqueElevatorTarget: opaqueCorrelationId);
    }

    internal bool TryReadTerminalFreshFloor(PortfolioMineElevatorFreshFloorRequest request, PortfolioScope scope,
        int selectedCheckpoint, long currentRevision, out PortfolioMineElevatorFreshFloor? floor)
    {
        floor = null;
        if (request is null || !request.IsValid || !request.Scope.Equals(scope)
            || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= request.DeadlineMs
            || !this.TryReadLiveFacts(scope, selectedCheckpoint, allowSelectedFloor: true, requireElevatorFacility: false,
                out int currentFloor, out int lowestMineLevel)
            || currentFloor != selectedCheckpoint || currentRevision <= request.ExpectedRevision)
            return false;
        floor = new PortfolioMineElevatorFreshFloor(request.RequestId, request.TraceId, request.ExecutionId,
            scope, currentRevision, Fresh: true, currentFloor, lowestMineLevel);
        return true;
    }

    public bool IsAvailable => this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineElevatorAction)
        && Context.IsWorldReady && Game1.hasLoadedGame && this.isBindingCurrent();

    public bool RequestElevatorSelection(PortfolioMineElevatorAdapterContext context,
        out PortfolioMineElevatorAdapterResult? result)
    {
        result = null;
        PendingExecution? existing = this.pending;
        if (existing is not null && !Matches(existing, context))
            return false;
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= context.DeadlineMs
            || !this.TryReadLiveFacts(context.Scope, context.SelectedCheckpoint, allowSelectedFloor: false,
                requireElevatorFacility: true, out _, out _)
            || Game1.player?.currentLocation is not MineShaft oldMine)
            return false;

        Farmer player = Game1.player!;
        PendingExecution candidate = existing ?? new PendingExecution(context.RequestId, context.TraceId, context.Scope,
            context.OpaqueElevatorTarget, context.SelectedCheckpoint, context.ExpectedRevision, context.DeadlineMs,
            context.CancellationToken, player, oldMine, oldMine.Name, oldMine.mineLevel, -1, EdgeGeneration: 0)
        { ExecutionId = context.ExecutionId };
        candidate = candidate with { ExecutionId = context.ExecutionId };
        this.pending = candidate;
        if (!this.TryIssueNativeTransition(candidate, context, out _))
        {
            this.DiscardPending(context.ExecutionId);
            return false;
        }
        result = new PortfolioMineElevatorAdapterResult(context.RequestId, context.TraceId, context.ExecutionId,
            context.Scope, context.ExpectedRevision, context.OpaqueElevatorTarget, context.SelectedCheckpoint,
            TransitionArmed: true);
        return true;
    }

    private bool TryIssueNativeTransition(PendingExecution candidate, PortfolioMineElevatorAdapterContext context,
        out bool edgeIssued)
    {
        edgeIssued = false;
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= context.DeadlineMs
            || !this.TryReadLiveFacts(context.Scope, context.SelectedCheckpoint, allowSelectedFloor: false,
                requireElevatorFacility: true, out _, out _)
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

        bool previousRidingMineElevator = candidate.Player.ridingMineElevator;
        try
        {
            // This action-owned transient flag is the native elevator-entrance
            // semantic. LocationRequest.Warped clears it after the exact warp.
            candidate.Player.ridingMineElevator = true;
            Game1.enterMine(context.SelectedCheckpoint);
        }
        catch
        {
            if (Game1.locationRequest is null)
                candidate.Player.ridingMineElevator = previousRidingMineElevator;
            return false;
        }

        PendingExecution? armed = this.pending;
        LocationRequest? request = Game1.locationRequest;
        if (armed is null || !Matches(armed, context) || armed.EdgeGeneration != candidate.EdgeGeneration
            || armed.EdgeIssuedTick > Game1.ticks || request is null
            || !MatchesExpectedRequest(request, context.SelectedCheckpoint) || !ReferenceEquals(Game1.locationRequest, request))
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
                || !MatchesExpectedRequest(request, current.SelectedCheckpoint) || request.Location is not MineShaft target
                || !ReferenceEquals(Game1.player.currentLocation, target))
            {
                TryFail(current);
                return;
            }
            current = current with { NativeRequestCompleted = true, TransitionRevision = this.nextRevision() };
            this.pending = current;
            PortfolioMineElevatorTransitionStartedObservation transition = new(current.RequestId, current.TraceId,
                current.ExecutionId, current.TransitionRevision, current.Scope, Fresh: true, PlayerAvailable: true,
                WorldReady: true, PolicyAllowed: true, MineEntryObserved: true, NativeElevatorTransitionObserved: true,
                current.OpaqueTarget, current.SelectedCheckpoint);
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
            if (!this.TryReadLiveFacts(candidate.Scope, candidate.SelectedCheckpoint, allowSelectedFloor: true,
                    requireElevatorFacility: false, out int actualFloor, out int lowestMineLevel)
                || actualFloor != candidate.SelectedCheckpoint || lowestMineLevel < candidate.SelectedCheckpoint
                || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= candidate.DeadlineMs)
            {
                TryFail(candidate);
                return;
            }
            PortfolioMineElevatorPostconditionObservation postcondition = new(candidate.RequestId, candidate.TraceId,
                candidate.ExecutionId, this.nextRevision(), candidate.Scope, Fresh: true, PlayerAvailable: true,
                WorldReady: true, PolicyAllowed: true, MineEntryObserved: true, ActualCurrentFloor: actualFloor,
                LowestMineLevel: lowestMineLevel, LowestMineLevelObserved: true, candidate.OpaqueTarget,
                candidate.SelectedCheckpoint);
            _ = this.observePostcondition(postcondition);
        }
        catch { TryFail(candidate); }
        finally { DiscardPending(candidate.ExecutionId); }
    }

    private bool TryReadLiveFacts(PortfolioScope scope, int selectedCheckpoint, bool allowSelectedFloor,
        bool requireElevatorFacility, out int currentFloor, out int lowestMineLevel)
    {
        currentFloor = 0;
        lowestMineLevel = 0;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineElevatorAction)
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
        if (currentFloor < 0 || currentFloor > PortfolioBridgeProtocol.MineElevatorMaximumCheckpoint
            || lowestMineLevel < currentFloor
            || !PortfolioMineElevatorProjection.IsUnlockedSelection(lowestMineLevel, selectedCheckpoint)
            || (requireElevatorFacility && !HasElevatorFacility(mine)))
            return false;
        return allowSelectedFloor ? currentFloor == selectedCheckpoint : selectedCheckpoint != currentFloor;
    }

    private static bool HasElevatorFacility(MineShaft mine)
    {
        var layer = mine.map?.GetLayer("Buildings");
        if (layer is null)
            return false;
        for (int x = 0; x < layer.LayerWidth; x++)
        for (int y = 0; y < layer.LayerHeight; y++)
            if (mine.getTileIndexAt(new xTile.Dimensions.Location(x, y), "Buildings") == 112)
                return true;
        return false;
    }

    private void TryFail(PendingExecution candidate)
    {
        try { _ = this.fail(candidate.RequestId, candidate.TraceId, candidate.ExecutionId,
            "native_operation_uncertain", this.nextRevision(), candidate.Scope); }
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

    private static bool MatchesExpectedRequest(LocationRequest request, int selectedCheckpoint)
        => request.Name == MineShaft.GetLevelName(selectedCheckpoint) && request.Location is MineShaft target
            && target.mineLevel == selectedCheckpoint;

    private static bool Matches(PendingExecution candidate, PortfolioMineElevatorAdapterContext context)
        => candidate.RequestId == context.RequestId && candidate.TraceId == context.TraceId && candidate.Scope.Equals(context.Scope)
            && candidate.OpaqueTarget == context.OpaqueElevatorTarget && candidate.SelectedCheckpoint == context.SelectedCheckpoint
            && candidate.ExpectedRevision == context.ExpectedRevision && candidate.DeadlineMs == context.DeadlineMs
            && candidate.CancellationToken == context.CancellationToken;

    private static bool MatchesWarp(PendingExecution candidate, WarpedEventArgs args)
        => candidate.EdgeIssued && args.Player == candidate.Player && args.OldLocation == candidate.OldMine
            && args.NewLocation == candidate.NativeRequest?.Location && args.NewLocation is MineShaft mine
            && mine.mineLevel == candidate.SelectedCheckpoint && args.Player.currentLocation == args.NewLocation
            && candidate.EdgeIssuedTick <= Game1.ticks;

    private static string BuildOpaqueCorrelationId(string requestId, string traceId, PortfolioScope scope, long revision,
        int selectedCheckpoint, int currentFloor, int lowestMineLevel)
    {
        string canonicalFacts = string.Join("\n", new[] { "requestId=" + requestId, "traceId=" + traceId,
            "scope.integrationId=" + scope.IntegrationId, "scope.topology=" + scope.Topology,
            "scope.saveId=" + scope.SaveId, "scope.worldId=" + scope.WorldId,
            "scope.localPlayerId=" + scope.LocalPlayerId, "scope.companionId=" + scope.CompanionId,
            "scope.bindingGeneration=" + scope.BindingGeneration, "scope.bindingHash=" + scope.BindingHash,
            "revision=" + revision, "selectedCheckpoint=" + selectedCheckpoint, "currentFloor=" + currentFloor,
            "lowestMineLevel=" + lowestMineLevel });
        return "mine_elevator_correlation_" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalFacts))).ToLowerInvariant();
    }

    private sealed record PendingExecution(string RequestId, string TraceId, PortfolioScope Scope, string OpaqueTarget,
        int SelectedCheckpoint, long ExpectedRevision, long DeadlineMs, string CancellationToken, Farmer Player,
        MineShaft OldMine, string OldMineName, int OldMineFloor, int EdgeIssuedTick, long EdgeGeneration)
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
