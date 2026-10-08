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
}
