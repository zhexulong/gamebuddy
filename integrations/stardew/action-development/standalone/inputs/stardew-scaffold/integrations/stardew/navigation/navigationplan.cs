using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Navigation;

/// <summary>
/// Private result of one Navigation planning step. It carries the current
/// resolution and source view alongside the exclusive outcome; only the outcome
/// is consumed by the execution ledger.
/// </summary>
internal sealed record NavigationPlan(
    NavigationDestinationResolution Resolution,
    NavigationWorldView View,
    NavigationOutcome Outcome)
{
    internal bool IsTerminal => this.Outcome.NextLeg is null;

    internal static NavigationPlan Blocked(string terminalReason, string detail) =>
        new(
            new NavigationDestinationResolution(null, null, null, terminalReason),
            new NavigationWorldView(
                HasLivePlayer: false,
                PlayerActionable: false,
                CurrentSourceLocation: null,
                SourceX: 0,
                SourceY: 0,
                AtDestination: false,
                OrdinaryLegs: Array.Empty<NavigationTransitionLeg>(),
                BoundaryExcludesDestination: false,
                DestinationTemporarilyUnavailable: false,
                TransitionAmbiguousOrUnknown: false,
                UncorrelatedTransition: false),
            new NavigationOutcome(ExecutionState.Blocked, terminalReason, detail));
}
