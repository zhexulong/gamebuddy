using FluentAssertions;
using GameBuddy.Stardew.Navigation;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class NavigationRoutePlannerTests
{
    private static readonly NavigationDestinationBinding Mine =
        new("stardew", "Mine", "generation_01", 1);

    private readonly ITestOutputHelper output;

    public NavigationRoutePlannerTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// ① MEASUREMENT, `round89`: how many routes does one plan consider before it settles, and which one does it take?
    ///
    /// <para>
    /// The answer the live run gave: ONE. `Backwoods` published two ways to the Mountain - its east edge, and
    /// `BusStop -> Town -> Mountain` - the east edge's entry cell holds a Bush (`entry_blocked_by:large:Bush@49,10`),
    /// and the action settled `navigation_approach_unavailable` with `never_retry=true` without the second route ever
    /// being asked for. So "it did not try" and "it tried and all failed" were the same receipt, and this test is the
    /// reading that tells them apart: the planner's first answer, then its answer once that edge is refused.
    /// </para>
    /// </summary>
    [Fact]
    public void Plan_BlockedEdge_AnswersTheOtherPublishedRoute()
    {
        NavigationTransitionLeg eastExit = Leg("Mountain", 50, 10, 30, 31);
        NavigationTransitionLeg busStop = Leg("BusStop", 50, 30, 11, 8);
        NavigationOrdinaryWarpTopology topology = Topology("Backwoods",
            Source("Backwoods", eastExit, busStop),
            Source("BusStop", Leg("Town", 11, 8, 60, 60)),
            Source("Town", Leg("Mountain", 79, -1, 30, 31)),
            Source("Mountain", Leg("Mine", 31, 20, 4, 4)),
            Source("Mine"));
        var planner = new NavigationRoutePlanner();

        NavigationRoutePlanResult first = planner.Plan(topology, "Backwoods", Mine);
        this.output.WriteLine(
            $"plan 1 of N: routes published from Backwoods=2; planner answered {first.Kind} {first.NextLeg?.TargetLocation}@{first.NextLeg?.SourceX},{first.NextLeg?.SourceY}");
        first.Kind.Should().Be(NavigationRoutePlanKind.NextEdge);
        first.NextLeg.Should().Be(eastExit);

        NavigationRoutePlanResult second = planner.Plan(topology, "Backwoods", Mine, leg => leg != eastExit);
        this.output.WriteLine(
            $"plan 2 of N: refusing {eastExit.TargetLocation}@{eastExit.SourceX},{eastExit.SourceY}, planner answered {second.Kind} {second.NextLeg?.TargetLocation}@{second.NextLeg?.SourceX},{second.NextLeg?.SourceY}");
        second.Kind.Should().Be(NavigationRoutePlanKind.NextEdge);
        second.NextLeg.Should().Be(busStop, "the other published route is the answer once the east edge is refused");

        NavigationRoutePlanResult none = planner.Plan(topology, "Backwoods", Mine, leg => leg != eastExit && leg != busStop);
        none.Kind.Should().Be(NavigationRoutePlanKind.Terminal);
        none.ReasonCode.Should().Be("destination_unreachable");
        none.NextLeg.Should().BeNull();
    }

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

    /// <summary>
    /// A door is an EDGE, and the planner traverses it. This is the property the old rejection protected - a door is never
    /// silently accepted as a warp - restated where it now lives: the leg keeps <c>IsDoor</c>, so the WALKER decides that
    /// crossing it means the game's own door entry, and the planner only answers "this is the next leg".
    ///
    /// <para>
    /// Refusing it here made every interior a leaf: an interior has no inbound warp, so a topology of warps alone drains
    /// its queue and answers <c>destination_unreachable</c> for the carpenter's, Pierre's and the community centre.
    /// </para>
    /// </summary>
    [Fact]
    public void Plan_DoorEdge_IsTraversedAndKeepsItsFamily()
    {
        var door = new NavigationTransitionLeg("Mountain", 10, 10, 20, 20, IsDoor: true);
        NavigationOrdinaryWarpTopology topology = Topology("Farm",
            Source("Farm", door),
            Source("Mountain", Leg("Mine", 20, 20, 30, 30)),
            Source("Mine"));

        NavigationRoutePlanResult result = new NavigationRoutePlanner().Plan(topology, "Farm", Mine);

        result.Kind.Should().Be(NavigationRoutePlanKind.NextEdge);
        result.NextLeg.Should().Be(door);
        result.NextLeg!.IsDoor.Should().BeTrue("the walker, not the planner, owns how a door is crossed");
    }

    /// <summary>
    /// The falsifier's shape: a destination reachable ONLY through a door is reached, and the first leg on the path is the
    /// door leg - not the second one, and not <c>destination_unreachable</c>. This is the carpenter's/Pierre's/community
    /// centre shape (an interior with no inbound warp) in three nodes.
    /// </summary>
    [Fact]
    public void Plan_DestinationReachedOnlyThroughADoor_ReturnsTheDoorLeg()
    {
        var door = new NavigationTransitionLeg("ScienceHouse", 12, 14, 4, 18, IsDoor: true);
        var house = new NavigationDestinationBinding("stardew", "ScienceHouse", "generation_01", 1);
        NavigationOrdinaryWarpTopology topology = Topology("Town",
            Source("Farm", Leg("Town", 79, -1, 60, 60)),
            Source("Town", door),
            Source("ScienceHouse"));

        NavigationRoutePlanResult result = new NavigationRoutePlanner().Plan(topology, "Town", house);

        result.Kind.Should().Be(NavigationRoutePlanKind.NextEdge);
        result.NextLeg.Should().Be(door, "the interior is behind the door, so the door is the leg to walk");
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