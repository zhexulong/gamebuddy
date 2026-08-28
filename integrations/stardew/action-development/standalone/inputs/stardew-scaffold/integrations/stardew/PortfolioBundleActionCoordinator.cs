namespace GameBuddy.Stardew;

/// <summary>
/// Game-thread-owned future core for the two independent M7 bundle transactions.
/// The adapter exposes semantic exact operations only; native invocation remains a later seam.
/// </summary>
internal sealed class PortfolioBundleActionCoordinator
{
    private readonly object gate = new();
    private readonly IPortfolioBundleNativeAdapter? adapter;
    private readonly Dictionary<string, ReplayEntry> completedByIdempotency = new(StringComparer.Ordinal);
    private BundleExecution? active;

    internal PortfolioBundleActionCoordinator(IPortfolioBundleNativeAdapter? adapter = null) => this.adapter = adapter;

    internal PortfolioBundleActionReceipt BeginContribute(
        PortfolioContributeBundleSlotRequest request,
        PortfolioBundleExecutionContext context,
        PortfolioBundleSlotObservation observation)
    {
        lock (this.gate)
        {
            if (request is null || !request.IsValid)
                return InvalidRequest(request, context);
            PortfolioBundleActionReceipt? replay = this.TryReplay(request.RequestId, request.TraceId, request.Action, request.IdempotencyKey, Fingerprint(request), request.Scope);
            if (replay is not null)
                return replay;
            if (this.active is not null)
            {
                // The active execution owns its idempotency key through its
                // terminal receipt; an in-flight retry must not pre-seed it.
                bool sameKey = String.Equals(this.active.IdempotencyKey, request.IdempotencyKey, StringComparison.Ordinal);
                string reason = sameKey && String.Equals(this.active.Fingerprint, Fingerprint(request), StringComparison.Ordinal)
                    ? "execution_already_active"
                    : (sameKey ? "idempotency_key_reused_with_different_request" : "execution_already_active");
                return Failure(request.RequestId, request.TraceId, NewExecutionId(), request.Action, this.active.Revision, reason, this.active.Scope);
            }
            if (context is null)
                return RememberTerminal(request.IdempotencyKey, Fingerprint(request), InvalidRequest(request, context), request.Scope);
            if (!context.IsValid || !request.Scope.Equals(context.Scope))
                return RememberTerminal(request.IdempotencyKey, Fingerprint(request), Failure(request.RequestId, request.TraceId, NewExecutionId(), request.Action, context.CurrentRevision, "portfolio_binding_invalid", SafeScope(context.Scope)), request.Scope);
            if (request.ExpectedRevision != context.CurrentRevision)
                return RememberTerminal(request.IdempotencyKey, Fingerprint(request), Failure(request.RequestId, request.TraceId, NewExecutionId(), request.Action, context.CurrentRevision, "revision_mismatch", context.Scope), request.Scope);
            if (!Guards(request.DeadlineMs, context, request.ExpectedRevision))
                return RememberTerminal(request.IdempotencyKey, Fingerprint(request), Failure(request.RequestId, request.TraceId, NewExecutionId(), request.Action, context.CurrentRevision, DeadlineReason(request.DeadlineMs), context.Scope), request.Scope);
            if (observation is null || !observation.IsValid(request.ExpectedRevision, context.Scope)
                || !SameSelector(observation.Selector, request.Selector)
                || !String.Equals(observation.Target.TargetId, request.Target.TargetId, StringComparison.Ordinal)
                || !String.Equals(observation.Item.ItemIdentity, request.Item.ItemIdentity, StringComparison.Ordinal)
                || observation.Item.Stack != request.Item.Stack || observation.Item.Quality != request.Item.Quality
                || !request.Selector.AcceptedItemIds.Contains(request.Item.ItemIdentity, StringComparer.Ordinal)
                || !String.Equals(observation.RewardState, PortfolioBundleActionProtocol.RewardUnavailable, StringComparison.Ordinal)
                || !String.Equals(observation.SlotState, PortfolioBundleActionProtocol.OpenSlot, StringComparison.Ordinal)
                || !String.Equals(observation.MutexState, PortfolioBundleActionProtocol.FreeMutex, StringComparison.Ordinal))
                return RememberTerminal(request.IdempotencyKey, Fingerprint(request), Failure(request.RequestId, request.TraceId, NewExecutionId(), request.Action, context.CurrentRevision, "bundle_selection_or_state_invalid", context.Scope), request.Scope);
            BundleExecution execution = new(request.RequestId, request.TraceId, request.Action, request.IdempotencyKey, Fingerprint(request), request.CancellationToken, request.DeadlineMs, request.ExpectedRevision, NewExecutionId(), context.Scope, request.Selector, request.Target, request.Item, request.Selector.RewardId);
            execution.Phases.Add(Phase(execution, "fresh_observed", request.ExpectedRevision, "fresh_observed"));
            execution.Phases.Add(Phase(execution, "accepted", request.ExpectedRevision, "accepted"));
            this.active = execution;
            try
            {
                PortfolioBundleActionReceipt receipt;
                if (this.adapter is null || !this.adapter.IsAvailable)
                    receipt = Terminate(execution, "blocked", "adapter_unavailable", observation, null);
                else if (!this.TryContribute(execution, out PortfolioBundleMutation? mutation) || mutation is null)
                    receipt = Terminate(execution, "uncertain", "native_operation_uncertain", observation, null);
                else if (!mutation.IsValid)
                    // The adapter supplied facts but they fail our closure
                    // schema. Preserve them in an uncertain receipt rather
                    // than inventing a no-change observation.
                    receipt = Terminate(execution, "uncertain", "native_operation_facts_invalid", observation, mutation);
                else if (mutation.CancellationObserved || IsCancelled(execution))
                    receipt = Terminate(execution, "uncertain", "cancellation_not_safely_confirmed", observation, mutation);
                else if (mutation.DeadlineExpired || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= request.DeadlineMs)
                    receipt = Terminate(execution, "expired", "deadline_expired", observation, mutation);
                else if (mutation.Revision <= execution.BeforeRevision)
                    receipt = Terminate(execution, "uncertain", "stale_native_operation", observation, mutation);
                else
                    receipt = Complete(execution, observation, mutation);
                return RememberTerminal(request.IdempotencyKey, execution.Fingerprint, receipt, context.Scope);
            }
            catch
            {
                PortfolioBundleActionReceipt receipt = Terminate(execution, "uncertain", "native_operation_uncertain", observation, null);
                return RememberTerminal(request.IdempotencyKey, execution.Fingerprint, receipt, context.Scope);
            }
            finally { this.active = null; }
        }
    }

