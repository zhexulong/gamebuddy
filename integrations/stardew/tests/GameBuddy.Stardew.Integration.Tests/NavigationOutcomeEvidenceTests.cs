using FluentAssertions;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// L3 evidence stays on the existing key/value detail channel. These tests use
/// the decider's narrow probe seam so no game process or mutable Game1 state is
/// needed to verify evidence shape.
/// </summary>
public sealed class NavigationOutcomeEvidenceTests
{
    [Fact]
    public void BoundaryExcludedWithoutAccessFact_RemainsConservative()
    {
        NavigationOutcome outcome = Decide(accessEvidenceProbe: null);

        outcome.TerminalReasonCode.Should().Be("destination_unreachable");
        outcome.Evidence.Should().Be("destination=Desert;boundary=excluded");
        outcome.Evidence.Should().NotContain("accessible=");
        outcome.Evidence.Should().NotContain("gate_closed=");
    }

    [Fact]
    public void BoundaryExcludedWithNativeAccessBool_ProjectsAccessibleFact()
    {
        NavigationOutcome outcome = Decide(_ => new NavigationDestinationAccessEvidence(false, null));

        outcome.TerminalReasonCode.Should().Be("destination_unreachable");
        outcome.Evidence.Should().Be("destination=Desert;boundary=excluded;accessible=false");
    }

    [Fact]
    public void BoundaryExcludedWithNativeAccessibleTrue_DoesNotClaimAnAccessFailure()
    {
        NavigationOutcome outcome = Decide(_ => new NavigationDestinationAccessEvidence(true, null));

        outcome.TerminalReasonCode.Should().Be("destination_unreachable");
        outcome.Evidence.Should().Be("destination=Desert;boundary=excluded");
    }

    [Fact]
    public void BoundaryExcludedWithNamedGameGate_ProjectsOnlyTheNamedGate()
    {
        NavigationOutcome outcome = Decide(_ => new NavigationDestinationAccessEvidence(false, "ccVault"));

        outcome.TerminalReasonCode.Should().Be("destination_unreachable");
        outcome.Evidence.Should().Be("destination=Desert;boundary=excluded;gate_closed=ccVault");
        outcome.Evidence.Should().NotContain("accessible=");
    }

    private static NavigationOutcome Decide(
        Func<string, NavigationDestinationAccessEvidence?>? accessEvidenceProbe)
    {
        NavigationDestinationBinding binding = new("stardew", "Desert", "generation_01", 1);
        NavigationDestinationResolution resolution = new(binding, binding, "Desert", null);
        NavigationWorldView view = new(
            HasLivePlayer: true,
            PlayerActionable: true,
            CurrentSourceLocation: "BusStop",
            SourceX: 4,
            SourceY: 4,
            AtDestination: false,
            OrdinaryLegs: Array.Empty<NavigationTransitionLeg>(),
            BoundaryExcludesDestination: true,
            DestinationTemporarilyUnavailable: false,
            TransitionAmbiguousOrUnknown: false,
            UncorrelatedTransition: false);

        return NavigationOutcomeDecider.DecideTerminalBeforeRouting(
            resolution,
            view,
            accessEvidenceProbe)!;
    }
}
