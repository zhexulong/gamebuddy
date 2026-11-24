using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class AcceptedNavigationExecutionTests
{
    private static readonly BridgeScope Scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");


    [Fact]
    public void PlanNextRouteLeg_TwoHopTopology_ReturnsOnlyTheCurrentNextLeg()
    {
        NavigationTransitionLeg farmToMountain = new("Mountain", 1, 1, 2, 2, false);
        NavigationTransitionLeg mountainToMine = new("Mine", 3, 3, 4, 4, false);
        var world = new SequencedWorldSource(
            View(true, true, "Farm", at: false),
            View(true, true, "Mountain", at: false));
        NavigationOrdinaryWarpTopology farmTopology = Topology("Farm", farmToMountain, mountainToMine);
        NavigationOrdinaryWarpTopology mountainTopology = Topology("Mountain", farmToMountain, mountainToMine);
        var runtime = RuntimeSnapshot(world, new SequencedConnectivitySource(farmTopology, mountainTopology));
        AcceptedNavigationExecution coordinator = AcceptedNavigationExecution.ForAcceptedDestination(
            AcceptedNavigationExecution.Admit(Label("Mine"), runtime));
        coordinator.HasAcceptedDestination.Should().BeTrue();

        NavigationPlan first = coordinator.PlanNextRouteLeg();
        NavigationPlan second = coordinator.PlanNextRouteLeg();

        first.Outcome.NextLeg.Should().Be(farmToMountain);
        second.Outcome.NextLeg.Should().Be(mountainToMine);
        first.Outcome.State.Should().Be(ExecutionState.Running);
        second.Outcome.State.Should().Be(ExecutionState.Running);
    }

    [Fact]
    public void PlanNextRouteLeg_AcceptedRefContinuesAfterReferenceExpires()
    {
        var references = new NavigationReferenceStore();
        DerivedDestinationSet set = DestinationSet("generation_01");
        DerivedDestinationSet currentSet = set;
        var context = new NavigationBindingContext("runtime_01", Scope, set.Generation, 1, DateTimeOffset.UtcNow);
        string reference = references.IssueDestination(context, new NavigationDestinationBinding("stardew", "Mine", set.Generation, 1));
        NavigationTransitionLeg farmToMine = new("Mine", 1, 1, 2, 2, false);
        var runtime = new NavigationRuntimeSnapshot(
            references, "runtime_01", Scope, () => currentSet,
            new FixedWorldSource(View(true, true, "Farm", at: false)),
            new FixedConnectivitySource(new NavigationOrdinaryWarpTopology("Farm", new[]
            {
                new NavigationOrdinaryWarpLegs("Farm", new[] { farmToMine }),
                new NavigationOrdinaryWarpLegs("Mine", Array.Empty<NavigationTransitionLeg>()),
            })));

        NavigationAdmission admission = AcceptedNavigationExecution.Admit(new NavigationDestinationSelector("ref", null, reference), runtime);
        AcceptedNavigationExecution coordinator = AcceptedNavigationExecution.ForAcceptedDestination(admission);
        currentSet = DestinationSet("generation_02");
        references.ClearForSourceGenerationChange();

        NavigationPlan plan = coordinator.PlanNextRouteLeg();

        admission.IsAccepted.Should().BeTrue();
        coordinator.HasAcceptedDestination.Should().BeTrue();
        plan.Outcome.State.Should().Be(ExecutionState.Running);
        plan.Outcome.NextLeg.Should().Be(farmToMine);
    }

    [Fact]
    public void PlanNextRouteLeg_InvalidTopology_FailsClosedWithoutNextLeg()
    {
        NavigationTransitionLeg invalid = new("Missing", 1, 1, 2, 2, false);
        var runtime = RuntimeSnapshot(
            new FixedWorldSource(View(true, true, "Farm", at: false)),
            new FixedConnectivitySource(new NavigationOrdinaryWarpTopology("Farm", new[]
            {
                new NavigationOrdinaryWarpLegs("Farm", new[] { invalid }),
                new NavigationOrdinaryWarpLegs("Mine", Array.Empty<NavigationTransitionLeg>()),
            })));
        AcceptedNavigationExecution coordinator = AcceptedNavigationExecution.ForAcceptedDestination(
            AcceptedNavigationExecution.Admit(Label("Mine"), runtime));

        NavigationPlan plan = coordinator.PlanNextRouteLeg();

        plan.Outcome.State.Should().Be(ExecutionState.Blocked);
        plan.Outcome.TerminalReasonCode.Should().Be("destination_access_indeterminate");
        plan.Outcome.NextLeg.Should().BeNull();
    }

    [Fact]
    public void AlreadyAtDestination_IsTheOnlySuccessWithEvidenceAndPostcondition()
    {
        AcceptedNavigationExecution coordinator = Runtime(View(true, true, "Mine", at: true));
        NavigationPlan plan = coordinator.PlanDirectTransition(Label("Mine"));
        plan.IsTerminal.Should().BeTrue();
        plan.Outcome.State.Should().Be(ExecutionState.Succeeded);
        plan.Outcome.TerminalReasonCode.Should().Be("navigation_completed");
        plan.Outcome.Evidence.Should().NotBeNullOrEmpty();
        plan.Outcome.Evidence.Should().Contain("postcondition=true");
    }

    [Fact]
    public void NotAtCurrentDestination_PlansOnePrivateOrdinaryLegAndNeverSuccess()
    {
        var leg = new NavigationTransitionLeg("Mine", 10, 10, 20, 20, IsDoor: false);
        AcceptedNavigationExecution coordinator = Runtime(View(true, true, "Farm", at: false, legs: new[] { leg }));
        NavigationPlan plan = coordinator.PlanDirectTransition(Label("Mine"));
        plan.IsTerminal.Should().BeFalse();
        plan.Outcome.State.Should().Be(ExecutionState.Running);
        plan.Outcome.NextLeg.Should().Be(leg);
        plan.Outcome.TerminalReasonCode.Should().Be("accepted");
    }

    [Fact]
    public void UnknownLabel_FailsClosedAsDestinationSelectorInvalid()
    {
        AcceptedNavigationExecution coordinator = Runtime(View(true, true, "Mine", at: true));
        NavigationPlan plan = coordinator.PlanDirectTransition(Label("NotARealDestination"));
        plan.Outcome.TerminalReasonCode.Should().Be("destination_selector_invalid");
        plan.Outcome.State.Should().Be(ExecutionState.Rejected);
    }

    [Fact]
    public void DuplicateLabel_IsAmbiguousNotChosen()
    {
        AcceptedNavigationExecution coordinator = Runtime(View(true, true, "Mine", at: true), duplicate: true);
        NavigationPlan plan = coordinator.PlanDirectTransition(Label("Mine"));
        plan.Outcome.TerminalReasonCode.Should().Be("destination_selector_ambiguous");
        plan.Outcome.State.Should().Be(ExecutionState.Rejected);
    }

    [Fact]
    public void InvalidSelector_FailsClosedBeforeWorldSourceIsRead()
    {
        AcceptedNavigationExecution coordinator = new(new NavigationRuntimeSnapshot(
            new NavigationReferenceStore(), "runtime_01", Scope, () => DestinationSet("generation_01"),
            new ThrowingWorldSource()));

        NavigationPlan plan = coordinator.PlanDirectTransition(Label("NotARealDestination"));

        plan.Outcome.State.Should().Be(ExecutionState.Rejected);
        plan.Outcome.TerminalReasonCode.Should().Be("destination_selector_invalid");
    }

    [Fact]
    public void StaleDestinationRef_FailsClosed()
    {
        (AcceptedNavigationExecution coordinator, string staleRef) = RuntimeWithStaleRef();
        var selector = new NavigationDestinationSelector("ref", null, staleRef);
        NavigationPlan plan = coordinator.PlanDirectTransition(selector);
        plan.Outcome.TerminalReasonCode.Should().Be("destination_selector_stale");
        plan.Outcome.State.Should().Be(ExecutionState.Rejected);
    }

    [Fact]
    public void NoOrdinaryLegToDestination_IsPathNotFound()
    {
        AcceptedNavigationExecution coordinator = Runtime(View(true, true, "Farm", at: false, legs: Array.Empty<NavigationTransitionLeg>()));
        NavigationPlan plan = coordinator.PlanDirectTransition(Label("Mine"));
        plan.Outcome.TerminalReasonCode.Should().Be("path_not_found");
        plan.Outcome.State.Should().Be(ExecutionState.Blocked);
    }

    [Fact]
    public void LegsExistButNoneToDestination_IsDestinationUnreachable()
    {
        var other = new NavigationTransitionLeg("OtherLocation", 2, 2, 3, 3, IsDoor: false);
        AcceptedNavigationExecution coordinator = Runtime(View(true, true, "Farm", at: false, legs: new[] { other }));
        NavigationPlan plan = coordinator.PlanDirectTransition(Label("Mine"));
        plan.Outcome.TerminalReasonCode.Should().Be("destination_unreachable");
        plan.Outcome.State.Should().Be(ExecutionState.Blocked);
    }

    /// <summary>
    /// ROUND99's SHAPE, at the layer that decides it: a navigation asked from a mine level for a destination on another
    /// map. `UndergroundMine1` is a graph node with no ordinary legs (its way out is the exit ladder, not a warp), `Farm`
    /// is four hops away, and the answer must be the LEG THAT LEAVES THIS MAP - the published `use_mine_ladder` target -
    /// with the map it lands on, so the caller can act instead of observing again.
    /// </summary>
    [Fact]
    public void MineLevelToFarm_NamesTheLadderOutOfTheMapInsteadOfIndeterminate()
    {
        const string ladderStep = "use_mine_ladder@mine_entrance_0123456789abcdef";
        NavigationWorldView view = View(true, true, "UndergroundMine1", at: false) with
        {
            SourceExitStep = ladderStep,
            SourceExitLanding = "Mine",
        };
        AcceptedNavigationExecution coordinator = MineToFarm(view);

        NavigationPlan plan = coordinator.PlanNextRouteLeg();

        plan.Outcome.State.Should().Be(ExecutionState.Blocked);
        plan.Outcome.TerminalReasonCode.Should().Be("destination_unreachable");
        plan.Outcome.Evidence.Should()
            .Contain("destination=Farm")
            .And.Contain("from=UndergroundMine1")
            .And.Contain($"next_step={ladderStep}")
            .And.Contain("landing=Mine");
        // The specific step wins over the table's generic word: one sentence, one instruction.
        NavigationNextStep.Describe("destination_unreachable", plan.Outcome.Evidence)
            .Should().NotContain("choose_a_reachable_destination");
    }

    /// <summary>
    /// The same request against the graph `round99` actually got: the planner was handed a topology that does not hold the
    /// map the body stands on (`topology=route_topology_invalid` in the receipt). That is not an unread fact - the body's
    /// map and its exit are known - so it must answer with the leg, never with `observe_before_acting`.
    /// </summary>
    [Fact]
    public void AGraphThatDoesNotHoldTheStandingMap_AnswersWithTheLegNotIndeterminate()
    {
        const string ladderStep = "use_mine_ladder@mine_entrance_0123456789abcdef";
        NavigationWorldView view = View(true, true, "UndergroundMine1", at: false) with
        {
            SourceExitStep = ladderStep,
            SourceExitLanding = "Mine",
        };
        // No `UndergroundMine1` node at all, which is exactly what the live builder produced before it held the standing
        // map: `plan_441` and `plan_443` both carried `topology=route_topology_invalid`.
        NavigationOrdinaryWarpTopology graph = new("UndergroundMine1", new[]
        {
            new NavigationOrdinaryWarpLegs("Mine", new[] { MineToMountain() }),
            new NavigationOrdinaryWarpLegs("Mountain", new[] { MountainToFarm() }),
            new NavigationOrdinaryWarpLegs("Farm", Array.Empty<NavigationTransitionLeg>()),
        });
        AcceptedNavigationExecution coordinator = AcceptedNavigationExecution.ForAcceptedDestination(
            AcceptedNavigationExecution.Admit(Label("Farm"), RuntimeSnapshot(new FixedWorldSource(view), new FixedConnectivitySource(graph))));

        NavigationPlan plan = coordinator.PlanNextRouteLeg();

        plan.Outcome.State.Should().Be(ExecutionState.Blocked);
        plan.Outcome.TerminalReasonCode.Should().Be("destination_unreachable");
        plan.Outcome.Evidence.Should().Contain($"next_step={ladderStep}").And.Contain("from=UndergroundMine1");
    }

    /// <summary>
    /// The positive half, in the same graph: a destination the ordinary legs DO reach is admitted in one go, with the
    /// first leg of the route armed and no refusal at all.
    /// </summary>
    [Fact]
    public void AReachableDestinationInTheSameGraph_StillArmsTheFirstLegInOneGo()
    {
        AcceptedNavigationExecution coordinator = AcceptedNavigationExecution.ForAcceptedDestination(
            AcceptedNavigationExecution.Admit(
                Label("Farm"),
                RuntimeSnapshot(
                    new FixedWorldSource(View(true, true, "Mine", at: false)),
                    new FixedConnectivitySource(MineGraph("Mine")))));

        NavigationPlan plan = coordinator.PlanNextRouteLeg();

        plan.IsTerminal.Should().BeFalse();
        plan.Outcome.State.Should().Be(ExecutionState.Running);
        plan.Outcome.TerminalReasonCode.Should().Be("accepted");
        plan.Outcome.NextLeg.Should().Be(MineToMountain());
    }

    /// <summary>
    /// The boundary that does not move: a map with no exit leg keeps the plain answer, and no step is invented for it.
    /// A caller's next move there is a destination the topology reaches, which the table already names once.
    /// </summary>
    [Fact]
    public void NoRouteInsideOneMap_KeepsItsOwnCodeAndInventsNoStep()
    {
        // The body stands on `Mine`, the destination is `Farm`, and no ordinary leg of this graph reaches it. There is no
        // exit leg here either, so the answer stays the plain one and the table's own word is the only step published.
        NavigationOrdinaryWarpTopology graph = new("Mine", new[]
        {
            new NavigationOrdinaryWarpLegs("Mine", Array.Empty<NavigationTransitionLeg>()),
            new NavigationOrdinaryWarpLegs("Mountain", new[] { MountainToFarm() }),
            new NavigationOrdinaryWarpLegs("Farm", Array.Empty<NavigationTransitionLeg>()),
        });
        AcceptedNavigationExecution coordinator = AcceptedNavigationExecution.ForAcceptedDestination(
            AcceptedNavigationExecution.Admit(
                Label("Farm"),
                RuntimeSnapshot(
                    new FixedWorldSource(View(true, true, "Mine", at: false)),
                    new FixedConnectivitySource(graph))));

        NavigationPlan plan = coordinator.PlanNextRouteLeg();

        plan.Outcome.TerminalReasonCode.Should().Be("destination_unreachable");
        plan.Outcome.Evidence.Should().Contain("from=Mine").And.NotContain("next_step=").And.NotContain("leg=");
        NavigationNextStep.Describe("destination_unreachable", plan.Outcome.Evidence)
            .Should().EndWith("next_step=choose_a_reachable_destination");
    }

    private static NavigationTransitionLeg MineToMountain() => new("Mountain", 20, 4, 9, 4, IsDoor: false);

    private static NavigationTransitionLeg MountainToFarm() => new("Farm", 31, 5, 44, 44, IsDoor: false);

    /// <summary>
    /// The mine level's own graph as the live builder now produces it: the level is a node with no ordinary legs, and
    /// the map it can only leave through its ladder is what the rest of the valley hangs off.
    /// </summary>
    private static NavigationOrdinaryWarpTopology MineGraph(string current) => new(current, new[]
    {
        new NavigationOrdinaryWarpLegs("UndergroundMine1", Array.Empty<NavigationTransitionLeg>()),
        new NavigationOrdinaryWarpLegs("Mine", new[] { MineToMountain() }),
        new NavigationOrdinaryWarpLegs("Mountain", new[] { MountainToFarm() }),
        new NavigationOrdinaryWarpLegs("Farm", Array.Empty<NavigationTransitionLeg>()),
    });

    private static AcceptedNavigationExecution MineToFarm(NavigationWorldView view) =>
        AcceptedNavigationExecution.ForAcceptedDestination(
            AcceptedNavigationExecution.Admit(
                Label("Farm"),
                RuntimeSnapshot(new FixedWorldSource(view), new FixedConnectivitySource(MineGraph("UndergroundMine1")))));

    [Fact]
    public void DestinationLockedOnBodyIsTerminal()
    {
        AcceptedNavigationExecution coordinator = Runtime(View(true, false, "Farm", at: false));
        NavigationPlan plan = coordinator.PlanDirectTransition(Label("Mine"));
        plan.Outcome.TerminalReasonCode.Should().Be("destination_locked");
        plan.Outcome.State.Should().Be(ExecutionState.Rejected);
    }

    [Fact]
    public void TemporarilyUnavailableDestinationIsTerminal()
    {
        AcceptedNavigationExecution coordinator = Runtime(View(true, true, "Farm", at: false, temporary: true));
        NavigationPlan plan = coordinator.PlanDirectTransition(Label("Mine"));
        plan.Outcome.TerminalReasonCode.Should().Be("destination_temporarily_unavailable");
        plan.Outcome.State.Should().Be(ExecutionState.Blocked);
    }

    [Fact]
    public void UnknownTransition_PerformsAccessIndeterminate()
    {
        AcceptedNavigationExecution coordinator = Runtime(View(true, true, "Farm", at: false, unknown: true));
        NavigationPlan plan = coordinator.PlanDirectTransition(Label("Mine"));
        plan.Outcome.TerminalReasonCode.Should().Be("destination_access_indeterminate");
        plan.Outcome.State.Should().Be(ExecutionState.Blocked);
    }

    [Fact]
    public void NoLivePlayer_IsAccessIndeterminant()
    {
        AcceptedNavigationExecution coordinator = Runtime(View(false, false, null, at: false));
        NavigationPlan plan = coordinator.PlanDirectTransition(Label("Mine"));
        plan.Outcome.TerminalReasonCode.Should().Be("destination_access_indeterminate");
    }

    [Fact]
    public void BoundaryExcludedDestination_IsDestinationUnreachable()
    {
        AcceptedNavigationExecution coordinator = Runtime(View(true, true, "Farm", at: false, boundary: true));
        NavigationPlan plan = coordinator.PlanDirectTransition(Label("Mine"));
        plan.Outcome.TerminalReasonCode.Should().Be("destination_unreachable");
        plan.Outcome.State.Should().Be(ExecutionState.Rejected);
    }

    [Fact]
    public void UncorrelatedTransition_IsNativeTransitionUncertainAndNotRetried()
    {
        AcceptedNavigationExecution coordinator = Runtime(View(true, true, "MidWarp", at: false, uncorrelated: true));
        NavigationPlan plan = coordinator.PlanDirectTransition(Label("Mine"));
        plan.Outcome.TerminalReasonCode.Should().Be("native_transition_uncertain");
        plan.Outcome.State.Should().Be(ExecutionState.Uncertain);
    }

    private static NavigationOrdinaryWarpTopology Topology(
        string current,
        NavigationTransitionLeg farmToMountain,
        NavigationTransitionLeg mountainToMine) => new(current, new[]
    {
        new NavigationOrdinaryWarpLegs("Farm", new[] { farmToMountain }),
        new NavigationOrdinaryWarpLegs("Mountain", new[] { mountainToMine }),
        new NavigationOrdinaryWarpLegs("Mine", Array.Empty<NavigationTransitionLeg>()),
    });

    private static DerivedDestinationSet DestinationSet(string generation) => new(
        generation,
        new NavigationSourceNode("root", null, null, null, Array.Empty<NavigationSourceNode>()),
        new[]
        {
            new NavigationDestination("stardew", "Mine", "Mine", null),
            new NavigationDestination("stardew", "Farm", "Farm", null),
        });

    private static NavigationRuntimeSnapshot RuntimeSnapshot(
        INavigationWorldSource world,
        INavigationConnectivitySource connectivity) => new(
            new NavigationReferenceStore(), "runtime_01", Scope, () => DestinationSet("generation_01"), world, connectivity);

    private AcceptedNavigationExecution Runtime(NavigationWorldView view, bool duplicate = false)
    {
        var references = new NavigationReferenceStore();
        var destinations = new List<NavigationDestination>();
        destinations.Add(new NavigationDestination("stardew", "Mine", "Mine", null));
        if (duplicate) destinations.Add(new NavigationDestination("stardew", "Mine2", "Mine", null));
        var set = new DerivedDestinationSet("generation_01", new NavigationSourceNode("root", null, null, null, Array.Empty<NavigationSourceNode>()), destinations);
        var runtime = new NavigationRuntimeSnapshot(references, "runtime_01", Scope, () => set, new FixedWorldSource(view));
        return new AcceptedNavigationExecution(runtime);
    }

    private (AcceptedNavigationExecution, string) RuntimeWithStaleRef()
    {
        var references = new NavigationReferenceStore();
        var oldContext = new NavigationBindingContext("runtime_01", Scope, "generation_old", 5, DateTimeOffset.UtcNow);
        var binding = new NavigationDestinationBinding("stardew", "Mine", "generation_old", 5);
        string staleRef = references.IssueDestination(oldContext, binding);
        var set = new DerivedDestinationSet("generation_new", new NavigationSourceNode("root", null, null, null, Array.Empty<NavigationSourceNode>()),
            new[] { new NavigationDestination("stardew", "Mine", "Mine", null) });
        var runtime = new NavigationRuntimeSnapshot(references, "runtime_01", Scope, () => set, new FixedWorldSource(View(true, true, "Mine", at: true)));
        return (new AcceptedNavigationExecution(runtime), staleRef);
    }

    /// <summary>
    /// The hold these fixtures publish for a body the game has not described further, in <see cref="WorldModel"/>'s own
    /// words rather than a second copy of them.
    /// </summary>
    private static readonly string NotActionableHold = WorldModel.DescribeHeldBody(default, canMove: false, hold: BodyHoldFact.Free).Evidence;

    private static NavigationWorldView View(bool live, bool actionable, string? source, bool at,
        IReadOnlyList<NavigationTransitionLeg>? legs = null, bool boundary = false, bool temporary = false,
        bool unknown = false, bool uncorrelated = false)
        => new(live, actionable ? null : NotActionableHold, source, 0, 0, at, legs ?? Array.Empty<NavigationTransitionLeg>(), boundary, temporary, unknown, uncorrelated);

    private static NavigationDestinationSelector Label(string label) => new("label", label, null);

    private sealed class FixedWorldSource : INavigationWorldSource
    {
        private readonly NavigationWorldView view;
        public FixedWorldSource(NavigationWorldView view) { this.view = view; }
        public NavigationWorldView CurrentView(NavigationDestinationBinding binding) => this.view;
    }

    private sealed class ThrowingWorldSource : INavigationWorldSource
    {
        public NavigationWorldView CurrentView(NavigationDestinationBinding binding) =>
            throw new InvalidOperationException("A rejected selector must not reach the world seam.");
    }

    private sealed class SequencedWorldSource : INavigationWorldSource
    {
        private readonly Queue<NavigationWorldView> views;
        public SequencedWorldSource(params NavigationWorldView[] views) => this.views = new Queue<NavigationWorldView>(views);
        public NavigationWorldView CurrentView(NavigationDestinationBinding binding) => this.views.Dequeue();
    }

    private sealed class FixedConnectivitySource : INavigationConnectivitySource
    {
        private readonly NavigationOrdinaryWarpTopology topology;
        public FixedConnectivitySource(NavigationOrdinaryWarpTopology topology) => this.topology = topology;
        public bool TryCreateCurrentOrdinaryWarpTopology(NavigationDestinationBinding binding, out NavigationOrdinaryWarpTopology? topology, out string reasonCode)
        {
            topology = this.topology;
            reasonCode = "accepted";
            return true;
        }
    }

    private sealed class SequencedConnectivitySource : INavigationConnectivitySource
    {
        private readonly Queue<NavigationOrdinaryWarpTopology> topologies;
        public SequencedConnectivitySource(params NavigationOrdinaryWarpTopology[] topologies) => this.topologies = new Queue<NavigationOrdinaryWarpTopology>(topologies);
        public bool TryCreateCurrentOrdinaryWarpTopology(NavigationDestinationBinding binding, out NavigationOrdinaryWarpTopology? topology, out string reasonCode)
        {
            topology = this.topologies.Dequeue();
            reasonCode = "accepted";
            return true;
        }
    }
}