using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using Netcode;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Network;
using StardewValley.Objects;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The furniture transfer cycle as ONE chain: <c>move_placed_furniture</c> lifts a piece out of the room, and what it
/// hands back is what <c>place_owned_object</c> accepts to put it down again.
///
/// <para>
/// THE DEFECT THIS DRIVES, measured 2026-11-19 (Turn 130-138). She picked the house plant at <c>(F)1376</c> up, passed
/// the axe's <c>slot: 0</c> (refused <c>place_owned_object_not_owned_in_slot</c>), then guessed <c>slot: 12</c> and kept
/// the PRE-PICKUP <c>placed_furniture_*</c> id as <c>expectedTargetId</c> - four consecutive
/// <c>place_owned_object_target_changed</c> (05:16:02-05:17:08). Two facts were missing from the pickup's receipt: the
/// slot the game chose, and the identity that replaced the one the pickup invalidated. Neither is a fact a caller can
/// derive - an opaque id cannot be computed, only echoed - so the receipt owes both.
/// </para>
///
/// <para>
/// The world here is the harness shape <c>MovePlacedFurnitureActionTests</c> and <c>RotateFurnitureActionTests</c>
/// established (an uninitialized <c>Game1</c>, a real map-backed room with a floor, a real <see cref="Farmer"/> whose
/// NetFields are seeded, real <see cref="Furniture"/> in the location's own collection) plus the one thing a placement
/// needs and a rotation does not: a bag slot the piece can land in. Every case drives the PRODUCTION request path.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class FurnitureIdentityReplayTests
{
    private const string FurnitureItemId = "(F)0";
    private const string RotationHandlerFile = "farmhandexecutioncontroller.furnituredecorationactions.cs";

    /// <summary>
    /// THE FALSIFIER. Pick a piece up, then place it with the slot and the id the pickup's own receipt names - the
    /// identity gate must accept that id on the FIRST try. Whatever happens after the gate (this process has no
    /// content manager, so a furniture placement cannot complete) the request must not be
    /// <c>place_owned_object_target_changed</c>, which is what it answered four times in the measured run.
    /// </summary>
    [Fact]
    public void PickupThenPlace_AcceptsTheIdentityAndSlotThePickupReceiptNames()
    {
        using var world = FurnitureIdentityWorld.Create();
        Furniture piece = world.PlaceFurniture(x: 2, y: 2, rotations: 1);
        world.StandAt(2, 3);

        LocalExecutionReceipt pickup = world.RequestPickup(2, 2);

        int carriedSlot = world.CarriedSlot(piece);
        carriedSlot.Should().BeGreaterThanOrEqualTo(0, $"the pickup must really hand the piece to the pack: {pickup.Evidence}");
        pickup.Evidence.Should().Contain(
            $"carried_slot={carriedSlot}",
            "which slot the game chose is a fact only the receipt can tell the caller - she guessed the axe's slot 0");
        string carriedTarget = ExecutionManager.BuildOwnedObjectPlacementTargetId(world.Location, carriedSlot, FurnitureItemId);
        pickup.Evidence.Should().Contain(
            $"carried_target={carriedTarget}",
            "the identity the pickup created must come from the one builder the placement validates against");

        int destinationX = 3;
        int destinationY = 2;
        LocalExecutionReceipt place = world.RequestPlace(carriedSlot, destinationX, destinationY, carriedTarget);

        place.ReasonCode.Should().NotBe(
            "place_owned_object_target_changed",
            $"the identity and the slot came out of the pickup's own receipt: {place.Evidence}");
    }

    /// <summary>
    /// The falsifier's negative half, so the acceptance above cannot be a blanket one: the id the caller held BEFORE the
    /// pickup - the piece's own <c>placed_furniture_*</c> id - names nothing the pack carries, so it is refused by name
    /// and the refusal prints the live identity in the same evidence.
    /// </summary>
    [Fact]
    public void PlacingWithThePrePickupIdentity_IsRefusedByNameAndNamesTheLiveOne()
    {
        using var world = FurnitureIdentityWorld.Create();
        Furniture piece = world.PlaceFurniture(x: 2, y: 2, rotations: 1);
        world.StandAt(2, 3);
        string prePickupTargetId = world.PlacedFurnitureTargetId(2, 2);

        world.RequestPickup(2, 2);
        int carriedSlot = world.CarriedSlot(piece);
        carriedSlot.Should().BeGreaterThanOrEqualTo(0, "the pickup must have delivered the piece");

        LocalExecutionReceipt place = world.RequestPlace(carriedSlot, 3, 2, prePickupTargetId);

        place.State.Should().Be(ExecutionState.Rejected);
        place.ReasonCode.Should().Be("place_owned_object_target_changed");
        place.Evidence.Should().Contain(
            $"live={ExecutionManager.BuildOwnedObjectPlacementTargetId(world.Location, carriedSlot, FurnitureItemId)}",
            "a refusal that names only what the caller passed leaves it guessing the id it should have used");
    }

    /// <summary>
    /// The furniture reach is the engine's own predicate (<c>Furniture.IsCloseEnoughToFarmer</c>, Furniture.cs:1295-1308),
    /// and the request half ANSWERS IT WITH A STEP rather than with the bound it measured: measured `round79`, four
    /// refusals in a row named a pixel box nobody could turn into a tile. The bound is still printed - by the arrival that
    /// finds the piece outside it - but the request's answer is the walk the seam arms.
    /// </summary>
    [Fact]
    public void RotationOutOfRange_IsAWalkRatherThanARefusal()
    {
        using var world = FurnitureIdentityWorld.Create();
        world.PlaceFurniture(x: 2, y: 2, rotations: 4);
        world.StandAt(14, 14);

        LocalExecutionReceipt receipt = world.RequestRotation(2, 2);

        receipt.State.Should().Be(ExecutionState.Accepted, receipt.Evidence);
        receipt.ReasonCode.Should().NotBe("furniture_rotation_out_of_range");
        receipt.Evidence.Should().Contain("approach=adjacent", "the answer is the step, not the distance");
        receipt.Evidence.Should().Contain("stand_at=", "the step names the tile it walks to");
    }

    /// <summary>
    /// <c>furniture_rotation_unsupported</c> is a REAL engine limit, not a name for "we did not try":
    /// <c>Furniture.rotate()</c> is four lines and does nothing at all unless <c>rotations.Value &gt;= 2</c>
    /// (Furniture.cs:1153-1162), and <c>rotations</c> is the piece's own <c>Data/Furniture</c> value (:320). A plant with
    /// one orientation and a bed with one are therefore unturnable by the game itself, and the refusal states the bound it
    /// read (two) beside the value the piece carries.
    /// </summary>
    [Fact]
    public void RotationUnsupported_NamesTheEngineGuardAndThePiecesOwnCycle()
    {
        using var world = FurnitureIdentityWorld.Create();
        Furniture piece = world.PlaceFurniture(x: 2, y: 2, rotations: 1);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.RequestRotation(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("furniture_rotation_unsupported");
        receipt.Evidence.Should().Contain("rotations=1", "the piece's own Data/Furniture value");
        receipt.Evidence.Should().Contain("rotations_required=2", "the bound `Furniture.rotate` compares it against");
        piece.currentRotation.Value.Should().Be(0, "the engine performed nothing, so the piece did not turn");
    }

    /// <summary>
    /// One identity, many tiles: a placement candidate row names the PIECE (location, bag slot, item) and each row names
    /// one tile it may go on, so every lawful tile is advertised while the id stays the one a receipt can hand out.
    /// </summary>
    [Fact]
    public void EveryPlacementCandidateForOneSlotCarriesTheSameIdentity()
    {
        using var world = FurnitureIdentityWorld.Create();
        world.PlaceCarriedFurnitureInSlot(0);
        world.StandAt(4, 4);

        IReadOnlyList<BridgeWorldObjectTarget> targets = ExecutionManager.DiscoverWorldObjectTargets(Game1.player);
        List<BridgeWorldObjectTarget> candidates = targets
            .Where(target => string.Equals(target.Kind, "placement_candidate", StringComparison.Ordinal)
                && target.Slot == 0
                && string.Equals(target.QualifiedItemId, FurnitureItemId, StringComparison.Ordinal))
            .ToList();

        candidates.Should().HaveCountGreaterThan(1, "the room offers more than one tile for a 1x1 piece");
        string identity = ExecutionManager.BuildOwnedObjectPlacementTargetId(world.Location, 0, FurnitureItemId);
        candidates.Select(candidate => candidate.TargetId).Distinct(StringComparer.Ordinal)
            .Should().Equal(new[] { identity }, "the id names the piece; the row's x/y names the tile");
        candidates.Select(candidate => $"{candidate.X},{candidate.Y}").Distinct(StringComparer.Ordinal)
            .Should().HaveCount(candidates.Count, "no tile may be advertised twice");
    }

    /// <summary>
    /// A real room with a floor, one 1x1 piece the pickup can lift, and a pack with room for it - plus the
    /// <c>Game1</c> statics both the engine and <c>Context.IsWorldReady</c> dereference.
    /// </summary>
    private sealed class FurnitureIdentityWorld : IDisposable
    {
        private const long ActorId = 1001;
        private const int PackCapacity = 36;

        private static readonly FieldInfo WorldReadyPerScreen = typeof(Context)
            .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
            .GetGetMethod()!
            .Module.ResolveField(BitConverter.ToInt32(typeof(Context)
                .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
                .GetGetMethod()!.GetMethodBody()!.GetILAsByteArray()!, 1))!;

        private readonly Dictionary<string, object?> staticsBefore;

        internal GameLocation Location { get; }

        private FurnitureIdentityWorld()
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
            // `location.furniture`'s own `OnValueAdded` hook runs `Furniture.OnAdded` -> `minutesElapsed` ->
            // `timeToTurnOnLights` -> `IsRainingHere`, which needs a cached day; caching it is the state a loaded save
            // carries, and it must happen before the first piece is added.
            Game1.locationContextData = new Dictionary<string, StardewValley.GameData.LocationContexts.LocationContextData>(StringComparer.Ordinal);
            Game1.netWorldState.Value.GetWeatherForLocation("Default");
            Game1.locationContextData["Default"] = new StardewValley.GameData.LocationContexts.LocationContextData();

            var location = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Front", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            // The room has a FLOOR: `Furniture.canBePlacedHere` asks `GameLocation.isTilePlaceable` per covered tile
            // (Furniture.cs:1356), and that method's own question is `hasTileAt(x, y, "Back")` (GameLocation.cs:7532) - a
            // bare map answers NO everywhere, so nothing would ever be placeable or admitted.
            var floorSheet = new xTile.Tiles.TileSheet(
                "probe", map, "Maps/probe", new xTile.Dimensions.Size(64, 64), new xTile.Dimensions.Size(16, 16));
            map.AddTileSheet(floorSheet);
            xTile.Layers.Layer back = map.GetLayer("Back");
            for (int tileX = 0; tileX < 16; tileX++)
            for (int tileY = 0; tileY < 16; tileY++)
                back.Tiles[tileX, tileY] = new xTile.Tiles.StaticTile(back, floorSheet, xTile.Tiles.BlendMode.Alpha, 0);
            location.map = map;
            location.IsFarm = true;
            // A ROOM, not a field: `GameLocation.CanPlaceThisFurnitureHere` (GameLocation.cs:7490-7523) answers "indoors
            // only" for a piece whose placement restriction is 0, so furniture stands indoors.
            location.IsOutdoors = false;
            SetField(location, "name", new NetString("ProbeFurnitureRoom"));
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
            SetField(actor, "uniqueMultiplayerID", new NetLong(ActorId));
            SetField(actor, "netStamina", new NetFloat(270f));
            SetField(actor, "usingTool", new NetBool(false));
            SetField(actor, "toolPower", new NetInt(0));
            SetField(actor, "temporaryItem", new NetRef<Item>());
            SetField(actor, "currentToolIndex", new NetInt(0));
            SetField(actor, "netItemStowed", new NetBool(false));
            SetField(actor, "miningLevel", new NetInt(0));
            SetField(actor, "foragingLevel", new NetInt(0));
            SetField(actor, "farmingLevel", new NetInt(0));
            SetField(actor, "facingDirection", new NetDirection(2));
            SetField(actor, "isSitting", new NetBool(false));
            SetField(actor, "movementDirections", new List<int>());
            SetField(actor, "friendshipData", new NetStringDictionary<Friendship, NetRef<Friendship>>());
            SetField(actor, "stats", new Stats());
            SetField(actor, "mailReceived", new NetStringHashSet());
            var team = (FarmerTeam)FormatterServices.GetUninitializedObject(typeof(FarmerTeam));
            SeedMissingNetFields(team);
            SetField(actor, "teamRoot", new NetRoot<FarmerTeam> { Value = team });
            var buffs = new StardewValley.Buffs.BuffManager();
            typeof(StardewValley.Buffs.BuffManager)
                .GetField("CombinedEffects", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(buffs, new StardewValley.Buffs.BuffEffects());
            buffs.Dirty = false;
            SetField(actor, "buffs", buffs);
            // `Furniture.OnAdded` offers the actor a temporary passable tile whenever the piece overlaps the actor's own
            // bounding box (Furniture.cs:194-197), and the group holding those tiles is a field initializer an
            // uninitialized `Farmer` never ran.
            SetField(actor, "temporaryPassableTiles", new StardewValley.Util.BoundingBoxGroup());
            typeof(Farmer).GetField("canMove", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, true);

            var pack = new StardewValley.Inventories.Inventory();
            for (int slot = 0; slot < PackCapacity; slot++) pack.Add(null!);
            SetField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = pack });
            SetField(actor, "maxItems", new NetInt(PackCapacity));
            // The engine's own placement ingress reads farmer flags this list does not name one by one
            // (`f.bathingClothes`, `f.onBridge`, `f.isSitting`, ... in `Utility.playerCanPlaceItemHere`,
            // Utility.cs:5727-5750), and every one of them is a NetField an uninitialized `Farmer` never built. Seeding
            // the remaining NetFields is the same completeness `RotateFurnitureActionTests` supplies by hand for the three
            // a rotation touches.

            actor.position.Set(new Vector2(2 * 64 + 8, 3 * 64));
            actor.currentLocation = location;
            SeedMissingNetFields(actor);
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            WorldReadyPerScreen.GetValue(null)!.GetType()
                .GetMethod("SetValueForScreen", new[] { typeof(int), typeof(bool) })!
                .Invoke(WorldReadyPerScreen.GetValue(null), new object[] { Context.ScreenId, true });
            Context.IsWorldReady.Should().BeTrue("the headless world must satisfy the readiness gate the body checks");
        }

        internal static FurnitureIdentityWorld Create() => new();

        /// <summary>
        /// A real 1x1 <see cref="Furniture"/> standing in the location's own collection. Nothing derives from
        /// <c>Data/Furniture</c>: the type, the rotation cycle, the geometry and the engine's own cached placement
        /// restriction are written explicitly, because this process loads no content manager.
        /// </summary>
        internal Furniture PlaceFurniture(int x, int y, int rotations) => this.AddPiece(x, y, rotations);

        /// <summary>The same piece, already in the bag: the state a pickup leaves behind, for the discovery case.</summary>
        internal Furniture PlaceCarriedFurnitureInSlot(int slot) => (Furniture)PlaceIntoPack(this.AddPiece(-1, -1, 1, placed: false), slot)!;

        private Furniture AddPiece(int x, int y, int rotations, bool placed = true)
        {
            var piece = new Furniture { ItemId = FurnitureItemId[3..] };
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(piece, FurnitureItemId);
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(piece, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(piece, false);
            piece.furniture_type.Value = 0;
            piece.rotations.Value = rotations;
            piece.currentRotation.Value = 0;
            SetField(piece, "tileLocation", new NetVector2 { Value = new Vector2(x, y) });
            piece.defaultBoundingBox.Value = new Rectangle(x * 64, y * 64, 64, 64);
            piece.boundingBox.Value = piece.defaultBoundingBox.Value;
            piece.defaultSourceRect.Value = new Rectangle(0, 0, 16, 32);
            piece.sourceRect.Value = piece.defaultSourceRect.Value;
            SetField(piece, "_placementRestriction", 0);
            piece.HasBeenInInventory = true;
            if (placed) this.Location.furniture.Add(piece);
            return piece;
        }

        private static Item? PlaceIntoPack(Item item, int slot)
        {
            Game1.player.Items[slot] = item;
            return item;
        }

        internal void StandAt(int x, int y) => Game1.player.position.Set(new Vector2(x * 64 + 8, y * 64));

        internal int CarriedSlot(Item piece) => ExecutionManager.SlotHoldingPiece(Game1.player, piece);

        internal string PlacedFurnitureTargetId(int x, int y) => ExecutionManager.BuildPlacedFurnitureTargetId(
            this.Location,
            x,
            y,
            this.Location.furniture.FirstOrDefault(piece => piece.TileLocation == new Vector2(x, y))
                ?? throw new InvalidOperationException($"no furniture stands on {x},{y}"));

        internal LocalExecutionReceipt RequestPickup(int x, int y) =>
            this.Manager().RequestLocalMovePlacedFurniture(
                $"req_identity_pickup_{x}_{y}",
                x,
                y,
                this.PlacedFurnitureTargetId(x, y),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);

        internal LocalExecutionReceipt RequestPlace(int slot, int x, int y, string expectedTargetId) =>
            this.Manager().RequestLocalPlaceOwnedObject(
                $"req_identity_place_{slot}_{x}_{y}",
                slot,
                x,
                y,
                FurnitureItemId,
                expectedTargetId,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);

        internal LocalExecutionReceipt RequestRotation(int x, int y) =>
            this.Manager().RequestLocalRotateFurniture(
                $"req_identity_rotation_{x}_{y}",
                x,
                y,
                this.PlacedFurnitureTargetId(x, y),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);

        private ExecutionManager Manager()
        {
            var publication = FarmhandCapabilityPublication.Initial(
                new HashSet<string>(StringComparer.Ordinal) { "place_owned_object", "move_placed_furniture", "rotate_furniture" });
            return new ExecutionManager(new DummyMonitor(), () => publication, executionScope: null);
        }

        public void Dispose()
        {
            WorldReadyPerScreen.GetValue(null)!.GetType().GetMethod("ResetAllScreens")!
                .Invoke(WorldReadyPerScreen.GetValue(null), null);
            HeadlessGameWorld.RestoreStatics(this.staticsBefore);
        }

        private static void SeedMissingNetFields(object instance)
        {
            foreach (FieldInfo field in instance.GetType().GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            {
                if (!field.FieldType.Namespace!.StartsWith("Netcode", StringComparison.Ordinal)) continue;
                if (field.GetValue(instance) is not null) continue;
                if (field.FieldType.GetConstructor(Type.EmptyTypes) is null) continue;
                field.SetValue(instance, Activator.CreateInstance(field.FieldType)!);
            }
        }

        private static void SetField(object target, string name, object value) =>
            target.GetType().GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);
    }
}
