using System;
using System.Collections.Generic;
using System.Linq;
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
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The gate for one class of defect: a transition whose SOURCE cell is not a place a body stands - a door in a wall,
/// or an edge exit whose source is outside the map - was approached by probing the four tiles around that source, and
/// the probe answered `off_map`/`blocked` three times and refused the whole navigation. Measured `round77`:
/// six <c>navigation_approach_unavailable</c> on already-approved <c>navigate_to_destination</c> requests, among them
///
/// <list type="bullet">
/// <item><c>approaches=north:off_map,east:off_map,south:unreachable,west:off_map;approach_blocked_by:unreachable_ground@40,0</c>
/// - the Farm's north edge exit, whose source is <c>40,-1</c> and whose entry cell is <c>40,0</c>;</item>
/// <item><c>approaches=north:off_map,east:off_map,south:off_map,west:large:Bush@49,10;approach_blocked_by:large:Bush@49,10</c>
/// - the Backwoods' east edge exit at <c>50,10</c> on a 50-wide map, with the one cell in front of it occupied.</item>
/// </list>
///
/// <para>
/// The population is not a list here: <see cref="Game1NavigationWorldSource.DoorLegs"/> answers with the door legs the
/// topology's own enumeration produced for the world, so a door that starts or stops being an edge changes the
/// examined set on its own. Each door must either be approached from a tile a body can stand on, one step from the
/// door on the side the door faces, or be refused with the entry cell and its occupant named. A door that answers
/// neither is SILENT, and this gate fails naming it.
/// </para>
///
/// <para>
/// The world is real: a location whose two map layers the engine's collision test reads, real door-table entries
/// resolved by <c>GameLocation.getWarpFromDoor</c> from a Buildings-layer <c>Action</c> tile, real terrain features,
/// and a real <c>Farmer</c> with its 48x32 box - the shape <c>ApproachRingAgreementTests</c> established.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class DoorApproachSideGateTests
{
    private readonly ITestOutputHelper output;

    public DoorApproachSideGateTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>
    /// The gate itself: every door the topology enumerates is approached from the side it faces, or refused with the
    /// cell and the occupant that keeps the body off it. The two halves are both present on purpose - a suite that only
    /// had the successful half would pass for a Mod that refused nothing because it approached everything.
    /// </summary>
    [Fact]
    public void ADoorIsApproachedFromTheSideItFaces()
    {
        using ApproachWorld world = ApproachWorld.Create(width: 16, height: 16, actorTile: new Point(9, 8));
        // A door in a wall whose facing cell is free ground: three faces inside the wall, the south face outside it.
        world.AddMapDoor(6, 4, "Mine", 10, 4);
        world.AddWall(6, 3);
        world.AddWall(5, 4);
        world.AddWall(7, 4);
        // A door whose facing cell is taken by something the game itself clears: the door is enterable the moment
        // that tile is freed, so the refusal has to name the tile and the thing on it.
        world.AddMapDoor(12, 4, "Mine", 11, 4);
        world.AddWall(12, 3);
        world.AddWall(11, 4);
        world.AddWall(13, 4);
        world.PlacePricedBoulder(12, 5);

        IReadOnlyList<NavigationTransitionLeg> doors = Game1NavigationWorldSource.DoorLegs(world.Location);

        doors.Select(door => (door.SourceX, door.SourceY)).Should().Equal(
            new[] { (6, 4), (12, 4) },
            "the population is the door table this location declares, read through the topology's own enumeration");
        doors.Should().OnlyContain(door => door.IsDoor, "the population is the door family, not every leg");

        int approached = 0;
        int refused = 0;
        int silent = 0;
        var silentDoors = new List<string>();
        foreach (NavigationTransitionLeg door in doors)
        {
            Vector2? approach = world.Manager.SelectSafeApproachTarget(door, out StardewBodyController.CardinalRing? ring);
            string entry = ExecutionManager.DescribeTransitionEntry(door);
            string named = $"{door.SourceX},{door.SourceY}->{door.TargetLocation}";

            if (approach is { } tile)
            {
                approached++;
                Vector2 facing = ExecutionManager.TransitionEntryCell(world.Location, door)!.Value;
                tile.Should().Be(facing, $"{named} is entered from the side it faces");
                Math.Max(Math.Abs(tile.X - door.SourceX), Math.Abs(tile.Y - door.SourceY)).Should().Be(1,
                    $"{named} is entered from one step away, which is the range every door in the game is opened from");
                StardewBodyController.IsStandableTile(world.Location, Game1.player, tile).Should().BeTrue(
                    $"{named} may only be approached over ground a body can stand on");
                continue;
            }

            ring.Should().NotBeNull($"a refused {named} must carry the ring it decided on");
            if (entry.Contains("entry_blocked_by", StringComparison.Ordinal))
            {
                refused++;
                continue;
            }

            silent++;
            silentDoors.Add(named);
        }

        this.output.WriteLine(
            $"a_door_is_approached_from_the_side_it_faces: doors examined {doors.Count} · approached {approached} · "
            + $"refused-with-a-reason {refused} · silent {silent}");

        silentDoors.Should().BeEmpty($"a door with no approach and no named blocker leaves a reader with nothing: {string.Join("|", silentDoors)}");
        approached.Should().Be(1, "the door whose facing cell is free ground is approached, not refused");
        refused.Should().Be(1, "the door whose facing cell is occupied is refused naming that cell");
    }

    /// <summary>
    /// The first live string, replayed: the Farm's north edge exit. Its source is <c>40,-1</c>, so the probe sees two
    /// off-map faces, an off-map side face and the one in-map cell - which `round77` read as <c>unreachable</c> because
    /// the corridor was not walkable-to in that frame, and the navigation was rejected instead of walked.
    ///
    /// RED BEFORE THE FIX: <c>approach=unavailable</c> with the ring's own four faces and nothing that says the
    /// transition is entered from <c>40,0</c>.
    /// </summary>
    [Fact]
    public void TheFarmNorthEdgeExit_IsEnteredFromTheCellInsideIt()
    {
        using ApproachWorld world = ApproachWorld.Create(width: 41, height: 16, actorTile: new Point(20, 3));
        world.WallRow(1);
        var leg = new NavigationTransitionLeg("Backwoods", 40, -1, 14, 39, IsDoor: false);

        Vector2? approach = world.Manager.SelectSafeApproachTarget(leg, out StardewBodyController.CardinalRing? ring);

        ring!.Evidence.Should().Be(
            "north:off_map,east:off_map,south:unreachable,west:off_map",
            "the replay is the live world: the same four faces `round77` published for this exit");
        ring.BlockedBy.Should().Be("unreachable_ground@40,0");
        approach.Should().Be(new Vector2(40f, 0f),
            "the exit is entered from the in-map cell on the same column, whatever the component flood says about it");
        ExecutionManager.DescribeTransitionEntry(leg).Should().Be(";entry=40,0");
    }

    /// <summary>
    /// The second live string, replayed: the Backwoods' east edge exit at <c>50,10</c> on a 50-wide map, with a Bush on
    /// the one cell in front of it. No cell exists to walk to, so the answer cannot be an approach - what it owes the
    /// reader is which tile the transition is entered from and what stands on it, which the ring's direction words
    /// never said.
    ///
    /// RED BEFORE THE FIX: <c>approaches=north:off_map,east:off_map,south:off_map,west:large:Bush@49,10</c> and no
    /// statement about <c>entry</c> at all.
    /// </summary>
    [Fact]
    public void TheBackwoodsEastEdgeExit_NamesTheEntryCellAndItsOccupant()
    {
        using ApproachWorld world = ApproachWorld.Create(width: 50, height: 11, actorTile: new Point(46, 9));
        world.PlaceBush(49, 10);
        var leg = new NavigationTransitionLeg("Mountain", 50, 10, 30, 31, IsDoor: false);

        Vector2? approach = world.Manager.SelectSafeApproachTarget(leg, out StardewBodyController.CardinalRing? ring);

        ring!.Evidence.Should().Be(
            "north:off_map,east:off_map,south:off_map,west:large:Bush@49,10",
            "the replay is the live world: the Bush is on the only cell the east edge can be walked off from");
        approach.Should().BeNull("a Bush is not a tile a body stands on, so there is no approach to walk to this frame");
        ExecutionManager.DescribeTransitionEntry(leg).Should().Be(
            ";entry=49,10;entry_blocked_by:large:Bush@49,10",
            "the refusal names the cell the transition is entered from and the occupant the game's own tools remove");
    }

    /// <summary>
    /// A real location of the requested size, real door-table rows resolved by the engine's own
    /// <c>getWarpFromDoor</c> from Buildings-layer <c>Action</c> tiles, and a real farmer bound as <c>Game1.player</c>.
    /// Disposable because those statics are process-wide; restoring them on exit keeps the next class honest.
    /// </summary>
    private sealed class ApproachWorld : IDisposable
    {
        /// <summary>The boulder the native tool table prices as `rock` - a wall that CAN be cleared.</summary>
        private const int PricedBoulderIndex = 148;

        private readonly Dictionary<string, object?> statics;
        private readonly xTile.Tiles.TileSheet sheet;
        private int nextActionTileIndex;

        private ApproachWorld(int width, int height, Point actorTile)
        {
            this.statics = HeadlessGameWorld.CaptureStatics();
            Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, root);

            var location = new GameLocation();
            var map = new xTile.Map();
            var size = new xTile.Dimensions.Size(width, height);
            map.AddLayer(new xTile.Layers.Layer("Back", map, size, new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, size, new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Front", map, size, new xTile.Dimensions.Size(64, 64)));
            // One tilesheet, one tile index per door: a Tile's Action lives on the TILESHEET's per-index properties,
            // so two doors sharing an index would share one Action and one of them would stop resolving.
            this.sheet = new xTile.Tiles.TileSheet(map, "Maps/approach-gate", new xTile.Dimensions.Size(32, 1), new xTile.Dimensions.Size(16, 16));
            map.AddTileSheet(this.sheet);
            this.nextActionTileIndex = 1;
            location.map = map;
            location.IsFarm = true;
            SetField(location, "name", new NetString("ApproachGate"));
            this.Location = location;

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            SetField(sprite, "spriteWidth", new NetInt(16));
            SetField(sprite, "spriteHeight", new NetInt(32));
            SetField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
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
            typeof(Farmer).GetField("canMove", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, true);
            // The engine's own placement for a 32px-tall sprite: the box centres on the tile.
            actor.position.Set(new Vector2(actorTile.X * 64 + 8, actorTile.Y * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            FarmhandCapabilityPublication publication =
                FarmhandCapabilityPublication.Initial(new HashSet<string>(new[] { "navigate_to_destination" }));
            this.Manager = new ExecutionManager(new DummyMonitor(), () => publication);
            HeadlessGameWorld.RequireBound(actor, location);
        }

        public GameLocation Location { get; }

        /// <summary>The real ledger, with no native approach seam wired - the branch production runs.</summary>
        public ExecutionManager Manager { get; }

        public static ApproachWorld Create(int width, int height, Point actorTile) =>
            new(width, height, actorTile);

        /// <summary>
        /// One doorway the map drew: a Buildings-layer tile whose <c>Action</c> is the warp the engine resolves, plus
        /// the row <c>updateDoors</c> would have built from it. Both are what <c>EnumerateEdges</c> reads.
        /// </summary>
        public void AddMapDoor(int x, int y, string target, int targetX, int targetY)
        {
            string action = $"Warp {targetX} {targetY} {target}";
            xTile.Layers.Layer layer = this.Location.map.GetLayer("Buildings");
            var tile = new xTile.Tiles.StaticTile(layer, this.sheet, xTile.Tiles.BlendMode.Alpha, this.nextActionTileIndex++);
            tile.TileIndexProperties["Action"] = action;
            layer.Tiles[x, y] = tile;
            this.Location.doors[new Point(x, y)] = action;
        }

        /// <summary>A wall face: a Buildings tile with no property, which the engine will not walk through.</summary>
        public void AddWall(int x, int y)
        {
            xTile.Layers.Layer layer = this.Location.map.GetLayer("Buildings");
            layer.Tiles[x, y] = new xTile.Tiles.StaticTile(layer, this.sheet, xTile.Tiles.BlendMode.Alpha, 0);
        }

        /// <summary>One row of wall across the whole map, so the row above it is ground the actor cannot walk to.</summary>
        public void WallRow(int y)
        {
            for (int x = 0; x < this.Location.map.Layers[0].LayerWidth; x++)
                this.AddWall(x, y);
        }

        /// <summary>A boulder the native tool table prices, so the refusal's clearing word is the action that frees it.</summary>
        public void PlacePricedBoulder(int x, int y) =>
            this.Location.resourceClumps.Add(new StardewValley.TerrainFeatures.ResourceClump(PricedBoulderIndex, 1, 1, new Vector2(x, y)));

        /// <summary>A large terrain feature occupant - the `large:Bush@x,y` the live refusal named.</summary>
        public void PlaceBush(int x, int y)
        {
            // The parameterless constructor, because the placement one builds its sprite from the content pipeline:
            // `size` is what `getBoundingBox` reads, and one tile is the shape the live occupant had.
            var bush = new StardewValley.TerrainFeatures.Bush { Tile = new Vector2(x, y), Location = this.Location };
            bush.size.Value = 3;
            this.Location.largeTerrainFeatures.Add(bush);
        }

        private static void SetField(object target, string name, object value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);

        public void Dispose() => HeadlessGameWorld.RestoreStatics(this.statics);
    }
}
