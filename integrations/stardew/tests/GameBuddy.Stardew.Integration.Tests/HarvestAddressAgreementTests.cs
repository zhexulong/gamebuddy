using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE COUNT AND THE ADDRESS ARE TWO READINGS OF ONE CROP POPULATION, so the tile the whole-map row names must be a tile
/// the family that hands out target ids would publish.
///
/// <para>
/// The defect this file was written against, measured `round99` (`game-1795514126213`): one observation carried
/// <c>harvestWhereabouts: [{ location: "Farm", readyForHarvestCount: 3 }]</c> with <c>nearestX/nearestY</c> at the ready
/// crop on (33,16), and <c>harvestTargets: []</c>. Both readings were true and only one was usable: the count is the
/// whole map's (sixteen tiles out is still this farm's crop), the family's rows are its own six-tile window, and nothing
/// said which of the two bounds the address came from. Her block read `可收作物: 3（最近: 33,16）`, `harvest_crop`
/// needs a target id, and no reading she could reach carried one - four observations and three game hours.
/// </para>
///
/// <para>
/// A COUNT IS NEVER NARROWED (that false zero is why the family exists), so the agreement is made on the ADDRESS side:
/// <c>DiscoverHarvestWhereabouts</c> and <c>DiscoverHarvestTargets</c> now ask the one predicate
/// (<c>FarmhandTargetDiscovery.IsPublishedHarvestTile</c>), and these two cases hold it from both sides - a ripe crop
/// inside the window is named and published, one beyond it is counted and NOT named. Both drive the shipped discovery
/// through <see cref="WhereaboutsWorld"/>; the family itself cannot be driven in this process (`ItemRegistry.Create`
/// needs <c>Data/Objects</c>), which is why the second assertion is the family's own admission rather than its rows.
/// </para>
/// </summary>
public sealed class HarvestAddressAgreementTests
{
    [Fact]
    public void TheAddressTheWholeMapRowNamesIsATileTheTargetFamilyPublishes()
    {
        using var world = WhereaboutsWorld.Create();
        world.PlaceRipeCrop(world.Farm, x: 7, y: 10);
        world.StandIn(world.Farm, x: 6, y: 10);

        BridgeHarvestWhereabouts row = world.Harvest().Should().ContainSingle().Subject;

        row.ReadyForHarvestCount.Should().Be(1);
        row.NearestX.Should().Be(7, "one ripe crop, one tile away: it is inside the family's window, so it is named");
        row.NearestY.Should().Be(10);
        world.HarvestTargetTileIsPublished(x: 7, y: 10)
            .Should().BeTrue("the address the row names is a tile `harvestTargets` would publish, so the same observation can hand out its target id");
    }

    [Fact]
    public void ARipeCropBeyondTheTargetFamilysWindowIsCountedButNotNamed()
    {
        using var world = WhereaboutsWorld.Create();
        world.PlaceRipeCrop(world.Farm, x: 20, y: 20);
        world.StandIn(world.Farm, x: 4, y: 9);

        BridgeHarvestWhereabouts row = world.Harvest().Should().ContainSingle().Subject;

        row.ReadyForHarvestCount.Should().Be(
            1,
            "the count is the whole map's - a radius-bounded count was the false zero this row exists to prevent");
        row.NearestX.Should().BeNull("an address the family refuses is a crop she can see and cannot name");
        row.NearestY.Should().BeNull();
        // WHICH PREDICATE REFUSED IT. The tile is on this map, so the rejection is the family's window and not the map edge.
        world.Farm.isTileOnMap(20, 20).Should()
            .BeTrue("the crop is sixteen tiles away on the same map, so the map edge is not what refuses it");
        world.HarvestTargetTileIsPublished(x: 20, y: 20)
            .Should().BeFalse("outside `TargetDiscoveryRadius` the family publishes no row, so the row must name no address");
    }
}
