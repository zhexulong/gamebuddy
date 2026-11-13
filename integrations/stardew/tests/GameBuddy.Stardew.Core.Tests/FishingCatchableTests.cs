using System;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// One derivation, two callers: the planning lookup and the `fish_here` admission guard both read
/// <see cref="FishingCatchable.CatchableNow"/>.
///
/// <para>
/// WHAT IS PINNED HERE, AND WHY IT IS THE ARITHMETIC RATHER THAN THE SAMPLER. The engine decides what bites in
/// `GameLocation.GetFishFromLocationData` (`GameLocation.cs:13901-14029`) and `CheckGenericFishRequirements`
/// (`:14042-14189`), and it reads `Data/Fish` by POSITION: difficulty at index 1, time spans at 5, weather at 7, minimum
/// level at 12, the tutorial flag at 13. A position is the kind of fact that drifts silently, so every fixture row below
/// is composed at those indices and every reading is asserted by name - move an index in the module and the field it
/// costs is named in the failure.
/// </para>
///
/// <para>
/// THE FIXTURE ROWS ARE FORMAT-EXACT, NOT COPIED. The shipped `Data/Fish` is `Content/Data/Fish.xnb` and no fixture can
/// stand in for a packed asset, so a row here is composed at the indices the engine reads. A real row would add nothing
/// the arithmetic does not already decide, and copying one would claim a provenance this process cannot check.
/// </para>
///
/// <para>
/// WHAT THIS FILE CANNOT PROVE, said plainly: "every fish the engine's sampler produces is in this candidate set" is a
/// live-run gate. `getFish` reads `DataLoader.Fish(Game1.content)` and `Game1.locationData`, and this process has no
/// content manager - the same limit `FishingActionTests` records for the engine's own catch. The reverse direction is not
/// provable at any finite N either, because the sampler is a sampler. Neither direction is claimed by a green run here.
/// </para>
/// </summary>
public sealed class FishingCatchableTests
{
    private const string Carp = "(O)142";
    private const string Pufferfish = "(O)128";

    /// <summary>
    /// The arithmetic on one fixed moment: TWO rows, one in season and in window, one out of season.
    ///
    /// This is the case a reader should be able to check by hand, and it is also the lookUp/guard identity in miniature:
    /// the species the report blocks is the species `RefusalFor` refuses, by the same code.
    /// </summary>
    [Fact]
    public void TheReportSplitsTheRowsAndRefusesTheBlockedSpeciesByItsOwnCode()
    {
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(),
            new[]
            {
                Spawn(Carp, season: "Spring", fishRow: FishRow()),
                Spawn(Pufferfish, season: "Summer", fishRow: FishRow()),
            });

        report.Measured.Should().BeTrue();
        report.Examined.Should().Be(2, "a verdict without its population is not a measurement");
        report.Catchable.Select(row => row.Species).Should().Equal(Carp);
        report.Blocked.Should().ContainSingle();

        FishingSpeciesRow blocked = report.Blocked[0];
        blocked.Species.Should().Be(Pufferfish);
        blocked.BlockedCode.Should().Be($"season_mismatch:{Pufferfish}:Summer");
        blocked.BlockedFact.Should().Contain("world_season=Spring", "the fact that would change the answer names the world");

