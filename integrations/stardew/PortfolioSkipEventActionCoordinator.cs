namespace GameBuddy.Stardew;

/// <summary>
/// Game-thread-owned state machine for the bounded, observation-driven event
/// skip primitive. It never resolves a target from caller text and never
/// invokes a native game member: the adapter owns that semantic edge.
/// </summary>
internal interface IPortfolioSkipEventPendingOwner
{
    void DiscardPending(string executionId);
}

internal sealed class PortfolioSkipEventActionCoordinator
{
    private const string Action = PortfolioBridgeProtocol.SkipEventAction;
    private static readonly string[] Phases = { "fresh_observed", "accepted", "native_skip", "postcondition", "terminal" };

    private readonly object gate = new();
    private readonly IPortfolioSkipEventSemanticAdapter? adapter;
    private readonly Dictionary<string, ReplayEntry> completedByIdempotency = new(StringComparer.Ordinal);
    private readonly PortfolioTerminalDeliveryCore<PortfolioSkipEventTerminalDelivery> terminalDelivery = new();
    private SkipEventExecution? active;

    internal PortfolioSkipEventActionCoordinator(IPortfolioSkipEventSemanticAdapter? adapter = null) => this.adapter = adapter;

    internal bool HasActiveExecution
    {
        get { lock (this.gate) return this.active is not null; }
    }

    internal PortfolioSkipEventActionBeginResult Begin(
        PortfolioSkipEventActionRequest request,
        PortfolioSkipEventFreshObservation observation,
        string correlationId)
    {
        lock (this.gate)
        {
            string executionId = NewId();
            if (request is null)
                return TerminalResult(Failure("invalid", "invalid", executionId, "rejected", 0, "invalid_skip_event_request", InvalidScope()));
            if (!IsRequestShapeValid(request))
                return TerminalResult(Failure(SafeId(request.RequestId), SafeId(request.TraceId), executionId, "rejected", 0,
                    "invalid_skip_event_request", SafeScope(request.Scope)));

            // Replay an exact completed request before dynamic observation,
            // revision, and deadline guards.
            PortfolioSkipEventActionReceipt? replay = TryReplay(request);
            if (replay is not null)
                return TerminalResult(replay);
            if (observation is null || !IsObservationShapeValid(observation))
                return TerminalResult(Failure(request, executionId, "rejected", observation?.Revision ?? 0, "invalid_skip_event_observation", SafeScope(observation?.Scope)));

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
                return TerminalResult(Failure(request, executionId, "blocked", observation.Revision, "execution_already_active", observation.Scope));
            if (adapter is null || !adapter.IsAvailable)
                return TerminalResult(Remember(request, Failure(request, executionId, "blocked", observation.Revision, "adapter_unavailable", observation.Scope)));

            if (!PortfolioBridgeProtocol.IsOpaqueId(correlationId))
                return TerminalResult(Failure(request, executionId, "rejected", observation.Revision, "invalid_envelope", observation.Scope));
            SkipEventExecution execution = new(request, observation, executionId, correlationId);
            execution.Phases.Add(Phase(execution, "fresh_observed", observation.Revision, "fresh_observed"));
            execution.Phases.Add(Phase(execution, "accepted", observation.Revision, "accepted"));
            active = execution;
            bool armed;
            PortfolioSkipEventAdapterResult? adapterResult;
            try
            {
                // Crossing this boundary may issue the native skip before the
                // adapter returns (including during a reentrant callback), so
                // cancellation must remain fail-closed until an explicit native
                // outcome arrives.
                execution.TransitionArmed = true;
                execution.AdapterCallInProgress = true;
                armed = adapter.RequestSkipEvent(new PortfolioSkipEventAdapterContext(
                    request.RequestId, request.TraceId, executionId, request.CancellationToken,
                    observation.Scope, observation.OpaqueEventTarget, observation.NativeEventId,
                    request.ExpectedRevision, request.DeadlineMs), out adapterResult);
            }
            catch
            {
                armed = false;
                adapterResult = null;
            }
            execution.AdapterCallInProgress = false;
            execution.BeginInProgress = false;
            if (active != execution && execution.TerminalReceipt is not null)
                return TerminalResult(execution.TerminalReceipt);
            if (!armed || adapterResult is null || execution.Cancelled || !IsMatchingAdapterResult(execution, adapterResult)
                || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= execution.DeadlineMs)
            {
                return TerminalResult(TerminateActive("uncertain", "native_operation_uncertain", enqueue: false));
            }
            // The adapter result acknowledges the exact native skip issuance;
            // it is not a second observation and must reuse its revision.
            return AcceptedResult(execution);
        }
    }

