using FluentAssertions;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class NavigationRoutePlannerTests
{
    private static readonly NavigationDestinationBinding Mine =
        new("stardew", "Mine", "generation_01", 1);

    [Fact]
    public void Plan_FarmToMineViaMountain_ReturnsFirstFarmToMountainEdgeOnly()
    {
        NavigationTransitionLeg expected = Leg("Mountain", 10, 10, 20, 20);
        NavigationOrdinaryWarpTopology topology = Topology("Farm",
            Source("Farm", Leg("Mountain", 10, 10, 20, 20)),
            Source("Mountain", Leg("Mine", 20, 20, 30, 30)),
            Source("Mine"));

        NavigationRoutePlanResult result = new NavigationRoutePlanner().Plan(topology, "Farm", Mine);

        result.Kind.Should().Be(NavigationRoutePlanKind.NextEdge);
        result.ReasonCode.Should().Be("accepted");
        result.NextLeg.Should().Be(expected);
    }

    [Fact]
    public void Plan_MountainToMine_ReturnsDirectEdge()
    {
        NavigationTransitionLeg edge = Leg("Mine", 20, 20, 30, 30);
        NavigationOrdinaryWarpTopology topology = Topology("Mountain",
            Source("Farm", Leg("Mountain", 10, 10, 20, 20)),
            Source("Mountain", edge),
            Source("Mine"));

        NavigationRoutePlanResult result = new NavigationRoutePlanner().Plan(topology, "Mountain", Mine);

        result.Kind.Should().Be(NavigationRoutePlanKind.NextEdge);
        result.ReasonCode.Should().Be("accepted");
        result.NextLeg.Should().Be(edge);
    }

    [Fact]
    public void Plan_AtDestination_ReturnsArrivedTerminalWithoutEdge()
    {
        NavigationOrdinaryWarpTopology topology = Topology("Mine",
            Source("Farm", Leg("Mountain", 10, 10, 20, 20)),
            Source("Mountain", Leg("Mine", 20, 20, 30, 30)),
            Source("Mine"));

        NavigationRoutePlanResult result = new NavigationRoutePlanner().Plan(topology, "Mine", Mine);

        result.Kind.Should().Be(NavigationRoutePlanKind.Arrived);
        result.ReasonCode.Should().Be("navigation_completed");
        result.NextLeg.Should().BeNull();
    }

    [Fact]
    public void Plan_UnreachableDestination_IsTerminalWithoutEdge()
    {
        NavigationOrdinaryWarpTopology topology = Topology("Farm",
            Source("Farm", Leg("Mountain", 10, 10, 20, 20)),
            Source("Mountain"),
            Source("Beach"));

        NavigationRoutePlanResult result = new NavigationRoutePlanner().Plan(topology, "Farm", Mine);

        result.Kind.Should().Be(NavigationRoutePlanKind.Terminal);
        result.ReasonCode.Should().Be("destination_unreachable");
        result.NextLeg.Should().BeNull();
    }

    [Fact]
    public void Plan_DuplicateSourceKeys_FailsClosedBeforeTraversal()
    {
        var duplicate = new NavigationOrdinaryWarpLegs("Farm", new List<NavigationTransitionLeg>
        {
            Leg("Mountain", 10, 10, 20, 20),
        });
        NavigationOrdinaryWarpTopology topology = new(
            "Farm",
            new[]
            {
                new NavigationOrdinaryWarpLegs("Farm", new List<NavigationTransitionLeg>
                {
                    Leg("Mountain", 1, 1, 2, 2),
                }),
                duplicate,
                Source("Mountain", Leg("Mine", 2, 2, 3, 3)),
                Source("Mine"),
            });

        NavigationRoutePlanResult result = new NavigationRoutePlanner().Plan(topology, "Farm", Mine);

        result.Kind.Should().Be(NavigationRoutePlanKind.Terminal);
        result.ReasonCode.Should().Be("route_topology_invalid");
        result.NextLeg.Should().BeNull();
    }

    [Fact]
    public void Plan_InvalidMissingEndpoint_FailClosedBeforeTraversal()
    {
        NavigationOrdinaryWarpTopology topology = Topology("Farm",
            Source("Farm", Leg("Unknown", 10, 10, 20, 20)),
            Source("Mountain", Leg("Mine", 2, 2, 3, 3)),
            Source("Mine"));

        NavigationRoutePlanResult result = new NavigationRoutePlanner().Plan(topology, "Farm", Mine);

        result.Kind.Should().Be(NavigationRoutePlanKind.Terminal);
        result.ReasonCode.Should().Be("route_topology_invalid");
        result.NextLeg.Should().BeNull();
    }

    [Fact]
    public void Plan_EmptyTargetEdge_FailsClosed()
    {
        NavigationOrdinaryWarpTopology topology = Topology("Farm",
            Source("Farm", new NavigationTransitionLeg("", 10, 10, 20, 20, IsDoor: false)),
            Source("Mountain", Leg("Mine", 2, 2, 3, 3)),
            Source("Mine"));

        NavigationRoutePlanResult result = new NavigationRoutePlanner().Plan(topology, "Farm", Mine);

        result.Kind.Should().Be(NavigationRoutePlanKind.Terminal);
        result.ReasonCode.Should().Be("route_topology_invalid");
        result.NextLeg.Should().BeNull();
    }

    [Fact]
    public void Plan_DoorEdge_IsRejectedNotSilentlyAccepted()
    {
        var door = new NavigationTransitionLeg("Mountain", 10, 10, 20, 20, IsDoor: true);
        NavigationOrdinaryWarpTopology topology = Topology("Farm",
            Source("Farm", door),
            Source("Mountain", Leg("Mine", 20, 20, 30, 30)),
            Source("Mine"));

        NavigationRoutePlanResult result = new NavigationRoutePlanner().Plan(topology, "Farm", Mine);

        result.Kind.Should().Be(NavigationRoutePlanKind.Terminal);
        result.ReasonCode.Should().Be("route_topology_invalid");
        result.NextLeg.Should().BeNull();
    }

    [Fact]
    public void Plan_CurrentSourceMismatch_FailsClosed()
    {
        NavigationOrdinaryWarpTopology topology = Topology("Mountain",
            Source("Farm", Leg("Mountain", 10, 10, 20, 20)),
            Source("Mountain", Leg("Mine", 20, 20, 30, 30)),
            Source("Mine"));

        NavigationRoutePlanResult result = new NavigationRoutePlanner().Plan(topology, "Farm", Mine);

        result.Kind.Should().Be(NavigationRoutePlanKind.Terminal);
        result.ReasonCode.Should().Be("source_identity_mismatch");
        result.NextLeg.Should().BeNull();
    }

    [Fact]
    public void Result_ExposesNoPublicRouteGraphOrTraversalState()
    {
        // The private result is a steel box for the planner: it may expose only
        // the exclusive kind, terminal reason, and one next edge. No route,
        // graph, intermediate identity, traversal state, edge/hop/replan count,
        // or quota may be observable.
        string[] exposed = typeof(NavigationRoutePlanResult).GetProperties()
            .Select(property => property.Name)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        exposed.Should().BeEquivalentTo(new[] { "Kind", "NextLeg", "NextVirtualLeg", "ReasonCode" });
    }

    [Fact]
    public void VirtualNextLeg_ExposesOnlyOneEdgeAndNativeGateFact_NotTraversalState()
    {
        // The virtual result may carry the one edge identity needed by the private
        // execution handoff: its transition, departure/transport identity, and
        // the native gate fact. It must not turn into a route or BFS dump.
        string[] virtualLegProperties = typeof(NavigationVirtualConnectivityLeg).GetProperties()
            .Select(property => property.Name)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        virtualLegProperties.Should().BeEquivalentTo(new[]
        {
            "DepartureLocation", "DestinationId", "Gate", "NetworkId", "TransportAction", "Transition",
        });
        virtualLegProperties.Should().NotContain(name =>
            name.Contains("Route", StringComparison.Ordinal)
            || name.Contains("Graph", StringComparison.Ordinal)
            || name.Contains("Visited", StringComparison.Ordinal)
            || name.Contains("Predecessor", StringComparison.Ordinal)
            || name.Contains("Count", StringComparison.Ordinal)
            || name.Contains("Hop", StringComparison.Ordinal)
            || name.Contains("Replan", StringComparison.Ordinal));

        typeof(NavigationConnectivityGate).GetProperties()
            .Select(property => property.Name)
            .Should().BeEquivalentTo(new[] { "IsSatisfied", "Key" });
    }

    private static NavigationTransitionLeg First = Leg("Mountain", 10, 10, 20, 20);
    private static NavigationTransitionLeg edge = Leg("Mountain", 10, 10, 20, 20);
    private static NavigationTransitionLeg Edge => edge;

    private static NavigationOrdinaryWarpTopology Topology(string current,
        params NavigationOrdinaryWarpLegs[] sources)
        => new(current, sources);

    private static NavigationOrdinaryWarpLegs Source(string id, params NavigationTransitionLeg[] legs)
        => new(id, legs);

    private static NavigationTransitionLeg Leg(string target, int sx, int sy, int tx, int ty)
        => new(target, sx, sy, tx, ty, IsDoor: false);
}