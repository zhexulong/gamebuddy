using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// WHAT THE CROP ROW CARRIES, driven through the REAL `DiscoverCropTargets` over a fixture world.
///
/// <para>
/// The measurement this exists for: the runtime answers "how should this crop be planted" through
/// `look_up({subject:"data", table:"Crops"})`, and across a day of runs (measured 2026-11-09) that table was asked zero
/// times while `look_up` itself was called once, with `subject: "affordances"`. So the fact was available and never
/// reached the companion's working set - and a trellis crop, which is planted on a tile that stops being walkable,
/// appeared in no row she could read.
/// </para>
///
/// <para>
/// These are not assertions about a TYPE. Each one drives `DiscoverCropTargets` against a world built the way the
/// engine builds one (a `HoeDirt` carrying a `Crop`, and a `Data/Crops` row this fixture writes), and reads the row the
/// discovery really publishes. A `BridgeCropTarget` field that nothing fills fails here rather than in a live run.
/// </para>
/// </summary>
public sealed class CropRowFactsTests
{
    /// <summary>Seeds this fixture owns: no other case in the suite writes these ids into the static `Game1.cropData`.</summary>
    private const string TrellisSeedId = "9671";

    private const string RegrowingSeedId = "9672";

    [Fact]
    public void ACropRowCarriesItsEngineDataSoNoSecondQuestionIsNeeded()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.PlaceCropWithData(x: 2, y: 3, seedId: TrellisSeedId, raised: true);
        world.StandAt(2, 2);

        BridgeCropTarget row = SingleCropRow(world);

        row.CropId.Should().Be(TrellisSeedId, "the row names the crop its data answer is keyed by, so the two can be joined");
        row.IsRaised.Should().BeTrue("`CropData.IsRaised` is what makes this crop a trellis");
        row.DaysToHarvest.Should().Be(6, "the row publishes the same sum of `DaysInPhase` the `Crops` data answer does");
        row.RegrowDays.Should().Be(3, "`CropData.RegrowDays` is the fact that decides whether this tile is worth keeping");
        row.Seasons.Should().Equal(new[] { "spring", "summer" }, "the engine's own season keys, through `Utility.getSeasonKey`");
        row.HarvestMethod.Should().Be("grab", "the same word `harvestTargets` publishes for the same crop");
        row.FullyGrown.Should().BeFalse("this crop is still in its growth phases");
        row.Harvestable.Should().BeFalse("and it is therefore not pickable");
        row.CropFactsUnknown.Should().BeNull("every data fact was resolvable, so there is nothing to warn about");
    }

    /// <summary>
    /// The assertion this field exists for, and the one that can fail: a trellis crop's tile is BLOCKED, though the
    /// map-only test calls it open ground.
    ///
    /// <para>
    /// `GameLocation.isTilePassable` (GameLocation.cs:2898) reads only the map's Back and Buildings layers, so it answers
    /// `true` here. The pathfinder does not: `PathFindController.cs:222` admits a step only when
    /// `isCollidingPosition(..., pathfinding: true)` is false, and that call consults the terrain feature
    /// (`HoeDirt.isPassable` returns false when `crop.raisedSeeds`, HoeDirt.cs:456-463). Publishing the map-only answer
    /// under a name that promises walkability is what this test forbids.
    /// </para>
    /// </summary>
    [Fact]
    public void ATrellisCropTileIsBlockedThoughTheMapOnlyTestCallsItOpenGround()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.PlaceCropWithData(x: 2, y: 3, seedId: TrellisSeedId, raised: true);
        world.StandAt(2, 2);

        BridgeCropTarget row = SingleCropRow(world);

        world.Farm.isTilePassable(new Vector2(2f, 3f))
            .Should().BeTrue("the map's own layers are empty at this tile, which is why the cheaper test lies here");
        row.TileBlockedNow.Should().BeTrue(
            "a trellis crop is a terrain feature the pathfinder refuses; the row must say so even though the map is open");
    }

    [Fact]
    public void ARegrowingCropIsFullyGrownAndNotYetHarvestable()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.PlaceCropWithData(x: 2, y: 3, seedId: RegrowingSeedId, raised: false, fullyGrown: true, dayOfCurrentPhase: 1);
        world.StandAt(2, 2);

        BridgeCropTarget row = SingleCropRow(world);

        row.FullyGrown.Should().BeTrue("`Crop.fullyGrown`: this plant finished its phases");
        row.Harvestable.Should().BeFalse(
            "`HoeDirt.readyForHarvest()` is false the morning after a pick, which is why the row carries both facts rather than one");
        row.TileBlockedNow.Should().BeFalse("an ordinary crop does not block its tile");
    }

    [Fact]
    public void ACropWithNoDataRowNamesTheGapRatherThanDefaulting()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        // `PlaceWaterableCrop` uses a seed id no data row exists for, which is the state a content pack adding a seed
        // without a `Data/Crops` row produces.
        world.PlaceWaterableCrop(x: 2, y: 3);
        world.StandAt(2, 2);

        BridgeCropTarget row = SingleCropRow(world);

        row.CropFactsUnknown.Should().Be("crop_data_missing", "the row must SAY why the data facts are absent");
        row.IsRaised.Should().BeNull("a default `false` would read as a fact she could plan on");
        row.DaysToHarvest.Should().BeNull();
        row.RegrowDays.Should().BeNull();
        row.HarvestMethod.Should().BeNull();
        row.Seasons.Should().BeNull();
        row.FullyGrown.Should().BeFalse("this fact comes from the Crop instance, which exists whether or not its data row does");
    }

    private static BridgeCropTarget SingleCropRow(TargetFamilyCompletenessTests.TargetFamilyWorld world) =>
        world.Rows("cropTargets").Cast<BridgeCropTarget>().Should().ContainSingle().Subject;
}
