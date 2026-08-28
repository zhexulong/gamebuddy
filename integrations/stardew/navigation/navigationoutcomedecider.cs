using GameBuddy.Stardew;

namespace GameBuddy.Stardew.Navigation;

/// <summary>
/// Pure, deterministic Navigation outcome decision. It maps a resolved
/// destination and a current source view to one exclusive terminal (or a single
/// next private leg) using only real source facts. It never retries an
/// attempted edge and never yields a public hop route.
/// </summary>
internal static class NavigationOutcomeDecider
{
    /// <summary>
    /// Decides one step of the Navigation execution on the game thread for the
    /// direct-transition path. Before every return the caller has revalidated
    /// current scope, capability/policy, revision/idempotency, deadline/cancel
    /// and body ownership; this function narrows the source facts to the
    /// terminal or the one leg the execution may arm next.
    /// </summary>
    internal static NavigationOutcome DecideDirectTransition(
        NavigationDestinationResolution resolution,
        NavigationWorldView view)
    {
        NavigationOutcome? terminal = DecideTerminalBeforeRouting(resolution, view);
        if (terminal is not null)
            return terminal;

        NavigationDestinationBinding binding = resolution.Binding!;
        string label = resolution.DisplayLabel ?? "destination";

        // Direct-transition path: scans ordinary legs for a matching target identity.
        NavigationTransitionLeg? next = view.OrdinaryLegs.FirstOrDefault(
            leg => leg.TargetLocation == binding.CanonicalDestinationIdentity);
        if (next is null)
        {
            string reason = view.OrdinaryLegs.Count == 0 ? "path_not_found" : "destination_unreachable";
            return new NavigationOutcome(ExecutionState.Blocked, reason,
                $"destination={label};source={view.CurrentSourceLocation}");
        }

        return new NavigationOutcome(ExecutionState.Running, "accepted", null, next);
    }

    /// <summary>
    /// Evaluates the terminal conditions shared by the direct-transition path and
    /// the accepted-destination path. A <c>null</c> result means only that a
    /// private route decision may be attempted; it does not authorize a native
    /// action.
    /// </summary>
    internal static NavigationOutcome? DecideTerminalBeforeRouting(
        NavigationDestinationResolution resolution,
        NavigationWorldView view)
    {
        if (resolution.FailureReason is not null)
            return new NavigationOutcome(ExecutionState.Rejected, resolution.FailureReason,
                $"destination={resolution.DisplayLabel ?? "unknown"};reason={resolution.FailureReason}");

        string label = resolution.DisplayLabel ?? "destination";
        if (!view.HasLivePlayer)
            return new NavigationOutcome(ExecutionState.Uncertain, "destination_access_indeterminate",
                $"destination={label};live_player=false");
        if (view.DestinationTemporarilyUnavailable)
            return new NavigationOutcome(ExecutionState.Blocked, "destination_temporarily_unavailable",
                $"destination={label};availability=temporary");
        if (!view.PlayerActionable)
            return new NavigationOutcome(ExecutionState.Rejected, "destination_locked",
                $"destination={label};actionable=false");
        if (view.BoundaryExcludesDestination)
            return new NavigationOutcome(ExecutionState.Rejected, "destination_unreachable",
                $"destination={label};boundary=excluded");
        if (view.TransitionAmbiguousOrUnknown)
            return new NavigationOutcome(ExecutionState.Blocked, "destination_access_indeterminate",
                $"destination={label};transition=unknown");
        if (view.AtDestination)
            return new NavigationOutcome(ExecutionState.Succeeded, "navigation_completed",
                $"destination={label};location={view.CurrentSourceLocation};arrived=true;postcondition=true");
        if (view.UncorrelatedTransition)
            return new NavigationOutcome(ExecutionState.Uncertain, "native_transition_uncertain",
                $"destination={label};correlated=false");
        return null;
    }
}