    internal bool TryPeekTerminalDelivery(out PortfolioSkipEventTerminalDelivery? delivery)
        => this.terminalDelivery.TryPeekTerminalDelivery(out delivery);

    internal bool TryArmTerminalDelivery(PortfolioSkipEventTerminalDelivery delivery, PortfolioPipeOutboundCompletion completion)
        => this.terminalDelivery.TryArmTerminalDelivery(delivery, completion);

    internal bool IsTerminalDeliveryPending(PortfolioSkipEventTerminalDelivery delivery)
        => this.terminalDelivery.IsTerminalDeliveryPending(delivery);

    internal bool TryCompleteTerminalDelivery(PortfolioSkipEventTerminalDelivery delivery, long authenticatedGeneration, out bool failed)
        => this.terminalDelivery.TryCompleteTerminalDelivery(delivery, authenticatedGeneration, out failed);

    internal bool TryAcknowledgeTerminalDelivery(PortfolioSkipEventTerminalDelivery delivery)
        => this.terminalDelivery.TryAcknowledgeTerminalDelivery(delivery);

    internal PortfolioSkipEventActionReceipt Cancel(PortfolioSkipEventActionCancelRequest request)
    {
        lock (this.gate)
        {
            if (request is null)
                return Failure("invalid", "invalid", NewId(), "rejected", active?.Revision ?? 0, "invalid_skip_event_cancel_request", active?.Scope ?? InvalidScope());
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

    internal bool ObserveNativeSkip(PortfolioSkipEventNativeSkipObservation observation)
    {
        lock (this.gate)
        {
            if (observation is null || active is null || active.Cancelled
                || !IsNativeSkipObservationShapeValid(observation)
                || !CanAdvance("native_skip", observation.RequestId, observation.TraceId, observation.ExecutionId,
                    observation.Revision, observation.Scope)
                || !IsNativeSkipObservationValid(observation, active))
                return false;
            SkipEventExecution execution = active!;
            execution.NativeSkipObserved = true;
            execution.Irreversible = true;
            execution.NativeSkipRevision = observation.Revision;
            execution.Phases.Add(Phase(execution, "native_skip", observation.Revision, "skip_event_native_skip"));
            execution.Revision = observation.Revision;
            return true;
        }
    }

    internal PortfolioSkipEventActionReceipt ObservePostcondition(PortfolioSkipEventPostconditionObservation observation)
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
                // An exact callback after native_skip proves the irreversible
                // native edge happened, but not a clean postcondition. Preserve
                // that fact with the post-native uncertain receipt shape.
                if (IsMatchingPostconditionTuple(observation, active))
                    return TerminateActive("uncertain", "native_operation_uncertain");
                return Failure(SafeId(observation.RequestId), SafeId(observation.TraceId), SafeId(observation.ExecutionId), "uncertain", observation.Revision,
                    "postcondition_observation_invalid", SafeScope(observation.Scope));
            }

            SkipEventExecution execution = active;
            execution.EventCleared = true;
            execution.PostEventStateClean = observation.PostEventStateClean;
            execution.PostconditionRevision = observation.Revision;
            execution.Phases.Add(Phase(execution, "postcondition", observation.Revision, "postcondition_observed"));
            execution.Revision = observation.Revision;
            return TerminateActive("succeeded", "skip_event_completed");
        }
    }

    internal PortfolioSkipEventActionReceipt Fail(
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

            SkipEventExecution execution = active;
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= execution.DeadlineMs)
                return TerminateActive(execution.TransitionArmed ? "uncertain" : "expired",
                    execution.TransitionArmed ? "native_operation_uncertain" : "deadline_expired");
            if (revision <= execution.Revision)
                return TerminateActive("uncertain", "stale_callback_revision");

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

    private void ReleasePending(SkipEventExecution execution)
    {
        if (this.adapter is IPortfolioSkipEventPendingOwner owner)
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

    private static bool IsObservationShapeValid(PortfolioSkipEventFreshObservation observation)
        => PortfolioBridgeProtocol.IsOpaqueId(observation.RequestId)
            && PortfolioBridgeProtocol.IsOpaqueId(observation.TraceId)
            && observation.Scope is not null && observation.Scope.IsValid
            && (observation.ExtensionData is null || observation.ExtensionData.Count == 0);

    private static bool IsFreshObservationValid(PortfolioSkipEventActionRequest request,
        PortfolioSkipEventFreshObservation observation, long now)
        => observation.RequestId == request.RequestId && observation.TraceId == request.TraceId
            && request.Scope.Equals(observation.Scope) && observation.Scope.IsValid
            && (observation.ExtensionData is null || observation.ExtensionData.Count == 0)
            && observation.Fresh && observation.PlayerAvailable && observation.WorldReady && observation.PolicyAllowed
            // Event.skipEvent() is a direct native terminal and does not
            // consult Event.skippable; that flag describes UI affordance only.
            && observation.EventObserved
            && observation.Revision == request.ExpectedRevision
            && now < request.DeadlineMs;

    private static string GuardReason(PortfolioSkipEventActionRequest request,
        PortfolioSkipEventFreshObservation observation, long now)
    {
        if (request.ExpectedRevision != observation.Revision) return "revision_mismatch";
        if (now >= request.DeadlineMs) return "deadline_expired";
        if (!observation.PlayerAvailable || !observation.WorldReady) return "portfolio_world_not_ready";
        if (!observation.PolicyAllowed) return "portfolio_action_not_allowed";
        if (!observation.EventObserved) return "skip_event_no_active_event";
        return "skip_event_target_invalid";
    }

    private static bool IsNativeSkipObservationShapeValid(PortfolioSkipEventNativeSkipObservation observation)
        => PortfolioBridgeProtocol.IsOpaqueId(observation.RequestId)
            && PortfolioBridgeProtocol.IsOpaqueId(observation.TraceId)
            && PortfolioBridgeProtocol.IsOpaqueId(observation.ExecutionId)
            && observation.Scope is not null && observation.Scope.IsValid
            && (observation.ExtensionData is null || observation.ExtensionData.Count == 0);

    private static bool IsNativeSkipObservationValid(PortfolioSkipEventNativeSkipObservation observation, SkipEventExecution execution)
        => IsNativeSkipObservationShapeValid(observation)
            && observation.Fresh && observation.PlayerAvailable && observation.WorldReady && observation.PolicyAllowed
            && observation.EventObserved && observation.NativeSkipObserved
            && observation.Revision > execution.Revision
            && (observation.OpaqueEventTarget is null || execution.OpaqueEventTarget is null || String.Equals(observation.OpaqueEventTarget, execution.OpaqueEventTarget, StringComparison.Ordinal))
            && (observation.NativeEventId is null || execution.NativeEventId is null || String.Equals(observation.NativeEventId, execution.NativeEventId, StringComparison.Ordinal));

    private static bool IsPostconditionObservationShapeValid(PortfolioSkipEventPostconditionObservation observation)
        => PortfolioBridgeProtocol.IsOpaqueId(observation.RequestId)
            && PortfolioBridgeProtocol.IsOpaqueId(observation.TraceId)
            && PortfolioBridgeProtocol.IsOpaqueId(observation.ExecutionId)
            && observation.Scope is not null && observation.Scope.IsValid
            && (observation.ExtensionData is null || observation.ExtensionData.Count == 0);

    private static bool IsPostconditionObservationValid(PortfolioSkipEventPostconditionObservation observation, SkipEventExecution execution)
        => IsPostconditionObservationShapeValid(observation)
            && observation.Fresh && observation.PlayerAvailable && observation.WorldReady && observation.PolicyAllowed
            && observation.EventCleared
            && observation.PostEventStateClean
            && observation.Revision > execution.Revision
            && (observation.OpaqueEventTarget is null || execution.OpaqueEventTarget is null || String.Equals(observation.OpaqueEventTarget, execution.OpaqueEventTarget, StringComparison.Ordinal))
            && (observation.NativeEventId is null || execution.NativeEventId is null || String.Equals(observation.NativeEventId, execution.NativeEventId, StringComparison.Ordinal))
            && execution.NativeSkipObserved;

    private static bool IsRequestShapeValid(PortfolioSkipEventActionRequest? request)
        => request is not null && request.IsValid;

    private static bool IsMatchingPostconditionTuple(PortfolioSkipEventPostconditionObservation observation, SkipEventExecution execution)
        => observation.RequestId == execution.RequestId
            && observation.TraceId == execution.TraceId
            && observation.ExecutionId == execution.ExecutionId
            && observation.Scope is not null && observation.Scope.Equals(execution.Scope);

    private bool IsMatchingAdapterResult(SkipEventExecution execution, PortfolioSkipEventAdapterResult? result)
        => ReferenceEquals(this.active, execution)
            && execution.Phases.Count > 0
            && (execution.Phases[^1].Phase == "accepted" || execution.Phases[^1].Phase == "native_skip")
            && result is not null && result.IsValid && result.NativeSkipIssued
            && (!execution.NativeSkipObserved || result.Revision == execution.NativeSkipRevision)
            && result.RequestId == execution.RequestId && result.TraceId == execution.TraceId
            && result.ExecutionId == execution.ExecutionId && result.Scope.Equals(execution.Scope)
            && (result.Revision == execution.Revision || result.Revision == execution.NativeSkipRevision);

    private static string NormalizeCallbackReason(string? value) => value switch
    {
        "cancelled" => "cancelled",
        "native_operation_failed" => "native_operation_failed",
        "deadline_expired" => "deadline_expired",
        "portfolio_bridge_disconnected" => "portfolio_bridge_disconnected",
        _ => "native_operation_uncertain"
    };

    private PortfolioSkipEventActionReceipt? TryReplay(PortfolioSkipEventActionRequest request)
    {
        if (!completedByIdempotency.TryGetValue(request.IdempotencyKey, out ReplayEntry? entry))
            return null;
        return entry.Matches(request)
            ? entry.Receipt
            : Failure(request, NewId(), "rejected", entry.Receipt.Revision,
                "idempotency_key_reused_with_different_request", entry.Scope);
    }

    private PortfolioSkipEventActionReceipt Remember(PortfolioSkipEventActionRequest request, PortfolioSkipEventActionReceipt receipt)
    {
        if (PortfolioBridgeProtocol.IsOpaqueId(request.IdempotencyKey)
            && !completedByIdempotency.ContainsKey(request.IdempotencyKey))
            completedByIdempotency.Add(request.IdempotencyKey, new ReplayEntry(request, receipt, receipt.Evidence.Scope));
        return receipt;
    }

    internal PortfolioSkipEventActionReceipt? Invalidate(string reasonCode)
    {
        lock (this.gate)
        {
            if (active is null)
                return null;
            return TerminateActive("uncertain", "native_operation_uncertain");
        }
    }

    private PortfolioSkipEventActionReceipt TerminateActive(string state, string reasonCode, bool enqueue = true)
    {
        SkipEventExecution execution = active!;
        execution.Phases.Add(Phase(execution, "terminal", execution.Revision, reasonCode));
        PortfolioSkipEventActionReceipt receipt = Finish(execution, state, reasonCode);
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
            this.terminalDelivery.Enqueue(new PortfolioSkipEventTerminalDelivery(execution.CorrelationId, execution.Scope, receipt));
        return receipt;
    }

    private static PortfolioSkipEventActionReceipt Finish(SkipEventExecution execution, string state, string reasonCode)
    {
        bool validSuccess = state == "succeeded" && HasCompleteSuccessPhaseTrace(execution)
            && execution.Revision == execution.PostconditionRevision
            && execution.PostconditionRevision == execution.Phases[^2].Revision
            && execution.Phases[^1].Revision == execution.PostconditionRevision
            && execution.PostconditionRevision > execution.NativeSkipRevision
            && execution.NativeSkipObserved
            && execution.EventCleared
            && execution.PostEventStateClean;
        if (state == "succeeded" && !validSuccess)
        {
            state = "uncertain";
            reasonCode = "postcondition_observation_invalid";
        }
        return new PortfolioSkipEventActionReceipt(execution.RequestId, execution.TraceId, execution.ExecutionId,
            state, execution.Revision, reasonCode,
            new PortfolioSkipEventActionEvidence(execution.Scope, execution.Phases.ToArray(),
                execution.EventObserved, execution.EventSkippable,
                execution.OpaqueEventTarget, execution.NativeEventId,
                execution.NativeSkipObserved, execution.EventCleared, execution.PostEventStateClean),
            new PortfolioSkipEventActionPostcondition(execution.PostEventStateClean, validSuccess, state == "succeeded" && validSuccess));
    }

    private static bool HasCompleteSuccessPhaseTrace(SkipEventExecution execution)
        => execution.Phases.Count == Phases.Length
            && execution.Phases[0].Phase == "fresh_observed"
            && execution.Phases[1].Phase == "accepted"
            && execution.Phases[2].Phase == "native_skip"
            && execution.Phases[3].Phase == "postcondition"
            && execution.Phases[4].Phase == "terminal"
            && execution.Phases[0].ReasonCode == "fresh_observed"
            && execution.Phases[1].ReasonCode == "accepted"
            && execution.Phases[2].ReasonCode == "skip_event_native_skip"
            && execution.Phases[3].ReasonCode == "postcondition_observed"
            && execution.Phases[4].ReasonCode == "skip_event_completed"
            && execution.Phases[0].Revision == execution.BeforeRevision
            && execution.Phases[1].Revision == execution.BeforeRevision
            && execution.Phases[2].Revision == execution.NativeSkipRevision
            && execution.Phases[2].Revision > execution.BeforeRevision
            && execution.Phases[3].Revision == execution.PostconditionRevision
            && execution.Phases[3].Revision > execution.NativeSkipRevision
            && execution.Phases[4].Revision == execution.PostconditionRevision;

    private static PortfolioSkipEventActionBeginResult AcceptedResult(SkipEventExecution execution)
        // The native adapter may synchronously advance execution.Revision before
        // Begin returns. Return the immutable accepted phase already recorded
        // before that boundary so the immediate frame and terminal trace agree.
        => new(execution.Phases[1], null);

    private static PortfolioSkipEventActionBeginResult TerminalResult(PortfolioSkipEventActionReceipt receipt)
        => new(null, receipt);

    private static PortfolioSkipEventActionReceipt Failure(PortfolioSkipEventActionRequest request, string executionId,
        string state, long revision, string reasonCode, PortfolioScope scope)
        => Failure(request.RequestId, request.TraceId, executionId, state, revision, reasonCode, scope);

    private static PortfolioSkipEventActionReceipt Failure(string requestId, string traceId, string executionId,
        string state, long revision, string reasonCode, PortfolioScope scope)
    {
        PortfolioSkipEventActionPhase[] phases =
        {
            new(requestId, traceId, executionId, "fresh_observed", revision, "fresh_observed"),
            new(requestId, traceId, executionId, "terminal", revision, reasonCode),
        };
        return new PortfolioSkipEventActionReceipt(requestId, traceId, executionId, state, revision, reasonCode,
            new PortfolioSkipEventActionEvidence(scope, phases, false, false, null, null, false, false, false),
            new PortfolioSkipEventActionPostcondition(false, false, false));
    }

    private static PortfolioSkipEventActionPhase Phase(SkipEventExecution execution, string phase, long revision, string reasonCode)
        => new(execution.RequestId, execution.TraceId, execution.ExecutionId, phase, revision, reasonCode);

    private static string NewId() => Guid.NewGuid().ToString("N");
    private static string SafeId(string? value) => PortfolioBridgeProtocol.IsOpaqueId(value) ? value! : "invalid";
    private static PortfolioScope SafeScope(PortfolioScope? scope) => scope is not null && scope.IsValid ? scope : InvalidScope();
    private static PortfolioScope InvalidScope() => new(PortfolioBridgeProtocol.IntegrationId, PortfolioBridgeProtocol.Topology,
        "invalid", "invalid", "invalid", "invalid", 0, new string('0', 64));

    private sealed class SkipEventExecution
    {
        internal SkipEventExecution(PortfolioSkipEventActionRequest request, PortfolioSkipEventFreshObservation observation, string executionId, string correlationId)
        {
            RequestId = request.RequestId; TraceId = request.TraceId; IdempotencyKey = request.IdempotencyKey; CorrelationId = correlationId;
            CancellationToken = request.CancellationToken; DeadlineMs = request.DeadlineMs; BeforeRevision = observation.Revision;
            Revision = observation.Revision; ExecutionId = executionId; Scope = observation.Scope;
            Action = request.Action;
            EventObserved = observation.EventObserved;
            EventSkippable = observation.EventSkippable;
            OpaqueEventTarget = observation.OpaqueEventTarget;
            NativeEventId = observation.NativeEventId;
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
        internal bool EventObserved { get; }
        internal bool EventSkippable { get; }
        internal string? OpaqueEventTarget { get; }
        internal string? NativeEventId { get; }
        internal bool Irreversible { get; set; }
        internal bool TransitionArmed { get; set; }
        internal bool AdapterCallInProgress { get; set; }
        internal bool BeginInProgress { get; set; } = true;
        internal bool Cancelled { get; set; }
        internal bool NativeSkipObserved { get; set; }
        internal long NativeSkipRevision { get; set; }
        internal long PostconditionRevision { get; set; }
        internal bool EventCleared { get; set; }
        internal bool PostEventStateClean { get; set; }
        internal PortfolioSkipEventActionReceipt? TerminalReceipt { get; set; }
        internal List<PortfolioSkipEventActionPhase> Phases { get; } = new();
        internal PortfolioSkipEventActionRequest ToRequest() => new(Action, RequestId, TraceId, IdempotencyKey,
            BeforeRevision, DeadlineMs, CancellationToken, Scope);
    }

    private sealed record ReplayEntry(PortfolioSkipEventActionRequest Request,
        PortfolioSkipEventActionReceipt Receipt, PortfolioScope Scope)
    {
        internal bool Matches(PortfolioSkipEventActionRequest request)
            => Request.Action == request.Action && Request.RequestId == request.RequestId && Request.TraceId == request.TraceId
                && Request.IdempotencyKey == request.IdempotencyKey
                && Request.ExpectedRevision == request.ExpectedRevision && Request.DeadlineMs == request.DeadlineMs
                && Request.CancellationToken == request.CancellationToken && Request.Scope.Equals(request.Scope)
                && Request.Scope.BindingHash == request.Scope.BindingHash;
    }
}