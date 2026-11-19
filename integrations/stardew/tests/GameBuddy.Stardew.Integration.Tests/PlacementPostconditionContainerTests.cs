using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using StardewValley.Objects;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// <c>place_owned_object</c>'s postcondition, driven against a REAL room: the placed thing is read back from the
/// collection its own kind lands in.
///
/// <para>
/// THE DEFECT THIS PINS, measured 2026-11-19. The postcondition was judged from <c>location.objects</c>, and furniture
/// is not there: a placed piece is appended to <c>location.furniture</c> (<c>Object.cs:7041</c>, the location's own
/// <c>NetCollection&lt;Furniture&gt;</c>, GameLocation.cs:452). So a <c>furnish_and_arrange</c> day placed every piece
/// correctly and every receipt answered <c>place_owned_object_postcondition_unavailable</c>, and the day was refused
/// for a fact nothing stated: the tile the same piece came to rest on.
/// </para>
///
/// <para>
/// THE FALSIFIER. A piece stands in the room at the tile the native furniture branch leaves it on, and
/// <c>location.objects</c> holds nothing there. The pre-fix reading - the tile-keyed lookup this file performs itself
/// in <see cref="AFurniturePlacementIsJudgedInTheFurnitureCollectionAndTheTileItCameToRestOnIsNamed"/> - sees nothing,
/// so the verdict was <c>place_owned_object_postcondition_unavailable</c>; the production reading finds the piece on
/// its own tile and the verdict is <c>owned_object_placed</c>.
/// </para>
///
/// <para>
/// WHAT IS NOT PROVEN HERE: the native write. <c>Furniture.placementAction</c> asks the engine which furniture class an
/// id belongs to (<c>Furniture.GetFurnitureInstance</c> -&gt; <c>getData</c>, Furniture.cs), which reads
/// <c>Data/Furniture</c> through a content manager this process does not have, so the room below is the POST-STATE that
/// branch produces rather than one it produced. That mutation belongs to the lane's native-local live gate
/// (<c>run-stardew-native-local-player-place-owned-object-smoke.mjs</c>), exactly as the sibling placement, rotation,
/// fence and tank mutations do.
/// </para>
/// </summary>
public sealed class PlacementPostconditionContainerTests
{
    private const string FurnitureItemId = "(F)0";
    private const string HeldItemId = "(F)1364";
    private const string CraftableItemId = "(BC)105";

    [Fact]
    public void AFurniturePlacementIsJudgedInTheFurnitureCollectionAndTheTileItCameToRestOnIsNamed()
    {
        using var room = FurnitureRoom.Create();
        Furniture piece = room.PlaceFurniture(x: 2, y: 2);

        // The pre-fix reading, kept as the measurement rather than described: `location.objects` holds nothing on the
        // tile a furniture piece was placed on, which is why the old decision could never be anything but Uncertain.
        room.Location.objects.ContainsKey(new Vector2(2, 2)).Should().BeFalse(
            "the defect was this lookup - furniture is filed in `location.furniture`, never here");
        ExecutionManager
            .PlacementVerdict(placementHandled: true, foundInItsContainer: false, inventoryDecremented: true)
            .Should()
            .Be((ExecutionState.Uncertain, "place_owned_object_postcondition_unavailable"),
                "this is what the old objects-only reading answered for a piece that was placed correctly");

        (StardewValley.Object? placed, Vector2 restingTile) =
            ExecutionManager.FindPlacedThing(room.Location, new Vector2(2, 2), piece);
        placed.Should().BeSameAs(
            piece,
            "the native furniture branch appends the SOURCE instance (`location.furniture.Add(this as Furniture)`, "
            + "Object.cs:7041), so the piece found is the piece asked for");
        restingTile.Should().Be(
            new Vector2(2, 2),
            "the tile the piece came to rest on is the fact the receipt has to name, and it is the piece's own TileLocation");
        ExecutionManager
            .PlacementVerdict(placementHandled: true, foundInItsContainer: true, inventoryDecremented: true)
            .Should()
            .Be((ExecutionState.Succeeded, "owned_object_placed"));
    }

