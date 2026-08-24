using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew;

/// <summary>
/// Typed, semantic-only boundary for the two M9 Special Order transactions.
/// It contains no menu, dispatcher, input, save, or native-call surface.
/// </summary>
internal static class PortfolioSpecialOrderActionProtocol
{
    internal const string AcceptAction = "accept_special_order_offer";
    internal const string ClaimAction = "claim_special_order_reward";
    internal const string FreshOfferState = "fresh_offer_available";
    internal const string AcceptedState = "accepted_in_progress";
    internal const string CompletedUnclaimedState = "completed_reward_unclaimed";
    internal const string ClaimedState = "completed_reward_claimed";
    internal const string UnselectedState = "unselected_domain_no_claim";

    internal static readonly string[] Phases =
    {
        "fresh_observed", "accepted", "offer_committed", "completion_observed", "reward_committed", "terminal",
    };

    internal static bool IsOpaqueRuntimeValue(string? value) => PortfolioBridgeProtocol.IsOpaqueId(value)
        && !String.Equals(value, "none", StringComparison.Ordinal);

    internal static bool IsValidAction(string? value) => value == AcceptAction || value == ClaimAction;

    internal static bool IsUncertainFailureReason(string? value)
        => String.Equals(value, "native_operation_uncertain", StringComparison.Ordinal)
            || String.Equals(value, "portfolio_bridge_disconnected", StringComparison.Ordinal)
            || String.Equals(value, "bridge_disconnected", StringComparison.Ordinal)
            || (value?.Contains("disconnect", StringComparison.OrdinalIgnoreCase) ?? false)
            || (value?.Contains("unknown", StringComparison.OrdinalIgnoreCase) ?? false);

    internal static string NormalizeFailureReason(string? value)
        => IsUncertainFailureReason(value) || !PortfolioBridgeProtocol.IsReasonCode(value)
            ? "native_operation_uncertain" : value!;
}