    internal PortfolioBundleActionReceipt BeginClaimReward(
        PortfolioClaimBundleRewardRequest request,
        PortfolioBundleExecutionContext context,
        PortfolioBundleRewardObservation observation)
    {
        lock (this.gate)
        {
            if (request is null || !request.IsValid)
                return InvalidRequest(request, context);
            PortfolioBundleActionReceipt? replay = this.TryReplay(request.RequestId, request.TraceId, request.Action, request.IdempotencyKey, Fingerprint(request), request.Scope);
            if (replay is not null)
                return replay;
            if (this.active is not null)
            {
                // See contribution: active work remains the sole owner of its
                // terminal idempotency record.
                bool sameKey = String.Equals(this.active.IdempotencyKey, request.IdempotencyKey, StringComparison.Ordinal);
                string reason = sameKey && String.Equals(this.active.Fingerprint, Fingerprint(request), StringComparison.Ordinal)
                    ? "execution_already_active"
                    : (sameKey ? "idempotency_key_reused_with_different_request" : "execution_already_active");
                return Failure(request.RequestId, request.TraceId, NewExecutionId(), request.Action, this.active.Revision, reason, this.active.Scope);
            }
            if (context is null)
                return RememberTerminal(request.IdempotencyKey, Fingerprint(request), InvalidRequest(request, context), request.Scope);
            if (!context.IsValid || !request.Scope.Equals(context.Scope))
                return RememberTerminal(request.IdempotencyKey, Fingerprint(request), Failure(request.RequestId, request.TraceId, NewExecutionId(), request.Action, context.CurrentRevision, "portfolio_binding_invalid", SafeScope(context.Scope)), request.Scope);
            if (request.ExpectedRevision != context.CurrentRevision)
                return RememberTerminal(request.IdempotencyKey, Fingerprint(request), Failure(request.RequestId, request.TraceId, NewExecutionId(), request.Action, context.CurrentRevision, "revision_mismatch", context.Scope), request.Scope);
            if (!Guards(request.DeadlineMs, context, request.ExpectedRevision))
                return RememberTerminal(request.IdempotencyKey, Fingerprint(request), Failure(request.RequestId, request.TraceId, NewExecutionId(), request.Action, context.CurrentRevision, DeadlineReason(request.DeadlineMs), context.Scope), request.Scope);
            if (observation is null || !observation.IsValid(request.ExpectedRevision, context.Scope)
                || !SameSelector(observation.Selector, request.Selector)
                || !String.Equals(observation.Target.TargetId, request.Target.TargetId, StringComparison.Ordinal)
                || !String.Equals(observation.RewardId, request.RewardId, StringComparison.Ordinal)
                || !String.Equals(observation.RewardId, request.Selector.RewardId, StringComparison.Ordinal)
                || !String.Equals(observation.RewardState, PortfolioBundleActionProtocol.RewardAvailable, StringComparison.Ordinal)
                || !String.Equals(observation.MutexState, PortfolioBundleActionProtocol.FreeMutex, StringComparison.Ordinal))
                return RememberTerminal(request.IdempotencyKey, Fingerprint(request), Failure(request.RequestId, request.TraceId, NewExecutionId(), request.Action, context.CurrentRevision, "bundle_selection_or_state_invalid", context.Scope), request.Scope);
            BundleExecution execution = new(request.RequestId, request.TraceId, request.Action, request.IdempotencyKey, Fingerprint(request), request.CancellationToken, request.DeadlineMs, request.ExpectedRevision, NewExecutionId(), context.Scope, request.Selector, request.Target, null, request.RewardId);
            execution.Phases.Add(Phase(execution, "fresh_observed", request.ExpectedRevision, "fresh_observed"));
            execution.Phases.Add(Phase(execution, "accepted", request.ExpectedRevision, "accepted"));
            this.active = execution;
            try
            {
                PortfolioBundleActionReceipt receipt;
                if (this.adapter is null || !this.adapter.IsAvailable)
                    receipt = Terminate(execution, "blocked", "adapter_unavailable", observation, null);
                else if (!this.TryClaimReward(execution, out PortfolioBundleMutation? mutation) || mutation is null)
                    receipt = Terminate(execution, "uncertain", "native_operation_uncertain", observation, null);
                else if (!mutation.IsValid)
                    receipt = Terminate(execution, "uncertain", "native_operation_facts_invalid", observation, mutation);
                else if (mutation.CancellationObserved || IsCancelled(execution))
                    receipt = Terminate(execution, "uncertain", "cancellation_not_safely_confirmed", observation, mutation);
                else if (mutation.DeadlineExpired || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= request.DeadlineMs)
                    receipt = Terminate(execution, "expired", "deadline_expired", observation, mutation);
                else if (mutation.Revision <= execution.BeforeRevision)
                    receipt = Terminate(execution, "uncertain", "stale_native_operation", observation, mutation);
                else
                    receipt = Complete(execution, observation, mutation);
                return RememberTerminal(request.IdempotencyKey, execution.Fingerprint, receipt, context.Scope);
            }
            catch
            {
                PortfolioBundleActionReceipt receipt = Terminate(execution, "uncertain", "native_operation_uncertain", observation, null);
                return RememberTerminal(request.IdempotencyKey, execution.Fingerprint, receipt, context.Scope);
            }
            finally { this.active = null; }
        }
    }

