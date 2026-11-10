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
/// <c>place_item_on_pedestal</c>: putting one carried item onto a placed pedestal through the pedestal's own
/// <c>ItemPedestal.performObjectDropInAction</c> (ItemPedestal.cs:82-124).
///
/// <para>
/// THE BRANCH A CALLER MUST NEVER REACH. While the pedestal already holds something, the native occupied arm is
/// <c>if (heldObject.Value != null && !probe) { DropObject(who); return false; }</c> (:97-101): it KNOCKS THE EXISTING ITEM
/// OFF and then answers false, so a naive call would trade the displayed item for no deposit at all. The action refuses an
/// occupied pedestal by name before it calls anything - and that is what <c>AnOccupiedPedestalIsRefusedAndKeepsItsItem</c>
/// drives, asserting the item is still there afterwards.
/// </para>
///
/// <para>
/// THE ACCEPTANCE IS THE PEDESTAL'S. <c>probe: true</c> runs its two guards without writing - the item must be trashable
/// (:93-96) and must be EXACTLY a plain <c>StardewValley.Object</c> (:102), which is why a hat, a piece of clothing or a
/// piece of furniture is refused rather than placed. <c>ThePedestalsExactTypeRuleIsReachedAndNamesTheReason</c> drives that
/// with a real <c>Furniture</c>, so the refusal is the engine's own answer, not a rule restated here.
/// </para>
///
/// <para>
/// WHAT IS NOT PROVEN HERE: the settled deposit. The write lives in <c>itemModifyMutex.RequestLock</c>'s acquired callback
/// (:107-113) and the callback's first statement is <c>location.playSound("woodyStep")</c>, which needs a sound bank this
/// process does not have; the action drives the engine's own <c>NetMutex.Update</c> once (the call
/// <c>ItemPedestal.updateWhenCurrentLocation</c> makes every tick, :195-201) and reports the honest <c>Uncertain</c>. That
/// same throw is what puts the CONSUMPTION line out of reach here, so which slot the deposit spends is driven directly in
/// <c>TheConsumptionSpendsTheNamedSlotAndLeavesTheHeldItemAlone</c> rather than through the action. The success path
/// belongs to the lane's native-local live gate, like the sibling placement, rotation, fence and tank mutations.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the shape pins below read the catalogue and handler source so a rename or a dropped declaration fails here, while the behaviour tests drive the handler and assert its postcondition; they are kept together because either half alone can be green while the action is wrong.
public sealed class PlaceItemOnPedestalActionTests
{
    private const string ActionId = "place_item_on_pedestal";
    private const string HandlerFile = "farmhandexecutioncontroller.furnituredecorationactions.cs";
    private const string ItemId = "(O)129";
    private const string PedestalItemId = "(BC)221";

    [Fact]
    public void Catalog_RegistersThePedestalPlacementWithTheItemSlotAndThePedestalsIdentity()
    {
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == ActionId);

        registration.FamilyId.Should().Be("buildings_farm_management");
        registration.Kind.Should().Be(FarmhandOperationKind.Execution);
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        registration.Descriptor!.Arguments.Select(argument => argument.Name)
            .Should().Equal(new[] { "x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId" });
        registration.Descriptor.Postcondition.Should().Be("pedestal_item_placed");
        registration.Descriptor.NativeBinding.Should().Be("ItemPedestal.performObjectDropInAction");
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
    public void Handler_RoutesThePedestalPlacementToItsExecutionBody()
    {
        using var world = PedestalWorld.Create();
        world.PlacePedestal(x: 2, y: 2);
        world.PutItemInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.DispatchThroughTheResourceToolHandler(2, 2);

        receipt.ReasonCode.Should().NotBe("unsupported_action", "the resource-tool handler must own this action id");
        receipt.ReasonCode.Should().NotBe("world_not_ready", "the harness must satisfy the actor guard");
        (receipt.ReasonCode == "pedestal_item_placed" || receipt.ReasonCode.StartsWith("pedestal", StringComparison.Ordinal))
            .Should().BeTrue($"the handler must reach this action's own body: {receipt.ReasonCode}");
    }

