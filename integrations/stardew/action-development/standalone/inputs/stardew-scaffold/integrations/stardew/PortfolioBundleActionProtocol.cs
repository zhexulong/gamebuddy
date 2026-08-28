using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew;

/// <summary>Closed, typed Batch B1 bundle action vocabulary.</summary>
internal static class PortfolioBundleActionProtocol
{
    internal const string ContributeBundleSlotAction = "contribute_bundle_slot";
    internal const string ClaimBundleRewardAction = "claim_bundle_reward";
    internal const string FreeMutex = "free";
    internal const string ReleasedMutex = "released";
    internal const string OpenSlot = "open";
    internal const string ContributedSlot = "contributed";
    internal const string RewardUnavailable = "unavailable";
    internal const string RewardAvailable = "available";
    internal const string RewardClaimed = "claimed";
    internal static readonly string[] Actions = { ContributeBundleSlotAction, ClaimBundleRewardAction };

    internal static bool IsAction(string? value) => value is ContributeBundleSlotAction or ClaimBundleRewardAction;
    internal static bool IsState(string? value) => value is "succeeded" or "blocked" or "failed" or "cancelled" or "expired" or "rejected" or "uncertain";
    internal static bool IsOpaque(string? value) => PortfolioBridgeProtocol.IsOpaqueId(value) && !String.Equals(value, "none", StringComparison.Ordinal);
    internal static bool IsFiniteSelector(PortfolioBundleDsmSelector? value)
        => value is not null && IsOpaque(value.SelectorId) && IsOpaque(value.RewardId)
            && value.AcceptedItemIds is { Count: >= 1 and <= 256 }
            && value.AcceptedItemIds.All(IsOpaque)
            && value.AcceptedItemIds.Distinct(StringComparer.Ordinal).Count() == value.AcceptedItemIds.Count;
    internal static bool IsValidItem(PortfolioBundleItemSelection? value)
        => value is not null && IsOpaque(value.ItemIdentity) && value.Stack is >= 1 and <= 999 && value.Quality is >= 0 and <= 4;
    internal static bool IsFreshTarget(PortfolioBundleTarget? value, long revision)
        => value is not null && IsOpaque(value.TargetId) && IsOpaque(value.ObservationId) && value.ObservedRevision == revision;
    internal static bool IsKnownMutex(string? value) => value is FreeMutex or "held" or ReleasedMutex;
    internal static bool IsKnownSlot(string? value) => value is OpenSlot or ContributedSlot;
    internal static bool IsKnownReward(string? value) => value is RewardUnavailable or RewardAvailable or RewardClaimed;
}

internal sealed record PortfolioBundleDsmSelector(
    string SelectorId,
    IReadOnlyList<string> AcceptedItemIds,
    string RewardId)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => PortfolioBundleActionProtocol.IsFiniteSelector(this)
        && (ExtensionData is null || ExtensionData.Count == 0);
}

/// <summary>Target identity is supplied by a fresh semantic observation; it is never a caller-chosen coordinate.</summary>
internal sealed record PortfolioBundleTarget(string TargetId, string ObservationId, long ObservedRevision)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid(long revision) => PortfolioBundleActionProtocol.IsFreshTarget(this, revision)
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioBundleItemSelection(string ItemIdentity, int Stack, int Quality)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => PortfolioBundleActionProtocol.IsValidItem(this)
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioContributeBundleSlotRequest(
    string Action,
    string RequestId,
    string TraceId,
    string IdempotencyKey,
    long ExpectedRevision,
    long DeadlineMs,
    string CancellationToken,
    PortfolioBundleDsmSelector Selector,
    PortfolioBundleTarget Target,
    PortfolioBundleItemSelection Item,
    PortfolioScope Scope)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Action == PortfolioBundleActionProtocol.ContributeBundleSlotAction
        && Scope is not null && Scope.IsValid
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(IdempotencyKey)
        && ExpectedRevision >= 0 && DeadlineMs > 0
        && PortfolioBridgeProtocol.IsOpaqueId(CancellationToken)
        && Selector is not null && Selector.IsValid
        && Target is not null && Target.IsValid(ExpectedRevision)
        && Item is not null && Item.IsValid
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioClaimBundleRewardRequest(
    string Action,
    string RequestId,
    string TraceId,
    string IdempotencyKey,
    long ExpectedRevision,
    long DeadlineMs,
    string CancellationToken,
    PortfolioBundleDsmSelector Selector,
    PortfolioBundleTarget Target,
    string RewardId,
    PortfolioScope Scope)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Action == PortfolioBundleActionProtocol.ClaimBundleRewardAction
        && Scope is not null && Scope.IsValid
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(IdempotencyKey)
        && ExpectedRevision >= 0 && DeadlineMs > 0
        && PortfolioBridgeProtocol.IsOpaqueId(CancellationToken)
        && Selector is not null && Selector.IsValid
        && Target is not null && Target.IsValid(ExpectedRevision)
        && PortfolioBridgeActionRewardIsValid(this)
        && String.Equals(RewardId, Selector.RewardId, StringComparison.Ordinal)
        && (ExtensionData is null || ExtensionData.Count == 0);

    private static bool PortfolioBridgeActionRewardIsValid(PortfolioClaimBundleRewardRequest request)
        => PortfolioBundleActionProtocol.IsOpaque(request.RewardId);
}

