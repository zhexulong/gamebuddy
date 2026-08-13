namespace GameBuddy.Stardew;

/// <summary>
/// Game-thread-owned coordinator for the bounded M9 offer/complete/claim seam.
/// Objective work is intentionally absent: completion is accepted only as a
/// fresh observation from separately selected typed objective actions.
/// </summary>
internal sealed class PortfolioSpecialOrderActionCoordinator
{
    private readonly object gate = new();
    private readonly IPortfolioSpecialOrderSemanticAdapter? adapter;
    private readonly Dictionary<string, ReplayEntry> completedByIdempotency = new(StringComparer.Ordinal);
    private readonly Dictionary<OrderIdentity, OrderState> orders = new();
    private ActiveExecution? active;

    internal PortfolioSpecialOrderActionCoordinator(IPortfolioSpecialOrderSemanticAdapter? adapter = null) => this.adapter = adapter;

    internal PortfolioSpecialOrderReceipt BeginAccept(
        PortfolioSpecialOrderAcceptRequest request,
        PortfolioSpecialOrderRuntimeState runtime,
        PortfolioSpecialOrderDsmSelection selection,
        PortfolioSpecialOrderFreshOfferObservation freshOffer)
    {
        lock (this.gate)
        {
            if (request is null || selection is null || !request.IsValid || !selection.IsValid)
                return Failure(request?.Action ?? "invalid", request?.RequestId ?? "invalid", request?.TraceId ?? "invalid", NewExecutionId(), runtime?.Revision ?? 0, "portfolio_binding_invalid", SafeScope(runtime?.Scope), SafeSelection(selection));
            PortfolioSpecialOrderDsmSelection fingerprintSelection =
                new(request.OfferTarget, selection.OrderKey, request.Generation, selection.Reward);
            // Replay is checked after request/selection shape validation but before
            // runtime, revision, deadline, and fresh-observation guards. A terminal
            // mutation can legitimately make those dynamic facts stale.
            PortfolioSpecialOrderReceipt? replay = TryReplay(request.Action, request.RequestId, request.TraceId, request.IdempotencyKey,
                request.ExpectedRevision, request.DeadlineMs, request.CancellationToken, request.Scope, fingerprintSelection);
            if (replay is not null)
                return replay;
            if (runtime is null || freshOffer is null)
                return Remember(request.IdempotencyKey, request, selection, Failure(request.Action, request.RequestId, request.TraceId, NewExecutionId(), runtime?.Revision ?? 0, "portfolio_binding_invalid", SafeScope(runtime?.Scope), selection), SafeScope(runtime?.Scope));
            PortfolioSpecialOrderReceipt? guardFailure = ValidateCommon(request.Action, request.RequestId, request.TraceId,
                request.IdempotencyKey, request.ExpectedRevision, request.DeadlineMs, request.CancellationToken, runtime, selection, request.Scope,
                runtime.Revision, selection.OfferTarget, selection.OrderKey, selection.Generation, selection.Reward);
            if (guardFailure is not null)
                return Remember(request.IdempotencyKey, request, selection, guardFailure, runtime.Scope);
            if (!IsMatchingFreshOffer(request, runtime, selection, freshOffer))
                return Remember(request.IdempotencyKey, request, selection, Failure(request.Action, request.RequestId, request.TraceId, NewExecutionId(), runtime.Revision, "portfolio_scope_mismatch", runtime.Scope, selection), runtime.Scope);
            if (orders.ContainsKey(new OrderIdentity(selection.OrderKey, selection.Generation)))
                return Remember(request.IdempotencyKey, request, selection, Failure(request.Action, request.RequestId, request.TraceId, NewExecutionId(), runtime.Revision, "order_already_accepted", runtime.Scope, selection), runtime.Scope);
            if (active is not null)
            {
                // The active execution owns its key until terminalization;
                // never store a competing rejection under another active key.
                if (String.Equals(active.IdempotencyKey, request.IdempotencyKey, StringComparison.Ordinal))
                    return Failure(request.Action, request.RequestId, request.TraceId, NewExecutionId(), runtime.Revision, "idempotency_key_active", runtime.Scope, selection);
                return Remember(request.IdempotencyKey, request, selection, Failure(request.Action, request.RequestId, request.TraceId, NewExecutionId(), runtime.Revision, "execution_already_active", runtime.Scope, selection), runtime.Scope);
            }
            if (adapter is null || !adapter.IsAvailable)
                return Remember(request.IdempotencyKey, request, selection, Failure(request.Action, request.RequestId, request.TraceId, NewExecutionId(), runtime.Revision, "adapter_unavailable", runtime.Scope, selection), runtime.Scope);

            string executionId = NewExecutionId();
            ActiveExecution execution = new(request.Action, request.RequestId, request.TraceId, request.IdempotencyKey, request.CancellationToken,
                request.DeadlineMs, request.ExpectedRevision, runtime.Scope, selection, executionId);
            execution.Phases.Add(Phase(execution, "fresh_observed", runtime.Revision, "fresh_observed"));
            execution.Phases.Add(Phase(execution, "accepted", runtime.Revision, "accepted"));
            active = execution;
            PortfolioSpecialOrderAcceptanceObservation observation;
            bool invoked;
            // From this point the semantic adapter may have crossed native
            // state; cancellation/timeout cannot manufacture a determinate
            // terminal result without a native no-effect acknowledgement.
            execution.NativeOperationArmed = true;
            try { invoked = adapter.TryAcceptOffer(new PortfolioSpecialOrderAcceptContext(request, runtime.Scope, selection, freshOffer, executionId), out observation); }
            catch { invoked = false; observation = InvalidAcceptanceObservation(request, runtime.Scope, selection, executionId); }
            if (!invoked || execution.Cancelled || !IsMatchingAcceptance(execution, observation)
                || !IsRuntimeStillValid(execution, runtime, observation.Revision))
                return CompleteAdapterFailure(execution);

            execution.Revision = observation.Revision;
            execution.OfferAccepted = true;
            execution.OrderKey = observation.OrderKey;
            execution.Phases.Add(Phase(execution, "offer_committed", observation.Revision, "offer_committed"));
            // The accept execution is terminal after this receipt, but its
            // identity remains the correlation anchor for the later monitor.
            orders[new OrderIdentity(observation.OrderKey, observation.Generation)] = new OrderState(
                observation.OrderKey, observation.Generation, selection.OfferTarget, selection.Reward, runtime.Scope, observation.ExecutionId,
                observation.RequestId, observation.TraceId, observation.Revision, request.DeadlineMs, OrderLifecycle.AcceptedInProgress);
            PortfolioSpecialOrderReceipt receipt = Finish(execution, "succeeded", "special_order_offer_accepted");
            active = null;
            StoreReplay(request.IdempotencyKey, new ReplayEntry(
                new RequestFingerprint(request.Action, request.RequestId, request.TraceId, request.IdempotencyKey, request.ExpectedRevision, request.DeadlineMs, request.CancellationToken, request.Scope,
                    new PortfolioSpecialOrderDsmSelection(request.OfferTarget, selection.OrderKey, request.Generation, selection.Reward)), receipt, runtime.Scope));
            return receipt;
        }
    }

