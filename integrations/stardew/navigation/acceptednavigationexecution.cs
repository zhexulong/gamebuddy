using GameBuddy.Stardew;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Navigation;

/// <summary>
/// A private admission which copies the destination binding exactly once. It is
/// intentionally not serializable and does not retain the public selector or
/// its opaque reference.
/// </summary>
internal sealed record NavigationAdmission(
    NavigationRuntimeSnapshot Runtime,
    NavigationDestinationResolution Resolution)
{
    internal bool IsAccepted => this.Resolution.FailureReason is null && this.Resolution.Binding is not null;
}

/// <summary>
/// Owns the private Navigation lifecycle decision. The connected execution
/// controller remains the sole receipt/ledger authority; this class exposes
/// at most one ordinary next leg and never a public route.
/// </summary>
internal sealed class AcceptedNavigationExecution
{
    private readonly NavigationRuntimeSnapshot runtime;
    private readonly NavigationDestinationResolution? acceptedResolution;
    private long observationSequence;

    /// <summary>
    /// Direct-transition planner used for first-hop navigation.
    /// This constructor creates a planner that re-resolves the selector each time.
    /// </summary>
    internal AcceptedNavigationExecution(NavigationRuntimeSnapshot runtime)
    {
        this.runtime = runtime;
    }

    private AcceptedNavigationExecution(NavigationAdmission admission)
    {
        this.runtime = admission.Runtime;
        this.acceptedResolution = admission.Resolution;
    }

    internal NavigationReferenceStore References => this.runtime.References;

    /// <summary>
    /// Resolves a public selector once and copies its private destination
    /// binding. Later <see cref="PlanNextRouteLeg"/> calls never consult references or
    /// re-resolve the selector, so a subsequently expired ref cannot revoke an
    /// already accepted execution.
    /// </summary>
    internal static NavigationAdmission Admit(
        NavigationDestinationSelector selector,
        NavigationRuntimeSnapshot runtime)
    {
        DerivedDestinationSet? set = runtime.SetProvider();
        if (set is null)
            return new NavigationAdmission(runtime, new NavigationDestinationResolution(
                null, null, null, "destination_access_indeterminate"));

        NavigationBindingContext context = new(
            runtime.RuntimeInstanceId,
            runtime.Scope,
            set.Generation,
            1,
            DateTimeOffset.UtcNow);
        return new NavigationAdmission(runtime, Resolve(selector, set, context, runtime.References));
    }

    /// <summary>Constructs an execution-private route-leg planner from
    /// an accepted admission. The public selector is deliberately absent.</summary>
    internal static AcceptedNavigationExecution ForAcceptedDestination(NavigationAdmission admission) =>
        new(admission);

    internal bool HasAcceptedDestination => this.acceptedResolution?.Binding is not null
        && this.acceptedResolution.FailureReason is null;

    /// <summary>
    /// Re-resolves the passed selector and decides the next exclusive outcome on
    /// the game thread. Every admission/arm/commit boundary revalidates the
    /// current destination authority and the live source facts.
    /// </summary>
    internal NavigationPlan PlanDirectTransition(NavigationDestinationSelector selector)
    {
        DerivedDestinationSet? set = this.runtime.SetProvider();
        if (set is null)
            return NavigationPlan.Blocked("destination_access_indeterminate", "world_map_unavailable");

        NavigationBindingContext context = new(
            this.runtime.RuntimeInstanceId,
            this.runtime.Scope,
            set.Generation,
            ++this.observationSequence,
            DateTimeOffset.UtcNow);

        NavigationDestinationResolution resolution = Resolve(selector, set, context, this.runtime.References);
        if (resolution.Binding is null)
            return PlanWithoutLiveWorld(resolution);

        NavigationWorldView view = this.runtime.WorldSource.CurrentView(resolution.Binding);
        return new NavigationPlan(resolution, view, NavigationOutcomeDecider.DecideDirectTransition(resolution, view));
    }