internal sealed record PortfolioSpecialOrderAcceptRequest(
    string Action,
    string RequestId,
    string TraceId,
    string IdempotencyKey,
    long ExpectedRevision,
    long DeadlineMs,
    string CancellationToken,
    PortfolioScope Scope,
    string OfferTarget,
    string Generation)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Action == PortfolioSpecialOrderActionProtocol.AcceptAction
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(RequestId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(TraceId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(IdempotencyKey)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(CancellationToken)
        && Scope is not null && Scope.IsValid
        && ExpectedRevision >= 0 && DeadlineMs > 0
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(OfferTarget)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(Generation)
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioSpecialOrderClaimRequest(
    string Action,
    string RequestId,
    string TraceId,
    string IdempotencyKey,
    long ExpectedRevision,
    long DeadlineMs,
    string CancellationToken,
    PortfolioScope Scope,
    string OrderKey,
    string Generation,
    string Reward)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Action == PortfolioSpecialOrderActionProtocol.ClaimAction
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(RequestId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(TraceId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(IdempotencyKey)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(CancellationToken)
        && Scope is not null && Scope.IsValid
        && ExpectedRevision >= 0 && DeadlineMs > 0
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(OrderKey)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(Generation)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(Reward)
        && (ExtensionData is null || ExtensionData.Count == 0);
}

/// <summary>Finite content selected by the signed DSM. Values are opaque runtime references.</summary>
internal sealed record PortfolioSpecialOrderDsmSelection(
    string OfferTarget,
    string OrderKey,
    string Generation,
    string Reward)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(OfferTarget)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(OrderKey)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(Generation)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(Reward)
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioSpecialOrderRuntimeState(
    PortfolioScope Scope,
    long Revision,
    bool WorldReady,
    bool SinglePlayer,
    bool CurrentLocalPlayerMatches,
    bool Saving)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsActionReady => Scope is not null && Scope.IsValid
        && (ExtensionData is null || ExtensionData.Count == 0)
        && WorldReady && SinglePlayer && CurrentLocalPlayerMatches && !Saving && Revision >= 0;
}

/// <summary>Freshly observed offer facts; no static offer or generation is accepted.</summary>
internal sealed record PortfolioSpecialOrderFreshOfferObservation(
    string RequestId,
    string TraceId,
    PortfolioScope Scope,
    long Revision,
    string OfferTarget,
    string Generation,
    bool Fresh,
    bool AlreadyAccepted,
    bool PlayerEligible)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Scope is not null && Scope.IsValid
        && (ExtensionData is null || ExtensionData.Count == 0)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(RequestId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(TraceId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(OfferTarget)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(Generation)
        && Revision >= 0 && Fresh && !AlreadyAccepted && PlayerEligible;
}

internal sealed record PortfolioSpecialOrderAcceptanceObservation(
    string RequestId,
    string TraceId,
    string ExecutionId,
    PortfolioScope Scope,
    long Revision,
    string OfferTarget,
    string OrderKey,
    string Generation,
    bool Accepted,
    bool NativeAcceptedInProgress)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Scope is not null && Scope.IsValid
        && (ExtensionData is null || ExtensionData.Count == 0)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(RequestId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(TraceId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(ExecutionId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(OfferTarget)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(OrderKey)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(Generation)
        && Revision >= 0 && Accepted && NativeAcceptedInProgress;
}

/// <summary>Completion is an observation of selected objective facts, never a progress command.</summary>
internal sealed record PortfolioSpecialOrderCompletionObservation(
    string RequestId,
    string TraceId,
    string ExecutionId,
    PortfolioScope Scope,
    long Revision,
    string OrderKey,
    string Generation,
    bool Fresh,
    bool AllSelectedObjectivesComplete,
    bool NativeCompleteState,
    bool ParticipantRewardEntitlementAvailable,
    // Completion is a fresh monitor observation, but it is still part of the
    // action-owned accept → completion → claim lifecycle. This must echo the
    // immutable acceptance deadline; it is not a caller-selected replacement.
    long DeadlineMs = 0)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Scope is not null && Scope.IsValid
        && (ExtensionData is null || ExtensionData.Count == 0)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(RequestId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(TraceId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(ExecutionId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(OrderKey)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(Generation)
        && Revision >= 0 && DeadlineMs > 0 && Fresh && AllSelectedObjectivesComplete && NativeCompleteState && ParticipantRewardEntitlementAvailable;
}

internal sealed record PortfolioSpecialOrderFreshRewardObservation(
    string RequestId,
    string TraceId,
    PortfolioScope Scope,
    long Revision,
    string OrderKey,
    string Generation,
    string Reward,
    bool Fresh,
    bool NativeOrderComplete,
    bool ParticipantRewardUnclaimed)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Scope is not null && Scope.IsValid
        && (ExtensionData is null || ExtensionData.Count == 0)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(RequestId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(TraceId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(OrderKey)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(Generation)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(Reward)
        && Revision >= 0 && Fresh && NativeOrderComplete && ParticipantRewardUnclaimed;
}

internal sealed record PortfolioSpecialOrderRewardClaimObservation(
    string RequestId,
    string TraceId,
    string ExecutionId,
    PortfolioScope Scope,
    long Revision,
    string OrderKey,
    string Generation,
    string Reward,
    bool EntitlementConsumed,
    bool NativeRewardGranted,
    bool NativeClaimedState)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Scope is not null && Scope.IsValid
        && (ExtensionData is null || ExtensionData.Count == 0)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(RequestId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(TraceId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(ExecutionId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(OrderKey)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(Generation)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(Reward)
        && Revision >= 0 && EntitlementConsumed && NativeRewardGranted && NativeClaimedState;
}

internal sealed record PortfolioSpecialOrderPhase(
    string RequestId,
    string TraceId,
    string ExecutionId,
    string Action,
    string Phase,
    long Revision,
    string ReasonCode)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioSpecialOrderEvidenceIdentity(
    string IntegrationId,
    string Topology,
    string SaveId,
    string WorldId,
    string LocalPlayerId,
    string CompanionId,
    long BindingGeneration,
    string BindingHash)
{
    internal static PortfolioSpecialOrderEvidenceIdentity FromScope(PortfolioScope scope) => new(
        scope.IntegrationId, scope.Topology, scope.SaveId, scope.WorldId, scope.LocalPlayerId, scope.CompanionId, scope.BindingGeneration, scope.BindingHash);
}

internal sealed record PortfolioSpecialOrderEvidence(
    PortfolioSpecialOrderEvidenceIdentity Identity,
    IReadOnlyList<PortfolioSpecialOrderPhase> PhaseTrace,
    string OfferTarget,
    string OrderKey,
    string Generation,
    string Reward,
    bool FreshOfferObserved,
    bool ObjectiveSpecificCompletionObserved,
    bool RewardEntitlementObserved,
    bool EntitlementConsumed,
    bool RewardGranted)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioSpecialOrderPostcondition(
    long BeforeRevision,
    long AfterRevision,
    string State,
    bool OfferAccepted,
    bool AllSelectedObjectivesComplete,
    bool RewardEntitlementAvailable,
    bool RewardEntitlementConsumed,
    bool RewardGranted,
    string OrderKey,
    string Generation)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioSpecialOrderReceipt(
    string Action,
    string RequestId,
    string TraceId,
    string ExecutionId,
    string State,
    long Revision,
    string ReasonCode,
    PortfolioSpecialOrderEvidence Evidence,
    PortfolioSpecialOrderPostcondition Postcondition)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioSpecialOrderCancelRequest(
    string Action,
    string RequestId,
    string TraceId,
    string ExecutionId,
    string CancellationToken,
    PortfolioScope Scope)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => PortfolioSpecialOrderActionProtocol.IsValidAction(Action)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(RequestId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(TraceId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(ExecutionId)
        && PortfolioSpecialOrderActionProtocol.IsOpaqueRuntimeValue(CancellationToken)
        && Scope is not null && Scope.IsValid
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioSpecialOrderAcceptContext(
    PortfolioSpecialOrderAcceptRequest Request,
    PortfolioScope Scope,
    PortfolioSpecialOrderDsmSelection Selection,
    PortfolioSpecialOrderFreshOfferObservation FreshOffer,
    string ExecutionId);

internal sealed record PortfolioSpecialOrderClaimContext(
    PortfolioSpecialOrderClaimRequest Request,
    PortfolioScope Scope,
    PortfolioSpecialOrderDsmSelection Selection,
    PortfolioSpecialOrderFreshRewardObservation FreshReward,
    string ExecutionId);

/// <summary>
/// Semantic adapter contract only. Implementations return typed facts and must
/// own their target-version integration; this boundary has no native invoker.
/// </summary>
internal interface IPortfolioSpecialOrderSemanticAdapter
{
    bool IsAvailable { get; }
    bool TryAcceptOffer(PortfolioSpecialOrderAcceptContext context, out PortfolioSpecialOrderAcceptanceObservation observation);
    bool TryClaimReward(PortfolioSpecialOrderClaimContext context, out PortfolioSpecialOrderRewardClaimObservation observation);
}
