using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The exits a building's INTERIOR offers must be published, whatever class the interior happens to be.
///
/// <para>
/// <c>location.doors</c> is built by <c>GameLocation.updateDoors</c> from Buildings-layer tiles whose <c>Action</c>
/// property contains "Warp" (GameLocation.cs:17586-17641), so it holds the doorways a map DREW. A farm building's
/// interior carries its exit in <c>warps</c> instead - <c>Building.updateInteriorWarps</c> rewrites the interior warp
/// whose target is the parent location (Building.cs:1799-1816) and <c>getWarpFromDoor</c> reads
/// <c>indoors.warps[0]</c> as the tile the entrance puts the player on (GameLocation.cs:2203) - which is why
/// <c>DiscoverDoorTargets</c> had to reach for the warp list at all. It reached only inside a <c>FarmHouse</c>/<c>Cabin</c>
/// though, so inside a shed, barn, coop or greenhouse the same list was there and the snapshot said
/// <c>doorTargets: []</c>: "this room has no way out".
/// </para>
///
/// <para>
/// The cases below build the interior SHAPE rather than a Shed instance - an empty door table beside a warp list that
/// holds the exit - because that shape is the engine's fact about every building interior and the class name is exactly
/// what the discovery must stop reading. Each case asserts the shape it built, so a fixture that quietly grew a door
/// table could not keep passing.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class DoorTargetsInteriorExitTests
{
    /// <summary>
    /// The defect, as a case: an interior with no door table and its exit in the warp list publishes that exit, naming
    /// the tile the warp holds and the location it leads to.
    /// </summary>
    [Fact]
    public void AnInteriorWhoseOnlyExitIsAWarpPublishesThatExit()
    {
        using DoorWorld world = DoorWorld.Create();
        world.Location.warps.Add(new Warp(6, 12, "Farm", 64, 15, flipFarmer: false));

        IReadOnlyList<BridgeDoor> doors = ExecutionManager.DiscoverDoorTargets(Game1.player);

        world.Location.doors.Pairs.Should().BeEmpty("a building interior's doorways are not drawn into the Buildings layer");
        world.Location.warps.Should().ContainSingle("the exit is the warp list's fact, and it is the only exit this room has");
        doors.Should().ContainSingle("this room has a way out, so doorTargets must never be empty here")
            .Which.Should().Be(new BridgeDoor(6, 12, "Farm", 64, 15));
    }

    /// <summary>
    /// Two exits are two rows, and one tile named twice is one row: the family publishes TILES, so a warp the map
    /// declared twice (an NPC-only twin beside the player's, or a repeated declaration) must not read as two doorways.
    /// </summary>
    [Fact]
    public void TwoExitsAreTwoRowsAndOneTileNamedTwiceIsOneRow()
    {
        using DoorWorld world = DoorWorld.Create();
        world.Location.warps.Add(new Warp(6, 12, "Farm", 64, 15, flipFarmer: false));
        world.Location.warps.Add(new Warp(6, 12, "Farm", 64, 15, flipFarmer: false));
        world.Location.warps.Add(new Warp(6, 13, "Farm", 65, 15, flipFarmer: false));

        IReadOnlyList<BridgeDoor> doors = ExecutionManager.DiscoverDoorTargets(Game1.player);

        doors.Select(door => (door.SourceX, door.SourceY)).Should().Equal(
            new[] { (6, 12), (6, 13) },
            "dedup is by source tile, and the order is the warp list's own so one world yields one list");
    }

    /// <summary>
    /// A transition that moves no PLAYER is not a doorway: an <c>NPCWarp</c> declaration carries
    /// <c>npcOnly.Value</c>, and the <c>warps</c> family beside this one excludes the same rows.
    /// </summary>
    [Fact]
    public void AnNpcOnlyWarpIsNotADoor()
    {
        using DoorWorld world = DoorWorld.Create();
        world.Location.warps.Add(new Warp(6, 12, "Farm", 64, 15, flipFarmer: false, npcOnly: true));
        world.Location.warps.Add(new Warp(6, 13, "Farm", 65, 15, flipFarmer: false));

        IReadOnlyList<BridgeDoor> doors = ExecutionManager.DiscoverDoorTargets(Game1.player);

        world.Location.warps.Should().HaveCount(2, "the fixture carries both declarations");
        doors.Should().ContainSingle().Which.SourceY.Should().Be(13);
    }

    /// <summary>
    /// The inverse: a room with no exits publishes nothing, and that is a different answer from the defect above
    /// because the fixture asserts the warp list it publishes from is empty.
    /// </summary>
    [Fact]
    public void ARoomWithNoExitPublishesNoDoor()
    {
        using DoorWorld world = DoorWorld.Create();

        IReadOnlyList<BridgeDoor> doors = ExecutionManager.DiscoverDoorTargets(Game1.player);

        world.Location.doors.Pairs.Should().BeEmpty();
        world.Location.warps.Should().BeEmpty();
        doors.Should().BeEmpty();
    }

    // ---------------------------------------------------------------------------------------------------------

    /// <summary>
    /// A room the size of a shed's interior: a real <see cref="GameLocation"/> whose door table is empty, a real
    /// <see cref="Farmer"/> bound to it as <c>Game1.player</c>, and the <c>Game1</c> statics the engine dereferences
    /// (the shape <c>EnterExitAdjacentExitRefusalTests.HeadlessWorld</c> established). The statics are captured before
    /// the world is built and restored on exit, so a later class never resolves its own location into this one.
    /// </summary>
    private sealed class DoorWorld : IDisposable
    {
        private readonly Dictionary<string, object?> statics;

        private DoorWorld()
        {
            this.statics = HeadlessGameWorld.CaptureStatics();
        }

        public GameLocation Location { get; private set; } = null!;

        public static DoorWorld Create()
        {
            var world = new DoorWorld();

            Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, root);

            var location = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            location.IsFarm = true;
            SetField(location, "name", new NetString("ProbeShedInterior"));
            world.Location = location;

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = new StardewValley.Inventories.Inventory() });
            actor.position.Set(new Vector2(6 * 64 + 8, 13 * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);
            HeadlessGameWorld.RequireBound(actor, location);

            return world;
        }

        private static void SetField(object target, string name, object value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);

        public void Dispose() => HeadlessGameWorld.RestoreStatics(this.statics);
    }
}
