using System.Collections.Generic;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The whole-map crop counts, as the Mod actually publishes them: a row for EVERY loaded map that has work, with a
/// coordinate only on the map the actor stands on.
///
/// <para>
/// The shipped defect: both discovery loops counted a location's crops and then discarded the row unless it also had a
/// nearest tile, and the nearest tile was computed only for the player's own map. So a companion standing in the
/// farmhouse read `wateringWhereabouts: []` while the farm outside was dry, and its fact line said "none on any map" -
/// the exact false negative the whole-map family exists to prevent. A count is a fact every loaded map can answer; the
/// nearest tile is a separate fact only one map can answer.
/// </para>
/// <para>
/// These cases drive the SHIPPED discovery through reflection against a real headless world (see
/// <see cref="WhereaboutsWorld"/>: real locations, a real farmer, and a content-free <c>Crop</c>), so
/// the predicates that decide what is dry and what is ripe are the engine's own. Nothing here re-implements the
/// projection, and the last case serialises the row with the Mod's own serializer to prove the pair is OMITTED rather
/// than written as null - which is what the Host validator and the wire schema both require.
/// </para>
/// </summary>
public sealed class OffMapWhereaboutsPublishingTests
{
    [Fact]
    public void ADryFarmIsReportedWhileTheCompanionStandsInTheFarmhouse()
    {
        using var world = WhereaboutsWorld.Create();
        world.PlaceDryCrop(world.Farm, x: 4, y: 9);
        world.PlaceDryCrop(world.Farm, x: 12, y: 20);
        world.StandIn(world.FarmHouse, x: 3, y: 5);

        IReadOnlyList<BridgeWateringWhereabouts> rows = world.Watering();

        rows.Should().ContainSingle("the farm is one of two loaded maps and it is the one with dry crops");
        rows[0].Location.Should().Be("ProbeFarm");
        rows[0].NeedsWaterCount.Should().Be(2, "the count is the whole map's, not a radius scan");
        // The defect: this row was dropped entirely, so the companion read "nothing needs water on any map".
        rows[0].NearestX.Should().BeNull("a tile on another map is not an address the companion can walk to");
        rows[0].NearestY.Should().BeNull();
    }

    [Fact]
    public void TheNearestDryCropOnThePlayersOwnMapKeepsItsTile()
    {
        using var world = WhereaboutsWorld.Create();
        world.PlaceDryCrop(world.Farm, x: 9, y: 9);
        world.PlaceDryCrop(world.Farm, x: 4, y: 4);
        world.StandIn(world.Farm, x: 5, y: 4);

        BridgeWateringWhereabouts row = world.Watering().Should().ContainSingle().Subject;

        row.Location.Should().Be("ProbeFarm");
        row.NeedsWaterCount.Should().Be(2);
        row.NearestX.Should().Be(4, "the nearest tile is the fact that makes the count actionable");
        row.NearestY.Should().Be(4);
    }

    [Fact]
    public void ARipeFarmIsReportedWhileTheCompanionStandsInTheFarmhouse()
    {
        using var world = WhereaboutsWorld.Create();
        world.PlaceRipeCrop(world.Farm, x: 7, y: 2);
        world.StandIn(world.FarmHouse, x: 3, y: 5);

        IReadOnlyList<BridgeHarvestWhereabouts> rows = world.Harvest();

        rows.Should().ContainSingle("the harvest family has the same shape and had the same defect");
        rows[0].Location.Should().Be("ProbeFarm");
        rows[0].ReadyForHarvestCount.Should().Be(1);
        rows[0].NearestX.Should().BeNull("a ripe crop on another map is a plan, not a place");
        rows[0].NearestY.Should().BeNull();
    }

    [Fact]
    public void TheNearestRipeCropOnThePlayersOwnMapKeepsItsTile()
    {
        using var world = WhereaboutsWorld.Create();
        world.PlaceRipeCrop(world.Farm, x: 9, y: 9);
        world.PlaceRipeCrop(world.Farm, x: 4, y: 4);
        world.StandIn(world.Farm, x: 5, y: 4);

        BridgeHarvestWhereabouts row = world.Harvest().Should().ContainSingle().Subject;

        row.ReadyForHarvestCount.Should().Be(2);
        row.NearestX.Should().Be(4);
        row.NearestY.Should().Be(4);
    }

    [Fact]
    public void AnOffMapRowIsSerialisedWithoutItsCoordinateKeys()
    {
        // ABSENT, not null. The Host refuses a `nearestX: null` (its predicate demands a tile when the key is there) and
        // the wire schema makes the pair both-or-neither, so a null written onto the wire would close the bridge on the
        // companion's first snapshot taken indoors. The serializer's own output is the authority this asserts against.
        using var world = WhereaboutsWorld.Create();
        world.PlaceDryCrop(world.Farm, x: 4, y: 9);
        world.PlaceRipeCrop(world.Farm, x: 7, y: 2);
        world.StandIn(world.FarmHouse, x: 3, y: 5);

        string watering = JsonSerializer.Serialize(world.Watering()[0], BridgeProtocol.JsonOptions);
        string harvest = JsonSerializer.Serialize(world.Harvest()[0], BridgeProtocol.JsonOptions);

        watering.Should().Be("{\"location\":\"ProbeFarm\",\"needsWaterCount\":1}");
        harvest.Should().Be("{\"location\":\"ProbeFarm\",\"readyForHarvestCount\":1}");
    }
}