internal sealed record PortfolioBundleCancelRequest(
    string Action,
    string RequestId,
    string TraceId,
    string ExecutionId,
    string CancellationToken,
    PortfolioScope Scope)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => PortfolioBundleActionProtocol.IsAction(Action)
        && Scope is not null && Scope.IsValid
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(ExecutionId)
        && PortfolioBridgeProtocol.IsOpaqueId(CancellationToken)
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioBundleExecutionContext(
    PortfolioScope Scope,
    long CurrentRevision,
    bool PlayerCurrent,
    bool WorldReady,
    bool SinglePlayer,
    bool PolicyAuthorized)
{
    internal bool IsValid => Scope is not null && Scope.IsValid && CurrentRevision >= 0 && PlayerCurrent && WorldReady && SinglePlayer && PolicyAuthorized;
}

internal sealed record PortfolioBundleSlotObservation(
    PortfolioBundleDsmSelector Selector,
    PortfolioBundleTarget Target,
    PortfolioBundleItemSelection Item,
    string MutexState,
    string SlotState,
    string RewardState,
    long Revision,
    PortfolioScope Scope)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
    internal bool IsValid(long expectedRevision, PortfolioScope expectedScope) => Scope is not null && expectedScope is not null && Scope.Equals(expectedScope)
        && Scope.IsValid && Selector is not null && Selector.IsValid
        && Target is not null && Target.IsValid(expectedRevision)
        && Item is not null && Item.IsValid
        && PortfolioBundleActionProtocol.IsKnownMutex(MutexState)
        && PortfolioBundleActionProtocol.IsKnownSlot(SlotState)
        && PortfolioBundleActionProtocol.IsKnownReward(RewardState)
        && Revision == expectedRevision
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioBundleRewardObservation(
    PortfolioBundleDsmSelector Selector,
    PortfolioBundleTarget Target,
    string RewardId,
    string MutexState,
    string SlotState,
    string RewardState,
    long Revision,
    PortfolioScope Scope)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
    internal bool IsValid(long expectedRevision, PortfolioScope expectedScope) => Scope is not null && expectedScope is not null && Scope.Equals(expectedScope)
        && Scope.IsValid && Selector is not null && Selector.IsValid
        && Target is not null && Target.IsValid(expectedRevision)
        && PortfolioBundleActionProtocol.IsOpaque(RewardId)
        && PortfolioBundleActionProtocol.IsKnownMutex(MutexState)
        && PortfolioBundleActionProtocol.IsKnownSlot(SlotState)
        && PortfolioBundleActionProtocol.IsKnownReward(RewardState)
        && Revision == expectedRevision
        && (ExtensionData is null || ExtensionData.Count == 0);
}

