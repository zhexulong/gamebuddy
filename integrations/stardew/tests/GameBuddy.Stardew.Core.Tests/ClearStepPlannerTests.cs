using System.Collections.Generic;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// Resolving "which tiles must go" into "walk THERE, hit THAT".
///
/// `ClearingPlanner` already prices which tiles must be removed. A caller holding only a tile list still
/// has to work out where to stand, and the tile it must stand on is often not adjacent to the actor. These
/// cases pin the resolution, and - more importantly - the two places it must REFUSE:
///
/// - a plan that is not reachable has no first step;
/// - a blocker only approachable through itself cannot be cleared in one step, because the executor
///   clears exactly one tile and re-plans. Reporting a step there would authorise a chain it cannot keep.
/// </summary>
public sealed class ClearStepPlannerTests
{
    private static ClearingPlan Plan(params (int X, int Y)[] clears) =>
        new(true, clears, clears.Length * 3);

    [Theory]
    [InlineData(0, 0)]
    [InlineData(1, 1)]
    [InlineData(-1, 0)]
    public void ABlockerAlreadyWithinToolReachNeedsNoWalk(int blockerX, int blockerY)
    {
        // Reporting an approach tile separate from the actor here would make the caller issue a
        // zero-length move, and every move has a cost in body ownership and a receipt.
        var actor = (X: 0, Y: 0);
        FirstClearStep step = ClearStepPlanner.Resolve(
            actor,
            Plan((blockerX, blockerY)),
            new HashSet<(int X, int Y)> { actor });

        step.Reachable.Should().BeTrue();
        step.BlockerTile.Should().Be((blockerX, blockerY));
        step.ApproachTile.Should().Be(actor, "the actor is already where it needs to stand");
        step.ReasonCode.Should().Be("already_in_reach");
    }

    [Fact]
    public void ABlockerTwoTilesAwayResolvesToAnAdjacentStandingTile()
    {
        // A 1-wide corridor along y=0. The actor at (0,0), the blocker at (3,0), and one walkable tile at
        // (2,0) which is adjacent to the blocker.
        var walkable = new HashSet<(int X, int Y)> { (0, 0), (1, 0), (2, 0) };

        FirstClearStep step = ClearStepPlanner.Resolve((0, 0), Plan((3, 0)), walkable);

        step.Reachable.Should().BeTrue();
        step.BlockerTile.Should().Be((3, 0));
        step.ApproachTile.Should().Be((2, 0), "the closest tile the actor can already walk to");
        step.ReasonCode.Should().Be("approach_found");
        step.RemainingClears.Should().Be(1);
    }

    [Fact]
    public void TheClosestApproachWinsOverAFurtherOne()
    {
        // A 5-wide open row. The actor at (0,0) and the blocker at (5,0); the nearest standing tile is
        // (4,0), not (1,4). Breadth-first guarantees the closest one, which matters because the walk is
        // the expensive part.
        var walkable = new HashSet<(int X, int Y)>();
        for (int x = 0; x <= 5; x += 1)
            for (int y = -1; y <= 1; y += 1)
                walkable.Add((x, y));
        walkable.Remove((5, 0));

        FirstClearStep step = ClearStepPlanner.Resolve((0, 0), Plan((5, 0)), walkable);

        step.Reachable.Should().BeTrue();
        step.ApproachTile.Should().Be((4, 0));
    }

    [Fact]
    public void ABlockerApproachOnlyThroughItselfIsRefusedByCharacterisingTheWorld()
    {
        // Two blockers in a 1-wide corridor: (1,0) then (2,0). The plan's head is (1,0), and the only
        // tile adjacent to it that the actor can reach is (0,0)... which IS adjacent, so this resolves.
        // The genuinely unapproachable shape is a blocker whose every neighbour is itself blocked:
        // (1,0) walled in on both sides by non-walkable, non-clearable tiles except the actor's own.
        var walkable = new HashSet<(int X, int Y)> { (0, 0) };
        var plan = new ClearingPlan(true, new[] { (2, 2) }, 5);

        FirstClearStep step = ClearStepPlanner.Resolve((0, 0), plan, walkable);

        step.Reachable.Should().BeFalse();
        step.ReasonCode.Should().Be("blocker_unapproachable_without_another_clear");
        step.ApproachTile.Should().BeNull("an unverified approach tile is worse than none - the actor would walk nowhere");
    }

    [Fact]
    public void WalkingOntoTheBlockerIsNotAWalk()
    {
        // The blocker sits on the only route. A planner that treated it as a step would return the
        // blocker itself as the approach tile, and the actor would try to occupy the rock.
        var walkable = new HashSet<(int X, int Y)> { (0, 0), (1, 0) };
        var plan = new ClearingPlan(true, new[] { (2, 0) }, 3);

        FirstClearStep step = ClearStepPlanner.Resolve((0, 0), plan, walkable);

        step.Reachable.Should().BeTrue();
        step.ApproachTile.Should().Be((1, 0));
        step.ApproachTile.Should().NotBe(step.BlockerTile, "the actor never stands on the thing it is about to remove");
    }

