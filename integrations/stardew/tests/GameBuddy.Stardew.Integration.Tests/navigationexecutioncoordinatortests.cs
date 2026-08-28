using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Deterministic lifecycle tests for the single Navigation execution. They feed
/// the coordinator real resolved-destination and source-transition facts (a
/// plain chain of warp/door edges and a private reference binding) so every
/// terminal comes from a real planner/lifecycle decision, never an invented
/// access taxonomy.
/// </summary>
public sealed class NavigationExecutionCoordinatorTests
{
    private static readonly BridgeScope Scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");

    [Fact]
    public void AlreadyAtDestination_IsTheOnlySuccessAndCarriesEvidenceAndPostcondition()
    {
        NavigationExecutionCoordinator coordinator = Runtime(View(true, true, "Mine", at: true));
        NavigationPlan plan = coordinator.Plan(Label("Mine"));

        plan.IsTerminal.Should().BeTrue();
        plan.Outcome.State.Should().Be(ExecutionState.Succeeded);
        plan.Outcome.TerminalReasonCode.Should().Be("navigation_completed");
        plan.Outcome.Evidence.Should().NotBeNullOrEmpty();
        plan.Outcome.Evidence.Should().Contain("arrived=true");
        plan.Outcome.Evidence.Should().Contain("postcondition=true");
    }

    [Fact]
    public void ExactDestination_NotAtCurrent_PlansOnePrivateOrdinaryLegAndNeverSuccess()
    {
        var leg = new NavigationTransitionLeg("Mine", 10, 10, 20, 20, IsDoor: false);
        NavigationExecutionCoordinator coordinator = Runtime(View(true, true, "Farm", at: false, legs: new[] { leg }));

        NavigationPlan plan = coordinator.Plan(Label("Mine"));

        plan.IsTerminal.Should().BeFalse();
        plan.Outcome.State.Should().Be(ExecutionState.Running);
        plan.Outcome.NextLeg.Should().Be(leg);
        plan.Outcome.TerminalReasonCode.Should().Be("accepted");
    }

    [Fact]
    public void UnknownLabel_FailsClosedAsDestinationSelectorInvalid()
    {
        NavigationExecutionCoordinator coordinator = Runtime(View(true, true, "Mine", at: true));
        NavigationPlan plan = coordinator.Plan(Label("NotARealDestination"));

        plan.Outcome.TerminalReasonCode.Should().Be("destination_selector_invalid");
        plan.Outcome.State.Should().Be(ExecutionState.Rejected);
    }

    [Fact]
    public void DuplicateLabel_IsAmbiguousNotChosen()
    {
        NavigationExecutionCoordinator coordinator = Runtime(View(true, true, "Mine", at: true), duplicate: true);
        NavigationPlan plan = coordinator.Plan(Label("Mine"));

        plan.Outcome.TerminalReasonCode.Should().Be("destination_selector_ambiguous");
        plan.Outcome.State.Should().Be(ExecutionState.Rejected);
    }

    [Fact]
    public void StaleDestinationRef_FailsClosed()
    {
        (NavigationExecutionCoordinator coordinator, string staleRef) = RuntimeWithStaleRef();
        var selector = new NavigationDestinationSelector("ref", null, staleRef);

        NavigationPlan plan = coordinator.Plan(selector);

        plan.Outcome.TerminalReasonCode.Should().Be("destination_selector_stale");
        plan.Outcome.State.Should().Be(ExecutionState.Rejected);
    }

    [Fact]
    public void NoOrdinaryLegToDestination_IsPathNotFound()
    {
        NavigationExecutionCoordinator coordinator = Runtime(View(true, true, "Farm", at: false, legs: Array.Empty<NavigationTransitionLeg>()));
        NavigationPlan plan = coordinator.Plan(Label("Mine"));

        plan.Outcome.TerminalReasonCode.Should().Be("path_not_found");
        plan.Outcome.State.Should().Be(ExecutionState.Blocked);
    }

    [Fact]
    public void LegsExistButNoneToDestination_IsDestinationUnreachable()
    {
        var other = new NavigationTransitionLeg("OtherLocation", 2, 2, 3, 3, IsDoor: false);
        NavigationExecutionCoordinator coordinator = Runtime(View(true, true, "Farm", at: false, legs: new[] { other }));
        NavigationPlan plan = coordinator.Plan(Label("Mine"));

        plan.Outcome.TerminalReasonCode.Should().Be("destination_unreachable");
        plan.Outcome.State.Should().Be(ExecutionState.Blocked);
    }

    [Fact]
    public void DestinationLockedOnBodyIsTerminal()
    {
        NavigationExecutionCoordinator coordinator = Runtime(View(true, false, "Farm", at: false));
        NavigationPlan plan = coordinator.Plan(Label("Mine"));

        plan.Outcome.TerminalReasonCode.Should().Be("destination_locked");
        plan.Outcome.State.Should().Be(ExecutionState.Rejected);
    }

