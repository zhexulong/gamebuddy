using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// A target the actor cannot walk to is the ordinary case in a player's own world: a rock, a stump, a
/// crop, a placed object. The engine's finder answers "no path" and stops there, so the refusal says
/// nothing about whether clearing one thing would open the way - and an agent that is only told "no"
/// re-aims at neighbouring tiles, which is the shape three live runs took tonight.
///
/// `ClearingPlanner` answers what the refusal cannot: given the walkable tiles, the tiles occupied by
/// something CLEARABLE with its cost, and the actor's tile, which clears (if any) open a route to the
/// target, and what do they cost.
///
/// These cases pin the answers without a game: the search is a pure function over three sets, so the
/// coordinates are plain value tuples rather than XNA types.
/// </summary>
public sealed class ClearingPlannerTests
{
    private static HashSet<(int X, int Y)> Walkable(int width, int height)
    {
        var tiles = new HashSet<(int X, int Y)>();
        for (int x = 0; x < width; x += 1)
            for (int y = 0; y < height; y += 1)
                tiles.Add((x, y));
        return tiles;
    }

    [Fact]
    public void AReachableTargetNeedsNothingCleared()
    {
        ClearingPlan plan = ClearingPlanner.Plan(
            actor: (0, 0),
            target: (2, 2),
            walkable: Walkable(5, 5),
            clearable: new Dictionary<(int X, int Y), int>());

        plan.Reachable.Should().BeTrue();
        plan.Clear.Should().BeEmpty("nothing stands in the way");
        plan.Cost.Should().Be(0);
    }

    [Fact]
    public void OneObstacleInACorridorIsNamedWithItsCost()
    {
        var walkable = new HashSet<(int X, int Y)> { (0, 0), (1, 0), (3, 0), (4, 0) };
        var clearable = new Dictionary<(int X, int Y), int> { [(2, 0)] = 9 };

        ClearingPlan plan = ClearingPlanner.Plan((0, 0), (4, 0), walkable, clearable);

        plan.Reachable.Should().BeTrue();
        plan.Clear.Should().ContainSingle().Which.Should().Be((2, 0));
        plan.Cost.Should().Be(9);
    }

    [Fact]
    public void TheCheapestOfTwoRoutesWins()
    {
        var walkable = new HashSet<(int X, int Y)>
        {
            (0, 0), (1, 0), (3, 0), (4, 0),
            (0, 2), (2, 2), (4, 2),
            (0, 1), (4, 1),
        };
        var clearable = new Dictionary<(int X, int Y), int>
        {
            [(2, 0)] = 9,
            [(1, 2)] = 5,
            [(3, 2)] = 5,
        };

        ClearingPlan plan = ClearingPlanner.Plan((0, 0), (4, 0), walkable, clearable);

        plan.Reachable.Should().BeTrue();
        plan.Cost.Should().Be(9, "one rock costs less than two weeds");
        plan.Clear.Should().ContainSingle().Which.Should().Be((2, 0));
    }

    [Fact]
    public void TwoWeedsBeatOneRockWhenTheyAreCheaper()
    {
        var walkable = new HashSet<(int X, int Y)>
        {
            (0, 0), (1, 0), (3, 0), (4, 0),
            (0, 2), (2, 2), (4, 2),
            (0, 1), (4, 1),
        };
        var clearable = new Dictionary<(int X, int Y), int>
        {
            [(2, 0)] = 11,
            [(1, 2)] = 5,
            [(3, 2)] = 5,
        };

        ClearingPlan plan = ClearingPlanner.Plan((0, 0), (4, 0), walkable, clearable);

        plan.Reachable.Should().BeTrue();
        plan.Cost.Should().Be(10, "two weeds cost 10, the rock costs 11");
        plan.Clear.Should().BeEquivalentTo(new[] { (1, 2), (3, 2) });
    }

    [Fact]
    public void ATargetSealedByWallsIsReportedUnreachableRatherThanInventingAClear()
    {
        var walkable = new HashSet<(int X, int Y)> { (0, 0), (1, 0) };
        var clearable = new Dictionary<(int X, int Y), int> { [(3, 0)] = 5 };

        ClearingPlan plan = ClearingPlanner.Plan((0, 0), (5, 5), walkable, clearable);

        plan.Reachable.Should().BeFalse("no number of clears opens a wall that cannot be cleared");
        plan.Clear.Should().BeEmpty();
    }

    [Fact]
    public void ThePlanIsDeterministicForTheSameInputs()
    {
        var walkable = new HashSet<(int X, int Y)> { (0, 0), (1, 0), (3, 0), (4, 0) };
        var clearable = new Dictionary<(int X, int Y), int> { [(2, 0)] = 9 };

        ClearingPlan first = ClearingPlanner.Plan((0, 0), (4, 0), walkable, clearable);
        ClearingPlan again = ClearingPlanner.Plan((0, 0), (4, 0), walkable, clearable);

        again.Clear.Should().Equal(first.Clear);
        again.Cost.Should().Be(first.Cost);
    }

    [Fact]
    public void ATargetThatIsItselfClearableIsReachedByClearingIt()
    {
        // The rock is the target: clearing it is the whole job, and the plan must say so
        // rather than call the tile unreachable.
        var walkable = new HashSet<(int X, int Y)> { (0, 0), (1, 0), (2, 0) };
        var clearable = new Dictionary<(int X, int Y), int> { [(2, 0)] = 9 };

        ClearingPlan plan = ClearingPlanner.Plan((0, 0), (2, 0), walkable, clearable);

        plan.Reachable.Should().BeTrue();
        plan.Clear.Should().ContainSingle().Which.Should().Be((2, 0));
        plan.Cost.Should().Be(9);
    }
}
