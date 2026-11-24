using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Netcode;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Network;
using StardewValley.Objects;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The pre-attachment Givens that <c>put_item_in_fish_tank</c> and <c>place_item_on_pedestal</c> never had: one EMPTY
/// <c>FishTankFurniture</c> standing in a room, one EMPTY <c>ItemPedestal</c> standing on a Farm tile.
///
/// <para>
/// WHY THIS SUITE EXISTS. Both actions sat in the catalogue with a complete descriptor, a named native binding and no
/// fixture in the tree that could hold the thing they act on, so neither had a world to run in and neither could ever be
/// live-verified. The missing fact was never an id or a coordinate: it was a piece the ENGINE would accept on a real
/// tile that also starts empty - which is what these Givens establish, and what these tests hold them to.
/// </para>
///
/// <para>
/// WHAT IS ASSERTED, and why each half is needed. The engine's own collection holds the piece the action re-resolves
/// (<c>location.furniture</c> for a tank, <c>location.objects</c> for a pedestal), the piece is EMPTY - the deposit is the
/// action's result and pre-satisfying it would make the receipt unobservable - and production's own resolution
/// (<c>TryDescribeFishTank</c>/<c>TryDescribePedestal</c>) accepts it under the id the observation publishes. A fixture
/// that placed the right instance in the wrong collection would satisfy every other assertion here and hand the handler
/// <c>fish_tank_target_not_found</c>.
/// </para>
///
/// <para>
/// THE TWO RESOLVERS ARE PRIVATE SEAMS, reached the way this suite already reaches
/// <c>TryGetHarvestableBush</c>: they are the exact question the handler asks at its own gate and again at the moment of
/// the write, so asking anything else here would be a second, weaker copy of it.
/// </para>
/// </summary>
public sealed class PlacedDepositFixtureTests
{
    /// <summary>One of the game's fish tank ids, used only as an id: the identity builder hashes it.</summary>
    private const string TankItemId = "(F)2397";

    [Fact]
    public void FishTankGiven_PlacesAnEmptyTankTheActionResolves()
    {
        using var world = DepositFixtureWorld.Create();
        FishTankFurniture tank = world.NewFishTank();
        Point needed = world.RoomNeeded[0];

        (Vector2 Tile, Vector2 Standing) spot =
            ModEntry.FindEmptyFishTankSpot(world.Room, world.Actor, tank, world.RoomNeeded);
        tank.canBePlacedHere(world.Room, spot.Tile).Should().BeTrue(
            $"the tile the Given chose must be one the ENGINE's own placement rule accepts ({spot.Tile.X},{spot.Tile.Y})");
        world.PlaceTank(tank, spot.Tile);
        world.StandAt(spot.Standing);

        Point tile = new((int)tank.TileLocation.X, (int)tank.TileLocation.Y);
        world.Room.furniture.Should().Contain(tank, "a tank lives in location.furniture and nowhere else");
        tank.heldItems.Should().BeEmpty("the deposit is the action's result, not the Given's");
        tile.Should().NotBe(world.Actor.TilePoint, "no Given may stand a solid piece on the tile the actor occupies");
        tank.IsCloseEnoughToFarmer(world.Actor).Should().BeTrue(
            $"the standing tile the Given chose must be inside the tank's own reach ({spot.Standing.X},{spot.Standing.Y} vs {tile.X},{tile.Y})");
        world.Footprint(tank, tile).Should().NotContain(needed,
            "a Given may not take the ground the room needs");
        PlaySessionFixturePlacement.TilesSeveredByPlacing(world.CanStand, world.Actor.TilePoint, tile, world.RoomNeeded)
            .Should().BeEmpty("placing the tank may not cut the room off from a tile it needs");

        string targetId = ExecutionManager.BuildPlacedFurnitureTargetId(world.Room, tile.X, tile.Y, tank);
        (bool resolved, object? described, string refusal) = world.DescribeFishTank(tile, targetId);
        resolved.Should().BeTrue($"the action's own resolution must find the tank it was handed: {refusal}");
        described.Should().BeSameAs(tank);
    }