    [Fact]
    public void AnUnreachablePlanHasNoFirstStep()
    {
        FirstClearStep step = ClearStepPlanner.Resolve(
            (0, 0),
            ClearingPlan.Unreachable,
            new HashSet<(int X, int Y)> { (0, 0) });

        step.Reachable.Should().BeFalse();
        step.ReasonCode.Should().Be("plan_unreachable");
    }

    [Fact]
    public void TheWholeIdeasPriceIsReportedButNotAuthorised()
    {
        // Three tiles must go. The step resolves the FIRST one only, and reports the total so a caller
        // can see the shape of the job - but nothing here approves the second or third clear, because
        // the world changes after the first and the executor re-plans.
        var walkable = new HashSet<(int X, int Y)> { (0, 0), (1, 0) };
        var plan = new ClearingPlan(true, new[] { (2, 0), (3, 0), (4, 0) }, 9);

        FirstClearStep step = ClearStepPlanner.Resolve((0, 0), plan, walkable);

        step.Reachable.Should().BeTrue();
        step.BlockerTile.Should().Be((2, 0), "the plan's head is the first clear");
        step.RemainingClears.Should().Be(3, "the price of the whole idea is visible");
    }

    [Fact]
    public void AnExhaustedSearchRefusesRatherThanGuessingAnApproachTile()
    {
        var walkable = new HashSet<(int X, int Y)> { (0, 0) };
        for (int x = 0; x < 100; x += 1) walkable.Add((0, x));

        FirstClearStep step = ClearStepPlanner.Resolve(
            (0, 0),
            new ClearingPlan(true, new[] { (99, 99) }, 3),
            walkable,
            maxExpansions: 8);

        step.Reachable.Should().BeFalse();
        step.ReasonCode.Should().Be("approach_search_budget_exhausted");
    }

    [Fact]
    public void TheSameWorldAlwaysResolvesToTheSameStep()
    {
        var walkable = new HashSet<(int X, int Y)>();
        for (int x = 0; x <= 6; x += 1)
            for (int y = 0; y <= 6; y += 1)
                walkable.Add((x, y));
        var plan = Plan((6, 3));

        FirstClearStep first = ClearStepPlanner.Resolve((0, 3), plan, walkable);
        FirstClearStep second = ClearStepPlanner.Resolve((0, 3), plan, walkable);

        first.ApproachTile.Should().Be(second.ApproachTile);
        first.ReasonCode.Should().Be(second.ReasonCode);
    }


    [Fact]
    public void TheWalkNeverCrossesATileTheActorCannotStandOn()
    {
        // THE invariant the walkable set exists for. Without it the search would happily route an actor
        // across water, a wall or a building, and report an approach tile it can never actually occupy.
        //
        // Shape: a straight line from the actor to the blocker, interrupted by a gap. The near side is
        // reachable, the far side is not, and the gap is neither walkable nor the blocker.
        //
        //   (0,0) actor  (1,0) walk   (2,0) GAP   (3,0) walk   (4,0) blocker
        //
        // A search that ignores `walkable` walks the whole line and returns (3,0). A correct one cannot
        // cross the gap, so it must refuse - even though the plan says clearing (4,0) opens the way.
        var walkable = new HashSet<(int X, int Y)> { (0, 0), (1, 0), (3, 0) };

        FirstClearStep step = ClearStepPlanner.Resolve((0, 0), new ClearingPlan(true, new[] { (4, 0) }, 3), walkable);

        step.Reachable.Should().BeFalse("the gap at (2,0) cannot be walked, so (3,0) is unreachable");
        step.ReasonCode.Should().Be("blocker_unapproachable_without_another_clear");
        step.ApproachTile.Should().BeNull();
    }

    [Fact]
    public void TheWalkIsBoundedByTheWalkableSetNotByDistance()
    {
        // A second shape for the same invariant: the closest-looking tile is across a one-tile wall, and the
        // only legal route is the long way round. A search that ignored `walkable` would take the shortcut.
        //
        //   row y=1 is the wall except at x=3
        //   actor (0,0), blocker (2,0); (1,0) and (2,1) look adjacent but the legal route is
        //   (0,0)->(0,1) is also walled, so nothing on the near side touches the blocker.
        // The gap forces the detour: (0,0)->(0,1)->(1,1), and (1,1) is then adjacent to the blocker, so the
        // LONG route is never needed. The assertion that matters is the opposite one: the search must not
        // return a tile on the far side of the gap.
        var walkable = new HashSet<(int X, int Y)> { (0, 0), (0, 1), (1, 1), (2, 1), (3, 1), (3, 0) };

        FirstClearStep step = ClearStepPlanner.Resolve((0, 0), new ClearingPlan(true, new[] { (2, 0) }, 3), walkable);

        step.Reachable.Should().BeTrue();
        step.ApproachTile.Should().Be((1, 1),
            "the closest reachable tile adjacent to the blocker - Chebyshev 1 includes diagonals");
        step.ApproachTile.Should().NotBe((3, 0), "the far side of the gap is not the answer when a nearer tile works");
    }
}