using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew;

internal sealed record PortfolioMineLadderActionRequest(
    string Action,
    string RequestId,
    string TraceId,
    string IdempotencyKey,
    long ExpectedRevision,
    long DeadlineMs,
    string CancellationToken,
    PortfolioScope Scope)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Action == PortfolioBridgeProtocol.MineLadderAction
        && Scope is not null && Scope.IsValid
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(IdempotencyKey)
        && PortfolioBridgeProtocol.IsToken(CancellationToken)
        && ExpectedRevision >= 0 && DeadlineMs > 0
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioMineLadderFreshFloorRequest(
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

    internal bool IsValid => Action == PortfolioBridgeProtocol.MineLadderAction
        && Scope is not null && Scope.IsValid
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(ExecutionId)
        && PortfolioBridgeProtocol.IsToken(CancellationToken)
        && ExpectedRevision >= 0 && DeadlineMs > 0
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioMineLadderFreshFloor(
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

internal sealed record PortfolioMineLadderActionCancelRequest(
    string Action,
    string RequestId,
    string TraceId,
    string ExecutionId,
    string CancellationToken,
    PortfolioScope Scope)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Action == PortfolioBridgeProtocol.MineLadderAction
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
internal sealed record PortfolioMineLadderProbe(
    string RequestId,
    string TraceId,
    PortfolioScope Scope,
    long Revision,
    bool Fresh,
    bool EntryObserved,
    int CurrentFloor,
    int LowestMineLevel,
    bool TargetUnlocked,
    bool LadderObserved,
    int TargetFloor)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioMineLadderFreshObservation(
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
    bool LadderObserved,
    string OpaqueLadderTarget,
    int TargetFloor)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

}

internal sealed record PortfolioMineLadderTransitionStartedObservation(
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
    bool NativeLadderTransitionObserved,
    string OpaqueLadderTarget,
    int TargetFloor)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

}

// Produced by the game-thread Player.Warped continuation only. This is a
// fresh current-world observation, not proof that a native save/reopen occurred.
internal sealed record PortfolioMineLadderPostconditionObservation(
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
    string OpaqueLadderTarget,
    int TargetFloor)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

}