    [Fact]
    public void PedestalGiven_PlacesAnEmptyPedestalTheActionResolves()
    {
        using var world = DepositFixtureWorld.Create();
        ItemPedestal pedestal = world.NewEmptyPedestal();

        (Vector2 Tile, Vector2 Standing) spot = ModEntry.FindEmptyPedestalSpot(world.Room, world.Actor, pedestal);
        world.Room.CanItemBePlacedHere(spot.Tile, itemIsPassable: false, CollisionMask.All, CollisionMask.None, useFarmerTile: true)
            .Should().BeTrue($"the tile the Given chose must be one the ENGINE's own placement rule accepts ({spot.Tile.X},{spot.Tile.Y})");
        world.PlacePedestal(pedestal, spot.Tile);
        world.StandAt(spot.Standing);

        Point tile = new((int)pedestal.TileLocation.X, (int)pedestal.TileLocation.Y);
        world.Room.objects.TryGetValue(new Vector2(tile.X, tile.Y), out StardewValley.Object? placed).Should().BeTrue();
        placed.Should().BeSameAs(pedestal, "a pedestal is an Object and lives in location.objects");
        pedestal.heldObject.Value.Should().BeNull("placing the item is the action's result, not the Given's");
        pedestal.locked.Value.Should().BeFalse("a locked pedestal refuses every deposit");
        PlaySessionFixturePlacement.WalkableExitCount(tile, world.CanStand).Should().Be(
            1, "a prop is placed on a dead end, so it can only ever cost the ground it already owns");
        Math.Max(Math.Abs(spot.Standing.X - tile.X), Math.Abs(spot.Standing.Y - tile.Y)).Should().Be(
            1, "the action admits a pedestal target only from a cardinal neighbour");

        string targetId = ExecutionManager.BuildPedestalDepositTargetId(world.Room, tile.X, tile.Y, pedestal);
        (bool resolved, object? described, string refusal) = world.DescribePedestal(tile, targetId);
        resolved.Should().BeTrue($"the action's own resolution must find the pedestal it was handed: {refusal}");
        described.Should().BeSameAs(pedestal);
    }

    /// <summary>
    /// A headless room with an open block, one dead-end spur, and a real actor. Both Givens are driven against the SAME
    /// room because the two questions they ask of it are the two shapes it must offer: ground wide enough to take a
    /// two-tile tank, and a tile no path crosses for the pedestal.
    ///
    /// <para>
    /// The tank and the pedestal are built uninitialised with their NetFields seeded: their public constructors reach
    /// <c>Data/Furniture</c> through <c>Furniture.InitializeAtTile</c> (Furniture.cs:309-344), and this process loads no
    /// content manager. Everything the FIXTURE does with them is real - the engine's placement predicate, the engine's
    /// collections, the reach test and the identity builders.
    /// </para>
    /// </summary>
    private sealed class DepositFixtureWorld : IDisposable
    {
        private const long ActorId = 1001;
        private const int PackCapacity = 36;
        private const int MapSize = 16;

        /// <summary>The open ground a tank may stand on: six tiles each way.</summary>
        private const int RoomMinimum = 2;

        private const int RoomMaximum = 7;

        /// <summary>One tile reached only from the room, so the pedestal Given has a dead end to place on.</summary>
        private static readonly Point Spur = new(RoomMaximum + 1, RoomMaximum);

        private static readonly FieldInfo WorldReadyPerScreen = typeof(Context)
            .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
            .GetGetMethod()!
            .Module.ResolveField(BitConverter.ToInt32(typeof(Context)
                .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
                .GetGetMethod()!.GetMethodBody()!.GetILAsByteArray()!, 1))!;

        private readonly Dictionary<string, object?> staticsBefore;

        internal GameLocation Room { get; }

        internal Farmer Actor { get; }

        /// <summary>The tile the room must keep reachable: the far corner of the open ground.</summary>
        internal IReadOnlyList<Point> RoomNeeded { get; }

