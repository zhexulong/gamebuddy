using FluentAssertions;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class VirtualConnectivityEdgeTests
{
    private static readonly NavigationDestinationBinding Mountain =
        new("stardew", "Mountain", "generation_01", 1);

    [Fact]
    public void LockedVirtualEdge_IsIgnoredAndDestinationRemainsUnreachable()
    {
        NavigationVirtualConnectivityLeg locked = VirtualLeg(
            "Farm", "Mountain", gateSatisfied: false);
        NavigationOrdinaryWarpTopology topology = Topology(
            Source("Farm", virtualLegs: new[] { locked }),
            Source("Mountain"));

        NavigationRoutePlanResult result = new NavigationRoutePlanner().Plan(topology, "Farm", Mountain);

        result.Kind.Should().Be(NavigationRoutePlanKind.Terminal);
        result.ReasonCode.Should().Be("destination_unreachable");
        result.NextLeg.Should().BeNull();
        result.NextVirtualLeg.Should().BeNull();
    }

    [Fact]
    public void UnlockedVirtualEdge_IsAFirstClassBfsEdgeToTheTransportDestination()
    {
        NavigationVirtualConnectivityLeg unlocked = VirtualLeg(
            "Farm", "Mountain", gateSatisfied: true, stationX: 17, stationY: 23);
        NavigationOrdinaryWarpTopology topology = Topology(
            Source("Farm", virtualLegs: new[] { unlocked }),
            Source("Mountain"));

        NavigationRoutePlanResult result = new NavigationRoutePlanner().Plan(topology, "Farm", Mountain);

        result.Kind.Should().Be(NavigationRoutePlanKind.NextEdge);
        result.ReasonCode.Should().Be("accepted");
        result.NextLeg.Should().Be(unlocked.Transition);
        result.NextVirtualLeg.Should().Be(unlocked);
        result.NextVirtualLeg!.DepartureLocation.Should().Be("Farm");
        result.NextVirtualLeg.TransportAction.Should().Be("ride_minecart");
        result.NextVirtualLeg.Transition.SourceX.Should().Be(17);
        result.NextVirtualLeg.Transition.SourceY.Should().Be(23);
    }

    [Fact]
    public void OrdinaryWarpToGatedLocation_IsFilteredFromEffectiveGraph()
    {
        NavigationTransitionLeg gatedWarp = Leg("Mountain");
        NavigationOrdinaryWarpTopology topology = Topology(
            Source("Farm", gatedOrdinaryLegs: Array.Empty<NavigationTransitionLeg>()),
            Source("Mountain", gatedOrdinaryLegs: new[] { gatedWarp }));

        NavigationRoutePlanResult result = new NavigationRoutePlanner().Plan(topology, "Farm", Mountain);

        result.Kind.Should().Be(NavigationRoutePlanKind.Terminal);
        result.ReasonCode.Should().Be("destination_unreachable");
    }

    [Fact]
    public void OrdinaryAndVirtualEdgesRemainSeparateForTopologyConsumers()
    {
        NavigationTransitionLeg ordinary = Leg("Mountain");
        NavigationVirtualConnectivityLeg virtualLeg = VirtualLeg("Farm", "Mountain", gateSatisfied: true);
        NavigationOrdinaryWarpLegs source = Source(
            "Farm",
            gatedOrdinaryLegs: new[] { ordinary },
            virtualLegs: new[] { virtualLeg });

        source.OutgoingOrdinaryLegs.Should().ContainSingle().Which.Should().Be(ordinary);
        source.OutgoingVirtualLegs.Should().ContainSingle().Which.Should().Be(virtualLeg);
    }

    private static NavigationOrdinaryWarpTopology Topology(params NavigationOrdinaryWarpLegs[] sources) =>
        new("Farm", sources);

    private static NavigationOrdinaryWarpLegs Source(
        string id,
        IReadOnlyList<NavigationTransitionLeg>? gatedOrdinaryLegs = null,
        IReadOnlyList<NavigationVirtualConnectivityLeg>? virtualLegs = null) =>
        new(id, gatedOrdinaryLegs ?? Array.Empty<NavigationTransitionLeg>(), virtualLegs);

    private static NavigationTransitionLeg Leg(string target) =>
        new(target, 10, 10, 20, 20, IsDoor: false);

    private static NavigationVirtualConnectivityLeg VirtualLeg(
        string departure,
        string target,
        bool gateSatisfied,
        int stationX = 10,
        int stationY = 10) =>
        new(
            new NavigationTransitionLeg(target, stationX, stationY, 30, 30, IsDoor: false),
            departure,
            "ride_minecart",
            "Default",
            "mine",
            new NavigationConnectivityGate("minecart:Default:mine", gateSatisfied));
}