internal sealed record PortfolioMineLadderActionPhase(
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

// Evidence covers the typed ladder lifecycle through its fresh in-session
// postcondition only. Selecting an already unlocked ladder checkpoint does
// not claim to advance or persist mine progress; a distinct route action owns
// any persisted M8 milestone evidence.
internal sealed record PortfolioMineLadderActionEvidence(
    PortfolioScope Scope,
    IReadOnlyList<PortfolioMineLadderActionPhase> PhaseTrace,
    bool EntryObserved,
    int CurrentFloorBefore,
    int LowestMineLevelBefore,
    string? OpaqueLadderTarget,
    bool NativeLadderTransitionObserved,
    int CurrentFloorAfter,
    int LowestMineLevelAfter,
    bool LowestMineLevelObserved)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioMineLadderActionPostcondition(
    int? TargetFloor,
    int ActualCurrentFloor,
    int ObservedLowestMineLevel,
    string? OpaqueLadderTarget,
    bool FreshObservation,
    bool SameExecution)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioMineLadderAdapterResult(
    string RequestId,
    string TraceId,
    string ExecutionId,
    PortfolioScope Scope,
    long Revision,
    string OpaqueLadderTarget,
    int TargetFloor,
    bool TransitionArmed)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Scope is not null && Scope.IsValid
        && TransitionArmed
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(ExecutionId)
        && PortfolioBridgeProtocol.IsOpaqueId(OpaqueLadderTarget)
        && !String.Equals(OpaqueLadderTarget, "none", StringComparison.Ordinal)
        && Revision >= 0 && TargetFloor >= 0
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioMineLadderActionReceipt(
    string RequestId,
    string TraceId,
    string ExecutionId,
    string State,
    long Revision,
    string ReasonCode,
    PortfolioMineLadderActionEvidence Evidence,
    PortfolioMineLadderActionPostcondition Postcondition)
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
        && PortfolioBridgeProtocol.IsMineLadderTerminalReason(State, ReasonCode)
        && (State != "succeeded" || IsSucceededStructurallyValid(Evidence, Postcondition))
        && (ExtensionData is null || ExtensionData.Count == 0);

    private bool IsEvidenceStructurallyValid(PortfolioMineLadderActionEvidence evidence)
    {
        if (evidence.Scope is null || !evidence.Scope.IsValid || evidence.PhaseTrace is null || evidence.PhaseTrace.Count < 2
            || evidence.CurrentFloorBefore < 0 || evidence.LowestMineLevelBefore < 0
            || evidence.CurrentFloorAfter < 0 || evidence.LowestMineLevelAfter < 0
            || (evidence.OpaqueLadderTarget is not null && !IsOpaqueTarget(evidence.OpaqueLadderTarget)))
            return false;
        int priorPhase = -1;
        long priorRevision = -1;
        foreach (PortfolioMineLadderActionPhase phase in evidence.PhaseTrace)
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
        PortfolioMineLadderActionPhase terminal = evidence.PhaseTrace[^1];
        return evidence.PhaseTrace[0].Phase == "fresh_observed" && terminal.Phase == "terminal"
            && terminal.Revision == Revision && terminal.ReasonCode == ReasonCode;
    }

    private static bool IsPostconditionStructurallyValid(PortfolioMineLadderActionPostcondition postcondition)
        => postcondition.ActualCurrentFloor >= 0 && postcondition.ObservedLowestMineLevel >= 0
            && (postcondition.TargetFloor is null || PortfolioBridgeProtocol.IsMineLadderCheckpoint(postcondition.TargetFloor.Value))
            && (postcondition.OpaqueLadderTarget is null || IsOpaqueTarget(postcondition.OpaqueLadderTarget));

    private static bool IsSucceededStructurallyValid(PortfolioMineLadderActionEvidence evidence,
        PortfolioMineLadderActionPostcondition postcondition)
        => evidence.OpaqueLadderTarget is not null && evidence.EntryObserved && evidence.NativeLadderTransitionObserved
            && evidence.LowestMineLevelObserved && postcondition.TargetFloor is not null
            && postcondition.OpaqueLadderTarget is not null && IsOpaqueTarget(postcondition.OpaqueLadderTarget)
            && postcondition.FreshObservation && postcondition.SameExecution
            && postcondition.ActualCurrentFloor == postcondition.TargetFloor
            && postcondition.ObservedLowestMineLevel >= postcondition.TargetFloor;

    private static bool IsOpaqueTarget(string value)
        => PortfolioBridgeProtocol.IsOpaqueId(value)
            && !String.Equals(value, "none", StringComparison.Ordinal);
}

internal sealed record PortfolioMineLadderActionBeginResult(
    PortfolioMineLadderActionPhase? Phase,
    PortfolioMineLadderActionReceipt? Receipt)
{
    internal bool IsTerminal => Receipt is not null && Phase is null;
    internal bool IsAccepted => Phase is not null && Receipt is null;
}

internal sealed record PortfolioMineLadderTerminalDelivery(
    string CorrelationId,
    PortfolioScope Scope,
    PortfolioMineLadderActionReceipt Receipt);

/// <summary>Semantic boundary for a future target-version implementation.</summary>
internal sealed record PortfolioMineLadderAdapterContext(
    string RequestId,
    string TraceId,
    string ExecutionId,
    string CancellationToken,
    PortfolioScope Scope,
    string OpaqueLadderTarget,
    int TargetFloor,
    long ExpectedRevision,
    long DeadlineMs)
{
    internal bool IsValid => PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(ExecutionId)
        && PortfolioBridgeProtocol.IsToken(CancellationToken)
        && Scope is not null && Scope.IsValid
        && PortfolioBridgeProtocol.IsOpaqueId(OpaqueLadderTarget)
        && !String.Equals(OpaqueLadderTarget, "none", StringComparison.Ordinal)
        && TargetFloor >= 0 && ExpectedRevision >= 0 && DeadlineMs > 0;
}

/// <summary>
/// Semantic boundary for a future target-version implementation. The adapter
/// receives the complete immutable execution authority tuple; it may not infer
/// scope, trace, cancellation, target, or revision from ambient game state.
/// </summary>
internal interface IPortfolioMineLadderSemanticAdapter
{
    bool IsAvailable { get; }

    bool RequestMineLadder(
        PortfolioMineLadderAdapterContext context,
        out PortfolioMineLadderAdapterResult? result);
}
