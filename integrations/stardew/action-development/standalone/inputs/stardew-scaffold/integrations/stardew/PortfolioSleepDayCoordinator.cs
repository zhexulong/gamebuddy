namespace GameBuddy.Stardew;

/// <summary>Game-thread-owned state machine for the bounded native sleep/day lifecycle.</summary>
internal sealed class PortfolioSleepDayCoordinator
{
    private readonly object gate = new();
    private readonly Dictionary<string, ReplayEntry> completedByIdempotency = new(StringComparer.Ordinal);
    private SleepDayExecution? active;

    internal PortfolioSleepDayCoordinator()
    {
    }

    internal bool HasActiveExecution
    {
        get { lock (this.gate) return this.active is not null; }
    }

    // Compatibility shim for the not-yet-adapted session caller. It is deliberately
    // fail-closed: no valid scope can be inferred from a request.
    internal PortfolioSleepDayReceipt Begin(PortfolioSleepDayRequest request, long currentRevision)
        => Failure(request, NewExecutionId(), "blocked", currentRevision, "portfolio_binding_invalid", InvalidScope());

    internal PortfolioSleepDayReceipt Begin(PortfolioSleepDayRequest request, long currentRevision, PortfolioScope immutableScope)
    {
        lock (this.gate)
        {
            PortfolioSleepDayReceipt? replay = this.TryReplay(request, immutableScope);
            if (replay is not null)
                return replay;

            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (!immutableScope.IsValid)
                return Failure(request, NewExecutionId(), "blocked", currentRevision, "portfolio_binding_invalid", immutableScope);
            if (request.ExpectedRevision != currentRevision)
                return Failure(request, NewExecutionId(), "rejected", currentRevision, "revision_mismatch", immutableScope);
            if (request.DeadlineMs <= now)
                return Failure(request, NewExecutionId(), "expired", currentRevision, "deadline_expired", immutableScope);
            if (this.active is not null)
                return Failure(request, NewExecutionId(), "blocked", currentRevision, "execution_already_active", immutableScope);

            // Target 1.6.15.24356 has no public typed non-UI ingress that
            // preserves the bed confirmation decision: normal sleep reaches
            // private UI continuations before Game1.NewDay.  Do not arm a
            // synthetic lifecycle from this static coordinator.
            PortfolioSleepDayReceipt blocked = Failure(request, NewExecutionId(), "blocked", currentRevision, "adapter_unavailable", immutableScope);
            this.completedByIdempotency[request.IdempotencyKey] = new ReplayEntry(request, blocked, immutableScope);
            return blocked;
        }
    }

    internal PortfolioSleepDayReceipt Cancel(PortfolioSleepDayCancelRequest request)
    {
        lock (this.gate)
        {
            if (request.Action != PortfolioBridgeProtocol.SleepDayAction)
                return Failure(request.RequestId, request.TraceId, request.ExecutionId, "rejected", this.active?.Revision ?? 0, "invalid_request", this.active?.Scope ?? InvalidScope());
            if (this.active is null || this.active.RequestId != request.RequestId || this.active.TraceId != request.TraceId || this.active.ExecutionId != request.ExecutionId)
                return Failure(request.RequestId, request.TraceId, request.ExecutionId, "rejected", this.active?.Revision ?? 0, "execution_not_active", this.active?.Scope ?? InvalidScope());
            if (!String.Equals(this.active.CancellationToken, request.CancellationToken, StringComparison.Ordinal))
                return Failure(this.active.RequestId, this.active.TraceId, this.active.ExecutionId, "rejected", this.active.Revision, "cancellation_token_mismatch", this.active.Scope);
            if (this.active.Irreversible)
                return Failure(this.active.RequestId, this.active.TraceId, this.active.ExecutionId, "blocked", this.active.Revision, "irreversible_phase_reached", this.active.Scope);
            PortfolioSleepDayReceipt receipt = this.TerminateActive("cancelled", "cancelled");
            this.completedByIdempotency[this.active.IdempotencyKey] = new ReplayEntry(this.active.ToRequest(), receipt, this.active.Scope);
            this.active = null;
            return receipt;
        }
    }

