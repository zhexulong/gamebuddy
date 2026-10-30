using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The published order of an addressable target family when the family is larger than one plan can consume.
///
/// `MAX_PLAN_NODES` is 16 and the seed/sapling families publish up to 64 rows, so one script names at most sixteen of
/// them. Measured 2026-10-29 (`round7`): those families were 6.8 KB and 7.2 KB of a 32.8 KB observation and the sixteen
/// a plan could reach soonest were scattered through the list.
///
/// Trimming is not an option - `ExecutePlantSeed` recomputes the target id from slot and tile and refuses on a
/// mismatch - so every case below is about ORDER and one asserts that nothing is dropped.
/// </summary>
public sealed class TargetOrderingTests
{
    [Fact]
    public void TheNearestTileComesFirst()
    {
        var tiles = new List<TargetCandidate>
        {
            new(14, 10, 0), // 4 away from (10,10)
            new(11, 10, 0), // 1 away
            new(12, 12, 0), // 2 away
        };

        Ordered(tiles, actorX: 10, actorY: 10)
            .Select(tile => (tile.X, tile.Y))
            .Should()
            .Equal((11, 10), (12, 12), (14, 10));
    }

    [Fact]
    public void DistanceIsChebyshevSoADiagonalNeighbourIsAsNearAsAnOrthogonalOne()
    {
        // The range gate in the execution manager is Chebyshev (`IsTileWithinChebyshevRadius`), so a tile one step
        // diagonally is as reachable as one step sideways. Manhattan would order (11,11) after (12,10) and put the
        // action that is already in range second.
        var tiles = new List<TargetCandidate>
        {
            new(12, 10, 0), // Manhattan 2, Chebyshev 2 from (10,10)
            new(11, 11, 0), // Manhattan 2, Chebyshev 1
        };

        Ordered(tiles, actorX: 10, actorY: 10)[0].Should().Be(new TargetCandidate(11, 11, 0));
    }

    [Fact]
    public void NothingIsDroppedEvenWhenOnePlanCannotUseItAll()
    {
        // "The plan can only use sixteen, so publish sixteen" is the wrong fix: the dropped rows are addressable, and a
        // target the model was never shown is one it can never name.
        var tiles = Enumerable.Range(0, 64).Select(offset => new TargetCandidate(offset, 0, 0)).ToList();

        Ordered(tiles, actorX: 0, actorY: 0).Should().HaveCount(64);
    }

    [Fact]
    public void EqualDistancesKeepOneStableOrderAcrossTwoObservations()
    {
        // Two tiles the same distance away: without a tie-break, one unchanged world could publish two orders and the
        // ids would look unstable to a reader that is comparing them.
        var tiles = new List<TargetCandidate> { new(11, 10, 2), new(10, 11, 1) };

        var first = Ordered(tiles, actorX: 10, actorY: 10);
        var second = Ordered(Enumerable.Reverse(tiles).ToList(), actorX: 10, actorY: 10);

        first.Select(tile => (tile.X, tile.Y)).Should().Equal(second.Select(tile => (tile.X, tile.Y)));
        first[0].Should().Be(new TargetCandidate(10, 11, 1), "the lower slot wins the tie");
    }

    [Fact]
    public void TheOrderFollowsTheActorsCurrentTileRatherThanAFixedOrigin()
    {
        var tiles = new List<TargetCandidate> { new(5, 0, 0), new(0, 5, 0) };

        Ordered(tiles, actorX: 10, actorY: 0)[0].Should().Be(new TargetCandidate(5, 0, 0));
        Ordered(tiles, actorX: 0, actorY: 10)[0].Should().Be(new TargetCandidate(0, 5, 0));
    }

    private static IReadOnlyList<TargetCandidate> Ordered(IEnumerable<TargetCandidate> tiles, int actorX, int actorY) =>
        TargetOrdering.NearestFirstByChebyshev(tiles, actorX, actorY, tile => tile);
}
