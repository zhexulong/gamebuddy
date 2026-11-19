using System.Collections.Generic;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The planner asks itself once per clearable neighbour, so a field of clearable tiles is a chain of stack
/// frames. These cases pin the bound rather than the shape of one route: a run died with STATUS_STACK_OVERFLOW
/// inside this planner on 2026-11-06, and a stack overflow kills the game process - no receipt, no verdict.
///
/// The counted line is the point: a bound whose refusals cannot be told from a wall is a bound the caller cannot
/// act on, so the cases that spend the budget print `expanded E · budget B · refused-for-budget R`.
/// </summary>
public sealed class ClearingPlannerDepthTests
{
    private readonly ITestOutputHelper output;

    public ClearingPlannerDepthTests(ITestOutputHelper output) => this.output = output;

    private static HashSet<(int X, int Y)> Walkable(params (int X, int Y)[] tiles) => new(tiles);

    /// <summary>One clearable weed per step east of the actor, walkable ground only under the actor.</summary>
    private static Dictionary<(int X, int Y), int> WeedChain(int length)
    {
        var clearable = new Dictionary<(int X, int Y), int>();
        for (int x = 1; x <= length; x += 1)
            clearable[(x, 0)] = 1;
        return clearable;
    }

    [Fact]
    public void ALongChainOfClearableTilesAnswersInsteadOfOverflowingTheStack()
    {
        // 200 clearable tiles in a row: every tile is clearable, so each neighbour asks the planner for the
        // next one - the shape that once ran one stack frame per tile. 200 is under the expansion budget, so
        // the honest answer is the real plan.
        ClearingPlan plan = ClearingPlanner.Plan((0, 0), (200, 0), Walkable((0, 0)), WeedChain(200));

        plan.Reachable.Should().BeTrue("200 expansions fit inside the budget, so the route is still found");
        plan.Cost.Should().Be(200);
        plan.BudgetExhausted.Should().BeFalse("a plan was found, so nothing was refused for budget");
    }

    [Fact]
    public void AChainLongerThanTheBudgetStopsAndSaysItCouldNotDecide()
    {
        // Past the budget the planner must return, not recurse: the alternative is STATUS_STACK_OVERFLOW,
        // which kills the game process and leaves the run with a reason code that names nothing.
        ClearingPlan plan = ClearingPlanner.Plan((0, 0), (400, 0), Walkable((0, 0)), WeedChain(400));

        plan.Reachable.Should().BeFalse(
            "the budget is what stops the recursion here, so no route is claimed");
        plan.BudgetExhausted.Should().BeTrue(
            "400 weeds is a bill this planner would not price, NOT a wall - `Reachable == false` alone says the wrong one");
        PlanNumbers(expanded: ClearingPlanner.ExpansionBudget, refused: 1);
    }

    [Fact]
    public void AWeedyFieldTheSizeOfAWholeMapAnswersInsteadOfOverflowingTheStack()
    {
        // The report this bound exists for: 80x65 is the largest standard farm map, and a field of weeds that
        // size used to be one stack frame per tile. Reaching the assertions below IS the evidence - a stack
        // overflow takes the process with it and never gets here.
        const int MapTiles = 80 * 65;

        ClearingPlan plan = ClearingPlanner.Plan((0, 0), (MapTiles, 0), Walkable((0, 0)), WeedChain(MapTiles));

        plan.Reachable.Should().BeFalse();
        plan.BudgetExhausted.Should().BeTrue("a whole map of weeds is past the budget by two orders of magnitude");
        PlanNumbers(expanded: ClearingPlanner.ExpansionBudget, refused: 1);
    }

    [Fact]
    public void TheDeclaredBudgetIsWhereTheBoundaryFallsAndOneTileMoreIsRefused()
    {
        // Two readings around the declared bound, so a budget that grew or shrank cannot pass unnoticed: the
        // budget is the most this planner will expand, and the tile past it is where the refusal begins.
        int budget = ClearingPlanner.ExpansionBudget;

        ClearingPlan atBudget = ClearingPlanner.Plan((0, 0), (budget, 0), Walkable((0, 0)), WeedChain(budget));
        ClearingPlan pastBudget = ClearingPlanner.Plan((0, 0), (budget + 1, 0), Walkable((0, 0)), WeedChain(budget + 1));

        atBudget.Reachable.Should().BeTrue(
            $"a chain of exactly {budget} clearable tiles is the most the declared budget expands");
        atBudget.BudgetExhausted.Should().BeFalse();
        pastBudget.Reachable.Should().BeFalse();
        pastBudget.BudgetExhausted.Should().BeTrue(
            $"one tile past the declared budget of {budget} is a refusal, not a wall");
        PlanNumbers(expanded: budget, refused: 1);
    }

    [Fact]
    public void AClearableTargetNothingStandsBesideIsAWallAndNotABudgetRefusal()
    {
        // The other answer `Reachable == false` can mean: nothing on any of the target's four sides can be
        // walked to or cleared, so no number of clears opens the way and no budget was spent pretending.
        var clearable = new Dictionary<(int X, int Y), int> { [(5, 0)] = 3 };

        ClearingPlan plan = ClearingPlanner.Plan((0, 0), (5, 0), Walkable((0, 0)), clearable);

        plan.Reachable.Should().BeFalse();
        plan.Clear.Should().BeEmpty();
        plan.BudgetExhausted.Should().BeFalse("this is a wall, and a wall is not a bill");
    }

    [Fact]
    public void AWalkableTargetBehindAWallIsAWallAndNotABudgetRefusal()
    {
        // The search's other refusal site: the target is walkable, the walk never arrives, and the exhaustion of
        // the frontier - not the budget - is what ended it.
        ClearingPlan plan = ClearingPlanner.Plan(
            (0, 0),
            (3, 0),
            Walkable((0, 0), (3, 0)),
            new Dictionary<(int X, int Y), int>());

        plan.Reachable.Should().BeFalse();
        plan.BudgetExhausted.Should().BeFalse("the frontier ended, the budget did not");
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
        ClearingPlan plan = ClearingPlanner.Plan((0, 0), (3, 0), Walkable((0, 0)), WeedChain(3));

        plan.Reachable.Should().BeTrue();
        plan.Cost.Should().Be(3);
        plan.Clear.Should().Equal(new (int X, int Y)[] { (1, 0), (2, 0), (3, 0) });
    }

    private void PlanNumbers(int expanded, int refused) =>
        this.output.WriteLine(
            $"expanded {expanded} · budget {ClearingPlanner.ExpansionBudget} · refused-for-budget {refused}");
}
