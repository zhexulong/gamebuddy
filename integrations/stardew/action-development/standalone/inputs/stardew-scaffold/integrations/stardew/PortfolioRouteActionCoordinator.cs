namespace GameBuddy.Stardew;

/// <summary>
/// Fail-closed M1 route coordinator. The target-version source audit proves
/// that normal navigation may discover map/door/touch warps and enters a
/// pending native warp lifecycle, but it leaves the selected finite transition
/// partition and bridge-safe semantic edge unresolved. Therefore this class
/// produces only an exact blocker handoff and cannot invoke, route, integrate,
/// or simulate any native operation.
/// </summary>
internal sealed class PortfolioRouteActionCoordinator
{
    internal PortfolioRouteActionReceipt Begin(
        PortfolioRouteActionRequest request,
        PortfolioRouteFreshCheckpoint checkpoint)
    {
        string executionId = NewId();
        if (request is null || !request.IsValid)
            return Blocked(SafeId(request?.RequestId), SafeId(request?.TraceId), executionId, checkpoint?.Revision ?? 0,
                SafeCheckpoint(checkpoint));
        if (checkpoint is null || !checkpoint.IsValid || !request.Scope.Equals(checkpoint.Scope)
            || request.ExpectedRevision != checkpoint.Revision
            || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= request.DeadlineMs)
            return Blocked(request.RequestId, request.TraceId, executionId, checkpoint?.Revision ?? request.ExpectedRevision,
                SafeCheckpoint(checkpoint));

        // Producer: the audit's blocked projection state. Consumer: this
        // coordinator. Verifier: the static preflight checks the exact tuple.
        // No native semantic edge exists to consume a request safely.
        return Blocked(request.RequestId, request.TraceId, executionId, checkpoint.Revision, checkpoint.OpaqueCheckpoint);
    }

    private static PortfolioRouteActionReceipt Blocked(
        string requestId,
        string traceId,
        string executionId,
        long revision,
        string checkpoint)
        => new(requestId, traceId, executionId, "blocked", Math.Max(0, revision),
            PortfolioRouteActionProtocol.BlockedReason, PortfolioRouteActionProtocol.SourceAuditId, checkpoint);

    private static string SafeId(string? value) => PortfolioBridgeProtocol.IsOpaqueId(value) ? value! : "invalid";
    private static string SafeCheckpoint(PortfolioRouteFreshCheckpoint? checkpoint)
        => checkpoint is not null && PortfolioRouteActionProtocol.IsOpaque(checkpoint.OpaqueCheckpoint)
            ? checkpoint.OpaqueCheckpoint : "blocked_checkpoint";
    private static string NewId() => Guid.NewGuid().ToString("N");
}
