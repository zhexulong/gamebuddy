using System;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A tree's target id names the tree; the durability is what the chop spends, not what the tree IS.
///
/// <para>
/// The identity used to hash `tree.health.Value`, which is the one value `chop_tree_source` exists to change:
/// `Tree.performToolAction` subtracts `upgradeLevel switch { 0 => 1f, 1 => 1.25f, ... }` from it IN PLACE
/// (Tree.cs:1200), a mature tree starts at `Tree.startingHealth = 10` (Tree.cs:38, assigned at :187) and a basic axe
/// removes exactly 1 (Tree.cs:1177-1200). So a plan that submitted two chops could never work: node 0 landed and took
/// the tree from 10 to 9, node 1 arrived carrying the id the plan had read from the observation, the preflight
/// recomputed a different hash from the new health, and the node was refused `tree_chop_target_changed`. The
/// multi-swing interaction was structurally impossible inside one plan.
/// </para>
/// <para>
/// These cases drive the SHIPPED builder over real `Tree` instances, so the id is the one the radar publishes and the
/// preflight recomputes - never a second implementation of it.
/// </para>
/// </summary>
public sealed class TreeChopSourceIdentityTests
{
    /// <summary>
    /// One axe swing does not rename the tree, and neither do the nine that follow it.
    ///
    /// The swing is the engine's own arithmetic (`health.Value -= 1f`, Tree.cs:1200 for `upgradeLevel == 0`), applied
    /// to the value the engine's own constructor assigns, so this is the state the second node of a plan would see.
    /// </summary>
    [Fact]
    public void OneAxeSwingDoesNotChangeTheTargetId()
    {
        using var world = TreeWorld.Create();
        StardewValley.TerrainFeatures.Tree tree = world.PlaceTree(x: 3, y: 2, treeType: "1");

        string observed = ExecutionManager.BuildTreeChopSourceTargetId(world.Farm, 3, 2, tree);
        tree.health.Value.Should().Be(
            (float)StardewValley.TerrainFeatures.Tree.startingHealth,
            "a mature tree starts at the engine's own durability, which is the state the observation read");

        tree.health.Value -= 1f;
        string afterOneSwing = ExecutionManager.BuildTreeChopSourceTargetId(world.Farm, 3, 2, tree);

        afterOneSwing.Should().Be(
            observed,
            "a tree that has been hit once is the SAME tree: hashing the remaining durability refused the second node "
                + "of every multi-swing plan with `tree_chop_target_changed`");

        // The whole sequence, not just the first step: a tree is felled only at `health <= 0` (Tree.cs:587), so every
        // value above it is the same standing source.
        while (tree.health.Value > 1f)
        {
            tree.health.Value -= 1f;
            ExecutionManager.BuildTreeChopSourceTargetId(world.Farm, 3, 2, tree)
                .Should().Be(observed, "every swing before the felling one leaves the same tree standing");
        }
    }

    /// <summary>
    /// The id still binds the SPECIES, which is what stops "the durability is not identity" from degenerating into
    /// "any tree at this tile": a tile can be cleared and replanted between the observation and the request, and a
    /// different tree standing there is a different tree.
    ///
    /// Both directions in one case, deliberately: an id that ignores the species and an id that follows the
    /// durability are each a wrong answer to the same question, and a single-sided assertion would let one of them
    /// pass.
    /// </summary>
    [Fact]
    public void TheIdBindsTheSpeciesAndNotTheDurability()
    {
        using var world = TreeWorld.Create();
        StardewValley.TerrainFeatures.Tree oak = world.PlaceTree(x: 3, y: 2, treeType: StardewValley.TerrainFeatures.Tree.bushyTree);
        string oakId = ExecutionManager.BuildTreeChopSourceTargetId(world.Farm, 3, 2, oak);

        StardewValley.TerrainFeatures.Tree maple = world.PlaceTree(x: 3, y: 2, treeType: StardewValley.TerrainFeatures.Tree.leafyTree);
        string mapleId = ExecutionManager.BuildTreeChopSourceTargetId(world.Farm, 3, 2, maple);

        mapleId.Should().NotBe(oakId, "a maple planted where the oak stood is not the tree the caller asked for");

        oak.health.Value -= 1f;
        maple.health.Value -= 1f;
        ExecutionManager.BuildTreeChopSourceTargetId(world.Farm, 3, 2, oak).Should().Be(oakId);
        ExecutionManager.BuildTreeChopSourceTargetId(world.Farm, 3, 2, maple).Should().Be(mapleId);
    }