    [Fact]
    public void TemporarilyUnavailableDestinationIsTerminal()
    {
        NavigationExecutionCoordinator coordinator = Runtime(View(true, true, "Farm", at: false, temporary: true));
        NavigationPlan plan = coordinator.Plan(Label("Mine"));

        plan.Outcome.TerminalReasonCode.Should().Be("destination_temporarily_unavailable");
        plan.Outcome.State.Should().Be(ExecutionState.Blocked);
    }

    [Fact]
    public void UnknownTransition_IsAccessIndeterminate()
    {
        NavigationExecutionCoordinator coordinator = Runtime(View(true, true, "Farm", at: false, unknown: true));
        NavigationPlan plan = coordinator.Plan(Label("Mine"));

        plan.Outcome.TerminalReasonCode.Should().Be("destination_access_indeterminate");
        plan.Outcome.State.Should().Be(ExecutionState.Blocked);
    }

    [Fact]
    public void NoLivePlayer_IsAccessIndeterminate()
    {
        NavigationExecutionCoordinator coordinator = Runtime(View(false, false, null, at: false));
        NavigationPlan plan = coordinator.Plan(Label("Mine"));

        plan.Outcome.TerminalReasonCode.Should().Be("destination_access_indeterminate");
        plan.Outcome.State.Should().Be(ExecutionState.Uncertain);
    }

    [Fact]
    public void BoundaryExcludedDestination_IsDestinationUnreachable()
    {
        NavigationExecutionCoordinator coordinator = Runtime(View(true, true, "Farm", at: false, boundary: true));
        NavigationPlan plan = coordinator.Plan(Label("Mine"));

        plan.Outcome.TerminalReasonCode.Should().Be("destination_unreachable");
        plan.Outcome.State.Should().Be(ExecutionState.Rejected);
    }

    [Fact]
    public void UncorrelatedTransition_IsNativeTransitionUncertainAndNotRetried()
    {
        NavigationExecutionCoordinator coordinator = Runtime(View(true, true, "MidWarp", at: false, uncorrelated: true));
        NavigationPlan plan = coordinator.Plan(Label("Mine"));

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

    private NavigationExecutionCoordinator Runtime(NavigationWorldView view, bool duplicate = false)
    {
        var references = new NavigationReferenceStore();
        var destinations = new List<NavigationDestination>
        {
            new("stardew", "Mine", "Mine", null),
        };
        if (duplicate)
            destinations.Add(new NavigationDestination("stardew", "Mine2", "Mine", null));
        var set = new DerivedDestinationSet("generation_01", new NavigationSourceNode("root", null, null, null, Array.Empty<NavigationSourceNode>()), destinations);
        var runtime = new NavigationRuntimeSnapshot(references, "runtime_01", Scope, () => set, new FixedWorldSource(view));
        return new NavigationExecutionCoordinator(runtime);
    }

    private (NavigationExecutionCoordinator, string) RuntimeWithStaleRef()
    {
        var references = new NavigationReferenceStore();
        var oldContext = new NavigationBindingContext("runtime_01", Scope, "generation_old", 5, DateTimeOffset.UtcNow);
        var binding = new NavigationDestinationBinding("stardew", "Mine", "generation_old", 5);
        string staleRef = references.IssueDestination(oldContext, binding);
        var set = new DerivedDestinationSet("generation_new", new NavigationSourceNode("root", null, null, null, Array.Empty<NavigationSourceNode>()),
            new[] { new NavigationDestination("stardew", "Mine", "Mine", null) });
        var runtime = new NavigationRuntimeSnapshot(references, "runtime_01", Scope, () => set, new FixedWorldSource(View(true, true, "Mine", at: true)));
        return (new NavigationExecutionCoordinator(runtime), staleRef);
    }

    private static NavigationWorldView View(
        bool live,
        bool actionable,
        string? source,
        bool at,
        IReadOnlyList<NavigationTransitionLeg>? legs = null,
        bool boundary = false,
        bool temporary = false,
        bool unknown = false,
        bool uncorrelated = false) => new(
            live,
            actionable,
            source,
            0,
            0,
            at,
            legs ?? Array.Empty<NavigationTransitionLeg>(),
            boundary,
            temporary,
            unknown,
            uncorrelated);

    private static NavigationDestinationSelector Label(string label) => new("label", label, null);

    private sealed class FixedWorldSource : INavigationWorldSource
    {
        private readonly NavigationWorldView view;

        public FixedWorldSource(NavigationWorldView view) => this.view = view;

        public NavigationWorldView CurrentView(NavigationDestinationBinding binding) => this.view;
    }
}
