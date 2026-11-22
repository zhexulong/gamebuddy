using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The play-session fixture's placement rules. A live receipt measured what happens without them: the actor started
/// in the Farm's corner between the farmhouse wall and the map edge, `component_tiles=2`, and targets a few tiles
/// away were unreachable for reasons the world never showed. The rules are pinned here because their effect shows up
/// only in a live session.
/// </summary>
public sealed class PlaySessionFixturePlacementTests
{
    private static List<Point> Grid(int width, int height) =>
        Enumerable.Range(0, width)
            .SelectMany(x => Enumerable.Range(0, height).Select(y => new Point(x, y)))
            .ToList();

    [Fact]
    public void CandidatesAreNearestTheStartFirst()
    {
        // This is the property that puts the props beside the actor instead of in the map's origin corner.
        Point start = new(20, 20);
        List<Point> ordered = PlaySessionFixturePlacement.PlaceableCandidates(Grid(40, 40), start).ToList();

        ordered.Should().NotBeEmpty();
        List<int> distances = ordered
            .Select(tile => System.Math.Max(System.Math.Abs(tile.X - start.X), System.Math.Abs(tile.Y - start.Y)))
            .ToList();
        distances.Should().BeInAscendingOrder("placement must walk outward from the start");
        distances[0].Should().Be(1, "the nearest placeable tiles are the DIAGONALS beside the actor: the four cardinal tiles are the excluded ring");
        List<Point> nearest = ordered.Where(tile => System.Math.Max(System.Math.Abs(tile.X - start.X), System.Math.Abs(tile.Y - start.Y)) == 1).ToList();
        nearest.Should().BeEquivalentTo(
            new[] { new Point(19, 19), new Point(19, 21), new Point(21, 19), new Point(21, 21) },
            "the cardinal exits stay free");
        ordered.Should().NotContain(tile => PlaySessionFixturePlacement.IsInStartRing(tile, start));
    }

    [Fact]
    public void TheActorsOwnRingIsNeverAPlacement()
    {
        // The exact way the old layout fenced the companion in: a prop on one of the four cardinal tiles beside it.
        Point start = new(5, 5);
        Point[] ring =
        {
            new(5, 5), new(4, 5), new(6, 5), new(5, 4), new(5, 6),
        };
        foreach (Point tile in ring)
        {
            PlaySessionFixturePlacement.IsInStartRing(tile, start).Should().BeTrue($"({tile.X},{tile.Y}) is the start or beside it");
            PlaySessionFixturePlacement.PlaceableCandidates(Grid(20, 20), start).Should().NotContain(tile);
        }
        PlaySessionFixturePlacement.IsInStartRing(new Point(4, 6), start).Should().BeFalse("that tile is a diagonal, not the ring");
    }

    [Fact]
    public void PlacementIsDeterministic()
    {
        // Two runs of the same fixture must produce the same world, or a session diff cannot be attributed.
        Point start = new(7, 3);
        PlaySessionFixturePlacement.PlaceableCandidates(Grid(30, 30), start)
            .Should()
            .Equal(PlaySessionFixturePlacement.PlaceableCandidates(Grid(30, 30), start));
    }

    [Fact]
    public void AStartInTheOpenKeepsFourExitsPlaceable()
    {
        // The fixture chooses a start whose four cardinal neighbours are passable and free; the ring exclusion is
        // what keeps them that way, so the actor is never boxed in by its own world.
        Point start = new(12, 12);
        List<Point> ordered = PlaySessionFixturePlacement.PlaceableCandidates(Grid(24, 24), start).ToList();
        Point[] exits = { new(11, 12), new(13, 12), new(12, 11), new(12, 13) };
        exits.Should().OnlyContain(exit => !ordered.Contains(exit));
    }

    /// <summary>The tiles a 7x4 barn stands on when its top-left corner is at this origin.</summary>
    private static List<Vector2> BarnFootprint(Point origin)
    {
        List<Vector2> footprint = new();
        for (int offsetX = 0; offsetX < 7; offsetX++)
            for (int offsetY = 0; offsetY < 4; offsetY++)
                footprint.Add(new Vector2(origin.X + offsetX, origin.Y + offsetY));
        return footprint;
    }

    [Fact]
    public void TheDoorRingIsTheFourTilesBesideTheDoorAndNeverTheDoorItself()
    {
        // The ring is one fact with two readers - the animal Given's `no_approach` probe and the prop rule that keeps
        // the ring clear - so it lives in one place. The door tile itself is a building tile nobody stands on.
        Point door = new(4, 2);
        PlaySessionFixturePlacement.DoorApproachTiles(door)
            .Should()
            .BeEquivalentTo(
                new[] { new Point(4, 3), new Point(3, 2), new Point(5, 2), new Point(4, 1) },
                "an actor stands BESIDE a door, never on it");
    }

    [Fact]
    public void NoPropMayTakeTheAnimalHousesGroundOrItsDoorRing()
    {
        // The house is sited BEFORE the props because it needs a 7x4 footprint of clean ground, and the props are
        // placed nearest the start first - which is where the house was sited. Without this rule the next prop takes a
        // tile the house is reached from, and the arm-time porch assertion then refuses a world whose every part was
        // placed lawfully. Measured 2026-11-22: two free footprints on the whole farm, one `no_approach`, one refused
        // because the building's own tile sat across the road home.
        Point origin = new(8, 9);
        Point door = new(12, 12);
        Point start = new(5, 5);
        List<Vector2> footprint = BarnFootprint(origin);
        List<Point> footprintTiles = footprint.Select(tile => new Point((int)tile.X, (int)tile.Y)).ToList();
        HashSet<Point> held = PlaySessionFixturePlacement.TilesHeldByBuilding(footprint, door);

        // The footprint entire, plus the ring - the tiles the ring shares with the footprint are the same tiles.
        held.Should().Contain(footprintTiles, "the barn's own ground is not placeable");
        held.Should().Contain(new Point(12, 13), "and neither is the one ring tile outside its footprint");
        held.Should().BeSubsetOf(footprintTiles.Concat(PlaySessionFixturePlacement.DoorApproachTiles(door)));

        List<Point> ordered = PlaySessionFixturePlacement.PlaceableCandidates(Grid(20, 20), start, held).ToList();
        ordered.Should().NotBeEmpty("the rule must not refuse the world");
        ordered.Should().NotIntersectWith(held, "a prop on the house or on its door ring spends the road to the animals");
        // The tiles beside the house stay placeable: the exclusion is the building's own ground and ring, not a
        // neighbourhood. Without the held list the very ring tiles ARE candidates, which is what makes this a rule.
        ordered.Should().Contain(new Point(7, 8));
        ordered.Should().Contain(new Point(13, 13));
        PlaySessionFixturePlacement.PlaceableCandidates(Grid(20, 20), start)
            .Should()
            .Contain(PlaySessionFixturePlacement.DoorApproachTiles(door), "the ring is free ground until the house owns it");
    }
}
