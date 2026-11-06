using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The planner asks itself once per clearable neighbour, so a field of clearable tiles is a chain of stack
/// frames. These cases pin the bound rather than the shape of one route: a run died with STATUS_STACK_OVERFLOW
/// inside this planner on 2026-11-06, and a stack overflow kills the game process - no receipt, no verdict.
/// </summary>
public sealed class ClearingPlannerDepthTests
{
    private static HashSet<(int X, int Y)> Walkable(params (int X, int Y)[] tiles) => new(tiles);

    [Fact]
    public void ALongChainOfClearableTilesAnswersInsteadOfOverflowingTheStack()
    {
        // 200 clearable tiles in a row, with walkable ground only at the actor's end. Every tile is
        // clearable, so each neighbour asks the planner for the next one: this is the shape that once ran one
        // stack frame per tile, and 200 is under the expansion budget, so the honest answer is the real plan.
        var clearable = new Dictionary<(int X, int Y), int>();
        for (int x = 1; x <= 200; x += 1)
            clearable[(x, 0)] = 1;

        ClearingPlan plan = ClearingPlanner.Plan((0, 0), (200, 0), Walkable((0, 0)), clearable);

        plan.Reachable.Should().BeTrue("200 expansions fit inside the budget, so the route is still found");
        plan.Cost.Should().Be(200);
    }

    [Fact]
    public void AChainLongerThanTheBudgetStopsAndSaysItCouldNotDecide()
    {
        // Past the budget the planner must return, not recurse: the alternative is STATUS_STACK_OVERFLOW,
        // which kills the game process and leaves the run with a reason code that names nothing.
        var clearable = new Dictionary<(int X, int Y), int>();
        for (int x = 1; x <= 400; x += 1)
            clearable[(x, 0)] = 1;

        ClearingPlan plan = ClearingPlanner.Plan((0, 0), (400, 0), Walkable((0, 0)), clearable);

        plan.Reachable.Should().BeFalse(
            "the budget is what stops the recursion here, and Unreachable is the only answer it can give");
    }

    [Fact]
    public void ACycleOfClearableTilesDoesNotAskForTheTileItIsAlreadyExpanding()
    {
        // Two clearable tiles beside the actor that are neighbours of each other: the naive recursion would
        // alternate between them forever.
        var clearable = new Dictionary<(int X, int Y), int> { [(1, 0)] = 1, [(1, 1)] = 1 };

        ClearingPlan plan = ClearingPlanner.Plan((0, 0), (1, 0), Walkable((0, 0)), clearable);

        plan.Reachable.Should().BeTrue("a single adjacent clear is still the cheapest route");
        plan.Clear.Should().Equal(new (int X, int Y)[] { (1, 0) });
    }

    [Fact]
    public void AShortChainStillProducesTheClearsItChargesFor()
    {
        // The budget must not change the answer for the ordinary case: three tiles of weeds on the way.
        var clearable = new Dictionary<(int X, int Y), int> { [(1, 0)] = 1, [(2, 0)] = 1, [(3, 0)] = 1 };

        ClearingPlan plan = ClearingPlanner.Plan((0, 0), (3, 0), Walkable((0, 0)), clearable);

        plan.Reachable.Should().BeTrue();
        plan.Cost.Should().Be(3);
        plan.Clear.Should().Equal(new (int X, int Y)[] { (1, 0), (2, 0), (3, 0) });
    }
}