    internal PortfolioBundleActionReceipt Cancel(PortfolioBundleCancelRequest request)
    {
        lock (this.gate)
        {
            if (request is null || !request.IsValid || this.active is null || this.active.RequestId != request.RequestId || this.active.TraceId != request.TraceId || this.active.ExecutionId != request.ExecutionId || this.active.Action != request.Action || !this.active.Scope.Equals(request.Scope))
                return Failure(request?.RequestId ?? "invalid", request?.TraceId ?? "invalid", request?.ExecutionId ?? NewExecutionId(), request?.Action ?? "invalid", this.active?.Revision ?? 0, "execution_not_active", this.active?.Scope ?? InvalidScope());
            if (!String.Equals(this.active.CancellationToken, request.CancellationToken, StringComparison.Ordinal))
                return Failure(this.active.RequestId, this.active.TraceId, this.active.ExecutionId, this.active.Action, this.active.Revision, "cancellation_token_mismatch", this.active.Scope);
            BundleExecution execution = this.active;
            // The adapter may be synchronously re-entering this coordinator.
            // Mark cancellation but retain ownership until that invocation
            // returns and terminalizes the native outcome as uncertain.
            if (execution.Cancelled)
                return Failure(execution.RequestId, execution.TraceId, execution.ExecutionId, execution.Action, execution.Revision,
                    "cancellation_already_requested", execution.Scope, execution, "blocked");
            execution.Cancelled = true;
            return Failure(execution.RequestId, execution.TraceId, execution.ExecutionId, execution.Action, execution.Revision,
                "native_operation_uncertain", execution.Scope, execution, "blocked");
        }
    }

