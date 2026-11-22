using System;
using System.Collections.Generic;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE ROAD TO THE ANIMAL HOUSE'S PORCH, not the porch's four neighbours.
///
/// `PlaySessionAnimalDoorApproach` reserves the four tiles beside the house's door and `no_approach` asks whether the
/// session's START can walk to one of them - both measured on the field as it stands before the day's props exist. A
/// clearing with four free neighbours can still be sealed off from the farmhouse by the building itself, and nothing
/// asked that question. Measured 2026-11-22 (`round93`): 26 minutes, 233 bridge facts, `Barn 0` / `Coop 0` in the run
/// log, and no assertion anywhere had asked whether the house could reach the animal house at all.
///
/// The worlds below are the smallest ones that tell the two questions apart: a farmhouse on a one-tile lane, a barn
/// whose 2x2 footprint either crosses that lane or stands beside it, and a door whose approach ring is open ground on
/// both sides of the blockage.
/// </summary>
public sealed class AnimalBuildingPorchRouteTests
{
    private static readonly Point HouseDoor = new(1, 2);

    /// <summary>The barn's door tile, and the centre of the four tiles an actor stands on to use it.</summary>
    private static readonly Point BarnDoor = new(4, 2);

    /// <summary>The ground a farmer can reach: the farmhouse's lane, and the yard east of where the barn goes.</summary>
    private static readonly HashSet<Point> OpenGround = new()
    {
        new Point(1, 2), new Point(2, 2),
        new Point(5, 2), new Point(6, 2), new Point(5, 3), new Point(6, 3), new Point(4, 3),
    };

    /// <summary>The barn ASTRIDE the lane: the only ground that joined farmhouse and yard is its own footprint.</summary>
    private static readonly HashSet<Point> BarnAcrossTheLane = new()
    {
        new Point(3, 1), new Point(4, 1), new Point(3, 2), new Point(4, 2),
    };

    private static readonly Point[] BarnDoorRing =
    {
        new(4, 1), new(5, 2), new(3, 2), new(4, 3),
    };

    private static string KindOfTile(Point tile) => BarnAcrossTheLane.Contains(tile) ? "building:Barn" : "none";

    [Fact]
    public void AFreePorchWithNoRoadToIt_IsRefusedNamingTheTileTheRoadStoppedAt()
    {
        // THE OLD QUESTION ANSWERS "VACANT": two of the door's four tiles are open ground the session can stand on, so
        // `no_approach` is satisfied by this world - which is exactly why the run armed on a world it could not use.
        BarnDoorRing.Should().Contain(tile => OpenGround.Contains(tile));

        Action assert = () => ModEntry.AssertNativeLocalMultiDayAnimalPorchReachable(
            HouseDoor, BarnDoor, OpenGround.Contains, KindOfTile);

        // ...and the farmhouse reaches neither of them: the barn's own footprint is across the only lane, and the
        // refusal names the footprint tile the road stopped at and what stands there.
        assert.Should()
            .Throw<InvalidOperationException>()
            .WithMessage("animal_building_unreachable_from_house:door=1,2;porch=4,2;blocked_at=3,2;why=building:Barn");
    }

    [Fact]
    public void ABarnBesideTheLane_LeavesTheRoadOpen()
    {
        // The same barn one row north: the lane is untouched, the door's south tile (3,2) is the ground the road
        // arrives on, and there is nothing to refuse. A check that refused every world would pass the test above and
        // measure nothing at all.
        HashSet<Point> lane = new(OpenGround) { new Point(3, 2) };
        Point barnDoorBesideTheLane = new(3, 1);

        Action assert = () => ModEntry.AssertNativeLocalMultiDayAnimalPorchReachable(
            HouseDoor, barnDoorBesideTheLane, lane.Contains, KindOfTile);

        assert.Should().NotThrow();
    }

    [Fact]
    public void ARoadAroundTheBarn_IsNotRefused()
    {
        // The footprint still sits across the straight line and the yard is still the door's only approach. What the
        // check must not do is call that unreachable because the shortest way is walled - this is a flood, not a ray.
        HashSet<Point> detour = new(OpenGround) { new Point(2, 3), new Point(3, 3) };
        detour.Should().NotContain(new[] { new Point(3, 2), new Point(4, 1) }, "the barn still covers the direct tiles");

        Action assert = () => ModEntry.AssertNativeLocalMultiDayAnimalPorchReachable(
            HouseDoor, BarnDoor, detour.Contains, KindOfTile);

        assert.Should().NotThrow();
    }

    [Fact]
    public void AnExhaustedProbe_IsNotReadAsARefusal()
    {
        // The third zero, kept apart from the other two: a component the probe gave up on is NOT "no road" and NOT
        // "unreachable" - it is an answer nobody made, and it says so instead of refusing a site over a guess. The
        // quadrant is infinite while the porch stays outside it, so the flood must exhaust its budget.
        Action assert = () => ModEntry.AssertNativeLocalMultiDayAnimalPorchReachable(
            new Point(0, 0),
            new Point(50, 0),
            tile => tile.X <= 0 && tile.Y <= 0,
            _ => "none");

        assert.Should()
            .Throw<InvalidOperationException>()
            .WithMessage("fixture_native_local_multi_day_home_reachability_unknown:what=animal_porch;door=0,0;target=50,0");
    }
}
