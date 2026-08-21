using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew;

internal sealed record PortfolioSkipEventActionRequest(
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

    internal bool IsValid => Action == PortfolioBridgeProtocol.SkipEventAction
        && Scope is not null && Scope.IsValid
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(IdempotencyKey)
        && PortfolioBridgeProtocol.IsToken(CancellationToken)
        && ExpectedRevision >= 0 && DeadlineMs > 0
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioSkipEventActionCancelRequest(
    string Action,
    string RequestId,
    string TraceId,
    string ExecutionId,
    string CancellationToken,
    PortfolioScope Scope)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Action == PortfolioBridgeProtocol.SkipEventAction
        && Scope is not null && Scope.IsValid
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(ExecutionId)
        && PortfolioBridgeProtocol.IsToken(CancellationToken)
        && (ExtensionData is null || ExtensionData.Count == 0);
}

// This is a fact snapshot, not a route target supplied by the caller. The
// observed native event identity is resolved afresh by the game-thread
// observation and remains opaque to the action surface.
internal sealed record PortfolioSkipEventProbe(
    string RequestId,
    string TraceId,
    PortfolioScope Scope,
    long Revision,
    bool Fresh,
    bool EventObserved,
    bool EventSkippable,
    string? OpaqueEventTarget)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioSkipEventFreshObservation(
    string RequestId,
    string TraceId,
    long Revision,
    PortfolioScope Scope,
    bool Fresh,
    bool PlayerAvailable,
    bool WorldReady,
    bool PolicyAllowed,
    bool EventObserved,
    bool EventSkippable,
    string? OpaqueEventTarget,
    string? NativeEventId)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioSkipEventNativeSkipObservation(
    string RequestId,
    string TraceId,
    string ExecutionId,
    long Revision,
    PortfolioScope Scope,
    bool Fresh,
    bool PlayerAvailable,
    bool WorldReady,
    bool PolicyAllowed,
    bool EventObserved,
    bool NativeSkipObserved,
    string? OpaqueEventTarget,
    string? NativeEventId)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

// Produced by a fresh game-thread reread after the native event end
// settled. This is a fresh current-world observation, not proof that a
// native save/reopen occurred.
internal sealed record PortfolioSkipEventPostconditionObservation(
    string RequestId,
    string TraceId,
    string ExecutionId,
    long Revision,
    PortfolioScope Scope,
    bool Fresh,
    bool PlayerAvailable,
    bool WorldReady,
    bool PolicyAllowed,
    bool EventCleared,
    bool PostEventStateClean,
    string? OpaqueEventTarget,
    string? NativeEventId)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioSkipEventActionPhase(
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

internal sealed record PortfolioSkipEventActionEvidence(
    PortfolioScope Scope,
    IReadOnlyList<PortfolioSkipEventActionPhase> PhaseTrace,
    bool EventObserved,
    bool EventSkippable,
    string? OpaqueEventTarget,
    string? NativeEventId,
    bool NativeSkipObserved,
    bool EventCleared,
    bool PostEventStateClean)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioSkipEventActionPostcondition(
    bool PostEventStateClean,
    bool FreshObservation,
    bool SameExecution)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }
}