    private PortfolioBundleActionReceipt RememberTerminal(string key, string fingerprint, PortfolioBundleActionReceipt receipt, PortfolioScope scope)
    {
        if (this.completedByIdempotency.TryGetValue(key, out ReplayEntry? existing))
            return existing.Fingerprint == fingerprint ? existing.Receipt : Failure(receipt.RequestId, receipt.TraceId, NewExecutionId(), receipt.Action, existing.Receipt.Revision, "idempotency_key_reused_with_different_request", scope);
        this.completedByIdempotency.Add(key, new ReplayEntry(fingerprint, receipt, scope));
        return receipt;
    }

    private PortfolioBundleActionReceipt? TryReplay(string requestId, string traceId, string action, string key, string requestFingerprint, PortfolioScope scope)
    {
        if (!this.completedByIdempotency.TryGetValue(key, out ReplayEntry? entry))
            return null;
        return entry.Fingerprint == requestFingerprint
            ? entry.Receipt
            : Failure(requestId, traceId, NewExecutionId(), action, entry.Receipt.Revision, "idempotency_key_reused_with_different_request", scope);
    }

    private bool IsCancelled(BundleExecution execution) => this.active == execution && execution.Cancelled;

    private bool TryContribute(BundleExecution execution, out PortfolioBundleMutation? mutation)
        => this.adapter!.TryContributeBundleSlot(new PortfolioBundleContributionContext(execution.RequestId, execution.TraceId, execution.ExecutionId, execution.Scope, execution.Selector, execution.Target, execution.Item!, execution.DeadlineMs, execution.CancellationToken), out mutation);

    private bool TryClaimReward(BundleExecution execution, out PortfolioBundleMutation? mutation)
        => this.adapter!.TryClaimBundleReward(new PortfolioBundleRewardClaimContext(execution.RequestId, execution.TraceId, execution.ExecutionId, execution.Scope, execution.Selector, execution.Target, execution.RewardId, execution.DeadlineMs, execution.CancellationToken), out mutation);

    private static bool IsMatchingMutation(BundleExecution execution, PortfolioBundleMutation facts)
        => facts.RequestId == execution.RequestId && facts.TraceId == execution.TraceId && facts.ExecutionId == execution.ExecutionId
            && facts.Scope.Equals(execution.Scope) && facts.Revision > execution.BeforeRevision
            && facts.SelectorIdBefore == execution.Selector.SelectorId && facts.SelectorIdAfter == execution.Selector.SelectorId
            && facts.TargetIdBefore == execution.Target.TargetId && facts.TargetIdAfter == execution.Target.TargetId
            && facts.ObservationIdBefore == execution.Target.ObservationId && facts.ObservationIdAfter == execution.Target.ObservationId;

    private static PortfolioBundleMutation BaselineFacts(BundleExecution execution, string mutex, string slot, string reward)
        => new(execution.RequestId, execution.TraceId, execution.ExecutionId, execution.Scope,
            mutex, mutex, slot, slot, reward, reward, false, false, false, execution.Revision);

    private static PortfolioBundleActionReceipt InvalidRequest(
        PortfolioContributeBundleSlotRequest? request,
        PortfolioBundleExecutionContext? context)
        => Failure(
            request?.RequestId ?? "invalid",
            request?.TraceId ?? "invalid",
            NewExecutionId(),
            request?.Action ?? "invalid",
            context?.CurrentRevision ?? 0,
            "invalid_request",
            context?.Scope is { IsValid: true } scope ? scope : InvalidScope());

    private static PortfolioBundleActionReceipt InvalidRequest(
        PortfolioClaimBundleRewardRequest? request,
        PortfolioBundleExecutionContext? context)
        => Failure(
            request?.RequestId ?? "invalid",
            request?.TraceId ?? "invalid",
            NewExecutionId(),
            request?.Action ?? "invalid",
            context?.CurrentRevision ?? 0,
            "invalid_request",
            context?.Scope is { IsValid: true } scope ? scope : InvalidScope());

