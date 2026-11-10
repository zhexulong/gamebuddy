using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Navigation;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// ONE reachability judgement for the ring around a goal, asked by both halves that used to disagree about it: the
/// refusal that DESCRIBES the approaches (<see cref="StardewBodyController.DescribeTargetApproaches"/>,
/// published as <c>approaches=</c>) and the Navigation approach leg that WALKS one
/// (<c>ExecutionManager.SelectSafeApproachTarget</c>, published as <c>approach=unavailable</c>).
///
/// <para>
/// The two were measured disagreeing in one session: <c>no_native_path</c> x3 carrying
/// <c>approaches=east:open,south:open</c> beside <c>route_exists_cardinal=false</c> for ring tiles six tiles outside
/// the actor's component, and <c>navigation_approach_unavailable</c> x2 carrying <c>phase=approved;approach=unavailable</c>
/// and nothing else. Between them the companion crossed Farm -&gt; Backwoods -&gt; Mountain three times. Three shapes are
/// pinned here, and none of them can stand for another:
/// </para>
///
/// <list type="bullet">
/// <item>ordinary farm ground on the ring must be <c>open</c> AND walkable to - the approach leg used a
/// <c>CollisionMask.All</c> occupant mask, which counts <c>TerrainFeatures</c>, so it refused the very tile the agent
/// had just been told to stand on;</item>
/// <item>a ring tile that is free but walled off from the actor must be <c>unreachable</c>, not <c>open</c> - this is the
/// refusal that ends a hunt for a door that is not connected;</item>
/// <item>a ring with no open tile must NAME the culprit and its tile, so the caller has a next step instead of
/// <c>unavailable</c>.</item>
/// </list>
///
/// <para>
/// The world is real: a 16x16 location whose two layers the engine's collision test reads, a real <c>Farmer</c> with its
/// 48x32 box, real terrain features, real resource clumps. The walls are resource clumps of an index the tool table does
/// not price (<c>CorridorHarness</c>'s rule), because an unoccupied tile in a headless xTile map is never refused by the
/// planner on its own.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class ApproachRingAgreementTests
{
    private static NavigationTransitionLeg LegFor(Vector2 goal) =>
        new("Mine", (int)goal.X, (int)goal.Y, 20, 20, IsDoor: false);

    private static readonly (string Direction, int Dx, int Dy)[] Cardinal =
    {
        ("north", 0, -1),
        ("east", 1, 0),
        ("south", 0, 1),
        ("west", -1, 0),
    };

    /// <summary>
    /// The fork's own shape: the ground the companion was told to stand on (<c>stand_at=40,10</c>) is ordinary farm
    /// ground, and the approach leg refused it. All four ring tiles carry tilled soil, so the leg had no candidate left
    /// - which is exactly the state that produced <c>phase=approved;approach=unavailable</c> with no tile in it.
    ///
    /// RED BEFORE THE FIX: the probe answered <c>west:open north:open east:open south:open</c> while the leg answered
    /// null, because <c>CollisionMask.All</c> contains <c>TerrainFeatures</c>.
    /// </summary>
    [Fact]
    public void FarmGroundOnTheRing_IsOpenForTheProbeAndWalkableForTheApproachLeg()
    {
        using var harness = RingHarness.Create();
        Vector2 goal = new(6f, 6f);
        foreach ((string _, int dx, int dy) in Cardinal)
            harness.PlaceTerrain(new Vector2(goal.X + dx, goal.Y + dy), new StardewValley.TerrainFeatures.HoeDirt());

        string probe = StardewBodyController.DescribeTargetApproaches(harness.Actor, harness.Location, goal);
        probe.Split(',').Should().HaveCount(4).And.OnlyContain(
            entry => entry.EndsWith(":open", StringComparison.Ordinal),
            $"tilled soil is ground the planner walks on, and the receipt says so - got: {probe}");

        Vector2? approach = harness.Manager.SelectSafeApproachTarget(LegFor(goal), out StardewBodyController.CardinalRing? ring);

        ring.Should().NotBeNull();
        approach.Should().NotBeNull(
            $"the probe named four open approaches ({probe}), so the leg that walks one must accept one");
        probe.Split(',').Should().Contain($"{Direction(goal, approach!.Value)}:open",
            "the tile the leg walks to is one the probe published as open - one judgement, not two");
    }

    /// <summary>
    /// The lie that cost the three map crossings: a free tile outside the actor's walkable component answered
    /// <c>open</c>, and the leg that should have refused it accepted it and handed the engine a walk it answers
    /// <c>no_native_path</c>.
    ///
    /// RED BEFORE THE FIX: the probe said <c>east:open west:open</c> for tiles a wall separated from the actor, and the
    /// leg returned one of them.
    /// </summary>
    [Fact]
    public void AFreeButWalledOffRingTile_IsUnreachableForTheProbeAndNeverWalkedByTheLeg()
    {
        using var harness = RingHarness.Create();
        harness.BuildCorridor();
        // The boulder that splits the corridor: the actor's component ends west of it, the goal is east of it.
        harness.PlaceWall(6, 3, RingHarness.WallIndex);
        Vector2 goal = new(9f, 3f);

        string probe = StardewBodyController.DescribeTargetApproaches(harness.Actor, harness.Location, goal);

        probe.Should().NotContain(":open",
            $"from 2,3 nothing on the far side of the boulder is walkable-to, so no approach may read open - got: {probe}");
        probe.Split(',').Should().Contain("east:unreachable", "9,3's east neighbour is free ground the actor cannot walk to");
        probe.Split(',').Should().Contain("west:unreachable", "and so is its west neighbour");

        Vector2? approach = harness.Manager.SelectSafeApproachTarget(LegFor(goal), out StardewBodyController.CardinalRing? ring);

        approach.Should().BeNull(
            "the leg may not walk to a tile the actor cannot reach: the engine answers that walk with no_native_path");
        ring!.BlockedBy.Should().Be("unreachable_ground@10,3",
            "the culprit is the free ground beside the goal, and the receipt names its tile");
    }

    /// <summary>
    /// The claim the brief asks for by name: a refusal names the blocker and its tile instead of <c>unavailable</c>.
    /// The boulder is index 148 - the one the cost table prices as <c>rock</c> - so the word here is the same word
    /// the same receipt's <c>clear_to_reach=</c> publishes, and the companion can act on it with the pickaxe.
    ///
    /// RED BEFORE THE FIX: <c>phase=approved;approach=unavailable</c>, with no tile and no blocker anywhere in it.
    /// </summary>
    [Fact]
    public void ARingWithNoOpenTile_NamesTheBlockerAndItsTile()
    {
        using var harness = RingHarness.Create();
        // The goal's own tile is the only free ground: a priced boulder north of it, plain walls on the other three.
        Vector2 goal = new(9f, 3f);
        harness.PlaceWall(9, 2, RingHarness.PricedBoulderIndex);
        harness.PlaceWall(10, 3, RingHarness.WallIndex);
        harness.PlaceWall(9, 4, RingHarness.WallIndex);
        harness.PlaceWall(8, 3, RingHarness.WallIndex);

        Vector2? approach = harness.Manager.SelectSafeApproachTarget(LegFor(goal), out StardewBodyController.CardinalRing? ring);

        approach.Should().BeNull();
        ring!.BlockedBy.Should().Be("rock@9,2", "the boulder is named and placed - `rock` is the clearing table's word for it");
        ring.Entries.Should().Contain(entry => entry.Blocker == ring.BlockedBy,
            "the named blocker is attributed to one of the four ring tiles, not left dangling");
        string evidence = ExecutionManager.DescribeApproachRing(ring);
        evidence.Should().Contain("approach_blocked_by:rock@9,2");
        evidence.Should().Contain("approaches=").And.NotContain(":open",
            $"the refusal carries the ring it decided on and no open approach - got: {evidence}");
    }

    private static string Direction(Vector2 goal, Vector2 tile)
    {
        int dx = (int)tile.X - (int)goal.X;
        int dy = (int)tile.Y - (int)goal.Y;
        foreach ((string direction, int ox, int oy) in Cardinal)
        {
            if (dx == ox && dy == oy)
                return direction;
        }
        throw new InvalidOperationException($"({tile.X},{tile.Y}) is not cardinal-adjacent to ({goal.X},{goal.Y})");
    }

    /// <summary>
    /// A real 16x16 location, a real <c>Farmer</c> with its 48x32 box at (2,3), and the <c>Game1</c> statics both
    /// readings dereference. Disposable because those statics are process-wide and this assembly runs without
    /// parallelization (<c>AssemblyInfo.cs</c>); restoring them on dispose is what keeps the next test honest.
    ///
    /// <para>
    /// The walls are <c>ResourceClump</c>s of an index the tool table does not price, the same rule
    /// <c>CorridorHarness</c> uses: a resource clump blocks the planner, and only a clump the cost table refuses to
    /// price stays a wall instead of becoming a clearable target.
    /// </para>
    /// </summary>
    private sealed class RingHarness : IDisposable
    {
        /// <summary>
        /// A resource clump index the tool cost table does not price: the one occupant that blocks the planner and
        /// stays a wall instead of becoming a clearable target. The rule <c>CorridorHarness</c> already uses.
        /// </summary>
        internal const int WallIndex = 0;

        /// <summary>The boulder the native tool table prices as `rock` - a wall that CAN be cleared.</summary>
        internal const int PricedBoulderIndex = 148;

        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;

        private RingHarness()
        {
            this.gameBefore = Game1.game1;
            this.playerBefore = Game1.player;
            this.worldStateBefore = typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .GetValue(null);
            this.Location = null!;
            this.Actor = null!;
            this.Manager = null!;
        }

        public GameLocation Location { get; private set; }

        public Farmer Actor { get; private set; }

        /// <summary>The real ledger, with no native approach seam wired - the branch production runs.</summary>
        public ExecutionManager Manager { get; private set; }

        public static RingHarness Create()
        {
            var harness = new RingHarness();

            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, root);
            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));

            GameLocation location = new();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            location.IsFarm = true;
            SetField(location, "name", new NetString("ProbeFarm"));

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            SetField(sprite, "spriteWidth", new NetInt(16));
            SetField(sprite, "spriteHeight", new NetInt(32));
            SetField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            // The clearing table asks the actor what it is holding and how skilled it is, and every one of those reads a
            // Net field: an uninitialised actor dereferences null from `CurrentTool` and from `MiningLevel`.
            SetField(actor, "netStamina", new NetFloat(270f));
            SetField(actor, "usingTool", new NetBool(false));
            SetField(actor, "toolPower", new NetInt(0));
            SetField(actor, "temporaryItem", new NetRef<Item>());
            SetField(actor, "currentToolIndex", new NetInt(0));
            SetField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = new StardewValley.Inventories.Inventory() });
            SetField(actor, "miningLevel", new NetInt(0));
            SetField(actor, "foragingLevel", new NetInt(0));
            SetField(actor, "farmingLevel", new NetInt(0));
            var buffs = new StardewValley.Buffs.BuffManager();
            typeof(StardewValley.Buffs.BuffManager)
                .GetField("CombinedEffects", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(buffs, new StardewValley.Buffs.BuffEffects());
            buffs.Dirty = false;
            SetField(actor, "buffs", buffs);
            // `canMove` is a plain bool that defaults to false on an uninitialised actor.
            typeof(Farmer).GetField("canMove", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, true);
            // The engine's own placement for a 32px-tall sprite: the box centres on the tile, so the actor is on 2,3.
            actor.position.Set(new Vector2(2 * 64 + 8, 3 * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            FarmhandCapabilityPublication publication =
                FarmhandCapabilityPublication.Initial(new HashSet<string>(new[] { "navigate_to_destination" }));

            harness.Location = location;
            harness.Actor = actor;
            HeadlessGameWorld.RequireBound(actor, location);
            harness.Manager = new ExecutionManager(new DummyMonitor(), () => publication);
            return harness;
        }

        /// <summary>Walls every row but the corridor row y=3, where the actor stands.</summary>
        public void BuildCorridor()
        {
            for (int x = 0; x < 16; x++)
            {
                for (int y = 0; y < 16; y++)
                {
                    if (y != 3)
                        this.PlaceWall(x, y, WallIndex);
                }
            }
        }

        public void PlaceWall(int x, int y, int clumpIndex) =>
            this.Location.resourceClumps.Add(new StardewValley.TerrainFeatures.ResourceClump(clumpIndex, 1, 1, new Vector2(x, y)));

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
