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
    bool ElevatorInteractionAvailable,
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
    bool ElevatorInteractionAvailable,
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
        && Evidence is not null && IsEvidenceStructurallyValid(Evidence)
        && Postcondition is not null && IsPostconditionStructurallyValid(Postcondition)
        && PortfolioBridgeProtocol.IsReasonCode(ReasonCode)
        && PortfolioBridgeProtocol.IsMineElevatorTerminalReason(State, ReasonCode)
        && (State != "succeeded" || IsSucceededStructurallyValid(Evidence, Postcondition))
        && (ExtensionData is null || ExtensionData.Count == 0);

    private bool IsEvidenceStructurallyValid(PortfolioMineElevatorActionEvidence evidence)
    {
        if (evidence.Scope is null || !evidence.Scope.IsValid || evidence.PhaseTrace is null || evidence.PhaseTrace.Count < 2
            || evidence.CurrentFloorBefore < 0 || evidence.LowestMineLevelBefore < 0
            || evidence.CurrentFloorAfter < 0 || evidence.LowestMineLevelAfter < 0
            || (evidence.OpaqueElevatorTarget is not null && !IsOpaqueTarget(evidence.OpaqueElevatorTarget)))
            return false;
        int priorPhase = -1;
        long priorRevision = -1;
        foreach (PortfolioMineElevatorActionPhase phase in evidence.PhaseTrace)
        {
            int index = Array.IndexOf(new[] { "fresh_observed", "accepted", "transition_started", "postcondition", "terminal" }, phase.Phase);
            if (index <= priorPhase || phase.Revision < priorRevision || !PortfolioBridgeProtocol.IsOpaqueId(phase.RequestId)
                || !PortfolioBridgeProtocol.IsOpaqueId(phase.TraceId) || !PortfolioBridgeProtocol.IsOpaqueId(phase.ExecutionId)
                || !PortfolioBridgeProtocol.IsReasonCode(phase.ReasonCode)
                || phase.RequestId != RequestId || phase.TraceId != TraceId || phase.ExecutionId != ExecutionId)
                return false;
            priorPhase = index;
            priorRevision = phase.Revision;
        }
        PortfolioMineElevatorActionPhase terminal = evidence.PhaseTrace[^1];
        return evidence.PhaseTrace[0].Phase == "fresh_observed" && terminal.Phase == "terminal"
            && terminal.Revision == Revision && terminal.ReasonCode == ReasonCode;
    }

    private static bool IsPostconditionStructurallyValid(PortfolioMineElevatorActionPostcondition postcondition)
        => postcondition.ActualCurrentFloor >= 0 && postcondition.ObservedLowestMineLevel >= 0
            && (postcondition.SelectedCheckpoint is null || PortfolioBridgeProtocol.IsMineElevatorCheckpoint(postcondition.SelectedCheckpoint.Value))
            && (postcondition.OpaqueElevatorTarget is null || IsOpaqueTarget(postcondition.OpaqueElevatorTarget));

    private static bool IsSucceededStructurallyValid(PortfolioMineElevatorActionEvidence evidence,
        PortfolioMineElevatorActionPostcondition postcondition)
        => evidence.OpaqueElevatorTarget is not null && evidence.EntryObserved && evidence.NativeElevatorTransitionObserved
            && evidence.LowestMineLevelObserved && postcondition.SelectedCheckpoint is not null
            && postcondition.OpaqueElevatorTarget is not null && IsOpaqueTarget(postcondition.OpaqueElevatorTarget)
            && postcondition.FreshObservation && postcondition.SameExecution
            && postcondition.ActualCurrentFloor == postcondition.SelectedCheckpoint
            && postcondition.ObservedLowestMineLevel >= postcondition.SelectedCheckpoint;

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
