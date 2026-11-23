using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.GameData.Shops;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The hour a shop opens is part of the OBSERVATION, not something the door teaches her.
///
/// <para>
/// MEASURED `round96` (and again in `round97`): a companion walked to Pierre's door before nine, was refused
/// <c>door_gate_refused</c> twice, and the receipt's own words were the engine's sign -
/// 「上锁了……（营业时间：9:00~21:00）」. The sentence existed in the GAME and not in her world: `doorTargets` published
/// the tile, `shopTargets` published the counter and its stock, and no field anywhere carried the hour. A companion that
/// walks to a locked shop at eight has been given a map with no clock on it.
/// </para>
///
/// <para>
/// So the two families that NAME a shop publish the window the world declares for it, in the engine's own 24h minutes:
/// a door carries <c>LockedDoorWarp</c>'s own two numbers from the tile's Buildings-layer <c>Action</c>
/// (GameLocation.cs:9537-9544, the same tokens <c>lockedDoorWarp</c> quotes back at :10362-10368), and a counter carries
/// the <c>TIME</c> clause of the entry that runs it out of <c>Data/Shops</c>. The cases below drive the production
/// readers against a real <see cref="GameLocation"/>, so the numbers asserted here are the ones the game would read -
/// not a schedule restated in C#.
/// </para>
///
/// <para>
/// WHAT IS DELIBERATELY ABSENT IS ASSERTED TOO. A doorway that declares no hours publishes no window (a plain warp is
/// not "not measured"), and a tile that declares one whose numbers cannot be read publishes
/// <c>declared_window_unreadable</c> instead of a guessed hour - because a wrong hour is worse than none.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class ShopHoursPublishedBeforeTheWalkTests
{
    /// <summary>
    /// `LockedDoorWarp`'s window, in the engine's own token order
    /// (`LockedDoorWarp &lt;x&gt; &lt;y&gt; &lt;location&gt; &lt;openTime&gt; &lt;closeTime&gt;`, GameLocation.cs:9539) -
    /// the exact tile `round96` walked into, and the exact pair its refusal quoted.
    /// </summary>
    private const string SeedShopDoorAction = "LockedDoorWarp 9 12 SeedShop 900 2100";

    /// <summary>
    /// The defect, as a case: the door row she holds at 08:00 states the hour, in the world's own numbers.
    /// </summary>
    [Fact]
    public void ADoorThatOpensAtNinePublishesThatHourOnItsRow()
    {
        using DoorWorld world = DoorWorld.Create();
        world.SetDoorAction(9, 12, SeedShopDoorAction);
        world.Location.warps.Add(new Warp(9, 12, "SeedShop", 3, 11, flipFarmer: false));

        IReadOnlyList<BridgeDoor> doors = FarmhandTargetDiscovery.DiscoverDoorTargets(Game1.player);

        doors.Should().ContainSingle("one doorway was drawn and one warp leads out of it")
            .Which.Should().Be(
                new BridgeDoor(9, 12, "SeedShop", 3, 11, OpensAt: 900, ClosesAt: 2100),
                "the row must carry the window the map declares, so the hour arrives with the door");
    }

    /// <summary>
    /// ⛔ THE ROUND96 RED PROOF. Two arrivals, one published row: 08:00 is before the window opens, 09:30 is inside it -
    /// so the walk that produced two refusals is a fact she could have read before taking it, and a legitimate late
    /// arrival still goes through.
    ///
    /// <para>
    /// The clock is <c>Game1.timeOfDay</c>'s own (<c>800</c>, <c>930</c>, <c>2100</c>), which is why this case does not
    /// spell the hours as decimal minutes: the engine's unit is the one the row carries.
    /// </para>
    /// <para>
    /// The comparison is the engine's own (<c>now &gt;= openTime &amp;&amp; now &lt; closeTime</c>, GameLocation.cs:10348);
    /// <c>EnterExitDoorGateTests.DriftAnchors_ResolvedWarpHasNoGate_AndTheGateLivesInTheClickEntry</c> pins that
    /// expression against the decompiled source, so this case is anchored to it rather than restating an idea of what
    /// locks a door.
    /// </para>
    /// </summary>
    [Fact]
    public void TheEightOClockArrivalIsUnreachableFromThePublishedRowAndTheLateOneIsNot()
    {
        using DoorWorld world = DoorWorld.Create();
        world.SetDoorAction(9, 12, SeedShopDoorAction);
        world.Location.warps.Add(new Warp(9, 12, "SeedShop", 3, 11, flipFarmer: false));

        BridgeDoor door = FarmhandTargetDiscovery.DiscoverDoorTargets(Game1.player).Single();

        WindowAdmits(door, 800).Should().BeFalse(
            "08:00 is before the published opening hour, so the two door_gate_refused receipts of round96 are now a fact the observation states");
        WindowAdmits(door, 930).Should().BeTrue(
            "09:30 is inside the same window - a legitimate late arrival must still be admitted, or the field would have been bought with a false refusal");
        WindowAdmits(door, 2100).Should().BeFalse(
            "21:00 is the closing edge, exclusive: `Game1.timeOfDay < closeTime` is the engine's own comparison");
    }

    /// <summary>
    /// A doorway that declares NO hours publishes none of the three - and that absence is a fact about the world, not a
    /// "not measured": the engine has no gate on a plain warp either.
    /// </summary>
    [Fact]
    public void ADoorwayWithNoDeclaredHoursPublishesNoWindow()
    {
        using DoorWorld world = DoorWorld.Create();
        world.Location.warps.Add(new Warp(6, 12, "Farm", 64, 15, flipFarmer: false));

        BridgeDoor door = FarmhandTargetDiscovery.DiscoverDoorTargets(Game1.player).Single();

        door.OpensAt.Should().BeNull();
        door.ClosesAt.Should().BeNull("a window is a pair or it is nothing");
        door.HoursUnknown.Should().BeNull("this doorway declares no schedule at all, so nothing is owed");
    }

    /// <summary>
    /// ⛔ `not_measured` OVER A GUESS: the tile says it closes on a schedule and the numbers are unreadable, so the row
    /// says the hour is MISSING rather than printing a window the Mod invented.
    /// </summary>
    [Fact]
    public void ADoorWhoseDeclaredHoursCannotBeReadSaysSoInsteadOfGuessing()
    {
        using DoorWorld world = DoorWorld.Create();
        world.SetDoorAction(9, 12, "LockedDoorWarp 9 12 SeedShop morning evening");
        world.Location.warps.Add(new Warp(9, 12, "SeedShop", 3, 11, flipFarmer: false));

        BridgeDoor door = FarmhandTargetDiscovery.DiscoverDoorTargets(Game1.player).Single();

        door.OpensAt.Should().BeNull();
        door.ClosesAt.Should().BeNull();
        door.HoursUnknown.Should().Be("declared_window_unreadable");
    }

    /// <summary>
    /// The counter half: the window comes out of the entry that RUNS the counter, in the engine's own minutes - the same
    /// <c>TIME</c> query <c>ShopBuilder.GetCurrentOwners</c> evaluates.
    /// </summary>
    [Fact]
    public void AShopCounterPublishesTheWindowItsOwnOwnerEntryDeclares()
    {
        ExecutionManager.DeclaredOwnerWindow(new ShopOwnerData { Name = "Pierre", Condition = "TIME 900 1600" })
            .Should().Be((900, 1600), "`TIME 900 1600` is the engine's query, and its two arguments are the bounds");

        ExecutionManager.DeclaredOwnerWindow(new ShopOwnerData { Name = "Pierre" }).Should().BeNull(
            "an entry that declares no hours is not a guessed all-day window");
        ExecutionManager.DeclaredOwnerWindow(null).Should().BeNull();
    }

    /// <summary>
    /// ⛔ The spellings this reader must NOT interpret: a negated clause is the SHUT entry's query, and a window mixed
    /// with a day or season clause is a schedule whose meaning would have to be guessed. Both publish the not-measured
    /// reason instead of an hour.
    /// </summary>
    [Fact]
    public void AWindowTheReaderCannotStateBecomesTheNotMeasuredReason()
    {
        var closedEntry = new ShopOwnerData
        {
            Name = "Pierre",
            Condition = "!TIME 900 1600",
            ClosedMessage = "Closed",
        };
        ExecutionManager.DeclaredOwnerWindow(closedEntry).Should().BeNull(
            "a ClosedMessage entry states when the counter is SHUT; reading its numbers as an open window inverts the gate");
        ExecutionManager.OwnerWindowUnknown(closedEntry).Should().BeNull(
            "and the row it would produce already says the shop is closed - there is no hour owed");

        var mixed = new ShopOwnerData { Name = "Pierre", Condition = "TIME 900 1600,DAY_OF_WEEK Mon Tue" };
        ExecutionManager.DeclaredOwnerWindow(mixed).Should().BeNull();
        ExecutionManager.OwnerWindowUnknown(mixed).Should().Be(
            "declared_window_unreadable",
            "the entry DOES declare a window; this reader could not state it, and the difference must reach the row");
    }

    /// <summary>
    /// The engine's own admission comparison for a `LockedDoorWarp` (GameLocation.cs:10348): `now &gt;= openTime &amp;&amp;
    /// now &lt; closeTime`. Read off the PUBLISHED row, which is the whole point - the numbers a reader holds are the ones
    /// the gate compares.
    /// </summary>
    private static bool WindowAdmits(BridgeDoor door, int timeOfDay) =>
        door.OpensAt is { } opens && door.ClosesAt is { } closes && timeOfDay >= opens && timeOfDay < closes;

    // ---------------------------------------------------------------------------------------------------------

    /// <summary>
    /// A real <see cref="GameLocation"/> with a Buildings layer, a real <see cref="Farmer"/> bound to it as
    /// <c>Game1.player</c>, and the <c>Game1</c> statics the engine dereferences - the shape
    /// <c>DoorTargetsInteriorExitTests.DoorWorld</c> established, copied here because the two files assert different
    /// families and a shared fixture would have to own both.
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
            SetField(location, "name", new NetString("Town"));
            world.Location = location;

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = new StardewValley.Inventories.Inventory() });
            actor.position.Set(new Vector2(10 * 64 + 8, 12 * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);
            HeadlessGameWorld.RequireBound(actor, location);

            return world;
        }

        /// <summary>
        /// One drawn doorway: the <c>Buildings</c> layer's <c>Action</c> property, which is what <c>updateDoors</c>
        /// admits (GameLocation.cs:17601) and where `LockedDoorWarp` keeps its window.
        /// </summary>
        public void SetDoorAction(int x, int y, string action)
        {
            xTile.Layers.Layer buildings = this.Location.map!.GetLayer("Buildings");
            if (buildings.Tiles[x, y] is null)
            {
                var sheet = new xTile.Tiles.TileSheet(this.Location.map, "door", new xTile.Dimensions.Size(64, 64), new xTile.Dimensions.Size(1, 1));
                this.Location.map.AddTileSheet(sheet);
                buildings.Tiles[x, y] = new xTile.Tiles.StaticTile(buildings, sheet, xTile.Tiles.BlendMode.Alpha, 0);
            }

            buildings.Tiles[x, y].Properties["Action"] = action;
        }

        private static void SetField(object target, string name, object value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);

        public void Dispose() => HeadlessGameWorld.RestoreStatics(this.statics);
    }
}
