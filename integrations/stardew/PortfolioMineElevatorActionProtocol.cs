using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew;

internal sealed record PortfolioMineElevatorActionRequest(
    string Action,
    string RequestId,
    string TraceId,
    string IdempotencyKey,
    int SelectedCheckpoint,
    long ExpectedRevision,
    long DeadlineMs,
    string CancellationToken,
    PortfolioScope Scope)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Action == PortfolioBridgeProtocol.MineElevatorAction
        && Scope is not null && Scope.IsValid
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(IdempotencyKey)
        && PortfolioBridgeProtocol.IsToken(CancellationToken)
        && ExpectedRevision >= 0 && DeadlineMs > 0
        && PortfolioBridgeProtocol.IsMineElevatorCheckpoint(SelectedCheckpoint)
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioMineElevatorFreshFloorRequest(
    string Action,
    string RequestId,
    string TraceId,
    string ExecutionId,
    long ExpectedRevision,
    long DeadlineMs,
    string CancellationToken,
    PortfolioScope Scope)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Action == PortfolioBridgeProtocol.MineElevatorAction
        && Scope is not null && Scope.IsValid
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(ExecutionId)
        && PortfolioBridgeProtocol.IsToken(CancellationToken)
        && ExpectedRevision >= 0 && DeadlineMs > 0
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioMineElevatorFreshFloor(
    string RequestId,
    string TraceId,
    string ExecutionId,
    PortfolioScope Scope,
    long Revision,
    bool Fresh,
    int CurrentFloor,
    int LowestMineLevel)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioMineElevatorActionCancelRequest(
    string Action,
    string RequestId,
    string TraceId,
    string ExecutionId,
    string CancellationToken,
    PortfolioScope Scope)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Action == PortfolioBridgeProtocol.MineElevatorAction
        && Scope is not null && Scope.IsValid
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(ExecutionId)
        && PortfolioBridgeProtocol.IsToken(CancellationToken)
        && (ExtensionData is null || ExtensionData.Count == 0);
}

// This is a fact snapshot, not a route target supplied by the caller. The target
// is resolved afresh by the game-thread observation and remains opaque to the
// action surface.
internal sealed record PortfolioMineElevatorProbe(
    string RequestId,
    string TraceId,
    PortfolioScope Scope,
    long Revision,
    bool Fresh,
    bool EntryObserved,
    int CurrentFloor,
    int LowestMineLevel,
    bool TargetUnlocked,
    int SelectedCheckpoint)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioMineElevatorFreshObservation(
    string RequestId,
    string TraceId,
    long Revision,
    PortfolioScope Scope,
    bool Fresh,
    bool PlayerAvailable,
    bool WorldReady,
    bool PolicyAllowed,
    bool MineEntryObserved,
    int CurrentFloor,
    int LowestMineLevel,
    bool UnlockedLevelObserved,
    bool TargetUnlocked,
    string OpaqueElevatorTarget)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

}

internal sealed record PortfolioMineElevatorTransitionStartedObservation(
    string RequestId,
    string TraceId,
    string ExecutionId,
    long Revision,
    PortfolioScope Scope,
    bool Fresh,
    bool PlayerAvailable,
    bool WorldReady,
    bool PolicyAllowed,
    bool MineEntryObserved,
    bool NativeElevatorTransitionObserved,
    string OpaqueElevatorTarget,
    int SelectedCheckpoint)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

}

// Produced by the game-thread Player.Warped continuation only. This is a
// fresh current-world observation, not proof that a native save/reopen occurred.
internal sealed record PortfolioMineElevatorPostconditionObservation(
    string RequestId,
    string TraceId,
    string ExecutionId,
    long Revision,
    PortfolioScope Scope,
    bool Fresh,
    bool PlayerAvailable,
    bool WorldReady,
    bool PolicyAllowed,
    bool MineEntryObserved,
    int ActualCurrentFloor,
    int LowestMineLevel,
    bool LowestMineLevelObserved,
    string OpaqueElevatorTarget,
    int SelectedCheckpoint)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

}

