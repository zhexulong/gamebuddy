using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Navigation;
using Microsoft.Xna.Framework;
using Netcode;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Two actions gate on a distance and are classified OPPOSITELY on purpose, so that a later "tidy up" cannot
/// unify them into a defect.
///
/// <para>
/// <c>pickup_forage</c> DECLARES that it closes the distance (<c>self_walked</c>) and, in exchange, its request path
/// must WALK IN: it began as <c>adjacent, 1</c> and refused <c>forage_target_out_of_range</c> beyond the engine's own
/// Chebyshev-1 click gate, and that recorded decision was REVERSED on 2026-11-17. The radius is not this action's rule
/// - a player picking up a lily walks to it and clicks - and measured <c>round65</c> four such refusals were the only
/// failure class in the whole run while one lily was never picked. The walk is the one <c>pickup_item</c>, beside it in
/// the same handler group, already takes. So the declaration and the handler now agree from the other side, and this
/// file pins that side: out of range is a walk, or a refusal that says what stopped it.
/// </para>
///
/// <para>
/// <c>ride_bus</c> declares NOTHING and must not gain a declaration. Its family is <c>transport_warps</c> and its
/// postcondition is <c>bus_arrived</c>, the arrival the native cutscene and warp produce - the same shape as
/// <c>ride_minecart</c> and <c>enter_exit</c>, where the walk is a separate step. Its request path refuses
/// <c>bus_ticket_machine_out_of_reach</c> before it touches the native ticket machine, so a false declaration in
/// front of the companion, or a destructive action that began walking from inside a predicate, is caught here.
/// </para>
///
/// <para>
/// SCOPE, stated because it is easy to over-read. The two publication pins read the Mod catalog and its surface
/// projection - the artifact layer. The same declaration also travels on the <c>hello_ack</c> wire
/// (<c>FarmhandActionDescriptorWire.Approach</c>) and reaches <c>plan_shape</c>; <c>BridgeSessionPublicationTests</c>
/// pins that half.
/// </para>
///
/// <para>
/// The four request paths below are driven through the REAL ones against a headless world built the way
/// <c>ClearStepMoveTests.CorridorHarness</c> builds one: a real <see cref="GameLocation"/>, a real
/// <see cref="Farmer"/>, and the <c>Game1</c> statics the engine and <c>Context.IsWorldReady</c> dereference.
/// Each distance case is paired with one inside the gate that must NOT produce the same answer, so a stub that
/// answers everything the same way fails them.
/// </para>
/// </summary>
public sealed class ApproachClassificationTests
{
    // ---- the declared half: pickup_forage -----------------------------------

    [Fact]
    public void PickupForage_PublishesSelfWalked_OnTheDescriptorTheSurfaceProjectionCarries()
    {
        // Both readings of the same fact: the registration declares it, and the surface projection publishes it
        // rather than dropping it. This is the artifact layer - see the file header for what that does NOT claim.
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == "pickup_forage");
        registration.Descriptor!.Approach.Should().Be(new FarmhandActionApproachRequirement("self_walked", null));

