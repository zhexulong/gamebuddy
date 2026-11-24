using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// WHAT ONE REACHABILITY FLOOD COSTS, and what a second question about the same map is allowed to cost.
///
/// <para>
/// THE DEFECT. Measured `round99` on the play session's own farm: every `cut_weeds` and `break_rock` node paid
/// <c>floods=2</c> - two independent walks of the same 3,704-3,776-tile component, 13-20 ms of game thread against a
/// 16.67 ms frame, of which the actual dispatch was 0.28 ms. Each of those walks asked the engine
/// ~17,700 collision questions for ~3,700 tiles, because the membership test ran AFTER the predicate: every settled
/// tile re-asked about its own four neighbours every time one of them was expanded.
/// </para>
///
/// <para>
/// TWO ASSERTIONS, ONE PER HALF OF THE COST. The first is a property of the predicate's call log - a cell the flood has
/// already settled is not a question for the engine a second time - so the population is every cell the walk can see
/// and no count has to be hard-coded for it to keep meaning something. The second is the memo that makes one approach
/// leg pay for the map once: two nodes at one origin on an unchanged map, and one node that settled after changing it.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class FloodQueryBudgetTests
{
    // ---- the flood asks each cell once ------------------------------------------------------

    [Fact]
    public void AFloodAsksTheEngineAboutEachDistinctCellOnce()
    {
        // A 5x5 room with the actor in its corner. The component is 25 tiles; the cells the flood must ask about are
        // the 45 that touch one of them cardinally - the 7x7 block around the room less its four corners, which touch
        // nothing in it. Asking about every neighbour of every settled tile is 4 * 25 + 1 = 101 questions, so the old
        // shape asked up to four times about cells it had already answered for.
        var asked = new List<Point>();
        Point actor = new(0, 0);
        static bool InTheRoom(Point tile) => tile.X >= 0 && tile.X <= 4 && tile.Y >= 0 && tile.Y <= 4;

        StardewBodyController.WalkableComponent? component = StardewBodyController.ReachableTiles(
            actor,
            maxVisited: 2000,
            tile =>
            {
                asked.Add(tile);
                return InTheRoom(tile);
            });

        component.Should().NotBeNull();
        component!.Count.Should().Be(25);
        asked.Should().OnlyHaveUniqueItems("a settled cell is not a second question for the engine");
        asked.Should().HaveCount(45, "the flood asks about the component and the ring that closes it, once each");
    }

    [Fact]
    public void TheEarlyExitWalkAsksTheEngineAboutEachDistinctCellOnceToo()
    {
        // The other flood: `findClosestReachable: false` stops at the first tile the arrival rule accepts, and it used
        // to re-ask about settled cells on the way there for the same reason.
        var asked = new List<Point>();
        Point actor = new(0, 0);
        Point target = new(4, 4);
        static bool InTheRoom(Point tile) => tile.X >= 0 && tile.X <= 4 && tile.Y >= 0 && tile.Y <= 4;

        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            actor,
            target,
            tile =>
            {
                asked.Add(tile);
                return InTheRoom(tile);
            },
            maxVisited: 2000);

        verdict.Should().NotBeNull();
        verdict!.Value.TargetEnclosed.Should().BeFalse();
        asked.Should().OnlyHaveUniqueItems("the walk to the first accepted arrival pays one question per cell");
    }

    /// <summary>
    /// TWO QUESTIONS ABOUT ONE MAP, ONE WALK OF IT: this is the dispatch shape, in the small. The approach leg builds
    /// the component to choose a standing tile, and the walk's own probe asks the same map whether the goal is
    /// reachable - both fed from one component.
    /// </summary>
    [Fact]
    public void TwoQuestionsAboutOneMapAreAnsweredFromOneFlood()
    {
        var asked = new List<Point>();
        Point actor = new(2, 2);
        Point goal = new(9, 9);
        static bool OpenField(Point tile) => tile.X >= 0 && tile.X <= 12 && tile.Y >= 0 && tile.Y <= 12;

        StardewBodyController.WalkableComponent? component = StardewBodyController.ReachableTiles(
            actor,
            maxVisited: 4000,
            tile =>
            {
                asked.Add(tile);
                return OpenField(tile);
            });
        component.Should().NotBeNull();
        int firstWalk = asked.Count;

        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            actor,
            goal,
            tile =>
            {
                asked.Add(tile);
                return OpenField(tile);
            },
            maxVisited: 4000,
            findClosestReachable: true,
            reuseComponent: () => component);

        verdict.Should().NotBeNull();
        verdict!.Value.TargetEnclosed.Should().BeFalse("the field is open from the actor to the goal");
        verdict.Value.ComponentTiles.Should().Be(component!.Count, "both questions describe one component");
        asked.Should().HaveCount(firstWalk + 1, "only the GOAL tile is asked live; the map is not walked again");
        asked[^1].Should().Be(goal, "the one live question is the goal's own tile");
    }

    // ---- reuse inside one program, and the node that ends it --------------------------------

    /// <summary>
    /// THE MEMO AT ITS OWN SEAM, driven over a real location so the cost is the engine's own collision test rather than
    /// a lambda: two nodes at one origin, on a map nothing changed, pay for one flood.
    /// </summary>
    [Fact]
    public void TwoNodesAtOneOriginOnAnUnchangedMapFloodOnce()
    {
        var location = new CountingLocation();
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create(16, () => location);
        harness.BuildCorridor();
        var controller = new StardewBodyController((_, _, _) => { });

        StardewBodyController.WalkableComponent? first = controller.ApproachComponent(harness.Location, harness.Actor);
        int afterFirstNode = location.CollisionQueries;

        StardewBodyController.WalkableComponent? second = controller.ApproachComponent(harness.Location, harness.Actor);

        first.Should().NotBeNull();
        afterFirstNode.Should().BeGreaterThan(0, "the first node really did ask the engine about this map");
        second.Should().BeSameAs(first, "the same question about the same map is answered once");
        location.CollisionQueries.Should().Be(afterFirstNode, "the second node issued no collision query of its own");
    }

    /// <summary>
    /// AND THE NODE THAT CHANGED THE WORLD ENDS IT. A refusal did nothing, so the component it read is still true;
    /// any other terminal either changed the map's blocking set or may have, so the next approach refloods - and the
    /// flood it gets back is the world as it stands, not the one it remembered.
    /// </summary>
    [Fact]
    public void ANodeThatChangedTheWorldDiscardsTheFlood()
    {
        var location = new CountingLocation();
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create(16, () => location);
        harness.BuildCorridor();
        var controller = new StardewBodyController((_, _, _) => { });

        StardewBodyController.WalkableComponent? before = controller.ApproachComponent(harness.Location, harness.Actor);
        int afterFirstFlood = location.CollisionQueries;
        before.Should().NotBeNull();
        int sizeBefore = before!.Count;

        controller.NoteNodeSettled(ExecutionState.Rejected);
        controller.ApproachComponent(harness.Location, harness.Actor)
            .Should().BeSameAs(before, "a refused node changed nothing, so nothing is reflooded");
        location.CollisionQueries.Should().Be(afterFirstFlood);

        // A boulder on the corridor: the one change this file needs, made by the world rather than by the memo.
        harness.PlaceRock(8, 3);
        controller.NoteNodeSettled(ExecutionState.Succeeded);
        StardewBodyController.WalkableComponent? after = controller.ApproachComponent(harness.Location, harness.Actor);

        location.CollisionQueries.Should().BeGreaterThan(afterFirstFlood, "a settled node's world is asked about again");
        after.Should().NotBeSameAs(before);
        after!.Count.Should().BeLessThan(sizeBefore, "the reflood sees the boulder, so the component it answers is the corridor");
    }

    /// <summary>
    /// A location whose collision questions are counted, so a test can say what a flood COST rather than only what it
    /// answered. It is a test double for the boundary this file does not own - the engine's rectangle test - and it
    /// delegates to the real one, so every answer is still the engine's.
    /// </summary>
    private sealed class CountingLocation : GameLocation
    {
        internal int CollisionQueries { get; private set; }

        public override bool isCollidingPosition(
            Rectangle position,
            xTile.Dimensions.Rectangle viewport,
            bool isFarmer,
            int damagesFarmer,
            bool glider,
            Character character,
            bool pathfinding,
            bool projectile = false,
            bool ignoreCharacterRequirement = false,
            bool skipCollisionEffects = false)
        {
            this.CollisionQueries++;
            return base.isCollidingPosition(position, viewport, isFarmer, damagesFarmer, glider, character, pathfinding, projectile, ignoreCharacterRequirement, skipCollisionEffects);
        }
    }
}
