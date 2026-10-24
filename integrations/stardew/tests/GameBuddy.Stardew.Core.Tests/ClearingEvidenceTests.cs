using System.Collections.Generic;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The receipt sentence for a clear plan.
///
/// The refusal it rides on is the one an agent reads when it cannot go where it meant to. A bare
/// `no_native_path` says nothing about whether one rock is all that stands in the way, so three live
/// runs re-aimed at neighbouring tiles and called the farm a maze. This wording is what replaces that.
/// </summary>
public sealed class ClearingEvidenceTests
{
    private static string? KindAt((int X, int Y) tile) => tile switch
    {
        (2, 0) => "rock",
        (1, 2) or (3, 2) => "weed",
        _ => null,
    };

    [Fact]
    public void APlanNamesEveryTileItWouldClearAndTheTotal()
    {
        var plan = new ClearingPlan(true, new[] { (2, 0) }, 9);

        ClearingEvidence.Describe(plan, KindAt)
            .Should().Be("clear_to_reach=rock@2,0;clear_tiles=1;clear_cost=9");
    }

    [Fact]
    public void SeveralTilesAreListedInTheOrderTheyWouldBeCleared()
    {
        var plan = new ClearingPlan(true, new[] { (1, 2), (3, 2) }, 10);

        ClearingEvidence.Describe(plan, KindAt)
            .Should().Be("clear_to_reach=weed@1,2,weed@3,2;clear_tiles=2;clear_cost=10");
    }

    [Fact]
    public void NothingIsSaidWhenNothingMustBeCleared()
    {
        // The target is reachable already: the caller's existing evidence is the whole story.
        ClearingEvidence.Describe(new ClearingPlan(true, System.Array.Empty<(int, int)>(), 0), KindAt).Should().BeNull();
    }

    [Fact]
    public void NothingIsSaidWhenNoClearWouldHelp()
    {
        // A wall is not a bill. Saying "clear_cost=0" here would invite an agent to try.
        ClearingEvidence.Describe(ClearingPlan.Unreachable, KindAt).Should().BeNull();
    }

    [Fact]
    public void ATileWithoutANameIsCalledUnknownRatherThanGuessed()
    {
        // The search only enters tiles it was given a price for, so this cannot happen - and if it ever
        // does, the contradiction must be visible instead of hidden behind a plausible word.
        var plan = new ClearingPlan(true, new[] { (9, 9) }, 7);

        ClearingEvidence.Describe(plan, KindAt)
            .Should().Be("clear_to_reach=unknown@9,9;clear_tiles=1;clear_cost=7");
    }
}
