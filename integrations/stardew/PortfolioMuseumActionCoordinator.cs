namespace GameBuddy.Stardew;

/// <summary>
/// Game-thread coordinator for the two bounded M10 Museum transitions. The
/// coordinator owns request guards, replay, the single execution mutex, and
/// receipt construction. Native semantics are supplied only by the typed
/// semantic adapter; no menu, callback, dispatcher, or arbitrary invoker is
/// reachable from this class.
/// </summary>
internal sealed class PortfolioMuseumActionCoordinator
{
    private readonly object gate = new();
    private readonly IPortfolioMuseumSemanticAdapter? adapter;
    private readonly Dictionary<string, ReplayEntry> completedByIdempotency = new(StringComparer.Ordinal);
    private ActiveExecution? active;

    internal PortfolioMuseumActionCoordinator(IPortfolioMuseumSemanticAdapter? adapter = null) => this.adapter = adapter;

    internal PortfolioMuseumReceipt BeginDonate(
        PortfolioMuseumDonationRequest request,
        PortfolioMuseumRuntimeFacts currentFacts)
    {
        lock (this.gate)
        {
            // Request shape is the only prerequisite for an immutable replay.
            // Replay precedes dynamic facts: terminal facts may be stale or
            // unavailable after the native mutation.
            if (!IsRequestShapeValid(request))
                return FailureForMalformedRequest(request, currentFacts);

            string fingerprint = RequestFingerprint(request);
            PortfolioMuseumReceipt? replay = TryReplay(request, fingerprint);
            if (replay is not null)
                return replay;
            PortfolioMuseumReceipt? activeConflict = TryActiveConflict(request, fingerprint);
            if (activeConflict is not null)
                return activeConflict;
            if (currentFacts is null)
                return FailureForMalformedRequest(request, currentFacts);
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (!IsLiveGuardValid(request.Scope, request.ExpectedRevision, request.DeadlineMs, currentFacts, now, out string liveReasonCode))
                return Remember(request.IdempotencyKey, request, Failure(request, NewExecutionId(), currentFacts, liveReasonCode));
            if (!IsDonateRequestValid(request, currentFacts, now, out string reasonCode))
            {
                PortfolioMuseumReceipt failure = Failure(request, NewExecutionId(), currentFacts, reasonCode);
                return this.completedByIdempotency.ContainsKey(request.IdempotencyKey)
                    ? failure
                    : Remember(request.IdempotencyKey, request, failure);
            }
            if (this.active is not null)
                return Remember(request.IdempotencyKey, request, Failure(request, NewExecutionId(), currentFacts, "execution_already_active"));
            if (this.adapter is null || !this.adapter.IsAvailable)
                return Remember(request.IdempotencyKey, request, Failure(request, NewExecutionId(), currentFacts, "adapter_unavailable"));

            string executionId = NewExecutionId();
            PortfolioMuseumDonationContext context = new(request.RequestId, request.TraceId, executionId,
                request.Scope, request.Piece, request.Placement, request.ExactStack, request.CancellationToken, request.DeadlineMs, currentFacts);
            ActiveExecution execution = new(request, request.IdempotencyKey, request.Action, request.RequestId, request.TraceId,
                executionId, request.CancellationToken, request.DeadlineMs, currentFacts.Revision, request.Scope, RequestFingerprint(request));
            this.active = execution;
            PortfolioMuseumReceipt receipt;
            try
            {
                PortfolioMuseumSemanticResult? result = null;
                bool invoked;
                execution.AdapterInvocationStarted = true;
                try { invoked = this.adapter.TryDonateMuseumItem(context, out result!); }
                catch { invoked = false; }
                receipt = invoked && result is not null
                    ? FinishDonate(request, context, currentFacts, execution, result)
                    : Uncertain(request, executionId, currentFacts, "native_operation_uncertain");
            }
            catch { receipt = Uncertain(request, executionId, currentFacts, "native_operation_uncertain"); }
            finally { this.active = null; }
            return SafeRemember(request.IdempotencyKey, request, receipt);
        }
    }

