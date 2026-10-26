using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// A rock on the only route is the ordinary failure: the engine's finder treats every occupied tile as a wall,
/// so the caller is told `no_native_path` and never learns that clearing one thing would open the way.
///
/// These cases pin the two things the search must get right and one it must refuse:
///
///  1. clearing and walking are priced in the same unit, so "go around" and "deal with it" can be compared;
///  2. only the FIRST clear is offered as an action, because the executor clears one obstacle and re-plans
///     against a world that has changed;
///  3. an exhausted search refuses by name instead of returning a partial route as if it were whole.
///
/// Pure functions over three sets: no game, no XNA, plain value tuples.
/// </summary>
public sealed class SoftCostPathPlannerTests
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
    public void AnOpenRouteCostsOnePerStepAndNeedsNoClear()
    {
        HashSet<(int X, int Y)> open = Open(5, 5);

        SoftCostPath path = SoftCostPathPlanner.Plan(
            actor: (0, 0),
            target: (2, 0),
            isWalkable: open.Contains,
            clearCostAt: _ => null);

        path.Reachable.Should().BeTrue();
        path.TotalCost.Should().Be(2);
        path.ClearCount.Should().Be(0);
        path.FirstClear.Should().BeNull();
        path.Steps.Select(step => step.Tile).Should().Equal((1, 0), (2, 0));
    }

    [Fact]
    public void OneRockInACorridorIsPricedAgainstGoingAroundIt()
    {
        // A 1-wide corridor: (2,0) is the only way through, and it holds a rock priced 6.
        var walkable = new HashSet<(int X, int Y)> { (0, 0), (1, 0), (3, 0), (4, 0) };
        var clearable = new Dictionary<(int X, int Y), int> { [(2, 0)] = 6 };

        SoftCostPath path = SoftCostPathPlanner.Plan(
            actor: (0, 0),
            target: (4, 0),
            isWalkable: walkable.Contains,
            clearCostAt: tile => clearable.TryGetValue(tile, out int cost) ? cost : null);

        path.Reachable.Should().BeTrue();
        // (1,0)=1, then the 6-cost clear at (2,0), then two more walking steps: 1+6+1+1 = 9.
        path.TotalCost.Should().Be(9);
        path.ClearCount.Should().Be(1);
        path.FirstClear!.Tile.Should().Be((2, 0));
        // The walk before the clear is pure walking, which is what the executor dispatches first.
        path.WalkToFirstClear.Should().Equal((1, 0));
    }

    [Fact]
    public void WalkingAroundWinsWhenItIsCheaperThanClearing()
    {
        // Direct route through the rock costs 1 + 40; the detour costs three extra steps.
        var walkable = new HashSet<(int X, int Y)> { (0, 0), (1, 0), (2, 0), (3, 0) };
        var clearable = new Dictionary<(int X, int Y), int> { [(1, 0)] = 40 };
        // Make the detour real by opening the row below.
        walkable.UnionWith(new[] { (0, 1), (1, 1), (2, 1), (3, 1) });
        walkable.Remove((2, 0));
        clearable[(2, 0)] = 40;

        SoftCostPath path = SoftCostPathPlanner.Plan(
            actor: (0, 0),
            target: (3, 0),
            isWalkable: walkable.Contains,
            clearCostAt: tile => clearable.TryGetValue(tile, out int cost) ? cost : null);

        path.Reachable.Should().BeTrue();
        path.ClearCount.Should().Be(0, "walking round is cheaper than a 40-step clear");
        // One step down, two across, one back up: (0,0)->(0,1)->(1,1)->(2,1)->(3,1)->(3,0) = 5.
        path.TotalCost.Should().Be(5);
    }

    [Fact]
    public void ClearingWinsWhenItIsCheaperThanTheDetour()
    {
        var walkable = new HashSet<(int X, int Y)> { (0, 0), (1, 0), (2, 0), (3, 0) };
        walkable.UnionWith(new[] { (0, 1), (1, 1), (2, 1), (3, 1) });
        walkable.Remove((2, 0));
        var clearable = new Dictionary<(int X, int Y), int> { [(2, 0)] = 2 };

        SoftCostPath path = SoftCostPathPlanner.Plan(
            actor: (0, 0),
            target: (3, 0),
            isWalkable: walkable.Contains,
            clearCostAt: tile => clearable.TryGetValue(tile, out int cost) ? cost : null);

        path.ClearCount.Should().Be(1, "a 2-step clear beats a 2-step detour plus the extra walking");
        path.FirstClear!.Tile.Should().Be((2, 0));
    }

    [Fact]
    public void TheRouteReportsOnlyTheFirstClearEvenWhenTheWholeIdeaNeedsTwo()
    {
        // Two rocks in a 1-wide corridor. The route needs both, but only the first is an action.
        var walkable = new HashSet<(int X, int Y)> { (0, 0), (1, 0), (4, 0), (5, 0) };
        var clearable = new Dictionary<(int X, int Y), int> { [(2, 0)] = 3, [(3, 0)] = 3 };

        SoftCostPath path = SoftCostPathPlanner.Plan(
            actor: (0, 0),
            target: (5, 0),
            isWalkable: walkable.Contains,
            clearCostAt: tile => clearable.TryGetValue(tile, out int cost) ? cost : null);

        path.Reachable.Should().BeTrue();
        path.ClearCount.Should().Be(2, "the price of the whole idea is visible");
        path.FirstClear!.Tile.Should().Be((2, 0), "but the executor is told only the first");
        path.WalkToFirstClear.Should().Equal((1, 0));
    }

    [Fact]
    public void AnExhaustedSearchRefusesByNameInsteadOfReturningAPartialRoute()
    {
        HashSet<(int X, int Y)> open = Open(200, 200);

        SoftCostPath path = SoftCostPathPlanner.Plan(
            actor: (0, 0),
            target: (199, 199),
            isWalkable: open.Contains,
            clearCostAt: _ => null,
            maxExpansions: 32);

        path.Reachable.Should().BeFalse();
        path.ReasonCode.Should().Be("search_budget_exhausted");
        path.Steps.Should().BeEmpty("a partial route presented as whole is the failure this exists to prevent");
    }

    [Fact]
    public void AWallThatCannotBeClearedIsUnreachableByName()
    {
        var walkable = new HashSet<(int X, int Y)> { (0, 0), (1, 0) };

        SoftCostPath path = SoftCostPathPlanner.Plan(
            actor: (0, 0),
            target: (2, 0),
            isWalkable: walkable.Contains,
            clearCostAt: _ => null);

        path.Reachable.Should().BeFalse();
        path.ReasonCode.Should().Be("no_route_even_with_clearing");
    }

    [Fact]
    public void TheSameWorldAlwaysYieldsTheSameRoute()
    {
        HashSet<(int X, int Y)> open = Open(6, 6);
        var clearable = new Dictionary<(int X, int Y), int> { [(2, 2)] = 3, [(3, 3)] = 3 };
        open.Remove((2, 2));
        open.Remove((3, 3));

        SoftCostPath first = SoftCostPathPlanner.Plan((0, 0), (5, 5), open.Contains,
            tile => clearable.TryGetValue(tile, out int cost) ? cost : null);
        SoftCostPath second = SoftCostPathPlanner.Plan((0, 0), (5, 5), open.Contains,
            tile => clearable.TryGetValue(tile, out int cost) ? cost : null);

        first.Steps.Select(step => step.Tile).Should().Equal(second.Steps.Select(step => step.Tile));
        first.TotalCost.Should().Be(second.TotalCost);
    }

    [Fact]
    public void TheActorAlreadyStandingOnTheTargetPaysNothing()
    {
        SoftCostPath path = SoftCostPathPlanner.Plan(
            actor: (3, 3),
            target: (3, 3),
            isWalkable: Open(5, 5).Contains,
            clearCostAt: _ => null);

        path.Reachable.Should().BeTrue();
        path.TotalCost.Should().Be(0);
        path.Steps.Should().BeEmpty();
        path.ReasonCode.Should().Be("already_there");
    }
}
