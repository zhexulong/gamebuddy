using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew;

internal static class PortfolioMuseumActionProtocol
{
    internal const string DonateAction = "donate_museum_item";
    internal const string ClaimRewardAction = "claim_museum_reward";
    internal const string PieceDomain = "portfolio_m10_museum_piece_domain_v1";
    internal const string RewardDomain = "portfolio_m10_museum_reward_domain_v1";
    internal const int MaximumDomainCount = 40;

    internal static bool IsAction(string? action) => action is DonateAction or ClaimRewardAction;

    internal static bool IsValidOpaqueTarget(PortfolioMuseumOpaqueTarget? target, string kind, long expectedRevision)
        => target is not null
            && target.Kind == kind
            && target.Source == "fresh_observation"
            && PortfolioBridgeProtocol.IsOpaqueId(target.Value)
            && PortfolioBridgeProtocol.IsOpaqueId(target.SelectorId)
            && PortfolioBridgeProtocol.IsOpaqueId(target.ObservationId)
            && target.ObservedRevision == expectedRevision
            && (target.ExtensionData is null || target.ExtensionData.Count == 0);

    internal static bool IsValidSelector(PortfolioMuseumSelector? selector, string domain)
        => selector is not null
            && selector.DomainId == domain
            && selector.MinCount == 1
            && selector.MaxCount == MaximumDomainCount
            && (selector.ExtensionData is null || selector.ExtensionData.Count == 0);
}

/// <summary>A target is an opaque value selected from a fresh native observation.
/// The coordinator never interprets it as a game object or invokes a native name.
/// </summary>
internal sealed record PortfolioMuseumOpaqueTarget(
    string Kind,
    string Source,
    string Value,
    string SelectorId,
    string ObservationId,
    long ObservedRevision)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioMuseumSelector(
    string DomainId,
    int MinCount,
    int MaxCount)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioMuseumDonationRequest(
    string Action,
    string RequestId,
    string TraceId,
    string IdempotencyKey,
    long ExpectedRevision,
    long DeadlineMs,
    string CancellationToken,
    PortfolioScope Scope,
    PortfolioMuseumOpaqueTarget Piece,
    PortfolioMuseumOpaqueTarget Placement,
    PortfolioMuseumSelector Selector,
    int ExactStack)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Action == PortfolioMuseumActionProtocol.DonateAction
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(IdempotencyKey)
        && ExpectedRevision >= 0 && DeadlineMs > 0
        && PortfolioBridgeProtocol.IsOpaqueId(CancellationToken)
        && Scope is not null && Scope.IsValid
        && PortfolioMuseumActionProtocol.IsValidOpaqueTarget(Piece, "opaque_runtime_museum_piece", ExpectedRevision)
        && PortfolioMuseumActionProtocol.IsValidOpaqueTarget(Placement, "opaque_runtime_museum_placement", ExpectedRevision)
        // The piece and placement are a single fresh transaction selection,
        // never independently replayable opaque values.
        && String.Equals(Piece.ObservationId, Placement.ObservationId, StringComparison.Ordinal)
        && String.Equals(Piece.SelectorId, Placement.SelectorId, StringComparison.Ordinal)
        && PortfolioMuseumActionProtocol.IsValidSelector(Selector, PortfolioMuseumActionProtocol.PieceDomain)
        && ExactStack == 1
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioMuseumRewardClaimRequest(
    string Action,
    string RequestId,
    string TraceId,
    string IdempotencyKey,
    long ExpectedRevision,
    long DeadlineMs,
    string CancellationToken,
    PortfolioScope Scope,
    PortfolioMuseumOpaqueTarget Reward,
    PortfolioMuseumSelector Selector)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Action == PortfolioMuseumActionProtocol.ClaimRewardAction
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(IdempotencyKey)
        && ExpectedRevision >= 0 && DeadlineMs > 0
        && PortfolioBridgeProtocol.IsOpaqueId(CancellationToken)
        && Scope is not null && Scope.IsValid
        && PortfolioMuseumActionProtocol.IsValidOpaqueTarget(Reward, "opaque_runtime_museum_reward", ExpectedRevision)
        && PortfolioMuseumActionProtocol.IsValidSelector(Selector, PortfolioMuseumActionProtocol.RewardDomain)
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioMuseumCancelRequest(
    string Action,
    string RequestId,
    string TraceId,
    string ExecutionId,
    string CancellationToken,
    PortfolioScope Scope)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => PortfolioMuseumActionProtocol.IsAction(Action)
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(ExecutionId)
        && PortfolioBridgeProtocol.IsOpaqueId(CancellationToken)
        && Scope is not null && Scope.IsValid
        && (ExtensionData is null || ExtensionData.Count == 0);
}

