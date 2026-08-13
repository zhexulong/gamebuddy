using System.Security.Cryptography;
using System.Text;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

/// <summary>
/// Target-version semantic edge for the bounded M8 mine-elevator action. All
/// facts and the native call are owned by the game thread; the bridge supplies
/// only the immutable execution authority tuple.
/// </summary>
internal sealed class PortfolioMineElevatorSemanticAdapter : IPortfolioMineElevatorSemanticAdapter, IPortfolioMineElevatorPendingOwner
{
    private readonly PortfolioConfig config;
    private readonly Func<bool> isBindingCurrent;
    private readonly Func<long> nextRevision;
    private readonly Func<PortfolioMineElevatorTransitionStartedObservation, bool> observeTransitionStarted;
    private readonly Func<PortfolioMineElevatorPostconditionObservation, PortfolioMineElevatorActionReceipt> observePostcondition;
    private readonly Func<string, string, string, string, long, PortfolioScope, PortfolioMineElevatorActionReceipt> fail;
    private PendingExecution? pending;

    internal PortfolioMineElevatorSemanticAdapter(
        PortfolioConfig config,
        Func<bool> isBindingCurrent,
        Func<long> nextRevision,
        Func<PortfolioMineElevatorTransitionStartedObservation, bool> observeTransitionStarted,
        Func<PortfolioMineElevatorPostconditionObservation, PortfolioMineElevatorActionReceipt> observePostcondition,
        Func<string, string, string, string, long, PortfolioScope, PortfolioMineElevatorActionReceipt> fail)
    {
        this.config = config;
        this.isBindingCurrent = isBindingCurrent;
        this.nextRevision = nextRevision;
        this.observeTransitionStarted = observeTransitionStarted;
        this.observePostcondition = observePostcondition;
        this.fail = fail;
    }

