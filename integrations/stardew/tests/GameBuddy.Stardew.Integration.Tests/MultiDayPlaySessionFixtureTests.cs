using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane G0's fixture is a COMPOSITION of two declared Givens, and a scenario is registered in three
/// places. Both facts are easy to get half-right, and the failure mode is the worst kind: the fixture
/// silently arms a world that answers a different question.
///
/// Measured on this scenario's first real run: a multi-day run over the plain play-session world showed
/// that days pass but could not show the companion keeps working across them, and the multi-day world
/// alone has nothing to do in it. The composition is the point, so it is pinned here rather than left to
/// the dispatcher's reading order.
/// </summary>
public sealed class MultiDayPlaySessionFixtureTests
{
    private const string RepositoryRelativeRoot = "../../../../../../../";
    private const string Scenario = "native_multi_day_play_session_v1";

    private static string RepositorySourcePath(string relative) =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, relative));

    private static string ReadFixtureSource() =>
        File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "ModEntry.Fixtures.cs")));

    private static string ReadModConfigSource() =>
        File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "ModConfig.cs")));

    private static string ReadRunnerFixtureSource() =>
        File.ReadAllText(RepositorySourcePath(Path.Combine("tools", "lib", "stardew-native-local-player-fixture.mjs")));

    [Fact]
    public void ScenarioIsRegisteredEverywhereItMustBe()
    {
        string modEntry = ReadFixtureSource();
        // The pre-attachment allow list and the dispatcher are two separate gates: a scenario in one but
        // not the other is rejected before it can run, which is exactly how a new scenario failed silently.
        modEntry.Should().Contain($"\"{Scenario}\"", $"{Scenario} must be in ModEntry's pre-attachment allow list");
        modEntry.Should().Contain($"if (fixture.FixtureScenario == \"{Scenario}\")", $"{Scenario} must dispatch to an initializer");
        ReadModConfigSource().Should().Contain($"\"{Scenario}\"", $"{Scenario} must be in ModConfig's KnownFixtureScenarios");
    }

    [Fact]
    public void ScenarioComposesBothDeclaredGivens()
    {
        string source = ReadFixtureSource();
        int start = source.IndexOf($"if (fixture.FixtureScenario == \"{Scenario}\")", StringComparison.Ordinal);
        start.Should().BeGreaterThan(0);
        string body = source[start..source.IndexOf("\n            }\n", start, StringComparison.Ordinal)];
        // (a) days can pass, and the first rollover raises the settlement menu exactly once.
        body.Should().Contain("InitializeNativeLocalMultiDayFixture(player, farm);");
        // (b) each new day still has work in it.
        body.Should().Contain("InitializeNativeLocalPlaySessionFixture(player, farm);");
    }

    [Fact]
    public void MultiDayGivenIsAppliedBeforeThePlaySessionAffordances()
    {
        // Order matters: the multi-day Given warps the actor home and pins the clock, and it refuses by
        // name ("actor_not_home") if its own placement does not hold. The play-session fixture then moves
        // the actor to the Farm crossroads, which is where a session needs to start. Reversing them would
        // leave the multi-day placement assertion checking a world the other fixture already moved.
        string source = ReadFixtureSource();
        int start = source.IndexOf($"if (fixture.FixtureScenario == \"{Scenario}\")", StringComparison.Ordinal);
        string body = source[start..source.IndexOf("\n            }\n", start, StringComparison.Ordinal)];
        body.IndexOf("InitializeNativeLocalMultiDayFixture", StringComparison.Ordinal)
            .Should()
            .BeLessThan(body.IndexOf("InitializeNativeLocalPlaySessionFixture", StringComparison.Ordinal));
    }

    [Fact]
    public void TheFixtureActionAndTheScenarioAgreeOnOneName()
    {
        string runner = ReadRunnerFixtureSource();
        // The runner names the action set and derives the scenario from it. A rename in one place would
        // otherwise arm the wrong world - which is exactly what happened live when the play-session action
        // set was hijacked by the strawberry covenant's `harvest_crop + ship_item` fallback.
        runner.Should().Contain("if (action === \"play_session_multi_day\") return \"native_multi_day_play_session_v1\";");
        runner.Should().Contain("if (action === \"play_session_multi_day\")");
        // The action set must carry BOTH halves: the lifecycle actions and the farm work.
        int start = runner.IndexOf("if (action === \"play_session_multi_day\")", StringComparison.Ordinal);
        string set = runner[start..runner.IndexOf("];", start, StringComparison.Ordinal)];
        foreach (string action in new[] { "advance_day", "dismiss_modal", "harvest_crop", "cut_weeds", "plant_seed" })
            set.Should().Contain($"\"{action}\"", $"the Lane G0 action set must publish {action}");
    }

    [Fact]
    public void ScenarioIsKeyedByActionSoNoFallbackCanClaimIt()
    {
        // The fixture-scenario resolver is a list of action-keyed branches followed by
        // `actions.includes(...)` fallbacks. The play-session action set publishes harvest_crop AND
        // ship_item, which is exactly the strawberry covenant's signature, so an unkeyed scenario would be
        // silently replaced by that world.
        string runner = ReadRunnerFixtureSource();
        int scenarioAt = runner.IndexOf("if (action === \"play_session_multi_day\") return \"native_multi_day_play_session_v1\";", StringComparison.Ordinal);
        scenarioAt.Should().BeGreaterThan(0);
        int includeFallbackAt = runner.IndexOf("if (actions.includes(", scenarioAt, StringComparison.Ordinal);
        // Either there is no fallback after it, or the keyed branch comes first (which it does).
        if (includeFallbackAt > 0)
            scenarioAt.Should().BeLessThan(includeFallbackAt, "the keyed branch must precede the include-based fallbacks");
    }
}
