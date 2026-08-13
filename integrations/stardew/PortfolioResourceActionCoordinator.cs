namespace GameBuddy.Stardew;

/// <summary>
/// M4's fail-closed typed coordinator. The focused source audit proves a normal
/// tool/router → ResourceClump health/destroy → Debris lifecycle, but marks the
/// target-version source realization, signed source class, and safe semantic
/// ingress unresolved. Therefore this coordinator produces only a correlated
/// blocked handoff; it never calls a native member, dispatcher, UI, or pickup.
/// </summary>
internal sealed class PortfolioResourceActionCoordinator
{
    internal PortfolioBreakRockSourceReceipt Begin(
        PortfolioBreakRockSourceRequest request,
        PortfolioBreakRockSourceGiven given)
    {
        string requestId = request is not null && PortfolioResourceActionProtocol.IsOpaque(request.RequestId) ? request.RequestId : "invalid";
        string traceId = request is not null && PortfolioResourceActionProtocol.IsOpaque(request.TraceId) ? request.TraceId : "invalid";
        long revision = given?.Revision ?? 0;
        string executionId = Guid.NewGuid().ToString("N");

        // The receipt consumer must preserve this request/trace/execution tuple
        // when target-version realization provides the fresh-debris verifier.
        return new PortfolioBreakRockSourceReceipt(
            requestId,
            traceId,
            executionId,
            "blocked",
            revision,
            PortfolioResourceActionProtocol.SourceRealizationBlocked,
            new[]
            {
                new PortfolioBreakRockSourcePhase("fresh_observed", revision, "fresh_observed"),
                new PortfolioBreakRockSourcePhase("terminal", revision, PortfolioResourceActionProtocol.SourceRealizationBlocked),
            });
    }

    /// <summary>
    /// Consumer/verifier predicate for the future source-transform handoff.
    /// It rejects static, stale, empty, substituted, or pickup-implying facts.
    /// </summary>
    internal static bool HasExactFreshDebrisCorrelation(
        PortfolioBreakRockSourceRequest request,
        PortfolioBreakRockSourceReceipt receipt,
        PortfolioBreakRockFreshDebris debris)
        => request is not null && request.IsValid
            && receipt is not null && PortfolioResourceActionProtocol.IsOpaque(receipt.ExecutionId)
            && debris is not null && debris.IsValid
            && receipt.RequestId == request.RequestId && receipt.TraceId == request.TraceId
            && debris.RequestId == request.RequestId && debris.TraceId == request.TraceId
            && debris.ExecutionId == receipt.ExecutionId && debris.SourceId == request.SourceId
            && debris.Scope.Equals(request.Scope) && debris.SourceDestroyedRevision == receipt.Revision;
}
