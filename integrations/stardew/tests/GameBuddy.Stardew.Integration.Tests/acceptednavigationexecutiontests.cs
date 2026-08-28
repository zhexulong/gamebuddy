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
        new[] { new NavigationDestination("stardew", "Mine", "Mine", null) });

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

    private static NavigationWorldView View(bool live, bool actionable, string? source, bool at,
        IReadOnlyList<NavigationTransitionLeg>? legs = null, bool boundary = false, bool temporary = false,
        bool unknown = false, bool uncorrelated = false)
        => new(live, actionable, source, 0, 0, at, legs ?? Array.Empty<NavigationTransitionLeg>(), boundary, temporary, unknown, uncorrelated);

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