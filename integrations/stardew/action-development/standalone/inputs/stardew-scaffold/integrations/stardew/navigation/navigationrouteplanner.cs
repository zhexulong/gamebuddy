using GameBuddy.Stardew;

namespace GameBuddy.Stardew.Navigation;

/// <summary>
/// One source node's outgoing ordinary (non-door) warp legs. Nested inside the
/// topology only; never projected to a Host/Agent surface.
/// </summary>
internal sealed record NavigationOrdinaryWarpLegs(
    string SourceId,
    IReadOnlyList<NavigationTransitionLeg> OutgoingOrdinaryLegs);

/// <summary>
/// A private, deterministic ordinary-warp connectivity topology. It fixes the
/// current source identity plus the outgoing ordinary (non-door) legs for every
/// reachable source. It is a steel box for the planner; nothing about routes,
/// graph shape, intermediate identities or traversal state escapes it.
/// </summary>
internal sealed record NavigationOrdinaryWarpTopology(
    string CurrentSourceIdentity,
    IReadOnlyList<NavigationOrdinaryWarpLegs> Sources);

/// <summary>
/// The single exclusive planner outcome. It exposes exactly one private next
/// leg to arm, an arrived terminal, or a fail-closed terminal. No route, graph,
/// intermediate identity, traversal state, edge count, hop/replan count or quota
/// is ever projected.
/// </summary>
internal enum NavigationRoutePlanKind
{
    NextEdge,
    Arrived,
    Terminal,
}

internal sealed record NavigationRoutePlanResult(
    NavigationRoutePlanKind Kind,
    string ReasonCode,
    NavigationTransitionLeg? NextLeg = null)
{
    internal static NavigationRoutePlanResult NextEdge(NavigationTransitionLeg leg) =>
        new(NavigationRoutePlanKind.NextEdge, "accepted", leg);

    internal static NavigationRoutePlanResult Arrived() =>
        new(NavigationRoutePlanKind.Arrived, "navigation_completed");

    internal static NavigationRoutePlanResult Terminal(string reason) =>
        new(NavigationRoutePlanKind.Terminal, reason);
}

/// <summary>
/// Pure, deterministic breadth-first reachability planner over an
/// <see cref="NavigationOrdinaryWarpTopology"/>. It computes whether the bound
/// canonical destination is reachable from the current source and, if so, the
/// single next ordinary leg it may arm. It keeps only local visited/predecessor
/// state for one <c>Plan</c> call and fails closed (no route, no counts) on any
/// invalid or unreachable topology.
///
/// Private execution support: <see cref="AcceptedNavigationExecution"/> uses this
/// planner only to choose its next admitted ordinary leg. Its route topology,
/// graph shape, intermediate identities, and traversal state remain unprojected.
/// </summary>
internal sealed class NavigationRoutePlanner
{
    /// <summary>
    /// Plans one deterministic step from the topology's current source toward
    /// <paramref name="destination"/>. The supplied current source must match
    /// <paramref name="topology"/>.CurrentSourceIdentity. Invalid/duplicate
    /// source keys, door/empty/invalid edges and missing endpoints fail closed.
    /// </summary>
    internal NavigationRoutePlanResult Plan(
        NavigationOrdinaryWarpTopology topology,
        string currentSourceIdentity,
        NavigationDestinationBinding destination)
    {
        string destinationIdentity = destination.CanonicalDestinationIdentity;
        if (string.IsNullOrEmpty(destinationIdentity))
            return NavigationRoutePlanResult.Terminal("destination_identity_invalid");

        string topologySource = topology.CurrentSourceIdentity;
        if (string.IsNullOrEmpty(topologySource) || topologySource != currentSourceIdentity)
            return NavigationRoutePlanResult.Terminal("source_identity_mismatch");

        // Index sources and reject invalid/duplicate source keys fail closed.
        var sources = new Dictionary<string, NavigationOrdinaryWarpLegs>(StringComparer.Ordinal);
        foreach (NavigationOrdinaryWarpLegs source in topology.Sources)
        {
            if (string.IsNullOrEmpty(source.SourceId))
                return NavigationRoutePlanResult.Terminal("route_topology_invalid");
            if (!sources.TryAdd(source.SourceId, source))
                return NavigationRoutePlanResult.Terminal("route_topology_invalid");
        }

        if (!sources.ContainsKey(topologySource))
            return NavigationRoutePlanResult.Terminal("route_topology_invalid");

        // Ordinary doors and malformed edges are rejected, never silently
        // accepted. Missing endpoints fail closed before any traversal.
        foreach (NavigationOrdinaryWarpLegs source in topology.Sources)
        foreach (NavigationTransitionLeg leg in source.OutgoingOrdinaryLegs)
        {
            if (leg.IsDoor)
                return NavigationRoutePlanResult.Terminal("route_topology_invalid");
            if (string.IsNullOrEmpty(leg.TargetLocation))
                return NavigationRoutePlanResult.Terminal("route_topology_invalid");
            if (!sources.ContainsKey(leg.TargetLocation))
                return NavigationRoutePlanResult.Terminal("route_topology_invalid");
        }

        if (topologySource == destinationIdentity)
            return NavigationRoutePlanResult.Arrived();

        return Search(sources, topologySource, destinationIdentity);
    }

    private static NavigationRoutePlanResult Search(
        Dictionary<string, NavigationOrdinaryWarpLegs> sources,
        string sourceIdentity,
        string destinationIdentity)
    {
        var visited = new HashSet<string>(StringComparer.Ordinal)
        {
            sourceIdentity,
        };
        var predecessor = new Dictionary<string, (string From, NavigationTransitionLeg Leg)>(StringComparer.Ordinal);
        var queue = new Queue<string>();
        queue.Enqueue(sourceIdentity);

        while (queue.Count > 0)
        {
            string current = queue.Dequeue();
            NavigationOrdinaryWarpLegs node = sources[current];

            foreach (NavigationTransitionLeg leg in node.OutgoingOrdinaryLegs)
            {
                string target = leg.TargetLocation;
                if (!visited.Add(target))
                    continue;

                predecessor[target] = (current, leg);
                if (target == destinationIdentity)
                    return FirstEdgeFromSource(predecessor, sourceIdentity, destinationIdentity);

                queue.Enqueue(target);
            }
        }

        return NavigationRoutePlanResult.Terminal("destination_unreachable");
    }

    /// <summary>
    /// Walks the BFS predecessor chain back to the source and returns only the
    /// first ordinary leg on that path. No intermediate identity or hop count is
    /// exposed.
    /// </summary>
    private static NavigationRoutePlanResult FirstEdgeFromSource(
        Dictionary<string, (string From, NavigationTransitionLeg Leg)> predecessor,
        string sourceIdentity,
        string destinationIdentity)
    {
        string cursor = destinationIdentity;
        (string From, NavigationTransitionLeg Leg) entry = predecessor[cursor];
        while (entry.From != sourceIdentity)
        {
            cursor = entry.From;
            entry = predecessor[cursor];
        }

        return NavigationRoutePlanResult.NextEdge(entry.Leg);
    }
}