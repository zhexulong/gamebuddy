namespace GameBuddy.Stardew;

/// <summary>
/// Game-thread-owned state machine for the bounded, observation-driven mine
/// elevator primitive. It never resolves a target from caller text and never
/// invokes a native game member: a future target-version adapter owns that semantic edge.
/// </summary>
internal interface IPortfolioMineElevatorPendingOwner
{
    void DiscardPending(string executionId);
}

internal sealed class PortfolioMineElevatorActionCoordinator
{
    private const string Action = PortfolioBridgeProtocol.MineElevatorAction;
    private const int MinimumCheckpoint = PortfolioBridgeProtocol.MineElevatorMinimumCheckpoint;
    private const int MaximumCheckpoint = PortfolioBridgeProtocol.MineElevatorMaximumCheckpoint;
    private static readonly string[] Phases = { "fresh_observed", "accepted", "transition_started", "postcondition", "terminal" };

    private readonly object gate = new();
    private readonly IPortfolioMineElevatorSemanticAdapter? adapter;
    private readonly Dictionary<string, ReplayEntry> completedByIdempotency = new(StringComparer.Ordinal);
    private readonly PortfolioTerminalDeliveryCore<PortfolioMineElevatorTerminalDelivery> terminalDelivery = new();
    private ElevatorExecution? active;

    internal PortfolioMineElevatorActionCoordinator(IPortfolioMineElevatorSemanticAdapter? adapter = null) => this.adapter = adapter;

    internal bool HasActiveExecution
    {
        get { lock (this.gate) return this.active is not null; }
    }

    internal PortfolioMineElevatorActionBeginResult Begin(
        PortfolioMineElevatorActionRequest request,
        PortfolioMineElevatorFreshObservation observation,
        string correlationId)
    {
        lock (this.gate)
        {
            string executionId = NewId();
            if (request is null)
                return TerminalResult(Failure("invalid", "invalid", executionId, "rejected", 0, "invalid_mine_elevator_request", InvalidScope()));
            if (!IsRequestShapeValid(request))
                return TerminalResult(Failure(SafeId(request.RequestId), SafeId(request.TraceId), executionId, "rejected", 0,
                    "invalid_mine_elevator_request", SafeScope(request.Scope)));

            // Replay an exact completed request before dynamic observation,
            // revision, and deadline guards. Those facts legitimately change
            // after the terminal mutation and must not overwrite its receipt.
            PortfolioMineElevatorActionReceipt? replay = TryReplay(request);
            if (replay is not null)
                return TerminalResult(replay);
            if (observation is null || !IsObservationShapeValid(observation))
                return TerminalResult(Failure(request, executionId, "rejected", observation?.Revision ?? 0, "invalid_mine_elevator_observation", SafeScope(observation?.Scope)));

            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (!observation.Scope.IsValid || !request.Scope.Equals(observation.Scope))
                return TerminalResult(Remember(request, Failure(request, executionId, "blocked", observation.Revision, "portfolio_binding_invalid", observation.Scope)));
            if (!IsFreshObservationValid(request, observation, now))
            {
                string guardReason = GuardReason(request, observation, now);
                string guardState = guardReason is "portfolio_world_not_ready" or "portfolio_action_not_allowed"
                    ? "blocked"
                    : "rejected";
                return TerminalResult(Remember(request, Failure(request, executionId, guardState, observation.Revision, guardReason, observation.Scope)));
            }
            if (active is not null)
                // An in-flight duplicate must not be persisted as the replay for
                // this key. The terminal execution owns the eventual idempotency
                // entry, including when this request is rejected while it runs.
                return TerminalResult(Failure(request, executionId, "blocked", observation.Revision, "execution_already_active", observation.Scope));
            if (adapter is null || !adapter.IsAvailable)
                return TerminalResult(Remember(request, Failure(request, executionId, "blocked", observation.Revision, "adapter_unavailable", observation.Scope)));

            if (!PortfolioBridgeProtocol.IsOpaqueId(correlationId))
                return TerminalResult(Failure(request, executionId, "rejected", observation.Revision, "invalid_envelope", observation.Scope));
            ElevatorExecution execution = new(request, observation, executionId, correlationId);
            execution.Phases.Add(Phase(execution, "fresh_observed", observation.Revision, "fresh_observed"));
            execution.Phases.Add(Phase(execution, "accepted", observation.Revision, "accepted"));
            active = execution;
            bool armed;
            PortfolioMineElevatorAdapterResult? adapterResult;
            try
            {
                // Crossing this boundary may arm native work before the adapter
                // returns (including during a reentrant callback), so cancellation
                // must remain fail-closed until an explicit native outcome arrives.
                execution.TransitionArmed = true;
                execution.AdapterCallInProgress = true;
                // This is the only adapter boundary. It is intentionally
                // semantic and cannot accept a floor, location, or dispatcher.
                armed = adapter.RequestElevatorSelection(new PortfolioMineElevatorAdapterContext(
                    request.RequestId, request.TraceId, executionId, request.CancellationToken,
                    observation.Scope, observation.OpaqueElevatorTarget, request.SelectedCheckpoint,
                    request.ExpectedRevision, request.DeadlineMs), out adapterResult);
            }
            catch
            {
                armed = false;
                adapterResult = null;
            }
            execution.AdapterCallInProgress = false;
            execution.BeginInProgress = false;
            // The adapter result is untrusted until correlation, scope, target,
            // revision, checkpoint, and deadline are checked again after return.
            if (active != execution && execution.TerminalReceipt is not null)
                return TerminalResult(execution.TerminalReceipt);
            if (!armed || adapterResult is null || execution.Cancelled || !IsMatchingAdapterResult(execution, adapterResult)
                || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= execution.DeadlineMs)
            {
                // The semantic adapter may have crossed the native boundary even
                // when it reports false, throws, or returns an untrusted result.
                // Do not manufacture a determinate failure for an unknown native
                // outcome; terminalize exactly once after the invocation returns.
                return TerminalResult(TerminateActive("uncertain", "native_operation_uncertain", enqueue: false));
            }
            // The adapter result acknowledges the exact transition observation;
            // it is not a second observation and must reuse its revision.
            return AcceptedResult(execution);
        }
    }