    internal PortfolioMineElevatorFreshObservation CreateFreshObservation(
        PortfolioMineElevatorActionRequest request,
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
        bool policyAllowed = this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineElevatorAction);
        int currentFloor = 0;
        int lowestMineLevel = 0;
        bool mineEntryObserved = false;
        if (worldReady && singlePlayer && Game1.player is not null
            && Game1.player.currentLocation is MineShaft mine)
        {
            mineEntryObserved = true;
            currentFloor = mine.mineLevel;
            lowestMineLevel = MineShaft.lowestLevelReached;
        }
        bool checkpointValid = PortfolioBridgeProtocol.IsMineElevatorCheckpoint(request.SelectedCheckpoint);
        bool targetUnlocked = checkpointValid && lowestMineLevel >= request.SelectedCheckpoint;
        // The selected checkpoint is the native semantic target. Stardew has no
        // opaque elevator object or ID; this value is only a deterministic,
        // non-secret correlation capability bound to the complete fresh facts.
        string opaqueCorrelationId = BuildOpaqueCorrelationId(
            request.RequestId, request.TraceId, scope, revision, request.SelectedCheckpoint,
            currentFloor, lowestMineLevel);
        // Do not claim ownership of a target during observation. Begin may reject
        // this request before the semantic boundary, and such a request must not
        // replace a pending target owned by another execution.
        return new PortfolioMineElevatorFreshObservation(
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
            OpaqueElevatorTarget: opaqueCorrelationId);
    }

    internal bool TryReadTerminalFreshFloor(PortfolioMineElevatorFreshFloorRequest request, PortfolioScope scope,
        int selectedCheckpoint, long currentRevision, out PortfolioMineElevatorFreshFloor? floor)
    {
        floor = null;
        if (request is null || !request.IsValid || !request.Scope.Equals(scope)
            || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= request.DeadlineMs
            || !this.TryReadLiveFacts(scope, selectedCheckpoint, allowSelectedFloor: true, out int currentFloor, out int lowestMineLevel)
            || currentFloor != selectedCheckpoint
            || currentRevision <= request.ExpectedRevision)
            return false;
        floor = new PortfolioMineElevatorFreshFloor(request.RequestId, request.TraceId, request.ExecutionId,
            scope, currentRevision, Fresh: true, currentFloor, lowestMineLevel);
        return true;
    }

    public bool IsAvailable => this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineElevatorAction)
        && Context.IsWorldReady && Game1.hasLoadedGame && this.isBindingCurrent();

    public bool RequestElevatorSelection(
        PortfolioMineElevatorAdapterContext context,
        out PortfolioMineElevatorAdapterResult? result)
    {
        result = null;
        PendingExecution? existing = this.pending;
        if (existing is not null && !Matches(existing, context))
            return false;
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= context.DeadlineMs
            || !this.TryReadLiveFacts(context.Scope, context.SelectedCheckpoint, allowSelectedFloor: false,
                out int currentFloor, out int lowestMineLevel))
            return false;

        Farmer player = Game1.player!;
        if (player.currentLocation is not MineShaft oldMine)
            return false;
        PendingExecution candidate = existing ?? new PendingExecution(
            context.RequestId, context.TraceId, context.Scope, context.OpaqueElevatorTarget,
            context.SelectedCheckpoint, context.ExpectedRevision, context.DeadlineMs,
            context.CancellationToken,
            player, oldMine, oldMine.Name, oldMine.mineLevel, -1, EdgeGeneration: 0) { ExecutionId = context.ExecutionId };
        candidate = candidate with { ExecutionId = context.ExecutionId };
        this.pending = candidate;

        LocationRequest? previousRequest = Game1.locationRequest;
        try
        {
            // This is the complete native edge for M8: no menu, input, dispatcher,
            // direct warp, reflection, or save mutation is involved. The scoped
            // volatile flag is part of the exact target-version elevator semantic:
            // MineElevatorMenu sets it immediately before enterMine, and
            // LocationRequest.Warped clears it. It is not direct save/world
            // mutation and is not a generic player mutation fallback.
            candidate = candidate with
            {
                EdgeGeneration = candidate.EdgeGeneration + 1,
                EdgeIssuedTick = Game1.ticks,
                NativeCallInProgress = true
            };
            this.pending = candidate;
            bool previousRidingMineElevator = player.ridingMineElevator;
            player.ridingMineElevator = true;
            try
            {
                Game1.enterMine(context.SelectedCheckpoint);
            }
            catch
            {
                // Restore only when the native invocation threw before it
                // scheduled a new LocationRequest. Once scheduled, the native
                // LocationRequest.Warped lifecycle owns clearing the flag.
                if (ReferenceEquals(Game1.locationRequest, previousRequest))
                    player.ridingMineElevator = previousRidingMineElevator;
                return false;
            }
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
            || !MatchesExpectedRequest(request, context.SelectedCheckpoint)
            || !ReferenceEquals(Game1.locationRequest, request))
        {
            return false;
        }

        PendingExecution pending = armed with { NativeCallInProgress = false, NativeRequest = request };
        LocationRequest.Callback? handler = null;
        handler = () => this.ObserveNativeRequestWarp(pending, request, handler!);
        pending = pending with { NativeRequestHandler = handler };
        this.pending = pending;
        request.OnWarp += handler;
        result = new PortfolioMineElevatorAdapterResult(
            context.RequestId, context.TraceId, context.ExecutionId, context.Scope,
            context.ExpectedRevision, context.OpaqueElevatorTarget, context.SelectedCheckpoint,
            TransitionArmed: true);
        return true;
    }

    private void ObserveNativeRequestWarp(PendingExecution candidate, LocationRequest request, LocationRequest.Callback handler)
    {
        PendingExecution? current = this.pending;
        if (current is null || !ReferenceEquals(current, candidate)
            || !Matches(current, new PortfolioMineElevatorAdapterContext(
                candidate.RequestId, candidate.TraceId, candidate.ExecutionId, candidate.CancellationToken,
                candidate.Scope, candidate.OpaqueTarget, candidate.SelectedCheckpoint,
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
                || !MatchesExpectedRequest(request, current.SelectedCheckpoint)
                || request.Location is not MineShaft target
                || !ReferenceEquals(Game1.player.currentLocation, target))
            {
                TryFail(current);
                return;
            }

            current = current with { NativeRequestCompleted = true, TransitionRevision = this.nextRevision() };
            this.pending = current;
            PortfolioMineElevatorTransitionStartedObservation transition = new(
                current.RequestId, current.TraceId, current.ExecutionId, current.TransitionRevision, current.Scope,
                Fresh: true, PlayerAvailable: true, WorldReady: true, PolicyAllowed: true,
                MineEntryObserved: true, NativeElevatorTransitionObserved: true,
                current.OpaqueTarget, current.SelectedCheckpoint);
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
            if (!this.TryReadLiveFacts(candidate.Scope, candidate.SelectedCheckpoint, allowSelectedFloor: true,
                    out int actualFloor, out int lowestMineLevel)
                || actualFloor != candidate.SelectedCheckpoint
                || lowestMineLevel < candidate.SelectedCheckpoint
                || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= candidate.DeadlineMs)
            {
                TryFail(candidate);
                return;
            }

            PortfolioMineElevatorPostconditionObservation postcondition = new(
                candidate.RequestId, candidate.TraceId, candidate.ExecutionId, this.nextRevision(), candidate.Scope,
                Fresh: true, PlayerAvailable: true, WorldReady: true, PolicyAllowed: true,
                MineEntryObserved: true, ActualCurrentFloor: actualFloor,
                LowestMineLevel: lowestMineLevel, LowestMineLevelObserved: true,
                candidate.OpaqueTarget, candidate.SelectedCheckpoint);
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

    private bool TryReadLiveFacts(PortfolioScope scope, int selectedCheckpoint, bool allowSelectedFloor,
        out int currentFloor, out int lowestMineLevel)
    {
        currentFloor = 0;
        lowestMineLevel = 0;
        if (!this.isBindingCurrent() || !Context.IsWorldReady || !Game1.hasLoadedGame
            || Context.IsMultiplayer || !Game1.IsMasterGame
            || Game1.getAllFarmers().Count() != 1 || Game1.player is null
            || Game1.player.UniqueMultiplayerID != Game1.MasterPlayer.UniqueMultiplayerID
            || Game1.player.UniqueMultiplayerID.ToString() != scope.LocalPlayerId
            || Game1.player.currentLocation is not MineShaft mine)
            return false;

        currentFloor = mine.mineLevel;
        lowestMineLevel = MineShaft.lowestLevelReached;
        return PortfolioBridgeProtocol.IsMineElevatorCheckpoint(selectedCheckpoint)
            && (allowSelectedFloor || selectedCheckpoint != currentFloor)
            && currentFloor >= 0 && currentFloor <= PortfolioBridgeProtocol.MineElevatorMaximumCheckpoint
            && lowestMineLevel >= selectedCheckpoint
            && lowestMineLevel <= PortfolioBridgeProtocol.MineElevatorMaximumCheckpoint;
    }

    private void TryFail(PendingExecution candidate)
    {
        try
        {
            _ = this.fail(candidate.RequestId, candidate.TraceId, candidate.ExecutionId,
                "native_operation_uncertain", this.nextRevision(), candidate.Scope);
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

    private static bool MatchesExpectedRequest(LocationRequest request, int selectedCheckpoint)
        => request.Name == MineShaft.GetLevelName(selectedCheckpoint)
            && request.Location is MineShaft target
            && target.mineLevel == selectedCheckpoint;

    private static bool Matches(PendingExecution candidate, PortfolioMineElevatorAdapterContext context) =>
        candidate.RequestId == context.RequestId
        && candidate.TraceId == context.TraceId
        && candidate.Scope.Equals(context.Scope)
        && candidate.OpaqueTarget == context.OpaqueElevatorTarget
        && candidate.SelectedCheckpoint == context.SelectedCheckpoint
        && candidate.ExpectedRevision == context.ExpectedRevision
        && candidate.DeadlineMs == context.DeadlineMs
        && candidate.CancellationToken == context.CancellationToken;

    private static bool MatchesWarp(PendingExecution candidate, WarpedEventArgs args) =>
        candidate.EdgeIssued
        && args.Player == candidate.Player
        && candidate.OldMine is not null
        && candidate.OldMineName == candidate.OldMine.Name
        && candidate.OldMineFloor == candidate.OldMine.mineLevel
        && args.OldLocation == candidate.OldMine
        && args.NewLocation == candidate.NativeRequest?.Location
        && args.NewLocation is MineShaft mine
        && mine.mineLevel == candidate.SelectedCheckpoint
        && args.Player.currentLocation == args.NewLocation
        && candidate.EdgeIssuedTick <= Game1.ticks;

    private static string BuildOpaqueCorrelationId(
        string requestId,
        string traceId,
        PortfolioScope scope,
        long revision,
        int selectedCheckpoint,
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
            "selectedCheckpoint=" + selectedCheckpoint,
            "currentFloor=" + currentFloor,
            "lowestMineLevel=" + lowestMineLevel
        });
        return "mine_elevator_correlation_"
            + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalFacts))).ToLowerInvariant();
    }

    private sealed record PendingExecution(
        string RequestId,
        string TraceId,
        PortfolioScope Scope,
        string OpaqueTarget,
        int SelectedCheckpoint,
        long ExpectedRevision,
        long DeadlineMs,
        string CancellationToken,
        Farmer Player,
        MineShaft OldMine,
        string OldMineName,
        int OldMineFloor,
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