    internal bool ObserveNativeSleepStarted(PortfolioSleepDayNativeSleepStartedObservation observation)
        => Advance(observation.RequestId, observation.TraceId, observation.ExecutionId, "native_sleep_started", observation.Revision, "native_sleep_started", observation.Scope, observation.NativeSleepObserved, ObservationFact.NativeSleep, irreversible: true);

    internal bool ObserveSaving(PortfolioSleepDaySavingObservation observation)
        => Advance(observation.RequestId, observation.TraceId, observation.ExecutionId, "saving", observation.Revision, "saving", observation.Scope, observation.SavingObserved, ObservationFact.Saving, irreversible: true);

    internal bool ObserveSaved(PortfolioSleepDaySavedObservation observation)
        => Advance(observation.RequestId, observation.TraceId, observation.ExecutionId, "saved", observation.Revision, "saved", observation.Scope, observation.SavedObserved, ObservationFact.Saved, irreversible: true);

    internal bool ObserveDayStarted(PortfolioSleepDayDayStartedObservation observation)
    {
        lock (this.gate)
        {
            if (!CanAdvance("day_started", observation.RequestId, observation.TraceId, observation.ExecutionId, observation.Revision, observation.Scope)
                || !observation.DayStartedObserved || !IsFreshDayIdentity(observation.NewDayIdentity))
                return false;
            SleepDayExecution execution = this.active!;
            execution.DayStartedObserved = true;
            execution.NewDayIdentity = observation.NewDayIdentity;
            execution.Phases.Add(Phase(execution, "day_started", observation.Revision, "day_started"));
            execution.Revision = observation.Revision;
            execution.Irreversible = true;
            return true;
        }
    }

    internal bool ObserveCloseRequested(PortfolioSleepDayCloseRequestedObservation observation)
        => Advance(observation.RequestId, observation.TraceId, observation.ExecutionId, "close_requested", observation.Revision, "close_requested", observation.Scope, observation.CloseObserved, ObservationFact.Close, irreversible: true);

    internal PortfolioSleepDayReceipt ObserveReopened(PortfolioSleepDayReopenedObservation observation)
    {
        lock (this.gate)
        {
            if (!CanAdvance("reopened", observation.RequestId, observation.TraceId, observation.ExecutionId, observation.Revision, observation.RefreshedScope)
                || !observation.ReopenObserved
                || !IsFreshDayIdentity(observation.NewDayIdentity)
                || this.active!.NewDayIdentity is null
                || !String.Equals(this.active.NewDayIdentity, observation.NewDayIdentity, StringComparison.Ordinal)
                || !observation.RefreshedScope.Equals(this.active.Scope))
                return Failure(observation.RequestId, observation.TraceId, observation.ExecutionId, "uncertain", observation.Revision, "reopen_observation_invalid", this.active?.Scope ?? observation.RefreshedScope);
            SleepDayExecution execution = this.active!;
            execution.Phases.Add(Phase(execution, "reopened", observation.Revision, "reopened"));
            execution.Revision = observation.Revision;
            execution.ReopenedObserved = true;
            PortfolioSleepDayReceipt receipt = Finish(execution, "succeeded", "single_player_sleep_and_advance_day_completed");
            this.completedByIdempotency[execution.IdempotencyKey] = new ReplayEntry(execution.ToRequest(), receipt, execution.Scope);
            this.active = null;
            return receipt;
        }
    }

    internal PortfolioSleepDayReceipt Fail(string requestId, string traceId, string executionId, string reasonCode, long revision, PortfolioScope refreshedScope)
    {
        lock (this.gate)
        {
            reasonCode = PortfolioBridgeProtocol.IsReasonCode(reasonCode) ? reasonCode : "native_operation_failed";
            if (this.active is null || this.active.RequestId != requestId || this.active.TraceId != traceId || this.active.ExecutionId != executionId || !this.active.Scope.Equals(refreshedScope))
                return Failure(requestId, traceId, executionId, "uncertain", revision, "execution_not_active", refreshedScope);
            PortfolioSleepDayReceipt receipt = this.TerminateActive("failed", reasonCode);
            this.completedByIdempotency[this.active.IdempotencyKey] = new ReplayEntry(this.active.ToRequest(), receipt, this.active.Scope);
            this.active = null;
            return receipt;
        }
    }