/// <summary>Facts re-read on the game thread before and after one transaction.</summary>
internal sealed record PortfolioMuseumRuntimeFacts(
    PortfolioScope Scope,
    long Revision,
    bool WorldReady,
    bool SinglePlayer,
    bool LocalPlayerMatches,
    bool ActionAuthorized,
    bool MutexAvailable,
    bool CancellationRequested,
    string InventoryItem,
    int InventoryStack,
    bool CollectionContainsPiece,
    string CollectionPiece,
    string CollectionPlacement,
    bool RewardEligible,
    bool RewardAlreadyClaimed,
    string RewardIdentity,
    int RewardDeliveryCount)
{
    internal bool IsUsable(PortfolioScope? expectedScope) => Scope is not null
        && expectedScope is not null
        && Scope.Equals(expectedScope)
        && Scope.IsValid
        && WorldReady
        && SinglePlayer
        && LocalPlayerMatches
        && ActionAuthorized
        && MutexAvailable
        && !CancellationRequested
        && Revision >= 0
        && PortfolioBridgeProtocol.IsOpaqueId(InventoryItem)
        && InventoryStack >= 0
        && RewardDeliveryCount >= 0
        && (ExtensionData is null || ExtensionData.Count == 0);

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioMuseumDonationContext(
    string RequestId,
    string TraceId,
    string ExecutionId,
    PortfolioScope Scope,
    PortfolioMuseumOpaqueTarget Piece,
    PortfolioMuseumOpaqueTarget Placement,
    int ExactStack,
    string CancellationToken,
    long DeadlineMs,
    PortfolioMuseumRuntimeFacts Before)
{
    internal bool IsValid => Before is not null
        && Scope is not null
        && PortfolioMuseumActionProtocol.IsValidOpaqueTarget(Piece, "opaque_runtime_museum_piece", Before.Revision)
        && PortfolioMuseumActionProtocol.IsValidOpaqueTarget(Placement, "opaque_runtime_museum_placement", Before.Revision)
        && ExactStack == 1
        && Before.IsUsable(Scope);
}

internal sealed record PortfolioMuseumRewardClaimContext(
    string RequestId,
    string TraceId,
    string ExecutionId,
    PortfolioScope Scope,
    PortfolioMuseumOpaqueTarget Reward,
    string CancellationToken,
    long DeadlineMs,
    PortfolioMuseumRuntimeFacts Before)
{
    internal bool IsValid => Before is not null
        && Scope is not null
        && PortfolioMuseumActionProtocol.IsValidOpaqueTarget(Reward, "opaque_runtime_museum_reward", Before.Revision)
        && Before.IsUsable(Scope);
}

/// <summary>Semantic result supplied by a target-version adapter. It contains
/// observations only; it is not a native call or a generic invoker.</summary>
internal sealed record PortfolioMuseumSemanticResult(
    string RequestId,
    string TraceId,
    string ExecutionId,
    PortfolioScope Scope,
    long ExpectedRevision,
    PortfolioMuseumOpaqueTarget Target,
    bool Committed,
    PortfolioMuseumRuntimeFacts After,
    bool FreshObservation,
    bool NativeDonationObserved,
    bool NativeRewardClaimObserved,
    bool PlacementCommitted,
    bool InventoryDeltaObserved,
    bool CollectionDeltaObserved,
    bool RewardEligibilityDeltaObserved,
    bool RewardDeliveryObserved,
    string ReasonCode)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    /// <summary>
    /// The adapter may assert this only when it has freshly re-observed the
    /// unchanged runtime and can prove that no native effect crossed the
    /// semantic boundary. It is deliberately not inferred from a false
    /// return value or an exception.
    /// </summary>
    internal bool SafeNoNativeEffectProof { get; init; }

    internal bool HasActionSpecificEvidence(bool donation) => Scope is not null && Scope.IsValid
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(ExecutionId)
        && Target is not null
        && Committed
        && FreshObservation
        && (donation
            ? NativeDonationObserved && PlacementCommitted && InventoryDeltaObserved && CollectionDeltaObserved
            : NativeRewardClaimObserved && RewardEligibilityDeltaObserved && RewardDeliveryObserved)
        && PortfolioBridgeProtocol.IsReasonCode(ReasonCode)
        && (ExtensionData is null || ExtensionData.Count == 0);

    internal bool HasSafeNoNativeEffectProof(PortfolioMuseumRuntimeFacts before)
        => SafeNoNativeEffectProof
            && !Committed
            && FreshObservation
            && !NativeDonationObserved
            && !NativeRewardClaimObserved
            && !PlacementCommitted
            && !InventoryDeltaObserved
            && !CollectionDeltaObserved
            && !RewardEligibilityDeltaObserved
            && !RewardDeliveryObserved
            && After is not null
            && After.Equals(before)
            && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioMuseumPhase(
    string Action,
    string RequestId,
    string TraceId,
    string ExecutionId,
    string Phase,
    long Revision,
    string ReasonCode)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioMuseumEvidence(
    string Action,
    PortfolioScope Scope,
    PortfolioMuseumOpaqueTarget Target,
    IReadOnlyList<PortfolioMuseumPhase> PhaseTrace,
    PortfolioMuseumRuntimeFacts Before,
    PortfolioMuseumRuntimeFacts After,
    bool MutexObserved,
    bool CollectionConditionObserved,
    bool RewardConditionObserved,
    bool FreshObservation,
    bool ActionSpecific)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioMuseumPostcondition(
    long BeforeRevision,
    long AfterRevision,
    string TargetIdentity,
    string PlacementIdentity,
    string InventoryItemBefore,
    string InventoryItemAfter,
    int ExactStack,
    int InventoryStackBefore,
    int InventoryStackAfter,
    bool CollectionChanged,
    bool RewardEligibilityConsumed,
    int RewardDeliveryDelta,
    bool FreshObservation)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioMuseumReceipt(
    string Action,
    string RequestId,
    string TraceId,
    string ExecutionId,
    string State,
    long Revision,
    string ReasonCode,
    PortfolioMuseumEvidence Evidence,
    PortfolioMuseumPostcondition Postcondition)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal interface IPortfolioMuseumSemanticAdapter
{
    bool IsAvailable { get; }
    bool TryDonateMuseumItem(PortfolioMuseumDonationContext context, out PortfolioMuseumSemanticResult result);
    bool TryClaimMuseumReward(PortfolioMuseumRewardClaimContext context, out PortfolioMuseumSemanticResult result);
}