    private static bool SameSelector(PortfolioBundleDsmSelector actual, PortfolioBundleDsmSelector expected)
        => String.Equals(actual.SelectorId, expected.SelectorId, StringComparison.Ordinal)
            && String.Equals(actual.RewardId, expected.RewardId, StringComparison.Ordinal)
            && actual.AcceptedItemIds.SequenceEqual(expected.AcceptedItemIds, StringComparer.Ordinal);

    private static bool Guards(long deadlineMs, PortfolioBundleExecutionContext context, long revision)
        => deadlineMs > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() && revision == context.CurrentRevision && context.Scope.IsValid;

    private static string DeadlineReason(long deadlineMs) => deadlineMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() ? "deadline_expired" : "portfolio_binding_invalid";

    private static PortfolioBundleActionReceipt Complete(BundleExecution execution, PortfolioBundleSlotObservation observation, PortfolioBundleMutation mutation)
        => Finish(execution, observation, mutation, "succeeded", "bundle_action_completed");

    private static PortfolioBundleActionReceipt Complete(BundleExecution execution, PortfolioBundleRewardObservation observation, PortfolioBundleMutation mutation)
        => Finish(execution, observation, mutation, "succeeded", "bundle_action_completed");

    private static PortfolioBundleActionReceipt Terminate(BundleExecution execution, string state, string reasonCode, PortfolioBundleSlotObservation observation, PortfolioBundleMutation? mutation)
        => Finish(execution, observation, mutation, state, reasonCode);

    private static PortfolioBundleActionReceipt Terminate(BundleExecution execution, string state, string reasonCode, PortfolioBundleRewardObservation observation, PortfolioBundleMutation? mutation)
        => Finish(execution, observation, mutation, state, reasonCode);

    private static PortfolioBundleActionReceipt Finish(BundleExecution execution, PortfolioBundleSlotObservation observation, PortfolioBundleMutation? mutation, string state, string reasonCode)
    {
        if (state == "succeeded" && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= execution.DeadlineMs)
        {
            state = "expired";
            reasonCode = "deadline_expired";
        }
        PortfolioBundleMutation facts = mutation ?? BaselineFacts(execution, observation.MutexState, observation.SlotState, observation.RewardState);
        execution.Phases.Add(Phase(execution, "terminal", facts.Revision, reasonCode));
        bool success = state == "succeeded" && facts.FreshAfterObservation && !facts.CancellationObserved && !facts.DeadlineExpired
            && IsMatchingMutation(execution, facts) && facts.ProgressChanged && facts.RewardAvailabilityChanged && facts.InventoryChanged && facts.MutexBefore == "free" && facts.MutexAfter == "released" && facts.SlotBefore == "open" && facts.SlotAfter == "contributed"
            && facts.RewardBefore == "unavailable" && facts.RewardAfter == "available"
            && facts.InventoryStackAfter == facts.InventoryStackBefore - execution.Item!.Stack && facts.ItemIdentityBefore == execution.Item.ItemIdentity && facts.ItemIdentityAfter == execution.Item.ItemIdentity;
        if (!success && state == "succeeded") { state = "uncertain"; reasonCode = "bundle_postcondition_invalid"; }
        // For an uncertain native outcome, preserve every fact the semantic
        // adapter actually observed. The state—not a fabricated no-change
        // snapshot—communicates that those facts cannot establish closure.
        return Receipt(execution, state, reasonCode, observation.Target, observation.Item.ItemIdentity, observation.Item.Stack, observation.Item.Quality, execution.RewardId, facts, facts.Revision, state == "succeeded" && facts.ProgressChanged, state == "succeeded" && facts.RewardAfter == "available", false, state == "succeeded" && facts.InventoryChanged);
    }