    private bool Advance(string requestId, string traceId, string executionId, string phase, long revision, string reasonCode, PortfolioScope scope, bool fact, ObservationFact factKind, bool irreversible)
    {
        lock (this.gate)
        {
            if (!fact || !CanAdvance(phase, requestId, traceId, executionId, revision, scope)) return false;
            SleepDayExecution execution = this.active!;
            execution.Phases.Add(Phase(execution, phase, revision, reasonCode));
            switch (factKind)
            {
                case ObservationFact.NativeSleep: execution.NativeSleepObserved = true; break;
                case ObservationFact.Saving: execution.SavingObserved = true; break;
                case ObservationFact.Saved: execution.SavedObserved = true; break;
                case ObservationFact.Close: execution.CloseObserved = true; break;
            }
            execution.Revision = revision;
            execution.Irreversible |= irreversible;
            return true;
        }
    }

    private bool CanAdvance(string phase, string requestId, string traceId, string executionId, long revision, PortfolioScope scope)
    {
        if (this.active is null || this.active.RequestId != requestId || this.active.TraceId != traceId || this.active.ExecutionId != executionId || !this.active.Scope.Equals(scope)) return false;
        int current = Array.IndexOf(PortfolioBridgeProtocol.SleepDayPhases, this.active.Phases[^1].Phase);
        int next = Array.IndexOf(PortfolioBridgeProtocol.SleepDayPhases, phase);
        return next == current + 1 && revision >= this.active.Revision && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() <= this.active.DeadlineMs;
    }

    private PortfolioSleepDayReceipt? TryReplay(PortfolioSleepDayRequest request, PortfolioScope immutableScope)
    {
        if (!this.completedByIdempotency.TryGetValue(request.IdempotencyKey, out ReplayEntry? entry)) return null;
        return entry.Matches(request, immutableScope) ? entry.Receipt : Failure(request, entry.Receipt.ExecutionId, "rejected", entry.Receipt.Revision, "idempotency_key_reused_with_different_request", immutableScope);
    }

    private PortfolioSleepDayReceipt TerminateActive(string state, string reasonCode)
    {
        SleepDayExecution execution = this.active!;
        execution.Phases.Add(Phase(execution, "terminal", execution.Revision, reasonCode));
        return Finish(execution, state, reasonCode);
    }

    private static PortfolioSleepDayReceipt Finish(SleepDayExecution execution, string state, string reasonCode)
    {
        bool nativeSleep = execution.NativeSleepObserved;
        bool saving = execution.SavingObserved;
        bool saved = execution.SavedObserved;
        bool dayStarted = execution.DayStartedObserved;
        bool closed = execution.CloseObserved;
        bool reopened = execution.ReopenedObserved;
        string day = execution.NewDayIdentity ?? "none";
        bool validSuccess = state == "succeeded" && nativeSleep && saving && saved && dayStarted && closed && reopened && IsFreshDayIdentity(day) && execution.Revision > execution.BeforeRevision;
        if (state == "succeeded" && !validSuccess)
        {
            state = "uncertain";
            reasonCode = "reopen_observation_invalid";
        }
        return new PortfolioSleepDayReceipt(execution.RequestId, execution.TraceId, execution.ExecutionId, state, execution.Revision, reasonCode,
            new PortfolioSleepDayEvidence(PortfolioSleepDayEvidenceIdentity.FromScope(execution.Scope), execution.Phases.ToArray(), nativeSleep ? "native_sleep_started" : "none", nativeSleep, saving, saved, dayStarted, day, closed, reopened),
            new PortfolioSleepDayPostcondition(execution.BeforeRevision, execution.Revision, state == "succeeded", dayStarted, reopened, day));
    }

    private static PortfolioSleepDayReceipt Pending(SleepDayExecution execution, string reasonCode)
    {
        PortfolioSleepDayPhase[] phases = execution.Phases.Append(Phase(execution, "terminal", execution.Revision, reasonCode)).ToArray();
        return new PortfolioSleepDayReceipt(execution.RequestId, execution.TraceId, execution.ExecutionId, "uncertain", execution.Revision, reasonCode,
            new PortfolioSleepDayEvidence(PortfolioSleepDayEvidenceIdentity.FromScope(execution.Scope), phases, "none", false, false, false, false, "none", false, false),
            new PortfolioSleepDayPostcondition(execution.BeforeRevision, execution.Revision, false, false, false, "none"));
    }

