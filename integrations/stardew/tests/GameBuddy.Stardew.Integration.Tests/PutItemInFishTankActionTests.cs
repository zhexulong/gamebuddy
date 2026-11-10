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
/// <c>put_item_in_fish_tank</c>: putting one carried item into a placed fish tank through the tank's own
/// <c>FishTankFurniture.checkForAction</c> (FishTankFurniture.cs:220-268).
///
/// <para>
/// THE SEAM IS THE TANK'S OPINION, NOT THIS ACTION'S. <c>CanBeDeposited</c> (:270-309) admits a <c>(TR)FrogEgg</c>, the
/// closed vanilla fish/decor id list, a hat when a hat-wearing fish is in the tank, and otherwise whatever
/// <c>Data/Aquarium</c> lists; <c>HasRoomForThisItem</c> (:168-207) adds the per-category capacity. Nothing here restates
/// either. What this action adds is the part the engine leaves to its caller: the native method answers <c>true</c>
/// doing nothing while the mutex is held (:231-234) and answers <c>true</c> after showing a red message when the tank is
/// full (:237-241), so both are named refusals here instead of silent no-ops.
/// </para>
///
/// <para>
/// THE DEPOSIT COMPLETES ON A LATER TICK, and that is a fact about the engine rather than about this action.
/// <c>checkForAction</c> parks a copy in <c>localDepositedItem</c> and calls <c>NetMutex.RequestLock</c> (:242-263);
/// <c>RequestLock</c> only records the request, and the acquired callback runs from <c>NetMutex.Update</c>, which the
/// engine calls once per tick from <c>StorageFurniture.updateWhenCurrentLocation</c> (:226-234). The action drives that
/// same public method once so the receipt describes a settled tank rather than a half-interaction.
/// </para>
///
/// <para>
/// WHAT IS NOT PROVEN HERE: the deposit itself. <c>CanBeDeposited</c> reads <c>DataLoader.AquariumFish(Game1.content)</c>
/// (:360-363) with no seedable cache, so a process without a content manager cannot get past the tank's acceptance
/// predicate - every case below that reaches it reports the honest <c>Uncertain</c>
/// (<c>fish_tank_native_exception</c>), and the success path belongs to the lane's native-local live gate, exactly as
/// the sibling placement, rotation and fence-removal mutations do.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the shape pins below read the catalogue and handler source so a rename or a dropped declaration fails here, while the behaviour tests drive the handler and assert its postcondition; they are kept together because either half alone can be green while the action is wrong.
public sealed class PutItemInFishTankActionTests
{
    private const string ActionId = "put_item_in_fish_tank";
    private const string HandlerFile = "farmhandexecutioncontroller.furnituredecorationactions.cs";
    private const string FishItemId = "(O)129";
    private const string TankItemId = "(F)2397";

    [Fact]
    public void Catalog_RegistersTheTankDepositWithTheItemSlotAndTheTanksIdentity()
    {
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == ActionId);

