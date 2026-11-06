using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The dry-crop count follows the tiles while the companion waters them.
///
/// <para>
/// The shipped defect (measured 11:22): the companion finished watering the farm, and the row its state block reads
/// still counted those tiles as dry. `HoeDirt.needsWatering()` is a CROP-TYPE fact - "this kind of crop wants water" -
/// and it ignores the tile's own <c>state</c>, so a count derived from it alone never falls when a tile IS watered. The
/// companion then read "- unwatered crops: 34", walked to a nearest tile that no longer needed water, and took
/// `crop_target_unavailable` - the refusal `water_crop` gives for a tile that is already watered.
/// </para>
/// <para>
/// The property is two-sided and each half is its own case: the count is computed from the live tile when the snapshot
/// is built (so it follows the tile back to dry as well), and a watered tile lowers it by exactly one - the number of
/// tiles one `water_crop` receipt waters.
/// </para>
/// </summary>
public sealed class WateringWhereaboutsFreshnessTests
{
    [Fact]
    public void WateringTilesLowersTheCountByExactlyTheTilesWatered()
    {
        using var world = WhereaboutsWorld.Create();
        world.PlaceDryCrop(world.Farm, x: 4, y: 9);
        world.PlaceDryCrop(world.Farm, x: 5, y: 9);
        world.PlaceDryCrop(world.Farm, x: 6, y: 9);
        world.StandIn(world.Farm, x: 5, y: 10);

        world.Watering().Should().ContainSingle().Which.NeedsWaterCount.Should().Be(3, "three tokens are dry before watering");

        // What one water_crop receipt leaves behind, on exactly the tiles it watered.
        world.Water(world.Farm, x: 4, y: 9);
        world.Water(world.Farm, x: 5, y: 9);

        BridgeWateringWhereabouts row = world.Watering().Should().ContainSingle().Subject;
        row.NeedsWaterCount.Should().Be(1, "the count answers what still needs water now, not what the crop kind wants");
        row.NearestX.Should().Be(6, "the nearest tile is the tile a companion should walk to, so it cannot be a watered one");
        row.NearestY.Should().Be(9);
    }

    [Fact]
    public void TheCountFollowsTheTileBothWays_SoItIsRecomputedRatherThanRemembered()
    {
        using var world = WhereaboutsWorld.Create();
        world.PlaceDryCrop(world.Farm, x: 4, y: 9);
        world.StandIn(world.Farm, x: 4, y: 10);

        world.Watering()[0].NeedsWaterCount.Should().Be(1);
        world.Water(world.Farm, x: 4, y: 9);
        world.Watering().Should().BeEmpty("a map with nothing dry is no row at all, not a row with a stale count");
        world.Dry(world.Farm, x: 4, y: 9);
        world.Watering()[0].NeedsWaterCount.Should().Be(1, "the count reads the tile, never a memo of an earlier answer");
    }
}