        private DepositFixtureWorld()
        {
            this.staticsBefore = HeadlessGameWorld.CaptureStatics();

            Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, root);
            Game1.random ??= new Random(1);
            Game1.otherFarmers ??= new NetRootDictionary<long, Farmer>();
            Game1.hudMessages ??= new List<HUDMessage>();
            var options = (Options)FormatterServices.GetUninitializedObject(typeof(Options));
            SetField(options, "gamepadControls", false);
            SetField(options, "rumble", false);
            Game1.options ??= options;
            if (Game1.game1!._locations is null) Game1.game1._locations = new List<GameLocation>();
            Game1.locationContextData = new Dictionary<string, StardewValley.GameData.LocationContexts.LocationContextData>(StringComparer.Ordinal);
            Game1.netWorldState.Value.GetWeatherForLocation("Default");
            Game1.locationContextData["Default"] = new StardewValley.GameData.LocationContexts.LocationContextData();
            // `Furniture.removeLights` is reached from `OnAdded` -> `minutesElapsed` for a TANK specifically, and its own
            // light bookkeeping walks the game's shared light book. `Game1.currentLightSources` is a plain static the
            // game assigns at startup (Game1.cs:2254), so an uninitialized `Game1` leaves it null and the insert of a
            // tank throws from inside the engine rather than from this fixture.
            Game1.currentLightSources ??= new Dictionary<string, LightSource>();
            // Daylight: `Furniture.OnAdded` -> `minutesElapsed` -> `timeToTurnOnLights()` (Furniture.cs:1112-1126) takes the
            // removal branch in the day, which is the branch a room also takes on every morning.
            Game1.timeOfDay = 2200;

