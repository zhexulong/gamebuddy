using FluentAssertions;
using Microsoft.Xna.Framework;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class ReachabilityProbeTests
{
    [Fact]
    public void TargetSurroundedInNativeEightNeighbourhood_IsEnclosed()
    {
        // Enclosure is decidable only after the actor's component is fully
        // enumerated, so the fixture must give the actor a FINITE component:
        // the probe walks the whole 3x3 room and never reaches the target's
        // eight-neighbourhood beyond the sealed wall.
        Point actor = new(0, 0);
        Point target = new(5, 0);
        static bool InTheRoom(Point tile) =>
            tile.X >= 0 && tile.X <= 2 && tile.Y >= -1 && tile.Y <= 1;

        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            actor,
            target,
            tile => InTheRoom(tile) && tile != target,
            maxVisited: 2000);

        verdict.Should().NotBeNull();
        verdict!.Value.TargetEnclosed.Should().BeTrue();
    }

    [Fact]
    public void OpenWorldComponentBeyondTheBudget_AbandonsTheDerivedClaim()
    {
        // An unbounded component must not produce a claim: the probe gives up when
        // it exhausts its budget instead of reporting enclosure. The half-plane
        // keeps the component infinite while the target stays outside it (its
        // eight-neighbourhood never intersects y <= 0, so nothing short-circuits
        // the walk into an honest "not enclosed").
        Point actor = new(0, 0);
        Point target = new(0, 5);

        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            actor,
            target,
            tile => tile.Y <= 0,
            maxVisited: 64);

        verdict.Should().BeNull("the bounded probe must not claim anything about an unbounded component");
    }

    [Fact]
    public void UnstandableTargetWithReachableNeighbour_IsNotEnclosed()
    {
        Point actor = new(0, 0);
        Point target = new(2, 0);

        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            actor,
            target,
            tile => tile != target,
            maxVisited: 2000);

        verdict.Should().NotBeNull();
        verdict!.Value.TargetEnclosed.Should().BeFalse();
    }

    [Fact]
    public void ReachableNeighbourBeyondProbeBudget_AbandonsTheDerivedClaim()
    {
        Point actor = new(0, 0);
        Point target = new(100, 0);

        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            actor,
            target,
            tile => tile == new Point(99, 0) || tile.X >= 0 && tile.X < 99 && tile.Y == 0,
            maxVisited: 3);

        verdict.Should().BeNull("the bounded probe must not claim enclosure after its hard limit");
    }

    [Fact]
    public void ActorAlreadyOnTarget_IsDefinedAsNotEnclosed()
    {
        Point tile = new(4, 7);

        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            tile,
            tile,
            _ => false,
            maxVisited: 2000);

        verdict.Should().NotBeNull();
        verdict!.Value.TargetEnclosed.Should().BeFalse();
    }

    [Fact]
    public void StagingAsk_FindsTheClosestReachableTileTowardsTheTarget()
    {
        // The native finder can give up on a far goal whose walkable component still contains
        // it (its node budget is finite: PathFindController.cs:232). A live run reported a FREE,
        // walkable tile the finder could not route to. The probe's staging answer is what lets
        // the move handler make progress instead of refusing: the nearest tile the component
        // actually offers.
        Point actor = new(0, 0);
        Point target = new(10, 0);
        // A corridor along y == 0 that stops at x == 4, i.e. the target's neighbourhood is NOT
        // in the component, and the closest reachable tile is the corridor's end.
        static bool Corridor(Point tile) => tile.Y == 0 && tile.X >= 0 && tile.X <= 4;

        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            actor,
            target,
            Corridor,
            maxVisited: 2000,
            findClosestReachable: true);

        verdict.Should().NotBeNull();
        verdict!.Value.ComponentContainsTarget.Should().BeFalse("the corridor ends short of the target");
        verdict.Value.TargetEnclosed.Should().BeTrue();
        verdict.Value.ClosestToTarget.Should().Be(new Point(4, 0));
        verdict.Value.ComponentTiles.Should().Be(5);
    }

    [Fact]
    public void StagingAsk_ReportsTheComponentContainsTheTarget()
    {
        // The case the budget-exhaustion distinction exists for: the target IS walkable and the
        // component reaches it inside the budget, so the native finder's null path is a search
        // outcome, not a reachability fact. The component is bounded here so the probe can decide.
        Point actor = new(0, 0);
        Point target = new(3, 0);
        static bool Room(Point tile) => tile.X >= 0 && tile.X <= 4 && tile.Y >= 0 && tile.Y <= 4;

        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            actor,
            target,
            Room,
            maxVisited: 500,
            findClosestReachable: true);

        verdict.Should().NotBeNull();
        verdict!.Value.ComponentContainsTarget.Should().BeTrue();
        verdict.Value.TargetEnclosed.Should().BeFalse();
        // The best staging tile is adjacent to the target (distance 1), never the target itself.
        verdict.Value.ClosestToTarget.Should().Be(new Point(2, 0));
    }

    [Fact]
    public void StagingAsk_OnAnUnboundedComponent_MakesNoClaim()
    {
        // An open map's component is the whole map, so it cannot be enumerated inside any
        // bounded budget; the probe must say nothing rather than guess (the move handler then
        // falls back to its bounded fast-path probe before it stages anything).
        Point actor = new(0, 0);
        Point target = new(3, 0);

        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            actor,
            target,
            _ => true,
            maxVisited: 500,
            findClosestReachable: true);

        verdict.Should().BeNull();
    }

    [Fact]
    public void DiagonalOnlyApproach_IsNotReachableForTheCardinalPlanner()
    {
        // Measured live (actor 3,9 -> target 4,8 on the cropped fixture field): the destination tile itself
        // is walkable while BOTH of its cardinal approaches are blocked, and the native finder returns null
        // at 10000, 40000 and 400000 expansions. `PathFindController.Directions` is cardinal only, so this
        // flood must say the component does NOT contain the target. The earlier eight-neighbour flood said it
        // did, and the refusal then read `route_exists=true ... path_search=native_budget_exhausted` for a
        // route no planner can walk.
        Point actor = new(3, 9);
        Point target = new(4, 8);
        static bool Pocket(Point tile) =>
            tile == new Point(4, 8) || tile == new Point(3, 9) || tile == new Point(2, 9) || tile == new Point(3, 10);

        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            actor,
            target,
            Pocket,
            maxVisited: 200);

        verdict.Should().NotBeNull();
        verdict!.Value.ComponentContainsTarget.Should().BeFalse(
            "no cardinal route reaches the target, however walkable the target tile itself is");
        verdict.Value.TargetEnclosed.Should().BeTrue();
    }

    [Fact]
    public void CardinalApproach_IsReportedAsContainingTheTarget()
    {
        // The companion case, and the one staging is for: the target's own tile is walkable and the
        // component reaches a CARDINAL neighbour of it, so the planner can step onto the target.
        Point actor = new(3, 9);
        Point target = new(3, 11);
        static bool Lane(Point tile) => tile.Y >= 9 && tile.Y <= 11 && tile.X == 3;

        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            actor,
            target,
            Lane,
            maxVisited: 200);

        verdict.Should().NotBeNull();
        verdict!.Value.ComponentContainsTarget.Should().BeTrue();
        verdict.Value.TargetEnclosed.Should().BeFalse();
    }

    // ---- the staged-walk arrival contract ----------------------------------

    [Fact]
    public void StagingStep_IsAlwaysACardinalStepTowardsTheTarget()
    {
        // The planner moves cardinally (`PathFindController.cs:45-51`), so a staged step must be a cardinal
        // neighbour: only then is it guaranteed to be one planner step away when it is walkable. The measured
        // failure this replaces: the old eight-neighbour scan chose the DIAGONALLY adjacent 4,8 for an actor at
        // 3,9, the planner produced a one-node path, the actor never moved, and the action refused with
        // `did_not_arrive` after promising an adjacent approach.
        Point actor = new(3, 9);
        Point target = new(4, 7);

        bool found = StardewBodyController.TrySelectCardinalStagingStep(actor, target, _ => true, out Point staging);

        found.Should().BeTrue();
        (Math.Abs(staging.X - actor.X) + Math.Abs(staging.Y - actor.Y)).Should().Be(1);
        // And the step is real progress, not a sideways shuffle.
        Math.Max(Math.Abs(staging.X - target.X), Math.Abs(staging.Y - target.Y))
            .Should().BeLessThan(Math.Max(Math.Abs(actor.X - target.X), Math.Abs(actor.Y - target.Y)));
    }

    [Fact]
    public void StagingStep_IsRejectedWhenNoCardinalStepReducesTheDistance()
    {
        // The companion case: every cardinal neighbour is walkable, but all of them are blocked as far as the
        // caller is concerned, so there is nothing honest to stage.
        Point actor = new(3, 9);
        Point target = new(4, 7);

        StardewBodyController.TrySelectCardinalStagingStep(actor, target, _ => false, out _).Should().BeFalse();
    }

    [Fact]
    public void StagingStep_IgnoresADiagonalTileEvenWhenItIsTheClosest()
    {
        // The diagonal 4,8 is Chebyshev-1 from 4,7 and would win a pure-distance contest, but it is not a
        // cardinal step for an actor at 3,9 and the planner cannot walk it.
        Point actor = new(3, 9);
        Point target = new(4, 7);
        bool walkableOnlyDiagonally(Point tile) => tile == new Point(4, 8);

        StardewBodyController.TrySelectCardinalStagingStep(actor, target, walkableOnlyDiagonally, out _).Should().BeFalse();
    }

    [Theory]
    // A staged walk is finished only where the caller can act: the requested tile itself, or Chebyshev-1 of it.
    [InlineData(4, 7, true)]
    [InlineData(4, 8, true)]
    [InlineData(3, 9, false)]
    [InlineData(4, 9, false)]
    [InlineData(6, 7, false)]
    public void StagedWalk_IsFinishedOnlyWithinReachOfTheRequestedTile(int tileX, int tileY, bool expected)
    {
        StardewBodyController.IsStagedWalkFinished(new Point(tileX, tileY), new Point(4, 7)).Should().Be(expected);
    }
}
