using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew;

/// <summary>
/// M3's deliberately narrow spawned-forage vocabulary. Debris is a separate
/// automatic collection lifecycle and must use <c>pickup_item</c>, never this
/// request. This protocol is not a native ingress authorization.
/// </summary>
internal static class PortfolioForageActionProtocol
{
    internal const string Action = "pickup_forage";
    internal const string SpawnedForageTargetKind = "spawned_forage_object";
    internal const string FreshObservationSource = "fresh_native_observation";

    internal static bool IsOpaque(string? value) => PortfolioBridgeProtocol.IsOpaqueId(value)
        && !String.Equals(value, "none", StringComparison.Ordinal);
}

/// <summary>Opaque target selected from one fresh scoped native observation.</summary>
internal sealed record PortfolioForageTarget(
    string TargetId,
    string SelectorId,
    string ObservationId,
    string Kind,
    string Source,
    long ObservedRevision)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid(long revision) => PortfolioForageActionProtocol.IsOpaque(TargetId)
        && PortfolioForageActionProtocol.IsOpaque(SelectorId)
        && PortfolioForageActionProtocol.IsOpaque(ObservationId)
        && Kind == PortfolioForageActionProtocol.SpawnedForageTargetKind
        && Source == PortfolioForageActionProtocol.FreshObservationSource
        && ObservedRevision == revision
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioPickupForageRequest(
    string Action,
    string RequestId,
    string TraceId,
    string IdempotencyKey,
    long ExpectedRevision,
    long DeadlineMs,
    string CancellationToken,
    PortfolioScope Scope,
    PortfolioForageTarget Target)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Action == PortfolioForageActionProtocol.Action
        && PortfolioForageActionProtocol.IsOpaque(RequestId)
        && PortfolioForageActionProtocol.IsOpaque(TraceId)
        && PortfolioForageActionProtocol.IsOpaque(IdempotencyKey)
        && PortfolioForageActionProtocol.IsOpaque(CancellationToken)
        && Scope is not null && Scope.IsValid
        && ExpectedRevision >= 0 && DeadlineMs > 0
        && Target is not null && Target.IsValid(ExpectedRevision)
        && (ExtensionData is null || ExtensionData.Count == 0);
}

/// <summary>Fresh game-thread facts required before a future semantic edge.</summary>
internal sealed record PortfolioForageFreshObservation(
    string RequestId,
    string TraceId,
    PortfolioScope Scope,
    long Revision,
    bool Fresh,
    bool WorldReady,
    bool LocalPlayerMatches,
    bool PolicyAllowed,
    bool InRange,
    bool InventoryCapacityAvailable,
    bool SpawnedForagePresent,
    PortfolioForageTarget Target)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioForagePhase(
    string RequestId,
    string TraceId,
    string ExecutionId,
    string Phase,
    long Revision,
    string ReasonCode);

/// <summary>
/// A blocked receipt is the only currently truthful terminal producer. A
/// succeeded receipt requires a target-version semantic edge plus a fresh
/// target-removal and exact local-inventory-delta reader.
/// </summary>
internal sealed record PortfolioForageActionReceipt(
    string RequestId,
    string TraceId,
    string ExecutionId,
    string State,
    long Revision,
    string ReasonCode,
    IReadOnlyList<PortfolioForagePhase> PhaseTrace,
    PortfolioScope Scope,
    string? TargetId,
    bool TargetRemovedObserved,
    int InventoryDelta)
{
    internal bool IsBlockedSourceEdge => State == "blocked"
        && ReasonCode == "forage_source_semantic_edge_unestablished"
        && TargetRemovedObserved == false && InventoryDelta == 0;
}