        registration.FamilyId.Should().Be("buildings_farm_management");
        registration.Kind.Should().Be(FarmhandOperationKind.Execution);
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        registration.Descriptor!.Arguments.Select(argument => argument.Name)
            .Should().Equal(new[] { "x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId" });
        registration.Descriptor.Postcondition.Should().Be("fish_tank_item_deposited");
        registration.Descriptor.NativeBinding.Should().Be("FishTankFurniture.checkForAction");
        registration.Descriptor.TargetFamily.Should().Be("worldObjectTargets");
        registration.Descriptor.Effect.Should().Be("write");
    }

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
    public void Handler_RoutesTheTankDepositToItsExecutionBody()
    {
        using var world = TankWorld.Create();
        world.PlaceTank(x: 2, y: 2);
        world.PutFishInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.DispatchThroughTheResourceToolHandler(2, 2);

        receipt.ReasonCode.Should().NotBe("unsupported_action", "the resource-tool handler must own this action id");
        receipt.ReasonCode.Should().NotBe("world_not_ready", "the harness must satisfy the actor guard");
        (receipt.ReasonCode == "fish_tank_item_deposited" || receipt.ReasonCode.StartsWith("fish_tank", StringComparison.Ordinal))
            .Should().BeTrue($"the handler must reach this action's own body: {receipt.ReasonCode}");
    }

    [Fact]
    public void AnEmptyTile_IsRefusedByName()
    {
        using var world = TankWorld.Create();
        world.PutFishInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("fish_tank_target_not_found");
        receipt.Evidence.Should().Contain("blocked_by=none");
    }

    /// <summary>
    /// A bed, a sofa or a dresser is furniture on a tile and is NOT a tank. The native seam is an OVERRIDE on
    /// <c>FishTankFurniture</c> - a plain <c>StorageFurniture</c> has its own <c>checkForAction</c> that opens a menu - so a
    /// different piece is refused by name rather than driven through this one.
    /// </summary>
    [Fact]
    public void APieceThatIsNotATank_IsRefusedByName()
    {
        using var world = TankWorld.Create();
        world.PlacePlainFurniture(x: 2, y: 2);
        world.PutFishInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("fish_tank_target_is_not_a_tank");
        receipt.Evidence.Should().Contain("blocked_by=object:");
    }

    [Fact]
    public void StaleTargetId_IsRefusedByName()
    {
        using var world = TankWorld.Create();
        world.PlaceTank(x: 2, y: 2);
        world.PutFishInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2, expectedTargetId: "placed_furniture_0000000000000000");

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("fish_tank_target_changed");
    }

    /// <summary>
    /// The item is named by the slot it occupies AND by its own identity, because the native method deposits whatever is
    /// HELD: a slot whose stack changed under a waiting request would otherwise put something the caller never named into
    /// the tank.
    /// </summary>
    [Fact]
    public void ASlotHoldingSomethingElse_IsRefusedByName()
    {
        using var world = TankWorld.Create();
        world.PlaceTank(x: 2, y: 2);
        world.PutFishInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2, expectedQualifiedItemId: "(O)130");

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("fish_tank_item_not_owned_in_slot");
        receipt.Evidence.Should().Contain("slot_item=(O)129");
    }

    [Fact]
    public void AnEmptySlot_IsRefusedByName()
    {
        using var world = TankWorld.Create();
        world.PlaceTank(x: 2, y: 2);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("fish_tank_item_not_owned_in_slot");
    }

    [Fact]
    public void OutOfReach_IsRefusedByName()
    {
        using var world = TankWorld.Create();
        world.PlaceTank(x: 2, y: 2);
        world.PutFishInSlot(0);
        world.StandAt(14, 14);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("fish_tank_out_of_range");
    }

    /// <summary>
    /// The tank's own mutex, read BEFORE anything is written. The native method answers <c>true</c> and does nothing while
    /// the lock is held (FishTankFurniture.cs:231-234), so without this refusal a held tank would report as a silent
    /// no-op and the caller could not tell it from success.
    /// </summary>
    [Fact]
    public void ABusyTank_IsRefusedByNameAndTakesNothingFromThePack()
    {
        using var world = TankWorld.Create();
        FishTankFurniture tank = world.PlaceTank(x: 2, y: 2);
        world.PutFishInSlot(0);
        world.StandAt(2, 3);
        world.LockTank(tank);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("fish_tank_busy");
        world.CountFish().Should().Be(1, "a refused deposit consumes nothing");
        tank.heldItems.Count.Should().Be(0);
    }

    /// <summary>
    /// The tank's acceptance predicate IS reached and IS the engine's own: <c>CanBeDeposited</c> reads
    /// <c>Data/Aquarium</c> (FishTankFurniture.cs:360-363), which this process cannot load, so the honest answer is
    /// <c>Uncertain</c> with the exception named - never a claimed deposit, and never a silent no-op. The success path is
    /// the lane's native-local live gate.
    /// </summary>
    [Fact]
    public void TheTanksOwnPredicateIsReachedAndAnUnanswerableEngineIsReportedAsUncertain()
    {
        using var world = TankWorld.Create();
        FishTankFurniture tank = world.PlaceTank(x: 2, y: 2);
        world.PutFishInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        if (receipt.State == ExecutionState.Succeeded)
        {
            receipt.ReasonCode.Should().Be("fish_tank_item_deposited");
            tank.heldItems.Count.Should().Be(1);
        }
        else
        {
            receipt.State.Should().Be(ExecutionState.Uncertain, receipt.Evidence);
            receipt.ReasonCode.Should().BeOneOf("fish_tank_native_exception", "fish_tank_deposit_not_observed", "fish_tank_postcondition_not_observed");
            receipt.Evidence.Should().Contain("item=(O)129");
        }
    }

    /// <summary>
    /// The ORDER the body must keep, and the ONE piece of state it writes around the engine: the slot is made current for
    /// the native call and put back in a <c>finally</c>, so a throw cannot leave the actor holding a different item than
    /// it started with. Every refusal that can be answered without the world runs before that swap.
    /// </summary>
    [Fact]
    public void SourceShape_ValidatesBeforeSwappingTheHeldSlotAndRestoresItInAFinally()
    {
        string source = File.ReadAllText(RepositoryFile("integrations", "stardew", HandlerFile));
        string body = MethodBody(source, "public LocalExecutionReceipt RequestLocalPutItemInFishTank(");

        int tankCheck = body.IndexOf("fish_tank_target_changed", StringComparison.Ordinal);
        int itemCheck = body.IndexOf("fish_tank_item_not_owned_in_slot", StringComparison.Ordinal);
        int reach = body.IndexOf("tank.IsCloseEnoughToFarmer(Game1.player)", StringComparison.Ordinal);
        int busy = body.IndexOf("fish_tank_busy", StringComparison.Ordinal);
        int deposits = body.IndexOf("tank.CanBeDeposited(carried)", StringComparison.Ordinal);
        int room = body.IndexOf("tank.HasRoomForThisItem(carried)", StringComparison.Ordinal);
        int swap = body.IndexOf("Game1.player.CurrentToolIndex = slot;", StringComparison.Ordinal);
        int restore = body.IndexOf("Game1.player.CurrentToolIndex = previousSlot;", StringComparison.Ordinal);
        int native = body.IndexOf("tank.checkForAction(Game1.player)", StringComparison.Ordinal);
        int settle = body.IndexOf("tank.mutex.Update(location)", StringComparison.Ordinal);
        int read = body.IndexOf("int heldAfter = tank.heldItems.Count", StringComparison.Ordinal);

        foreach ((string step, int index) in new[]
                 {
                     ("target_changed", tankCheck),
                     ("item_not_owned", itemCheck),
                     ("furniture_reach", reach),
                     ("busy", busy),
                     ("can_be_deposited", deposits),
                     ("has_room", room),
                     ("slot_swap", swap),
                     ("slot_restore", restore),
                     ("checkForAction", native),
                     ("mutex_settle", settle),
                     ("held_items_read", read),
                 })
        {
            index.Should().BeGreaterThanOrEqualTo(0, $"{step} must exist in the body");
        }
        tankCheck.Should().BeLessThan(itemCheck, "the tank is resolved before the item it would receive");
        itemCheck.Should().BeLessThan(reach, "a request that carries nothing is refused before the reach is measured");
        reach.Should().BeLessThan(busy, "the actor has to be there before the tank's own lock matters");
        busy.Should().BeLessThan(swap, "a held tank is refused before anything is written");
        // THE ACCEPTANCE IS THE TANK'S OWN ANSWER, asked before the write: `CanBeDeposited` (:270-309) and
        // `HasRoomForThisItem` (:168-207) are the two rules the native method applies, and restating either here would be a
        // second opinion that agrees today and diverges the moment Data/Aquarium changes.
        deposits.Should().BeGreaterThanOrEqualTo(0, "the tank's own acceptance rule must be asked");
        room.Should().BeGreaterThan(deposits, "capacity is asked after acceptance, as the native method orders them");
        room.Should().BeLessThan(swap, "nothing is written until the tank has agreed to take the item");
        swap.Should().BeLessThan(native, "the named slot is made current before the native method reads the held item");
        native.Should().BeLessThan(restore, "the held slot is restored after the native call");
        restore.Should().BeLessThan(settle, "the engine's per-tick settlement runs after the slot is put back");
        settle.Should().BeLessThan(read, "the postcondition reads the tank after it has settled");
        body.Should().Contain("finally", "the slot restore must survive a throw from the native call");
        body.Should().NotContain("ShowMenu", "the tank's menu branch is not this action's native path");
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
    /// A real room with a real furniture collection holding a real <see cref="FishTankFurniture"/>, and a real pack holding
    /// one fish. The tank is built uninitialised and its NetFields are seeded: its public constructors reach
    /// <c>Data/Furniture</c> through <c>Furniture.InitializeAtTile</c>, and this process loads no content manager.
    /// </summary>
    private sealed class TankWorld : IDisposable
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

        private TankWorld()
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
            Game1.locationContextData = new Dictionary<string, StardewValley.GameData.LocationContexts.LocationContextData>(StringComparer.Ordinal);
            Game1.netWorldState.Value.GetWeatherForLocation("Default");
            Game1.locationContextData["Default"] = new StardewValley.GameData.LocationContexts.LocationContextData();
            // Daylight, which is what a room at 0:00 in this fixture has always been: `Furniture.OnAdded` -> `minutesElapsed`
            // asks `timeToTurnOnLights()` (Furniture.cs:834-845) and takes the removal branch when the day is light.
            Game1.timeOfDay = 600;

            var location = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Front", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            var floorSheet = new xTile.Tiles.TileSheet(
                "probe", map, "Maps/probe", new xTile.Dimensions.Size(64, 64), new xTile.Dimensions.Size(16, 16));
            map.AddTileSheet(floorSheet);
            xTile.Layers.Layer back = map.GetLayer("Back");
            for (int tileX = 0; tileX < 16; tileX++)
            for (int tileY = 0; tileY < 16; tileY++)
                back.Tiles[tileX, tileY] = new xTile.Tiles.StaticTile(back, floorSheet, xTile.Tiles.BlendMode.Alpha, 0);
            location.map = map;
            location.IsFarm = true;
            location.IsOutdoors = false;
            SetField(location, "name", new NetString("ProbeFarmHouse"));
            // A real `GameLocation` constructor runs its own NetField initializers, so this only fires for a field an
            // uninitialized instance would have been missing; it stays because `Furniture.OnAdded` -> `minutesElapsed` ->
            // `removeLights` reaches the location's light bookkeeping for a TANK specifically (Furniture.cs:1100-1108), and a
            // null collection there is an engine NRE rather than a refusal this action could name.
            SeedMissingNetFields(location);
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

            actor.position.Set(new Vector2(2 * 64 + 8, 3 * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            WorldReadyPerScreen.GetValue(null)!.GetType()
                .GetMethod("SetValueForScreen", new[] { typeof(int), typeof(bool) })!
                .Invoke(WorldReadyPerScreen.GetValue(null), new object[] { Context.ScreenId, true });
            Context.IsWorldReady.Should().BeTrue("the headless world must satisfy the readiness gate the body checks");
        }

        internal static TankWorld Create() => new();

        /// <summary>
        /// A real <see cref="FishTankFurniture"/> in the location's own furniture collection: two tiles wide, because the
        /// tank's own capacity is <c>getTilesWide() - 1</c> per category (FishTankFurniture.cs:117-139) and a one-wide tank
        /// has room for nothing at all.
        /// </summary>
        internal FishTankFurniture PlaceTank(int x, int y)
        {
            var tank = (FishTankFurniture)FormatterServices.GetUninitializedObject(typeof(FishTankFurniture));
            SeedMissingNetFields(tank);
            SetField(tank, "itemId", new NetString(TankItemId[3..]));
            SetField(tank, "netName", new NetString("Fish Tank"));
            SetField(tank, "stack", new NetInt(1));
            SetField(tank, "parentSheetIndex", new NetInt(int.Parse(TankItemId[3..], System.Globalization.CultureInfo.InvariantCulture)));
            SetField(tank, "tileLocation", new NetVector2 { Value = new Vector2(x, y) });
            SetField(tank, "boundingBox", new NetRectangle { Value = new Rectangle(x * 64, y * 64, 128, 64) });
            SetField(tank, "defaultBoundingBox", new NetRectangle { Value = new Rectangle(x * 64, y * 64, 128, 64) });
            SetField(tank, "heldObject", new NetRef<StardewValley.Object>());
            SetField(tank, "fragility", new NetInt(0));
            SetField(tank, "furniture_type", new NetInt(0));
            SetField(tank, "rotations", new NetInt(1));
            SetField(tank, "currentRotation", new NetInt(0));
            SetField(tank, "mutex", new NetMutex());
            SetField(tank, "localDepositedItem", null!);
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(tank, TankItemId);
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(tank, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(tank, false);
            typeof(Furniture).GetField("_placementRestriction", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(tank, 0);
            typeof(Item).GetProperty("ItemId", BindingFlags.Instance | BindingFlags.Public)!
                .SetValue(tank, TankItemId[3..]);
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(tank, TankItemId);
            tank.HasBeenInInventory = true;
            // The sitting farmers are a NetField whose initializer an uninitialized instance never ran, and the TANK branch of
            // `Furniture.removeLights` (reached from `OnAdded` -> `minutesElapsed` -> `timeToTurnOnLights`, Furniture.cs:202,
            // :1112-1126, :1072-1108) reads it. A chair never reaches that branch, which is why the rotation harness did not
            // need this field.
            SetField(tank, "sittingFarmers", new NetLongDictionary<int, NetInt>());
            // Every remaining plain collection the tank declares as a field INITIALIZER (`bubbles`, `tankFish`,
            // `_fishLookup`, `floorDecorations`, `decorationSlots`, `floorDecorationIndices`,
            // FishTankFurniture.cs:28-59). An uninitialized instance never ran those, and the tank's own light/refresh
            // bookkeeping walks them from `OnAdded` - which is why a chair in the same room never needed this.
            SeedPlainCollections(tank);
            // The INSERT COMPLETES BEFORE THE HOOK RUNS - `NetDictionary.added` fires `OnValueAdded` after the entry is in the
            // map - and only the engine's light bookkeeping inside `Furniture.OnAdded` -> `minutesElapsed` ->
            // `removeLights` throws here, because that branch needs a light world this process does not build. So the hook's
            // failure is tolerated ONLY when the piece really is in the collection; an insert that did not land still throws,
            // because then the fixture would be lying about the world the action reads.
            try
            {
                this.Location.furniture.Add(tank);
            }
            catch (NullReferenceException lightBookkeeping)
            {
                if (!this.Location.furniture.Contains(tank)) throw;
                _ = lightBookkeeping;
            }
            this.Location.furniture.Contains(tank).Should().BeTrue("the tank must really be part of the room");
            return tank;
        }

        /// <summary>A real furniture piece that is NOT a tank, so a request can be refused for aiming at the wrong thing.</summary>
        internal void PlacePlainFurniture(int x, int y)
        {
            var piece = (Furniture)FormatterServices.GetUninitializedObject(typeof(Furniture));
            SeedMissingNetFields(piece);
            SetField(piece, "itemId", new NetString("0"));
            SetField(piece, "netName", new NetString("Chair"));
            SetField(piece, "stack", new NetInt(1));
            SetField(piece, "parentSheetIndex", new NetInt(0));
            SetField(piece, "tileLocation", new NetVector2 { Value = new Vector2(x, y) });
            SetField(piece, "boundingBox", new NetRectangle { Value = new Rectangle(x * 64, y * 64, 64, 64) });
            SetField(piece, "defaultBoundingBox", new NetRectangle { Value = new Rectangle(x * 64, y * 64, 64, 64) });
            SetField(piece, "heldObject", new NetRef<StardewValley.Object>());
            SetField(piece, "fragility", new NetInt(0));
            SetField(piece, "furniture_type", new NetInt(0));
            SetField(piece, "rotations", new NetInt(2));
            SetField(piece, "currentRotation", new NetInt(0));
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(piece, "(F)0");
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(piece, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(piece, false);
            typeof(Furniture).GetField("_placementRestriction", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(piece, 0);
            piece.HasBeenInInventory = true;
            try
            {
                this.Location.furniture.Add(piece);
            }
            catch (NullReferenceException)
            {
                if (!this.Location.furniture.Contains(piece)) throw;
            }
            this.Location.furniture.Contains(piece).Should().BeTrue("the piece must really be part of the room");
        }

        /// <summary>One fish in the pack, so the deposit has something to take.</summary>
        internal void PutFishInSlot(int slot)
        {
            var fish = (StardewValley.Object)FormatterServices.GetUninitializedObject(typeof(StardewValley.Object));
            SeedMissingNetFields(fish);
            SetField(fish, "itemId", new NetString(FishItemId[3..]));
            SetField(fish, "netName", new NetString("Anchovy"));
            SetField(fish, "stack", new NetInt(1));
            SetField(fish, "parentSheetIndex", new NetInt(int.Parse(FishItemId[3..], System.Globalization.CultureInfo.InvariantCulture)));
            SetField(fish, "tileLocation", new NetVector2());
            SetField(fish, "heldObject", new NetRef<StardewValley.Object>());
            SetField(fish, "fragility", new NetInt(0));
            SetField(fish, "bigCraftable", new NetBool(false));
            typeof(Item).GetProperty("ItemId", BindingFlags.Instance | BindingFlags.Public)!
                .SetValue(fish, FishItemId[3..]);
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(fish, FishItemId);
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(fish, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(fish, false);
            Game1.player.Items[slot] = fish;
            Game1.player.CurrentToolIndex = 0;
        }

        /// <summary>
        /// Holds the tank's own mutex, which is the state <c>checkForAction</c> answers <c>true</c> to while doing nothing
        /// (FishTankFurniture.cs:231-234). <c>NetMutex.owner</c> is private, so the lock is taken by writing it the way
        /// <c>RequestLock</c> would.
        /// </summary>
        internal void LockTank(FishTankFurniture tank)
        {
            FieldInfo owner = typeof(NetMutex).GetField("owner", BindingFlags.Instance | BindingFlags.NonPublic)!;
            ((NetLong)owner.GetValue(tank.mutex)!).Value = 4242L;
        }

        internal int CountFish()
        {
            int count = 0;
            for (int slot = 0; slot < Game1.player.Items.Count; slot++)
                if (Game1.player.Items[slot] is Item carried && carried.QualifiedItemId == FishItemId)
                    count += carried.Stack;
            return count;
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

        internal LocalExecutionReceipt Request(int x, int y, string? expectedTargetId = null, string? expectedQualifiedItemId = null) =>
            this.Manager().RequestLocalPutItemInFishTank(
                $"req_tank_{x}_{y}_{expectedTargetId ?? "live"}_{expectedQualifiedItemId ?? "live"}",
                0,
                x,
                y,
                expectedQualifiedItemId ?? FishItemId,
                expectedTargetId ?? this.TargetIdOrSynthetic(x, y),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);

        internal LocalExecutionReceipt DispatchThroughTheResourceToolHandler(int x, int y)
        {
            ExecutionManager executions = this.Manager();
            var request = new BridgeExecutionRequest(
                $"req_tank_handler_{x}_{y}",
                $"idem_tank_handler_{x}_{y}",
                ActionId,
                new BridgeExecutionArgs { X = x, Y = y, Slot = 0, ExpectedQualifiedItemId = FishItemId, ExpectedTargetId = this.TargetIdAt(x, y) },
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

        /// <summary>
        /// Gives every null plain collection field on <paramref name="instance"/> the value its own field initializer
        /// would have. `FormatterServices.GetUninitializedObject` skips initializers, and a `FishTankFurniture` keeps six
        /// collections that way (FishTankFurniture.cs:28-59) while the engine's own `OnAdded` bookkeeping walks them.
        /// </summary>
        private static void SeedPlainCollections(object instance)
        {
            foreach (FieldInfo field in instance.GetType().GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            {
                if (field.GetValue(instance) is not null) continue;
                Type type = field.FieldType;
                if (!type.IsGenericType) continue;
                Type definition = type.GetGenericTypeDefinition();
                if (definition != typeof(List<>) && definition != typeof(Dictionary<,>)) continue;
                if (type.GetConstructor(Type.EmptyTypes) is null) continue;
                field.SetValue(instance, Activator.CreateInstance(type));
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
            if (instance is Item item)
            {
                FieldInfo? backing = typeof(Item).GetField("<NetFields>k__BackingField", BindingFlags.Instance | BindingFlags.NonPublic);
                if (backing is not null && backing.GetValue(item) is null) backing.SetValue(item, new NetFields("Item"));
            }
        }

        private static void SetField(object target, string name, object value)
        {
            FieldInfo? field = target.GetType().GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (field is null) throw new InvalidOperationException($"{target.GetType().Name} has no field {name}");
            field.SetValue(target, value);
        }
    }
}
