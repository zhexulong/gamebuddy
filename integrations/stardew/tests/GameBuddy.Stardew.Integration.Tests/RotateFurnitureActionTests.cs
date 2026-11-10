using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Microsoft.Xna.Framework;
using Netcode;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Network;
using StardewValley.Objects;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// <c>rotate_furniture</c>: turning a piece of furniture that is ALREADY standing in the room, through the
/// piece's own <c>Furniture.rotate()</c> (Furniture.cs:1153-1162) and its bookkeeping
/// <c>updateRotation()</c> (:1164-1242), with the rotated footprint admitted by the game's own
/// <c>Furniture.canBePlacedHere</c> (:1331-1406).
///
/// <para>
/// THE CASE THAT DECIDES THE ACTION is a piece whose rotation changes the tiles it covers. A non-square
/// piece swaps its bounding box's width and height on the odd rotations (Furniture.cs:1182-1198), so a turn
/// can land the piece on a neighbour. The native <c>rotate()</c> does not look; it is the placement
/// PREVIEW's writer (<c>Game1.cs:11401-11409</c>), and the game never rotates placed furniture at all. So
/// the caller owns the occupancy question, and a turn that does not fit is put BACK rather than left
/// overlapping - which is what <c>OccupiedFootprintPutsTheRotationBackAndRefusesByName</c> drives.
/// </para>
///
/// <para>
/// The world here is the harness shape <c>MovePlacedFurnitureActionTests</c> established: an uninitialized
/// <c>Game1</c>, a real map-backed <see cref="GameLocation"/>, a real <see cref="Farmer"/> whose NetFields
/// are seeded because a save never loaded, and real <see cref="Furniture"/> instances in the location's own
/// furniture collection. Every case drives the PRODUCTION request path; nothing re-implements it.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: one pin here asserts on repository source text because the ordering it
// protects (validate, then turn, then probe, then revert) is an order rather than an outcome, while the rest
// of the class calls the production request path against a real world.
public sealed class RotateFurnitureActionTests
{
    private const string ActionId = "rotate_furniture";
    private const string FurnitureItemId = "(F)0";
    private const string HandlerFile = "farmhandexecutioncontroller.furnituredecorationactions.cs";

    [Fact]
    public void Catalog_RegistersTheFurnitureRotationWithItsTileAndTargetAndNoSlot()
    {
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == ActionId);

