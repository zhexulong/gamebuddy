namespace GameBuddy.Stardew;

/// <summary>
/// Guarded M3 coordinator. The source audit proves a normal-player ingress
/// followed by location dispatch, but does not prove a bridge-safe semantic
/// edge. Re-entering the broad normal-player location dispatcher here would
/// be unbounded, so this coordinator fails closed until the shared
/// integration supplies a target-version bounded semantic adapter.
/// </summary>
internal sealed class PortfolioForageActionCoordinator
{
    internal PortfolioForageActionReceipt Begin(
        PortfolioPickupForageRequest request,
        PortfolioForageFreshObservation observation)
    {
        string executionId = Guid.NewGuid().ToString("N");
        if (request is null || !request.IsValid)
            return Receipt("invalid", "invalid", executionId, "rejected", 0, "invalid_forage_request", InvalidScope(), null);
        if (observation is null || !HasMatchingFreshObservation(request, observation))
            return Receipt(request.RequestId, request.TraceId, executionId, "rejected", observation?.Revision ?? 0,
                GuardReason(request, observation), observation?.Scope ?? request.Scope, request.Target.TargetId);

        // Producer → consumer → verifier handoff: a future target-version
        // adapter must consume this exact target/scope/revision tuple and
        // produce correlated native delivery facts. The shared integration
        // must then consume requestId+traceId+executionId and a fresh reader
        // must verify target absence plus the exact inventory delta.
        return Receipt(request.RequestId, request.TraceId, executionId, "blocked", observation.Revision,
            "forage_source_semantic_edge_unestablished", observation.Scope, request.Target.TargetId);
    }

    private static bool HasMatchingFreshObservation(PortfolioPickupForageRequest request, PortfolioForageFreshObservation observation)
        => observation.Scope is not null && observation.Scope.Equals(request.Scope)
            && observation.Target is not null && request.Target is not null
            && observation.Target == request.Target
            && observation.Revision == request.ExpectedRevision
            && observation.Fresh && observation.WorldReady && observation.LocalPlayerMatches
            && observation.PolicyAllowed && observation.InRange && observation.InventoryCapacityAvailable
            && observation.SpawnedForagePresent
            && observation.Target.IsValid(request.ExpectedRevision)
            && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() < request.DeadlineMs;

    private static string GuardReason(PortfolioPickupForageRequest request, PortfolioForageFreshObservation? observation)
    {
        if (observation is null || observation.Scope is null || !observation.Scope.Equals(request.Scope)) return "portfolio_binding_invalid";
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= request.DeadlineMs) return "deadline_expired";
        if (observation.Revision != request.ExpectedRevision) return "revision_mismatch";
        if (!observation.WorldReady || !observation.LocalPlayerMatches) return "portfolio_world_not_ready";
        if (!observation.PolicyAllowed) return "portfolio_action_not_allowed";
        if (!observation.InRange) return "forage_target_out_of_range";
        if (!observation.InventoryCapacityAvailable) return "forage_inventory_capacity_unavailable";
        return "forage_observation_invalid";
    }

    private static PortfolioForageActionReceipt Receipt(string requestId, string traceId, string executionId,
        string state, long revision, string reasonCode, PortfolioScope scope, string? targetId)
    {
        PortfolioForagePhase[] phases =
        {
            new(requestId, traceId, executionId, "fresh_observed", revision, "fresh_observed"),
            new(requestId, traceId, executionId, "terminal", revision, reasonCode),
        };
        return new PortfolioForageActionReceipt(requestId, traceId, executionId, state, revision, reasonCode,
            phases, scope, targetId, false, 0);
    }

    private static PortfolioScope InvalidScope() => new(PortfolioBridgeProtocol.IntegrationId,
        PortfolioBridgeProtocol.Topology, "invalid", "invalid", "invalid", "invalid", 0, new string('0', 64));
}
