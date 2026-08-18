using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew;

/// <summary>
/// Closed vocabulary for the M4 source-only primitive. It deliberately has no
/// Debris pickup or inventory-delivery operation: those are separate actions.
/// </summary>
internal static class PortfolioResourceActionProtocol
{
    internal const string BreakRockSourceAction = "break_rock_source";
    internal const string SourceRealizationBlocked = "resource_source_realization_blocked";

    internal static bool IsOpaque(string? value)
        => !String.IsNullOrWhiteSpace(value) && value.Length <= 128
            && value.All(character => (character >= 'A' && character <= 'Z')
                || (character >= 'a' && character <= 'z')
                || (character >= '0' && character <= '9')
                || character is '_' or '-');
}

internal sealed record PortfolioBreakRockSourceRequest(
    string Action,
    string RequestId,
    string TraceId,
    string IdempotencyKey,
    string SourceId,
    long ExpectedRevision,
    long DeadlineMs,
    string CancellationToken,
    PortfolioScope Scope)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Action == PortfolioResourceActionProtocol.BreakRockSourceAction
        && PortfolioResourceActionProtocol.IsOpaque(RequestId)
        && PortfolioResourceActionProtocol.IsOpaque(TraceId)
        && PortfolioResourceActionProtocol.IsOpaque(IdempotencyKey)
        && PortfolioResourceActionProtocol.IsOpaque(SourceId)
        && PortfolioResourceActionProtocol.IsOpaque(CancellationToken)
        && ExpectedRevision >= 0 && DeadlineMs > 0
        && Scope is not null && Scope.IsValid
        && (ExtensionData is null || ExtensionData.Count == 0);
}

/// <summary>Fresh, read-only source observation consumed by the typed request.</summary>
internal sealed record PortfolioBreakRockSourceGiven(
    string SourceId,
    long Revision,
    PortfolioScope Scope,
    bool Fresh,
    bool PlayerAvailable,
    bool WorldReady,
    bool PolicyAllowed,
    bool SourcePresent,
    bool SourceIdentityObserved,
    int SourceHealth,
    bool EligiblePickaxeEquipped,
    bool ToolEligible)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => PortfolioResourceActionProtocol.IsOpaque(SourceId)
        && Revision >= 0 && Scope is not null && Scope.IsValid && Fresh
        && PlayerAvailable && WorldReady && PolicyAllowed && SourcePresent
        && SourceIdentityObserved && SourceHealth > 0 && EligiblePickaxeEquipped && ToolEligible
        && (ExtensionData is null || ExtensionData.Count == 0);
}

/// <summary>
/// Required future successor of a source-transform receipt. Its Debris IDs must
/// be freshly observed and correlated to this source/execution; it never proves
/// pickup or inventory delivery.
/// </summary>
internal sealed record PortfolioBreakRockFreshDebris(
    string RequestId,
    string TraceId,
    string ExecutionId,
    string SourceId,
    long SourceDestroyedRevision,
    long Revision,
    PortfolioScope Scope,
    bool Fresh,
    bool SourceAbsent,
    IReadOnlyList<string> DebrisIds)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => PortfolioResourceActionProtocol.IsOpaque(RequestId)
        && PortfolioResourceActionProtocol.IsOpaque(TraceId)
        && PortfolioResourceActionProtocol.IsOpaque(ExecutionId)
        && PortfolioResourceActionProtocol.IsOpaque(SourceId)
        && Scope is not null && Scope.IsValid && Fresh && SourceAbsent
        && SourceDestroyedRevision >= 0 && Revision > SourceDestroyedRevision
        && DebrisIds is { Count: > 0 } && DebrisIds.All(PortfolioResourceActionProtocol.IsOpaque)
        && DebrisIds.Distinct(StringComparer.Ordinal).Count() == DebrisIds.Count
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioBreakRockSourcePhase(string Phase, long Revision, string ReasonCode);

internal sealed record PortfolioBreakRockSourceReceipt(
    string RequestId,
    string TraceId,
    string ExecutionId,
    string State,
    long Revision,
    string ReasonCode,
    IReadOnlyList<PortfolioBreakRockSourcePhase> PhaseTrace)
{
    internal bool IsTerminal => State == "blocked" && ReasonCode == PortfolioResourceActionProtocol.SourceRealizationBlocked
        && PhaseTrace.Count == 2 && PhaseTrace[0].Phase == "fresh_observed" && PhaseTrace[1].Phase == "terminal";
}
