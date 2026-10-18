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
        body.Should().Contain("InitializeNativeLocalPlaySessionFixture(player, farm, new Vector2(doorStandingSpot.X, doorStandingSpot.Y));");
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
    public void TheGivenArmsARealDaysEnergyAndTheWorkThatCanSpendIt()
    {
        // The scenario must NOT manufacture stamina.
        //
        // An earlier version armed 12 points "so the fatigue/self-heal assertion stays reachable", but that threshold
        // belongs to a DIFFERENT scenario and nothing in the multi-day run reads it; two reviews found the write had no
        // reader and only made an early pass-out likelier. A later version replaced it with "MaxStamina - 90" to express
        // a mid-morning premise - and the owner rejected that too, correctly: a Stardew day starts at 06:00 with a full
        // bar, so the real fix for a world with no fatigue pressure is the WORK it can spend, never a manufactured start.
        // The pin is inverted so neither version can come back silently.
        string source = ReadMultiDayGivenSource();
        source.Should().NotContain("LowMorningStamina");
        source.Should().NotContain("player.stamina =");
        source.Should().Contain("Game1.timeOfDay = 600;");

        // ...and the world does contain work that spends the morning it really has.
        string fixture = ReadFixtureSource();
        fixture.Should().Contain("for (int index = 0; index < 10; index += 1)");
        fixture.Should().Contain("cauliflowerSeedId, 8");
    }

    [Fact]
    public void TheComposedWorldMustLetTheCompanionReachItsFrontDoor()
    {
        // Lane G0 starts with the actor home and the play-session fixture then moves it to the Farm crossroads, so
        // the composed world is only usable if the farmhouse is STILL reachable from where the session starts.
        // Each given is fine alone; measured 2026-10-17 the composition was not: the actor's cardinal component
        // was 28 tiles with the door outside it, eleven move_to_tile attempts came back no_native_path and
        // enter_exit said door_out_of_range, so the night could never begin and the turn was spent re-aiming.
        string source = ReadFixtureSource();
        source.Should().Contain("AssertNativeLocalMultiDayHomeReachable(player, farm);");
        // The start tile is chosen INSIDE the door's component, not merely checked afterwards: choosing a start in
        // a different piece of the Farm is the defect the check caught, so the choice is what had to change.
        source.Should().Contain("if (requiredReachable is { } required && !IsReachableFromStart(farm, tile, required))");
        // ...and it runs AFTER both givens, because it is the composition it checks.
        int multiDay = source.IndexOf("InitializeNativeLocalMultiDayFixture(player, farm);", StringComparison.Ordinal);
        int playSession = source.IndexOf("InitializeNativeLocalPlaySessionFixture(player, farm,", multiDay, StringComparison.Ordinal);
        int assertion = source.IndexOf("AssertNativeLocalMultiDayHomeReachable(player, farm);", playSession, StringComparison.Ordinal);
        assertion.Should().BeGreaterThan(playSession, "the check is about the composed world");

        string given = ReadMultiDayGivenSource();
        // The reachability authority is the SAME probe the refusal receipts publish, so an arm-time refusal and a
        // mid-run `no_native_path` cannot disagree about what reachable means.
        given.Should().Contain("StardewBodyController.AssessReachability(");
        given.Should().Contain("home.getPorchStandingSpot()");
        // Measured on the FARM and from the spot the actor stands on when it comes OUT, never from its own tile:
        // at arm time the actor's tile is its bed inside the house, and probing the Farm's map from an interior
        // coordinate refused every world (component_tiles=22 around the bed, measured on run g5).
        given.Should().NotContain("Point from = new((int)player.Tile.X");
        given.Should().Contain("FindNativeLocalShippingBinStandingTile(farm, bin)");
        // The refusal carries numbers rather than a verdict, and it says nothing about the ROUTE.
        given.Should().Contain("component_tiles={assessed.ComponentTiles}");
        given.Should().Contain("closest=");
        given.Should().Contain("what={what}");
        // Four outcomes, each named: unreachable, unknown (component over budget), door off map, and a bin with no
        // standing tile at all.
        given.Should().Contain("fixture_native_local_multi_day_home_unreachable:what=");
        given.Should().Contain("fixture_native_local_multi_day_home_reachability_unknown:what=");
        given.Should().Contain("fixture_native_local_multi_day_home_door_off_map:");
        given.Should().Contain("fixture_native_local_multi_day_bin_standing_tile_missing:");
        // BOTH places the day needs are checked, and the field is one of them: checking home-bin alone would not
        // have caught g4, because both are engine geometry while the FIELD is where the fixture's own props go.
        given.Should().Contain("AssertReachable(door, binStandingTile, Walkable, \"bin\");");
        given.Should().Contain("AssertReachable(door, field, Walkable, \"field\");");
        given.Should().Contain("this.nativeLocalPlaySessionStartTile is not { } fieldTile");
        // The session's start tile is the one it actually used, not one re-derived after the props exist.
        File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "ModEntry.Fixtures.cs")))
            .Should()
            .Contain("this.nativeLocalPlaySessionStartTile = startTile;");
    }

    [Fact]
    public void ThePinnedSkillsArriveWithTheirProfessionsOrTheEngineReOffersThemEveryMorning()
    {
        // Measured 2026-10-17 (run g15, from the product's own refusal evidence): pinning all five skills to 10
        // WITHOUT professions left `pending_level_ups=11` at the next morning, because the engine re-queues a missed
        // 5/10 choice for every skill that reached it (level_up=0@5;0@10;1@5;1@10;...). Ten milestone menus is not a
        // world a companion can be asked to play, and it is not the world a mature save has.
        string source = ReadMultiDayGivenSource();
        source.Should().Contain("player.professions.Add(levelFiveProfession);");
        source.Should().Contain("player.professions.Add(levelTenProfession);");
        source.Should().Contain("int levelFiveProfession = professionSkill * 6;");
        source.Should().Contain("int levelTenProfession = levelFiveProfession + 2;");
        source.Should().Contain("fixture_native_local_multi_day_profession_not_granted");
        // The arm log reports the count, so a run's own log says whether the world carried them.
        source.Should().Contain("professions={player.professions.Count}");
        source.Should().Contain("guarantee=skills_pinned_with_their_professions");
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
