using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using Netcode;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A transition refusal must name the exits this location actually has, and a request one step off a published
/// exit must be the transition rather than a refusal.
///
/// <para>
/// Measured 2026-11-14 (`round42`, day 6, a companion who could not leave the farmhouse): she stood on `(3,11)`
/// and asked `enter_exit(3,11)` while the SAME snapshot published `doorTargets: [{sourceX:3, sourceY:12,
/// targetLocation:"Farm", targetX:64, targetY:15}]`. The refusal was <c>door_not_available</c> with
/// <c>source=3,11;warps=1</c> - the count of the location's warp list and nothing else. Every fact needed to
/// answer "the door you want is at 3,12, one step south of you" was in hand at the moment of refusal and was not
/// published.
/// </para>
///
/// <para>
/// This is the second member of one family. `round19` refused `Farm(41,65)-&gt;Forest` as
/// <c>door_not_available</c> seven times across three minutes while the companion stood on the adjacent tile;
/// that fix taught the action to RESOLVE a warp from either table, and this one teaches the refusal to NAME the
/// tile it resolved - and, when the actor is one orthogonal step from it, to take that step instead of refusing.
/// </para>
///
/// <para>
/// The refusals below are driven through the REAL request path against a headless world built the way
/// <c>ApproachClassificationTests.HeadlessWorld</c> builds one: a real <see cref="GameLocation"/>, a real
/// <see cref="Farmer"/> and the <c>Game1</c> statics the engine and <c>Context.IsWorldReady</c> dereference. The
/// one thing that cannot run here is the engine's own warp: <c>Farm.warpFarmer</c> dereferences a live game
/// (<c>Farmer.warpFarmer</c>, Farmer.cs:5416 -&gt; <c>Halt()</c> -&gt; <c>Sprite</c>), so the adjacency DECISION is
/// asserted on the production function that makes it and the live run proves the arrival.
/// </para>
/// </summary>
public sealed class EnterExitAdjacentExitRefusalTests
{
    private const string TransitionMethod = "private LocalExecutionReceipt RequestLocalDoorTransition";

    /// <summary>
    /// The exact `round42` row, through the real request path: the refusal names the door at `(3,12)`, its
    /// distance from the actor's own tile, and the tile the caller asked for.
    /// </summary>
    [Fact]
    public void TheRefusalNamesTheDoorTheActorIsStandingBeside()
    {
        using var world = HeadlessWorld.Create();
        world.Location.warps.Add(new Warp(3, 12, "Farm", 64, 15, flipFarmer: false));
        world.PlaceActorAt(3, 11);

        LocalExecutionReceipt receipt = world.RequestEnterExit(9, 9);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("door_not_available");
        receipt.Evidence.Should().Be(
            "source=9,9;warps=1;you=3,11;nearest=3,12;distance=1;doors=3,12->Farm",
            "the refusal knows where the door is; naming the count of the warp list alone is the round42 defect");
    }

    /// <summary>
    /// The exact `round42` request: she named her OWN tile, the door was one row below it, and one orthogonal step
    /// is what stood in the way. The decision is the production function the request path asks, run against the
    /// exits the production discovery reads out of a live location.
    /// </summary>
    [Fact]
    public void TheOneStepOffTheDoorIsTheTransitionRatherThanARefusal()
    {
        using var world = HeadlessWorld.Create();
        world.Location.warps.Add(new Warp(3, 12, "Farm", 64, 15, flipFarmer: false));
        world.PlaceActorAt(3, 11);

        ExecutionManager.AdjacentExitStep(
                ExecutionManager.DiscoverExitTiles(Game1.player), (3, 11), (3, 11))
            .Should().Be((3, 12, 1), "she asked to leave and the way out is one step south of her");
    }

