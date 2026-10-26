using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
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

    /// <summary>Everything is walkable-to: the cases below are about geometry, not walls.</summary>
    private static Func<Vector2, bool> Anywhere() => _ => true;

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
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(10f, 20f), standable, Anywhere())
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
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(10f, 12f), standable, Anywhere())
            .Should().Be(new Vector2(10f, 11f));
        // Actor to the left: the preference reverses.
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(7f, 10f), standable, Anywhere())
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
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(10f, 10f), standable, Anywhere())
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
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(5f, 5f), diagonalOnly, Anywhere())
            .Should().Be(new Vector2(9f, 9f));

        // Cardinals still win when both are standable and equally distant: the declared
        // order is cardinals first, so the preference does not change for the common case.
        Func<Vector2, bool> cardinalAndDiagonal = StandableAt(
            new Vector2(9f, 10f),
            new Vector2(11f, 11f));
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(10f, 10f), cardinalAndDiagonal, Anywhere())
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
        ExecutionManager.SelectStandingApproachTile(target, new Vector2(1f, 1f), _ => false, Anywhere())
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

    // ---- one tile, one rule ---------------------------------------------------------------

    /*
     * The two predicates used to be two different answers about one tile: `IsWalkableTile` asked the engine's
     * collision test with `pathfinding: true`, while `IsStandableTile` asked `isTilePassable` plus a
     * `StopsStanding` occupancy mask. They could disagree, and the architecture spec (§3.2.1, 「谓词绝对同源」)
     * says one predicate must decide both.
     *
     * `StopsStanding` cannot answer the boulder case at all: resource clumps live under
     * `CollisionMask.TerrainFeatures` (`GameLocation.cs:7385-7392`), which the mask deliberately excludes so
     * that grass and tilled soil stop being obstacles (cbf76421). So the old standable reading reported TRUE for
     * a boulder's own tile -- the exact tile the planner refuses. These cases are behavioural: a real
     * `GameLocation`, real terrain features, a real `Farmer` bounding box.
     */

    [Fact]
    public void AHoeDirtWithNoCrop_IsBothWalkableAndStandable()
    {
        // The live symptom that motivated the mask fix: the tile a farmer would naturally stand on next to a
        // rock, once hoed. Standing among terrain features is the job; it must not be refused here.
        using var harness = TileHarness.Create();
        harness.PlaceTerrain(new Vector2(5f, 5f), new StardewValley.TerrainFeatures.HoeDirt());

        Vector2 tile = new(5f, 5f);
        StardewBodyController.IsWalkableTile(harness.Location, harness.Actor, tile).Should().BeTrue(
            "the planner walks onto tilled soil");
        StardewBodyController.IsStandableTile(harness.Location, harness.Actor, tile).Should().BeTrue(
            "tilled soil is a place to stand, not an obstacle");
    }

    [Fact]
    public void ABoulderOwnTile_IsNeitherWalkableNorStandable()
    {
        // The tile the agent wants to break. No mask membership can express this: a clump is stored under
        // `terrainFeatures`, the collection the mask has to ignore. Only the native step test refuses it.
        using var harness = TileHarness.Create();
        harness.Location.resourceClumps.Add(
            new StardewValley.TerrainFeatures.ResourceClump(148, 2, 2, new Vector2(9f, 9f)));

        Vector2 tile = new(9f, 9f);
        StardewBodyController.IsWalkableTile(harness.Location, harness.Actor, tile).Should().BeFalse(
            "the planner does not step onto a boulder");
        StardewBodyController.IsStandableTile(harness.Location, harness.Actor, tile).Should().BeFalse(
            "and neither may we: this used to answer true, because the mask that ignores terrain features "
            + "also hides the clumps that live there");
    }

    [Fact]
    public void EveryStandableTileIsAlsoWalkable()
    {
        // The contract the spec names (§3.2.1, 「谓词绝对同源」): a tile may never be "standable but not passable",
        // because the approach selector would then hand the native finder a destination it refuses. This is
        // checked across a whole farm corner, not just the two cases above.
        //
        // The reverse is deliberately NOT asserted: an NPC's tile is walkable-through and not standable, which is
        // a real state and the reason the two entry points survive as separate names.
        using var harness = TileHarness.Create();
        harness.PlaceTerrain(new Vector2(5f, 5f), new StardewValley.TerrainFeatures.HoeDirt());
        harness.PlaceTerrain(new Vector2(6f, 5f), new StardewValley.TerrainFeatures.Grass());
        harness.Location.resourceClumps.Add(
            new StardewValley.TerrainFeatures.ResourceClump(148, 2, 2, new Vector2(9f, 9f)));

        for (int x = 0; x < 12; x++)
        {
            for (int y = 0; y < 12; y++)
            {
                Vector2 tile = new(x, y);
                bool walkable = StardewBodyController.IsWalkableTile(harness.Location, harness.Actor, tile);
                bool standable = StardewBodyController.IsStandableTile(harness.Location, harness.Actor, tile);
                if (standable)
                {
                    walkable.Should().BeTrue(
                        $"tile {x},{y} is standable, so the planner must be able to walk there");
                }
            }
        }
    }

    [Fact]
    public void TheActorsOwnTile_StaysStandableAndWalkable()
    {
        // The one tile whose native collision answer cannot be trusted: it reports the actor's own footprint.
        using var harness = TileHarness.Create();

        Vector2 own = harness.Actor.Tile;
        StardewBodyController.IsWalkableTile(harness.Location, harness.Actor, own).Should().BeTrue();
        StardewBodyController.IsStandableTile(harness.Location, harness.Actor, own).Should().BeTrue();
    }

    [Fact]
    public void AMissingActor_IsRefusedByBoth()
    {
        // The honest refusal: with no actor there is no body to stand, and neither reading may claim otherwise.
        using var harness = TileHarness.Create();
        Vector2 tile = new(5f, 5f);

        StardewBodyController.IsWalkableTile(harness.Location, null, tile).Should().BeFalse();
        StardewBodyController.IsStandableTile(harness.Location, null, tile).Should().BeFalse();
    }

    /// <summary>
    /// A real headless farm corner: a 16x16 map with the two layers the engine's collision test reads, a farmer
    /// with a real 48x32 bounding box, and the <c>Game1</c> statics that test dereferences.
    ///
    /// <para>
    /// The statics are the reason this is disposable: <c>NetPosition.Get</c> reads <c>Game1.HostPaused</c> and
    /// <c>Farmer.GetBoundingBox</c> reads <c>netMount</c>, so they must be seeded or every read throws. The whole
    /// assembly already runs without parallelization (AssemblyInfo.cs), so restoring them on dispose is sufficient.
    /// </para>
    /// </summary>
    private sealed class TileHarness : IDisposable
    {
        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;

        /// <summary>
        /// Captures the statics BEFORE <see cref="Create"/> seeds them. Saving them inside <c>Create</c> after
        /// seeding would save this harness's own values and restore them as "the previous state", leaving every
        /// later test in the assembly reading a probe farmer that was disposed minutes ago.
        /// </summary>
        private TileHarness()
        {
            this.gameBefore = Game1.game1;
            this.playerBefore = Game1.player;
            this.worldStateBefore = typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .GetValue(null);
            this.Location = null!;
            this.Actor = null!;
        }

        public GameLocation Location { get; private set; }

        public Farmer Actor { get; private set; }

        public static TileHarness Create()
        {
            var harness = new TileHarness();

            var root = (NetRoot<NetWorldState>)System.Runtime.Serialization.FormatterServices
                .GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, root);
            if (Game1.game1 is null)
                Game1.game1 = (Game1)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(Game1));

            GameLocation location = new();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            location.IsFarm = true;
            SetField(location, "name", new NetString("ProbeFarm"));

            var sprite = (FarmerSprite)System.Runtime.Serialization.FormatterServices
                .GetUninitializedObject(typeof(FarmerSprite));
            SetField(sprite, "spriteWidth", new NetInt(16));
            SetField(sprite, "spriteHeight", new NetInt(32));
            SetField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(Farmer));
            var reference = new NetRef<AnimatedSprite> { Value = sprite };
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetField(actor, "sprite", reference);
            // Sits on 3,3 with the engine's own 48x32 farmer box.
            actor.position.Set(new Vector2(3 * 64 + 8, 3 * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            harness.Location = location;
            harness.Actor = actor;
            return harness;
        }

        public void PlaceTerrain(Vector2 tile, StardewValley.TerrainFeatures.TerrainFeature feature)
        {
            feature.Location = this.Location;
            feature.Tile = tile;
            this.Location.terrainFeatures[tile] = feature;
        }

        private static void SetField(object target, string name, object value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);

        public void Dispose()
        {
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, this.playerBefore);
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, this.worldStateBefore);
            Game1.game1 = this.gameBefore!;
        }
    }
}


