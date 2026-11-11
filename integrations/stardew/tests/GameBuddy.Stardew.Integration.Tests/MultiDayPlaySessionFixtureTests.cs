using System.Text.RegularExpressions;
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
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class MultiDayPlaySessionFixtureTests
{
    private const string RepositoryRelativeRoot = "../../../../../../../";
    private const string Scenario = "native_multi_day_play_session_v1";

    private static string RepositorySourcePath(string relative) =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, relative));

    /// <summary>
    /// Every fixture partial concatenated. The scenario initializers moved out of `ModEntry.Fixtures.cs` into
    /// `ModEntry.Fixtures.ScenarioInitializers.cs` (one method per scenario, dispatched from a table), so a pin that read
    /// the single file would now fail on a fact that still holds. The set is derived from the directory, so the next
    /// split cannot leave this reading a file that no longer contains the fixture.
    /// </summary>
    private static string ReadFixtureSource() => string.Join(
        "\n",
        Directory.GetFiles(
                Path.Combine(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot)), "integrations", "stardew"),
                "ModEntry.Fixtures*.cs")
            .OrderBy(path => path, StringComparer.Ordinal)
            .Select(File.ReadAllText));

    private static string ReadModConfigSource() =>
        File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "ModConfig.cs")));

    /// <summary>
    /// One scenario initializer's body, by brace balance. The dispatch is a table now (each scenario is a row naming its
    /// own initializer in `ModEntry.Fixtures.ScenarioInitializers.cs`), so a scenario's Given is the body of the method its
    /// row names rather than a branch of one `if` chain.
    /// </summary>
    private static string InitializerBody(string declaration)
    {
        string source = ReadFixtureSource();
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"initializer not found: {declaration}");
        int open = source.IndexOf('{', start);
        int depth = 0;
        for (int i = open; i < source.Length; i++)
        {
            if (source[i] == '{')
                depth++;
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                    return source[start..(i + 1)];
            }
        }
        throw new InvalidOperationException($"unbalanced body: {declaration}");
    }

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
        modEntry.Should().Contain(
            $"NativeLocalFixtureScenarioRow.ActorPrepared(\"{Scenario}\", static (mod, player, farm, _) => mod.InitializeNativeLocalMultiDayPlaySessionFixture(player, farm))",
            $"{Scenario} must dispatch to an initializer");
        ReadModConfigSource().Should().Contain($"\"{Scenario}\"", $"{Scenario} must be in ModConfig's KnownFixtureScenarios");
    }

    [Fact]
    public void ScenarioComposesBothDeclaredGivens()
    {
        string body = InitializerBody("private void InitializeNativeLocalMultiDayPlaySessionFixture(");
        // (a) days can pass, and the first rollover raises the settlement menu exactly once.
        body.Should().Contain("InitializeNativeLocalMultiDayFixture(player, farm);");
        // (b) each new day still has work in it.
        body.Should().Contain("InitializeNativeLocalPlaySessionFixture(");
body.Should().Contain("startAtHome: true);");
body.Should().Contain("new Vector2(doorStandingSpot.X, doorStandingSpot.Y),");
    }

    [Fact]
    public void TheGivenStartsHerSkillsWhereANewSaveStartsThem()
    {
        // The shortcut this replaces: every skill pinned to 10 (with the ten professions that implies) so the night's own
        // LevelUpMenu could not arrive. A maxed skill cannot level again, so the shortcut made the level-up path
        // unprovable in the one world that runs several nights - and it described a farmer nobody plays, because real work
        // levels Farming and Foraging within the first days.
        string source = ReadMultiDayGivenSource();
        source.Should().NotContain("setSkillLevel(skill, 10)", "that pin is what kept the menu from ever appearing");
        source.Should().NotContain("skills_pinned=", "the arm log must report the skills the run has, not a pin");
        source.Should().NotContain("mastery_hint", "no mastery hint can fire in a level-0 world, so nothing may report one");

        // A new save's five skills at 0, with the experience each level's base is read against, and nothing else on them.
        foreach (string skill in new[] { "farmingLevel", "fishingLevel", "foragingLevel", "miningLevel", "combatLevel" })
            source.Should().Contain($"player.{skill}.Value = 0;", $"{skill} must start where a new save starts it");
        source.Should().Contain("player.experiencePoints[skill] = 0;");
        // A new save carries no professions, and the branch world needs both level-5 cards to be live choices.
        source.Should().Contain("player.professions.Clear();");
        source.Should().Contain("fixture_native_local_multi_day_professions_not_cleared");
        // The starting point is ASSERTED, not assumed: a save that arrived with a level on it would change the question.
        source.Should().Contain("fixture_native_local_multi_day_skills_not_reset");
        source.Should().Contain("player.newLevels.Clear();");
        source.Should().Contain("fixture_native_local_multi_day_pending_level_up");

        // The arm log names the property the world now has instead of the lock it used to carry.
        source.Should().Contain("guarantee=her_work_may_raise_one_and_respond_level_up_answers_it");
        source.Should().Contain("skills={skills}", "the reported skills are the player's own fields, read back after the write");

        // And the branch world still arms its MILESTONE from below it, so both candidates are live choices.
        source.Should().Contain("player.setSkillLevel(MilestoneSkillName, MilestoneLevel - 1)");
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
        // The counts come from the ground now, not from a literal: `stoneCount` is derived so that a farm with less
        // walkable room still arms. Pinning "10" here would re-introduce the fixed budget this whole change removed,
        // so the assertion names the shape instead - a loop over a count, plus the seed the crops are planted with.
        fixture.Should().Contain("for (int index = 0; index < stoneCount; index += 1)");
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
        int playSession = source.IndexOf("InitializeNativeLocalPlaySessionFixture(", multiDay, StringComparison.Ordinal);
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
        //
        // The calls are READ out of the given rather than spelled here. 2026-11-09 lifted the predicate out of a local
        // function (`Walkable`) into `NativeLocalMultiDayWalkable(farm)`, and an assertion that quotes the delegate's
        // name pins a spelling instead of the property: it was green before that commit and red after it while the
        // checks themselves were unchanged. The property is that each place is checked against the place it belongs
        // to, and that ONE predicate answers for both - two copies of the rule is what severed the door->field route.
        var reachabilityCalls = Regex.Matches(given, @"AssertReachable\(door, (?<target>\w+), (?<walkable>\w+), ""(?<what>\w+)""\);")
            .Cast<Match>()
            .ToArray();
        reachabilityCalls
            .Select(call => $"{call.Groups["what"].Value}={call.Groups["target"].Value}")
            .Should()
            .BeEquivalentTo(
                new[] { "bin=binStandingTile", "field=field" },
                "the arm-time check covers both places the day needs, each against its own tile");
        var predicates = reachabilityCalls.Select(call => call.Groups["walkable"].Value).Distinct().ToArray();
        predicates.Should().ContainSingle(
            "one predicate answers for both places, so an arm-time refusal and a mid-run no_native_path cannot disagree");
        var sharedFactory = Regex.Match(given, @"Func<Point, bool> (?<name>\w+) = NativeLocalMultiDayWalkable\(farm\);");
        sharedFactory.Success.Should().BeTrue("the predicate is the shared rule, not a private copy of it");
        predicates[0].Should().Be(sharedFactory.Groups["name"].Value, "both calls are handed that one delegate");
        given.Should().Contain("this.nativeLocalPlaySessionStartTile is not { } fieldTile");
        // The session's start tile is the one it actually used, not one re-derived after the props exist.
        File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "ModEntry.Fixtures.cs")))
            .Should()
            .Contain("this.nativeLocalPlaySessionStartTile = startTile;");
    }

    [Fact]
    public void TheBranchWorldsMilestoneIsTheOnePendingLevelUp()
    {
        // Measured 2026-10-17 (run g15, from the product's own refusal evidence): pinning skills to 10 WITHOUT professions
        // left `pending_level_ups=11` at the next morning, because the engine re-queues a missed 5/10 choice. The lock that
        // produced that is gone; what remains to pin is the only entry this Given still arms by hand - the branch world's
        // milestone, which is what `respond_level_up`'s profession half has to be shown.
        string source = ReadMultiDayGivenSource();
        source.Should().Contain("player.newLevels.Add(new Point(PendingLevelUpSkill, MilestoneLevel));");
        source.Should().Contain("fixture_native_local_multi_day_pending_level_up_not_armed");
        // The ordinary world arms nothing: a hand-written entry would prove that a queue entry can be answered, never that
        // her own work raises one.
        // The arm log reports the count and the pair, so a run's own log says what the night will ask about.
        source.Should().Contain("pending_level_ups={player.newLevels.Count}");
        source.Should().Contain("pending_level_up=");
    }

    [Fact]
    public void MultiDayGivenIsAppliedBeforeThePlaySessionAffordances()
    {
        // Order matters: the multi-day Given warps the actor home and pins the clock, and it refuses by
        // name ("actor_not_home") if its own placement does not hold. The play-session fixture then moves
        // the actor to the Farm crossroads, which is where a session needs to start. Reversing them would
        // leave the multi-day placement assertion checking a world the other fixture already moved.
        string body = InitializerBody("private void InitializeNativeLocalMultiDayPlaySessionFixture(");
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
        foreach (string action in new[] { "sleep", "dismiss_modal", "harvest_crop", "cut_weeds", "plant_seed" })
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
