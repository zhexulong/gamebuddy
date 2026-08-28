using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew;

/// <summary>
/// M1's finite route composition vocabulary. This is deliberately not a
/// generic movement, warp, or native-dispatch surface. The source-bound route
/// remains blocked until its target-version transition partition and bridge
/// semantic edge are realized.
/// </summary>
internal static class PortfolioRouteActionProtocol
{
    internal const string Action = "m1_leave_and_return_route";
    internal const string SourceAuditId = "portfolio_m1_route_source_audit_v1";
    internal const string BlockedReason = "m1_route_source_projection_blocked";
    internal static readonly string[] RequiredComposition =
    {
        "move_to_tile", "travel", "enter_exit", "move_to_tile",
    };

    internal static bool IsOpaque(string? value) => PortfolioBridgeProtocol.IsOpaqueId(value)
        && !String.Equals(value, "none", StringComparison.Ordinal);

    internal static bool IsExactComposition(IReadOnlyList<string>? value)
        => value is not null && value.SequenceEqual(RequiredComposition, StringComparer.Ordinal);
}

/// <summary>
/// An opaque target is produced by a fresh game-thread route observation. It
/// is not a coordinate, location name, door, warp, or caller-selected native target.
/// </summary>
internal sealed record PortfolioRouteFreshCheckpoint(
    string ObservationId,
    string OpaqueCheckpoint,
    long Revision,
    PortfolioScope Scope,
    bool Fresh,
    bool PlayerAvailable,
    bool WorldReady,
    bool PolicyAllowed)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => PortfolioRouteActionProtocol.IsOpaque(ObservationId)
        && PortfolioRouteActionProtocol.IsOpaque(OpaqueCheckpoint)
        && Revision >= 0 && Scope is not null && Scope.IsValid
        && Fresh && PlayerAvailable && WorldReady && PolicyAllowed
        && (ExtensionData is null || ExtensionData.Count == 0);
}

/// <summary>
/// This typed coordination request can only name the frozen M1 composition;
/// it cannot select arbitrary movement, a warp, or a native member.
/// </summary>
internal sealed record PortfolioRouteActionRequest(
    string Action,
    string RequestId,
    string TraceId,
    string IdempotencyKey,
    long ExpectedRevision,
    long DeadlineMs,
    string CancellationToken,
    IReadOnlyList<string> Composition,
    PortfolioScope Scope)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Action == PortfolioRouteActionProtocol.Action
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(IdempotencyKey)
        && PortfolioBridgeProtocol.IsToken(CancellationToken)
        && ExpectedRevision >= 0 && DeadlineMs > 0
        && Scope is not null && Scope.IsValid
        && PortfolioRouteActionProtocol.IsExactComposition(Composition)
        && (ExtensionData is null || ExtensionData.Count == 0);
}

/// <summary>
/// A terminal blocked receipt: its producer is the source-audit verdict, its
/// consumer is the coordinator, and its verifier is the M1 preflight reader.
/// It is never evidence of native movement, travel, entry, exit, or arrival.
/// </summary>
internal sealed record PortfolioRouteActionReceipt(
    string RequestId,
    string TraceId,
    string ExecutionId,
    string State,
    long Revision,
    string ReasonCode,
    string SourceAuditId,
    string OpaqueCheckpoint)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsBlocked => State == "blocked"
        && ReasonCode == PortfolioRouteActionProtocol.BlockedReason
        && SourceAuditId == PortfolioRouteActionProtocol.SourceAuditId
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(ExecutionId)
        && PortfolioRouteActionProtocol.IsOpaque(OpaqueCheckpoint)
        && (ExtensionData is null || ExtensionData.Count == 0);
}
