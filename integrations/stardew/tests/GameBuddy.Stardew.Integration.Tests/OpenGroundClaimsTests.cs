using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE TILES THE MAP CALLS OPEN AND THE BODY CANNOT USE.
///
/// <para>
/// `GameLocation.isTilePassable` (GameLocation.cs:2898-2911) reads the map's Back and Buildings layers and NOTHING
/// ELSE, so a `Bush` - an impassable `LargeTerrainFeature` (Bush.cs:15, whose `isPassable` returns false for every
/// character but a Junimo, :487-490) - reads as open ground. The operator's run that ended with her standing still had
/// no refusal at all: nothing named the tile as unusable, because the code that decides where she may stand asked the
/// map. The engine disagrees where it counts: `isCollidingPosition(..., pathfinding: true)` walks
/// `largeTerrainFeatures` (GameLocation.cs:2637-2648) and refuses the step, which is the call
/// `PathFindController.cs:222` admits a step with and the call `StardewBodyController.IsPlannerAdmissibleTile` makes.
/// </para>
///
/// <para>
/// So every case here reads the SAME tile twice: once with the map-only test, which is the reading the member had
/// before, and once with the member's own answer, which must come from the body's rule. A case cannot pass by pinning
/// a sentence - each one calls the shipped member, and the three members are reached the way the suite reaches engine
/// statics that `Game1` closes over: `IsPassableBuildableAtLocation` is `internal` and called directly,
/// `IsMoveStallLineWalkable` and `DiscoverArtifactSpotTargets` are `private static` and invoked by name, as
/// `TargetFamilyWorld.DiscoverFamily` does for every other `Discover*`.
/// </para>
///
/// <para>
/// WHAT EACH MEMBER'S FORMER ANSWER WAS, measured from the decompiled clauses rather than assumed: a bush was already
/// refused by the twelve members that carried an occupancy second pass (`IsTileOccupiedBy` counts
/// `largeTerrainFeatures`, GameLocation.cs:7394-7403), so for those this unit is one spelling where there were two and
/// not a behaviour change. The four members that carried NO second pass - `IsLegalEmptyFarmFenceTile`'s stance,
/// `OnWarped`'s clear-hoedirt gate, the water-source neighbour in `TryCreateSceneObservationInput` and
/// `TryCreateWaterLandmark`'s standable edge - are the ones that admitted the bush, and they are the operator's stall.
/// Each case below therefore asserts the MAP truth (`isTilePassable` is true: the lie's exact red reading) beside the
/// MEMBER truth (the tile is not usable), which is the pair that was disagreeing.
/// </para>
/// </summary>
public sealed class OpenGroundClaimsTests
{
    /// <summary>A trellis seed id no other case in this suite writes into the static `Game1.cropData`.</summary>
    private const string TrellisSeedId = "9681";

    [Fact]
    public void ABushTileReadsAsOpenGroundToTheMapAndNotToTheBody()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        Vector2 tile = new(3f, 3f);
        world.Farm.largeTerrainFeatures.Add(SmallBush(world, tile));
        world.StandAt(2, 3);