    internal PortfolioSpecialOrderReceipt BeginClaim(
        PortfolioSpecialOrderClaimRequest request,
        PortfolioSpecialOrderRuntimeState runtime,
        PortfolioSpecialOrderDsmSelection selection,
        PortfolioSpecialOrderFreshRewardObservation freshReward)
    {
        lock (this.gate)
        {
            if (request is null || selection is null || !request.IsValid || !selection.IsValid)
                return Failure(request?.Action ?? "invalid", request?.RequestId ?? "invalid", request?.TraceId ?? "invalid", NewExecutionId(), runtime?.Revision ?? 0, "portfolio_binding_invalid", SafeScope(runtime?.Scope), SafeSelection(selection));
            PortfolioSpecialOrderDsmSelection fingerprintSelection =
                new("none", request.OrderKey, request.Generation, request.Reward);
            // Replay is checked after request/selection shape validation but before
            // runtime, revision, deadline, and fresh-observation guards. A terminal
            // mutation can legitimately make those dynamic facts stale.
            PortfolioSpecialOrderReceipt? replay = TryReplay(request.Action, request.RequestId, request.TraceId, request.IdempotencyKey,
                request.ExpectedRevision, request.DeadlineMs, request.CancellationToken, request.Scope, fingerprintSelection);
            if (replay is not null)
                return replay;
            if (runtime is null || freshReward is null)
                return Remember(request.IdempotencyKey, request, Failure(request.Action, request.RequestId, request.TraceId, NewExecutionId(), runtime?.Revision ?? 0, "portfolio_binding_invalid", SafeScope(runtime?.Scope), selection), SafeScope(runtime?.Scope));
            PortfolioSpecialOrderReceipt? guardFailure = ValidateCommon(request.Action, request.RequestId, request.TraceId,
                request.IdempotencyKey, request.ExpectedRevision, request.DeadlineMs, request.CancellationToken, runtime, selection, request.Scope,
                runtime.Revision, selection.OfferTarget, selection.OrderKey, selection.Generation, selection.Reward);
            if (guardFailure is not null)
                return Remember(request.IdempotencyKey, request, guardFailure, runtime.Scope);
            if (!IsMatchingFreshReward(request, runtime, selection, freshReward))
                return Remember(request.IdempotencyKey, request, Failure(request.Action, request.RequestId, request.TraceId, NewExecutionId(), runtime.Revision, "portfolio_scope_mismatch", runtime.Scope, selection), runtime.Scope);
            OrderIdentity identity = new(request.OrderKey, request.Generation);
            if (request.OrderKey != selection.OrderKey || request.Generation != selection.Generation || request.Reward != selection.Reward
                || freshReward.Revision != runtime.Revision || !freshReward.NativeOrderComplete || !freshReward.ParticipantRewardUnclaimed)
                return Remember(request.IdempotencyKey, request, Failure(request.Action, request.RequestId, request.TraceId, NewExecutionId(), runtime.Revision, "portfolio_scope_mismatch", runtime.Scope, selection), runtime.Scope);
            if (!orders.TryGetValue(identity, out OrderState? order) || !order.Scope.Equals(runtime.Scope))
                return Remember(request.IdempotencyKey, request, Failure(request.Action, request.RequestId, request.TraceId, NewExecutionId(), runtime.Revision, "unselected_domain_no_claim", runtime.Scope, selection), runtime.Scope);
            // The monitor/claim lifecycle is bounded by the immutable accept
            // deadline. A later claim request cannot reopen that authority
            // window by presenting a longer deadline of its own.
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= order.AcceptDeadlineMs
                || request.DeadlineMs > order.AcceptDeadlineMs)
                return Remember(request.IdempotencyKey, request, Failure(request.Action, request.RequestId, request.TraceId, NewExecutionId(), runtime.Revision,
                    "claim_deadline_exceeds_acceptance_window", runtime.Scope, selection), runtime.Scope);
            if (order.Lifecycle != OrderLifecycle.CompletedRewardUnclaimed
                || freshReward.Revision < order.CompletionRevision
                || !String.Equals(order.OfferTarget, selection.OfferTarget, StringComparison.Ordinal)
                || !String.Equals(order.Reward, request.Reward, StringComparison.Ordinal)
                || !String.Equals(order.Reward, selection.Reward, StringComparison.Ordinal)
                || !freshReward.NativeOrderComplete || !freshReward.ParticipantRewardUnclaimed)
                return Remember(request.IdempotencyKey, request, Failure(request.Action, request.RequestId, request.TraceId, NewExecutionId(), runtime.Revision, "reward_not_available", runtime.Scope, selection), runtime.Scope);
            if (active is not null)
            {
                // Never persist a rejection for a key currently owned by the
                // active execution; doing so would overwrite its terminal replay.
                if (String.Equals(active.IdempotencyKey, request.IdempotencyKey, StringComparison.Ordinal))
                    return Failure(request.Action, request.RequestId, request.TraceId, NewExecutionId(), runtime.Revision, "idempotency_key_active", runtime.Scope, selection);
                return Failure(request.Action, request.RequestId, request.TraceId, NewExecutionId(), runtime.Revision, "execution_already_active", runtime.Scope, selection);
            }
            if (adapter is null || !adapter.IsAvailable)
                return Remember(request.IdempotencyKey, request, Failure(request.Action, request.RequestId, request.TraceId, NewExecutionId(), runtime.Revision, "adapter_unavailable", runtime.Scope, selection), runtime.Scope);

            string executionId = NewExecutionId();
            ActiveExecution execution = new(request.Action, request.RequestId, request.TraceId, request.IdempotencyKey, request.CancellationToken,
                request.DeadlineMs, request.ExpectedRevision, runtime.Scope, selection, executionId);
            execution.Phases.Add(Phase(execution, "fresh_observed", runtime.Revision, "fresh_observed"));
            execution.Phases.Add(Phase(execution, "accepted", runtime.Revision, "accepted"));
            execution.ObjectiveCompletionObserved = true;
            execution.RewardEntitlementObserved = true;
            active = execution;
            PortfolioSpecialOrderRewardClaimObservation observation;
            bool invoked;
            execution.NativeOperationArmed = true;
            try { invoked = adapter.TryClaimReward(new PortfolioSpecialOrderClaimContext(request, runtime.Scope, selection, freshReward, executionId), out observation); }
            catch { invoked = false; observation = InvalidClaimObservation(request, runtime.Scope, selection, executionId); }
            if (!invoked || execution.Cancelled || !IsMatchingClaim(execution, observation)
                || !IsRuntimeStillValid(execution, runtime, observation.Revision))
                return CompleteAdapterFailure(execution);

            execution.Revision = observation.Revision;
            execution.RewardConsumed = true;
            execution.RewardGranted = true;
            execution.OrderKey = observation.OrderKey;
            execution.Phases.Add(Phase(execution, "completion_observed", observation.Revision, "completion_observed"));
            execution.Phases.Add(Phase(execution, "reward_committed", observation.Revision, "reward_committed"));
            orders[identity] = order with { Lifecycle = OrderLifecycle.CompletedRewardClaimed };
            PortfolioSpecialOrderReceipt receipt = Finish(execution, "succeeded", "special_order_reward_claimed");
            active = null;
            StoreReplay(request.IdempotencyKey, new ReplayEntry(
                new RequestFingerprint(request.Action, request.RequestId, request.TraceId, request.IdempotencyKey, request.ExpectedRevision, request.DeadlineMs, request.CancellationToken, request.Scope, selection),
                receipt, runtime.Scope));
            return receipt;
        }
    }

    internal bool ObserveCompletion(PortfolioSpecialOrderCompletionObservation observation)
    {
        lock (this.gate)
        {
            if (observation is null)
                return false;
            // Completion is deliberately a separate, fresh monitor state. The
            // accept execution has already terminalized and must not be active.
            // Its durable identity/revision are retained in OrderState solely
            // for exact correlation and monotonicity checks.
            if (!observation.IsValid
                || !orders.TryGetValue(new OrderIdentity(observation.OrderKey, observation.Generation), out OrderState? order)
                // A completion monitor advances the accepted action-owned order.
                // It therefore remains bounded by the immutable acceptance
                // deadline, not by a caller-provided replacement deadline.
                || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= order.AcceptDeadlineMs
                || observation.DeadlineMs != order.AcceptDeadlineMs
                || !order.Scope.Equals(observation.Scope)
                || order.Lifecycle != OrderLifecycle.AcceptedInProgress
                || !String.Equals(order.OrderKey, observation.OrderKey, StringComparison.Ordinal)
                || !String.Equals(order.Generation, observation.Generation, StringComparison.Ordinal)
                || !String.Equals(order.AcceptedExecutionId, observation.ExecutionId, StringComparison.Ordinal)
                || !String.Equals(order.AcceptRequestId, observation.RequestId, StringComparison.Ordinal)
                || !String.Equals(order.AcceptTraceId, observation.TraceId, StringComparison.Ordinal)
                || !PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(order.OfferTarget)
                || !PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(order.Reward)
                || observation.Revision <= order.AcceptedRevision)
                return false;
            orders[new OrderIdentity(observation.OrderKey, observation.Generation)] = order with
            {
                Lifecycle = OrderLifecycle.CompletedRewardUnclaimed,
                CompletionRevision = observation.Revision
            };
            return true;
        }
    }

    internal PortfolioSpecialOrderReceipt Cancel(PortfolioSpecialOrderCancelRequest request)
    {
        lock (this.gate)
        {
            if (request is null || !request.IsValid || active is null || active.RequestId != request.RequestId || active.TraceId != request.TraceId
                || active.ExecutionId != request.ExecutionId || active.Action != request.Action || !active.Scope.Equals(request.Scope))
                return Failure(request?.Action ?? "invalid", request?.RequestId ?? "invalid", request?.TraceId ?? "invalid", request?.ExecutionId ?? NewExecutionId(), active?.Revision ?? 0, "execution_not_active", active?.Scope ?? InvalidScope(), active?.Selection ?? EmptySelection());
            if (!String.Equals(active.CancellationToken, request.CancellationToken, StringComparison.Ordinal))
                return Failure(active.Action, active.RequestId, active.TraceId, active.ExecutionId, active.Revision, "cancellation_token_mismatch", active.Scope, active.Selection);
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= active.DeadlineMs)
            {
                if (active.NativeOperationArmed)
                {
                    if (active.Cancelled)
                        return Failure(active.Action, active.RequestId, active.TraceId, active.ExecutionId, active.Revision,
                            "cancellation_already_requested", active.Scope, active.Selection);
                    active.Cancelled = true;
                    return Failure(active.Action, active.RequestId, active.TraceId, active.ExecutionId, active.Revision,
                        "native_operation_uncertain", active.Scope, active.Selection);
                }
                return CompleteFailure(active, "deadline_expired");
            }
            if (!PortfolioSpecialOrderActionProtocol.IsValidAction(request.Action)
                || !PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(request.TraceId)
                || !request.Scope.IsValid)
                return Failure(active.Action, active.RequestId, active.TraceId, active.ExecutionId, active.Revision, "execution_not_active", active.Scope, active.Selection);
            if (active.NativeOperationArmed)
            {
                // Retain the active execution until the invoking adapter frame
                // returns; a cancellation request alone is not a native ack.
                if (active.Cancelled)
                    return Failure(active.Action, active.RequestId, active.TraceId, active.ExecutionId, active.Revision,
                        "cancellation_already_requested", active.Scope, active.Selection);
                active.Cancelled = true;
                return Failure(active.Action, active.RequestId, active.TraceId, active.ExecutionId, active.Revision,
                    "native_operation_uncertain", active.Scope, active.Selection);
            }
            if (active.Irreversible)
                return Failure(active.Action, active.RequestId, active.TraceId, active.ExecutionId, active.Revision, "irreversible_phase_reached", active.Scope, active.Selection);
            return CompleteFailure(active, "cancelled");
        }
    }

    internal PortfolioSpecialOrderReceipt Fail(string requestId, string traceId, string executionId, long revision, PortfolioScope scope, string reasonCode)
    {
        lock (this.gate)
        {
            if (active is null || active.RequestId != requestId || active.TraceId != traceId || active.ExecutionId != executionId || !active.Scope.Equals(scope))
                return Failure(PortfolioSpecialOrderActionProtocol.AcceptAction, requestId, traceId, executionId, revision, "execution_not_active", scope, EmptySelection());
            // A callback at the current revision is stale, and after the
            // semantic adapter has armed a native operation no determinate
            // failure can establish that no native state changed.
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= active.DeadlineMs || revision <= active.Revision || active.NativeOperationArmed)
                return CompleteFailure(active, "native_operation_uncertain");
            active.Revision = revision;
            return CompleteFailure(active, PortfolioSpecialOrderActionProtocol.NormalizeFailureReason(reasonCode));
        }
    }

    private PortfolioSpecialOrderReceipt? ValidateCommon(string action, string requestId, string traceId, string idempotencyKey,
        long expectedRevision, long deadlineMs, string cancellationToken, PortfolioSpecialOrderRuntimeState runtime, PortfolioSpecialOrderDsmSelection selection,
        PortfolioScope scope, long currentRevision, string offer, string order, string generation, string reward)
    {
        string executionId = NewExecutionId();
        if (!PortfolioSpecialOrderActionProtocol.IsValidAction(action) || !PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(requestId)
            || !PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(traceId) || !PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(idempotencyKey)
            || !PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(cancellationToken) || !runtime.IsActionReady || !selection.IsValid
            || !scope.IsValid || !scope.Equals(runtime.Scope) || !selection.Equals(new PortfolioSpecialOrderDsmSelection(offer, order, generation, reward)))
            return Failure(action, requestId, traceId, executionId, currentRevision, "portfolio_binding_invalid", runtime.Scope, selection);
        if (expectedRevision != currentRevision)
            return Failure(action, requestId, traceId, executionId, currentRevision, "revision_mismatch", runtime.Scope, selection);
        if (deadlineMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
            return Failure(action, requestId, traceId, executionId, currentRevision, "deadline_expired", runtime.Scope, selection);
        if (!PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(offer) || !PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(order)
            || !PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(generation) || !PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(reward))
            return Failure(action, requestId, traceId, executionId, currentRevision, "unselected_domain_no_claim", runtime.Scope, selection);
        return null;
    }

    private PortfolioSpecialOrderReceipt CompleteAdapterFailure(ActiveExecution execution)
        // Once the adapter has been invoked, deadline expiry or exception
        // cannot prove the native operation had no effect.
        => CompleteFailure(execution, execution.NativeOperationArmed
            ? "native_operation_uncertain"
            : (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= execution.DeadlineMs ? "deadline_expired" : "native_operation_uncertain"));

    private PortfolioSpecialOrderReceipt CompleteFailure(ActiveExecution execution, string reasonCode)
    {
        execution.Phases.Add(Phase(execution, "terminal", execution.Revision, reasonCode));
        string state = reasonCode switch
        {
            "cancelled" => "cancelled",
            "deadline_expired" => "expired",
            "native_operation_uncertain" => "uncertain",
            _ => "failed"
        };
        PortfolioSpecialOrderReceipt receipt = Finish(execution, state, reasonCode);
        StoreReplay(execution.IdempotencyKey, new ReplayEntry(execution.ToRequest(), receipt, execution.Scope));
        active = null;
        return receipt;
    }

    private PortfolioSpecialOrderReceipt? TryReplay(string action, string requestId, string traceId, string idempotencyKey, long revision, long deadline, string cancel,
        PortfolioScope scope, PortfolioSpecialOrderDsmSelection selection)
    {
        if (!completedByIdempotency.TryGetValue(idempotencyKey, out ReplayEntry? entry)) return null;
        return entry.Matches(action, requestId, traceId, revision, deadline, cancel, scope, selection)
            ? entry.Receipt
            : Failure(action, requestId, traceId, NewExecutionId(), entry.Receipt.Revision, "idempotency_key_reused_with_different_request", entry.Scope, entry.Request.Selection);
    }

    private PortfolioSpecialOrderReceipt Remember(string key, PortfolioSpecialOrderAcceptRequest request, PortfolioSpecialOrderDsmSelection selection, PortfolioSpecialOrderReceipt receipt, PortfolioScope scope)
    {
        StoreReplay(key, new ReplayEntry(
            new RequestFingerprint(request.Action, request.RequestId, request.TraceId, request.IdempotencyKey, request.ExpectedRevision, request.DeadlineMs, request.CancellationToken, request.Scope,
                new PortfolioSpecialOrderDsmSelection(request.OfferTarget, selection.OrderKey, request.Generation, selection.Reward)), receipt, scope));
        return receipt;
    }

    private PortfolioSpecialOrderReceipt Remember(string key, PortfolioSpecialOrderClaimRequest request, PortfolioSpecialOrderReceipt receipt, PortfolioScope scope)
    {
        StoreReplay(key, new ReplayEntry(
            new RequestFingerprint(request.Action, request.RequestId, request.TraceId, request.IdempotencyKey, request.ExpectedRevision, request.DeadlineMs, request.CancellationToken, request.Scope,
                new PortfolioSpecialOrderDsmSelection("none", request.OrderKey, request.Generation, request.Reward)), receipt, scope));
        return receipt;
    }

    private void StoreReplay(string key, ReplayEntry entry)
    {
        if (!completedByIdempotency.ContainsKey(key))
            completedByIdempotency.Add(key, entry);
    }

    private static PortfolioSpecialOrderReceipt Finish(ActiveExecution execution, string state, string reasonCode)
    {
        string nativeState = state == "succeeded"
            ? (execution.Action == PortfolioSpecialOrderActionProtocol.AcceptAction
                ? PortfolioSpecialOrderActionProtocol.AcceptedState
                : PortfolioSpecialOrderActionProtocol.ClaimedState)
            : PortfolioSpecialOrderActionProtocol.UnselectedState;
        return new PortfolioSpecialOrderReceipt(execution.Action, execution.RequestId, execution.TraceId, execution.ExecutionId, state,
            execution.Revision, reasonCode,
            new PortfolioSpecialOrderEvidence(PortfolioSpecialOrderEvidenceIdentity.FromScope(execution.Scope), execution.Phases.ToArray(),
                execution.Selection.OfferTarget, execution.OrderKey ?? execution.Selection.OrderKey, execution.Selection.Generation, execution.Selection.Reward,
                execution.Action == PortfolioSpecialOrderActionProtocol.AcceptAction,
                execution.ObjectiveCompletionObserved, execution.RewardEntitlementObserved, execution.RewardConsumed, execution.RewardGranted),
            new PortfolioSpecialOrderPostcondition(execution.BeforeRevision, execution.Revision, nativeState, execution.OfferAccepted,
                execution.ObjectiveCompletionObserved, execution.RewardEntitlementObserved, execution.RewardConsumed, execution.RewardGranted,
                execution.OrderKey ?? execution.Selection.OrderKey, execution.Selection.Generation));
    }

    private static PortfolioSpecialOrderReceipt Failure(string action, string requestId, string traceId, string executionId, long revision,
        string reasonCode, PortfolioScope scope, PortfolioSpecialOrderDsmSelection selection)
    {
        PortfolioSpecialOrderPhase[] phases = { new(requestId, traceId, executionId, action, "fresh_observed", revision, "fresh_observed"), new(requestId, traceId, executionId, action, "terminal", revision, reasonCode) };
        string state = reasonCode switch
        {
            "deadline_expired" => "expired",
            "native_operation_uncertain" => "blocked",
            "cancelled" => "cancelled",
            _ => "rejected"
        };
        return new PortfolioSpecialOrderReceipt(action, requestId, traceId, executionId, state, revision, reasonCode,
            new PortfolioSpecialOrderEvidence(PortfolioSpecialOrderEvidenceIdentity.FromScope(scope), phases, selection.OfferTarget, selection.OrderKey, selection.Generation, selection.Reward,
                false, false, false, false, false),
            new PortfolioSpecialOrderPostcondition(revision, revision, PortfolioSpecialOrderActionProtocol.UnselectedState, false, false, false, false, false, selection.OrderKey, selection.Generation));
    }

    private static PortfolioSpecialOrderPhase Phase(ActiveExecution execution, string phase, long revision, string reasonCode)
        => new(execution.RequestId, execution.TraceId, execution.ExecutionId, execution.Action, phase, revision, reasonCode);

    private static bool IsMatchingFreshOffer(PortfolioSpecialOrderAcceptRequest request, PortfolioSpecialOrderRuntimeState runtime,
        PortfolioSpecialOrderDsmSelection selection, PortfolioSpecialOrderFreshOfferObservation freshOffer)
        => freshOffer.IsValid && request.OfferTarget == freshOffer.OfferTarget && request.Generation == freshOffer.Generation
            && request.Scope.Equals(freshOffer.Scope) && freshOffer.RequestId == request.RequestId && freshOffer.TraceId == request.TraceId
            && freshOffer.Revision == runtime.Revision && selection.OfferTarget == freshOffer.OfferTarget
            && selection.Generation == freshOffer.Generation;

    private static bool IsMatchingFreshReward(PortfolioSpecialOrderClaimRequest request, PortfolioSpecialOrderRuntimeState runtime,
        PortfolioSpecialOrderDsmSelection selection, PortfolioSpecialOrderFreshRewardObservation freshReward)
        => freshReward.IsValid && request.OrderKey == selection.OrderKey && request.Generation == selection.Generation && request.Reward == selection.Reward
            && request.Scope.Equals(freshReward.Scope) && freshReward.RequestId == request.RequestId && freshReward.TraceId == request.TraceId
            && freshReward.Revision == runtime.Revision && freshReward.OrderKey == selection.OrderKey && freshReward.Generation == selection.Generation
            && freshReward.Reward == selection.Reward;

    private static bool IsMatchingAcceptance(ActiveExecution execution, PortfolioSpecialOrderAcceptanceObservation observation)
        => observation.IsValid && observation.RequestId == execution.RequestId && observation.TraceId == execution.TraceId && observation.ExecutionId == execution.ExecutionId
            && observation.Scope.Equals(execution.Scope) && observation.OfferTarget == execution.Selection.OfferTarget && observation.OrderKey == execution.Selection.OrderKey
            && observation.Generation == execution.Selection.Generation
            && observation.Revision > execution.BeforeRevision && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() < execution.DeadlineMs;

    private static bool IsMatchingClaim(ActiveExecution execution, PortfolioSpecialOrderRewardClaimObservation observation)
        => observation.IsValid && observation.RequestId == execution.RequestId && observation.TraceId == execution.TraceId && observation.ExecutionId == execution.ExecutionId
            && observation.Scope.Equals(execution.Scope) && observation.OrderKey == execution.Selection.OrderKey && observation.Generation == execution.Selection.Generation
            && observation.Reward == execution.Selection.Reward && observation.Revision > execution.BeforeRevision && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() < execution.DeadlineMs;

    private static bool IsRuntimeStillValid(ActiveExecution execution, PortfolioSpecialOrderRuntimeState runtime, long observedRevision)
        => runtime.IsActionReady && runtime.Scope.Equals(execution.Scope) && runtime.Revision == observedRevision
            && runtime.Revision > execution.BeforeRevision
            && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() < execution.DeadlineMs;

    private static PortfolioSpecialOrderAcceptanceObservation InvalidAcceptanceObservation(PortfolioSpecialOrderAcceptRequest request, PortfolioScope scope, PortfolioSpecialOrderDsmSelection selection, string executionId)
        => new(request.RequestId, request.TraceId, executionId, scope, request.ExpectedRevision, selection.OfferTarget, selection.OrderKey, selection.Generation, false, false);

    private static PortfolioSpecialOrderRewardClaimObservation InvalidClaimObservation(PortfolioSpecialOrderClaimRequest request, PortfolioScope scope, PortfolioSpecialOrderDsmSelection selection, string executionId)
        => new(request.RequestId, request.TraceId, executionId, scope, request.ExpectedRevision, selection.OrderKey, selection.Generation, selection.Reward, false, false, false);

    private static string NewExecutionId() => Guid.NewGuid().ToString("N");
    private static PortfolioScope InvalidScope() => new(PortfolioBridgeProtocol.IntegrationId, PortfolioBridgeProtocol.Topology, "invalid", "invalid", "invalid", "invalid", 0, new string('0', 64));
    private static PortfolioScope SafeScope(PortfolioScope? scope) => scope is { IsValid: true } ? scope : InvalidScope();
    private static PortfolioSpecialOrderDsmSelection SafeSelection(PortfolioSpecialOrderDsmSelection? selection) => selection is { IsValid: true } ? selection : EmptySelection();
    private static PortfolioSpecialOrderDsmSelection EmptySelection() => new("none", "none", "none", "none");

    private sealed class ActiveExecution
    {
        internal ActiveExecution(string action, string requestId, string traceId, string idempotencyKey, string cancellationToken, long deadlineMs, long beforeRevision,
            PortfolioScope scope, PortfolioSpecialOrderDsmSelection selection, string executionId)
        {
            Action = action; RequestId = requestId; TraceId = traceId; IdempotencyKey = idempotencyKey; CancellationToken = cancellationToken;
            DeadlineMs = deadlineMs; BeforeRevision = beforeRevision; Revision = beforeRevision; Scope = scope; Selection = selection; ExecutionId = executionId;
        }
        internal string Action { get; }
        internal string RequestId { get; }
        internal string TraceId { get; }
        internal string IdempotencyKey { get; }
        internal string CancellationToken { get; }
        internal long DeadlineMs { get; }
        internal long BeforeRevision { get; }
        internal long Revision { get; set; }
        internal PortfolioScope Scope { get; }
        internal PortfolioSpecialOrderDsmSelection Selection { get; }
        internal string ExecutionId { get; }
        internal string? OrderKey { get; set; }
        internal bool Irreversible { get; set; }
        internal bool NativeOperationArmed { get; set; }
        internal bool Cancelled { get; set; }
        internal bool OfferAccepted { get; set; }
        internal bool ObjectiveCompletionObserved { get; set; }
        internal bool RewardEntitlementObserved { get; set; }
        internal bool RewardConsumed { get; set; }
        internal bool RewardGranted { get; set; }
        internal List<PortfolioSpecialOrderPhase> Phases { get; } = new();
        internal RequestFingerprint ToRequest() => new(Action, RequestId, TraceId, IdempotencyKey, BeforeRevision, DeadlineMs, CancellationToken, Scope, Selection);
    }

    private sealed record RequestFingerprint(string Action, string RequestId, string TraceId, string IdempotencyKey, long ExpectedRevision, long DeadlineMs, string CancellationToken, PortfolioScope Scope, PortfolioSpecialOrderDsmSelection Selection);
    private sealed record ReplayEntry(RequestFingerprint Request, PortfolioSpecialOrderReceipt Receipt, PortfolioScope Scope)
    {
        internal bool Matches(string action, string requestId, string traceId, long revision, long deadline, string cancel, PortfolioScope scope, PortfolioSpecialOrderDsmSelection selection)
            => Request.Action == action && Request.RequestId == requestId && Request.TraceId == traceId && Request.ExpectedRevision == revision
                && Request.DeadlineMs == deadline && Request.CancellationToken == cancel && Request.Scope.Equals(scope) && Request.Selection.Equals(selection);
    }
    private readonly record struct OrderIdentity(string OrderKey, string Generation);
    private enum OrderLifecycle { AcceptedInProgress, CompletedRewardUnclaimed, CompletedRewardClaimed }
    private sealed record OrderState(
        string OrderKey,
        string Generation,
        string OfferTarget,
        string Reward,
        PortfolioScope Scope,
        string AcceptedExecutionId,
        string AcceptRequestId,
        string AcceptTraceId,
        long AcceptedRevision,
        long AcceptDeadlineMs,
        OrderLifecycle Lifecycle,
        long CompletionRevision = 0);
}