    internal bool TryPeekTerminalDelivery(out PortfolioMineElevatorTerminalDelivery? delivery)
        => this.terminalDelivery.TryPeekTerminalDelivery(out delivery);

    internal bool TryArmTerminalDelivery(PortfolioMineElevatorTerminalDelivery delivery, PortfolioPipeOutboundCompletion completion)
        => this.terminalDelivery.TryArmTerminalDelivery(delivery, completion);

    internal bool IsTerminalDeliveryPending(PortfolioMineElevatorTerminalDelivery delivery)
        => this.terminalDelivery.IsTerminalDeliveryPending(delivery);

    internal bool TryCompleteTerminalDelivery(PortfolioMineElevatorTerminalDelivery delivery, long authenticatedGeneration, out bool failed)
        => this.terminalDelivery.TryCompleteTerminalDelivery(delivery, authenticatedGeneration, out failed);

    internal bool TryAcknowledgeTerminalDelivery(PortfolioMineElevatorTerminalDelivery delivery)
        => this.terminalDelivery.TryAcknowledgeTerminalDelivery(delivery);

    internal bool TryValidateFreshFloorRequest(PortfolioMineElevatorFreshFloorRequest request, long currentRevision, out int selectedCheckpoint)
    {
        selectedCheckpoint = 0;
        lock (this.gate)
        {
            if (request is null || !request.IsValid || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= request.DeadlineMs)
                return false;
            // The terminal receipt is immutable evidence. A fresh reader may
            // consume only its exact authority tuple, never an active/replayed
            // execution or a substituted cancellation token/scope.
            ReplayEntry? entry = completedByIdempotency.Values.FirstOrDefault(entry =>
                entry.Receipt.State == "succeeded"
                && entry.Receipt.RequestId == request.RequestId
                && entry.Receipt.TraceId == request.TraceId
                && entry.Receipt.ExecutionId == request.ExecutionId
                && entry.Receipt.Revision == request.ExpectedRevision
                && entry.Request.CancellationToken == request.CancellationToken
                && entry.Scope.Equals(request.Scope)
                && currentRevision > request.ExpectedRevision);
            if (active is not null || entry is null)
                return false;
            selectedCheckpoint = entry.Request.SelectedCheckpoint;
            return true;
        }
    }