        registration.FamilyId.Should().Be("buildings_farm_management");
        registration.Kind.Should().Be(FarmhandOperationKind.Execution);
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);
        // Experimental until its own native-local live gate passes; promotion is a separate catalog edit.
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        registration.Descriptor!.Arguments.Select(argument => argument.Name)
            .Should().Equal(
                new[] { "x", "y", "expectedTargetId" },
                "no slot is involved: turning a placed piece consumes no item and swings no tool");
        registration.Descriptor.Postcondition.Should().Be("furniture_rotated");
        registration.Descriptor.NativeBinding.Should().Be("Furniture.rotate");
        registration.Descriptor.TargetFamily.Should().Be("worldObjectTargets");
        registration.Descriptor.Effect.Should().Be("write");
    }

    /// <summary>
    /// Two vocabularies for one fact drift silently: the parser's argument list decides what an inbound request
    /// may carry, the descriptor decides what the acceptance layer demands, and a request refused by the parser
    /// never reaches a handler.
    /// </summary>
    [Fact]
    public void Wire_AndCatalogDeclareTheSameArgumentNames()
    {
        FarmhandActionDescriptor descriptor = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == ActionId).Descriptor!;

        BridgeProtocol.ExecutionArgumentProperties(ActionId).Should().NotBeNull();
        BridgeProtocol.ExecutionArgumentProperties(ActionId)!
            .OrderBy(name => name, StringComparer.Ordinal)
            .Should().Equal(descriptor.Arguments.Select(argument => argument.Name).OrderBy(name => name, StringComparer.Ordinal));
    }

    [Fact]
    public void Handler_RoutesTheFurnitureRotationToItsExecutionBody()
    {
        using var world = FurnitureRotationWorld.Create();
        world.PlaceFurniture(x: 2, y: 2, rotations: 4);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.DispatchThroughTheResourceToolHandler(2, 2);

        receipt.ReasonCode.Should().NotBe("unsupported_action", "the resource-tool handler must own this action id");
        receipt.ReasonCode.Should().NotBe("world_not_ready", "the harness must satisfy the actor guard, not hide behind it");
        (receipt.ReasonCode == "furniture_rotated" || receipt.ReasonCode.StartsWith("furniture_rotation", StringComparison.Ordinal))
            .Should().BeTrue($"the handler must reach this action's own body, not another action's: {receipt.ReasonCode}");
    }

    /// <summary>
    /// THE SUCCESS PATH, and the proof that the write is the engine's own: the piece's <c>currentRotation</c> read
    /// AFTER the call is the next value in its own cycle, and the footprint the engine derived from it is the one
    /// a 1x2 piece covers at an odd rotation.
    /// </summary>
    [Fact]
    public void RotationAdvancesThePiecesOwnCycleAndTheFootprintItDerives()
    {
        using var world = FurnitureRotationWorld.Create();
        Furniture piece = world.PlaceFurniture(x: 2, y: 2, rotations: 4);
        world.StandAt(2, 3);
        piece.currentRotation.Value.Should().Be(0);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Succeeded, receipt.Evidence);
        receipt.ReasonCode.Should().Be("furniture_rotated");
        piece.currentRotation.Value.Should().Be(1, "a four-rotation piece steps by one (Furniture.cs:1157)");
        receipt.Evidence.Should().Contain("rotation_before=0");
        receipt.Evidence.Should().Contain("rotation_after=1");
        receipt.Evidence.Should().Contain("rotations=4");
        // The derived footprint moved, which is the fact that makes the occupancy probe meaningful: a 1x2 piece
        // covers two tiles going up and two tiles across at an odd rotation.
        receipt.Evidence.Should().Contain("footprint_before=2,2:1x2", receipt.Evidence);
        receipt.Evidence.Should().Contain("footprint_after=2,2:2x1", receipt.Evidence);
        receipt.Evidence.Should().Contain("placeable=true");
        world.Location.furniture.Should().ContainSingle().Which.Should().BeSameAs(piece);
        piece.TileLocation.Should().Be(new Vector2(2, 2), "turning a piece does not move it");
    }

    /// <summary>
    /// THE CRITICAL CASE. The rotated footprint lands on the chair beside it, so the turn is undone: the piece must
    /// report the rotation it really has, the receipt must NOT claim success, and the reason must name the
    /// occupant rather than a generic "not placeable".
    /// </summary>
    [Fact]
    public void OccupiedFootprintPutsTheRotationBackAndRefusesByName()
    {
        using var world = FurnitureRotationWorld.Create();
        Furniture turned = world.PlaceFurniture(x: 2, y: 2, rotations: 4);
        Furniture neighbour = world.PlaceFurniture(x: 3, y: 2, rotations: 1);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected, "the world shows no turn, so nothing succeeded");
        receipt.ReasonCode.Should().Be("furniture_rotation_blocked_by_occupant");
        receipt.Evidence.Should().Contain("placeable=false");
        receipt.Evidence.Should().Contain("reverted=true");
        receipt.Evidence.Should().Contain($"furniture:{neighbour.QualifiedItemId}");
        turned.currentRotation.Value.Should().Be(0, "a refused turn leaves the piece as it stood");
        // The revert re-derives the footprint from the restored value, so the piece is back on its own two tiles.
        turned.GetBoundingBox().Should().Be(new Rectangle(2 * 64, 2 * 64, 64, 128));
        world.Location.furniture.Should().HaveCount(2, "the probe puts the piece back in the room's collection");
    }

    /// <summary>
    /// <c>rotate()</c> does NOTHING below two rotations (Furniture.cs:1155). Running it anyway would leave the
    /// receipt with a turn it could only report as uncertain, so the request is refused by name instead.
    /// </summary>
    [Fact]
    public void APieceTheEngineWillNotTurnIsRefusedByName()
    {
        using var world = FurnitureRotationWorld.Create();
        Furniture piece = world.PlaceFurniture(x: 2, y: 2, rotations: 1);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("furniture_rotation_unsupported");
        receipt.Evidence.Should().Contain("rotations=1");
        piece.currentRotation.Value.Should().Be(0);
    }

    [Fact]
    public void StaleTargetId_IsRefusedByNameAndLeavesThePieceStanding()
    {
        using var world = FurnitureRotationWorld.Create();
        Furniture piece = world.PlaceFurniture(x: 2, y: 2, rotations: 4);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2, expectedTargetId: "placed_furniture_0000000000000000");

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("furniture_rotation_target_changed");
        piece.currentRotation.Value.Should().Be(0);
        world.Location.furniture.Should().ContainSingle().Which.Should().BeSameAs(piece);
    }

    /// <summary>
    /// The reach is the game's own furniture predicate (<c>Furniture.IsCloseEnoughToFarmer</c>, Furniture.cs:1295-1308),
    /// which the pickup is gated on - not a tile distance invented here.
    /// </summary>
    [Fact]
    public void OutOfReach_IsRefusedByNameAndLeavesThePieceStanding()
    {
        using var world = FurnitureRotationWorld.Create();
        Furniture piece = world.PlaceFurniture(x: 2, y: 2, rotations: 4);
        world.StandAt(14, 14);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("furniture_rotation_out_of_range");
        piece.currentRotation.Value.Should().Be(0);
    }

    [Fact]
    public void AnEmptyTile_IsRefusedByName()
    {
        using var world = FurnitureRotationWorld.Create();
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("furniture_rotation_target_not_found");
    }

    /// <summary>
    /// The ORDER the body must keep, pinned because it is an order and not an outcome: every check that can refuse
    /// runs before the first mutation, the native turn runs before the occupancy probe, and the revert lives inside
    /// the not-placeable branch rather than after an unconditional success.
    /// </summary>
    [Fact]
    public void SourceShape_ValidatesFirstThenTurnsThenProbesThenReverts()
    {
        string source = File.ReadAllText(RepositoryFile("integrations", "stardew", HandlerFile));
        string body = MethodBody(source, "public LocalExecutionReceipt RequestLocalRotateFurniture(");

        int targetCheck = body.IndexOf("furniture_rotation_target_changed", StringComparison.Ordinal);
        int unsupported = body.IndexOf("furniture_rotation_unsupported", StringComparison.Ordinal);
        int reach = body.IndexOf("piece.IsCloseEnoughToFarmer(Game1.player)", StringComparison.Ordinal);
        int turn = body.IndexOf("piece.rotate();", StringComparison.Ordinal);
        int probe = body.IndexOf("piece.canBePlacedHere(location, placedTile)", StringComparison.Ordinal);
        // The revert also appears in the native-exception branch, which is EARLIER in the body; the pin is about the
        // one inside the not-placeable branch, so it is searched from the probe forward.
        int revert = body.IndexOf("RestoreFurnitureRotation(piece, rotationBefore)", probe, StringComparison.Ordinal);
        int blocked = body.IndexOf("\"furniture_rotation_blocked_by_occupant\"", StringComparison.Ordinal);

        foreach ((string step, int index) in new[]
                 {
                     ("target_changed", targetCheck),
                     ("unsupported", unsupported),
                     ("furniture_reach", reach),
                     ("rotate", turn),
                     ("canBePlacedHere", probe),
                     ("restore", revert),
                     ("blocked_by_occupant", blocked),
                 })
        {
            index.Should().BeGreaterThanOrEqualTo(0, $"{step} must exist in the body");
        }
        targetCheck.Should().BeLessThan(unsupported, "the id proves the piece before its own data is read");
        unsupported.Should().BeLessThan(reach, "a piece the engine will not turn is refused before the reach is measured");
        reach.Should().BeLessThan(turn, "no mutation may happen before the reach is admitted");
        turn.Should().BeLessThan(probe, "the footprint is judged AFTER the turn produced it");
        probe.Should().BeLessThan(blocked, "the engine answers before the refusal names a reason");
        revert.Should().BeGreaterThan(probe, "the revert belongs to the not-placeable branch");
        blocked.Should().BeGreaterThan(revert, "the refusal names the state the revert produced");
    }

    // -----------------------------------------------------------------------------------------------------------

    private static string RepositoryFile(params string[] relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, Path.Combine(relative));
                if (File.Exists(candidate)) return candidate;
            }
        }

        throw new FileNotFoundException($"repository path not found: {Path.Combine(relative)}");
    }

    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{declaration} must exist");

        int depth = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}')
            {
                depth--;
                if (started && depth == 0) return source[start..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced body for {declaration}");
    }

    /// <summary>
    /// A real room with a real furniture collection and a real farmer, plus the <c>Game1</c> statics both the engine
    /// and <c>Context.IsWorldReady</c> dereference. Same shape as <c>MovePlacedFurnitureActionTests.FurnitureWorld</c>,
    /// with the three fields a ROTATION needs and a pickup does not: <c>furniture_type</c>, <c>rotations</c> and the
    /// default geometry <c>updateRotation</c> re-derives from.
    /// </summary>
    private sealed class FurnitureRotationWorld : IDisposable
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

        private FurnitureRotationWorld()
        {
            this.staticsBefore = HeadlessGameWorld.CaptureStatics();

            // A world fixture owns the `Game1` singleton while it runs: reusing a leftover instance would write this
            // world's location book on somebody else's singleton, and `getLocationFromName` answers from that book for
            // every later class that reuses the name.
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
            // `timeToTurnOnLights` -> `IsRainingHere`, which needs a cached day. Caching it here is the same state a
            // loaded save carries.
            Game1.locationContextData = new Dictionary<string, StardewValley.GameData.LocationContexts.LocationContextData>(StringComparer.Ordinal);
            Game1.netWorldState.Value.GetWeatherForLocation("Default");
            Game1.locationContextData["Default"] = new StardewValley.GameData.LocationContexts.LocationContextData();

            var location = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Front", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            // THE ROOM HAS A FLOOR. `Furniture.canBePlacedHere` asks `GameLocation.isTilePlaceable` per covered tile
            // (Furniture.cs:1356), and that method's second question is `hasTileAt(x, y, "Back")`
            // (GameLocation.cs:7532) - an unpainted map answers NO for every tile, so a bare map refuses every piece
            // before occupancy is ever considered. The sheet is a real `xTile.Tiles.TileSheet` because xTile rejects a
            // `StaticTile` that belongs to no parent map (`ApproachClassificationTests.ForBus` established the shape).
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
            // only" for a piece whose placement restriction is 0, so an outdoor location would refuse every piece in
            // this world before the occupancy question was ever asked. Furniture in a house stands indoors.
            location.IsOutdoors = false;
            SetField(location, "name", new NetString("ProbeFarmHouse"));
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
            // `Furniture.OnAdded` offers the actor a temporary passable tile whenever the piece it is being added to
            // overlaps the actor's own bounding box (Furniture.cs:194-197), and the group holding those tiles is a field
            // initializer an uninitialized `Farmer` never ran. A piece that stands on the tile the actor is standing on -
            // which a 1x2 piece at (2,2) does for an actor at (2,3) - reaches that write, so the group is seeded here.
            SetField(actor, "temporaryPassableTiles", new StardewValley.Util.BoundingBoxGroup());
            typeof(Farmer).GetField("canMove", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, true);

            var pack = new StardewValley.Inventories.Inventory();
            for (int slot = 0; slot < PackCapacity; slot++) pack.Add(null!);
            SetField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = pack });
            SetField(actor, "maxItems", new NetInt(PackCapacity));

            actor.position.Set(new Vector2(2 * 64 + 8, 3 * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            WorldReadyPerScreen.GetValue(null)!.GetType()
                .GetMethod("SetValueForScreen", new[] { typeof(int), typeof(bool) })!
                .Invoke(WorldReadyPerScreen.GetValue(null), new object[] { Context.ScreenId, true });
            Context.IsWorldReady.Should().BeTrue("the headless world must satisfy the readiness gate the body checks");
        }

        internal static FurnitureRotationWorld Create() => new();

        /// <summary>
        /// A real <see cref="Furniture"/> in the location's own furniture collection, one tile wide and TWO tiles
        /// high, so a turn really changes the tiles it covers. Nothing here derives from <c>Data/Furniture</c>: the
        /// type, the rotation count, the default geometry and the engine's own cached placement restriction are
        /// written explicitly, because this process loads no content manager and a value it cannot read is a value it
        /// must declare.
        /// </summary>
        internal Furniture PlaceFurniture(int x, int y, int rotations, int rotation = 0)
        {
            var piece = new Furniture { ItemId = FurnitureItemId[3..] };
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(piece, FurnitureItemId);
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(piece, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(piece, false);
            // A chair: a ground piece of type 0, which `isGroundFurniture` accepts and `updateRotation` treats as a
            // non-table (Furniture.cs:1176, :1244-1251).
            piece.furniture_type.Value = 0;
            piece.rotations.Value = rotations;
            piece.currentRotation.Value = rotation;
            SetField(piece, "tileLocation", new NetVector2 { Value = new Vector2(x, y) });
            piece.defaultBoundingBox.Value = new Rectangle(x * 64, y * 64, 64, 128);
            piece.boundingBox.Value = piece.defaultBoundingBox.Value;
            piece.defaultSourceRect.Value = new Rectangle(0, 0, 16, 32);
            piece.sourceRect.Value = piece.defaultSourceRect.Value;
            // The engine's own cache of the `Data/Furniture` placement restriction (Furniture.cs:105-141). Written
            // here for the same reason as the geometry: the asset is not loaded, and the getter would read it.
            SetField(piece, "_placementRestriction", 0);
            piece.HasBeenInInventory = true;
            this.Location.furniture.Add(piece);
            if (rotation != 0) piece.updateRotation();
            return piece;
        }

        internal void StandAt(int x, int y) => Game1.player.position.Set(new Vector2(x * 64 + 8, y * 64));

        /// <summary>The target id the snapshot publishes for this tile, read off the production builder.</summary>
        internal string TargetIdAt(int x, int y) => ExecutionManager.BuildPlacedFurnitureTargetId(
            this.Location,
            x,
            y,
            this.Location.furniture.FirstOrDefault(piece => piece.TileLocation == new Vector2(x, y))
                ?? throw new InvalidOperationException($"no furniture stands on {x},{y}"));

        private string TargetIdOrSynthetic(int x, int y) =>
            this.Location.furniture.Any(piece => piece.TileLocation == new Vector2(x, y))
                ? this.TargetIdAt(x, y)
                : "placed_furniture_0000000000000000";

        internal LocalExecutionReceipt Request(int x, int y, string? expectedTargetId = null) =>
            this.Manager().RequestLocalRotateFurniture(
                $"req_rotation_{x}_{y}_{expectedTargetId ?? "live"}",
                x,
                y,
                expectedTargetId ?? this.TargetIdOrSynthetic(x, y),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);

        /// <summary>The same request through the dispatch handler the production router registers for the group.</summary>
        internal LocalExecutionReceipt DispatchThroughTheResourceToolHandler(int x, int y)
        {
            ExecutionManager executions = this.Manager();
            var request = new BridgeExecutionRequest(
                $"req_rotation_handler_{x}_{y}",
                $"idem_rotation_handler_{x}_{y}",
                ActionId,
                new BridgeExecutionArgs { X = x, Y = y, ExpectedTargetId = this.TargetIdAt(x, y) },
                executions.Revision,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);
            return new ResourceToolActionHandler(executions).Execute(request, executions);
        }

        private ExecutionManager Manager()
        {
            var publication = FarmhandCapabilityPublication.Initial(
                new HashSet<string>(StringComparer.Ordinal) { ActionId });
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
