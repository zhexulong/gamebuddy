using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The scenario population, held against itself: the config's closed set, the dispatch table's keys, and the two
/// scenarios a different dispatcher owns.
///
/// WHY THIS EXISTS. The pre-attachment scenarios used to be one `if` chain in `ModEntry.Fixtures.cs` whose last branch
/// carried no guard - it was the chain's `else`. A scenario with no branch of its own therefore built THAT world, the
/// `native_water_crop_v1` Given: arming `native_farmhand_chat_v1` created dry unwatered crops on the Farm and logged a
/// water-crop initialisation, so any chat fixture written against it had been testing water_crop while claiming
/// otherwise. The table replaced that default with a refusal, and these assertions are what keep a second silent
/// fall-through from appearing: a scenario that gains no initializer fails here, naming itself, instead of turning up in
/// some other scenario's world.
///
/// The two populations are read from their real declarations - `ModEntry.NativeLocalFixtureScenarioNames` (the folded
/// table, so a duplicated row throws while reading it) and `NativeLocalPlayerFixtureConfig.NativeLocalFixtureScenarios`
/// (the config's own list) - never from source text, because a pin on a spelling stops meaning anything the moment the
/// spelling moves and says nothing about the world that gets built.
/// </summary>
public sealed class NativeLocalFixtureScenarioPopulationTests
{
    /// <summary>
    /// The scenarios whose Given the HOST-AUTOMATION dispatcher owns. Named here so a third scenario arriving without a
    /// native-local initializer has to argue with this list rather than slip into a neighbour's world.
    /// </summary>
    private static readonly string[] HostAutomationOwnedScenarios = { "native_farmhand_chat_v1", "native_farmhand_talk_to_npc_v1" };

    [Fact]
    public void DispatchTable_CoversExactlyTheScenariosTheConfigDeclares()
    {
        string[] uninitialised = NativeLocalPlayerFixtureConfig.NativeLocalFixtureScenarios
            .Except(ModEntry.NativeLocalFixtureScenarioNames, StringComparer.Ordinal)
            .ToArray();
        uninitialised.Should().BeEmpty(
            "every scenario the native-local config accepts needs an initializer, and these have none: {0}",
            string.Join(", ", uninitialised));

        string[] unaccepted = ModEntry.NativeLocalFixtureScenarioNames
            .Except(NativeLocalPlayerFixtureConfig.NativeLocalFixtureScenarios, StringComparer.Ordinal)
            .ToArray();
        unaccepted.Should().BeEmpty(
            "an initializer for a scenario the config refuses is a world no configuration can ask for: {0}",
            string.Join(", ", unaccepted));

        ModEntry.NativeLocalFixtureScenarioNames.Should().OnlyHaveUniqueItems(
            "two rows for one scenario would make the world it builds depend on declaration order, and the fold refuses that at start-up");
    }

    [Fact]
    public void KnownScenarios_AreTheDispatchTablePlusExactlyTheTwoTheHostAutomationDispatcherOwns()
    {
        string[] withoutInitializer = NativeLocalPlayerFixtureConfig.KnownFixtureScenarios
            .Except(ModEntry.NativeLocalFixtureScenarioNames, StringComparer.Ordinal)
            .ToArray();

        withoutInitializer.Should().BeEquivalentTo(
            HostAutomationOwnedScenarios,
            "the native-local dispatcher initialises every known scenario except the two whose Given the host-automation dispatcher owns (ModEntry.ResolveHostAutomationFixtureRegistration); anything else appearing here is a scenario that would otherwise build another scenario's world");
    }

    [Fact]
    public void ArmedFixture_RefusesTheHostAutomationScenarios_WhileSaveCreationStillAcceptsThem()
    {
        foreach (string scenario in HostAutomationOwnedScenarios)
        {
            NativeLocalPlayerFixtureConfig armed = Armed(scenario);
            armed.IsHostAutomationOwnedScenario.Should().BeTrue($"{scenario} is the host-automation dispatcher's Given");
            armed.IsValid.Should().BeFalse(
                $"an armed native-local fixture has no initializer for {scenario}, so accepting the configuration would build a world nobody declared");

            Bootstrapped(scenario).IsBootstrapValid.Should().BeTrue(
                $"a disposable save is exactly what the native-local fixture contributes to {scenario}");
        }

        foreach (string scenario in NativeLocalPlayerFixtureConfig.NativeLocalFixtureScenarios)
        {
            NativeLocalPlayerFixtureConfig armed = Armed(scenario);
            armed.IsValid.Should().BeTrue($"{scenario} is a scenario this fixture declares an initializer for");
            armed.IsHostAutomationOwnedScenario.Should().BeFalse($"{scenario} is not one of the host-automation dispatcher's Givens");
        }
    }

    private static NativeLocalPlayerFixtureConfig Armed(string scenario) => new()
    {
        Enable = true,
        LogicalSaveName = "GameBuddyFixtureAlpha",
        ObservedSaveSlot = "GameBuddyFixtureAlpha_123456",
        FixtureScenario = scenario,
    };

    private static NativeLocalPlayerFixtureConfig Bootstrapped(string scenario) => new()
    {
        Enable = true,
        FixtureScenario = scenario,
        Bootstrap = new NativeLocalPlayerFixtureBootstrapConfig { Enable = true, SaveName = "GameBuddyFixtureAlpha", PlayerName = "GameBuddy" },
    };
}