/// <summary>Semantic operation result. An adapter may observe native facts, but this type contains no native callback.</summary>
internal sealed record PortfolioBundleMutation(
    string RequestId,
    string TraceId,
    string ExecutionId,
    PortfolioScope Scope,
    string MutexBefore,
    string MutexAfter,
    string SlotBefore,
    string SlotAfter,
    string RewardBefore,
    string RewardAfter,
    bool ProgressChanged,
    bool RewardAvailabilityChanged,
    bool InventoryChanged,
    long Revision)
{
    internal bool FreshAfterObservation { get; init; }
    internal bool CancellationObserved { get; init; }
    internal bool DeadlineExpired { get; init; }
    internal string? SelectorIdBefore { get; init; }
    internal string? SelectorIdAfter { get; init; }
    internal string? TargetIdBefore { get; init; }
    internal string? TargetIdAfter { get; init; }
    internal string? ObservationIdBefore { get; init; }
    internal string? ObservationIdAfter { get; init; }
    internal string? ItemIdentityBefore { get; init; }
    internal string? ItemIdentityAfter { get; init; }
    internal int InventoryStackBefore { get; init; }
    internal int InventoryStackAfter { get; init; }
    internal string? RewardIdentityBefore { get; init; }
    internal string? RewardIdentityAfter { get; init; }
    internal int RewardInventoryStackBefore { get; init; }
    internal int RewardInventoryStackAfter { get; init; }

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(ExecutionId)
        && Scope is not null && Scope.IsValid
        && PortfolioBundleActionProtocol.IsKnownMutex(MutexBefore)
        && PortfolioBundleActionProtocol.IsKnownMutex(MutexAfter)
        && PortfolioBundleActionProtocol.IsKnownSlot(SlotBefore)
        && PortfolioBundleActionProtocol.IsKnownSlot(SlotAfter)
        && PortfolioBundleActionProtocol.IsKnownReward(RewardBefore)
        && PortfolioBundleActionProtocol.IsKnownReward(RewardAfter)
        && Revision >= 0
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioBundleContributionContext(
    string RequestId,
    string TraceId,
    string ExecutionId,
    PortfolioScope Scope,
    PortfolioBundleDsmSelector Selector,
    PortfolioBundleTarget Target,
    PortfolioBundleItemSelection Item,
    long DeadlineMs,
    string CancellationToken);

internal sealed record PortfolioBundleRewardClaimContext(
    string RequestId,
    string TraceId,
    string ExecutionId,
    PortfolioScope Scope,
    PortfolioBundleDsmSelector Selector,
    PortfolioBundleTarget Target,
    string RewardId,
    long DeadlineMs,
    string CancellationToken);

internal sealed record PortfolioBundleActionPhase(
    string RequestId,
    string TraceId,
    string ExecutionId,
    string Phase,
    long Revision,
    string ReasonCode);

internal sealed record PortfolioBundleEvidenceIdentity(
    string IntegrationId,
    string Topology,
    string SaveId,
    string WorldId,
    string LocalPlayerId,
    string CompanionId,
    long BindingGeneration,
    string BindingHash)
{
    internal static PortfolioBundleEvidenceIdentity FromScope(PortfolioScope scope) => new(
        scope.IntegrationId, scope.Topology, scope.SaveId, scope.WorldId,
        scope.LocalPlayerId, scope.CompanionId, scope.BindingGeneration, scope.BindingHash);
}

internal sealed record PortfolioBundleActionEvidence(
    PortfolioBundleEvidenceIdentity Identity,
    string Action,
    IReadOnlyList<PortfolioBundleActionPhase> PhaseTrace,
    PortfolioBundleTarget Target,
    string ItemIdentity,
    int Stack,
    int Quality,
    string RewardId,
    string RewardInventoryIdentity,
    int RewardInventoryStackBefore,
    int RewardInventoryStackAfter,
    string MutexBefore,
    string MutexAfter,
    string SlotBefore,
    string SlotAfter,
    string RewardBefore,
    string RewardAfter,
    bool ProgressChanged,
    bool RewardAvailabilityChanged,
    bool InventoryChanged);

internal sealed record PortfolioBundleActionPostcondition(
    long BeforeRevision,
    long AfterRevision,
    string Action,
    string TargetId,
    bool ProgressChanged,
    bool RewardAvailable,
    bool RewardClaimed,
    bool InventoryChanged);

internal sealed record PortfolioBundleActionReceipt(
    string RequestId,
    string TraceId,
    string ExecutionId,
    string Action,
    string State,
    long Revision,
    string ReasonCode,
    PortfolioBundleActionEvidence Evidence,
    PortfolioBundleActionPostcondition Postcondition);