        FarmhandActionDescriptorProjection published = FarmhandActionSurfacePublication.Actions
            .Single(candidate => candidate.ActionId == "pickup_forage");
        published.Approach.Should().Be(new FarmhandActionApproachRequirementProjection("self_walked", null));
    }

    [Fact]
    public void PickupForage_OutOfRange_IsWalkedTo_OrNamesWhatStoppedTheWalk()
    {
        using var world = HeadlessWorld.ForForage();
        world.PlaceActorAt(2, 3);

        // Six tiles away, which is what the companion was when it learned the old precondition the hard way.
        LocalExecutionReceipt receipt = world.RequestForage(8, 3);

        // THE REVERSED DECISION, as one assertion: a distance is not an answer. `TryBeginToolApproach` mints
        // `Accepted, "accepted"` the moment the walk is dispatched, so the receipt below is the walk itself and not a
        // verdict about geometry. The code that used to be here, `forage_target_out_of_range`, was the distance dressed
        // as a reason. This drives the REAL request path, so a body that answers without walking - or that arms nothing -
        // fails here rather than in a comment.
        receipt.State.Should().Be(
            ExecutionState.Accepted,
            $"an out-of-range forageable is walked to, not refused: state={receipt.State} "
                + $"code={receipt.ReasonCode} evidence={receipt.Evidence}");
        receipt.ReasonCode.Should().Be("accepted");
        receipt.Evidence.Should().Contain("approach=adjacent", "the approach leg says which geometry it dispatched");
        receipt.Evidence.Should().Contain("distance=6", "and how far the walk had to close");
        receipt.ReasonCode.Should().NotBe(
            "forage_target_out_of_range",
            "pickup_forage now closes the native click radius instead of refusing it");
    }

    [Fact]
    public void PickupForage_WithNoStandableApproach_RefusesAndNamesWhatBlockedIt()
    {
        using var world = HeadlessWorld.ForForage();
        world.PlaceActorAt(2, 3);
        world.BufferWarpsAround(8, 3);

        // Nothing on the item's ring may be stood on: every one of its eight neighbours is a warp buffer, which the
        // approach leg refuses (`IsWarpBufferTile`) because a body that stopped there would be teleported. So there is
        // no walk to make - and THAT is the one case a refusal is honest. It has to say which impossibility it is:
        // `standable_neighbour` separates a wall (a free tile it cannot walk to) from geometry (no free tile at all).
        LocalExecutionReceipt receipt = world.RequestForage(8, 3);

        receipt.State.Should().Be(ExecutionState.Rejected, "with nowhere to stand there is no walk to dispatch");
        receipt.ReasonCode.Should().Be(
            "no_reachable_approach:8:3",
            "the shared approach refusal names the PLACEMENT whose ring has no approach");
        receipt.Evidence.Should().Contain("standable_neighbour=none", "geometry, not a wall")
            .And.Contain("standable_tiles=0", "and the count says the same thing in numbers");
        receipt.Hint.Should().Be(
            "no_approach;standable_neighbour=none",
            "ADR-006 withholds a settled refusal's evidence, so the hint is the only channel that survives into the node");
    }

    [Fact]
    public void PickupForage_InRange_ReportsTheMissingItemInsteadOfWalking()
    {
        using var world = HeadlessWorld.ForForage();
        world.PlaceActorAt(2, 3);

        // One tile away: no walk is needed, so the terminal half runs in place and finds nothing on the tile - the
        // headless farm holds no forage object. That is the `target_not_found` ending, and it is the control that stops
        // the case above from passing on a body that answers the same thing at every distance.
        LocalExecutionReceipt receipt = world.RequestForage(3, 3);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be(
            "target_not_found",
            "a tile that holds no forageable is the item being gone, not a distance and not a walk");
    }

    // ---- the undeclared half: ride_bus -------------------------------------

    [Fact]
    public void RideBus_PublishesNoApproachRequirement()
    {
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == "ride_bus");
        registration.Descriptor!.Approach.Should().BeNull(
            "ride_bus is a cross-map transition whose walk is a separate step, like ride_minecart");

        FarmhandActionDescriptorProjection published = FarmhandActionSurfacePublication.Actions
            .Single(candidate => candidate.ActionId == "ride_bus");
        published.Approach.Should().BeNull("ride_bus must declare no standing precondition in the artifact either");

        // Its shape, so the null above cannot drift into "it happens not to be a transition any more".
        registration.Descriptor!.Postcondition.Should().Be("bus_arrived");
        registration.FamilyId.Should().Be("transport_warps");
    }

    [Fact]
    public void RideBus_OutOfReach_IsRefused_NotWalkedIn()
    {
        using var world = HeadlessWorld.ForBus();
        world.PlaceActorAt(2, 3);

        // The ticket machine sits at (12,9): ten tiles away, so the reach gate is the first thing that can speak.
        LocalExecutionReceipt receipt = world.RequestBus();

        receipt.State.Should().Be(ExecutionState.Rejected, "an out-of-reach bus is refused, never admitted");
        receipt.ReasonCode.Should().Be("bus_ticket_machine_out_of_reach");
    }

    [Fact]
    public void RideBus_InReach_DoesNotProduceTheReachRefusal()
    {
        using var world = HeadlessWorld.ForBus();
        world.PlaceActorAt(11, 9);

        // Adjacent to the ticket machine, so the reach gate passes and the request proceeds to the native facts.
        // It answers `vault_not_completed` (this probe's save has not finished the Community Center vault), which
        // is a LATER gate speaking - the control that stops the case above passing on a body that always refuses.
        LocalExecutionReceipt receipt = world.RequestBus();

        receipt.ReasonCode.Should().NotBe(
            "bus_ticket_machine_out_of_reach",
            "a bus the actor can already reach must clear the reach gate");
    }

    // -------------------------------------------------------------------------

    /// <summary>
    /// A real headless world: a 16x16 <see cref="GameLocation"/>, a real <see cref="Farmer"/>, and the
    /// <c>Game1</c> statics both the engine and <c>Context.IsWorldReady</c> dereference.
    ///
    /// <para>
    /// <c>Context.IsWorldReady</c> is not a settable field: SMAPI reads
    /// <c>PerScreen&lt;bool&gt;.States[Context.ScreenId]</c>, so this harness seeds it through the type's own
    /// <c>SetValueForScreen</c> and clears it with <c>ResetAllScreens</c>. The assembly already disables xUnit
    /// parallelization for exactly this reason (<c>AssemblyInfo.cs</c>), so mutating the statics is safe.
    /// </para>
    /// </summary>
    private sealed class HeadlessWorld : IDisposable
    {
        /// <summary>BusStop.checkAction's ticket-machine tile index on the Buildings layer.</summary>
        private const int BusTicketMachineTileIndex = 1057;

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

        public static HeadlessWorld ForForage() => Create(new GameLocation(), "ProbeFarm");

        public static HeadlessWorld ForBus()
        {
            var stop = new BusStop();
            HeadlessWorld world = Create(stop, "BusStop");
            // The one Buildings tile whose index `TryFindTicketMachine` scans for. Placed on a real tilesheet so
            // xTile accepts it - a bare StaticTile is rejected as belonging to no parent map.
            var sheet = new xTile.Tiles.TileSheet(
                "probe", stop.map, "Maps/probe", new xTile.Dimensions.Size(64, 64), new xTile.Dimensions.Size(16, 16));
            stop.map.AddTileSheet(sheet);
            stop.map.GetLayer("Buildings").Tiles[12, 9] =
                new xTile.Tiles.StaticTile(stop.map.GetLayer("Buildings"), sheet, xTile.Tiles.BlendMode.Alpha, BusTicketMachineTileIndex);
            return world;
        }

        private static HeadlessWorld Create(GameLocation location, string name)
        {
            var world = new HeadlessWorld();

            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, root);

            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            location.IsFarm = true;
            SetField(location, "name", new NetString(name));

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
            // `AdmitExecution` refuses a body it cannot move, and `canMove` is a plain bool that defaults to false
            // on an uninitialized actor.
            typeof(Farmer).GetField("canMove", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, true);
            // `WorldModel.ReadFacts` and the tool reads dereference each of these, so every one gets its own honest
            // empty value rather than being left to throw.
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
            // `ride_bus` reads `Game1.MasterPlayer.mailReceived`, and MasterPlayer falls back to Game1.player on a
            // non-master instance - where an uninitialized NetStringHashSet is null, not empty.
            SetField(actor, "mailReceived", new NetStringHashSet());
            actor.position.Set(new Vector2(2 * 64 + 8, 3 * 64));
            actor.currentLocation = location;
            SeedOnlineFarmers();
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            WorldReadyPerScreen.GetValue(null)!.GetType()
                .GetMethod("SetValueForScreen", new[] { typeof(int), typeof(bool) })!
                .Invoke(WorldReadyPerScreen.GetValue(null), new object[] { Context.ScreenId, true });
            Context.IsWorldReady.Should().BeTrue("the headless world must satisfy the readiness gate the body checks");

            return world;
        }

        /// <summary>Moves the actor to a tile, which is the one variable the range gates read.</summary>
        public void PlaceActorAt(int x, int y) => Game1.player.position.Set(new Vector2(x * 64 + 8, y * 64));

        /// <summary>
        /// Makes every tile on the eight-neighbour ring of (<paramref name="x"/>, <paramref name="y"/>) a warp buffer.
        ///
        /// <para>
        /// This is the harness's way of saying "nowhere to stand": the approach leg asks
        /// <c>IsStandableTile &amp;&amp; !IsWarpBufferTile</c>, and the second half is a fact about the location's own warp
        /// table - the same table the engine reads - so it needs no content, no tilesheet and no clock. It is a real
        /// predicate of the product, not a stub: a body that stopped on one of these tiles would be warped by the engine.
        /// </para>
        /// </summary>
        public void BufferWarpsAround(int x, int y)
        {
            GameLocation location = Game1.player.currentLocation!;
            for (int offsetX = -1; offsetX <= 1; offsetX++)
            for (int offsetY = -1; offsetY <= 1; offsetY++)
            {
                if (offsetX == 0 && offsetY == 0) continue;
                location.warps.Add(new Warp(x + offsetX, y + offsetY, "Elsewhere", 0, 0, false));
            }
        }

        /// <summary>
        /// Seeds <c>Game1.otherFarmers</c>, which <c>Location.farmers</c> reads to answer "is a player present here".
        ///
        /// <para>
        /// The approach leg reaches the ENGINE's finder now (<c>PathFindController</c>'s constructor calls
        /// <c>isPlayerPresent</c>, <c>PathFindController.cs:133</c>), and an uninitialized netcode root is a null
        /// dereference there rather than the empty answer it stands for. The harness seeds it the same way it seeds
        /// <c>netWorldState</c>. Reflected rather than named because the member's type is the engine's own generic root;
        /// a shape it cannot construct is left alone, which is exactly today's behaviour and no worse.
        /// </para>
        /// </summary>
        private static void SeedOnlineFarmers()
        {
            FieldInfo? field = typeof(Game1).GetField("otherFarmers", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            if (field is null || field.GetValue(null) is not null)
                return;
            try
            {
                object root = Activator.CreateInstance(field.FieldType)!;
                PropertyInfo? value = field.FieldType.GetProperty("Value");
                if (value is not null && value.GetValue(root) is null)
                    value.SetValue(root, Activator.CreateInstance(value.PropertyType));
                field.SetValue(null, root);
            }
            catch (MissingMethodException)
            {
            }
        }

        /// <summary>
        /// `pickup_forage` through its real request path. The address is `expectedTargetId`, the id the forage row
        /// publishes, so the request carries nothing the caller could not have copied out of an observation.
        /// </summary>
        public LocalExecutionReceipt RequestForage(int targetX, int targetY)
        {
            ExecutionManager executions = this.Manager("pickup_forage");
            return executions.RequestLocalPickupForage(
                $"req_forage_{targetX}_{targetY}",
                targetX,
                targetY,
                "(O)18",
                "forage_target_1",
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);
        }

        public LocalExecutionReceipt RequestBus()
        {
            ExecutionManager executions = this.Manager("ride_bus");
            var request = new BridgeExecutionRequest(
                "req_ride_bus",
                "idem_ride_bus",
                "ride_bus",
                new BridgeExecutionArgs(),
                1,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);
            return executions.RequestLocalRideBus(request, executions);
        }

        private ExecutionManager Manager(string actionId)
        {
            var publication = FarmhandCapabilityPublication.Initial(
                new HashSet<string>(StringComparer.Ordinal) { actionId });
            return new ExecutionManager(new DummyMonitor(), () => publication, executionScope: null);
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
