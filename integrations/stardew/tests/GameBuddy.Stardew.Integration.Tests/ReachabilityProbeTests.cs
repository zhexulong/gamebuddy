using FluentAssertions;
using Microsoft.Xna.Framework;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class ReachabilityProbeTests
{
    [Fact]
    public void TargetSurroundedInNativeEightNeighbourhood_IsEnclosed()
    {
        // Enclosure is decidable only after the actor's component is fully
        // enumerated, so the fixture must give the actor a FINITE component:
        // the probe walks the whole 3x3 room and never reaches the target's
        // eight-neighbourhood beyond the sealed wall.
        Point actor = new(0, 0);
        Point target = new(5, 0);
        static bool InTheRoom(Point tile) =>
            tile.X >= 0 && tile.X <= 2 && tile.Y >= -1 && tile.Y <= 1;

        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            actor,
            target,
            tile => InTheRoom(tile) && tile != target,
            maxVisited: 2000);

        verdict.Should().NotBeNull();
        verdict!.Value.TargetEnclosed.Should().BeTrue();
    }

    [Fact]
    public void OpenWorldComponentBeyondTheBudget_AbandonsTheDerivedClaim()
    {
        // An unbounded component must not produce a claim: the probe gives up when
        // it exhausts its budget instead of reporting enclosure. The half-plane
        // keeps the component infinite while the target stays outside it (its
        // eight-neighbourhood never intersects y <= 0, so nothing short-circuits
        // the walk into an honest "not enclosed").
        Point actor = new(0, 0);
        Point target = new(0, 5);

        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            actor,
            target,
            tile => tile.Y <= 0,
            maxVisited: 64);

        verdict.Should().BeNull("the bounded probe must not claim anything about an unbounded component");
    }

    [Fact]
    public void UnstandableTargetWithReachableNeighbour_IsNotEnclosed()
    {
        Point actor = new(0, 0);
        Point target = new(2, 0);

        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            actor,
            target,
            tile => tile != target,
            maxVisited: 2000);

        verdict.Should().NotBeNull();
        verdict!.Value.TargetEnclosed.Should().BeFalse();
    }

    [Fact]
    public void ReachableNeighbourBeyondProbeBudget_AbandonsTheDerivedClaim()
    {
        Point actor = new(0, 0);
        Point target = new(100, 0);

        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            actor,
            target,
            tile => tile == new Point(99, 0) || tile.X >= 0 && tile.X < 99 && tile.Y == 0,
            maxVisited: 3);

        verdict.Should().BeNull("the bounded probe must not claim enclosure after its hard limit");
    }

    [Fact]
    public void ActorAlreadyOnTarget_IsDefinedAsNotEnclosed()
    {
        Point tile = new(4, 7);

        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            tile,
            tile,
            _ => false,
            maxVisited: 2000);

        verdict.Should().NotBeNull();
        verdict!.Value.TargetEnclosed.Should().BeFalse();
    }
}