    internal PortfolioMineElevatorActionReceipt Cancel(PortfolioMineElevatorActionCancelRequest request)
    {
        lock (this.gate)
        {
            if (request is null)
                return Failure("invalid", "invalid", NewId(), "rejected", active?.Revision ?? 0, "invalid_mine_elevator_cancel_request", active?.Scope ?? InvalidScope());
            if (!request.IsValid || active is null || active.Action != request.Action
                || active.RequestId != request.RequestId || active.TraceId != request.TraceId
                || active.ExecutionId != request.ExecutionId || !active.Scope.Equals(request.Scope))
                return Failure(SafeId(request.RequestId), SafeId(request.TraceId), SafeId(request.ExecutionId), "rejected", active?.Revision ?? 0, "execution_not_active", active?.Scope ?? InvalidScope());
            if (!String.Equals(active.CancellationToken, request.CancellationToken, StringComparison.Ordinal))
                return Failure(active.RequestId, active.TraceId, active.ExecutionId, "rejected", active.Revision, "cancellation_token_mismatch", active.Scope);
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= active.DeadlineMs)
            {
                if (active.TransitionArmed)
                {
                    if (active.AdapterCallInProgress)
                    {
                        if (active.Cancelled)
                        {
                            ReleasePending(active);
                            return TerminateActive("uncertain", "native_operation_uncertain", enqueue: false);
                        }
                        active.Cancelled = true;
                        ReleasePending(active);
                        return TerminateActive("uncertain", "native_operation_uncertain", enqueue: false);
                    }
                    ReleasePending(active);
                    return TerminateActive("uncertain", "native_operation_uncertain", enqueue: false);
                }
                return TerminateActive("expired", "deadline_expired", enqueue: false);
            }
            if (active.TransitionArmed && !active.AdapterCallInProgress)
                return TerminateActive("uncertain", "native_operation_uncertain", enqueue: false);
            if (active.TransitionArmed)
            {
                // A reentrant cancel does not acknowledge the native outcome.
                // Preserve active ownership until the adapter invocation returns,
                // but remove its pending event correlation immediately.
                if (active.Cancelled)
                {
                    ReleasePending(active);
                    return TerminateActive("uncertain", "native_operation_uncertain", enqueue: false);
                }
                active.Cancelled = true;
                ReleasePending(active);
                return TerminateActive("uncertain", "native_operation_uncertain", enqueue: false);
            }
            if (active.Irreversible)
                return Failure(active.RequestId, active.TraceId, active.ExecutionId, "blocked", active.Revision, "irreversible_phase_reached", active.Scope);

            return TerminateActive("cancelled", "cancelled", enqueue: false);
        }
    }

    internal bool ObserveTransitionStarted(PortfolioMineElevatorTransitionStartedObservation observation)
    {
        lock (this.gate)
        {
            if (observation is null || active is null || active.Cancelled
                || !IsTransitionObservationShapeValid(observation)
                || !CanAdvance("transition_started", observation.RequestId, observation.TraceId, observation.ExecutionId,
                    observation.Revision, observation.Scope)
                || !IsTransitionObservationValid(observation, active))
                return false;
            ElevatorExecution execution = active!;
            execution.NativeElevatorTransitionObserved = true;
            execution.Irreversible = true;
            execution.TransitionRevision = observation.Revision;
            execution.Phases.Add(Phase(execution, "transition_started", observation.Revision, "mine_elevator_transition_started"));
            execution.Revision = observation.Revision;
            return true;
        }
    }

    internal PortfolioMineElevatorActionReceipt ObservePostcondition(PortfolioMineElevatorPostconditionObservation observation)
    {
        lock (this.gate)
        {
            if (observation is null)
                return Failure("invalid", "invalid", NewId(), "uncertain", active?.Revision ?? 0,
                    "postcondition_observation_invalid", active?.Scope ?? InvalidScope());
            if (active is null)
                return Failure(SafeId(observation.RequestId), SafeId(observation.TraceId), SafeId(observation.ExecutionId), "uncertain", observation.Revision,
                    "postcondition_observation_invalid", SafeScope(observation.Scope));
            if (active.Cancelled || !IsPostconditionObservationShapeValid(observation)
                || !CanAdvance("postcondition", observation.RequestId, observation.TraceId, observation.ExecutionId,
                    observation.Revision, observation.Scope)
                || !IsPostconditionObservationValid(observation, active))
            {
                // A rejected observation for this execution is uncertainty, not
                // proof of a failed or successful native transition. Unrelated
                // or forged authority tuples must not terminate the active run.
                if (IsMatchingPostconditionTuple(observation, active))
                    return TerminateActive("uncertain", "postcondition_observation_invalid");
                return Failure(SafeId(observation.RequestId), SafeId(observation.TraceId), SafeId(observation.ExecutionId), "uncertain", observation.Revision,
                    "postcondition_observation_invalid", SafeScope(observation.Scope));
            }

            ElevatorExecution execution = active;
            execution.CurrentFloorAfter = observation.ActualCurrentFloor;
            execution.LowestMineLevelAfter = observation.LowestMineLevel;
            execution.LowestMineLevelObserved = true;
            execution.PostconditionRevision = observation.Revision;
            execution.Phases.Add(Phase(execution, "postcondition", observation.Revision, "postcondition_observed"));
            execution.Revision = observation.Revision;
            return TerminateActive("succeeded", "mine_elevator_floor_selected");
        }
    }

    internal PortfolioMineElevatorActionReceipt Fail(
        string requestId,
        string traceId,
        string executionId,
        string reasonCode,
        long revision,
        PortfolioScope scope)
    {
        lock (this.gate)
        {
            if (active is null || active.RequestId != requestId || active.TraceId != traceId || active.ExecutionId != executionId
                || !active.Scope.Equals(scope))
                return Failure(requestId, traceId, executionId, "rejected", revision, "execution_not_active", scope);

            ElevatorExecution execution = active;
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= execution.DeadlineMs)
                return TerminateActive(execution.TransitionArmed ? "uncertain" : "expired",
                    execution.TransitionArmed ? "native_operation_uncertain" : "deadline_expired");
            if (revision <= execution.Revision)
                return TerminateActive("uncertain", "stale_callback_revision");

            // A callback is a native handshake only when it explicitly says
            // cancelled or failed. Unknown reasons and disconnects cannot
            // prove that the armed transition did not commit.
            execution.Revision = revision;
            string callbackReason = NormalizeCallbackReason(reasonCode);
            string state = callbackReason switch
            {
                "cancelled" => "cancelled",
                "native_operation_failed" => "failed",
                "deadline_expired" => execution.TransitionArmed ? "uncertain" : "expired",
                _ => "uncertain"
            };
            if (execution.TransitionArmed)
            {
                state = "uncertain";
                callbackReason = "native_operation_uncertain";
            }
            return TerminateActive(state, callbackReason);
        }
    }

    private void ReleasePending(ElevatorExecution execution)
    {
        if (this.adapter is IPortfolioMineElevatorPendingOwner owner)
            owner.DiscardPending(execution.ExecutionId);
    }

    private bool CanAdvance(string phase, string requestId, string traceId, string executionId, long revision, PortfolioScope scope)
    {
        if (active is null || active.RequestId != requestId || active.TraceId != traceId || active.ExecutionId != executionId
            || !active.Scope.Equals(scope) || revision <= active.Revision
            || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= active.DeadlineMs)
            return false;
        int current = Array.IndexOf(Phases, active.Phases[^1].Phase);
        return Array.IndexOf(Phases, phase) == current + 1;
    }

    private static bool IsObservationShapeValid(PortfolioMineElevatorFreshObservation observation)
        => PortfolioBridgeProtocol.IsOpaqueId(observation.RequestId)
            && PortfolioBridgeProtocol.IsOpaqueId(observation.TraceId)
            && observation.Scope is not null && observation.Scope.IsValid
            && (observation.ExtensionData is null || observation.ExtensionData.Count == 0)
            && observation.CurrentFloor >= 0 && observation.CurrentFloor <= MaximumCheckpoint
            && observation.LowestMineLevel >= 0 && observation.LowestMineLevel <= MaximumCheckpoint
            && PortfolioBridgeProtocol.IsOpaqueId(observation.OpaqueElevatorTarget)
            && !String.Equals(observation.OpaqueElevatorTarget, "none", StringComparison.Ordinal);

    private static bool IsFreshObservationValid(PortfolioMineElevatorActionRequest request,
        PortfolioMineElevatorFreshObservation observation, long now)
        => observation.RequestId == request.RequestId && observation.TraceId == request.TraceId
            && request.Scope.Equals(observation.Scope) && observation.Scope.IsValid
            && (observation.ExtensionData is null || observation.ExtensionData.Count == 0)
            && observation.Fresh && observation.PlayerAvailable && observation.WorldReady && observation.PolicyAllowed
            && observation.MineEntryObserved && observation.UnlockedLevelObserved && observation.TargetUnlocked
            && observation.Revision == request.ExpectedRevision && observation.CurrentFloor >= 0
            && observation.CurrentFloor <= MaximumCheckpoint && observation.LowestMineLevel >= 0
            && observation.LowestMineLevel <= MaximumCheckpoint && observation.LowestMineLevel >= observation.CurrentFloor
            && observation.CurrentFloor != request.SelectedCheckpoint
            && IsCheckpoint(request.SelectedCheckpoint) && observation.LowestMineLevel >= request.SelectedCheckpoint
            && PortfolioBridgeProtocol.IsOpaqueId(observation.OpaqueElevatorTarget)
            && !String.Equals(observation.OpaqueElevatorTarget, "none", StringComparison.Ordinal)
            && now < request.DeadlineMs;

    private static string GuardReason(PortfolioMineElevatorActionRequest request,
        PortfolioMineElevatorFreshObservation observation, long now)
    {
        if (request.ExpectedRevision != observation.Revision) return "revision_mismatch";
        if (now >= request.DeadlineMs) return "deadline_expired";
        if (!observation.PlayerAvailable || !observation.WorldReady) return "portfolio_world_not_ready";
        if (!observation.PolicyAllowed) return "portfolio_action_not_allowed";
        if (!observation.MineEntryObserved || !observation.UnlockedLevelObserved || !observation.TargetUnlocked)
            return "mine_observation_invalid";
        return "mine_elevator_target_invalid";
    }

    private static bool IsTransitionObservationShapeValid(PortfolioMineElevatorTransitionStartedObservation observation)
        => PortfolioBridgeProtocol.IsOpaqueId(observation.RequestId)
            && PortfolioBridgeProtocol.IsOpaqueId(observation.TraceId)
            && PortfolioBridgeProtocol.IsOpaqueId(observation.ExecutionId)
            && observation.Scope is not null && observation.Scope.IsValid
            && (observation.ExtensionData is null || observation.ExtensionData.Count == 0)
            && PortfolioBridgeProtocol.IsOpaqueId(observation.OpaqueElevatorTarget)
            && !String.Equals(observation.OpaqueElevatorTarget, "none", StringComparison.Ordinal)
            && IsCheckpoint(observation.SelectedCheckpoint);

    private static bool IsTransitionObservationValid(PortfolioMineElevatorTransitionStartedObservation observation, ElevatorExecution execution)
        => IsTransitionObservationShapeValid(observation)
            && observation.Fresh && observation.PlayerAvailable && observation.WorldReady && observation.PolicyAllowed
            && observation.MineEntryObserved && observation.NativeElevatorTransitionObserved
            && observation.SelectedCheckpoint == execution.SelectedCheckpoint
            && observation.Revision > execution.Revision
            && String.Equals(observation.OpaqueElevatorTarget, execution.OpaqueElevatorTarget, StringComparison.Ordinal);

    private static bool IsPostconditionObservationShapeValid(PortfolioMineElevatorPostconditionObservation observation)
        => PortfolioBridgeProtocol.IsOpaqueId(observation.RequestId)
            && PortfolioBridgeProtocol.IsOpaqueId(observation.TraceId)
            && PortfolioBridgeProtocol.IsOpaqueId(observation.ExecutionId)
            && observation.Scope is not null && observation.Scope.IsValid
            && (observation.ExtensionData is null || observation.ExtensionData.Count == 0)
            && PortfolioBridgeProtocol.IsOpaqueId(observation.OpaqueElevatorTarget)
            && !String.Equals(observation.OpaqueElevatorTarget, "none", StringComparison.Ordinal);

    private static bool IsPostconditionObservationValid(PortfolioMineElevatorPostconditionObservation observation, ElevatorExecution execution)
        => IsPostconditionObservationShapeValid(observation)
            && observation.Fresh && observation.PlayerAvailable && observation.WorldReady && observation.PolicyAllowed
            && observation.MineEntryObserved && observation.LowestMineLevelObserved
            && observation.SelectedCheckpoint == execution.SelectedCheckpoint
            && observation.ActualCurrentFloor == execution.SelectedCheckpoint
            && observation.LowestMineLevel >= execution.SelectedCheckpoint
            && observation.LowestMineLevel <= MaximumCheckpoint
            && observation.Revision > execution.Revision
            && String.Equals(observation.OpaqueElevatorTarget, execution.OpaqueElevatorTarget, StringComparison.Ordinal)
            && execution.NativeElevatorTransitionObserved;

    private static bool IsRequestShapeValid(PortfolioMineElevatorActionRequest? request)
        => request is not null && request.IsValid && IsCheckpoint(request.SelectedCheckpoint);

    private static bool IsCheckpoint(int floor) => PortfolioBridgeProtocol.IsMineElevatorCheckpoint(floor);

    private static bool IsMatchingPostconditionTuple(PortfolioMineElevatorPostconditionObservation observation, ElevatorExecution execution)
        => observation.RequestId == execution.RequestId
            && observation.TraceId == execution.TraceId
            && observation.ExecutionId == execution.ExecutionId
            && observation.Scope is not null && observation.Scope.Equals(execution.Scope)
            && observation.OpaqueElevatorTarget == execution.OpaqueElevatorTarget
            && observation.SelectedCheckpoint == execution.SelectedCheckpoint;

    private bool IsMatchingAdapterResult(ElevatorExecution execution, PortfolioMineElevatorAdapterResult? result)
        => ReferenceEquals(this.active, execution)
            && execution.Phases.Count > 0
            && execution.Phases[^1].Phase == "accepted"
            && !execution.NativeElevatorTransitionObserved
            && result is not null && result.IsValid && result.TransitionArmed
            && result.RequestId == execution.RequestId && result.TraceId == execution.TraceId
            && result.ExecutionId == execution.ExecutionId && result.Scope.Equals(execution.Scope)
            && result.Revision == execution.Revision
            && result.SelectedCheckpoint == execution.SelectedCheckpoint
            && String.Equals(result.OpaqueElevatorTarget, execution.OpaqueElevatorTarget, StringComparison.Ordinal);
    private static string NormalizeCallbackReason(string? value) => value switch
    {
        "cancelled" => "cancelled",
        "native_operation_failed" => "native_operation_failed",
        "deadline_expired" => "deadline_expired",
        "portfolio_bridge_disconnected" => "portfolio_bridge_disconnected",
        _ => "native_operation_uncertain"
    };

    private PortfolioMineElevatorActionReceipt? TryReplay(PortfolioMineElevatorActionRequest request)
    {
        if (!completedByIdempotency.TryGetValue(request.IdempotencyKey, out ReplayEntry? entry))
            return null;
        return entry.Matches(request)
            ? entry.Receipt
            : Failure(request, NewId(), "rejected", entry.Receipt.Revision,
                "idempotency_key_reused_with_different_request", entry.Scope);
    }

    private PortfolioMineElevatorActionReceipt Remember(PortfolioMineElevatorActionRequest request, PortfolioMineElevatorActionReceipt receipt)
    {
        if (PortfolioBridgeProtocol.IsOpaqueId(request.IdempotencyKey)
            && !completedByIdempotency.ContainsKey(request.IdempotencyKey))
            completedByIdempotency.Add(request.IdempotencyKey, new ReplayEntry(request, receipt, receipt.Evidence.Scope));
        return receipt;
    }

    internal PortfolioMineElevatorActionReceipt? Invalidate(string reasonCode)
    {
        lock (this.gate)
        {
            if (active is null)
                return null;
            return TerminateActive("uncertain", "native_operation_uncertain");
        }
    }

    private PortfolioMineElevatorActionReceipt TerminateActive(string state, string reasonCode, bool enqueue = true)
    {
        ElevatorExecution execution = active!;
        execution.Phases.Add(Phase(execution, "terminal", execution.Revision, reasonCode));
        PortfolioMineElevatorActionReceipt receipt = Finish(execution, state, reasonCode);
        if (!String.Equals(execution.Phases[^1].ReasonCode, receipt.ReasonCode, StringComparison.Ordinal))
        {
            execution.Phases[^1] = Phase(execution, "terminal", execution.Revision, receipt.ReasonCode);
            receipt = Finish(execution, state, receipt.ReasonCode);
        }
        execution.TerminalReceipt = receipt;
        ReleasePending(execution);
        Remember(execution.ToRequest(), receipt);
        active = null;
        if (enqueue && !execution.BeginInProgress && PortfolioBridgeProtocol.IsOpaqueId(execution.CorrelationId))
            this.terminalDelivery.Enqueue(new PortfolioMineElevatorTerminalDelivery(execution.CorrelationId, execution.Scope, receipt));
        return receipt;
    }

    private static PortfolioMineElevatorActionReceipt Finish(ElevatorExecution execution, string state, string reasonCode)
    {
        bool validSuccess = state == "succeeded" && HasCompleteSuccessPhaseTrace(execution)
            && execution.Revision == execution.PostconditionRevision
            && execution.PostconditionRevision == execution.Phases[^2].Revision
            && execution.Phases[^1].Revision == execution.PostconditionRevision
            && execution.PostconditionRevision > execution.TransitionRevision
            && execution.NativeElevatorTransitionObserved
            && execution.CurrentFloorAfter == execution.SelectedCheckpoint
            && execution.LowestMineLevelObserved && execution.LowestMineLevelAfter >= execution.SelectedCheckpoint;
        if (state == "succeeded" && !validSuccess)
        {
            state = "uncertain";
            reasonCode = "postcondition_observation_invalid";
        }
        return new PortfolioMineElevatorActionReceipt(execution.RequestId, execution.TraceId, execution.ExecutionId,
            state, execution.Revision, reasonCode,
            new PortfolioMineElevatorActionEvidence(execution.Scope, execution.Phases.ToArray(), true,
                execution.CurrentFloorBefore, execution.LowestMineLevelBefore, execution.OpaqueElevatorTarget,
                execution.NativeElevatorTransitionObserved, execution.CurrentFloorAfter, execution.LowestMineLevelAfter,
                execution.LowestMineLevelObserved),
            new PortfolioMineElevatorActionPostcondition(execution.SelectedCheckpoint, execution.CurrentFloorAfter,
                execution.LowestMineLevelAfter, execution.OpaqueElevatorTarget, validSuccess, state == "succeeded" && validSuccess));
    }

    private static bool HasCompleteSuccessPhaseTrace(ElevatorExecution execution)
        => execution.Phases.Count == Phases.Length
            && execution.Phases[0].Phase == "fresh_observed"
            && execution.Phases[1].Phase == "accepted"
            && execution.Phases[2].Phase == "transition_started"
            && execution.Phases[3].Phase == "postcondition"
            && execution.Phases[4].Phase == "terminal"
            && execution.Phases[0].ReasonCode == "fresh_observed"
            && execution.Phases[1].ReasonCode == "accepted"
            && execution.Phases[2].ReasonCode == "mine_elevator_transition_started"
            && execution.Phases[3].ReasonCode == "postcondition_observed"
            && execution.Phases[4].ReasonCode == "mine_elevator_floor_selected"
            && execution.Phases[0].Revision == execution.BeforeRevision
            && execution.Phases[1].Revision == execution.BeforeRevision
            && execution.Phases[2].Revision == execution.TransitionRevision
            && execution.Phases[2].Revision > execution.BeforeRevision
            && execution.Phases[3].Revision == execution.PostconditionRevision
            && execution.Phases[3].Revision > execution.TransitionRevision
            && execution.Phases[4].Revision == execution.PostconditionRevision;

    private static PortfolioMineElevatorActionBeginResult AcceptedResult(ElevatorExecution execution)
        => new(new PortfolioMineElevatorActionPhase(execution.RequestId, execution.TraceId, execution.ExecutionId,
            "accepted", execution.Revision, "accepted"), null);

    private static PortfolioMineElevatorActionBeginResult TerminalResult(PortfolioMineElevatorActionReceipt receipt)
        => new(null, receipt);

    private static PortfolioMineElevatorActionReceipt Failure(PortfolioMineElevatorActionRequest request, string executionId,
        string state, long revision, string reasonCode, PortfolioScope scope)
        => Failure(request.RequestId, request.TraceId, executionId, state, revision, reasonCode, scope);

    private static PortfolioMineElevatorActionReceipt Failure(string requestId, string traceId, string executionId,
        string state, long revision, string reasonCode, PortfolioScope scope)
    {
        PortfolioMineElevatorActionPhase[] phases =
        {
            new(requestId, traceId, executionId, "fresh_observed", revision, "fresh_observed"),
            new(requestId, traceId, executionId, "terminal", revision, reasonCode),
        };
        return new PortfolioMineElevatorActionReceipt(requestId, traceId, executionId, state, revision, reasonCode,
            new PortfolioMineElevatorActionEvidence(scope, phases, false, 0, 0, null, false, 0, 0, false),
            new PortfolioMineElevatorActionPostcondition(null, 0, 0, null, false, false));
    }

    private static PortfolioMineElevatorActionPhase Phase(ElevatorExecution execution, string phase, long revision, string reasonCode)
        => new(execution.RequestId, execution.TraceId, execution.ExecutionId, phase, revision, reasonCode);

    private static string NewId() => Guid.NewGuid().ToString("N");
    private static string SafeId(string? value) => PortfolioBridgeProtocol.IsOpaqueId(value) ? value! : "invalid";
    private static PortfolioScope SafeScope(PortfolioScope? scope) => scope is not null && scope.IsValid ? scope : InvalidScope();
    private static PortfolioScope InvalidScope() => new(PortfolioBridgeProtocol.IntegrationId, PortfolioBridgeProtocol.Topology,
        "invalid", "invalid", "invalid", "invalid", 0, new string('0', 64));

    private sealed class ElevatorExecution
    {
        internal ElevatorExecution(PortfolioMineElevatorActionRequest request, PortfolioMineElevatorFreshObservation observation, string executionId, string correlationId)
        {
            RequestId = request.RequestId; TraceId = request.TraceId; IdempotencyKey = request.IdempotencyKey; CorrelationId = correlationId;
            CancellationToken = request.CancellationToken; DeadlineMs = request.DeadlineMs; BeforeRevision = observation.Revision;
            Revision = observation.Revision; ExecutionId = executionId; Scope = observation.Scope;
            Action = request.Action; SelectedCheckpoint = request.SelectedCheckpoint; OpaqueElevatorTarget = observation.OpaqueElevatorTarget;
            CurrentFloorBefore = observation.CurrentFloor; LowestMineLevelBefore = observation.LowestMineLevel;
        }
        internal string Action { get; }
        internal string RequestId { get; }
        internal string TraceId { get; }
        internal string IdempotencyKey { get; }
        internal string CorrelationId { get; }
        internal string CancellationToken { get; }
        internal long DeadlineMs { get; }
        internal long BeforeRevision { get; }
        internal long Revision { get; set; }
        internal string ExecutionId { get; }
        internal PortfolioScope Scope { get; }
        internal int SelectedCheckpoint { get; }
        internal string OpaqueElevatorTarget { get; }
        internal int CurrentFloorBefore { get; }
        internal int LowestMineLevelBefore { get; }
        internal int CurrentFloorAfter { get; set; }
        internal int LowestMineLevelAfter { get; set; }
        internal bool Irreversible { get; set; }
        internal bool TransitionArmed { get; set; }
        internal bool AdapterCallInProgress { get; set; }
        internal bool BeginInProgress { get; set; } = true;
        internal bool Cancelled { get; set; }
        internal bool NativeElevatorTransitionObserved { get; set; }
        internal long TransitionRevision { get; set; }
        internal long PostconditionRevision { get; set; }
        internal bool LowestMineLevelObserved { get; set; }
        internal PortfolioMineElevatorActionReceipt? TerminalReceipt { get; set; }
        internal List<PortfolioMineElevatorActionPhase> Phases { get; } = new();
        internal PortfolioMineElevatorActionRequest ToRequest() => new(Action, RequestId, TraceId, IdempotencyKey,
            SelectedCheckpoint, BeforeRevision, DeadlineMs, CancellationToken, Scope);
    }

    private sealed record ReplayEntry(PortfolioMineElevatorActionRequest Request,
        PortfolioMineElevatorActionReceipt Receipt, PortfolioScope Scope)
    {
        internal bool Matches(PortfolioMineElevatorActionRequest request)
            => Request.Action == request.Action && Request.RequestId == request.RequestId && Request.TraceId == request.TraceId
                && Request.IdempotencyKey == request.IdempotencyKey && Request.SelectedCheckpoint == request.SelectedCheckpoint
                && Request.ExpectedRevision == request.ExpectedRevision && Request.DeadlineMs == request.DeadlineMs
                && Request.CancellationToken == request.CancellationToken && Request.Scope.Equals(request.Scope)
                && Request.Scope.BindingHash == request.Scope.BindingHash;
    }
}