    /// <summary>
    /// The same one step for an EDGE WARP, which lives in `location.warps` and in no door table: the `round19`
    /// shape (`Farm(41,65)->Forest`), so the family is covered by a second map shape and both tables are named.
    /// </summary>
    [Fact]
    public void TheSameOneStepWorksForAnEdgeWarpTheDoorTableNeverHolds()
    {
        using var world = HeadlessWorld.Create();
        world.Location.warps.Add(new Warp(41, 65, "Forest", 56, 33, flipFarmer: false));
        world.PlaceActorAt(41, 64);

        ExecutionManager.AdjacentExitStep(
                ExecutionManager.DiscoverExitTiles(Game1.player), (41, 65), (41, 64))
            .Should().Be((41, 65, 1), "round19's tile is an edge warp; the actor stands one tile north of it");

        // And the refusal for a tile the caller aimed elsewhere names that exit, so the second shape carries the
        // naming half too rather than only the decision.
        LocalExecutionReceipt receipt = world.RequestEnterExit(45, 60);
        receipt.ReasonCode.Should().Be("door_not_available");
        receipt.Evidence.Should().Be("source=45,60;warps=1;you=41,64;nearest=41,65;distance=1;doors=41,65->Forest");
    }

    /// <summary>
    /// The step is ORTHOGONAL. A door on the diagonal is two steps of walking, not the one the actor is standing
    /// beside, and the native click entry does not reach it at its own radius either.
    /// </summary>
    [Fact]
    public void ADoorOnTheDiagonalIsNotTheOneStep()
    {
        using var world = HeadlessWorld.Create();
        world.Location.warps.Add(new Warp(3, 12, "Farm", 64, 15, flipFarmer: false));
        world.PlaceActorAt(2, 11);

        ExecutionManager.AdjacentExitStep(
                ExecutionManager.DiscoverExitTiles(Game1.player), (2, 11), (2, 11))
            .Should().BeNull("a diagonal door is two orthogonal steps away");
    }

    /// <summary>
    /// The rescue must not teleport a companion out of the location she is working in: a request for a tile she did
    /// NOT aim at stays a refusal even while she stands beside a door.
    /// </summary>
    [Fact]
    public void ARequestThatDidNotAimAtTheDoorIsNotARescue()
    {
        using var world = HeadlessWorld.Create();
        world.Location.warps.Add(new Warp(3, 12, "Farm", 64, 15, flipFarmer: false));
        world.PlaceActorAt(3, 11);

        ExecutionManager.AdjacentExitStep(
                ExecutionManager.DiscoverExitTiles(Game1.player), (9, 9), (3, 11))
            .Should().BeNull("the caller asked about (9,9); leaving the location is not the answer to that");
    }

    /// <summary>
    /// The list is bounded and ordered nearest-first, so one line cannot grow with the map and the nearest exit is
    /// always the one named first.
    /// </summary>
    [Fact]
    public void ARefusalNamesAtMostThreeExitsNearestFirst()
    {
        using var world = HeadlessWorld.Create();
        world.Location.warps.Add(new Warp(5, 5, "Desert", 35, 43, flipFarmer: false));
        world.Location.warps.Add(new Warp(3, 3, "Mountain", 31, 20, flipFarmer: false));
        world.Location.warps.Add(new Warp(2, 2, "Beach", 20, 4, flipFarmer: false));
        world.Location.warps.Add(new Warp(1, 1, "Town", 20, 12, flipFarmer: false));
        world.Location.warps.Add(new Warp(4, 4, "Forest", 56, 33, flipFarmer: false));
        world.PlaceActorAt(2, 1);

        LocalExecutionReceipt receipt = world.RequestEnterExit(9, 9);

        receipt.Evidence.Should().Be(
            "source=9,9;warps=5;you=2,1;nearest=1,1;distance=1;"
            + "doors=1,1->Town|2,2->Beach|3,3->Mountain");
    }

