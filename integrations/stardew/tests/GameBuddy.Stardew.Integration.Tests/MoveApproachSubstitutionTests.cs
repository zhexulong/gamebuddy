using System;
using System.Collections.Generic;
using System.IO;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Arithmetic tests for the move_to_tile approach substitution.
///
/// A live ladder run refused 10 of its 29 movement dispatches with
/// <c>no_native_path</c> because the agent aimed at tiles that hold the object it
/// wanted to touch. Two of those refusals were outright false (the actor was
/// already inside the arrival contract) and the rest were unactionable (the refusal
/// named no cause). The selection below is the deterministic half of the fix, so it
/// is tested as arithmetic rather than through a live game.
/// </summary>
public class MoveApproachSubstitutionTests
{
    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
                directory = directory.Parent;
            }
        }
        throw new FileNotFoundException($"repository source not found: {relative}");
    }

    private static Func<Vector2, bool> StandableAt(params Vector2[] tiles)
    {
        HashSet<Vector2> allowed = new(tiles);
        return candidate => allowed.Contains(candidate);
    }

    [Fact]
    public void ArrivalAlreadySatisfied_IsRecognisedForAnExactRequestOnTheTile()
    {
        StardewBodyController.IsArrivalDelta(0, 0, allowAdjacentArrival: false).Should().BeTrue();
    }

    [Fact]
    public void ArrivalAlreadySatisfied_IsNotClaimedForANeighbourWithoutAdjacency()
    {
        // The exact-tile request must still walk: standing one tile away is not
        // arrival unless the directive asked for an adjacent approach.
        StardewBodyController.IsArrivalDelta(1, 0, allowAdjacentArrival: false).Should().BeFalse();
        StardewBodyController.IsArrivalDelta(0, 1, allowAdjacentArrival: false).Should().BeFalse();
    }

    [Fact]
    public void ArrivalAlreadySatisfied_IsRecognisedForASubstitutedApproach()
    {
        // The substituted approach is requested WITH adjacency, so its target (the
        // standable neighbour) counts as arrival for the whole free ring -- which is
        // why the planner has nothing to plan and success is the honest terminal.
        StardewBodyController.IsArrivalDelta(1, 1, allowAdjacentArrival: true).Should().BeTrue();
        StardewBodyController.IsArrivalDelta(1, 0, allowAdjacentArrival: true).Should().BeTrue();
    }

    [Fact]
    public void ApproachSelection_PicksTheStandableNearestNeighbour()
    {
        Vector2 target = new(10f, 10f);
        // Only the far side is standable, so the substitution is not "the first
        // candidate" -- it is the only legal interaction position.
        Func<Vector2, bool> standable = StandableAt(new Vector2(10f, 11f));
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(10f, 20f), standable)
            .Should().Be(new Vector2(10f, 11f));
    }

    [Fact]
    public void ApproachSelection_PrefersTheNeighbourClosestToTheActor()
    {
        Vector2 target = new(10f, 10f);
        Func<Vector2, bool> standable = StandableAt(
            new Vector2(9f, 10f),
            new Vector2(10f, 11f));
        // Actor below the target: the tile under it is nearer than the one left of it.
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(10f, 12f), standable)
            .Should().Be(new Vector2(10f, 11f));
        // Actor to the left: the preference reverses.
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(7f, 10f), standable)
            .Should().Be(new Vector2(9f, 10f));
    }

    [Fact]
    public void ApproachSelection_BreaksDistanceTiesByTheDeclaredCandidateOrder()
    {
        Vector2 target = new(10f, 10f);
        Func<Vector2, bool> standable = StandableAt(
            new Vector2(11f, 10f),
            new Vector2(9f, 10f),
            new Vector2(10f, 9f),
            new Vector2(10f, 11f));
        // All four are equidistant from (10,10): the first candidate of the declared
        // order (left, right, up, down) wins, so the choice cannot drift between runs.
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(10f, 10f), standable)
            .Should().Be(new Vector2(9f, 10f));
    }

    [Fact]
    public void ApproachSelection_ConsidersTheWholeChebyshevRing()
    {
        Vector2 target = new(10f, 10f);
        // A densely cropped field can leave only a diagonal free. The ring matches both
        // the arrival predicate and every interaction's Chebyshev-1 admission radius,
        // whose own comment records that the native click path stops on any Chebyshev-1
        // tile -- so a diagonal standing tile is a legal place to act from.
        Func<Vector2, bool> diagonalOnly = StandableAt(new Vector2(9f, 9f));
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(5f, 5f), diagonalOnly)
            .Should().Be(new Vector2(9f, 9f));

        // Cardinals still win when both are standable and equally distant: the declared
        // order is cardinals first, so the preference does not change for the common case.
        Func<Vector2, bool> cardinalAndDiagonal = StandableAt(
            new Vector2(9f, 10f),
            new Vector2(11f, 11f));
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(10f, 10f), cardinalAndDiagonal)
            .Should().Be(new Vector2(9f, 10f));
    }

    [Fact]
    public void Substitution_AsksThePlannerQuestionAndPublishesBothFacts()
    {
        // Behaviour of the predicate itself needs a live GameLocation, so this pins the
        // DECLARED contract the same way the sibling body-controller tests do: the
        // substitution must consult the planner's walkability (not the stricter object
        // reading, which hijacked requests into substitutions the planner then refused),
        // and a refusal must publish BOTH facts so a reader can see them disagree.
        string source = File.ReadAllText(RepositorySourcePath(
            Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.movementactions.cs")));
        int moveStart = source.IndexOf("public LocalExecutionReceipt RequestLocalMove(", StringComparison.Ordinal);
        int moveEnd = source.IndexOf("internal static Vector2? SelectStandingApproachTile(", moveStart, StringComparison.Ordinal);
        moveStart.Should().BeGreaterThanOrEqualTo(0);
        moveEnd.Should().BeGreaterThan(moveStart);
        string moveBody = source[moveStart..moveEnd];
        moveBody.Should().Contain("IsWalkableTile", "the substitution must use the planner's own walkability");
        moveBody.Should().NotContain("IsStandableTile", "the object-occupancy reading must not decide the move");

        string controller = File.ReadAllText(RepositorySourcePath(
            Path.Combine("integrations", "stardew", "StardewBodyController.cs")));
        controller.Should().Contain("target_standable=");
        controller.Should().Contain("target_walkable=");
        controller.Should().Contain("probe_says_reachable=");
        // The refusal must also publish WHERE the actor CAN go. Mutation evidence: dropping this call left every
        // test green, because the formatter's own test never proved the refusal called it -- a formatter test is
        // not a wiring test.
        controller.Should().Contain("FormatReachableHint(assessed.ClosestToTarget");
        // And a refusal must NAME what blocks a tile it refuses: resource clumps, large terrain features and
        // buildings live outside objects/terrainFeatures, so asking only those answered "none" about a real wall
        // (measured: live refusals read blocked_by=none for tiles the planner would not enter).
        controller.Should().Contain("clump:",
            "resource clumps block tiles and are not in objects or terrainFeatures");
        controller.Should().Contain("large:",
            "large terrain features block tiles and are not in objects or terrainFeatures");
        controller.Should().Contain("building:",
            "building footprints block tiles and are not in objects or terrainFeatures");
        // And a refusal must say when the wall is REMOVABLE, because "no route" and "no route until you chop the
        // twig" are different messages. The predicates are the same ones the clearing actions use.
        controller.Should().Contain("IsRemovableLitter(blockedItem)");
        controller.Should().Contain("IsTwigLitter(item) || NativeItemPredicates.IsBreakableStone(item) || item.IsWeeds()");
    }

    [Fact]
    public void ApproachSelection_ReturnsNullWhenNothingAroundTheTargetIsStandable()
    {
        Vector2 target = new(10f, 10f);
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(1f, 1f), _ => false)
            .Should().BeNull();
    }

    [Fact]
    public void ApproachEntriesSeparateTheFourShapes()
    {
        // Measured live, in one refusal: `west:(O)294@34,49` (a twig), `north:(O)2@35,54` (a stone) and
        // `east:blocked` (map-level). The first two can be taken down with a tool the companion already has; the
        // third cannot. The entry text has to keep those apart.
        StardewBodyController.FormatApproachEntry("west", true, "none", false).Should().Be("west:open");
        StardewBodyController.FormatApproachEntry("east", false, "none", false).Should().Be("east:blocked");
        StardewBodyController.FormatApproachEntry("north", false, "(O)2@35,54", false).Should().Be("north:(O)2@35,54");
        StardewBodyController.FormatApproachEntry("west", false, "(O)294@34,49", true)
            .Should().Be("west:(O)294@34,49[removable]");
        // A wall that is walkable is open regardless of what occupies it decoratively: the planner decides.
        StardewBodyController.FormatApproachEntry("south", true, "terrain:HoeDirt@35,55", true).Should().Be("south:open");
    }

    [Fact]
    public void ReachableHintNamesTheNearestReachableTile()
    {
        // The refusal used to publish only the verdict, so an audited live session re-aimed inside a 28-tile pocket
        // for 63% of its turn while the tile it COULD reach was computed and discarded.
        string hint = StardewBodyController.FormatReachableHint(new Point(35, 54), new Point(35, 55));
        hint.Should().Be("closest=35,54;closest_distance=1");

        // No visited tile closer than the actor already is: say so rather than invent a destination.
        StardewBodyController.FormatReachableHint(null, new Point(35, 55)).Should().Be("closest=none");

        // Chebyshev, the metric the flood minimises.
        StardewBodyController.FormatReachableHint(new Point(30, 40), new Point(35, 55)).Should().Be("closest=30,40;closest_distance=15");
    }
}
