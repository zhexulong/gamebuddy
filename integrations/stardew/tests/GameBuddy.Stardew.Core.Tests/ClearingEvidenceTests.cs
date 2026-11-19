using System.Collections.Generic;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
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

    // ---- the step for a row the frame never published -----------------------

    private static readonly FarmhandClearingOffer CutWeeds =
        new("cut_weeds", new FarmhandClearingCost("scythe", 1), Destructive: false, "weedTargets");

    [Fact]
    public void TheOrderedStepWalksPublishesCutsAndThenWalks()
    {
        // The measured shape: the weed is on the route, `cut_weeds` exists, and its id was missing because she stood
        // outside the family's window. The order is the answer - the first step is the only one she can dispatch today.
        ClearingEvidence.DescribeNextSteps((40, 10), (40, 9), CutWeeds, (40, 0))
            .Should().Be(
                $"next_steps={ClearingEvidence.WalkAction}@40,10>publishes:weedTargets>cut_weeds@40,9>{ClearingEvidence.WalkAction}@40,0");
    }

    [Fact]
    public void TheOrderedStepStopsAtThePublicationWhenASwingWouldNotLand()
    {
        // A publish tile three tiles off brings the row into the family's window and nothing into the scythe's reach, so
        // the sentence must not promise a swing the engine would refuse for range - and without a cut there is no walk
        // after it either.
        ClearingEvidence.DescribeNextSteps((43, 9), (40, 9), CutWeeds, (40, 0))
            .Should().Be($"next_steps={ClearingEvidence.WalkAction}@43,9>publishes:weedTargets");
    }

    [Fact]
    public void NoTileThatPublishesTheRowIsSaidAsNone()
    {
        // Null is a MEASUREMENT here (the caller checks that before it calls): no tile it can walk to is inside the
        // family's window. Left out, the field would read as "nothing to say" instead of "no walk fixes this".
        ClearingEvidence.DescribeNextSteps(null, (40, 9), CutWeeds, (40, 0))
            .Should().Be($"next_steps={ClearingEvidence.NoNextSteps}");
    }

    [Fact]
    public void TheWalkTheOrderNamesIsAnActionTheCataloguePublishes()
    {
        // One spelling of the dispatch, held to the catalogue that publishes it: a step named with an id no action
        // answers is advice a caller cannot issue at all.
        FarmhandActionCatalog.Registrations
            .Should().Contain(registration => registration.ActionId == ClearingEvidence.WalkAction);
    }

    // ---- the other branch, when there IS no way round ------------------------

    [Fact]
    public void ADetourIsWithdrawnWhereTheFloodSaysThereIsNoWayRound()
    {
        // `round78`: `reachable=34,6;detour_steps=46` beside its own `route_exists_cardinal=false`, and the run walked
        // 46 steps into a dead end. The number is kept - it is how far the walk gets - and the claim is withdrawn.
        ClearingEvidence.DescribeNoDetour((34, 6), 46)
            .Should().Be("reachable=34,6;detour_steps=none;walk_limit_steps=46");
        ClearingEvidence.DescribeNoDetour(null, null).Should().Be("detour_steps=none");
    }

    [Fact]
    public void TheBlockerPutsTheOrderedStepBesideTheTargetItAddresses()
    {
        // Shape, not decoration: the field order is what a bounded host cut keeps, so the step that addresses
        // `blocker_target` has to follow it, and the other branch's price stays last.
        ClearingEvidence.DescribeBlocker(
                "weed",
                (40, 9),
                targetId: null,
                clearers: new[] { CutWeeds },
                staminaCharge: 0,
                detourFacts: ClearingEvidence.DescribeNoDetour((34, 6), 46),
                targetStepFacts: ClearingEvidence.DescribeNextSteps((40, 10), (40, 9), CutWeeds, (40, 0)))
            .Should().Be(
                "blocker_occupant=weed@40,9;clears_with=cut_weeds(stamina:0,tool:scythe,turns:1);"
                    + $"blocker_target={ClearingEvidence.TargetUnpublished}:weedTargets;"
                    + $"next_steps={ClearingEvidence.WalkAction}@40,10>publishes:weedTargets>cut_weeds@40,9>{ClearingEvidence.WalkAction}@40,0;"
                    + "reachable=34,6;detour_steps=none;walk_limit_steps=46");
    }
}