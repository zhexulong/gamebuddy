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
/// <c>move_placed_furniture</c>: picking an ALREADY-PLACED piece of furniture up off the floor, through the
/// game's own furniture pickup sequence (<c>GameLocation.removeQueuedFurniture</c>, GameLocation.cs:8074-8101).
///
/// <para>
/// WHY THIS ACTION EXISTS. Furniture is <c>Furniture</c> in <c>location.furniture</c> (GameLocation.cs:452), never
/// in <c>location.objects</c>, so the axe/pickaxe removal cannot reach one and says so
/// (<c>remove_placed_item_furniture_move_unsupported</c>). Measured 2026-11-03 (`round30`): the companion crafted a
/// stone sign and planted it at the farmhouse door because nothing could move the furniture already in the room.
/// </para>
///
/// <para>
/// THE CASE THAT DECIDES THE ACTION is a full backpack. <c>Furniture.performRemoveAction</c> (Furniture.cs:1129)
/// does NOT take the piece out of the collection and does NOT put it in the pack - the caller does both - so a
/// naive implementation that mirrors the native order and then fails to deliver has already destroyed the piece.
/// The native method dodges this by refusing up front (<c>!player.couldInventoryAcceptThisItem(value)</c>, :8077)
/// because it cannot undo itself; this action CAN undo itself, so it observes the delivery and puts the piece back
/// on the exact tile with the exact rotation. That rollback is driven below against a real full pack, and the
/// receipt is asserted to be a REFUSAL rather than a success.
/// </para>
///
/// <para>
/// The world here is the harness shape the two neighbouring files established
/// (<c>ApproachClassificationTests.HeadlessWorld</c>, <c>TargetFamilyCompletenessTests.TargetFamilyWorld</c>): an
/// uninitialized <c>Game1</c>, a real map-backed <see cref="GameLocation"/>, a real <see cref="Farmer"/> whose
/// NetFields are seeded because a save never loaded, and a real <see cref="Furniture"/> in the location's own
/// furniture collection. Every case drives the PRODUCTION request path; nothing re-implements it.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the ordering they protect
// (re-validate, then mutate, then restore) is an order rather than an outcome, while the rest of the class calls
// the production request path against a real world; keeping both in one file keeps each pin beside the behaviour.
public sealed class MovePlacedFurnitureActionTests
{
    private const string ActionId = "move_placed_furniture";
    private const string FurnitureItemId = "(F)0";
    private const string HandlerFile = "farmhandexecutioncontroller.worldobjectactions.cs";

    [Fact]
    public void Catalog_RegistersTheFurniturePickupWithItsTileAndTargetAndNoSlot()
    {
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == ActionId);

