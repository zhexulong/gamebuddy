using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// Choosing where to stand is the step before every native tool action: the actor must reach a tile
/// beside the target, and only then can the swing happen. The existing selector answers "which
/// standable tile is nearest", which is not the same question - a tile can be standable and still be
/// walled off from where the actor is, and the engine's own finder then answers `no_native_path` after
/// the walk has been committed to.
///
/// Measured on the multi-day farm 2026-10-24: approach tiles were chosen on the far side of a fence and
/// the action refused, while a reachable tile two steps further away was free the whole time.
///
/// These cases pin the property that closes it: a candidate must be reachable, not merely standable.
/// </summary>
public sealed class StandingApproachTests
{
    private static HashSet<(int X, int Y)> Open(int width, int height)
    {
        var tiles = new HashSet<(int X, int Y)>();
        for (int x = 0; x < width; x += 1)
            for (int y = 0; y < height; y += 1)
                tiles.Add((x, y));
        return tiles;
    }

    [Fact]
    public void TheNearestStandableTileWinsWhenEverythingIsReachable()
    {
        var standable = Open(10, 10);
        var reachable = Open(10, 10);

        (int X, int Y)? pick = ApproachTileSelector.Select(
            target: (5, 5),
            actor: (5, 8),
            isStandable: t => standable.Contains(t),
            isReachable: t => reachable.Contains(t));

        pick.Should().Be((5, 6), "the tile directly above the target is nearest to the actor");
    }

    [Fact]
    public void ANearerTileThatCannotBeWalkedToIsSkipped()
    {
        // The tile above the target is standable but cut off; the tile below is reachable.
        var standable = new HashSet<(int X, int Y)> { (5, 6), (5, 4) };
        var reachable = new HashSet<(int X, int Y)> { (5, 4) };

        (int X, int Y)? pick = ApproachTileSelector.Select(
            target: (5, 5),
            actor: (5, 3),
            isStandable: t => standable.Contains(t),
            isReachable: t => reachable.Contains(t));

        pick.Should().Be((5, 4), "an unreachable tile is not an approach");
    }

    [Fact]
    public void WithNoReachableTileThereIsNoAnswerRatherThanAWrongOne()
    {
        var standable = new HashSet<(int X, int Y)> { (5, 6) };
        var reachable = new HashSet<(int X, int Y)>();

        (int X, int Y)? pick = ApproachTileSelector.Select(
            target: (5, 5),
            actor: (0, 0),
            isStandable: t => standable.Contains(t),
            isReachable: t => reachable.Contains(t));

        pick.Should().BeNull("no answer is honest; a standable-but-unreachable tile is a refusal waiting to happen");
    }

    [Fact]
    public void TheChoiceIsDeterministicWhenTwoCandidatesAreEquidistant()
    {
        var standable = Open(10, 10);
        var reachable = Open(10, 10);

        var first = ApproachTileSelector.Select((5, 5), (5, 5), t => standable.Contains(t), t => reachable.Contains(t));
        var again = ApproachTileSelector.Select((5, 5), (5, 5), t => standable.Contains(t), t => reachable.Contains(t));

        again.Should().Be(first, "the same world must choose the same tile, or a run-to-run diff means nothing");
    }

    [Fact]
    public void ADiagonalApproachStillCountsBecauseTheFieldCanBeDense()
    {
        // Cardinal tiles blocked, one diagonal free: a real field does present this.
        var standable = new HashSet<(int X, int Y)> { (6, 6) };
        var reachable = new HashSet<(int X, int Y)> { (6, 6) };

        (int X, int Y)? pick = ApproachTileSelector.Select(
            target: (5, 5),
            actor: (8, 8),
            isStandable: t => standable.Contains(t),
            isReachable: t => reachable.Contains(t));

        pick.Should().Be((6, 6));
    }

    [Fact]
    public void TheTargetItselfIsNeverAnApproach()
    {
        var standable = Open(10, 10);
        var reachable = Open(10, 10);

        (int X, int Y)? pick = ApproachTileSelector.Select(
            target: (5, 5),
            actor: (5, 5),
            isStandable: t => standable.Contains(t),
            isReachable: t => reachable.Contains(t));

        pick.Should().NotBe((5, 5), "standing on the target is not approaching it");
    }
}