    /// <summary>
    /// The address is still the address: the same species on a different tile, or in a different location, is a
    /// different target. Without this, the repair above would be satisfiable by hashing the species alone.
    /// </summary>
    [Fact]
    public void TheIdStillBindsTheTileAndTheLocation()
    {
        using var world = TreeWorld.Create();
        StardewValley.TerrainFeatures.Tree here = world.PlaceTree(x: 3, y: 2, treeType: "1");
        StardewValley.TerrainFeatures.Tree there = world.PlaceTree(x: 4, y: 2, treeType: "1");

        string hereId = ExecutionManager.BuildTreeChopSourceTargetId(world.Farm, 3, 2, here);

        ExecutionManager.BuildTreeChopSourceTargetId(world.Farm, 4, 2, there)
            .Should().NotBe(hereId, "a second tree of the same species on the next tile is a different tree");
        ExecutionManager.BuildTreeChopSourceTargetId(world.OtherFarm, 3, 2, here)
            .Should().NotBe(hereId, "the same tile in another location is another tree");
    }

    /// <summary>
    /// A headless location holding real `Tree` terrain features, following
    /// <c>TargetFamilyCompletenessTests.TargetFamilyWorld</c> and <c>RockSourceSwingOutcomeTests.RockWorld</c>: an
    /// uninitialized `Game1`, the `netWorldState` root the engine's NetFields read, a map so `GameLocation` has its
    /// layers, and `Game1.random` because `Tree`'s own constructor draws from it for `flipped` (Tree.cs:186).
    /// </summary>
    private sealed class TreeWorld : IDisposable
    {
        private readonly Game1? gameBefore;
        private readonly object? worldStateBefore;
        private readonly Random? randomBefore;

        private TreeWorld()
        {
            this.gameBefore = Game1.game1;
            this.worldStateBefore = typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.GetValue(null);
            this.randomBefore = Game1.random;
        }

        internal GameLocation Farm { get; private set; } = null!;

        internal GameLocation OtherFarm { get; private set; } = null!;

        internal static TreeWorld Create()
        {
            var world = new TreeWorld();

            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, root);
            Game1.random ??= new Random(1);

            world.Farm = Location("ProbeFarm");
            world.OtherFarm = Location("ProbeGreenhouse");
            return world;
        }

        internal StardewValley.TerrainFeatures.Tree PlaceTree(int x, int y, string treeType)
        {
            var tree = new StardewValley.TerrainFeatures.Tree(treeType, StardewValley.TerrainFeatures.Tree.treeStage);
            this.Farm.terrainFeatures[new Vector2(x, y)] = tree;
            return tree;
        }

        private static GameLocation Location(string name)
        {
            var location = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            // `name` is a public readonly NetString (GameLocation.cs:331) and `NameOrUniqueName` reads it, so the field
            // itself is replaced. Reflection rather than `location.name.Set(...)` for the reason
            // `ContainerActionTests.HeadlessContainerWorld` gives at the same line.
            typeof(GameLocation).GetField("name", BindingFlags.Public | BindingFlags.Instance)!
                .SetValue(location, new NetString(name));
            return location;
        }

        public void Dispose()
        {
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, this.worldStateBefore);
            typeof(Game1).GetField("random", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, this.randomBefore);
            Game1.game1 = this.gameBefore!;
        }
    }
}