    [Fact]
    public void AnObjectPlacementIsStillJudgedInTheObjectsCollection()
    {
        using var room = FurnitureRoom.Create();
        StardewValley.Object placedObject = room.PlaceObject(x: 3, y: 3, CraftableItemId);

        room.Location.furniture.Should().BeEmpty("nothing was placed in the room itself");
        (StardewValley.Object? placed, Vector2 restingTile) =
            ExecutionManager.FindPlacedThing(room.Location, new Vector2(3, 3), placedObject);
        placed.Should().BeSameAs(
            placedObject,
            "a bigCraftable is keyed by tile in `location.objects` (Object.cs:7046), and that is the collection the "
            + "decision reads for a thing that is not furniture");
        restingTile.Should().Be(new Vector2(3, 3));
        ExecutionManager
            .PlacementVerdict(placementHandled: true, foundInItsContainer: true, inventoryDecremented: true)
            .Should()
            .Be((ExecutionState.Succeeded, "owned_object_placed"));
    }

    /// <summary>
    /// THE THIRD PLACE A FURNITURE PLACEMENT CAN END. <c>Furniture.placementAction</c> hands the piece to a
    /// <c>furniture_type</c> 11 table standing on the tile instead of adding it to the room
    /// (Furniture.cs:1443-1449), so the piece is in that table's <c>heldObject</c> and nowhere else. A read that only
    /// looked for pieces standing on the tile would call that placement unobserved.
    /// </summary>
    [Fact]
    public void APieceHeldByATableOnTheTileIsFoundOnTheTablesTile()
    {
        using var room = FurnitureRoom.Create();
        Furniture table = room.PlaceFurniture(x: 4, y: 4);
        table.furniture_type.Value = 11;
        Furniture held = room.MakeItem<Furniture>(HeldItemId);
        table.heldObject.Value = held;

        (StardewValley.Object? found, Vector2 restingTile) =
            ExecutionManager.FindPlacedThing(room.Location, new Vector2(4, 4), held);

        found.Should().BeSameAs(held, "the piece came to rest on the table, which is where the engine put it");
        restingTile.Should().Be(new Vector2(4, 4), "the tile it rests on is the table's, not the piece's own");
        ExecutionManager
            .PlacementVerdict(placementHandled: true, foundInItsContainer: true, inventoryDecremented: true)
            .Should()
            .Be((ExecutionState.Succeeded, "owned_object_placed"));
    }

    /// <summary>
    /// The boundaries of the read: an empty tile answers nothing, and a DIFFERENT piece standing where the request
    /// expected its own is returned rather than hidden - the receipt then names what it found instead.
    /// </summary>
    [Fact]
    public void AnEmptyTileAnswersNothingAndAnotherPieceAnswersItself()
    {
        using var room = FurnitureRoom.Create();
        Furniture other = room.PlaceFurniture(x: 5, y: 5);
        Furniture expected = room.MakeItem<Furniture>("(F)1466");

        ExecutionManager.FindPlacedThing(room.Location, new Vector2(9, 9), expected).Found.Should().BeNull();
        ExecutionManager.FindPlacedThing(room.Location, new Vector2(5, 5), expected).Found.Should().BeSameAs(other);
        string.Equals(other.QualifiedItemId, expected.QualifiedItemId, StringComparison.Ordinal).Should().BeFalse(
            "a different piece is not this placement, which is why the settlement compares the qualified item id");
    }

    /// <summary>
    /// Every failure this settlement can distinguish has its own name: the one code it used to answer with could not
    /// tell a native call that placed nothing from a piece standing in a collection nobody read.
    /// </summary>
    [Fact]
    public void EveryFailureTheSettlementCanDistinguishHasItsOwnName()
    {
        ExecutionManager.PlacementVerdict(placementHandled: false, foundInItsContainer: false, inventoryDecremented: false)
            .Should().Be((ExecutionState.Uncertain, "place_owned_object_native_declined"));
        ExecutionManager.PlacementVerdict(placementHandled: true, foundInItsContainer: false, inventoryDecremented: false)
            .Should().Be((ExecutionState.Uncertain, "place_owned_object_postcondition_unavailable"));
        ExecutionManager.PlacementVerdict(placementHandled: true, foundInItsContainer: true, inventoryDecremented: false)
            .Should().Be((ExecutionState.Uncertain, "place_owned_object_inventory_unchanged"));
        ExecutionManager.PlacementVerdict(placementHandled: true, foundInItsContainer: true, inventoryDecremented: true)
            .Should().Be((ExecutionState.Succeeded, "owned_object_placed"));
    }

    // -----------------------------------------------------------------------------------------------------------

