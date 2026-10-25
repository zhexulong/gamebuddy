using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// How many props a world can host, derived from the ground it actually has.
///
/// The fixture used to carry a literal count (ten stones, then six, then four) and the number was never a
/// product requirement - it was a geometry budget nobody had computed. On the multi-day farm the walkable
/// component measured 123 tiles while the model assumed the whole 5200-tile map was open, so the literal
/// count was either far too small (leaving the day with nothing to do) or too large (refusing the world
/// with `stone_spot_missing` after every individual placement succeeded).
///
/// This is the budget as a pure function, so the number can be stated and tested instead of tuned.
/// Each prop needs its own tile AND leaves one standable neighbour for the actor, and a placement must not
/// cut the walkable piece in two - so a component of N tiles holds far fewer than N props.
/// </summary>
public sealed class PropCapacityTests
{
    [Fact]
    public void AComponentThatBarelyFitsItselfHostsNothing()
    {
        // A pocket of three tiles cannot host a prop and leave a standing tile as well.
        PropCapacity.For(componentTiles: 3).Should().Be(0);
    }

    [Fact]
    public void CapacityGrowsWithTheComponent()
    {
        int small = PropCapacity.For(componentTiles: 32);
        int large = PropCapacity.For(componentTiles: 400);
        large.Should().BeGreaterThan(small);
        small.Should().BeGreaterOrEqualTo(1, "a 32-tile piece should still host the smallest useful world");
    }

    [Fact]
    public void CapacityIsBoundedBelowRegardlessOfHowLargeTheComponentIs()
    {
        // The count is a budget, not a target: a huge farm still gets a morning's work, not a quarry.
        PropCapacity.For(componentTiles: 100_000).Should().BeLessOrEqualTo(PropCapacity.Ceiling);
    }

    [Fact]
    public void TheMeasuredMultiDayFarmIsInsideTheBudget()
    {
        // Measured, not assumed: on a 122-tile piece the props severed the door from the work
        // (`component_tiles` went 123 -> 122 and the field dropped out of the component). A budget that leaves
        // the farm walkable is a handful, not a dozen - and the first version of this assertion guessed 8.
        int capacity = PropCapacity.For(componentTiles: 123);
        capacity.Should().BeInRange(4, 8, "a 122-tile piece keeps its corridor with a handful of props");
    }

    [Fact]
    public void TheSameComponentAlwaysYieldsTheSameCount()
    {
        PropCapacity.For(200).Should().Be(PropCapacity.For(200));
    }
}
