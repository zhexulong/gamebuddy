using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// M2 cross-day lifecycle wiring. The intent is modelled in the gameplay catalog
/// as <c>coordinated</c>; these tests pin the two things that make the wiring
/// honest rather than a second receipt authority:
///
///  1. <c>advance_day</c> is a registered execution action with an empty argument
///     list. It carries no client-supplied target at all, because its target is
///     the actor's own bed and its readiness is native state.
///  2. It is reachable over the wire with that exact empty shape. A registered
///     action the parser rejects is a capability that can never be invoked, which
///     is the defect this pairing exists to catch.
/// </summary>
public sealed class AdvanceDayLifecycleWiringTests
{
    [Fact]
    public void AdvanceDayIsRegisteredAsAnExecutionActionWithNoArguments()
    {
        FarmhandActionRegistration? registration = FarmhandActionCatalog.Registrations
            .SingleOrDefault(candidate => candidate.ActionId == "advance_day");

        registration.Should().NotBeNull();
        registration!.Kind.Should().Be(FarmhandOperationKind.Execution);
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.WorldLifecycle);
        registration.Descriptor.Should().NotBeNull();
        registration.Descriptor!.Arguments.Should().BeEmpty();
        registration.Descriptor.Postcondition.Should().Be("day_advanced");
        registration.Descriptor.Effect.Should().Be("write");
    }

    [Fact]
    public void AdvanceDayDeclaresTheCrossDayWatchdogRatherThanTheOrdinaryOne()
    {
        FarmhandActionDescriptor descriptor = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == "advance_day").Descriptor!;

        // A co-op night waits on other players' native ready state, a save, and a
        // new-day transition, so it cannot fit the 60s ordinary-action ceiling.
        descriptor.WatchdogMs.Should().Be(FarmhandActionCatalog.LifecycleWatchdogMs);
        descriptor.WatchdogMs.Should().BeGreaterThan(FarmhandActionCatalog.DefaultWatchdogMs);
    }

    [Fact]
    public void AdvanceDayIsReachableOverTheWireWithAnEmptyArgumentList()
    {
        string[]? argumentProperties = BridgeProtocol.ExecutionArgumentProperties("advance_day");

        argumentProperties.Should().NotBeNull("a registered action the parser rejects can never be invoked");
        argumentProperties!.Should().BeEmpty();
    }

    [Fact]
    public void AdvanceDayRejectsAnyClientSuppliedArgument()
    {
        // The whole input is the actor's own bed and its native ready state, so
        // there is nothing a client may legitimately spoof or retarget.
        string[]? argumentProperties = BridgeProtocol.ExecutionArgumentProperties("advance_day");

        argumentProperties.Should().NotBeNull();
        argumentProperties!.Should().NotContain(
            new[] { "x", "y", "slot", "expectedTargetId", "expectedQualifiedItemId", "destination" });
    }
}
