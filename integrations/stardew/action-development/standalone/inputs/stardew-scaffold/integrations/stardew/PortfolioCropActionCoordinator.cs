namespace GameBuddy.Stardew;

/// <summary>
/// M2's game-thread guard boundary. Source realization is currently blocked, so
/// accepted-shaped requests terminate fail-closed without a native invocation.
/// This class intentionally has no adapter, dispatcher, UI, reflection, or save/day path.
/// </summary>
internal sealed class PortfolioCropActionCoordinator
{
    private readonly object gate = new();
    private readonly Dictionary<string, ReplayEntry> completedByIdempotency = new(StringComparer.Ordinal);

    internal PortfolioCropActionReceipt BeginTill(PortfolioTillRequest request, long currentRevision) => Begin(request, request?.IsValid == true, currentRevision);
    internal PortfolioCropActionReceipt BeginPlant(PortfolioPlantRequest request, long currentRevision) => Begin(request, request?.IsValid == true, currentRevision);
    internal PortfolioCropActionReceipt BeginWater(PortfolioWaterRequest request, long currentRevision) => Begin(request, request?.IsValid == true, currentRevision);
    internal PortfolioCropActionReceipt BeginHarvest(PortfolioHarvestRequest request, long currentRevision) => Begin(request, request?.IsValid == true, currentRevision);

    private PortfolioCropActionReceipt Begin(PortfolioCropRequest? request, bool valid, long currentRevision)
    {
        lock (gate)
        {
            if (request is null) return Malformed(currentRevision);
            if (!valid) return Failure(request, NewExecutionId(), currentRevision, "invalid_request");
            if (completedByIdempotency.TryGetValue(request.IdempotencyKey, out ReplayEntry? replay))
                return replay.Matches(request) ? replay.Receipt : Failure(request, replay.Receipt.ExecutionId, currentRevision, "idempotency_key_reused_with_different_request");
            if (request.ExpectedRevision != currentRevision) return Remember(request, Failure(request, NewExecutionId(), currentRevision, "revision_mismatch"));
            if (request.DeadlineMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) return Remember(request, Failure(request, NewExecutionId(), currentRevision, "deadline_expired"));

            // Producer: the M2 audit's unverified target-version correlation.
            // Consumer: this game-thread guard. Verifier: the correlated terminal receipt.
            // No bridge-safe semantic edge may be inferred while source realization remains blocked.
            return Remember(request, Failure(request, NewExecutionId(), currentRevision, "source_realization_blocked"));
        }
    }

    private PortfolioCropActionReceipt Remember(PortfolioCropRequest request, PortfolioCropActionReceipt receipt)
    {
        completedByIdempotency[request.IdempotencyKey] = new ReplayEntry(request, receipt);
        return receipt;
    }

    private static PortfolioCropActionReceipt Failure(PortfolioCropRequest request, string executionId, long revision, string reason)
    {
        string? crop = request switch { PortfolioPlantRequest plant => plant.Crop.Value, PortfolioWaterRequest water => water.Crop.Value, PortfolioHarvestRequest harvest => harvest.Crop.Value, _ => null };
        PortfolioCropActionPhase[] phases = { new(request.RequestId, request.TraceId, executionId, "fresh_observed", revision, "fresh_observed"), new(request.RequestId, request.TraceId, executionId, "terminal", revision, reason) };
        return new(request.RequestId, request.TraceId, executionId, request.Action, "blocked", revision, reason,
            new(request.Scope, request.Action, request.Tile.Value, crop, phases, false, false));
    }

    private static PortfolioCropActionReceipt Malformed(long revision) => new("invalid", "invalid", NewExecutionId(), "invalid", "rejected", revision, "invalid_request",
        new(new(PortfolioBridgeProtocol.IntegrationId, PortfolioBridgeProtocol.Topology, "invalid", "invalid", "invalid", "invalid", 0, new string('0', 64)), "invalid", "invalid", null, Array.Empty<PortfolioCropActionPhase>(), false, false));
    private static string NewExecutionId() => Guid.NewGuid().ToString("N");

    private sealed record ReplayEntry(PortfolioCropRequest Request, PortfolioCropActionReceipt Receipt)
    {
        internal bool Matches(PortfolioCropRequest request) => Request == request;
    }
}