        world.Farm.isTilePassable(tile)
            .Should().BeTrue("the map's own Back and Buildings layers are empty at this tile, which is the reading that lied");
        StardewBodyController.IsWalkableTile(world.Farm, world.Actor, tile)
            .Should().BeFalse("`isCollidingPosition(..., pathfinding: true)` refuses a step a bush covers");
        StardewBodyController.IsStandableTile(world.Farm, world.Actor, tile)
            .Should().BeFalse("a tile the planner will not step onto can never be a place to stand");
    }

    [Fact]
    public void ATrellisCropTileReadsAsOpenGroundToTheMapAndNotToTheBody()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        Vector2 tile = new(3f, 3f);
        world.PlaceCropWithData(x: 3, y: 3, seedId: TrellisSeedId, raised: true);
        world.StandAt(2, 3);

        world.Farm.isTilePassable(tile)
            .Should().BeTrue("`isTilePassable` cannot see a terrain feature at all");
        StardewBodyController.IsWalkableTile(world.Farm, world.Actor, tile)
            .Should().BeFalse("`HoeDirt.isPassable` is false for a crop with `raisedSeeds`, and the planner reads it");
    }

    /// <summary>
    /// Representative member 1: the human door of a building may not open onto a tile the body cannot walk to. The
    /// ordinary answer is the map's, which is why the member keeps that clause; the body's answer is the planner's.
    /// </summary>
    [Fact]
    public void IsPassableBuildableAtLocationAsksTheBodyNotTheMapAboutABush()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        Vector2 bushTile = new(3f, 3f);
        Vector2 openTile = new(4f, 3f);
        world.Farm.largeTerrainFeatures.Add(SmallBush(world, bushTile));
        world.StandAt(2, 3);

        world.Farm.isTilePassable(bushTile).Should().BeTrue("the map-only reading the member used to take says open ground");
        ExecutionManager.IsPassableBuildableAtLocation(world.Farm, bushTile)
            .Should().BeFalse("a door on this tile would strand the farmer the building is for");
        ExecutionManager.IsPassableBuildableAtLocation(world.Farm, openTile)
            .Should().BeTrue("and the refusal is about the bush, not about the rule: the next tile over passes");
    }

    /// <summary>
    /// Representative member 2: the move-stall probe's Given is a line the PLANNER will walk, so its answer must be the
    /// planner's. It is `private static` on `ModEntry`, and its declared arrangement is what makes the probe's
    /// collision meaningful.
    /// </summary>
    [Fact]
    public void IsMoveStallLineWalkableRefusesALineWithABushOnIt()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.StandAt(2, 3);
        Vector2 a = new(2f, 3f);
        Vector2 b = new(3f, 3f);
        Vector2 c = new(4f, 3f);
        MethodInfo lineWalkable = typeof(ModEntry).GetMethod("IsMoveStallLineWalkable", BindingFlags.NonPublic | BindingFlags.Static)!;
        object?[] arguments = { world.Farm, a, b, c };

        ((bool)lineWalkable.Invoke(null, arguments)!).Should().BeTrue("the bare line is the control: three empty tiles");

        world.Farm.largeTerrainFeatures.Add(SmallBush(world, b));

        world.Farm.isTilePassable(b).Should().BeTrue("the map-only reading the member used to take says open ground");
        ((bool)lineWalkable.Invoke(null, arguments)!).Should().BeFalse(
            "the middle tile is a bush, so no A* walks this line and the probe's Given does not hold");
    }

    /// <summary>
    /// Representative member 3: an artifact spot is reachable only from a tile the body may stand on, so a ring of
    /// bushes around one publishes no target at all.
    /// </summary>
    [Fact]
    public void DiscoverArtifactSpotTargetsPublishesNoTargetWhenEveryNeighbourIsABush()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        Vector2 source = new(3f, 3f);
        world.PlaceForage(x: 3, y: 3, qualifiedItemId: "(O)590");
        world.StandAt(1, 3);
        Vector2[] ring = { new(2f, 3f), new(4f, 3f), new(3f, 2f), new(3f, 4f) };
        foreach (Vector2 tile in ring) world.Farm.largeTerrainFeatures.Add(SmallBush(world, tile));

        ring.Should().OnlyContain(tile => world.Farm.isTilePassable(tile),
            "every neighbour is open ground to the map, which is the reading that would have published the target");
        PublishedArtifactSpots(world).Should().BeEmpty(
            "a target she can never stand beside is not a target: the ring is refused by the body's rule");
    }

    /// <summary>
    /// The control for the case above: the same source with a walkable ring IS published, so the empty list is the
    /// bush refusal and not a world this fixture cannot build.
    /// </summary>
    [Fact]
    public void DiscoverArtifactSpotTargetsPublishesTheSameTargetWhenTheRingIsWalkable()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.PlaceForage(x: 3, y: 3, qualifiedItemId: "(O)590");
        world.StandAt(1, 3);

        PublishedArtifactSpots(world).Should().ContainSingle("nothing holds the ring, so the neighbouring tile is a place to stand");
    }

    /// <summary>
    /// The one place this member's answer CHANGED rather than moved: grass.
    ///
    /// <para>
    /// Its former filter was `isTilePassable` plus `IsTileOccupiedBy(standing, CollisionMask.All, CollisionMask.None)`,
    /// and `ignorePassables: None` makes that query count every occupant including the ones the natives call passable -
    /// so a grass tile was "occupied" and no artifact spot beside one was ever published. The body's rule answers what
    /// the field needs: `StopsStanding` leaves `TerrainFeatures` out on purpose (`StardewBodyController.cs`,
    /// "Standing among terrain features is the job"), and the planner admits grass because `Grass.isPassable` is true.
    /// </para>
    ///
    /// <para>
    /// This is the case that goes red on the member as it was: inject the old expression back and the target stops
    /// being published.
    /// </para>
    /// </summary>
    [Fact]
    public void DiscoverArtifactSpotTargetsReachesASpotThroughGrassTheBodyMayStandIn()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        Vector2 source = new(3f, 3f);
        world.PlaceForage(x: 3, y: 3, qualifiedItemId: "(O)590");
        world.StandAt(1, 3);
        world.PlaceGrass(x: 2, y: 3);
        foreach (Vector2 tile in new[] { new Vector2(4f, 3f), new Vector2(3f, 2f), new Vector2(3f, 4f) })
            world.Farm.largeTerrainFeatures.Add(SmallBush(world, tile));

        Vector2 grass = new(2f, 3f);
        world.Farm.terrainFeatures.ContainsKey(grass).Should().BeTrue("the only open neighbour is grass, and grass is a terrain feature");
        StardewBodyController.IsStandableTile(world.Farm, world.Actor, grass).Should().BeTrue(
            "the planner steps onto grass, and standing among terrain features is the job");
        PublishedArtifactSpots(world).Should().ContainSingle(
            $"the spot is reachable from {grass.X},{grass.Y}, so the target the ring hides is exactly this one");
    }

    /// <summary>
    /// The shipped `DiscoverArtifactSpotTargets` for this world, through the reflection seam
    /// `TargetFamilyWorld.DiscoverFamily` already uses for every family this suite drives.
    /// </summary>
    private static IReadOnlyList<BridgeArtifactSpotTarget> PublishedArtifactSpots(
        TargetFamilyCompletenessTests.TargetFamilyWorld world) =>
        ((IReadOnlyList<BridgeArtifactSpotTarget>)world.DiscoverFamily("DiscoverArtifactSpotTargets")).ToArray();

    /// <summary>
    /// A bush whose footprint is exactly one tile. `Bush.getBoundingBox` widens with `size` (64x64 for size 0 or 3,
    /// 128 for 1 or 4, 192 for 2), and the shipped `PlaceHarvestableBush` uses `walnutBush`, whose box covers two tiles -
    /// which would make "the tile is refused" unstoppable from "its neighbour is refused".
    /// </summary>
    private static StardewValley.TerrainFeatures.Bush SmallBush(
        TargetFamilyCompletenessTests.TargetFamilyWorld world,
        Vector2 tile) =>
        new(tile, StardewValley.TerrainFeatures.Bush.smallBush, world.Farm, datePlantedOverride: 0);
}