    [Fact]
    public void AnEmptyTile_IsRefusedByName()
    {
        using var world = PedestalWorld.Create();
        world.PutItemInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("pedestal_target_not_found");
        receipt.Evidence.Should().Contain("blocked_by=none");
    }

    [Fact]
    public void AnotherObjectOnTheTile_IsRefusedByName()
    {
        using var world = PedestalWorld.Create();
        world.PlaceOrdinaryObject(x: 2, y: 2);
        world.PutItemInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("pedestal_target_is_not_a_pedestal");
        receipt.Evidence.Should().Contain("blocked_by=object:");
    }

    [Fact]
    public void StaleTargetId_IsRefusedByName()
    {
        using var world = PedestalWorld.Create();
        world.PlacePedestal(x: 2, y: 2);
        world.PutItemInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2, expectedTargetId: "pedestal_deposit_0000000000000000");

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("pedestal_target_changed");
    }

    [Fact]
    public void ASlotHoldingSomethingElse_IsRefusedByName()
    {
        using var world = PedestalWorld.Create();
        world.PlacePedestal(x: 2, y: 2);
        world.PutItemInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2, expectedQualifiedItemId: "(O)130");

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("pedestal_item_not_owned_in_slot");
    }

    /// <summary>
    /// THE CRITICAL CASE. The native occupied arm knocks the displayed item off and answers false
    /// (ItemPedestal.cs:97-101), so a caller that reached it would lose the display. The refusal names the state and the
    /// item is untouched.
    /// </summary>
    [Fact]
    public void AnOccupiedPedestalIsRefusedAndKeepsItsItem()
    {
        using var world = PedestalWorld.Create();
        ItemPedestal pedestal = world.PlacePedestal(x: 2, y: 2);
        StardewValley.Object displayed = world.GiveThePedestalAnItem(pedestal, "(O)132");
        world.PutItemInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("pedestal_occupied");
        receipt.Evidence.Should().Contain("held=(O)132");
        pedestal.heldObject.Value.Should().BeSameAs(displayed, "the displayed item must not be knocked off");
        world.CountItem().Should().Be(1, "a refused placement consumes nothing");
    }

    [Fact]
    public void ALockedPedestalIsRefusedByName()
    {
        using var world = PedestalWorld.Create();
        world.PlacePedestal(x: 2, y: 2, locked: true);
        world.PutItemInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("pedestal_locked");
    }

    /// <summary>
    /// The pedestal's own mutex, read before anything is written: while it is held the native method parks the write in
    /// <c>RequestLock</c>, whose FAILURE callback drops the item as debris (:113-119) rather than refusing.
    /// </summary>
    [Fact]
    public void ABusyPedestalIsRefusedByNameAndTakesNothingFromThePack()
    {
        using var world = PedestalWorld.Create();
        ItemPedestal pedestal = world.PlacePedestal(x: 2, y: 2);
        world.PutItemInSlot(0);
        world.StandAt(2, 3);
        world.LockPedestal(pedestal);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("pedestal_busy");
        world.CountItem().Should().Be(1);
        pedestal.heldObject.Value.Should().BeNull();
    }

    [Fact]
    public void OutOfReach_StartsTheApproachLegAndLeavesThePedestalEmpty()
    {
        using var world = PedestalWorld.Create();
        ItemPedestal pedestal = world.PlacePedestal(x: 2, y: 2);
        world.PutItemInSlot(0);
        world.StandAt(14, 14);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Accepted, "an out-of-reach placement walks in first");
        pedestal.heldObject.Value.Should().BeNull();
    }

    /// <summary>
    /// THE PEDESTAL'S EXACT-TYPE RULE, reached through its own <c>probe: true</c>. <c>performObjectDropInAction</c> tests
    /// <c>dropInItem.GetType() == typeof(Object)</c> (:102), so a <c>Furniture</c> is refused by the engine - not by a rule
    /// restated in this action - and nothing is written.
    /// </summary>
    [Fact]
    public void ThePedestalsExactTypeRuleIsReachedAndNamesTheReason()
    {
        using var world = PedestalWorld.Create();
        ItemPedestal pedestal = world.PlacePedestal(x: 2, y: 2);
        world.PutHatInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2, expectedQualifiedItemId: "(H)0");

        receipt.State.Should().Be(ExecutionState.Rejected, receipt.Evidence);
        receipt.ReasonCode.Should().Be("pedestal_rejects_item");
        receipt.Evidence.Should().Contain("item_type=Hat");
        pedestal.heldObject.Value.Should().BeNull("the probe wrote nothing");
        world.CountItemById("(H)0").Should().Be(1, "a refused placement consumes nothing");
    }

    /// <summary>
    /// The native call IS reached for an item the pedestal accepts, and this process cannot finish it (the acquired
    /// callback's first statement is <c>location.playSound</c>), so the honest outcome is <c>Uncertain</c> with the reason
    /// named - never a claimed placement, and never a silent no-op.
    /// </summary>
    [Fact]
    public void TheNativeCallIsReachedAndAnUnfinishableDepositIsReportedAsUncertain()
    {
        using var world = PedestalWorld.Create();
        ItemPedestal pedestal = world.PlacePedestal(x: 2, y: 2);
        world.PutItemInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        if (receipt.State == ExecutionState.Succeeded)
        {
            receipt.ReasonCode.Should().Be("pedestal_item_placed");
            pedestal.heldObject.Value.Should().NotBeNull();
        }
        else
        {
            receipt.State.Should().Be(ExecutionState.Uncertain, receipt.Evidence);
            receipt.ReasonCode.Should().BeOneOf("pedestal_native_exception", "pedestal_deposit_not_observed", "pedestal_postcondition_not_observed");
            receipt.Evidence.Should().Contain("item=(O)129");
        }
    }

    /// <summary>
    /// THE CONSUMPTION RULE ITSELF, DRIVEN DIRECTLY.
    ///
    /// <para>
    /// The action-level case cannot reach this line in this process: the deposit's write lives in the pedestal's
    /// <c>itemModifyMutex</c> callback, whose first statement is <c>location.playSound("woodyStep")</c>, so the
    /// engine's own <c>NetMutex.Update</c> throws before the pack is touched (see the class summary). What CAN be
    /// driven is the one production seam that decides WHICH slot is spent - the rule the defect was about - against a
    /// real pack: the slot the caller named loses one unit and the item in the actor's hand does not.
    /// </para>
    /// <para>
    /// The engine's counterpart, <c>Farmer.reduceActiveItemByOne</c> (Farmer.cs:5083), spends <c>CurrentItem</c> - the
    /// hand - and clears the slot through <c>removeItemFromInventory</c> (Farmer.cs:5105-5116) when the stack runs out.
    /// Both halves are asserted, because a version that decremented the right slot and left it at zero would still be
    /// wrong.
    /// </para>
    /// </summary>
    [Fact]
    public void TheConsumptionSpendsTheNamedSlotAndLeavesTheHeldItemAlone()
    {
        using var world = PedestalWorld.Create();
        world.PutObjectInSlot(2, "(O)421", stack: 2);
        world.PutObjectInSlot(3, "(O)422", stack: 1);
        world.PutObjectInSlot(5, "(O)74", stack: 1);
        world.HoldSlot(5);
        MethodInfo consume = typeof(ExecutionManager)
            .GetMethod("ConsumeOneFromSlot", BindingFlags.NonPublic | BindingFlags.Static)!;

        consume.Invoke(null, new object[] { 2 });

        world.CountItemById("(O)74").Should().Be(1, "the held shard is not what the caller asked to deposit");
        world.CountItemById("(O)421").Should().Be(1, "the named slot paid one unit of the two it held");

        consume.Invoke(null, new object[] { 3 });

        Game1.player.Items[3].Should().BeNull("an emptied slot is cleared, as `removeItemFromInventory` does (Farmer.cs:5105-5116)");
        world.CountItemById("(O)74").Should().Be(1, "and the hand is still untouched");
    }

    /// <summary>
    /// The ORDER the body must keep, and the one thing that must happen before any write: the occupied check. Its position
    /// is the whole point - past it lies the branch that knocks the displayed item off.
    /// </summary>
    [Fact]
    public void SourceShape_RefusesAnOccupiedPedestalBeforeTheNativeCall()
    {
        string source = File.ReadAllText(RepositoryFile("integrations", "stardew", HandlerFile));
        string execute = MethodBody(source, "private LocalExecutionReceipt ExecutePlaceItemOnPedestal(");

        string predicate = MethodBody(source, "private static bool TryDescribePedestal(");
        predicate.Should().Contain("pedestal_target_changed", "the pedestal's own id is proved before anything else");
        int targetCheck = execute.IndexOf("TryDescribePedestal(", StringComparison.Ordinal);
        int reach = execute.IndexOf("IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1)", StringComparison.Ordinal);
        int occupied = execute.IndexOf("pedestal!.heldObject.Value is not null", StringComparison.Ordinal);
        int occupiedCode = execute.IndexOf("\"pedestal_occupied\"", StringComparison.Ordinal);
        int locked = execute.IndexOf("pedestal.locked.Value", StringComparison.Ordinal);
        int busy = execute.IndexOf("pedestal.itemModifyMutex.IsLocked()", StringComparison.Ordinal);
        int probe = execute.IndexOf("probe: true", StringComparison.Ordinal);
        int write = execute.IndexOf("probe: false", StringComparison.Ordinal);
        int settle = execute.IndexOf("pedestal.itemModifyMutex.Update(location)", StringComparison.Ordinal);
        int consume = execute.IndexOf("ConsumeOneFromSlot(slot)", StringComparison.Ordinal);
        int read = execute.IndexOf("pedestal.heldObject.Value is StardewValley.Object placed", StringComparison.Ordinal);

        foreach ((string step, int index) in new[]
                 {
                     ("describes_the_pedestal", targetCheck),
                     ("reach", reach),
                     ("occupied", occupied),
                     ("occupied_code", occupiedCode),
                     ("locked", locked),
                     ("busy", busy),
                     ("probe", probe),
                     ("write", write),
                     ("settle", settle),
                     ("consume", consume),
                     ("postcondition_read", read),
                 })
        {
            index.Should().BeGreaterThanOrEqualTo(0, $"{step} must exist in the body");
        }
        targetCheck.Should().BeLessThan(occupied, "the pedestal - and with it the id - is proved before its contents are read");
        occupied.Should().BeLessThan(occupiedCode, "the check produces its own named refusal");
        occupiedCode.Should().BeLessThan(probe, "an occupied pedestal is refused before the pedestal is asked anything");
        locked.Should().BeLessThan(busy, "the pedestal's own lock is read before its mutex");
        busy.Should().BeLessThan(probe, "a busy pedestal is refused before anything is written");
        probe.Should().BeLessThan(write, "the pedestal's verdict is asked before the write");
        write.Should().BeLessThan(settle, "the engine's per-tick settlement runs after the write");
        settle.Should().BeLessThan(consume, "the stack is reduced only once the deposit has settled");
        consume.Should().BeLessThan(read, "the postcondition reads the pedestal after the pack was reduced");
        execute.Should().NotContain("pedestal.DropObject(", "the occupied branch's eject must never be reachable from this action");
        execute.Should().NotContain("heldObject.Value = null", "this action never clears the pedestal to make room");
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
    private sealed class PedestalWorld : IDisposable
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

        private PedestalWorld()
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

        internal static PedestalWorld Create() => new();

        /// <summary>
        /// A real <see cref="FishTankFurniture"/> in the location's own furniture collection: two tiles wide, because the
        /// tank's own capacity is <c>getTilesWide() - 1</c> per category (FishTankFurniture.cs:117-139) and a one-wide tank
        /// has room for nothing at all.
        /// </summary>
        internal ItemPedestal PlacePedestal(int x, int y, bool locked = false)
        {
            var pedestal = (ItemPedestal)FormatterServices.GetUninitializedObject(typeof(ItemPedestal));
            SeedMissingNetFields(pedestal);
            SetField(pedestal, "itemId", new NetString("221"));
            SetField(pedestal, "netName", new NetString("Item Pedestal"));
            SetField(pedestal, "stack", new NetInt(1));
            SetField(pedestal, "parentSheetIndex", new NetInt(221));
            SetField(pedestal, "tileLocation", new NetVector2 { Value = new Vector2(x, y) });
            SetField(pedestal, "boundingBox", new NetRectangle { Value = new Rectangle(x * 64, y * 64, 64, 64) });
            SetField(pedestal, "heldObject", new NetRef<StardewValley.Object>());
            SetField(pedestal, "fragility", new NetInt(0));
            SetField(pedestal, "bigCraftable", new NetBool(true));
            SetField(pedestal, "itemModifyMutex", new NetMutex());
            SetField(pedestal, "requiredItem", new NetRef<StardewValley.Object>());
            SetField(pedestal, "successColor", new NetColor());
            SetField(pedestal, "lockOnSuccess", new NetBool(false));
            SetField(pedestal, "locked", new NetBool(locked));
            SetField(pedestal, "match", new NetBool(false));
            SetField(pedestal, "isIslandShrinePedestal", new NetBool(false));
            typeof(Item).GetProperty("ItemId", BindingFlags.Instance | BindingFlags.Public)!
                .SetValue(pedestal, "221");
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(pedestal, "(BC)221");
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(pedestal, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(pedestal, false);
            SetField(pedestal, "type", new NetString("Crafting"));
            this.Location.objects[new Vector2(x, y)] = pedestal;
            return pedestal;
        }

        /// <summary>A plain object on the tile, so a request can be refused for aiming at the wrong thing.</summary>
        internal void PlaceOrdinaryObject(int x, int y)
        {
            var placed = (StardewValley.Object)FormatterServices.GetUninitializedObject(typeof(StardewValley.Object));
            SeedMissingNetFields(placed);
            SetField(placed, "itemId", new NetString("130"));
            SetField(placed, "netName", new NetString("Chest"));
            SetField(placed, "stack", new NetInt(1));
            SetField(placed, "parentSheetIndex", new NetInt(130));
            SetField(placed, "tileLocation", new NetVector2 { Value = new Vector2(x, y) });
            SetField(placed, "boundingBox", new NetRectangle { Value = new Rectangle(x * 64, y * 64, 64, 64) });
            SetField(placed, "heldObject", new NetRef<StardewValley.Object>());
            SetField(placed, "fragility", new NetInt(0));
            SetField(placed, "bigCraftable", new NetBool(true));
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(placed, "(BC)130");
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(placed, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(placed, false);
            this.Location.objects[new Vector2(x, y)] = placed;
        }

        /// <summary>One plain object in the pack, so the deposit has something to place.</summary>
        internal void PutItemInSlot(int slot)
        {
            var fish = (StardewValley.Object)FormatterServices.GetUninitializedObject(typeof(StardewValley.Object));
            SeedMissingNetFields(fish);
            SetField(fish, "itemId", new NetString(ItemId[3..]));
            SetField(fish, "netName", new NetString("Anchovy"));
            SetField(fish, "stack", new NetInt(1));
            SetField(fish, "parentSheetIndex", new NetInt(int.Parse(ItemId[3..], System.Globalization.CultureInfo.InvariantCulture)));
            SetField(fish, "tileLocation", new NetVector2());
            SetField(fish, "heldObject", new NetRef<StardewValley.Object>());
            SetField(fish, "fragility", new NetInt(0));
            SetField(fish, "bigCraftable", new NetBool(false));
            typeof(Item).GetProperty("ItemId", BindingFlags.Instance | BindingFlags.Public)!
                .SetValue(fish, ItemId[3..]);
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(fish, ItemId);
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(fish, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(fish, false);
            Game1.player.Items[slot] = fish;
            Game1.player.CurrentToolIndex = 0;
        }

        /// <summary>
        /// One plain object of the caller's choosing in a NAMED slot, at the caller's stack. The pedestal is handed the
        /// item out of the slot a request names, so a fixture that can only fill slot 0 could not tell the two apart.
        /// </summary>
        internal void PutObjectInSlot(int slot, string qualifiedItemId, int stack)
        {
            var item = (StardewValley.Object)FormatterServices.GetUninitializedObject(typeof(StardewValley.Object));
            SeedMissingNetFields(item);
            SetField(item, "itemId", new NetString(qualifiedItemId[3..]));
            SetField(item, "netName", new NetString("Slot Item"));
            SetField(item, "stack", new NetInt(stack));
            SetField(item, "parentSheetIndex", new NetInt(int.Parse(qualifiedItemId[3..], System.Globalization.CultureInfo.InvariantCulture)));
            SetField(item, "tileLocation", new NetVector2());
            SetField(item, "heldObject", new NetRef<StardewValley.Object>());
            SetField(item, "fragility", new NetInt(0));
            SetField(item, "bigCraftable", new NetBool(false));
            typeof(Item).GetProperty("ItemId", BindingFlags.Instance | BindingFlags.Public)!
                .SetValue(item, qualifiedItemId[3..]);
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(item, qualifiedItemId);
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(item, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(item, false);
            Game1.player.Items[slot] = item;
        }

        /// <summary>Puts the actor's HAND on a pack slot, which is what `ActiveItem` and `reduceActiveItemByOne` read.</summary>
        internal void HoldSlot(int slot) => Game1.player.CurrentToolIndex = slot;

        /// <summary>
        /// Holds the tank's own mutex, which is the state <c>checkForAction</c> answers <c>true</c> to while doing nothing
        /// (FishTankFurniture.cs:231-234). <c>NetMutex.owner</c> is private, so the lock is taken by writing it the way
        /// <c>RequestLock</c> would.
        /// </summary>
        internal void LockPedestal(ItemPedestal pedestal)
        {
            FieldInfo owner = typeof(NetMutex).GetField("owner", BindingFlags.Instance | BindingFlags.NonPublic)!;
            ((NetLong)owner.GetValue(pedestal.itemModifyMutex)!).Value = 4242L;
        }

        internal int CountItem()
        {
            int count = 0;
            for (int slot = 0; slot < Game1.player.Items.Count; slot++)
                if (Game1.player.Items[slot] is Item carried && carried.QualifiedItemId == ItemId)
                    count += carried.Stack;
            return count;
        }

        /// <summary>An object already displayed on the pedestal, so the occupied branch can be driven.</summary>
        internal StardewValley.Object GiveThePedestalAnItem(ItemPedestal pedestal, string qualifiedItemId)
        {
            var displayed = (StardewValley.Object)FormatterServices.GetUninitializedObject(typeof(StardewValley.Object));
            SeedMissingNetFields(displayed);
            SetField(displayed, "itemId", new NetString(qualifiedItemId[3..]));
            SetField(displayed, "netName", new NetString("Displayed"));
            SetField(displayed, "stack", new NetInt(1));
            SetField(displayed, "parentSheetIndex", new NetInt(int.Parse(qualifiedItemId[3..], System.Globalization.CultureInfo.InvariantCulture)));
            SetField(displayed, "tileLocation", new NetVector2());
            SetField(displayed, "heldObject", new NetRef<StardewValley.Object>());
            SetField(displayed, "fragility", new NetInt(0));
            SetField(displayed, "bigCraftable", new NetBool(false));
            typeof(Item).GetProperty("ItemId", BindingFlags.Instance | BindingFlags.Public)!
                .SetValue(displayed, qualifiedItemId[3..]);
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(displayed, qualifiedItemId);
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(displayed, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(displayed, false);
            pedestal.heldObject.Value = displayed;
            return displayed;
        }

        /// <summary>
        /// One HAT in the pack. A `Hat` is an `Item` but not a plain `StardewValley.Object`, which is exactly the
        /// distinction the pedestal's own `GetType() == typeof(Object)` test makes (ItemPedestal.cs:102). A hat rather than
        /// a piece of furniture because a Furniture's own `canBeTrashed()` reaches the item registry, and that would be this
        /// process's content gap answering instead of the pedestal.
        /// </summary>
        internal void PutHatInSlot(int slot)
        {
            var piece = (Hat)FormatterServices.GetUninitializedObject(typeof(Hat));
            SeedMissingNetFields(piece);
            SetField(piece, "itemId", new NetString("0"));
            SetField(piece, "netName", new NetString("Cap"));
            SetField(piece, "stack", new NetInt(1));
            SetField(piece, "parentSheetIndex", new NetInt(0));
            typeof(Item).GetProperty("ItemId", BindingFlags.Instance | BindingFlags.Public)!
                .SetValue(piece, "0");
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(piece, "(H)0");
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(piece, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(piece, false);
            Game1.player.Items[slot] = piece;
            Game1.player.CurrentToolIndex = 0;
        }

        internal int CountItemById(string qualifiedItemId)
        {
            int count = 0;
            for (int slot = 0; slot < Game1.player.Items.Count; slot++)
                if (Game1.player.Items[slot] is Item carried && carried.QualifiedItemId == qualifiedItemId)
                    count += carried.Stack;
            return count;
        }

        internal void StandAt(int x, int y) => Game1.player.position.Set(new Vector2(x * 64 + 8, y * 64));

        /// <summary>The target id the snapshot publishes for this tile, read off the production builder.</summary>
        internal string TargetIdAt(int x, int y) => ExecutionManager.BuildPedestalDepositTargetId(
            this.Location,
            x,
            y,
            this.Location.objects[new Vector2(x, y)] as ItemPedestal
                ?? throw new InvalidOperationException($"no pedestal stands on {x},{y}"));

        private string TargetIdOrSynthetic(int x, int y) =>
            this.Location.objects.ContainsKey(new Vector2(x, y))
                && this.Location.objects[new Vector2(x, y)] is ItemPedestal
                ? this.TargetIdAt(x, y)
                : "pedestal_deposit_0000000000000000";

        internal LocalExecutionReceipt Request(int x, int y, string? expectedTargetId = null, string? expectedQualifiedItemId = null, int slot = 0) =>
            this.Manager().RequestLocalPlaceItemOnPedestal(
                $"req_pedestal_{x}_{y}_{slot}_{expectedTargetId ?? "live"}_{expectedQualifiedItemId ?? "live"}",
                slot,
                x,
                y,
                expectedQualifiedItemId ?? ItemId,
                expectedTargetId ?? this.TargetIdOrSynthetic(x, y),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);

        internal LocalExecutionReceipt DispatchThroughTheResourceToolHandler(int x, int y)
        {
            ExecutionManager executions = this.Manager();
            var request = new BridgeExecutionRequest(
                $"req_pedestal_handler_{x}_{y}",
                $"idem_pedestal_handler_{x}_{y}",
                ActionId,
                new BridgeExecutionArgs { X = x, Y = y, Slot = 0, ExpectedQualifiedItemId = ItemId, ExpectedTargetId = this.TargetIdAt(x, y) },
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
