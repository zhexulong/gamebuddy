using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A world-level count that publishes no row and one that withholds nothing must not answer the same thing.
///
/// <para>
/// `harvestWhereabouts` and `wateringWhereabouts` publish one row per location that HAS a subject. An empty list
/// therefore used to mean two different things: "there is a dead crop on this farm and no water will bring it back" and
/// "there is no crop here at all". The companion planned from the second reading of the first fact.
/// </para>
///
/// <para>
/// The two answers are asserted TOGETHER, on the same shipped discovery, because either one alone is satisfied by the
/// other's defect: a family that always records passes the first case and fails the second, and a family that never
/// records fails the first. Both read the recorder the snapshot publishes from, never a re-derivation of the filter.
/// </para>
/// </summary>
public sealed class WhereaboutsExclusionReportingTests
{
    [Fact]
    public void ADyingFarmWithNothingToWaterSaysWhichCropsItWithheld()
    {
        using var world = WhereaboutsWorld.Create();
        world.PlaceDeadCrop(world.Farm, x: 4, y: 9);
        world.StandIn(world.Farm, x: 5, y: 10);

        world.Watering().Should().BeEmpty("a dead crop is not a tile any watering can helps");

        BridgeDiscoveryExclusion row = world.ExclusionRows().Should().ContainSingle().Subject;
        row.Family.Should().Be("wateringWhereabouts");
        row.Reason.Should().Be("dead", "`Crop.dead` is the state the count withheld, and it is in the closed vocabulary");
        row.Count.Should().Be(1);
    }

    [Fact]
    public void AFarmWithNothingOfTheSubjectKindWithholdsNothingAndSaysNothing()
    {
        using var world = WhereaboutsWorld.Create();
        // The tile is there; the crop is not. A reader must be able to tell this from a dead crop WITHOUT the row, and
        // with the row present the two worlds would answer the same thing.
        world.PlaceEmptyHoeDirt(world.Farm, x: 4, y: 9);
        world.StandIn(world.Farm, x: 5, y: 10);

        world.Watering().Should().BeEmpty();
        world.ExclusionRows().Should().BeEmpty(
            "no subject was withheld, so there is no row - the answer a farm WITH a dead crop must not give");
    }

    [Fact]
    public void AnUnripeCropIsWithheldFromTheHarvestCountForTheReasonTheEngineGives()
    {
        using var world = WhereaboutsWorld.Create();
        world.PlaceDryCrop(world.Farm, x: 4, y: 9);
        world.StandIn(world.Farm, x: 5, y: 10);

        world.Harvest().Should().BeEmpty("a crop still growing is not ready for harvest");

        BridgeDiscoveryExclusion row = world.ExclusionRows().Should().ContainSingle().Subject;
        row.Family.Should().Be("harvestWhereabouts");
        row.Reason.Should().Be("not_ready", "`HoeDirt.readyForHarvest()` is false - the engine's own readiness answer");
        row.Count.Should().Be(1);
    }
}