internal sealed record PortfolioMineElevatorActionPhase(
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

// Evidence covers the typed elevator lifecycle through its fresh in-session
// postcondition only. Selecting an already unlocked elevator checkpoint does
// not claim to advance or persist mine progress; a distinct route action owns
// any persisted M8 milestone evidence.
internal sealed record PortfolioMineElevatorActionEvidence(
    PortfolioScope Scope,
    IReadOnlyList<PortfolioMineElevatorActionPhase> PhaseTrace,
    bool EntryObserved,
    int CurrentFloorBefore,
    int LowestMineLevelBefore,
    string? OpaqueElevatorTarget,
    bool NativeElevatorTransitionObserved,
    int CurrentFloorAfter,
    int LowestMineLevelAfter,
    bool LowestMineLevelObserved)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioMineElevatorActionPostcondition(
    int? SelectedCheckpoint,
    int ActualCurrentFloor,
    int ObservedLowestMineLevel,
    string? OpaqueElevatorTarget,
    bool FreshObservation,
    bool SameExecution)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioMineElevatorAdapterResult(
    string RequestId,
    string TraceId,
    string ExecutionId,
    PortfolioScope Scope,
    long Revision,
    string OpaqueElevatorTarget,
    int SelectedCheckpoint,
    bool TransitionArmed)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Scope is not null && Scope.IsValid
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(ExecutionId)
        && PortfolioBridgeProtocol.IsOpaqueId(OpaqueElevatorTarget)
        && !String.Equals(OpaqueElevatorTarget, "none", StringComparison.Ordinal)
        && Revision >= 0 && SelectedCheckpoint >= 0
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioMineElevatorActionReceipt(
    string RequestId,
    string TraceId,
    string ExecutionId,
    string State,
    long Revision,
    string ReasonCode,
    PortfolioMineElevatorActionEvidence Evidence,
    PortfolioMineElevatorActionPostcondition Postcondition)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsStructurallyTerminal => PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(ExecutionId)
        && State is "succeeded" or "blocked" or "failed" or "cancelled" or "expired" or "rejected" or "uncertain"
        && Evidence is not null && Evidence.PhaseTrace is not null && Evidence.PhaseTrace.Count > 0
        && Evidence.PhaseTrace[^1].Phase == "terminal"
        && Evidence.PhaseTrace[^1].ReasonCode != "execution_armed"
        && (Evidence.OpaqueElevatorTarget is null || IsOpaqueTarget(Evidence.OpaqueElevatorTarget))
        && Postcondition is not null
        && (Postcondition.SelectedCheckpoint is null || PortfolioBridgeProtocol.IsMineElevatorCheckpoint(Postcondition.SelectedCheckpoint.Value))
        && (Postcondition.OpaqueElevatorTarget is null || IsOpaqueTarget(Postcondition.OpaqueElevatorTarget))
        && (State != "succeeded" || Evidence.OpaqueElevatorTarget is not null
            && Postcondition.SelectedCheckpoint is not null && Postcondition.OpaqueElevatorTarget is not null
            && PortfolioBridgeProtocol.IsMineElevatorCheckpoint(Postcondition.SelectedCheckpoint.Value)
            && IsOpaqueTarget(Postcondition.OpaqueElevatorTarget))
        && PortfolioBridgeProtocol.IsReasonCode(ReasonCode)
        && PortfolioBridgeProtocol.IsMineElevatorTerminalReason(State, ReasonCode)
        && (ExtensionData is null || ExtensionData.Count == 0);

    private static bool IsOpaqueTarget(string value)
        => PortfolioBridgeProtocol.IsOpaqueId(value)
            && !String.Equals(value, "none", StringComparison.Ordinal);
}

internal sealed record PortfolioMineElevatorActionBeginResult(
    PortfolioMineElevatorActionPhase? Phase,
    PortfolioMineElevatorActionReceipt? Receipt)
{
    internal bool IsTerminal => Receipt is not null && Phase is null;
    internal bool IsAccepted => Phase is not null && Receipt is null;
}

internal sealed record PortfolioMineElevatorTerminalDelivery(
    string CorrelationId,
    PortfolioScope Scope,
    PortfolioMineElevatorActionReceipt Receipt);

/// <summary>Semantic boundary for a future target-version implementation.</summary>
internal sealed record PortfolioMineElevatorAdapterContext(
    string RequestId,
    string TraceId,
    string ExecutionId,
    string CancellationToken,
    PortfolioScope Scope,
    string OpaqueElevatorTarget,
    int SelectedCheckpoint,
    long ExpectedRevision,
    long DeadlineMs)
{
    internal bool IsValid => PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(ExecutionId)
        && PortfolioBridgeProtocol.IsToken(CancellationToken)
        && Scope is not null && Scope.IsValid
        && PortfolioBridgeProtocol.IsOpaqueId(OpaqueElevatorTarget)
        && !String.Equals(OpaqueElevatorTarget, "none", StringComparison.Ordinal)
        && SelectedCheckpoint >= 0 && ExpectedRevision >= 0 && DeadlineMs > 0;
}

/// <summary>
/// Semantic boundary for a future target-version implementation. The adapter
/// receives the complete immutable execution authority tuple; it may not infer
/// scope, trace, cancellation, target, or revision from ambient game state.
/// </summary>
internal interface IPortfolioMineElevatorSemanticAdapter
{
    bool IsAvailable { get; }

    bool RequestElevatorSelection(
        PortfolioMineElevatorAdapterContext context,
        out PortfolioMineElevatorAdapterResult? result);
}