    private static PortfolioBundleActionReceipt Finish(BundleExecution execution, PortfolioBundleRewardObservation observation, PortfolioBundleMutation? mutation, string state, string reasonCode)
    {
        if (state == "succeeded" && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= execution.DeadlineMs)
        {
            state = "expired";
            reasonCode = "deadline_expired";
        }
        PortfolioBundleMutation facts = mutation ?? BaselineFacts(execution, observation.MutexState, observation.SlotState, observation.RewardState);
        execution.Phases.Add(Phase(execution, "terminal", facts.Revision, reasonCode));
        // A claim is successful only when the exact selected reward identity
        // and its native inventory quantity are observed across this execution.
        // A broad inventory-changed flag could otherwise attribute an unrelated
        // mutation to the reward claim.
        bool success = state == "succeeded" && facts.FreshAfterObservation && !facts.CancellationObserved && !facts.DeadlineExpired
            && IsMatchingMutation(execution, facts) && facts.RewardIdentityBefore == execution.RewardId && facts.RewardIdentityAfter == execution.RewardId
            && facts.RewardInventoryStackAfter > facts.RewardInventoryStackBefore && facts.InventoryChanged
            && facts.MutexBefore == "free" && facts.MutexAfter == "released" && facts.SlotBefore == "contributed"
            && facts.SlotAfter == "contributed" && facts.RewardBefore == "available" && facts.RewardAfter == "claimed";
        if (!success && state == "succeeded") { state = "uncertain"; reasonCode = "bundle_postcondition_invalid"; }
        return Receipt(execution, state, reasonCode, observation.Target, "none", 0, 0, execution.RewardId, facts, facts.Revision, false, false, state == "succeeded" && facts.RewardAfter == "claimed", state == "succeeded" && facts.InventoryChanged);
    }

    private static PortfolioBundleActionReceipt Receipt(BundleExecution execution, string state, string reasonCode, PortfolioBundleTarget target, string itemIdentity, int stack, int quality, string rewardId, PortfolioBundleMutation facts, long revision, bool progress, bool rewardAvailable, bool rewardClaimed, bool inventoryChanged)
        => new(execution.RequestId, execution.TraceId, execution.ExecutionId, execution.Action, state, revision, reasonCode,
            new PortfolioBundleActionEvidence(PortfolioBundleEvidenceIdentity.FromScope(execution.Scope), execution.Action, execution.Phases.ToArray(), target, itemIdentity, stack, quality, rewardId, facts.RewardIdentityAfter ?? "none", facts.RewardInventoryStackBefore, facts.RewardInventoryStackAfter, facts.MutexBefore, facts.MutexAfter, facts.SlotBefore, facts.SlotAfter, facts.RewardBefore, facts.RewardAfter, facts.ProgressChanged, facts.RewardAvailabilityChanged, facts.InventoryChanged),
            new PortfolioBundleActionPostcondition(execution.BeforeRevision, revision, execution.Action, target.TargetId, progress, rewardAvailable, rewardClaimed, inventoryChanged));

    private static PortfolioBundleActionReceipt Failure(string requestId, string traceId, string executionId, string action, long revision, string reasonCode, PortfolioScope scope, BundleExecution? execution = null, string? stateOverride = null)
    {
        PortfolioBundleActionPhase[] phases = execution?.Phases.Append(new(requestId, traceId, executionId, "terminal", revision, reasonCode)).ToArray()
            ?? new[] { new PortfolioBundleActionPhase(requestId, traceId, executionId, "fresh_observed", revision, "fresh_observed"), new PortfolioBundleActionPhase(requestId, traceId, executionId, "terminal", revision, reasonCode) };
        PortfolioBundleTarget target = execution?.Target ?? new("invalid", "invalid", revision);
        PortfolioBundleMutation facts = execution is null
            ? new(requestId, traceId, executionId, scope, "free", "free", "open", "open", "unavailable", "unavailable", false, false, false, revision)
            : BaselineFacts(execution, "free", "open", "unavailable");
        return new PortfolioBundleActionReceipt(requestId, traceId, executionId, action, stateOverride ?? (reasonCode == "cancelled" ? "cancelled" : "rejected"), revision, reasonCode,
            new PortfolioBundleActionEvidence(PortfolioBundleEvidenceIdentity.FromScope(scope), action, phases, target, execution?.Item?.ItemIdentity ?? "none", execution?.Item?.Stack ?? 0, execution?.Item?.Quality ?? 0, execution?.RewardId ?? "none", facts.RewardIdentityAfter ?? "none", facts.RewardInventoryStackBefore, facts.RewardInventoryStackAfter, facts.MutexBefore, facts.MutexAfter, facts.SlotBefore, facts.SlotAfter, facts.RewardBefore, facts.RewardAfter, false, false, false),
            new PortfolioBundleActionPostcondition(revision, revision, action, target.TargetId, false, false, false, false));
    }