    /// <summary>
    /// A location with no exits at all says `doors=none` rather than a bare count: "there are no warps here" and
    /// "you named a tile that is not one" are different answers, and a count cannot tell them apart.
    /// </summary>
    [Fact]
    public void ALocationWithNoExitsSaysNoneRatherThanACount()
    {
        using var world = HeadlessWorld.Create();
        world.PlaceActorAt(9, 9);

        LocalExecutionReceipt receipt = world.RequestEnterExit(9, 9);

        receipt.ReasonCode.Should().Be("door_not_available");
        receipt.Evidence.Should().Be("source=9,9;warps=0;you=9,9;nearest=none;distance=none;doors=none");
    }

    // ---------------------------------------------------------------------------------------------------------

    /// <summary>
    /// A real headless world: a 16x16 <see cref="GameLocation"/>, a real <see cref="Farmer"/> and the
    /// <c>Game1</c> statics both the engine and <c>Context.IsWorldReady</c> dereference (the shape
    /// <c>ApproachClassificationTests.HeadlessWorld</c> established, kept local to the cases it serves).
    /// </summary>
    private sealed class HeadlessWorld : IDisposable
    {
        private static readonly FieldInfo WorldReadyPerScreen = typeof(Context)
            .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
            .GetGetMethod()!
            .Module.ResolveField(BitConverter.ToInt32(typeof(Context)
                .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
                .GetGetMethod()!.GetMethodBody()!.GetILAsByteArray()!, 1))!;

        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;

        private HeadlessWorld()
        {
            this.gameBefore = Game1.game1;
            this.playerBefore = Game1.player;
            this.worldStateBefore = typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .GetValue(null);
        }

        public GameLocation Location { get; private set; } = null!;

        public static HeadlessWorld Create()
        {
            var world = new HeadlessWorld();

            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, root);

            var location = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            location.IsFarm = true;
            SetField(location, "name", new NetString("ProbeFarm"));
            world.Location = location;

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            SetField(sprite, "spriteWidth", new NetInt(16));
            SetField(sprite, "spriteHeight", new NetInt(32));
            SetField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            SetField(actor, "uniqueMultiplayerID", new NetLong(1001));
            SetField(actor, "netStamina", new NetFloat(270f));
            SetField(actor, "usingTool", new NetBool(false));
            SetField(actor, "toolPower", new NetInt(0));
            typeof(Farmer).GetField("canMove", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, true);
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
            SetField(actor, "mailReceived", new NetStringHashSet());
            actor.position.Set(new Vector2(9 * 64 + 8, 9 * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            WorldReadyPerScreen.GetValue(null)!.GetType()
                .GetMethod("SetValueForScreen", new[] { typeof(int), typeof(bool) })!
                .Invoke(WorldReadyPerScreen.GetValue(null), new object[] { Context.ScreenId, true });
            Context.IsWorldReady.Should().BeTrue("the headless world must satisfy the readiness gate the body checks");

            return world;
        }

        public void PlaceActorAt(int x, int y) => Game1.player.position.Set(new Vector2(x * 64 + 8, y * 64));

        /// <summary>`enter_exit` through its real request path.</summary>
        public LocalExecutionReceipt RequestEnterExit(int sourceX, int sourceY)
        {
            var publication = FarmhandCapabilityPublication.Initial(
                new HashSet<string>(StringComparer.Ordinal) { "enter_exit" });
            var executions = new ExecutionManager(new DummyMonitor(), () => publication, executionScope: null);
            return executions.RequestLocalEnterExit(
                $"req_enter_exit_{sourceX}_{sourceY}",
                sourceX,
                sourceY,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);
        }

        private static void SetField(object target, string name, object value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);

        public void Dispose()
        {
            WorldReadyPerScreen.GetValue(null)!.GetType().GetMethod("ResetAllScreens")!
                .Invoke(WorldReadyPerScreen.GetValue(null), null);
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!
                .SetValue(null, this.playerBefore);
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, this.worldStateBefore);
            Game1.game1 = this.gameBefore!;
        }
    }
}