    internal PortfolioMuseumReceipt BeginClaimReward(
        PortfolioMuseumRewardClaimRequest request,
        PortfolioMuseumRuntimeFacts currentFacts)
    {
        lock (this.gate)
        {
            // Request shape is the only prerequisite for an immutable replay.
            // Replay precedes dynamic facts: terminal facts may be stale or
            // unavailable after the native mutation.
            if (!IsRequestShapeValid(request))
                return FailureForMalformedRequest(request, currentFacts);

            string fingerprint = RequestFingerprint(request);
            PortfolioMuseumReceipt? replay = TryReplay(request, fingerprint);
            if (replay is not null)
                return replay;
            PortfolioMuseumReceipt? activeConflict = TryActiveConflict(request, fingerprint);
            if (activeConflict is not null)
                return activeConflict;
            if (currentFacts is null)
                return FailureForMalformedRequest(request, currentFacts);
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (!IsLiveGuardValid(request.Scope, request.ExpectedRevision, request.DeadlineMs, currentFacts, now, out string liveReasonCode))
                return Remember(request.IdempotencyKey, request, Failure(request, NewExecutionId(), currentFacts, liveReasonCode));
            if (!IsClaimRequestValid(request, currentFacts, now, out string reasonCode))
            {
                PortfolioMuseumReceipt failure = Failure(request, NewExecutionId(), currentFacts, reasonCode);
                return this.completedByIdempotency.ContainsKey(request.IdempotencyKey)
                    ? failure
                    : Remember(request.IdempotencyKey, request, failure);
            }
            if (this.active is not null)
                return Remember(request.IdempotencyKey, request, Failure(request, NewExecutionId(), currentFacts, "execution_already_active"));
            if (this.adapter is null || !this.adapter.IsAvailable)
                return Remember(request.IdempotencyKey, request, Failure(request, NewExecutionId(), currentFacts, "adapter_unavailable"));

            string executionId = NewExecutionId();
            PortfolioMuseumRewardClaimContext context = new(request.RequestId, request.TraceId, executionId,
                request.Scope, request.Reward, request.CancellationToken, request.DeadlineMs, currentFacts);
            ActiveExecution execution = new(request, request.IdempotencyKey, request.Action, request.RequestId, request.TraceId,
                executionId, request.CancellationToken, request.DeadlineMs, currentFacts.Revision, request.Scope, RequestFingerprint(request));
            this.active = execution;
            PortfolioMuseumReceipt receipt;
            try
            {
                PortfolioMuseumSemanticResult? result = null;
                bool invoked;
                execution.AdapterInvocationStarted = true;
                try { invoked = this.adapter.TryClaimMuseumReward(context, out result!); }
                catch { invoked = false; }
                receipt = invoked && result is not null
                    ? FinishClaim(request, context, currentFacts, execution, result)
                    : Uncertain(request, executionId, currentFacts, "native_operation_uncertain");
            }
            catch { receipt = Uncertain(request, executionId, currentFacts, "native_operation_uncertain"); }
            finally { this.active = null; }
            return SafeRemember(request.IdempotencyKey, request, receipt);
        }
    }