        report.RefusalFor(Pufferfish).Should().Be(new FishingRefusal(blocked.BlockedCode, blocked.BlockedFact));
        report.RefusalFor(Carp).Should().BeNull("a species that can be caught is never refused");
    }

    /// <summary>
    /// THE IDENTITY, over the whole report: the lookup's `Blocked` set and the guard's refusals are one reading.
    ///
    /// The defect this file exists to prevent is a second evaluation path, and it would show up exactly here - a code the
    /// lookup prints that the guard does not mint, or a species the guard refuses that the lookup calls catchable.
    /// </summary>
    [Fact]
    public void EveryBlockedRowIsExactlyWhatTheGuardRefusesAndEveryCatchableRowIsNot()
    {
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(raining: true, level: 2),
            new[]
            {
                Spawn(Carp, fishRow: FishRow()),
                Spawn(Pufferfish, season: "Summer", fishRow: FishRow(weather: FishingCatchable.RainyMarker)),
                Spawn("(O)130", fishRow: FishRow(minFishingLevel: "9")),
                Spawn("(O)131", fishRow: FishRow(timeSpans: "600 900")),
                Spawn("(O)132", requiresMagicBait: true, fishRow: FishRow()),
            });

        report.Examined.Should().Be(5);
        foreach (FishingSpeciesRow row in report.Blocked)
            report.RefusalFor(row.Species)!.Code.Should().Be(row.BlockedCode, $"{row.Species} is refused by the code the lookup printed");
        foreach (FishingSpeciesRow row in report.Catchable)
            report.RefusalFor(row.Species).Should().BeNull($"{row.Species} can be caught, so the guard must admit it");
    }

    // ------------------------------------------------------------------
    // Boundaries: the half-open window, the equal level, the two depth edges, the catch limit.
    // ------------------------------------------------------------------

    [Theory]
    [InlineData(599, false)]
    [InlineData(600, true)]
    [InlineData(1899, true)]
    [InlineData(1900, false)]
    public void TheTimeWindowIsHalfOpenExactlyAsTheEngineComparesIt(int timeOfDay, bool catchable)
    {
        // GameLocation.cs:14103 compares `timeOfDay >= start && timeOfDay < end`.
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(timeOfDay: timeOfDay),
            new[] { Spawn(Carp, fishRow: FishRow(timeSpans: "600 1900")) });

        report.Catchable.Any(row => row.Species == Carp).Should().Be(catchable);
        if (!catchable)
            report.RefusalFor(Carp)!.Code.Should().Be($"time_outside_window:{Carp}:600-1900");
    }

    [Fact]
    public void AWindowSpelledPastMidnightIsNeitherClampedNorNormalised()
    {
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(timeOfDay: 2500),
            new[] { Spawn(Carp, fishRow: FishRow(timeSpans: "1800 2600")) });

        report.Catchable.Should().ContainSingle(row => row.Species == Carp);
        report.Catchable[0].TimeWindow.Should().Be("1800-2600");
    }

    [Theory]
    [InlineData(6, true)]
    [InlineData(5, false)]
    public void AMinimumLevelEqualToOneIsSatisfiedByThatLevelExactly(int level, bool catchable)
    {
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(level: level),
            new[] { Spawn(Carp, minimumFishingLevel: 6, fishRow: FishRow()) });

        if (catchable) report.RefusalFor(Carp).Should().BeNull();
        else report.RefusalFor(Carp)!.Code.Should().Be($"skill_too_low:{Carp}:6:{level}", "both numbers are in the code");
    }

    [Theory]
    [InlineData(2, true)]
    [InlineData(1, false)]
    public void TheMinimumDistanceFromShoreIsSatisfiedByThatDepthExactly(int depth, bool catchable)
    {
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(depth: depth),
            new[] { Spawn(Carp, minimumDepth: 2, fishRow: FishRow()) });

        if (catchable) report.RefusalFor(Carp).Should().BeNull();
        else report.RefusalFor(Carp)!.Code.Should().Be($"needs_deeper_water:{Carp}:2:{depth}");
    }

    [Theory]
    [InlineData(4, true)]
    [InlineData(5, false)]
    public void TheMaximumDistanceFromShoreIsSatisfiedByThatDepthExactly(int depth, bool catchable)
    {
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(depth: depth),
            new[] { Spawn(Carp, maximumDepth: 4, fishRow: FishRow()) });

        if (catchable) report.RefusalFor(Carp).Should().BeNull();
        else report.RefusalFor(Carp)!.Code.Should().Be($"needs_shallower_water:{Carp}:4:{depth}");
        report.DepthApplied.Should().BeTrue();
    }

    [Theory]
    [InlineData(2, 2, false)]
    [InlineData(2, 1, true)]
    [InlineData(-1, 99, true)]
    public void TheCatchLimitBlocksAtTheLimitAndNeverWhenTheRowDeclaresNone(int limit, int caught, bool catchable)
    {
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(),
            new[] { Spawn(Carp, catchLimit: limit, caughtSoFar: caught, fishRow: FishRow()) });

        if (catchable) report.RefusalFor(Carp).Should().BeNull();
        else report.RefusalFor(Carp)!.Code.Should().Be($"catch_limit_reached:{Carp}:{limit}");
    }

    // ------------------------------------------------------------------
    // The species row's three early returns, which a naive reader gets wrong in the unsafe direction.
    // ------------------------------------------------------------------

    [Fact]
    public void ARowWithNoSpeciesRowIsCatchableBecauseTheEnginePassesIt()
    {
        // GameLocation.cs:14044-14047 returns `!isTutorialCatch` for a fish with no Data/Fish entry: no requirement.
        FishingCatchable.CatchableNow(Moment(), new[] { Spawn(Carp, fishRow: null) })
            .RefusalFor(Carp).Should().BeNull();
    }

    [Fact]
    public void ATrapRowIsCatchableEvenOutOfSeasonWeatherAndTime()
    {
        // GameLocation.cs:14049-14052: `trap` returns `!isTutorialCatch` before any time or weather requirement.
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(raining: false, timeOfDay: 100, level: 0),
            new[] { Spawn("(O)Trapper", fishRow: FishRow(difficulty: "trap", timeSpans: "", weather: "rainy")) });

        report.RefusalFor("(O)Trapper").Should().BeNull();
    }

    [Fact]
    public void ARowThatIgnoresItsSpeciesRequirementsIsCatchableOutOfWindow()
    {
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(timeOfDay: 100),
            new[] { Spawn(Carp, ignoresFishDataRequirements: true, fishRow: FishRow(timeSpans: "600 1900")) });

        report.RefusalFor(Carp).Should().BeNull();
    }

    // ------------------------------------------------------------------
    // The species row's constraints, each named.
    // ------------------------------------------------------------------

    [Fact]
    public void ABlankTimeCellIsUncatchableAndSaysNoneRatherThanAnyTime()
    {
        // ArgUtility.SplitBySpace("") is empty (ArgUtility.cs:16-19), so no pair matches and the engine returns false
        // (GameLocation.cs:14091-14112). "any time" would be the opposite of what the engine does.
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(timeOfDay: 1200),
            new[] { Spawn(Carp, fishRow: FishRow(timeSpans: "")) });

        report.RefusalFor(Carp)!.Code.Should().Be($"time_outside_window:{Carp}:none");
        report.Catchable.Should().BeEmpty();
    }

    [Theory]
    [InlineData(false, "rainy")]
    [InlineData(true, "sunny")]
    public void TheWeatherRequirementNamesTheWeatherThatWouldChangeIt(bool raining, string declared)
    {
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(raining: raining),
            new[] { Spawn(Carp, fishRow: FishRow(weather: declared)) });

        report.RefusalFor(Carp)!.Code.Should().Be($"weather_mismatch:{Carp}:{declared}");
    }

    [Fact]
    public void TheSpeciesOwnMinimumLevelBlocksBelowItAndNamesBothNumbers()
    {
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(level: 3),
            new[] { Spawn(Carp, fishRow: FishRow(minFishingLevel: "5")) });

        report.RefusalFor(Carp)!.Code.Should().Be($"skill_too_low:{Carp}:5:3");
    }

    [Fact]
    public void AMalformedSpeciesRowNamesTheFieldThatIsWrong()
    {
        // ArgUtility.TryGetInt fails on index 12 and the engine logs + returns false (GameLocation.cs:14184-14188).
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(),
            new[] { Spawn(Carp, fishRow: FishRow(minFishingLevel: "not-a-number")) });

        report.RefusalFor(Carp)!.Code.Should().Be($"fish_data_malformed:{Carp}:12");
    }

    [Fact]
    public void TheFirstCastAcceptsOnlyTheSpeciesTheTableMarksAsATutorialFish()
    {
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(firstCatch: true),
            new[]
            {
                Spawn(Carp, fishRow: FishRow(tutorial: "false")),
                Spawn(Pufferfish, fishRow: FishRow(tutorial: "true")),
            });

        report.RefusalFor(Carp)!.Code.Should().Be($"first_catch_accepts_only_tutorial_fish:{Carp}");
        report.RefusalFor(Pufferfish).Should().BeNull();
    }

    [Fact]
    public void ATrainingRodRefusesADifficultyAtItsCeilingUnlessTheRowOverridesIt()
    {
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(trainingRod: true),
            new[]
            {
                Spawn(Carp, fishRow: FishRow(difficulty: "50")),
                Spawn(Pufferfish, fishRow: FishRow(difficulty: "50"), canUseTrainingRod: true),
                Spawn("(O)130", fishRow: FishRow(difficulty: "49")),
            });

        report.RefusalFor(Carp)!.Code.Should().Be($"training_rod_too_weak:{Carp}:50");
        report.RefusalFor(Pufferfish).Should().BeNull("the row itself allows the training rod");
        report.RefusalFor("(O)130").Should().BeNull();
    }

    // ------------------------------------------------------------------
    // Magic bait bypasses exactly what the engine says it bypasses, and nothing else.
    // ------------------------------------------------------------------

    [Fact]
    public void MagicBaitBypassesSeasonTimeWeatherAndTheMagicBaitRequirement()
    {
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(magicBait: true, timeOfDay: 100, raining: false),
            new[]
            {
                Spawn(Carp, season: "Summer", requiresMagicBait: true,
                    fishRow: FishRow(timeSpans: "1800 2600", weather: FishingCatchable.RainyMarker)),
            });

        report.RefusalFor(Carp).Should().BeNull();
    }

    [Fact]
    public void MagicBaitDoesNotBypassTheSpeciesMinimumLevel()
    {
        // The level check sits OUTSIDE both `if (!usingMagicBait)` blocks (GameLocation.cs:14132).
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(magicBait: true, level: 1),
            new[] { Spawn(Carp, fishRow: FishRow(minFishingLevel: "4")) });

        report.RefusalFor(Carp)!.Code.Should().Be($"skill_too_low:{Carp}:4:1");
    }

    // ------------------------------------------------------------------
    // The filters that need a tile: applied only when one was measured.
    // ------------------------------------------------------------------

    [Fact]
    public void TheFishAreaIsComparedAndNamesTheAreaTheRowNeeds()
    {
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(fishAreaId: "River"),
            new[] { Spawn(Carp, fishAreaId: "Lake", fishRow: FishRow()) });

        report.RefusalFor(Carp)!.Code.Should().Be($"fish_area_mismatch:{Carp}:Lake");
    }

    [Fact]
    public void ThePlayerRectangleFiltersOnlyWhenThePlayerTileIsKnown()
    {
        FishingRectangle rect = new(10, 10, 2, 2);
        FishingSpawn row = Spawn(Carp, fishRow: FishRow()) with { PlayerPosition = rect };

        FishingCatchable.CatchableNow(Moment(playerTile: new FishingTile(60, 60)), new[] { row })
            .RefusalFor(Carp)!.Code.Should().Be($"player_position_excluded:{Carp}");

        FishingCatchable.CatchableNow(Moment(playerTile: null), new[] { row })
            .RefusalFor(Carp).Should().BeNull("a lookup that does not know the tile cannot exclude the row");
    }

    [Fact]
    public void TheBobberRectangleFiltersOnlyWhenTheBobberTileIsKnown()
    {
        FishingSpawn row = Spawn(Carp, fishRow: FishRow()) with { BobberPosition = new FishingRectangle(5, 5, 3, 3) };

        FishingCatchable.CatchableNow(Moment(bobberTile: new FishingTile(70, 70)), new[] { row })
            .RefusalFor(Carp)!.Code.Should().Be($"bobber_position_excluded:{Carp}");

        FishingCatchable.CatchableNow(Moment(bobberTile: null), new[] { row })
            .RefusalFor(Carp).Should().BeNull();
    }

    [Fact]
    public void ALookUpWithNoBobberReportsThatTheDepthWasNotApplied()
    {
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(depth: null),
            new[] { Spawn(Carp, minimumDepth: 5, maximumDepth: 5, fishRow: FishRow()) });

        report.DepthApplied.Should().BeFalse("the answer says which question it answered");
        report.RefusalFor(Carp).Should().BeNull();
    }

    // ------------------------------------------------------------------
    // Sound-or-silent: not measured is never an empty set.
    // ------------------------------------------------------------------

    [Fact]
    public void NotMeasuredRefusesNothingAndPrintsItsReason()
    {
        FishingCatchReport report = FishingCatchable.NotMeasured("Data/Locations could not be read");

        report.Measured.Should().BeFalse();
        report.Examined.Should().Be(0);
        report.NotMeasuredReason.Should().Be("Data/Locations could not be read");
        report.Catchable.Should().BeEmpty("an empty set is a claim about the world, and no claim was made");
        report.RefusalFor(Pufferfish).Should().BeNull("the guard admits what it cannot judge");
    }

    [Fact]
    public void ASpeciesTheTableDoesNotNameIsRefusedByThatFact()
    {
        FishingCatchReport report = FishingCatchable.CatchableNow(Moment(), new[] { Spawn(Carp, fishRow: FishRow()) });

        report.RefusalFor("(O)999").Should().NotBeNull();
        report.RefusalFor("(O)999")!.Code.Should().Be("not_in_this_location:(O)999");
    }

    [Fact]
    public void AnItemQueryRowCanProduceAnySpeciesSoNothingIsRefusedByAbsence()
    {
        // `SpawnFishData.ItemId` may be an item query (ALL_ITEMS, RANDOM_ITEMS, ...), whose output this file cannot name
        // before the engine resolves it. Such a row makes "that species is not here" unprovable, so the guard admits.
        FishingCatchReport report = FishingCatchable.CatchableNow(
            Moment(),
            new[] { Spawn("ALL_ITEMS", species: null, speciesIsItemQuery: true, fishRow: FishRow()) });

        report.RefusalFor("(O)999").Should().BeNull();
    }

    // ------------------------------------------------------------------
    // The index pinning: the reading this module takes of a row positionally.
    // ------------------------------------------------------------------

    [Fact]
    public void TheSpeciesRowIsReadAtTheIndicesTheEngineNames()
    {
        FishRowSpec spec = FishRowSpec.Parse(FishRow(
            difficulty: "80",
            timeSpans: "1200 1600 1800 2600",
            weather: FishingCatchable.RainyMarker,
            minFishingLevel: "7",
            tutorial: "true"));

        spec.Difficulty.Should().Be(80, "Data/Fish index 1 is difficulty (GameLocation.cs:14066)");
        spec.TimeSpans.Should().Equal(new FishingTimeWindow(1200, 1600), new FishingTimeWindow(1800, 2600));
        spec.DescribeWindow().Should().Be("1200-1600,1800-2600");
        spec.Weather.Should().Be(FishingCatchable.RainyMarker, "index 7 is weather (GameLocation.cs:14116)");
        spec.MinimumFishingLevel.Should().Be(7, "index 12 is minFishingLevel (GameLocation.cs:14132)");
        spec.TutorialFish.Should().BeTrue("index 13 is isTutorialFish (GameLocation.cs:14078)");
        spec.MalformedIndex.Should().BeNull();
    }

    [Fact]
    public void AnOddNumberOfWindowCellsIsMalformedRatherThanHalfRead()
    {
        FishRowSpec spec = FishRowSpec.Parse(FishRow(timeSpans: "1200 1600 1800"));

        spec.MalformedIndex.Should().Be(FishingCatchable.FishRowTimeSpansIndex);
    }

    [Fact]
    public void TheJunkFallbackIsNamedSoAReaderCanSeeWhyACastNeverYieldsNothing()
    {
        // getFish returns ItemRegistry.Create("(O)168") when no row matched (GameLocation.cs:13874).
        FishingCatchable.JunkFallbackSpecies.Should().Be("(O)168");
    }

    // ------------------------------------------------------------------
    // Fixtures.
    // ------------------------------------------------------------------

    /// <summary>
    /// One `Data/Fish` row composed at the indices the engine reads: 0 name, 1 difficulty, 2 behavior, 3/4 size,
    /// 5 time spans, 6 seasons (unused by the 1.6 selection path - `GameLocation.cs:13955` filters on the
    /// `Data/Locations` season instead), 7 weather, 8 unused by selection, 9 max depth, 10 chance, 11 depth multiplier,
    /// 12 minimum fishing level, 13 tutorial flag.
    /// </summary>
    private static string FishRow(
        string difficulty = "50",
        string timeSpans = "600 1900",
        string weather = "",
        string minFishingLevel = "0",
        string tutorial = "false") =>
        string.Join(
            "/",
            "Test Fish",
            difficulty,
            "mixed",
            "1",
            "10",
            timeSpans,
            "spring",
            weather,
            "",
            "0",
            "0.1",
            "0.1",
            minFishingLevel,
            tutorial);

    private static FishingSpawn Spawn(
        string itemId,
        string? species = null,
        string? season = null,
        string? fishAreaId = null,
        int minimumFishingLevel = 0,
        int minimumDepth = 0,
        int maximumDepth = -1,
        bool requiresMagicBait = false,
        bool ignoresFishDataRequirements = false,
        int catchLimit = -1,
        int caughtSoFar = 0,
        bool speciesIsItemQuery = false,
        string? fishRow = null,
        bool? canUseTrainingRod = null) =>
        new(
            itemId,
            Species: speciesIsItemQuery ? null : species ?? QueryId(itemId),
            DisplayName: itemId,
            Season: season,
            FishAreaId: fishAreaId,
            MinimumFishingLevel: minimumFishingLevel,
            MinimumDistanceFromShore: minimumDepth,
            MaximumDistanceFromShore: maximumDepth,
            RequiresMagicBait: requiresMagicBait,
            IgnoresFishDataRequirements: ignoresFishDataRequirements,
            CatchLimit: catchLimit,
            CaughtSoFar: caughtSoFar,
            SpeciesIsItemQuery: speciesIsItemQuery,
            FishRow: fishRow,
            CanUseTrainingRod: canUseTrainingRod);

    private static string? QueryId(string itemId) => itemId.StartsWith('(') ? itemId : $"({itemId})";

    private static FishingMoment Moment(
        string season = "Spring",
        int dayOfMonth = 1,
        int timeOfDay = 1200,
        bool raining = false,
        int level = 10,
        string? fishAreaId = null,
        bool magicBait = false,
        bool trainingRod = false,
        bool firstCatch = false,
        int? depth = 0,
        FishingTile? playerTile = null,
        FishingTile? bobberTile = null) =>
        new(
            "Farm",
            season,
            dayOfMonth,
            timeOfDay,
            raining,
            level,
            fishAreaId,
            magicBait,
            trainingRod,
            firstCatch,
            WaterDepth: depth,
            PlayerTile: playerTile,
            BobberTile: bobberTile);
}