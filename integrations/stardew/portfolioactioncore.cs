namespace GameBuddy.Stardew;

/// <summary>
/// Shared, Portfolio-local execution state for the three Mine transition
/// action families (Entry / Ladder / Elevator). It carries the common
/// lifecycle facts the shared core owns; action-specific semantic facts
/// (target floor, opaque target, floors before/after) live here under
/// family-neutral names and are projected by the family semantics.
/// </summary>
internal sealed class MineExecutionState<TPhase, TReceipt>
    where TPhase : notnull
    where TReceipt : class
{
    internal MineExecutionState(
        string action,
        string requestId,
        string traceId,
        string idempotencyKey,
        string correlationId,
        string cancellationToken,
        long deadlineMs,
        long beforeRevision,
        string executionId,
        PortfolioScope scope,
        int targetFloor,
        string opaqueTarget,
        int currentFloorBefore,
        int lowestMineLevelBefore)
    {
        Action = action;
        RequestId = requestId;
        TraceId = traceId;
        IdempotencyKey = idempotencyKey;
        CorrelationId = correlationId;
        CancellationToken = cancellationToken;
        DeadlineMs = deadlineMs;
        BeforeRevision = beforeRevision;
        Revision = beforeRevision;
        ExecutionId = executionId;
        Scope = scope;
        TargetFloor = targetFloor;
        OpaqueTarget = opaqueTarget;
        CurrentFloorBefore = currentFloorBefore;
        LowestMineLevelBefore = lowestMineLevelBefore;
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
    /// <summary>Elevator: selected checkpoint; Ladder/Entry: target floor.</summary>
    internal int TargetFloor { get; }
    /// <summary>Elevator: opaque elevator target; Ladder: opaque ladder target; Entry: opaque entry target.</summary>
    internal string OpaqueTarget { get; }
    internal int CurrentFloorBefore { get; }
    internal int LowestMineLevelBefore { get; }
    internal int CurrentFloorAfter { get; set; }
    internal int LowestMineLevelAfter { get; set; }
    internal bool Irreversible { get; set; }
    internal bool TransitionArmed { get; set; }
    internal bool AdapterCallInProgress { get; set; }
    internal bool BeginInProgress { get; set; } = true;
    internal bool Cancelled { get; set; }
    internal bool PendingReleased { get; set; }
    internal bool NativeTransitionObserved { get; set; }
    internal long TransitionRevision { get; set; }
    internal long PostconditionRevision { get; set; }
    internal bool LowestMineLevelObserved { get; set; }
    internal TReceipt? TerminalReceipt { get; set; }
    internal List<TPhase> Phases { get; } = new();
}

/// <summary>
/// Family-specific semantic surface for the shared Mine action core. Every
/// member is provided by the family coordinator (production composition); the
/// core never selects a native member, interprets evidence, or derives policy.
/// </summary>
internal interface IPortfolioMineActionSemantics<TRequest, TCancelRequest, TFreshFloorRequest, TTransitionObservation, TPostconditionObservation, TPhase, TReceipt, TDelivery>
    where TPhase : notnull
    where TReceipt : class
    where TRequest : notnull
{
    string[] Phases { get; }
    string InvalidRequestReason { get; }
    string InvalidObservationReason { get; }
    string InvalidCancelReason { get; }
    string TransitionStartedReason { get; }
    string SuccessReason { get; }

    // Replay / idempotency.
    string IdempotencyKeyOf(TRequest request);
    bool RequestsMatch(TRequest left, TRequest right);
    PortfolioScope ScopeOfReceipt(TReceipt receipt);
    string ReasonCodeOf(TReceipt receipt);
    (string RequestId, string TraceId, string ExecutionId, string State, long Revision) ReceiptTupleOf(TReceipt receipt);
    string CancellationTokenOf(TRequest request);
    TRequest ToRequest(MineExecutionState<TPhase, TReceipt> execution);

    // Cancel.
    bool IsCancelRequestShapeValid(TCancelRequest request);
    string CancelAction(TCancelRequest request);
    string CancelRequestId(TCancelRequest request);
    string CancelTraceId(TCancelRequest request);
    string CancelExecutionId(TCancelRequest request);
    string CancelToken(TCancelRequest request);
    PortfolioScope CancelScope(TCancelRequest request);

    // Transition-started observation.
    bool IsTransitionObservationShapeValid(TTransitionObservation observation);
    bool IsTransitionObservationValid(TTransitionObservation observation, MineExecutionState<TPhase, TReceipt> execution);
    (string RequestId, string TraceId, string ExecutionId, long Revision, PortfolioScope Scope) TransitionTupleOf(TTransitionObservation observation);
    void ApplyTransitionObserved(MineExecutionState<TPhase, TReceipt> execution);

    // Postcondition observation.
    bool IsPostconditionObservationShapeValid(TPostconditionObservation observation);
    bool IsPostconditionObservationValid(TPostconditionObservation observation, MineExecutionState<TPhase, TReceipt> execution);
    (string RequestId, string TraceId, string ExecutionId, long Revision, PortfolioScope Scope) PostconditionTupleOf(TPostconditionObservation observation);
    bool IsMatchingPostconditionTuple(TPostconditionObservation observation, MineExecutionState<TPhase, TReceipt> execution);
    void ApplyPostcondition(MineExecutionState<TPhase, TReceipt> execution, TPostconditionObservation observation);

    // Fresh-floor reader.
    bool IsFreshFloorRequestShapeValid(TFreshFloorRequest request);
    long FreshFloorDeadline(TFreshFloorRequest request);
    (string RequestId, string TraceId, string ExecutionId, long ExpectedRevision, string CancellationToken, PortfolioScope Scope) FreshFloorTuple(TFreshFloorRequest request);
    int FreshFloorTargetOf(TRequest request, TReceipt receipt);

    // Receipt / phase / delivery projection.
    string PhaseName(TPhase phase);
    string PhaseReasonCode(TPhase phase);
    TPhase Phase(MineExecutionState<TPhase, TReceipt> execution, string phase, long revision, string reasonCode);
    TReceipt Failure(TRequest request, string executionId, string state, long revision, string reasonCode, PortfolioScope scope);
    TReceipt Failure(string requestId, string traceId, string executionId, string state, long revision, string reasonCode, PortfolioScope scope);
    TReceipt Finish(MineExecutionState<TPhase, TReceipt> execution, string state, string reasonCode);
    TDelivery Delivery(string correlationId, PortfolioScope scope, TReceipt receipt);
    void ReleasePending(string executionId);
}

/// <summary>
/// Shared, Portfolio-local execution mechanics for the Mine transition action
/// families. It owns replay/idempotency, single-active-execution ownership,
/// phase ordering, cancellation state, terminalization and the generation-bound
/// terminal delivery queue. It never resolves a target, invokes a native game
/// member, interprets evidence, or derives policy; family semantics are
/// injected through <see cref="IPortfolioMineActionSemantics{TRequest,TCancelRequest,TFreshFloorRequest,TTransitionObservation,TPostconditionObservation,TPhase,TReceipt,TDelivery}"/>.
/// All state is game-thread-owned; locks are reentrant so a locked semantic
/// callback (e.g. the Begin adapter invocation) may call back into the core.
/// </summary>
internal sealed class PortfolioMineActionCore<TRequest, TCancelRequest, TFreshFloorRequest, TTransitionObservation, TPostconditionObservation, TPhase, TReceipt, TDelivery>
    where TRequest : notnull
    where TCancelRequest : notnull
    where TFreshFloorRequest : notnull
    where TTransitionObservation : notnull
    where TPostconditionObservation : notnull
    where TPhase : notnull
    where TReceipt : class
    where TDelivery : notnull
{
    private readonly object gate = new();
    private readonly Func<long> clock;
    private readonly IPortfolioMineActionSemantics<TRequest, TCancelRequest, TFreshFloorRequest, TTransitionObservation, TPostconditionObservation, TPhase, TReceipt, TDelivery> semantics;
    private readonly Dictionary<string, ReplayEntry> completedByIdempotency = new(StringComparer.Ordinal);
    private readonly Queue<TDelivery> terminalDeliveries = new();
    private readonly Dictionary<TDelivery, PortfolioPipeOutboundCompletion> terminalCompletions = new();
    private MineExecutionState<TPhase, TReceipt>? active;

    internal PortfolioMineActionCore(
        IPortfolioMineActionSemantics<TRequest, TCancelRequest, TFreshFloorRequest, TTransitionObservation, TPostconditionObservation, TPhase, TReceipt, TDelivery> semantics,
        Func<long>? clock = null)
    {
        this.semantics = semantics;
        this.clock = clock ?? DefaultUtcNowMs;
    }

    /// <summary>
    /// Runs a Begin body while holding the core gate, preserving the original
    /// "adapter invocation runs under the lock" reentrancy semantics.
    /// </summary>
    internal TResult RunLocked<TResult>(Func<PortfolioMineActionCore<TRequest, TCancelRequest, TFreshFloorRequest, TTransitionObservation, TPostconditionObservation, TPhase, TReceipt, TDelivery>, TResult> body)
    {
        lock (this.gate)
            return body(this);
    }

    internal long Now() => this.clock();

    internal bool HasActiveExecution
    {
        get { lock (this.gate) return this.active is not null; }
    }

    internal bool IsCurrent(MineExecutionState<TPhase, TReceipt> execution)
    {
        lock (this.gate)
            return ReferenceEquals(this.active, execution);
    }

    internal TReceipt? TryReplay(TRequest request)
    {
        lock (this.gate)
        {
            if (!this.completedByIdempotency.TryGetValue(this.semantics.IdempotencyKeyOf(request), out ReplayEntry? entry))
                return null;
            return this.semantics.RequestsMatch(entry.Request, request)
                ? entry.Receipt
                : this.semantics.Failure(request, NewId(), "rejected", this.semantics.ReceiptTupleOf(entry.Receipt).Revision,
                    "idempotency_key_reused_with_different_request", entry.Scope);
        }
    }

    internal TReceipt Remember(TRequest request, TReceipt receipt)
    {
        lock (this.gate)
        {
            if (PortfolioBridgeProtocol.IsOpaqueId(this.semantics.IdempotencyKeyOf(request))
                && !this.completedByIdempotency.ContainsKey(this.semantics.IdempotencyKeyOf(request)))
                this.completedByIdempotency.Add(this.semantics.IdempotencyKeyOf(request),
                    new ReplayEntry(request, receipt, this.semantics.ScopeOfReceipt(receipt)));
            return receipt;
        }
    }

    /// <summary>
    /// Creates the active execution after all dynamic guards have passed.
    /// Returns null with <paramref name="rejectReason"/> when another execution
    /// is active ("execution_already_active") or the correlation id is not an
    /// opaque envelope id ("invalid_envelope").
    /// </summary>
    internal MineExecutionState<TPhase, TReceipt>? StartExecution(
        string action,
        string requestId,
        string traceId,
        string idempotencyKey,
        string correlationId,
        string cancellationToken,
        long deadlineMs,
        long beforeRevision,
        PortfolioScope scope,
        int targetFloor,
        string opaqueTarget,
        int currentFloorBefore,
        int lowestMineLevelBefore,
        out string? rejectReason)
    {
        lock (this.gate)
        {
            rejectReason = null;
            if (this.active is not null)
            {
                rejectReason = "execution_already_active";
                return null;
            }
            if (!PortfolioBridgeProtocol.IsOpaqueId(correlationId))
            {
                rejectReason = "invalid_envelope";
                return null;
            }
            return new MineExecutionState<TPhase, TReceipt>(
                action, requestId, traceId, idempotencyKey, correlationId, cancellationToken, deadlineMs,
                beforeRevision, NewId(), scope, targetFloor, opaqueTarget, currentFloorBefore, lowestMineLevelBefore);
        }
    }

    internal bool CanAdvance(MineExecutionState<TPhase, TReceipt> execution, string phase,
        string requestId, string traceId, string executionId, long revision, PortfolioScope scope)
    {
        lock (this.gate)
        {
            if (!ReferenceEquals(this.active, execution) || execution.RequestId != requestId
                || execution.TraceId != traceId || execution.ExecutionId != executionId
                || !execution.Scope.Equals(scope) || revision <= execution.Revision
                || this.clock() >= execution.DeadlineMs)
                return false;
            int current = Array.IndexOf(this.semantics.Phases, this.semantics.PhaseName(execution.Phases[^1]));
            return Array.IndexOf(this.semantics.Phases, phase) == current + 1;
        }
    }

    internal bool ObserveTransitionStarted(TTransitionObservation observation)
    {
        lock (this.gate)
        {
            if (observation is null || this.active is null || this.active.Cancelled)
                return false;
            (string requestId, string traceId, string executionId, long revision, PortfolioScope scope) =
                this.semantics.TransitionTupleOf(observation);
            if (!this.semantics.IsTransitionObservationShapeValid(observation)
                || !CanAdvance(this.active, "transition_started", requestId, traceId, executionId, revision, scope)
                || !this.semantics.IsTransitionObservationValid(observation, this.active))
                return false;
            MineExecutionState<TPhase, TReceipt> execution = this.active;
            this.semantics.ApplyTransitionObserved(execution);
            execution.Irreversible = true;
            execution.TransitionRevision = revision;
            execution.Phases.Add(this.semantics.Phase(execution, "transition_started", revision, this.semantics.TransitionStartedReason));
            execution.Revision = revision;
            return true;
        }
    }

    internal TReceipt ObservePostcondition(TPostconditionObservation observation)
    {
        lock (this.gate)
        {
            if (observation is null)
                return this.semantics.Failure("invalid", "invalid", NewId(), "uncertain", this.active?.Revision ?? 0,
                    "postcondition_observation_invalid", this.active?.Scope ?? InvalidScope());
            (string requestId, string traceId, string executionId, long revision, PortfolioScope scope) =
                this.semantics.PostconditionTupleOf(observation);
            if (this.active is null)
                return this.semantics.Failure(SafeId(requestId), SafeId(traceId), SafeId(executionId), "uncertain", revision,
                    "postcondition_observation_invalid", SafeScope(scope));
            if (this.active.Cancelled || !this.semantics.IsPostconditionObservationShapeValid(observation)
                || !CanAdvance(this.active, "postcondition", requestId, traceId, executionId, revision, scope)
                || !this.semantics.IsPostconditionObservationValid(observation, this.active))
            {
                // A rejected observation for this execution is uncertainty, not
                // proof of a failed or successful native transition. Unrelated
                // or forged authority tuples must not terminate the active run.
                if (this.semantics.IsMatchingPostconditionTuple(observation, this.active))
                    return TerminateActive("uncertain", "postcondition_observation_invalid");
                return this.semantics.Failure(SafeId(requestId), SafeId(traceId), SafeId(executionId), "uncertain", revision,
                    "postcondition_observation_invalid", SafeScope(scope));
            }

            MineExecutionState<TPhase, TReceipt> execution = this.active;
            this.semantics.ApplyPostcondition(execution, observation);
            execution.PostconditionRevision = revision;
            execution.Phases.Add(this.semantics.Phase(execution, "postcondition", revision, "postcondition_observed"));
            execution.Revision = revision;
            return TerminateActive("succeeded", this.semantics.SuccessReason);
        }
    }

    internal TReceipt Fail(string requestId, string traceId, string executionId, string reasonCode, long revision, PortfolioScope scope)
    {
        lock (this.gate)
        {
            if (this.active is null || this.active.RequestId != requestId || this.active.TraceId != traceId
                || this.active.ExecutionId != executionId || !this.active.Scope.Equals(scope))
                return this.semantics.Failure(requestId, traceId, executionId, "rejected", revision, "execution_not_active", scope);

            MineExecutionState<TPhase, TReceipt> execution = this.active;
            if (this.clock() >= execution.DeadlineMs)
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

    internal TReceipt Cancel(TCancelRequest request)
    {
        lock (this.gate)
        {
            if (request is null)
                return this.semantics.Failure("invalid", "invalid", NewId(), "rejected", this.active?.Revision ?? 0,
                    this.semantics.InvalidCancelReason, this.active?.Scope ?? InvalidScope());
            if (!this.semantics.IsCancelRequestShapeValid(request) || this.active is null
                || this.active.Action != this.semantics.CancelAction(request)
                || this.active.RequestId != this.semantics.CancelRequestId(request)
                || this.active.TraceId != this.semantics.CancelTraceId(request)
                || this.active.ExecutionId != this.semantics.CancelExecutionId(request)
                || !this.active.Scope.Equals(this.semantics.CancelScope(request)))
                return this.semantics.Failure(SafeId(this.semantics.CancelRequestId(request)),
                    SafeId(this.semantics.CancelTraceId(request)), SafeId(this.semantics.CancelExecutionId(request)),
                    "rejected", this.active?.Revision ?? 0, "execution_not_active", this.active?.Scope ?? InvalidScope());
            if (!String.Equals(this.active.CancellationToken, this.semantics.CancelToken(request), StringComparison.Ordinal))
                return this.semantics.Failure(this.active.RequestId, this.active.TraceId, this.active.ExecutionId,
                    "rejected", this.active.Revision, "cancellation_token_mismatch", this.active.Scope);
            if (this.clock() >= this.active.DeadlineMs)
            {
                if (this.active.TransitionArmed)
                {
                    if (this.active.AdapterCallInProgress)
                    {
                        if (this.active.Cancelled)
                        {
                            ReleasePending(this.active);
                            return TerminateActive("uncertain", "native_operation_uncertain", enqueue: false);
                        }
                        this.active.Cancelled = true;
                        ReleasePending(this.active);
                        return TerminateActive("uncertain", "native_operation_uncertain", enqueue: false);
                    }
                    ReleasePending(this.active);
                    return TerminateActive("uncertain", "native_operation_uncertain", enqueue: false);
                }
                return TerminateActive("expired", "deadline_expired", enqueue: false);
            }
            if (this.active.TransitionArmed && !this.active.AdapterCallInProgress)
                return TerminateActive("uncertain", "native_operation_uncertain", enqueue: false);
            if (this.active.TransitionArmed)
            {
                // A reentrant cancel does not acknowledge the native outcome.
                // Preserve active ownership until the adapter invocation returns,
                // but remove its pending event correlation immediately.
                if (this.active.Cancelled)
                {
                    ReleasePending(this.active);
                    return TerminateActive("uncertain", "native_operation_uncertain", enqueue: false);
                }
                this.active.Cancelled = true;
                ReleasePending(this.active);
                return TerminateActive("uncertain", "native_operation_uncertain", enqueue: false);
            }
            if (this.active.Irreversible)
                return this.semantics.Failure(this.active.RequestId, this.active.TraceId, this.active.ExecutionId,
                    "blocked", this.active.Revision, "irreversible_phase_reached", this.active.Scope);

            return TerminateActive("cancelled", "cancelled", enqueue: false);
        }
    }

    internal TReceipt? Invalidate(string reasonCode)
    {
        lock (this.gate)
        {
            if (this.active is null)
                return null;
            return TerminateActive("uncertain", "native_operation_uncertain");
        }
    }

    internal bool TryValidateFreshFloorRequest(TFreshFloorRequest request, long currentRevision, out int targetFloor)
    {
        targetFloor = 0;
        lock (this.gate)
        {
            if (request is null || !this.semantics.IsFreshFloorRequestShapeValid(request)
                || this.clock() >= this.semantics.FreshFloorDeadline(request))
                return false;
            (string requestId, string traceId, string executionId, long expectedRevision, string cancellationToken, PortfolioScope scope) =
                this.semantics.FreshFloorTuple(request);
            // The terminal receipt is immutable evidence. A fresh reader may
            // consume only its exact authority tuple, never an active/replayed
            // execution or a substituted cancellation token/scope.
            ReplayEntry? entry = this.completedByIdempotency.Values.FirstOrDefault(entry =>
            {
                (string receiptRequestId, string receiptTraceId, string receiptExecutionId, string receiptState, long receiptRevision) =
                    this.semantics.ReceiptTupleOf(entry.Receipt);
                return receiptState == "succeeded"
                    && receiptRequestId == requestId
                    && receiptTraceId == traceId
                    && receiptExecutionId == executionId
                    && receiptRevision == expectedRevision
                    && this.semantics.CancellationTokenOf(entry.Request) == cancellationToken
                    && entry.Scope.Equals(scope)
                    && currentRevision > expectedRevision;
            });
            if (this.active is not null || entry is null)
                return false;
            targetFloor = this.semantics.FreshFloorTargetOf(entry.Request, entry.Receipt);
            return true;
        }
    }

    internal bool TryPeekTerminalDelivery(out TDelivery? delivery)
    {
        lock (this.gate)
        {
            if (this.terminalDeliveries.Count == 0)
            {
                delivery = default;
                return false;
            }
            delivery = this.terminalDeliveries.Peek();
            return true;
        }
    }

    internal bool TryArmTerminalDelivery(TDelivery delivery, PortfolioPipeOutboundCompletion completion)
    {
        lock (this.gate)
        {
            if (this.terminalDeliveries.Count == 0 || !ReferenceEquals(this.terminalDeliveries.Peek(), delivery)
                || this.terminalCompletions.ContainsKey(delivery))
                return false;
            if (completion.Generation <= 0)
                return false;
            this.terminalCompletions.Add(delivery, completion);
            return true;
        }
    }

    internal bool IsTerminalDeliveryPending(TDelivery delivery)
    {
        lock (this.gate)
            return this.terminalCompletions.ContainsKey(delivery);
    }

    internal bool TryCompleteTerminalDelivery(TDelivery delivery, long authenticatedGeneration, out bool failed)
    {
        lock (this.gate)
        {
            failed = false;
            if (this.terminalDeliveries.Count == 0 || !ReferenceEquals(this.terminalDeliveries.Peek(), delivery))
                return false;
            if (!this.terminalCompletions.TryGetValue(delivery, out PortfolioPipeOutboundCompletion? completion))
                return false;
            if (!completion.IsCompleted)
                return false;
            this.terminalCompletions.Remove(delivery);
            if (!completion.Succeeded || completion.Generation != authenticatedGeneration)
            {
                failed = true;
                return false;
            }
            this.terminalDeliveries.Dequeue();
            return true;
        }
    }

    internal bool TryAcknowledgeTerminalDelivery(TDelivery delivery)
    {
        lock (this.gate)
        {
            if (this.terminalDeliveries.Count == 0 || !ReferenceEquals(this.terminalDeliveries.Peek(), delivery)
                || this.terminalCompletions.ContainsKey(delivery))
                return false;
            this.terminalDeliveries.Dequeue();
            return true;
        }
    }

    private TReceipt TerminateActive(string state, string reasonCode, bool enqueue = true)
    {
        MineExecutionState<TPhase, TReceipt> execution = this.active!;
        execution.Phases.Add(this.semantics.Phase(execution, "terminal", execution.Revision, reasonCode));
        TReceipt receipt = this.semantics.Finish(execution, state, reasonCode);
        if (!String.Equals(this.semantics.PhaseReasonCode(execution.Phases[^1]), this.semantics.ReasonCodeOf(receipt), StringComparison.Ordinal))
        {
            execution.Phases[^1] = this.semantics.Phase(execution, "terminal", execution.Revision, this.semantics.ReasonCodeOf(receipt));
            receipt = this.semantics.Finish(execution, state, this.semantics.ReasonCodeOf(receipt));
        }
        execution.TerminalReceipt = receipt;
        ReleasePending(execution);
            Remember(this.semantics.ToRequest(execution), receipt);
        this.active = null;
        if (enqueue && !execution.BeginInProgress && PortfolioBridgeProtocol.IsOpaqueId(execution.CorrelationId))
            this.terminalDeliveries.Enqueue(this.semantics.Delivery(execution.CorrelationId, execution.Scope, receipt));
        return receipt;
    }

    private void ReleasePending(MineExecutionState<TPhase, TReceipt> execution)
    {
        if (execution.PendingReleased)
            return;
        execution.PendingReleased = true;
        this.semantics.ReleasePending(execution.ExecutionId);
    }

    internal static string NormalizeCallbackReason(string? value) => value switch
    {
        "cancelled" => "cancelled",
        "native_operation_failed" => "native_operation_failed",
        "deadline_expired" => "deadline_expired",
        "portfolio_bridge_disconnected" => "portfolio_bridge_disconnected",
        _ => "native_operation_uncertain"
    };

    internal static long DefaultUtcNowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    internal static string NewId() => Guid.NewGuid().ToString("N");
    internal static string SafeId(string? value) => PortfolioBridgeProtocol.IsOpaqueId(value) ? value! : "invalid";
    internal static PortfolioScope SafeScope(PortfolioScope? scope) => scope is not null && scope.IsValid ? scope : InvalidScope();
    internal static PortfolioScope InvalidScope() => new(PortfolioBridgeProtocol.IntegrationId, PortfolioBridgeProtocol.Topology,
        "invalid", "invalid", "invalid", "invalid", 0, new string('0', 64));

    private sealed record ReplayEntry(TRequest Request, TReceipt Receipt, PortfolioScope Scope);
}
