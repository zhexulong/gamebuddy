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


    // ---- the first STEP, not just the price -----------------------------------

    [Fact]
    public void TheFirstStepNamesWhereToStandAndWhatToHit()
    {
        // The tile list tells a caller the price of the job. It does not tell it where to stand, and a rock is
        // removed from an adjacent tile - which is the part a live Agent could not work out, so it re-aimed at
        // neighbours and described the result as a maze.
        var kind = new Dictionary<(int X, int Y), string> { [(2, 0)] = "rock" };
        var step = new FirstClearStep(true, (2, 0), (1, 0), 1, "approach_found");

        ClearingEvidence.DescribeFirstStep(step, tile => kind.TryGetValue(tile, out string? name) ? name : null)
            .Should().Be("clear_step=rock@2,0;stand_at=1,0;remaining_clears=1");
    }

    [Theory]
    [InlineData("blocker_unapproachable_without_another_clear")]
    [InlineData("approach_search_budget_exhausted")]
    public void AnUnresolvableStepSaysNothingRatherThanNamingATileToStandOn(string reason)
    {
        // Null, not a partial string: a caller that receives `stand_at` will walk there, and walking to a tile
        // the planner could not verify is worse than being told nothing.
        ClearingEvidence.DescribeFirstStep(
                new FirstClearStep(false, null, null, 0, reason),
                KindAt)
            .Should().BeNull();

        // AND the case the first version of this test missed: a step that is unreachable yet still carries
        // coordinates - which is what a caller reusing a partially-built step would produce. The refusal has to
        // come from `Reachable`, not merely from the coordinates being null.
        ClearingEvidence.DescribeFirstStep(
                new FirstClearStep(false, (2, 0), (1, 0), 1, reason),
                KindAt)
            .Should().BeNull("an unreachable step must not name a tile to stand on, even if it has one");
    }

    [Fact]
    public void TheStepCarriesTheWholeIdeasSizeWithoutAuthorisingAChain()
    {
        // Five tiles must go. The step resolves the head only; `remaining_clears` lets the caller see the whole
        // job while nothing here approves a second clear, because the world changes after the first.
        var kind = new Dictionary<(int X, int Y), string> { [(4, 4)] = "weed" };
        var step = new FirstClearStep(true, (4, 4), (3, 4), 5, "approach_found");

        ClearingEvidence.DescribeFirstStep(step, tile => kind.TryGetValue(tile, out string? name) ? name : null)
            .Should().Be("clear_step=weed@4,4;stand_at=3,4;remaining_clears=5");
    }
}