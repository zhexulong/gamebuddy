using System;
using System.Collections.Generic;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Arithmetic tests for the move_to_tile approach substitution.
///
/// A live ladder run refused 10 of its 29 movement dispatches with
/// <c>no_native_path</c> because the agent aimed at tiles that hold the object it
/// wanted to touch. Two of those refusals were outright false (the actor was
/// already inside the arrival contract) and the rest were unactionable (the refusal
/// named no cause). The selection below is the deterministic half of the fix, so it
/// is tested as arithmetic rather than through a live game.
/// </summary>
public class MoveApproachSubstitutionTests
{
    private static Func<Vector2, bool> StandableAt(params Vector2[] tiles)
    {
        HashSet<Vector2> allowed = new(tiles);
        return candidate => allowed.Contains(candidate);
    }

    [Fact]
    public void ArrivalAlreadySatisfied_IsRecognisedForAnExactRequestOnTheTile()
    {
        StardewBodyController.IsArrivalDelta(0, 0, allowAdjacentArrival: false).Should().BeTrue();
    }

    [Fact]
    public void ArrivalAlreadySatisfied_IsNotClaimedForANeighbourWithoutAdjacency()
    {
        // The exact-tile request must still walk: standing one tile away is not
        // arrival unless the directive asked for an adjacent approach.
        StardewBodyController.IsArrivalDelta(1, 0, allowAdjacentArrival: false).Should().BeFalse();
        StardewBodyController.IsArrivalDelta(0, 1, allowAdjacentArrival: false).Should().BeFalse();
    }

    [Fact]
    public void ArrivalAlreadySatisfied_IsRecognisedForASubstitutedApproach()
    {
        // The substituted approach is requested WITH adjacency, so its target (the
        // standable neighbour) counts as arrival for the whole free ring -- which is
        // why the planner has nothing to plan and success is the honest terminal.
        StardewBodyController.IsArrivalDelta(1, 1, allowAdjacentArrival: true).Should().BeTrue();
        StardewBodyController.IsArrivalDelta(1, 0, allowAdjacentArrival: true).Should().BeTrue();
    }

    [Fact]
    public void ApproachSelection_PicksTheStandableNearestNeighbour()
    {
        Vector2 target = new(10f, 10f);
        // Only the far side is standable, so the substitution is not "the first
        // candidate" -- it is the only legal interaction position.
        Func<Vector2, bool> standable = StandableAt(new Vector2(10f, 11f));
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(10f, 20f), standable)
            .Should().Be(new Vector2(10f, 11f));
    }

    [Fact]
    public void ApproachSelection_PrefersTheNeighbourClosestToTheActor()
    {
        Vector2 target = new(10f, 10f);
        Func<Vector2, bool> standable = StandableAt(
            new Vector2(9f, 10f),
            new Vector2(10f, 11f));
        // Actor below the target: the tile under it is nearer than the one left of it.
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(10f, 12f), standable)
            .Should().Be(new Vector2(10f, 11f));
        // Actor to the left: the preference reverses.
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(7f, 10f), standable)
            .Should().Be(new Vector2(9f, 10f));
    }

    [Fact]
    public void ApproachSelection_BreaksDistanceTiesByTheDeclaredCandidateOrder()
    {
        Vector2 target = new(10f, 10f);
        Func<Vector2, bool> standable = StandableAt(
            new Vector2(11f, 10f),
            new Vector2(9f, 10f),
            new Vector2(10f, 9f),
            new Vector2(10f, 11f));
        // All four are equidistant from (10,10): the first candidate of the declared
        // order (left, right, up, down) wins, so the choice cannot drift between runs.
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(10f, 10f), standable)
            .Should().Be(new Vector2(9f, 10f));
    }

    [Fact]
    public void ApproachSelection_OnlyConsidersCardinalNeighbours()
    {
        Vector2 target = new(10f, 10f);
        Func<Vector2, bool> standable = StandableAt(
            new Vector2(9f, 9f),
            new Vector2(11f, 11f));
        // Diagonals are inside the arrival ring but not in the published
        // interaction-position set, so a diagonal-only world yields no substitution
        // and the request is refused with its cause named.
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(5f, 5f), standable)
            .Should().BeNull();
    }

    [Fact]
    public void ApproachSelection_ReturnsNullWhenNothingAroundTheTargetIsStandable()
    {
        Vector2 target = new(10f, 10f);
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(1f, 1f), _ => false)
            .Should().BeNull();
    }
}