internal sealed record PortfolioSkipEventAdapterResult(
    string RequestId,
    string TraceId,
    string ExecutionId,
    PortfolioScope Scope,
    long Revision,
    bool EventObserved,
    bool EventSkippable,
    string? OpaqueEventTarget,
    string? NativeEventId,
    bool NativeSkipIssued)
{
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid => Scope is not null && Scope.IsValid
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(ExecutionId)
        && Revision >= 0
        && (NativeSkipIssued || EventObserved)
        && (OpaqueEventTarget is null || PortfolioBridgeProtocol.IsOpaqueId(OpaqueEventTarget))
        && (NativeEventId is null || PortfolioBridgeProtocol.IsOpaqueId(NativeEventId))
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioSkipEventActionReceipt(
    string RequestId,
    string TraceId,
    string ExecutionId,
    string State,
    long Revision,
    string ReasonCode,
    PortfolioSkipEventActionEvidence Evidence,
    PortfolioSkipEventActionPostcondition Postcondition)
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
        && PortfolioBridgeProtocol.IsSkipEventTerminalReason(State, ReasonCode)
        && (State != "succeeded" || IsSucceededStructurallyValid(Evidence, Postcondition))
        && (ExtensionData is null || ExtensionData.Count == 0);

    private bool IsEvidenceStructurallyValid(PortfolioSkipEventActionEvidence evidence)
    {
        if (evidence.Scope is null || !evidence.Scope.IsValid || evidence.PhaseTrace is null || evidence.PhaseTrace.Count < 2
            || (evidence.OpaqueEventTarget is not null && !IsOpaqueEvent(evidence.OpaqueEventTarget))
            || (evidence.NativeEventId is not null && !PortfolioBridgeProtocol.IsOpaqueId(evidence.NativeEventId)))
            return false;
        int priorPhase = -1;
        long priorRevision = -1;
        foreach (PortfolioSkipEventActionPhase phase in evidence.PhaseTrace)
        {
            int index = Array.IndexOf(new[] { "fresh_observed", "accepted", "native_skip", "postcondition", "terminal" }, phase.Phase);
            if (index <= priorPhase || phase.Revision < priorRevision || !PortfolioBridgeProtocol.IsOpaqueId(phase.RequestId)
                || !PortfolioBridgeProtocol.IsOpaqueId(phase.TraceId) || !PortfolioBridgeProtocol.IsOpaqueId(phase.ExecutionId)
                || !PortfolioBridgeProtocol.IsReasonCode(phase.ReasonCode)
                || phase.RequestId != RequestId || phase.TraceId != TraceId || phase.ExecutionId != ExecutionId)
                return false;
            priorPhase = index;
            priorRevision = phase.Revision;
        }
        PortfolioSkipEventActionPhase terminal = evidence.PhaseTrace[^1];
        return evidence.PhaseTrace[0].Phase == "fresh_observed" && terminal.Phase == "terminal"
            && terminal.Revision == Revision && terminal.ReasonCode == ReasonCode;
    }

    private static bool IsPostconditionStructurallyValid(PortfolioSkipEventActionPostcondition postcondition)
        => postcondition is not null;

    private static bool IsSucceededStructurallyValid(PortfolioSkipEventActionEvidence evidence,
        PortfolioSkipEventActionPostcondition postcondition)
        => evidence.EventObserved && evidence.NativeSkipObserved
            && evidence.EventCleared && evidence.PostEventStateClean
            && (postcondition.PostEventStateClean == false || postcondition.PostEventStateClean)
            && postcondition.FreshObservation && postcondition.SameExecution
            && (evidence.OpaqueEventTarget is not null || evidence.NativeEventId is not null);

    private static bool IsOpaqueEvent(string value)
        => PortfolioBridgeProtocol.IsOpaqueId(value)
            && !String.Equals(value, "none", StringComparison.Ordinal);
}

internal sealed record PortfolioSkipEventActionBeginResult(
    PortfolioSkipEventActionPhase? Phase,
    PortfolioSkipEventActionReceipt? Receipt)
{
    internal bool IsTerminal => Receipt is not null && Phase is null;
    internal bool IsAccepted => Phase is not null && Receipt is null;
}

internal sealed record PortfolioSkipEventTerminalDelivery(
    string CorrelationId,
    PortfolioScope Scope,
    PortfolioSkipEventActionReceipt Receipt);

/// <summary>Semantic boundary for the target-version skip_event implementation.</summary>
internal sealed record PortfolioSkipEventAdapterContext(
    string RequestId,
    string TraceId,
    string ExecutionId,
    string CancellationToken,
    PortfolioScope Scope,
    string? OpaqueEventTarget,
    string? NativeEventId,
    long ExpectedRevision,
    long DeadlineMs)
{
    internal bool IsValid => PortfolioBridgeProtocol.IsOpaqueId(RequestId)
        && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(ExecutionId)
        && PortfolioBridgeProtocol.IsToken(CancellationToken)
        && Scope is not null && Scope.IsValid
        && (OpaqueEventTarget is null || PortfolioBridgeProtocol.IsOpaqueId(OpaqueEventTarget))
        && (NativeEventId is null || PortfolioBridgeProtocol.IsOpaqueId(NativeEventId))
        && ExpectedRevision >= 0 && DeadlineMs > 0;
}

/// <summary>
/// Semantic boundary for the target-version implementation. The adapter
/// receives the complete immutable execution authority tuple; it may not infer
/// scope, trace, cancellation, or revision from ambient game state.
/// </summary>
internal interface IPortfolioSkipEventSemanticAdapter
{
    bool IsAvailable { get; }

    bool RequestSkipEvent(
        PortfolioSkipEventAdapterContext context,
        out PortfolioSkipEventAdapterResult? result);
}

/// <summary>Fresh-observation boundary consumed by the bridge session.</summary>
internal interface IPortfolioSkipEventObservationAdapter : IPortfolioSkipEventSemanticAdapter
{
    PortfolioSkipEventFreshObservation CreateFreshObservation(
        PortfolioSkipEventActionRequest request,
        PortfolioScope scope,
        long revision);
}