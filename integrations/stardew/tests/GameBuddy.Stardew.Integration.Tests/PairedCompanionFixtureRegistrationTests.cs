using System.Reflection;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `native_paired_companion_v1` must be DISPATCHABLE by the HostAutomation registry, because that registry's null answer
/// is not "no fixture" - it is an endless wait.
///
/// <para>
/// The failure this pins was measured, not imagined: the scenario was declared in the native-local row table (the
/// single-player lane) and written into <c>NativeLocalFixtureScenarios</c>, and the HostAutomation dispatcher had no entry
/// for it. `TryInitializeNativeFixtureScenario` therefore returned without ever setting
/// <c>hostAutomationFixtureInitialized</c>, the tick gate that holds the LAN server waits on exactly that field
/// (`ModEntry.Fixtures.cs`), and the Host sat in the fixture wait while the driver waited for a readiness marker the Host
/// could never print.
/// </para>
///
/// <para>
/// The registry is read by reflection because it is a private static of the ModEntry partial - the dispatch itself is the
/// only caller, and the test must ask the SAME function the dispatch asks rather than a copy of its table. The two facts
/// asserted are the two a null answer loses: the phase the row runs in (the world needs the FINAL Farm, so
/// <c>AfterSharedValidation</c>) and the initializer it names.
/// </para>
/// </summary>
public sealed class PairedCompanionFixtureRegistrationTests
{
    private const string Scenario = "native_paired_companion_v1";

    private static object? Registration(string scenario) =>
        typeof(ModEntry)
            .GetMethod("ResolveHostAutomationFixtureRegistration", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, new object[] { scenario });

    [Fact]
    public void TheHostAutomationDispatcherArmsThePairedWorld()
    {
        object? registration = Registration(Scenario);

        registration.Should().NotBeNull(
            "a null registration leaves `hostAutomationFixtureInitialized` false for a paired launch, so the Host never starts its LAN server and the run ends in an endless fixture wait");
        registration!.GetType().GetProperty("Phase")!.GetValue(registration)!.ToString().Should().Be(
            "AfterSharedValidation",
            "the crop, the container and the bound farmhand's Cabin only all exist on the Farm the shared validation has already read");
        registration.GetType().GetProperty("Initialize")!.GetValue(registration).Should().NotBeNull(
            "the row must name the initializer that builds the world, not just a phase");
    }

    /// <summary>
    /// The other direction, so the assertion above cannot pass by matching everything: a scenario no row declares still
    /// resolves to nothing, which is what makes the dispatcher's silence mean "this build does not own that world".
    /// </summary>
    [Fact]
    public void AScenarioWithNoRowStillResolvesToNothing() => Registration("native_nothing_declares_this_v1").Should().BeNull();
}
