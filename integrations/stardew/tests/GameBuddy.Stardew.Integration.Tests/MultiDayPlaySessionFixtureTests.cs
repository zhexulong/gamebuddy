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

    private static string ReadMultiDayGivenSource() =>
        File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "ModEntry.Fixtures.MultiDay.cs")));

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
    public void TheGivenPinsEverySkillSoNoLevelUpMenuCanArriveMidRun()
    {
        // `showEndOfNightStuff` pushes one LevelUpMenu per entry in `player.newLevels` (Game1.cs:9130-9134), and that
        // menu is correctly NOT dismissible - its close hook writes the level perk. Refusing a PENDING level-up was
        // not enough: the companion earns experience while it works, so a mid-run level-up would arm the very menu
        // the run cannot pass. A maxed skill cannot level again, which is what makes the guarantee structural.
        string source = ReadMultiDayGivenSource();
        source.Should().Contain("PinnedSkills = { \"Farming\", \"Fishing\", \"Foraging\", \"Mining\", \"Combat\" }");
        source.Should().Contain("player.setSkillLevel(skill, 10)", "the engine's own setter keeps experiencePoints consistent");
        // Every pin is asserted, and the notices the pin itself queued are cleared and re-asserted empty.
        source.Should().Contain("fixture_native_local_multi_day_skills_not_maxed");
        source.Should().Contain("player.newLevels.Clear();");
        source.Should().Contain("fixture_native_local_multi_day_pending_level_up");
        // The mastery side effect of five maxed skills is a REAL persistent write (Game1.cs:9135-9141), so it is
        // reported rather than left to be discovered on the first rollover.
        source.Should().Contain("\"gotMasteryHint\"");
        source.Should().Contain("mastery_hint_already_armed=");
        source.Should().Contain("mastery_cave_visited=");
        source.Should().Contain("guarantee=first_rollover_may_add_gotMasteryHint");
    }

    [Fact]
    public void TheGivenKeepsTheFatigueAssertionReachableWithMaxedSkills()
    {
        // With every skill maxed the tools cost meaningfully less energy, so an ordinary morning may never reach a
        // low-stamina threshold and the fatigue/self-heal assertion would become untestable. The construction is a
        // direct stamina write (the same technique the attach-time fixtures already use) below the runner's low
        // threshold and well above the -15 pass-out floor - the game's own energy economy stays untouched.
        string source = ReadMultiDayGivenSource();
        source.Should().Contain("private const float LowMorningStamina = 12f;");
        source.Should().Contain("player.stamina = LowMorningStamina;");
        source.Should().Contain("fixture_native_local_multi_day_stamina_not_armed");
        source.Should().Contain("stamina={player.stamina}");
        // 12 is above the native pass-out floor, so the actor is tired rather than collapapsed.
        source.Should().NotContain("player.stamina = -15");
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
