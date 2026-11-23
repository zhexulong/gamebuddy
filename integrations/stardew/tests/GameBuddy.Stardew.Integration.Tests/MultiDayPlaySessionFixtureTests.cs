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
    private static IReadOnlyList<string> FixtureSourcePaths() =>
        Directory.GetFiles(
                Path.Combine(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot)), "integrations", "stardew"),
                "ModEntry.Fixtures*.cs")
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToArray();

    private static string ReadFixtureSource() =>
        string.Join("\n", FixtureSourcePaths().Select(File.ReadAllText));

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
        // The counts come from the ground now, not from a literal: the budget is a capacity divided out of the tiles the
        // props may use, so a farm with less walkable room still arms. Pinning "10" here would re-introduce the fixed
        // budget this whole change removed, so the assertion names the shape instead - a budget read off the ground, a
        // loop over the count it produced, plus the seed the crops are planted with.
        fixture.Should().Contain("int propBudget = PropCapacity.For(freeAfterReservations);");
        fixture.Should().Contain("for (int index = 0; index < remaining; index += 1)");
        fixture.Should().Contain("cauliflowerSeedId, 8");
    }

    /// <summary>
    /// THE DAY'S LOAD-BEARING MEMBERS ARE PLACED BEFORE THE SWEEP, FROM OPEN GROUND.
    ///
    /// MEASURED 2026-11-23, the launch this order answers: <c>dropped 5 prop(s) a later placement cut off:
    /// scenery=forage@8,36;weed@9,35;stone@9,34;stone@9,33; load_bearing=forage@8,35&gt;forageTargets</c>. The refusal
    /// was right - <c>forage_and_trees</c> addresses <c>forageTargets</c> and the family was empty - but the reason the
    /// last forage prop was in the pocket at all is the ORDER: the props are laid nearest-the-actor-first, and a pocket
    /// is the nearest ground there is. One member of every family therefore goes down first, from the openest ground the
    /// piece holds, and the near-first sweep spends what is left.
    ///
    /// <para>
    /// The population is <c>PlaySessionPropFamilies.All</c> - the fixture's own declaration - so a seventh family is
    /// inside both passes the moment it is added, and the order between them is read out of the initializer's body
    /// because no compiler can state "this pass runs before that loop".
    /// </para>
    /// </summary>
    [Fact]
    public void EveryFamilyTheDayNamesReservesOneMemberBeforeTheSweepSpendsTheGround()
    {
        string body = InitializerBody("private void InitializeNativeLocalPlaySessionFixture(");

        int reservation = body.IndexOf(
            "if (!TryPlacePlaySessionProp(family, clearance, out Vector2 reservedAt, out string? refusal))",
            StringComparison.Ordinal);
        int sweep = body.IndexOf("TryPlacePlaySessionProp(family, clearance: null,", StringComparison.Ordinal);
        reservation.Should().BeGreaterThanOrEqualTo(0, "the world must place one member of every family before the sweep runs");
        sweep.Should().BeGreaterThan(reservation, "the near-first sweep may only spend what the reservations left");
        // Both passes walk the DECLARATION, so no family can be added to the world and left out of either.
        body.Should().Contain("foreach (string family in PlaySessionPropFamilies.All)");
        body.Should().Contain(
            "ClearanceFromPieceEdge(walkablePiece)",
            "a reserved member is placed on the openest ground the piece holds, never on the floor of a pocket");

        // A FAMILY NO WORLD CAN HOLD IS A TASK THE ROTATION SHOULD NOT SCHEDULE: the refusal names the family, the
        // published family it would have filled, and the reason - one family per world, not one failure per prop loop.
        body.Should().Contain("fixture_native_local_play_session_reserved_prop_unplaceable:family=");
        body.Should().Contain("reason={refusal}");
        // ...and the arm log says which families got a reserved member and where, one row per FAMILY the day names.
        body.Should().Contain("string.Join(\";\", reserved)", "the reservation is printed, or a good launch cannot say where the day's families stand");
        // The sweep's own refusal is unchanged and still earned: a family that loses its last standing member is the one
        // case where a dropped prop is the day's loss rather than scenery.
        body.Should().Contain("fixture_native_local_play_session_world_too_fragmented:");
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
        source.Should().Contain("AssertNativeLocalMultiDayHomeReachable(player, farm, this.nativeLocalPlaySessionAnimalDoor);");
        // The start tile is chosen INSIDE the door's component, not merely checked afterwards: choosing a start in
        // a different piece of the Farm is the defect the check caught, so the choice is what had to change.
        source.Should().Contain("if (requiredReachable is { } required && !IsReachableFromStart(farm, tile, required))");
        // ...and it runs AFTER both givens, because it is the composition it checks.
        int multiDay = source.IndexOf("InitializeNativeLocalMultiDayFixture(player, farm);", StringComparison.Ordinal);
        int playSession = source.IndexOf("InitializeNativeLocalPlaySessionFixture(", multiDay, StringComparison.Ordinal);
        int assertion = source.IndexOf("AssertNativeLocalMultiDayHomeReachable(player, farm, this.nativeLocalPlaySessionAnimalDoor);", playSession, StringComparison.Ordinal);
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
        // The refusal carries numbers rather than a verdict: the flood's component size and the tile it got closest
        // with, not a route.
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
    public void TheComposedWorldMustAlsoReachTheAnimalHousePorch()
    {
        // THE DEFECT CLASS this answers: the animal house's own four neighbours were judged, never the road to them -
        // and the ring was judged on the field BEFORE the props that spend it. Measured round93 (2026-11-22): 26
        // minutes, 233 bridge facts, `Barn 0` / `Coop 0`, and no assertion had asked whether the farmhouse could walk
        // to the building at all. The route itself is pinned by `AnimalBuildingPorchRouteTests`; what is pinned here is
        // that the arm-time assertion asks it, of the right building, with the world's one walkability rule.
        string source = ReadFixtureSource();
        // The door is the one the animal Given actually placed, recorded for the assertion that runs after the props.
        source.Should().Contain("this.nativeLocalPlaySessionAnimalDoor = door;");
        // ...and the site search asks about the CANDIDATE's door, so a site that seals its own road is refused while
        // the search is still looking rather than after the day has armed on it.
        source.Should().Contain("AssertNativeLocalMultiDayHomeReachable(player, farm, door);");

        string given = ReadMultiDayGivenSource();
        given.Should().Contain("AssertNativeLocalMultiDayAnimalPorchReachable(");
        // ...and the assertion must actually CALL it, with the world's own tile kind: this pin read the helper's
        // declaration and stayed green when the call was deleted (seen red 2026-11-22, injected), so it names the
        // argument the declaration does not carry.
        given.Should().Contain("tile => NativeLocalMultiDayTileKind(farm, tile)");
        // The refusal names the tile the road stopped at and what stands there: a bare boolean is what let round93 arm.
        given.Should().Contain("animal_building_unreachable_from_house:door=");
        given.Should().Contain("blocked_at={road.BlockedAt.X},{road.BlockedAt.Y};why=");
        // The kind is the layer a refusal receipt publishes as `blocked_by`, not a second table of tile kinds.
        given.Should().Contain("StardewBodyController.DescribeTargetOccupant(");
        // A world with no animal house to walk to is not one this assertion may pass silently.
        given.Should().Contain("fixture_native_local_multi_day_animal_house_door_unrecorded");
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
    public void TheAnimalHouseIsSitedBeforeThePropsSpendTheGround()
    {
        // THE INVARIANT: the play-session world sites its one BUILDING before it places any prop. A barn is a 7x4
        // footprint of ground with nothing on it, and the prop search is ordered nearest-the-start-first, so a house
        // sited after the props competes for exactly the pocket they have already spent.
        //
        // Measured round93 (2026-11-22, SMAPI log `GameBuddy`):
        // `fixture_native_local_play_session_animal_site_missing:start=56,11;free_footprints=0;rejected=none` - the
        // coop had fitted in what the props left, the barn that replaced it needs ten tiles more, and the launcher
        // waited out its pipe timeout on a world that could never arm. That refusal had a second cause (the ground the
        // search was judging carried `SpreadDirt`'s soil - see `ThePlaySessionGivenLeavesTheGroundUntilled`), so the
        // order below is one of two things round93 needed, not the fix by itself. It is still the right order: the props
        // are placed nearest-the-crossroads-first, so the building must choose its ground before they spend it. No
        // compiler can state "this Given runs before those loops", so the order is read out of the initializer's own
        // body.
        string body = InitializerBody("private void InitializeNativeLocalPlaySessionFixture(");
        int animal = body.IndexOf("InstallNativeLocalPlaySessionAnimalGiven(", StringComparison.Ordinal);
        int firstProp = body.IndexOf("FindNativeLocalPlaySessionSpot(", StringComparison.Ordinal);
        animal.Should().BeGreaterThanOrEqualTo(0, "the play-session world must carry the animal Given at all");
        firstProp.Should().BeGreaterThanOrEqualTo(0, "the props are placed by that search");
        animal.Should().BeLessThan(
            firstProp,
            "a barn needs a 7x4 footprint and the props are placed nearest-the-start-first, so a house sited after them "
                + "competes for the pocket they have already spent (round93: free_footprints=0)");
    }

    [Fact]
    public void TheAnimalHouseIsBuiltFromTheEngineTableAtAFixedSiteNearTheFarmhouse()
    {
        // SIX LAUNCHES DIED ON A SEARCHED SITE (2026-11-22/23): no ground at `56,11` (the fixture's own soil), then no
        // vacancy under the props, then `object=2332` of 5195 candidates counted as walls, and finally a barn whose door
        // stood sixty tiles from the farmhouse porch (`animal_building_unreachable_from_house:door=66,15;porch=6,37`).
        // Each repair answered a footprint the search had picked. The fixture now GIVES the site, the way a player chooses
        // where a barn goes before buying it - and it builds the barn the way the mannequin taught a fixture must build
        // anything it authors: from the engine's own data table.
        string given = InitializerBody("private void InstallNativeLocalPlaySessionAnimalGiven(");
        string source = ReadFixtureSource();

        // (a) THE ROW, from `Data/Buildings`, refused by name when the table has none.
        given.Should().Contain(
            "BuildingData data = RequireNativeLocalPlaySessionAnimalBuildingData();",
            "the barn's footprint, door and indoor map are the row's, not this file's");
        string data = InitializerBody("private static BuildingData RequireNativeLocalPlaySessionAnimalBuildingData(");
        data.Should().Contain("Game1.buildingData.TryGetValue(PlaySessionAnimalBuildingType, out BuildingData? row)");
        data.Should().Contain("Data/Buildings", "the refusal names the table it read");
        data.Should().Contain("row_missing", "a table without the row is a named refusal, not a hand-built barn");
        data.Should().Contain("table_missing");

        // (b) THE SITE, a fixed offset from the farmhouse door the day's own route assertion starts from.
        source.Should().Contain("private static readonly Vector2 PlaySessionAnimalHouseDoorOffset = new(1f, 3f);");
        given.Should().Contain("Point site = PlaySessionAnimalFixedSite(player, farm, out Point houseDoor);");
        string siteHelper = InitializerBody("private static Point PlaySessionAnimalFixedSite(");
        siteHelper.Should().Contain("houseDoor = NativeLocalMultiDayDoorStandingSpot(player, farm);");
        siteHelper.Should().Contain(
            "houseDoor.X + (int)PlaySessionAnimalHouseDoorOffset.X",
            "one tile east of the house door, so the site and the walk to it are about the same farmhouse");

        // (c) THE EMPTIEST THING A FIXTURE MAY DO TO THE GROUND: the footprint and the door ring, cleared of what a
        // published action opens (`PlaySessionAnimalFootprintWall` is the classifier) and of nothing else.
        given.Should().Contain("int cleared = ClearPlaySessionAnimalSite(farm, footprint, ring, site, door);");
        string clearing = InitializerBody("private static int ClearPlaySessionAnimalSite(");
        clearing.Should().Contain("PlaySessionAnimalFootprintFirstWall(farm, owned, out Vector2 wallTile, out _)");
        clearing.Should().Contain("ClearPlaySessionAnimalFootprint(farm, owned, clearedKinds, out string? failure)");
        clearing.Should().Contain("animal_site_wall", "a tile no published action opens refuses the day by name");
        given.Should().Contain("PlaySessionFixturePlacement.DoorApproachTiles(door)", "the door ring is the second list");

        // (d) THE ENGINE'S OWN PLACEMENT RULE decides whether the fixed tile is placeable - `buildStructure`'s footprint,
        // additional placement tiles and human-door rule - and a tile it refuses stops the Given, naming the tile.
        given.Should().Contain("ExecutionManager.FindFarmBuildingSiteBlockage(farm, data, site.X, site.Y)");
        given.Should().Contain("fixture_native_local_play_session_animal_site_blocked:row=");
        given.Should().Contain("tile={blocked.X},{blocked.Y};rule={blocked.Why}");

        // (e) NO SEARCH IS LEFT. A candidate pool would be the same defect one launch later: a site picked by whatever
        // happens to be free, then repaired.
        given.Should().NotContain("PlaceableCandidates(");
        source.Should().NotContain("fixture_map_cannot_hold_animal_building");
        source.Should().NotContain("fixture_native_local_play_session_animal_site_missing");

        // (f) AND THE ROUTE ASSERTION SURVIVES, because it is what caught the sixty-tile barn.
        given.Should().Contain("RejectsThePlaySessionAnimalBuilding(player, farm, barn, startTile, mustRemainReachable)");
    }

    [Fact]
    public void ThePropSearchKeepsTheAnimalHousesGroundAndDoorRing()
    {
        // The house is sited first BECAUSE the props spend the ground nearest the crossroads - so the props must also
        // know where it stands. A prop on the footprint or on the ring its door is used from is the defect the props
        // already answer one layer down (a prop on the actor's own ring), and the arm-time porch assertion can only see
        // it after the whole day has been laid out.
        string body = InitializerBody("private void InitializeNativeLocalPlaySessionFixture(");
        body.Should().Contain("animalHouseHeldTiles", "the prop loops are handed the tiles the house holds");
        body.Should().Contain(
            "fixture_native_local_play_session_animal_house_tiles_unrecorded",
            "a prop search running without that list is a search that does not know the house is there");

        // EVERY prop family, read out of the initializer rather than listed here, so the next family added has to pass
        // the list too instead of quietly spending the house's ring.
        var calls = Regex.Matches(body, @"FindNativeLocalPlaySessionSpot\([^)]*\)").Cast<Match>().ToArray();
        calls.Should().NotBeEmpty("the props are placed by that search");
        calls.Select(call => call.Value)
            .Should()
            .OnlyContain(
                call => call.EndsWith(", animalHouseHeldTiles)", StringComparison.Ordinal),
                "every prop placement keeps the house's footprint and door ring free");

        // ...and the animal Given records them from the building that actually stands there, through the one spelling
        // of the ring the `no_approach` probe also reads.
        string source = ReadFixtureSource();
        source.Should().Contain("this.nativeLocalPlaySessionAnimalHeldTiles = PlaySessionFixturePlacement.TilesHeldByBuilding(");
        source.Should().Contain("PlaySessionFixturePlacement.DoorApproachTiles(door)");
    }

    [Fact]
    public void ThePlaySessionGivenLeavesTheGroundUntilled()
    {
        // THE INVARIANT: a fixture must not pre-satisfy the work the day's task is about. `SpreadDirt` gives every
        // Diggable tile of the Farm a `HoeDirt`, which is the whole field already opened; measured `round93`
        // (2026-11-22), a day asked to open a 3-wide, twenty-long strip answered `soil_tilled 0` against
        // `seed_planted 28`, because there was no untilled tile to hoe and nothing forced a hoe before a planting.
        //
        // What the world starts with is the farm nobody has worked, so the run's own `till_soil` is the only thing that
        // can create the ground it plants on. The props do not need loose soil - each crop is planted with its own
        // `HoeDirt` - and the animal Given's site search therefore judges real ground (a tree, a bush, a boulder, an
        // object, a building) rather than the fixture's own soil, which is what emptied round93's world.
        string body = InitializerBody("private void InitializeNativeLocalPlaySessionFixture(");
        body.Should().Contain(
            "parseDebugInput(\"RemoveDirt\"",
            "the ground must start with no hoe in it, whatever the save it was armed on arrived with");
        body.Should().NotContain(
            "parseDebugInput(\"SpreadDirt\"",
            "spreading soil opens the whole field before any turn runs, so `till_soil` measures the fixture, not her");
    }

    [Fact]
    public void TheWorldOffersSomethingToWearAndSomewhereInTheHouseToDisplayIt()
    {
        // THE DEFECT: `dress_and_display`'s criterion is `[equip_wearable, dress_mannequin | set_sign_display]`, and the
        // world it was rotated into held nothing to wear and nowhere to display it. Measured `round93` (2026-11-22):
        // `task_precondition_unmet:dress_and_display:pack:wearable`, with `mannequinTargets` and `signTargets` both empty.
        // Neither half was a product gap and neither was a criterion problem - she was not unwilling, there was nothing.
        string body = InitializerBody("private void InitializeNativeLocalPlaySessionFixture(");
        body.Should().Contain(
            "InstallNativeLocalPlaySessionDressAndDisplayGiven(player);",
            "the play-session world must give the day both halves, or the day measures the world");

        // The Given's OWN file, not every fixture partial: other scenarios' Givens type their own item ids (`(H)0` for
        // the mannequin scenario), and this assertion is about what THIS Given writes.
        string given = File.ReadAllText(RepositorySourcePath(
            Path.Combine("integrations", "stardew", "ModEntry.Fixtures.PlaySessionDressAndDisplay.cs")));
        string wardrobe = InitializerBody("private void InstallNativeLocalPlaySessionWardrobeGiven(");

        // ONE WEARABLE PER KIND THE CRITERION CAN SATISFY, so `equip_wearable` is a choice and something is left for
        // the mannequin. The kinds are read out of the Given's own table rather than listed here, so a kind dropped from
        // the world is a kind this sadly no longer covers. Four, and exactly these four: a ring is wearable but a mannequin
        // cannot be dressed with one, so it would buy the equip half and not the display half.
        var kinds = Regex.Matches(given, @"\(ItemTypeId: ""(?<type>\([HBSP]\))"", BodySlot: ""(?<slot>[a-z_]+)""\)")
            .Cast<Match>()
            .Select(match => $"{match.Groups["type"].Value}={match.Groups["slot"].Value}")
            .ToArray();
        kinds.Should().BeEquivalentTo(
            new[] { "(H)=hat", "(B)=boots", "(S)=shirt", "(P)=pants" },
            "the wardrobe stocks one wearable for each body slot the criterion's two actions can use");
        given.Should().Contain(
            "ItemRegistry.RequireTypeDefinition(itemTypeId)",
            "which ids exist is the content's data, so they are RESOLVED - a hand-typed id here is a second authority");
        given.Should().Contain(
            "definition.CreateItem(data)",
            "the item itself is built by the type's own definition, from the id that definition listed");
        given.Should().Contain(
            "ExecutionManager.IsWearableForBodySlot(candidate, bodySlot)",
            "the candidate is admitted by the same predicate the action applies to the item it was handed");
        // No wearable ITEM id is typed: the four type ids above are the sheet names, and the ids behind them are the data's.
        foreach (string typedWearableId in new[] { "ItemRegistry.Create(\"(H)", "ItemRegistry.Create(\"(B)", "ItemRegistry.Create(\"(S)", "ItemRegistry.Create(\"(P)" })
            given.Should().NotContain(typedWearableId, "a wearable id written here would rot the moment the game's data changed");
        // Idempotent by the same admission: a pack that already holds a wearable in that body slot keeps what it holds.
        wardrobe.Should().Contain("ExecutionManager.IsWearableForBodySlot(item, bodySlot)");

        // THE DISPLAY TARGET IS CHOSEN BY ASKING THE PUBLISHER. A mannequin in a room the wire does not publish is a target
        // the day cannot name, and re-deriving "in radius and addressable" here would be a second copy of that rule.
        given.Should().Contain("FarmhandTargetDiscovery.DiscoverMannequinTargets(");
        given.Should().Contain("FarmhandTargetDiscovery.DiscoverSignTargets(");
        given.Should().Contain("player.currentLocation is not FarmHouse room", "the room is the actor's own, or nothing is published");
        given.Should().Contain("fixture_native_local_play_session_display_target_missing");

        // AND THE ROOM HAS TO KEEP WORKING, not only its doors. Measured `round94` (2026-11-23), twice: the display
        // search ordered the room's tiles by distance from the actor, put the mannequin on the spawn tile `9,9`, and that
        // tile was the only approach to the bed at `10,9` - `no_native_path` with `approaches=west:object:(M)MannequinMale@9,9`,
        // no night slept, and she passed out at 02:00 three days running while the old warp-only flood answered
        // reachable. The two rules below are what a room object is placed under now, and both are the room's own
        // answers rather than this file's.
        given.Should().Contain(
            "PlaySessionFixturePlacement.RoomCandidates(",
            "the room's candidate order is the shared rule that keeps an object off the actor's own ring");
        given.Should().Contain(
            "PlaySessionFixturePlacement.TilesSeveredByPlacing(",
            "the flood after placement is the rule that refuses a tile the room needs");
        given.Should().Contain(
            "room.GetPlayerBedSpot()",
            "the bed is what the night walks to; a check that asks the warps and not the bed passed a room whose bed was sealed");
        given.Should().Contain("fixture_object_severs_the_room:", "a room that cannot hold the object refuses by name");
        given.Should().NotContain(
            "RoomExitsStayWalkable",
            "a warp-only connectivity check is the defect: the door stayed reachable while the bed was cut off");

        // AND NEITHER HALF IS THE WORK. A wearable in the pack is available, not worn; an empty mannequin is a target, not
        // a dressed result. The fixture performs no part of the day it makes possible, and it reads the target back off the
        // room to prove that rather than trusting the constructor.
        given.Should().Contain("IsEmptyDisplayTarget(", "a target that arrived dressed would be the day's result handed to her");
        given.Should().NotContain("performObjectDropInAction(", "dressing the mannequin belongs to production");
        given.Should().NotContain("checkForAction(", "setting the sign's display belongs to production");
        given.Should().NotContain(".Equip(", "equipping the wearable belongs to production");
    }

    /// <summary>
    /// NO FIXTURE MAY NAME A MANNEQUIN BY A LITERAL ID: the id must be one `Data/Mannequins` lists, because
    /// `Mannequin.draw` resolves the row behind the id on the first frame it is drawn.
    ///
    /// <para>
    /// MEASURED 2026-11-23, and the reading is the target install's own table (`Content/Data/Mannequins.xnb`, loaded
    /// through the game's content pipeline): the keys are `MannequinMale`, `MannequinFemale`, `CursedMannequinMale` and
    /// `CursedMannequinFemale` - there is no `Mannequin`. A mannequin built from that literal has no row, so
    /// `GetMannequinData()` answers null and `Mannequin.draw` throws inside `GetFarmerForRendering` (`Mannequin.cs:524` on
    /// `SMAPI-crash.txt` at 07:46:58, once per frame) - the farmhouse the session starts in could not be drawn at all, and
    /// the sprite batch could not be begun again. The fixture had authored a world object the engine cannot render, which
    /// is why the id is resolved from the sheet rather than typed here.
    /// </para>
    ///
    /// <para>
    /// THE POPULATION IS EVERY FIXTURE PARTIAL, not the one file that carried the defect: the single-action mannequin
    /// scenario typed the same id on a farm tile, so both spellings of the same mistake are in this gate's population and
    /// the next one committed is too.
    /// </para>
    /// </summary>
    [Fact]
    public void NoFixtureNamesAMannequinByALiteralId()
    {
        IReadOnlyList<string> fixtureSources = FixtureSourcePaths();
        fixtureSources.Should().NotBeEmpty("a fixture reading that examined no file would agree with itself");
        Regex literalMannequinId = new("\"(?:Cursed)?Mannequin[A-Za-z]*\"", RegexOptions.Compiled);
        List<string> offenders = new();
        foreach (string path in fixtureSources)
        {
            string[] lines = File.ReadAllLines(path);
            for (int index = 0; index < lines.Length; index++)
            {
                // COMMENTS ARE NOT DECLARATIONS: this pin is about an id a fixture hands the engine, and the prose that
                // explains why the literal is wrong has to be free to quote it.
                if (lines[index].TrimStart().StartsWith("//", StringComparison.Ordinal)) continue;
                foreach (Match match in literalMannequinId.Matches(lines[index]))
                    offenders.Add($"{Path.GetFileName(path)}:{index + 1}:{match.Value}");
            }
        }
        offenders.Should().BeEmpty(
            $"no fixture names a mannequin by a hand-written id ({string.Join(", ", offenders)}): the ids are "
                + "Data/Mannequins' own and the sheet lists MannequinMale/MannequinFemale, so the display target is built "
                + "by CreateNativeLocalMannequin(), which resolves the id through the (M) definition");
        string given = File.ReadAllText(RepositorySourcePath(
            Path.Combine("integrations", "stardew", "ModEntry.Fixtures.PlaySessionDressAndDisplay.cs")));
        given.Should().Contain(
            "CreateNativeLocalMannequin()",
            "the display Given builds its mannequin from the sheet's own id");
        given.Should().Contain(
            "ItemRegistry.RequireTypeDefinition(\"(M)\")",
            "which mannequins exist is the content's data, so the id is RESOLVED rather than typed");
        given.Should().Contain(
            "DataLoader.Mannequins(Game1.content)",
            "the row that decides is the one GetMannequinData reads, so the mannequin returned is one the draw path resolves");
        given.Should().Contain(
            "row.Cursed",
            "a cursed mannequin is skipped by the flag its data sheet carries, not by a name this file spells");
    }

    [Fact]
    public void TheArmTimeWalkabilityAsksWhatActuallyStopsAFarmer()
    {
        // THE DEFECT CLASS: two answers to "can the actor walk there". The arm-time rule counted ANY terrain feature
        // as a wall, while the engine - and `StardewBodyController.IsWalkableTile`, which says "standing among
        // terrain features is the job" - treat a tilled tile as ordinary ground. While this fixture spread soil, that
        // rule declared the field unwalkable, so a barn inside it could never have an approach whatever tile it stood
        // on: solving the footprint would have moved the refusal from `free_footprints=0` to `no_approach` on the door's
        // own ring. The play-session Given no longer spreads soil, and the rule still has to be the engine's answer
        // rather than "any terrain feature is a wall".
        //
        // The rule now asks the engine (`TerrainFeature.isPassable`). A grown tree, a bush and a boulder still refuse,
        // which is what the rule was written for; the props are objects and still block as objects.
        string given = ReadMultiDayGivenSource();
        given.Should().Contain("feature.isPassable(", "the rule asks the engine whether a terrain feature stops a farmer");
        given.Should().Contain("farm.objects.ContainsKey", "a placed object still blocks: the fixture's props are objects");
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