        registration.FamilyId.Should().Be("buildings_farm_management");
        registration.Kind.Should().Be(FarmhandOperationKind.Execution);
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);
        // The native-local live gate passed and left a receipt, so the rung is LiveVerified. This asserts the rung by
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        registration.Descriptor!.Arguments.Select(argument => argument.Name)
            .Should().Equal(
                new[] { "x", "y", "expectedTargetId" },
                "there is no slot: which backpack slot receives the piece is the game's own decision");
        registration.Descriptor.Postcondition.Should().Be("placed_furniture_picked_up");
        registration.Descriptor.NativeBinding.Should().Be("GameLocation.removeQueuedFurniture");
        registration.Descriptor.TargetFamily.Should().Be("worldObjectTargets");
        registration.Descriptor.Effect.Should().Be("write");
    }

    /// <summary>
    /// The COMMITTED artifact, not the catalog that emits it: a descriptor present in the definitions and absent
    /// from the regenerated file is invisible to every consumer downstream of the file.
    /// </summary>
    [Fact]
    public void Artifact_PublishesTheFurniturePickupTheCatalogDeclares()
    {
        using System.Text.Json.JsonDocument document = System.Text.Json.JsonDocument.Parse(
            File.ReadAllText(RepositoryFile(
                "integrations", "stardew", "action-development", "contracts", "generated", "action-surface.v1.json")));

        System.Text.Json.JsonElement published = document.RootElement.GetProperty("actions").EnumerateArray()
            .Single(action => action.GetProperty("actionId").GetString() == ActionId);

        published.GetProperty("lifecycle").GetString().Should().Be("live_verified");
        published.GetProperty("kind").GetString().Should().Be("execution");
        published.GetProperty("postcondition").GetProperty("name").GetString().Should().Be("placed_furniture_picked_up");
        published.GetProperty("targetFamily").GetString().Should().Be("worldObjectTargets");
        published.GetProperty("argumentSchema").EnumerateObject().Select(property => property.Name)
            .Should().Equal("x", "y", "expectedTargetId");
    }

    /// <summary>
    /// Two vocabularies for one fact drift silently: the parser's argument list decides what an inbound request may
    /// carry, the descriptor decides what the acceptance layer demands, and a request refused by the parser never
    /// reaches a handler.
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
    public void Handler_RoutesTheFurniturePickupToItsExecutionBody()
    {
        using var world = FurnitureWorld.Create();
        world.PlaceFurniture(x: 2, y: 2);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.DispatchThroughTheResourceToolHandler(2, 2);

        receipt.ReasonCode.Should().NotBe("unsupported_action", "the resource-tool handler must own this action id");
        receipt.ReasonCode.Should().NotBe("world_not_ready", "the harness must satisfy the actor guard, not hide behind it");
        (receipt.ReasonCode == "placed_furniture_picked_up" || receipt.ReasonCode.StartsWith("move_placed_furniture", StringComparison.Ordinal))
            .Should().BeTrue($"the handler must reach this action's own body, not another action's: {receipt.ReasonCode}");
    }

    /// <summary>
    /// The delivery step IS reached, and a piece the engine cannot hand over is put back: the one frame this process
    /// cannot pass is the game's own "item gained" HUD message, whose text is `Furniture.loadDisplayName` ->
    /// `ItemRegistry.GetDataOrErrorItem` -> `Data/Furniture` (Farmer.addItemToInventory, Farmer.cs:3897 ->
    /// ShowItemReceivedHudMessage 4746 -> HUDMessage.ForItemGained 78). Promoting it is a consequence of STORING an
    /// item, not of anything this action decides, so the receipt must be an honest Uncertain and the piece must come
    /// back - which is what this asserts. The end-to-end success belongs to the lane's native-local live gate, the
    /// same place the sibling placement/removal/container actions prove their mutations.
    /// </summary>
    [Fact]
    public void DeliveryIsReachedAndAnUndeliverablePieceIsPutBack()
    {
        using var world = FurnitureWorld.Create();
        Furniture piece = world.PlaceFurniture(x: 2, y: 2, rotation: 2);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Uncertain, receipt.Evidence);
        receipt.ReasonCode.Should().Be("move_placed_furniture_native_exception");
        receipt.Evidence.Should().Contain("native_call_ran_unknown=true");
        receipt.Evidence.Should().Contain("restored=true", "a throw after the piece left the room must not lose it");
        world.Location.furniture.Should().ContainSingle().Which.Should().BeSameAs(piece);
        piece.TileLocation.Should().Be(new Vector2(2, 2));
        piece.currentRotation.Value.Should().Be(2);
    }

    /// <summary>
    /// THE CRITICAL CASE. A piece that was lifted and could not be delivered must be back on its own tile, at its
    /// own rotation, and the receipt must NOT claim success - a silently lost chair is worse than a refusal.
    /// </summary>
    [Fact]
    public void InventoryFull_PutsThePieceBackExactlyWhereItStoodAndRefusesByName()
    {
        using var world = FurnitureWorld.Create(fullPack: true);
        Furniture piece = world.PlaceFurniture(x: 2, y: 2, rotation: 3);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected, "nothing was stored, so nothing succeeded");
        receipt.ReasonCode.Should().Be("move_placed_furniture_inventory_full");
        world.Location.furniture.Should().ContainSingle().Which.Should().BeSameAs(piece, "the same piece came back");
        piece.TileLocation.Should().Be(new Vector2(2, 2), "the piece must stand on the tile it was lifted from");
        piece.currentRotation.Value.Should().Be(3, "its rotation is part of where it stood");
        world.Carries(piece).Should().BeFalse("a full pack received nothing");
        receipt.Evidence.Should().Contain("restored=true");
    }

    [Fact]
    public void StaleTargetId_IsRefusedByNameAndLeavesThePieceStanding()
    {
        using var world = FurnitureWorld.Create();
        Furniture piece = world.PlaceFurniture(x: 2, y: 2);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2, expectedTargetId: "placed_furniture_0000000000000000");

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("move_placed_furniture_target_changed");
        world.Location.furniture.Should().ContainSingle().Which.Should().BeSameAs(piece);
    }

    /// <summary>
    /// The reach is the game's own furniture predicate (`Furniture.IsCloseEnoughToFarmer`, Furniture.cs:1295-1308),
    /// which `GameLocation.LowPriorityLeftClick` gates the pickup on - not a tile distance invented here.
    /// </summary>
    [Fact]
    public void OutOfReach_IsRefusedByNameAndLeavesThePieceStanding()
    {
        using var world = FurnitureWorld.Create();
        Furniture piece = world.PlaceFurniture(x: 2, y: 2);
        world.StandAt(14, 14);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("move_placed_furniture_out_of_range");
        world.Location.furniture.Should().ContainSingle().Which.Should().BeSameAs(piece);
    }

    [Fact]
    public void AnEmptyTile_IsRefusedByName()
    {
        using var world = FurnitureWorld.Create();
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("move_placed_furniture_target_not_found");
    }

    /// <summary>
    /// The ORDER the body must keep, pinned because it is an order and not an outcome: every check that can refuse
    /// runs before the first mutation, the native sequence runs in the native order
    /// (GameLocation.cs:8081-8093), and the restore is inside the delivery-failure branch rather than after an
    /// unconditional success.
    /// </summary>
    [Fact]
    public void SourceShape_ValidatesFirstThenRunsTheNativeSequenceThenRestoresOnDeliveryFailure()
    {
        string source = File.ReadAllText(RepositoryFile("integrations", "stardew", HandlerFile));
        string body = MethodBody(source, "public LocalExecutionReceipt RequestLocalMovePlacedFurniture(");

        int targetCheck = body.IndexOf("move_placed_furniture_target_changed", StringComparison.Ordinal);
        int reach = body.IndexOf("piece.IsCloseEnoughToFarmer(Game1.player)", StringComparison.Ordinal);
        int performRemove = body.IndexOf("piece.performRemoveAction()", StringComparison.Ordinal);
        int collectionRemove = body.IndexOf("location.furniture.Remove(piece)", StringComparison.Ordinal);
        int deliver = body.IndexOf("addItemToInventoryBool(piece)", StringComparison.Ordinal);
        int restore = body.IndexOf("RestoreFurniturePiece(location, piece, placedTile, placedRotation, placedFlipped)", StringComparison.Ordinal);
        int refusal = body.IndexOf("\"move_placed_furniture_inventory_full\"", StringComparison.Ordinal);

        foreach ((string step, int index) in new[]
                 {
                     ("target_changed", targetCheck),
                     ("furniture_reach", reach),
                     ("performRemoveAction", performRemove),
                     ("furniture.Remove", collectionRemove),
                     ("addItemToInventoryBool", deliver),
                     ("restore", restore),
                     ("inventory_full", refusal),
                 })
        {
            index.Should().BeGreaterThanOrEqualTo(0, $"{step} must exist in the body");
        }
        targetCheck.Should().BeLessThan(reach, "the id proves the piece before the reach is measured");
        reach.Should().BeLessThan(performRemove, "no mutation may happen before the reach is admitted");
        performRemove.Should().BeLessThan(collectionRemove, "the native order is performRemoveAction then Remove");
        collectionRemove.Should().BeLessThan(deliver, "the piece is delivered only after it left the collection");
        restore.Should().BeGreaterThan(deliver, "the restore belongs to the delivery-failure branch");
        refusal.Should().BeGreaterThan(restore, "the refusal names the state the restore produced");
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
    /// and <c>Context.IsWorldReady</c> dereference.
    ///
    /// <para>
    /// <c>Context.IsWorldReady</c> is not settable: SMAPI reads <c>PerScreen&lt;bool&gt;.States[Context.ScreenId]</c>,
    /// so this harness seeds it through the type's own <c>SetValueForScreen</c> and clears it with
    /// <c>ResetAllScreens</c>. The assembly disables xUnit parallelization for exactly this reason
    /// (<c>AssemblyInfo.cs</c>).
    /// </para>
    /// </summary>
    private sealed class FurnitureWorld : IDisposable
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
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;
        private readonly bool fullPack;

        internal GameLocation Location { get; }

        private FurnitureWorld(bool fullPack)
        {
            this.fullPack = fullPack;
            this.staticsBefore = HeadlessGameWorld.CaptureStatics();
            this.playerBefore = Game1.player;
            this.worldStateBefore = typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .GetValue(null);

            // A world fixture owns the `Game1` singleton while it runs: reusing a leftover instance would write this
            // world's location book on somebody else's singleton, and `getLocationFromName` answers from that book for
            // every later class that reuses the name.
            Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, root);
            Game1.random ??= new Random(1);
            // `Farmer.couldInventoryAcceptThisItem` reads `hudMessages` whenever the pack is full (Farmer.cs:4741),
            // and `FarmerCollection.Any` reads `otherFarmers`; both are assigned in Game1's own startup.
            Game1.otherFarmers ??= new NetRootDictionary<long, Farmer>();
            Game1.hudMessages ??= new List<HUDMessage>();
            var options = (Options)FormatterServices.GetUninitializedObject(typeof(Options));
            SetField(options, "gamepadControls", false);
            SetField(options, "rumble", false);
            Game1.options ??= options;
            if (Game1.game1!._locations is null) Game1.game1._locations = new List<GameLocation>();
            // TODAY'S WEATHER IS PART OF THE WORLD THIS FIXTURE BUILDS, not something the engine may compute.
            //
            // `GameLocation.furniture`'s own `OnValueAdded` hook calls `Furniture.OnAdded` -> `minutesElapsed` ->
            // `timeToTurnOnLights` -> `IsRainingHere` (GameLocation.cs:801 with Furniture.cs:202, :1167, :872), and a
            // location context with no cached weather sends `LocationWeather.UpdateDailyWeather` into
            // `Utility.isFestivalDay`, which reads `Data/Festivals` through a content manager this process does not
            // have. Caching the day here is the same state a loaded save carries, and it must happen while the
            // context table is still EMPTY or the engine computes the day instead of reading it.
            Game1.locationContextData = new Dictionary<string, StardewValley.GameData.LocationContexts.LocationContextData>(StringComparer.Ordinal);
            Game1.netWorldState.Value.GetWeatherForLocation("Default");
            Game1.locationContextData["Default"] = new StardewValley.GameData.LocationContexts.LocationContextData();

            var location = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Front", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            location.IsFarm = true;
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

            // `canMove` is a plain bool whose initializer never ran, and `AdmitExecution` refuses a body it cannot
            // move before any target is read.
            typeof(Farmer).GetField("canMove", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, true);

            // A real pack at its full capacity: `isInventoryFull` walks `maxItems` slots and answers "full" for every
            // slot the list does not hold, and the delivery writes into the first NULL slot.
            var pack = new StardewValley.Inventories.Inventory();
            for (int slot = 0; slot < PackCapacity; slot++) pack.Add(null!);
            SetField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = pack });
            SetField(actor, "maxItems", new NetInt(PackCapacity));
            if (fullPack)
                for (int slot = 0; slot < PackCapacity; slot++) pack[slot] = PackedObject(slot);

            actor.position.Set(new Vector2(2 * 64 + 8, 3 * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            WorldReadyPerScreen.GetValue(null)!.GetType()
                .GetMethod("SetValueForScreen", new[] { typeof(int), typeof(bool) })!
                .Invoke(WorldReadyPerScreen.GetValue(null), new object[] { Context.ScreenId, true });
            Context.IsWorldReady.Should().BeTrue("the headless world must satisfy the readiness gate the body checks");
        }

        internal static FurnitureWorld Create(bool fullPack = false) => new(fullPack);

        /// <summary>
        /// A real <see cref="Furniture"/> in the location's own furniture collection. The parameterless constructor
        /// touches no game content, and the piece's tile and bounding box are written directly: the public
        /// <c>TileLocation</c> setter reaches <c>Furniture.RecalculateBoundingBox</c>, which reads
        /// <c>Data/Furniture</c> and therefore needs a content manager this process does not have.
        /// </summary>
        internal Furniture PlaceFurniture(int x, int y, int rotation = 0)
        {
            var piece = new Furniture { ItemId = FurnitureItemId[3..] };
            // `Item.ItemId` clears the qualified cache and the game derives one from the type definition; a process
            // that loaded no item data has no definition to consult, so the qualified identity is written explicitly
            // (the same two writes `TargetFamilyWorld.PutToolInPackSlot` makes, and in the same order).
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(piece, FurnitureItemId);
            // The piece's data-derived context tags: `Object.performRemoveAction` asks `IsTapper()` -> `HasContextTag`,
            // which would otherwise read `Data/Furniture` through the item registry. An empty set is the answer a
            // chair has, and it is declared here rather than silently derived from an asset this process never loads.
            // The cache flag is written too: the collection's `OnValueAdded` hook runs `Furniture.OnAdded`, and a
            // dirty cache regenerates from data the moment anything asks.
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(piece, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(piece, false);
            SetField(piece, "tileLocation", new NetVector2 { Value = new Vector2(x, y) });
            piece.boundingBox.Value = new Rectangle(x * 64, y * 64, 64, 64);
            piece.currentRotation.Value = rotation;
            // A PLACED PIECE HAS BEEN CARRIED: it can only have reached the room through a farmer's pack. The flag is the
            // engine's own (`Item.HasBeenInInventory`, read first by `Farmer.OnItemReceived`, Farmer.cs:142583) and it is
            // what keeps the cosmetic "item gained" HUD message - whose text is `Furniture.loadDisplayName` ->
            // `Data/Furniture` - out of a delivery this process has no content manager for.
            piece.HasBeenInInventory = true;
            this.Location.furniture.Add(piece);
            return piece;
        }

        internal void StandAt(int x, int y) => Game1.player.position.Set(new Vector2(x * 64 + 8, y * 64));

        internal bool Carries(Item piece)
        {
            for (int slot = 0; slot < Game1.player.Items.Count; slot++)
                if (ReferenceEquals(Game1.player.Items[slot], piece)) return true;
            return false;
        }

        /// <summary>The target id the snapshot publishes for this tile, read off the production builder.</summary>
        internal string TargetIdAt(int x, int y) => ExecutionManager.BuildPlacedFurnitureTargetId(
            this.Location,
            x,
            y,
            this.Location.furniture.FirstOrDefault(piece => piece.TileLocation == new Vector2(x, y))
                ?? throw new InvalidOperationException($"no furniture stands on {x},{y}"));

        /// <summary>
        /// The id a caller would send: the live one when a piece stands there, and a well-formed id when one does not
        /// (the empty-tile case needs a target to name before it can be refused for not being there).
        /// </summary>
        private string TargetIdOrSynthetic(int x, int y) =>
            this.Location.furniture.Any(piece => piece.TileLocation == new Vector2(x, y))
                ? this.TargetIdAt(x, y)
                : "placed_furniture_0000000000000000";

        internal LocalExecutionReceipt Request(int x, int y, string? expectedTargetId = null) =>
            this.Manager().RequestLocalMovePlacedFurniture(
                $"req_furniture_{x}_{y}_{expectedTargetId ?? "live"}",
                x,
                y,
                expectedTargetId ?? this.TargetIdOrSynthetic(x, y),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);

        /// <summary>The same request through the dispatch handler the production router registers for the group.</summary>
        internal LocalExecutionReceipt DispatchThroughTheResourceToolHandler(int x, int y)
        {
            ExecutionManager executions = this.Manager();
            var request = new BridgeExecutionRequest(
                $"req_furniture_handler_{x}_{y}",
                $"idem_furniture_handler_{x}_{y}",
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
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!
                .SetValue(null, this.playerBefore);
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, this.worldStateBefore);
            HeadlessGameWorld.RestoreStatics(this.staticsBefore);
        }

        /// <summary>One stack of a DIFFERENT item, so a full pack holds something that cannot receive the piece.</summary>
        private static StardewValley.Object PackedObject(int index)
        {
            var item = new StardewValley.Object();
            typeof(Item).GetProperty("ItemId", BindingFlags.Instance | BindingFlags.Public)!
                .SetValue(item, (100 + index).ToString(System.Globalization.CultureInfo.InvariantCulture));
            return item;
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