    private static PortfolioSleepDayReceipt Failure(PortfolioSleepDayRequest request, string executionId, string state, long revision, string reasonCode, PortfolioScope scope)
        => Failure(request.RequestId, request.TraceId, executionId, state, revision, reasonCode, scope);

    private static PortfolioSleepDayReceipt Failure(string requestId, string traceId, string executionId, string state, long revision, string reasonCode, PortfolioScope scope)
    {
        PortfolioSleepDayPhase[] phases = { new(requestId, traceId, executionId, "fresh_observed", revision, "fresh_observed"), new(requestId, traceId, executionId, "terminal", revision, reasonCode) };
        return new PortfolioSleepDayReceipt(requestId, traceId, executionId, state, revision, reasonCode,
            new PortfolioSleepDayEvidence(PortfolioSleepDayEvidenceIdentity.FromScope(scope), phases, "none", false, false, false, false, "none", false, false),
            new PortfolioSleepDayPostcondition(revision, revision, false, false, false, "none"));
    }

    private static PortfolioSleepDayPhase Phase(SleepDayExecution execution, string phase, long revision, string reasonCode)
        => new(execution.RequestId, execution.TraceId, execution.ExecutionId, phase, revision, reasonCode);

    private enum ObservationFact { NativeSleep, Saving, Saved, Close }

    private static bool IsFreshDayIdentity(string value) =>
        PortfolioBridgeProtocol.IsOpaqueId(value) && !String.Equals(value, "none", StringComparison.Ordinal);

    private static string NewExecutionId() => Guid.NewGuid().ToString("N");
    private static PortfolioScope InvalidScope() => new(PortfolioBridgeProtocol.IntegrationId, PortfolioBridgeProtocol.Topology, "invalid", "invalid", "invalid", "invalid", 0, new string('0', 64));

    private sealed class SleepDayExecution
    {
        internal SleepDayExecution(PortfolioSleepDayRequest request, long revision, string executionId, PortfolioScope scope)
        {
            RequestId = request.RequestId; TraceId = request.TraceId; IdempotencyKey = request.IdempotencyKey; CancellationToken = request.CancellationToken;
            DeadlineMs = request.DeadlineMs; BeforeRevision = revision; Revision = revision; ExecutionId = executionId; Scope = scope;
            Phases.Add(new PortfolioSleepDayPhase(request.RequestId, request.TraceId, executionId, "fresh_observed", revision, "fresh_observed"));
        }
        internal string RequestId { get; }
        internal string TraceId { get; }
        internal string IdempotencyKey { get; }
        internal string CancellationToken { get; }
        internal long DeadlineMs { get; }
        internal long BeforeRevision { get; }
        internal long Revision { get; set; }
        internal string ExecutionId { get; }
        internal PortfolioScope Scope { get; }
        internal bool Irreversible { get; set; }
        internal bool NativeSleepObserved { get; set; }
        internal bool SavingObserved { get; set; }
        internal bool SavedObserved { get; set; }
        internal bool DayStartedObserved { get; set; }
        internal bool CloseObserved { get; set; }
        internal bool ReopenedObserved { get; set; }
        internal string? NewDayIdentity { get; set; }
        internal List<PortfolioSleepDayPhase> Phases { get; } = new();
        internal PortfolioSleepDayRequest ToRequest() => new(PortfolioBridgeProtocol.SleepDayAction, RequestId, TraceId, IdempotencyKey, BeforeRevision, DeadlineMs, CancellationToken);
    }

    private sealed record ReplayEntry(PortfolioSleepDayRequest Request, PortfolioSleepDayReceipt Receipt, PortfolioScope Scope)
    {
        internal bool Matches(PortfolioSleepDayRequest request, PortfolioScope immutableScope) =>
            Scope.Equals(immutableScope) &&
            Request.Action == request.Action && Request.RequestId == request.RequestId &&
            Request.TraceId == request.TraceId && Request.IdempotencyKey == request.IdempotencyKey &&
            Request.ExpectedRevision == request.ExpectedRevision && Request.DeadlineMs == request.DeadlineMs &&
            Request.CancellationToken == request.CancellationToken;
    }
}
