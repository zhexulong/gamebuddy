using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Navigation;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `a_blocked_exit_is_not_a_route:&lt;exit&gt;` - an exit whose own entry cell is a wall that stands for the whole run is not an
/// edge of the graph the planner ranks routes over.
///
/// <para>
/// MEASURED `round89`, days 1 and 3: the planner is an unweighted breadth-first search over map hops, so `Farm ->
/// Backwoods -> Mountain` (two hops) always beat `Farm -> Backwoods -> BusStop -> Town -> Mountain` (three) - and the
/// Backwoods' east exit is entered from the tile its own map puts a Bush on (`entry_blocked_by:large:Bush@49,10`), which
/// no published action clears. Every navigation across the north of the valley therefore walked to that wall and back,
/// while the road the game does let a body walk sat in the same topology unasked.
/// </para>
///
/// <para>
/// The world is real: locations whose two map layers the engine's collision test reads, a real warp table, a real Bush in
/// the collection the engine's own collision walks - the shape <c>DoorApproachSideGateTests</c> established. The
/// population is the product's own projection over that world (<see cref="Game1NavigationWorldSource.ProjectTopologyLegs"/>),
/// not a leg written here, so an exit that starts or stops being an edge changes the examined set on its own.
/// </para>
///
/// <para>
/// BOTH READINGS ARE TAKEN FROM ONE MAP: the same location with the Bush and without it. Only the second one can tell a
/// rule from a projection that never produced the leg in the first place.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class BlockedExitTopologyTests
{
    private readonly ITestOutputHelper output;

    public BlockedExitTopologyTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// The live failure, replayed: the Backwoods publishes two ways out, the east one is entered from a Bush, and the
    /// graph the planner walks must hold only the road that a body can actually take.
    ///
    /// <para>
    /// RED BEFORE THE FIX: `TraversableTopologyLegs` did not exist and the topology held both exits, so
    /// <see cref="NavigationRoutePlanner"/> answered <c>Mountain</c> - the exit the walk refuses - as the next leg of
    /// every navigation across the north of the valley.
    /// </para>
    /// </summary>
    [Fact]
    public void AnExitWhoseEntryCellIsPermanentlyWalledIsNotARoute()
    {
        using BackwoodsWorld world = BackwoodsWorld.Create();

        // WHAT THE MAP DECLARES, before any rule the topology applies: both exits are edges of this location.
        IReadOnlyList<string> declared = Game1NavigationWorldSource
            .ProjectTopologyLegs(world.Backwoods)
            .Select(Describe)
            .ToArray();
        declared.Should().Equal(new[] { "Mountain@50,10", "BusStop@50,30" }, "this map declares both exits");

        // THE READING THAT MATTERS: the route the planner hands the walker is the one it can actually take.
        NavigationRoutePlanResult next = new NavigationRoutePlanner().Plan(
            world.Topology(), "Backwoods", Binding("Mountain"));

        next.Kind.Should().Be(NavigationRoutePlanKind.NextEdge, next.ReasonCode);
        next.NextLeg!.TargetLocation.Should().Be(
            "BusStop",
            "the two-hop exit is a wall; Backwoods -> BusStop -> Town -> Mountain is the published way to the Mountain");

        IReadOnlyList<string> routes = Game1NavigationWorldSource
            .TraversableTopologyLegs(world.Backwoods)
            .Select(Describe)
            .ToArray();
        this.output.WriteLine($"declared: {string.Join(",", declared)} · routes: {string.Join(",", routes)}");
        routes.Should().Equal(
            new[] { "BusStop@50,30" },
            "the east exit is entered from 49,10, where this map's own Bush stands and no published action clears one");
    }

    /// <summary>
    /// The second reading, from the same map: take the Bush away and the east exit is a route again. Without it, the test
    /// above would pass for a projection that had simply stopped publishing that leg.
    /// </summary>
    [Fact]
    public void TheSameExitIsARouteOnceTheWallIsGone()
    {
        using BackwoodsWorld world = BackwoodsWorld.Create();
        world.ClearBushes();

        IReadOnlyList<string> routes = Game1NavigationWorldSource
            .TraversableTopologyLegs(world.Backwoods)
            .Select(Describe)
            .ToArray();
        this.output.WriteLine($"routes: {string.Join(",", routes)}");
        routes.Should().Equal(
            new[] { "Mountain@50,10", "BusStop@50,30" },
            "nothing keeps a body off 49,10 any more");

        NavigationRoutePlanResult next = new NavigationRoutePlanner().Plan(
            world.Topology(), "Backwoods", Binding("Mountain"));

        next.Kind.Should().Be(NavigationRoutePlanKind.NextEdge, next.ReasonCode);
        next.NextLeg!.TargetLocation.Should().Be("Mountain", "with the Bush gone the shorter route is the walkable one");
    }

    private static string Describe(NavigationTransitionLeg leg) => $"{leg.TargetLocation}@{leg.SourceX},{leg.SourceY}";

    private static NavigationDestinationBinding Binding(string identity) => new("stardew", identity, "generation_01", 1);

    /// <summary>
    /// A valley shaped like the game's own north road: the Backwoods' east exit onto the Mountain (the cell in front of it
    /// is where the map puts a Bush), the Backwoods road to the Bus Stop, and the Bus Stop and Town roads that reach the
    /// Mountain the long way. The two deeper locations' warps are ordinary in-map tiles, so the only fact this fixture
    /// varies is the wall in front of the east exit.
    /// </summary>
    private sealed class BackwoodsWorld : IDisposable
    {
        private readonly Dictionary<string, object?> statics;

        private BackwoodsWorld() => this.statics = HeadlessGameWorld.CaptureStatics();

        internal GameLocation Backwoods { get; private set; } = null!;

        private GameLocation BusStop { get; set; } = null!;

        private GameLocation Town { get; set; } = null!;

        private GameLocation Mountain { get; set; } = null!;

        internal static BackwoodsWorld Create()
        {
            var world = new BackwoodsWorld();

            Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, root);

            world.Backwoods = Location("Backwoods", 50, 40);
            world.Backwoods.warps.Add(new Warp(50, 10, "Mountain", 30, 31, flipFarmer: false));
            world.Backwoods.warps.Add(new Warp(50, 30, "BusStop", 11, 8, flipFarmer: false));
            world.Backwoods.largeTerrainFeatures.Add(Bush(world.Backwoods, 49, 10));

            world.BusStop = Location("BusStop", 12, 9);
            world.BusStop.warps.Add(new Warp(6, 8, "Town", 60, 60, flipFarmer: false));

            world.Town = Location("Town", 80, 80);
            world.Town.warps.Add(new Warp(79, 0, "Mountain", 30, 31, flipFarmer: false));

            world.Mountain = Location("Mountain", 40, 40);

            return world;
        }

        /// <summary>The graph the planner reads, built by the SAME projection the live source builds it from.</summary>
        internal NavigationOrdinaryWarpTopology Topology() =>
            new("Backwoods", new[]
            {
                this.Backwoods,
                this.BusStop,
                this.Town,
                this.Mountain,
            }.Select(location => new NavigationOrdinaryWarpLegs(
                location.NameOrUniqueName,
                Game1NavigationWorldSource.TraversableTopologyLegs(location))).ToArray());

        /// <summary>The wall removed: the one variable this fixture is about.</summary>
        internal void ClearBushes() => this.Backwoods.largeTerrainFeatures.Clear();

        /// <summary>
        /// One location of the requested size with the layers the engine's own tile questions read. The Bush is built the
        /// way <c>DoorApproachSideGateTests</c> builds it - the parameterless constructor plus <c>size</c>, because the
        /// placement constructor draws its sprite from the content pipeline and because <c>size</c> is what
        /// <c>getBoundingBox</c> reads.
        /// </summary>
        private static StardewValley.TerrainFeatures.Bush Bush(GameLocation location, int x, int y)
        {
            var bush = new StardewValley.TerrainFeatures.Bush { Tile = new Vector2(x, y), Location = location };
            bush.size.Value = 3;
            return bush;
        }

        private static GameLocation Location(string name, int width, int height)
        {
            var location = new GameLocation();
            var map = new xTile.Map();
            var size = new xTile.Dimensions.Size(width, height);
            map.AddLayer(new xTile.Layers.Layer("Back", map, size, new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, size, new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            typeof(GameLocation)
                .GetField("name", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(location, new NetString(name));
            return location;
        }

        public void Dispose() => HeadlessGameWorld.RestoreStatics(this.statics);
    }
}