    internal PortfolioMuseumReceipt Cancel(PortfolioMuseumCancelRequest request, long revision)
    {
        lock (this.gate)
        {
            if (!IsCancelShapeValid(request))
                return Failure(SafeCancelAction(request), SafeCancelRequestId(request), SafeCancelTraceId(request), SafeCancelExecutionId(request), "rejected", revision, SafeScope(request?.Scope), "invalid_request");
            ActiveExecution? execution = this.active;
            if (execution is null || execution.RequestId != request.RequestId || execution.TraceId != request.TraceId || execution.ExecutionId != request.ExecutionId || execution.Action != request.Action || !execution.Scope.Equals(request.Scope))
                return Failure(request.Action, request.RequestId, request.TraceId, request.ExecutionId, "rejected", revision, execution?.Scope ?? SafeScope(request.Scope), "execution_not_active");
            if (execution.CancellationToken != request.CancellationToken)
                return Failure(execution.Action, execution.RequestId, execution.TraceId, execution.ExecutionId, "rejected", revision, execution.Scope, "cancellation_token_mismatch");
            // Caller-supplied revision is not an authority fact. Terminalize
            // only against the coordinator's monotonic game-thread revision.
            long terminalRevision = execution.Revision;
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= execution.DeadlineMs)
            {
                if (execution.AdapterInvocationStarted)
                {
                    // Do not clear the active owner while a reentrant adapter
                    // invocation may still be completing. Its return path will
                    // terminalize this execution as uncertain.
                    if (execution.Cancelled)
                        return Failure(execution.Action, execution.RequestId, execution.TraceId, execution.ExecutionId,
                            "blocked", terminalRevision, execution.Scope, "cancellation_already_requested");
                    execution.Cancelled = true;
                    return Failure(execution.Action, execution.RequestId, execution.TraceId, execution.ExecutionId,
                        "blocked", terminalRevision, execution.Scope, "native_operation_uncertain");
                }
                PortfolioMuseumReceipt expired = Failure(execution.Action, execution.RequestId, execution.TraceId, execution.ExecutionId,
                    "expired", terminalRevision, execution.Scope, "deadline_expired");
                this.active = null;
                return SafeRemember(execution.IdempotencyKey, execution.Request, expired);
            }
            // This coordinator has no native cancellation acknowledgement. Once
            // the semantic adapter call has begun, retain execution ownership;
            // the return path observes Cancelled and terminalizes uncertain.
            if (execution.Cancelled)
                return Failure(execution.Action, execution.RequestId, execution.TraceId, execution.ExecutionId,
                    "blocked", terminalRevision, execution.Scope, "cancellation_already_requested");
            execution.Cancelled = true;
            if (execution.AdapterInvocationStarted)
                return Failure(execution.Action, execution.RequestId, execution.TraceId, execution.ExecutionId,
                    "blocked", terminalRevision, execution.Scope, "native_operation_uncertain");
            PortfolioMuseumReceipt cancelled = Failure(execution.Action, execution.RequestId, execution.TraceId, execution.ExecutionId,
                "cancelled", terminalRevision, execution.Scope, "cancelled");
            this.active = null;
            return SafeRemember(execution.IdempotencyKey, execution.Request, cancelled);
        }
    }

    private static bool IsRequestShapeValid(object? request)
    {
        try { return request switch { PortfolioMuseumDonationRequest donation => donation.IsValid, PortfolioMuseumRewardClaimRequest claim => claim.IsValid, _ => false, }; }
        catch { return false; }
    }

    private static bool IsCancelShapeValid(PortfolioMuseumCancelRequest? request)
    {
        try { return request is not null && request.IsValid; }
        catch { return false; }
    }

    private static string SafeCancelAction(PortfolioMuseumCancelRequest? request) => request?.Action ?? "invalid";

    private static string SafeCancelRequestId(PortfolioMuseumCancelRequest? request) => request?.RequestId ?? "invalid";

    private static string SafeCancelTraceId(PortfolioMuseumCancelRequest? request) => request?.TraceId ?? "invalid";

    private static string SafeCancelExecutionId(PortfolioMuseumCancelRequest? request) => request?.ExecutionId ?? "invalid";

    private static bool IsLiveGuardValid(PortfolioScope? expectedScope, long expectedRevision, long deadlineMs,
        PortfolioMuseumRuntimeFacts? facts, long now, out string reasonCode)
    {
        reasonCode = "accepted";
        if (facts is null || expectedScope is null || !expectedScope.IsValid || facts.Scope is null || !facts.Scope.IsValid || !facts.Scope.Equals(expectedScope))
        { reasonCode = "portfolio_binding_invalid"; return false; }
        if (expectedRevision != facts.Revision) { reasonCode = "revision_mismatch"; return false; }
        if (deadlineMs <= now) { reasonCode = "deadline_expired"; return false; }
        if (!facts.WorldReady || !facts.SinglePlayer || !facts.LocalPlayerMatches) { reasonCode = "portfolio_world_not_ready"; return false; }
        if (!facts.ActionAuthorized) { reasonCode = "portfolio_action_not_allowed"; return false; }
        if (facts.CancellationRequested) { reasonCode = "cancelled"; return false; }
        return facts.Revision >= 0;
    }

    private static PortfolioMuseumReceipt FailureForMalformedRequest(object? request, PortfolioMuseumRuntimeFacts? facts)
    {
        string action = request switch
        {
            PortfolioMuseumDonationRequest donation => donation.Action,
            PortfolioMuseumRewardClaimRequest claim => claim.Action,
            _ => "invalid",
        };
        string requestId = request switch
        {
            PortfolioMuseumDonationRequest donation => donation.RequestId,
            PortfolioMuseumRewardClaimRequest claim => claim.RequestId,
            _ => "invalid",
        };
        string traceId = request switch
        {
            PortfolioMuseumDonationRequest donation => donation.TraceId,
            PortfolioMuseumRewardClaimRequest claim => claim.TraceId,
            _ => "invalid",
        };
        PortfolioScope scope = request switch
        {
            PortfolioMuseumDonationRequest donation => donation.Scope,
            PortfolioMuseumRewardClaimRequest claim => claim.Scope,
            _ => InvalidScope(),
        };
        return Failure(action, requestId, traceId, NewExecutionId(), "rejected", facts?.Revision ?? 0, scope ?? InvalidScope(), "invalid_request");
    }

    private static PortfolioMuseumReceipt Uncertain(PortfolioMuseumDonationRequest request, string executionId, PortfolioMuseumRuntimeFacts facts, string reason)
        => Failure(request.Action, request.RequestId, request.TraceId, executionId, "uncertain", facts.Revision, request.Scope, reason);

    private static PortfolioMuseumReceipt Uncertain(PortfolioMuseumRewardClaimRequest request, string executionId, PortfolioMuseumRuntimeFacts facts, string reason)
        => Failure(request.Action, request.RequestId, request.TraceId, executionId, "uncertain", facts.Revision, request.Scope, reason);

    private static PortfolioScope InvalidScope() => new(PortfolioBridgeProtocol.IntegrationId, PortfolioBridgeProtocol.Topology,
        "invalid", "invalid", "invalid", "invalid", 0, new string('0', 64));

    private static PortfolioScope SafeScope(PortfolioScope? scope) => scope is not null && scope.IsValid ? scope : InvalidScope();

    private static bool IsDonateRequestValid(PortfolioMuseumDonationRequest request, PortfolioMuseumRuntimeFacts facts, long now, out string reasonCode)
    {
        reasonCode = "accepted";
        if (!request.IsValid || request.Action != PortfolioMuseumActionProtocol.DonateAction
            || !request.Scope.IsValid || !facts.IsUsable(request.Scope)
            || !PortfolioMuseumActionProtocol.IsValidOpaqueTarget(request.Piece, "opaque_runtime_museum_piece", facts.Revision)
            || !PortfolioMuseumActionProtocol.IsValidOpaqueTarget(request.Placement, "opaque_runtime_museum_placement", facts.Revision)
            || !PortfolioMuseumActionProtocol.IsValidSelector(request.Selector, PortfolioMuseumActionProtocol.PieceDomain)
            || request.Piece.SelectorId != request.Selector.DomainId
            || request.Placement.SelectorId != request.Selector.DomainId
            || request.ExactStack != 1
            || !String.Equals(request.Piece.Value, facts.InventoryItem, StringComparison.Ordinal)
            || facts.CollectionContainsPiece
            || facts.InventoryStack < request.ExactStack)
        { reasonCode = "invalid_request"; return false; }
        if (request.ExpectedRevision != facts.Revision) { reasonCode = "revision_mismatch"; return false; }
        if (request.DeadlineMs <= now) { reasonCode = "deadline_expired"; return false; }
        if (facts.CancellationRequested) { reasonCode = "cancelled"; return false; }
        return true;
    }

    private static bool IsClaimRequestValid(PortfolioMuseumRewardClaimRequest request, PortfolioMuseumRuntimeFacts facts, long now, out string reasonCode)
    {
        reasonCode = "accepted";
        if (!request.IsValid || request.Action != PortfolioMuseumActionProtocol.ClaimRewardAction
            || !request.Scope.IsValid || !facts.IsUsable(request.Scope)
            || !PortfolioMuseumActionProtocol.IsValidOpaqueTarget(request.Reward, "opaque_runtime_museum_reward", facts.Revision)
            || !PortfolioMuseumActionProtocol.IsValidSelector(request.Selector, PortfolioMuseumActionProtocol.RewardDomain)
            || request.Reward.SelectorId != request.Selector.DomainId
            || !String.Equals(request.Reward.Value, facts.RewardIdentity, StringComparison.Ordinal))
        { reasonCode = "invalid_request"; return false; }
        if (request.ExpectedRevision != facts.Revision) { reasonCode = "revision_mismatch"; return false; }
        if (request.DeadlineMs <= now) { reasonCode = "deadline_expired"; return false; }
        if (facts.CancellationRequested) { reasonCode = "cancelled"; return false; }
        if (!facts.RewardEligible || facts.RewardAlreadyClaimed) { reasonCode = "invalid_request"; return false; }
        return true;
    }

    private PortfolioMuseumReceipt FinishDonate(PortfolioMuseumDonationRequest request, PortfolioMuseumDonationContext context,
        PortfolioMuseumRuntimeFacts before, ActiveExecution execution, PortfolioMuseumSemanticResult result)
    {
        PortfolioMuseumRuntimeFacts after = result.After;
        long terminalNow = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        bool valid = !IsCancelled(context.ExecutionId) && terminalNow < request.DeadlineMs
            && IsMatchingDonationResult(context, before, result)
            && (result.ExtensionData is null || result.ExtensionData.Count == 0)
            && result.HasActionSpecificEvidence(true)
            && after.IsUsable(request.Scope)
            && after.Revision > before.Revision
            && !after.CancellationRequested
            && after.InventoryStack == before.InventoryStack - 1
            && String.Equals(after.InventoryItem, before.InventoryItem, StringComparison.Ordinal)
            && !before.CollectionContainsPiece && after.CollectionContainsPiece
            && String.Equals(after.CollectionPiece, request.Piece.Value, StringComparison.Ordinal)
            && String.Equals(after.CollectionPlacement, request.Placement.Value, StringComparison.Ordinal)
            && after.RewardEligible == before.RewardEligible
            && after.RewardDeliveryCount == before.RewardDeliveryCount;
        // Adapter invocation may have crossed native state before either
        // cancellation or expiry is observed. Do not claim a determinate
        // cancellation/expiry without a native no-effect acknowledgement.
        string state = valid ? "succeeded" : "uncertain";
        string reason = valid ? "accepted" : "native_operation_uncertain";
        PortfolioMuseumPhase[] phases = Phases(request.Action, request.RequestId, request.TraceId, context.ExecutionId, before.Revision, after.Revision, reason, "donation");
        PortfolioMuseumEvidence evidence = new(request.Action, request.Scope, request.Piece, phases, before, after,
            before.MutexAvailable, !before.CollectionContainsPiece, false, result.FreshObservation, valid);
        PortfolioMuseumPostcondition postcondition = new(before.Revision, after.Revision, request.Piece.Value, request.Placement.Value,
            before.InventoryItem, after.InventoryItem, request.ExactStack, before.InventoryStack, after.InventoryStack, after.CollectionContainsPiece != before.CollectionContainsPiece,
            false, after.RewardDeliveryCount - before.RewardDeliveryCount, result.FreshObservation);
        return new PortfolioMuseumReceipt(request.Action, request.RequestId, request.TraceId, context.ExecutionId,
            state, after.Revision, reason, evidence, postcondition);
    }

    private PortfolioMuseumReceipt FinishClaim(PortfolioMuseumRewardClaimRequest request, PortfolioMuseumRewardClaimContext context,
        PortfolioMuseumRuntimeFacts before, ActiveExecution execution, PortfolioMuseumSemanticResult result)
    {
        PortfolioMuseumRuntimeFacts after = result.After;
        long terminalNow = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        bool valid = !IsCancelled(context.ExecutionId) && terminalNow < request.DeadlineMs
            && IsMatchingRewardResult(context, before, result)
            && (result.ExtensionData is null || result.ExtensionData.Count == 0)
            && result.HasActionSpecificEvidence(false)
            && after.IsUsable(request.Scope)
            && after.Revision > before.Revision
            && !after.CancellationRequested
            && before.RewardEligible && !after.RewardEligible
            && !before.RewardAlreadyClaimed && after.RewardAlreadyClaimed
            && String.Equals(after.RewardIdentity, request.Reward.Value, StringComparison.Ordinal)
            && after.RewardDeliveryCount == before.RewardDeliveryCount + 1
            && after.CollectionContainsPiece == before.CollectionContainsPiece;
        // As above, an adapter call means the native reward outcome is not
        // determinate without a fresh no-effect acknowledgement.
        string state = valid ? "succeeded" : "uncertain";
        string reason = valid ? "accepted" : "native_operation_uncertain";
        PortfolioMuseumPhase[] phases = Phases(request.Action, request.RequestId, request.TraceId, context.ExecutionId, before.Revision, after.Revision, reason, "reward");
        PortfolioMuseumEvidence evidence = new(request.Action, request.Scope, request.Reward, phases, before, after,
            before.MutexAvailable, false, before.RewardEligible, result.FreshObservation, valid);
        PortfolioMuseumPostcondition postcondition = new(before.Revision, after.Revision, request.Reward.Value, "unchanged",
            before.InventoryItem, after.InventoryItem, 0, before.InventoryStack, after.InventoryStack, false, before.RewardEligible && !after.RewardEligible,
            after.RewardDeliveryCount - before.RewardDeliveryCount, result.FreshObservation);
        return new PortfolioMuseumReceipt(request.Action, request.RequestId, request.TraceId, context.ExecutionId,
            state, after.Revision, reason, evidence, postcondition);
    }

    private static bool IsMatchingDonationResult(PortfolioMuseumDonationContext context, PortfolioMuseumRuntimeFacts before, PortfolioMuseumSemanticResult result)
        => result.RequestId == context.RequestId && result.TraceId == context.TraceId && result.ExecutionId == context.ExecutionId
            && result.Scope.Equals(context.Scope) && result.ExpectedRevision == before.Revision
            && result.Target.Kind == context.Piece.Kind && result.Target.Value == context.Piece.Value
            && result.Target.SelectorId == context.Piece.SelectorId && result.Target.ObservationId == context.Piece.ObservationId
            && result.Target.ObservedRevision == context.Piece.ObservedRevision;

    private static bool IsMatchingRewardResult(PortfolioMuseumRewardClaimContext context, PortfolioMuseumRuntimeFacts before, PortfolioMuseumSemanticResult result)
        => result.RequestId == context.RequestId && result.TraceId == context.TraceId && result.ExecutionId == context.ExecutionId
            && result.Scope.Equals(context.Scope) && result.ExpectedRevision == before.Revision
            && result.Target.Kind == context.Reward.Kind && result.Target.Value == context.Reward.Value
            && result.Target.SelectorId == context.Reward.SelectorId && result.Target.ObservationId == context.Reward.ObservationId
            && result.Target.ObservedRevision == context.Reward.ObservedRevision;

    private bool IsCancelled(string executionId) => this.active?.ExecutionId == executionId && this.active.Cancelled;

    private PortfolioMuseumReceipt? TryActiveConflict(object request, string fingerprint)
    {
        if (this.active is null || !String.Equals(this.active.IdempotencyKey, RequestIdempotencyKey(request), StringComparison.Ordinal))
            return null;
        string reason = this.active.Fingerprint == fingerprint
            ? "execution_already_active"
            : "idempotency_key_reused_with_different_request";
        return Failure(RequestAction(request), RequestId(request), RequestTraceId(request), NewExecutionId(), "rejected",
            this.active.Revision, RequestScope(request), reason);
    }

    private PortfolioMuseumReceipt? TryReplay(object request, string fingerprint)
    {
        string idempotencyKey = request switch
        {
            PortfolioMuseumDonationRequest donation => donation.IdempotencyKey,
            PortfolioMuseumRewardClaimRequest claim => claim.IdempotencyKey,
            _ => throw new InvalidOperationException("unsupported museum request")
        };
        if (!this.completedByIdempotency.TryGetValue(idempotencyKey, out ReplayEntry? entry)) return null;
        return entry.Fingerprint == fingerprint
            ? entry.Receipt
            : Failure(RequestAction(request), RequestId(request), RequestTraceId(request), NewExecutionId(), "rejected", entry.Receipt.Revision, RequestScope(request), "idempotency_key_reused_with_different_request");
    }

    private PortfolioMuseumReceipt SafeRemember(string key, object request, PortfolioMuseumReceipt receipt)
    {
        try { return Remember(key, request, receipt); }
        catch { return Failure(RequestAction(request), RequestId(request), RequestTraceId(request), NewExecutionId(), "failed", receipt.Revision, RequestScope(request), "native_operation_failed"); }
    }

    private PortfolioMuseumReceipt Remember(string key, object request, PortfolioMuseumReceipt receipt)
    {
        if (receipt.State is "succeeded" or "failed" or "cancelled" or "uncertain" or "blocked" or "expired" or "rejected")
            // The first terminal receipt owns the idempotency key; never replace it.
            if (!this.completedByIdempotency.ContainsKey(key))
                this.completedByIdempotency.Add(key, new ReplayEntry(RequestFingerprint(request), receipt, ReceiptScope(receipt)));
        return receipt;
    }

    private static string RequestIdempotencyKey(object request) => request switch
    {
        PortfolioMuseumDonationRequest donation => donation.IdempotencyKey,
        PortfolioMuseumRewardClaimRequest claim => claim.IdempotencyKey,
        _ => "invalid"
    };

    private static string RequestAction(object request) => request switch
    {
        PortfolioMuseumDonationRequest donation => donation.Action,
        PortfolioMuseumRewardClaimRequest claim => claim.Action,
        _ => "invalid"
    };

    private static string RequestId(object request) => request switch
    {
        PortfolioMuseumDonationRequest donation => donation.RequestId,
        PortfolioMuseumRewardClaimRequest claim => claim.RequestId,
        _ => "invalid"
    };

    private static string RequestTraceId(object request) => request switch
    {
        PortfolioMuseumDonationRequest donation => donation.TraceId,
        PortfolioMuseumRewardClaimRequest claim => claim.TraceId,
        _ => "invalid"
    };

    private static PortfolioScope RequestScope(object request) => request switch
    {
        PortfolioMuseumDonationRequest donation => donation.Scope,
        PortfolioMuseumRewardClaimRequest claim => claim.Scope,
        _ => throw new InvalidOperationException("unsupported museum request")
    };

    private static string RequestFingerprint(object request) => request switch
    {
        PortfolioMuseumDonationRequest donation => string.Join("|", donation.Action, donation.RequestId, donation.TraceId, donation.IdempotencyKey, donation.ExpectedRevision, donation.DeadlineMs, donation.CancellationToken, ScopeFingerprint(donation.Scope), donation.Piece.Kind, donation.Piece.Value, donation.Piece.SelectorId, donation.Piece.ObservationId, donation.Piece.ObservedRevision, donation.Placement.Kind, donation.Placement.Value, donation.Placement.SelectorId, donation.Placement.ObservationId, donation.Placement.ObservedRevision, donation.Selector.DomainId, donation.Selector.MinCount, donation.Selector.MaxCount, donation.ExactStack),
        PortfolioMuseumRewardClaimRequest claim => string.Join("|", claim.Action, claim.RequestId, claim.TraceId, claim.IdempotencyKey, claim.ExpectedRevision, claim.DeadlineMs, claim.CancellationToken, ScopeFingerprint(claim.Scope), claim.Reward.Kind, claim.Reward.Value, claim.Reward.SelectorId, claim.Reward.ObservationId, claim.Reward.ObservedRevision, claim.Selector.DomainId, claim.Selector.MinCount, claim.Selector.MaxCount),
        _ => throw new InvalidOperationException("unsupported museum request")
    };

    private static string ScopeFingerprint(PortfolioScope scope) => string.Join("|", scope.IntegrationId, scope.Topology, scope.SaveId, scope.WorldId, scope.LocalPlayerId, scope.CompanionId, scope.BindingGeneration, scope.BindingHash);

    private static PortfolioScope ReceiptScope(PortfolioMuseumReceipt receipt) => receipt.Evidence.Scope;

    private static PortfolioMuseumReceipt Failure(PortfolioMuseumDonationRequest request, string executionId, PortfolioMuseumRuntimeFacts facts, string reason)
        => Failure(request.Action, request.RequestId, request.TraceId, executionId, StateFor(reason), facts.Revision, request.Scope, reason);

    private static PortfolioMuseumReceipt Failure(PortfolioMuseumRewardClaimRequest request, string executionId, PortfolioMuseumRuntimeFacts facts, string reason)
        => Failure(request.Action, request.RequestId, request.TraceId, executionId, StateFor(reason), facts.Revision, request.Scope, reason);

    private static PortfolioMuseumReceipt Failure(string action, string requestId, string traceId, string executionId, string state,
        long revision, PortfolioScope scope, string reason)
    {
        PortfolioMuseumRuntimeFacts facts = new(scope, revision, false, false, false, false, false, false, "invalid", 0, false, "invalid", "invalid", false, false, "invalid", 0);
        PortfolioMuseumOpaqueTarget target = new("opaque_runtime_museum_target", "fresh_observation", "unselected", "unselected", "unselected", revision);
        PortfolioMuseumPhase[] phases = Phases(action, requestId, traceId, executionId, revision, revision, reason, "rejected");
        PortfolioMuseumEvidence evidence = new(action, scope, target, phases, facts, facts, false, false, false, false, false);
        PortfolioMuseumPostcondition postcondition = new(revision, revision, "unselected", "unselected", "invalid", "invalid", 0, 0, 0, false, false, 0, false);
        return new PortfolioMuseumReceipt(action, requestId, traceId, executionId, state, revision, reason, evidence, postcondition);
    }

    private static string StateFor(string reason) => reason switch
    {
        "deadline_expired" => "expired",
        "cancelled" => "cancelled",
        "execution_already_active" or "adapter_unavailable" => "blocked",
        "revision_mismatch" or "invalid_request" => "rejected",
        _ => "failed",
    };

    private static PortfolioMuseumSemanticResult FailedResult(PortfolioMuseumRuntimeFacts facts, string reason) => new(
        "invalid", "invalid", "invalid", facts.Scope, facts.Revision,
        new PortfolioMuseumOpaqueTarget("opaque_runtime_museum_target", "fresh_observation", "unselected", "unselected", "unselected", facts.Revision),
        false, facts, false, false, false, false, false, false, false, false, reason);

    private static PortfolioMuseumPhase[] Phases(string action, string requestId, string traceId, string executionId,
        long beforeRevision, long afterRevision, string reason, string operation)
        => new[]
        {
            new PortfolioMuseumPhase(action, requestId, traceId, executionId, "fresh_observed", beforeRevision, "fresh_observed"),
            new PortfolioMuseumPhase(action, requestId, traceId, executionId, operation, afterRevision, reason),
            new PortfolioMuseumPhase(action, requestId, traceId, executionId, "terminal", afterRevision, reason),
        };

    private static string NewExecutionId() => Guid.NewGuid().ToString("N");

    private sealed class ActiveExecution
    {
        internal ActiveExecution(object request, string idempotencyKey, string action, string requestId, string traceId, string executionId, string cancellationToken, long deadlineMs, long revision, PortfolioScope scope, string fingerprint)
        { Request = request; IdempotencyKey = idempotencyKey; Action = action; RequestId = requestId; TraceId = traceId; ExecutionId = executionId; CancellationToken = cancellationToken; DeadlineMs = deadlineMs; Revision = revision; Scope = scope; Fingerprint = fingerprint; }
        internal object Request { get; }
        internal string IdempotencyKey { get; }
        internal string Action { get; }
        internal string RequestId { get; }
        internal string TraceId { get; }
        internal string ExecutionId { get; }
        internal string CancellationToken { get; }
        internal long DeadlineMs { get; }
        internal PortfolioScope Scope { get; }
        internal string Fingerprint { get; }
        internal long Revision { get; }
        internal bool Cancelled { get; set; }
        internal bool AdapterInvocationStarted { get; set; }
    }

    private sealed record ReplayEntry(string Fingerprint, PortfolioMuseumReceipt Receipt, PortfolioScope Scope);
}