    /// <summary>
    /// A real room with a real furniture collection, plus the <c>Game1</c> statics the collection's own
    /// <c>OnValueAdded</c> hook dereferences.
    ///
    /// <para>
    /// <c>GameLocation.furniture</c>'s hook calls <c>Furniture.OnAdded</c> -&gt; <c>minutesElapsed</c> -&gt; the light
    /// timers -&gt; <c>IsRainingHere</c>, and a location context with no cached weather sends that read into
    /// <c>Data/Festivals</c> through a content manager this process does not have. Caching the day is the state a
    /// loaded save carries, and it has to happen while the context table is still empty or the engine computes the day
    /// instead of reading it. The statics are captured before and restored on dispose, which is the population
    /// <c>HeadlessWorldStaticsGateTests</c> derives this fixture from.
    /// </para>
    /// </summary>
    private sealed class FurnitureRoom : IDisposable
    {
        private readonly Dictionary<string, object?> staticsBefore;

        internal GameLocation Location { get; }

        private FurnitureRoom()
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
            Game1.game1._locations = new List<GameLocation>();
            Game1.locationContextData = new Dictionary<string, StardewValley.GameData.LocationContexts.LocationContextData>(StringComparer.Ordinal);
            Game1.netWorldState.Value.GetWeatherForLocation("Default");
            Game1.locationContextData["Default"] = new StardewValley.GameData.LocationContexts.LocationContextData();

            var location = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Front", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            SetField(location, "name", new NetString("ProbeFurnitureRoom"));
            this.Location = location;

            // A real farmer, far from every tile this fixture furnishes: `Furniture.OnAdded` measures the piece against
            // `Game1.player.GetBoundingBox()` first thing (Furniture.cs:194) and adds a temporary passable tile when
            // they meet, so the body has to exist even though no case here places a piece under one.
            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            SetField(sprite, "spriteWidth", new NetInt(16));
            SetField(sprite, "spriteHeight", new NetInt(32));
            SetField(sprite, "tempSpriteHeight", -1);
            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            actor.position.Set(new Vector2(12 * 64, 12 * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);
        }

        internal static FurnitureRoom Create() => new();

        /// <summary>
        /// A piece standing in the room, in the state the native branch leaves: the SOURCE instance is appended
        /// (<c>Object.cs:7041</c>) after <c>Furniture.placementAction</c> has set its own <c>TileLocation</c> to the
        /// tile it was asked for (Furniture.cs:1434-1437). The tile and the bounding box are written directly because
        /// the public setter recalculates them from <c>Data/Furniture</c>, which this process cannot load.
        /// </summary>
        internal Furniture PlaceFurniture(int x, int y)
        {
            Furniture piece = MakeItem<Furniture>(FurnitureItemId);
            SetField(piece, "tileLocation", new NetVector2 { Value = new Vector2(x, y) });
            piece.boundingBox.Value = new Rectangle(x * 64, y * 64, 64, 64);
            this.Location.furniture.Add(piece);
            return piece;
        }

        /// <summary>A piece in the room's objects collection, the collection a non-furniture placement is filed in.</summary>
        internal StardewValley.Object PlaceObject(int x, int y, string qualifiedItemId)
        {
            StardewValley.Object placed = MakeItem<StardewValley.Object>(qualifiedItemId);
            this.Location.objects[new Vector2(x, y)] = placed;
            return placed;
        }

        /// <summary>
        /// One real item with its qualified identity written directly: <c>Item.ItemId</c> clears the qualified cache and
        /// the game derives one from the type definition, which a process that loaded no item data has none of. The
        /// context tags are declared empty - the answer a chair has - because <c>Furniture.OnAdded</c> and
        /// <c>Object.performRemoveAction</c> ask them through <c>Data/Furniture</c> otherwise.
        /// </summary>
        internal TItem MakeItem<TItem>(string qualifiedItemId)
            where TItem : Item, new()
        {
            TItem item = new();
            typeof(Item).GetProperty("ItemId", BindingFlags.Instance | BindingFlags.Public)!
                .SetValue(item, qualifiedItemId[(qualifiedItemId.IndexOf(')') + 1)..]);
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(item, qualifiedItemId);
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(item, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(item, false);
            item.HasBeenInInventory = true;
            return item;
        }

        public void Dispose() => HeadlessGameWorld.RestoreStatics(this.staticsBefore);

        private static void SetField(object target, string name, object value) =>
            target.GetType().GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);
    }
}
