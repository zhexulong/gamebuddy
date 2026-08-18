using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew;

internal sealed record PortfolioSleepDayRequest(
    string Action,
    string RequestId,
    string TraceId,
    string IdempotencyKey,
    long ExpectedRevision,
    long DeadlineMs,
    string CancellationToken)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioSleepDayCancelRequest(
    string Action,
    string RequestId,
    string TraceId,
    string ExecutionId,
    string CancellationToken)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioSleepDayPhase(
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

internal sealed record PortfolioSleepDayEvidenceIdentity(
    string IntegrationId,
    string Topology,
    string SaveId,
    string WorldId,
    string LocalPlayerId,
    string CompanionId,
    long BindingGeneration,
    string BindingHash)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => IntegrationId == PortfolioBridgeProtocol.IntegrationId
        && Topology == PortfolioBridgeProtocol.Topology
        && PortfolioBridgeProtocol.IsOpaqueId(SaveId)
        && PortfolioBridgeProtocol.IsOpaqueId(WorldId)
        && PortfolioBridgeProtocol.IsOpaqueId(LocalPlayerId)
        && PortfolioBridgeProtocol.IsOpaqueId(CompanionId)
        && BindingGeneration > 0
        && PortfolioBridgeProtocol.IsSha256(BindingHash)
        && (ExtensionData is null || ExtensionData.Count == 0);

    internal static PortfolioSleepDayEvidenceIdentity FromScope(PortfolioScope scope) => new(
        scope.IntegrationId, scope.Topology, scope.SaveId, scope.WorldId,
        scope.LocalPlayerId, scope.CompanionId, scope.BindingGeneration, scope.BindingHash);
}

internal sealed record PortfolioSleepDayEvidence(
    PortfolioSleepDayEvidenceIdentity Identity,
    IReadOnlyList<PortfolioSleepDayPhase> PhaseTrace,
    string IrreversiblePhase,
    bool NativeSleepObserved,
    bool SavingObserved,
    bool SavedObserved,
    bool DayStartedObserved,
    string NewDayIdentity,
    bool CloseObserved,
    bool ReopenObserved)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioSleepDayPostcondition(
    long BeforeRevision,
    long AfterRevision,
    bool DayAdvanced,
    bool FreshDayStarted,
    bool Reopened,
    string NewDayIdentity)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioSleepDayReceipt(
    string RequestId,
    string TraceId,
    string ExecutionId,
    string State,
    long Revision,
    string ReasonCode,
    PortfolioSleepDayEvidence Evidence,
    PortfolioSleepDayPostcondition Postcondition)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

// Typed native observations intentionally carry facts, rather than a phase name or callback.
internal sealed record PortfolioSleepDayNativeSleepStartedObservation(string RequestId, string TraceId, string ExecutionId, long Revision, PortfolioScope Scope, bool NativeSleepObserved);
internal sealed record PortfolioSleepDaySavingObservation(string RequestId, string TraceId, string ExecutionId, long Revision, PortfolioScope Scope, bool SavingObserved);
internal sealed record PortfolioSleepDaySavedObservation(string RequestId, string TraceId, string ExecutionId, long Revision, PortfolioScope Scope, bool SavedObserved);
internal sealed record PortfolioSleepDayDayStartedObservation(string RequestId, string TraceId, string ExecutionId, long Revision, PortfolioScope Scope, bool DayStartedObserved, string NewDayIdentity);
internal sealed record PortfolioSleepDayCloseRequestedObservation(string RequestId, string TraceId, string ExecutionId, long Revision, PortfolioScope Scope, bool CloseObserved);
internal sealed record PortfolioSleepDayReopenedObservation(string RequestId, string TraceId, string ExecutionId, long Revision, PortfolioScope RefreshedScope, bool ReopenObserved, string NewDayIdentity);