    /// <summary>
    /// Reads fresh current-world and all-loaded ordinary-warp facts, then plans
    /// only the next private edge. This path never resolves a selector,
    /// reads a reference store, publishes a receipt, or starts native movement;
    /// it relies on the binding already accepted during admission.
    /// </summary>
    internal NavigationPlan PlanNextRouteLeg()
    {
        NavigationDestinationResolution resolution = this.acceptedResolution
            ?? new NavigationDestinationResolution(null, null, null, "navigation_admission_required");
        NavigationDestinationBinding? binding = resolution.Binding;
        if (binding is null)
            return PlanWithoutLiveWorld(resolution);

        NavigationWorldView view = this.runtime.WorldSource.CurrentView(binding);
        NavigationOutcome? terminal = NavigationOutcomeDecider.DecideTerminalBeforeRouting(resolution, view);
        if (terminal is not null)
            return new NavigationPlan(resolution, view, terminal);

        INavigationConnectivitySource? connectivity = this.runtime.ConnectivitySource;
        string reason = "connectivity_unavailable";
        NavigationOrdinaryWarpTopology? topology = null;
        if (connectivity is null || !connectivity.TryCreateCurrentOrdinaryWarpTopology(binding, out topology, out reason))
            return new NavigationPlan(resolution, view, new NavigationOutcome(
                ExecutionState.Blocked,
                "destination_access_indeterminate",
                $"destination={resolution.DisplayLabel ?? "destination"};topology={reason}"));

        NavigationRoutePlanResult route = new NavigationRoutePlanner().Plan(
            topology!, view.CurrentSourceLocation!, binding);
        NavigationOutcome outcome = route.Kind switch
        {
            NavigationRoutePlanKind.Arrived => new NavigationOutcome(
                ExecutionState.Succeeded,
                "navigation_completed",
                $"destination={resolution.DisplayLabel ?? "destination"};location={view.CurrentSourceLocation};arrived=true;postcondition=true"),
            NavigationRoutePlanKind.NextEdge => new NavigationOutcome(ExecutionState.Running, "accepted", null, route.NextLeg),
            _ => MapTopologyTerminal(resolution, route.ReasonCode),
        };
        return new NavigationPlan(resolution, view, outcome);
    }

    private static NavigationPlan PlanWithoutLiveWorld(NavigationDestinationResolution resolution)
    {
        var emptyView = new NavigationWorldView(
            false, false, null, 0, 0, false,
            Array.Empty<NavigationTransitionLeg>(), false, false, false, false);
        return new NavigationPlan(resolution, emptyView, NavigationOutcomeDecider.DecideTerminalBeforeRouting(resolution, emptyView)!);
    }

    private static NavigationOutcome MapTopologyTerminal(
        NavigationDestinationResolution resolution,
        string reasonCode) => reasonCode switch
    {
        "destination_unreachable" => new NavigationOutcome(
            ExecutionState.Blocked, reasonCode,
            $"destination={resolution.DisplayLabel ?? "destination"};topology=unreachable"),
        "destination_identity_invalid" => new NavigationOutcome(
            ExecutionState.Rejected, "destination_selector_invalid",
            $"destination={resolution.DisplayLabel ?? "destination"};topology=destination_identity_invalid"),
        _ => new NavigationOutcome(
            ExecutionState.Blocked, "destination_access_indeterminate",
            $"destination={resolution.DisplayLabel ?? "destination"};topology={reasonCode}"),
    };

    private static NavigationDestinationResolution Resolve(
        NavigationDestinationSelector selector,
        DerivedDestinationSet set,
        NavigationBindingContext context,
        NavigationReferenceStore references)
    {
        if (selector.Kind == "ref")
        {
            if (!references.TryResolveDestination(selector, context, out NavigationDestinationBinding? binding, out string reasonCode))
                return new NavigationDestinationResolution(null, null, null, MapRefFailure(reasonCode));
            string? label = set.SearchDestinations.FirstOrDefault(
                destination => destination.CanonicalIdentity == binding!.CanonicalDestinationIdentity)?.CanonicalLabel;
            return new NavigationDestinationResolution(null, binding!, label, null);
        }

        // Label selectors must be provably unique in the current generation.
        NavigationDestination? match = set.SearchDestinations.FirstOrDefault(
            destination => StringComparer.Ordinal.Equals(destination.CanonicalLabel, selector.Label));
        if (match is null)
            return new NavigationDestinationResolution(null, null, selector.Label, "destination_selector_invalid");
        int matches = set.SearchDestinations.Count(destination =>
            destination.CanonicalLabel == selector.Label
            || (destination.ExplicitAliases is not null && destination.ExplicitAliases.Contains(selector.Label, StringComparer.Ordinal)));
        if (matches != 1)
            return new NavigationDestinationResolution(null, null, selector.Label, "destination_selector_ambiguous");
        return new NavigationDestinationResolution(
            null,
            new NavigationDestinationBinding("stardew", match.CanonicalIdentity, context.SourceGeneration, context.ObservationSequence),
            match.CanonicalLabel,
            null);
    }

    private static string MapRefFailure(string reason) => reason switch
    {
        "destination_ref_stale" => "destination_selector_stale",
        "destination_ref_invalid" => "destination_selector_invalid",
        _ => "destination_selector_invalid",
    };
}