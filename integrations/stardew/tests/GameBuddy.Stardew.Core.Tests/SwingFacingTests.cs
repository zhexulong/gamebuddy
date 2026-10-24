using System;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// Which way the actor must face so the engine's swing lands on the target.
///
/// `Character.GetToolLocation` derives the swing point from the bounding box plus one tile in the
/// facing direction, so "swing at tile T" is only achievable when the actor stands on a neighbour of T
/// and faces toward it. The Mod currently bypasses that geomet rically by naming the target tile
/// directly, which always hits and therefore lets the picture (where the actor looks) disagree with the
/// effect (which tile changed).
///
/// This is the rule that closes it: given the actor's tile and the target's tile, say which facing makes
/// the engine's own geometry land on the target - or that none does, which is a refusal the caller must
/// report rather than a swing to force.
///
/// Facing values are the engine's: 0 up, 1 right, 2 down, 3 left.
/// </summary>
public sealed class SwingFacingTests
{
    [Theory]
    [InlineData(10, 10, 10, 9, 0)] // target above
    [InlineData(10, 10, 11, 10, 1)] // target right
    [InlineData(10, 10, 10, 11, 2)] // target below
    [InlineData(10, 10, 9, 10, 3)] // target left
    public void ACardinalNeighbourNamesTheFacingThatPointsAtIt(int ax, int ay, int tx, int ty, int expected)
    {
        SwingFacing.For(actor: (ax, ay), target: (tx, ty)).Should().Be(expected);
    }

    [Fact]
    public void ADiagonalTargetHasNoFacingBecauseTheEngineSwingsCardinally()
    {
        // The eight-neighbour approach search can put the actor diagonally beside a target, and then no
        // facing reaches it: the engine's four cases are one tile up/right/down/left. Saying so is the
        // point - the caller must step to a cardinal neighbour first, or accept that the swing misses.
        SwingFacing.For(actor: (10, 10), target: (11, 11)).Should().BeNull();
    }

    [Fact]
    public void StandingOnTheTargetHasNoFacing()
    {
        SwingFacing.For(actor: (10, 10), target: (10, 10)).Should().BeNull();
    }

    [Fact]
    public void ATargetTwoTilesAwayHasNoFacing()
    {
        // Out of reach: the engine's offset is one tile, not a ray.
        SwingFacing.For(actor: (10, 10), target: (10, 8)).Should().BeNull();
    }
}