    private static PortfolioBundleActionPhase Phase(BundleExecution execution, string phase, long revision, string reasonCode)
        => new(execution.RequestId, execution.TraceId, execution.ExecutionId, phase, revision, reasonCode);

    private static string Fingerprint(PortfolioContributeBundleSlotRequest request)
        => string.Join("|", request.Action, request.RequestId, request.TraceId, request.IdempotencyKey, request.ExpectedRevision, request.DeadlineMs, request.CancellationToken, request.Scope?.IntegrationId, request.Scope?.Topology, request.Scope?.SaveId, request.Scope?.WorldId, request.Scope?.LocalPlayerId, request.Scope?.CompanionId, request.Scope?.BindingGeneration, request.Scope?.BindingHash, request.Selector.SelectorId, string.Join(",", request.Selector.AcceptedItemIds), request.Selector.RewardId, request.Target.TargetId, request.Target.ObservationId, request.Target.ObservedRevision, request.Item.ItemIdentity, request.Item.Stack, request.Item.Quality);

    private static string Fingerprint(PortfolioClaimBundleRewardRequest request)
        => string.Join("|", request.Action, request.RequestId, request.TraceId, request.IdempotencyKey, request.ExpectedRevision, request.DeadlineMs, request.CancellationToken, request.Scope?.IntegrationId, request.Scope?.Topology, request.Scope?.SaveId, request.Scope?.WorldId, request.Scope?.LocalPlayerId, request.Scope?.CompanionId, request.Scope?.BindingGeneration, request.Scope?.BindingHash, request.Selector.SelectorId, string.Join(",", request.Selector.AcceptedItemIds), request.Selector.RewardId, request.Target.TargetId, request.Target.ObservationId, request.Target.ObservedRevision, request.RewardId);

    private static string NewExecutionId() => Guid.NewGuid().ToString("N");
    private static PortfolioScope SafeScope(PortfolioScope? scope) => scope is { IsValid: true } ? scope : InvalidScope();
    private static PortfolioScope InvalidScope() => new(PortfolioBridgeProtocol.IntegrationId, PortfolioBridgeProtocol.Topology, "invalid", "invalid", "invalid", "invalid", 0, new string('0', 64));

    private sealed class BundleExecution
    {
        internal BundleExecution(string requestId, string traceId, string action, string idempotencyKey, string fingerprint, string cancellationToken, long deadlineMs, long revision, string executionId, PortfolioScope scope, PortfolioBundleDsmSelector selector, PortfolioBundleTarget target, PortfolioBundleItemSelection? item, string rewardId)
        {
            RequestId = requestId; TraceId = traceId; Action = action; IdempotencyKey = idempotencyKey; Fingerprint = fingerprint; CancellationToken = cancellationToken; DeadlineMs = deadlineMs; BeforeRevision = revision; Revision = revision; ExecutionId = executionId; Scope = scope; Selector = selector; Target = target; Item = item; RewardId = rewardId;
        }
        internal string RequestId { get; }
        internal string TraceId { get; }
        internal string Action { get; }
        internal string IdempotencyKey { get; }
        internal string CancellationToken { get; }
        internal long DeadlineMs { get; }
        internal long BeforeRevision { get; }
        internal long Revision { get; set; }
        internal string ExecutionId { get; }
        internal PortfolioScope Scope { get; }
        internal PortfolioBundleDsmSelector Selector { get; }
        internal PortfolioBundleTarget Target { get; }
        internal PortfolioBundleItemSelection? Item { get; }
        internal string RewardId { get; }
        internal string Fingerprint { get; }
        internal bool Cancelled { get; set; }
        internal List<PortfolioBundleActionPhase> Phases { get; } = new();
    }

    private sealed record ReplayEntry(string Fingerprint, PortfolioBundleActionReceipt Receipt, PortfolioScope Scope);
}

/// <summary>Future target-version seam: semantic exact operations only, with no UI, callback, dispatcher, or save access.</summary>
internal interface IPortfolioBundleNativeAdapter
{
    bool IsAvailable { get; }
    bool TryContributeBundleSlot(PortfolioBundleContributionContext context, out PortfolioBundleMutation? mutation);
    bool TryClaimBundleReward(PortfolioBundleRewardClaimContext context, out PortfolioBundleMutation? mutation);
}