            var room = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(MapSize, MapSize), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(MapSize, MapSize), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Front", map, new xTile.Dimensions.Size(MapSize, MapSize), new xTile.Dimensions.Size(64, 64)));
            var sheet = new xTile.Tiles.TileSheet(
                "probe", map, "Maps/probe", new xTile.Dimensions.Size(64, 64), new xTile.Dimensions.Size(16, 16));
            map.AddTileSheet(sheet);
            xTile.Layers.Layer back = map.GetLayer("Back");
            xTile.Layers.Layer buildings = map.GetLayer("Buildings");
            for (int tileX = 0; tileX < MapSize; tileX++)
            {
                for (int tileY = 0; tileY < MapSize; tileY++)
                {
                    back.Tiles[tileX, tileY] = new xTile.Tiles.StaticTile(back, sheet, xTile.Tiles.BlendMode.Alpha, 0);
                    // A Buildings tile with neither `Shadow` nor `Passable` is what `isTilePassable` calls a wall
                    // (GameLocation.cs:2898-2911), which is the only fact this room needs to have a shape.
                    if (IsOpenGround(tileX, tileY)) continue;
                    buildings.Tiles[tileX, tileY] = new xTile.Tiles.StaticTile(buildings, sheet, xTile.Tiles.BlendMode.Alpha, 0);
                }
            }
            room.map = map;
            room.IsOutdoors = false;
            SetField(room, "name", new NetString("ProbeRoom"));
            SeedMissingNetFields(room);
            this.Room = room;
            this.RoomNeeded = new[] { new Point(RoomMinimum, RoomMinimum) };

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            SetField(sprite, "spriteWidth", new NetInt(16));
            SetField(sprite, "spriteHeight", new NetInt(32));
            SetField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            SetField(actor, "uniqueMultiplayerID", new NetLong(ActorId));
            SetField(actor, "netStamina", new NetFloat(270f));
            SetField(actor, "usingTool", new NetBool(false));
            SetField(actor, "toolPower", new NetInt(0));
            SetField(actor, "temporaryItem", new NetRef<Item>());
            SetField(actor, "currentToolIndex", new NetInt(0));
            SetField(actor, "netItemStowed", new NetBool(false));
            SetField(actor, "facingDirection", new NetDirection(2));
            SetField(actor, "isSitting", new NetBool(false));
            SetField(actor, "movementDirections", new List<int>());
            SetField(actor, "friendshipData", new NetStringDictionary<Friendship, NetRef<Friendship>>());
            SetField(actor, "stats", new Stats());
            SetField(actor, "mailReceived", new NetStringHashSet());
            SetField(actor, "temporaryPassableTiles", new StardewValley.Util.BoundingBoxGroup());
            var team = (FarmerTeam)FormatterServices.GetUninitializedObject(typeof(FarmerTeam));
            SeedMissingNetFields(team);
            SetField(actor, "teamRoot", new NetRoot<FarmerTeam> { Value = team });
            var buffs = new StardewValley.Buffs.BuffManager();
            typeof(StardewValley.Buffs.BuffManager)
                .GetField("CombinedEffects", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(buffs, new StardewValley.Buffs.BuffEffects());
            buffs.Dirty = false;
            SetField(actor, "buffs", buffs);
            typeof(Farmer).GetField("canMove", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, true);
            var pack = new StardewValley.Inventories.Inventory();
            for (int slot = 0; slot < PackCapacity; slot++) pack.Add(null!);
            SetField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = pack });
            SetField(actor, "maxItems", new NetInt(PackCapacity));
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);
            actor.currentLocation = room;
            this.Actor = actor;
            this.StandAt(new Vector2(RoomMaximum, RoomMaximum));

            WorldReadyPerScreen.GetValue(null)!.GetType()
                .GetMethod("SetValueForScreen", new[] { typeof(int), typeof(bool) })!
                .Invoke(WorldReadyPerScreen.GetValue(null), new object[] { Context.ScreenId, true });
            Context.IsWorldReady.Should().BeTrue("the headless world must satisfy the readiness gate the body checks");
        }

        internal static DepositFixtureWorld Create() => new();

        internal void StandAt(Vector2 tile) => this.Actor.position.Set(new Vector2(tile.X * 64f + 8f, tile.Y * 64f));

        /// <summary>"A body may stand here": the room's own answer, with everything the fixture placed excluded.</summary>
        internal bool CanStand(Point tile)
        {
            Vector2 spot = new(tile.X, tile.Y);
            return this.Room.isTileOnMap(spot)
                && !this.Room.objects.ContainsKey(spot)
                && this.Room.isTilePassable(spot)
                && !this.Room.furniture.Any(piece => this.Footprint(piece, new Point((int)piece.TileLocation.X, (int)piece.TileLocation.Y)).Contains(tile));
        }

        /// <summary>
        /// The placement half of the tank Given: set the piece's tile and let the engine's own collection take it.
        ///
        /// <para>
        /// THE ENGINE'S HOOK IS TOLERATED HERE, ONCE, AND ONLY WHEN THE PIECE REALLY LANDED. <c>furniture.Add</c> fires
        /// <c>GameLocation</c>'s own <c>OnValueAdded</c>, which calls <c>Furniture.OnAdded</c> -> <c>minutesElapsed</c> ->
        /// the tank's light branch, and both of those branches build a <c>LightSource</c> with texture index 8, whose
        /// constructor loads <c>LooseSprites/Lighting/fishTankLight</c> through the content manager
        /// (LightSource.cs:167-169). This process has no content manager, so that load is the one thing a headless world
        /// cannot supply - measured as a NullReferenceException from <c>Furniture.addLights</c>/<c>removeLights</c>, in
        /// whichever branch the clock selects. The INSERT ITSELF COMPLETES BEFORE THE HOOK RUNS (<c>NetDictionary.added</c>
        /// fires with the entry already in the map), so the failure is swallowed only when the collection really holds the
        /// piece; an insert that did not land still throws, because then the Given would be lying about the world.
        /// </para>
        /// </summary>
        internal void PlaceTank(FishTankFurniture tank, Vector2 tile)
        {
            tank.TileLocation = tile;
            try
            {
                this.Room.furniture.Add(tank);
            }
            catch (NullReferenceException) when (this.Room.furniture.Contains(tank))
            {
                // The texture load described above; the piece is already in the room, which the filter re-asks.
            }
        }

        /// <summary>The placement half of the pedestal Given, on the same terms.</summary>
        internal void PlacePedestal(ItemPedestal pedestal, Vector2 tile)
        {
            pedestal.TileLocation = tile;
            this.Room.objects.Add(tile, pedestal);
        }

        internal IReadOnlyList<Point> Footprint(Furniture piece, Point origin) =>
            Enumerable.Range(0, piece.getTilesWide())
                .SelectMany(offsetX => Enumerable.Range(0, piece.getTilesHigh())
                    .Select(offsetY => new Point(origin.X + offsetX, origin.Y + offsetY)))
                .ToList();

        /// <summary>
        /// A real <see cref="FishTankFurniture"/>, two tiles wide: its own capacity is <c>getTilesWide() - 1</c> per
        /// category (FishTankFurniture.cs:117-139), so a one-wide tank could hold nothing and the deposit this fixture
        /// exists for would be impossible.
        /// </summary>
        internal FishTankFurniture NewFishTank()
        {
            var tank = (FishTankFurniture)FormatterServices.GetUninitializedObject(typeof(FishTankFurniture));
            SeedMissingNetFields(tank);
            SetField(tank, "itemId", new NetString(TankItemId[3..]));
            SetField(tank, "netName", new NetString("Fish Tank"));
            SetField(tank, "stack", new NetInt(1));
            SetField(tank, "parentSheetIndex", new NetInt(int.Parse(TankItemId[3..], System.Globalization.CultureInfo.InvariantCulture)));
            SetField(tank, "tileLocation", new NetVector2());
            SetField(tank, "boundingBox", new NetRectangle { Value = new Rectangle(0, 0, 128, 64) });
            SetField(tank, "defaultBoundingBox", new NetRectangle { Value = new Rectangle(0, 0, 128, 64) });
            SetField(tank, "heldObject", new NetRef<StardewValley.Object>());
            SetField(tank, "fragility", new NetInt(0));
            SetField(tank, "furniture_type", new NetInt(0));
            SetField(tank, "rotations", new NetInt(1));
            SetField(tank, "currentRotation", new NetInt(0));
            SetField(tank, "mutex", new NetMutex());
            SetField(tank, "localDepositedItem", null!);
            SetField(tank, "sittingFarmers", new NetLongDictionary<int, NetInt>());
            SeedPlainCollections(tank);
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(tank, TankItemId);
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(tank, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(tank, false);
            typeof(Furniture).GetField("_placementRestriction", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(tank, 0);
            tank.HasBeenInInventory = true;
            return tank;
        }

        /// <summary>A real <see cref="ItemPedestal"/> holding nothing, which is the state its deposit branch needs.</summary>
        internal ItemPedestal NewEmptyPedestal()
        {
            var pedestal = (ItemPedestal)FormatterServices.GetUninitializedObject(typeof(ItemPedestal));
            SeedMissingNetFields(pedestal);
            SetField(pedestal, "itemId", new NetString("221"));
            SetField(pedestal, "netName", new NetString("Item Pedestal"));
            SetField(pedestal, "stack", new NetInt(1));
            SetField(pedestal, "parentSheetIndex", new NetInt(221));
            SetField(pedestal, "tileLocation", new NetVector2());
            SetField(pedestal, "boundingBox", new NetRectangle { Value = new Rectangle(0, 0, 64, 64) });
            SetField(pedestal, "heldObject", new NetRef<StardewValley.Object>());
            SetField(pedestal, "fragility", new NetInt(0));
            SetField(pedestal, "bigCraftable", new NetBool(true));
            SetField(pedestal, "itemModifyMutex", new NetMutex());
            SetField(pedestal, "requiredItem", new NetRef<StardewValley.Object>());
            SetField(pedestal, "successColor", new NetColor());
            SetField(pedestal, "lockOnSuccess", new NetBool(false));
            SetField(pedestal, "locked", new NetBool(false));
            SetField(pedestal, "match", new NetBool(false));
            SetField(pedestal, "isIslandShrinePedestal", new NetBool(false));
            SetField(pedestal, "type", new NetString("Crafting"));
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(pedestal, "(BC)221");
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(pedestal, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(pedestal, false);
            return pedestal;
        }

        /// <summary>
        /// The handler's own tank resolution, asked through the private seam it uses at its gate and again at the moment
        /// of the write: same location, same tile, same published id.
        /// </summary>
        internal (bool Resolved, object? Described, string Refusal) DescribeFishTank(Point tile, string targetId)
        {
            MethodInfo method = typeof(ExecutionManager)
                .GetMethod("TryDescribeFishTank", BindingFlags.NonPublic | BindingFlags.Static)!;
            object?[] arguments = { this.Room, tile.X, tile.Y, targetId, null, null, null };
            bool resolved = (bool)method.Invoke(null, arguments)!;
            return (resolved, arguments[4], resolved ? "accepted" : $"{arguments[5]}:{arguments[6]}");
        }

        /// <summary>The handler's own pedestal resolution, on the same terms.</summary>
        internal (bool Resolved, object? Described, string Refusal) DescribePedestal(Point tile, string targetId)
        {
            MethodInfo method = typeof(ExecutionManager)
                .GetMethod("TryDescribePedestal", BindingFlags.NonPublic | BindingFlags.Static)!;
            object?[] arguments = { this.Room, tile.X, tile.Y, targetId, null, null, null, null };
            bool resolved = (bool)method.Invoke(null, arguments)!;
            return (resolved, arguments[4], resolved ? "accepted" : $"{arguments[5]}:{arguments[7]}");
        }

        private static bool IsOpenGround(int tileX, int tileY) =>
            Spur == new Point(tileX, tileY)
            || (tileX >= RoomMinimum && tileX <= RoomMaximum && tileY >= RoomMinimum && tileY <= RoomMaximum);

        private static void SeedPlainCollections(object instance)
        {
            foreach (FieldInfo field in instance.GetType().GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            {
                if (field.GetValue(instance) is not null) continue;
                if (!field.FieldType.IsGenericType) continue;
                Type definition = field.FieldType.GetGenericTypeDefinition();
                if (definition != typeof(List<>) && definition != typeof(Dictionary<,>)) continue;
                if (field.FieldType.GetConstructor(Type.EmptyTypes) is null) continue;
                field.SetValue(instance, Activator.CreateInstance(field.FieldType));
            }
        }

        private static void SeedMissingNetFields(object instance)
        {
            foreach (FieldInfo field in instance.GetType().GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            {
                if (field.FieldType.Namespace is null || !field.FieldType.Namespace.StartsWith("Netcode", StringComparison.Ordinal)) continue;
                if (field.GetValue(instance) is not null) continue;
                if (field.FieldType.GetConstructor(Type.EmptyTypes) is null) continue;
                field.SetValue(instance, Activator.CreateInstance(field.FieldType)!);
            }
            if (instance is not Item item) return;
            FieldInfo? backing = typeof(Item).GetField("<NetFields>k__BackingField", BindingFlags.Instance | BindingFlags.NonPublic);
            if (backing is not null && backing.GetValue(item) is null) backing.SetValue(item, new NetFields("Item"));
        }

        private static void SetField(object target, string name, object value)
        {
            FieldInfo? field = target.GetType().GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (field is null) throw new InvalidOperationException($"{target.GetType().Name} has no field {name}");
            field.SetValue(target, value);
        }

        public void Dispose()
        {
            WorldReadyPerScreen.GetValue(null)!.GetType().GetMethod("ResetAllScreens")!
                .Invoke(WorldReadyPerScreen.GetValue(null), null);
            HeadlessGameWorld.RestoreStatics(this.staticsBefore);
        }
    }
}
