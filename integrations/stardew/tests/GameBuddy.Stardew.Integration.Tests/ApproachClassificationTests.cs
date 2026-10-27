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
/// <c>pickup_forage</c> DECLARES its precondition (<c>FarmhandActionDefinitions.cs:212</c>) and, in exchange, its
/// request path must NOT walk in: it refuses <c>observation_binding_target_out_of_range</c>. The walk is the
/// caller's own <c>move_to_tile</c> step; if the handler started one, the declaration would be a redundant
/// sentence and the refusal would arrive after a walk nobody planned.
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
/// The four refusals below are driven through the REAL request paths against a headless world built the way
/// <c>ClearStepMoveTests.CorridorHarness</c> builds one: a real <see cref="GameLocation"/>, a real
/// <see cref="Farmer"/>, and the <c>Game1</c> statics the engine and <c>Context.IsWorldReady</c> dereference.
/// Each case is paired with an in-range call that must NOT produce the same code, so a stub that always refuses
/// fails them.
/// </para>
/// </summary>
public sealed class ApproachClassificationTests
{
    // ---- the declared half: pickup_forage -----------------------------------

    [Fact]
    public void PickupForage_PublishesAdjacentOne_OnTheDescriptorTheSurfaceProjectionCarries()
    {
        // Both readings of the same fact: the registration declares it, and the surface projection publishes it
        // rather than dropping it. This is the artifact layer - see the file header for what that does NOT claim.
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == "pickup_forage");
        registration.Descriptor!.Approach.Should().Be(new FarmhandActionApproachRequirement("adjacent", 1));

        FarmhandActionDescriptorProjection published = FarmhandActionSurfacePublication.Actions
            .Single(candidate => candidate.ActionId == "pickup_forage");
        published.Approach.Should().Be(new FarmhandActionApproachRequirementProjection("adjacent", 1));
    }

    [Fact]
    public void PickupForage_OutOfRange_IsRefused_NotWalkedIn()
    {
        using var world = HeadlessWorld.ForForage();
        world.PlaceActorAt(2, 3);

        // Six tiles away, which is what the companion was when it learned this precondition the hard way.
        LocalExecutionReceipt receipt = world.RequestForage(8, 3);

        // The REQUEST PATH is what this pins: a walk that had begun would return ExecutionState.Accepted
        // (`TryBeginToolApproach` mints `Accepted, "accepted"`) and settle later, so requiring a terminal
        // Rejected with this action's own code is exactly the difference between "refused" and "walked instead".
        receipt.State.Should().Be(ExecutionState.Rejected, "pickup_forage refuses from range; it is not the walk");
        receipt.ReasonCode.Should().Be("observation_binding_target_out_of_range");
    }

    [Fact]
    public void PickupForage_InRange_DoesNotProduceTheRangeRefusal()
    {
        using var world = HeadlessWorld.ForForage();
        world.PlaceActorAt(2, 3);

        // One tile away: the radius gate is satisfied, so the request proceeds to the binding/object checks. This
        // is the control that stops the case above from passing on a body that refuses everything: the same call,
        // one tile closer, must answer something else. (It answers `observation_binding_target_unavailable` here
        // because the headless farm holds no forage object - which is the point: a LATER gate spoke.)
        LocalExecutionReceipt receipt = world.RequestForage(3, 3);

        receipt.ReasonCode.Should().NotBe(
            "observation_binding_target_out_of_range",
            "an in-range target must clear the radius gate the declaration describes");
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
        /// `pickup_forage` through its real request path. The scene resolver is supplied because it is a Mod wiring
        /// slot, not game state: without it the body refuses `observation_binding_precondition_failed` before it
        /// ever measures the radius, and the radius branch would be unreachable.
        /// </summary>
        public LocalExecutionReceipt RequestForage(int targetX, int targetY)
        {
            BoundarySceneBinding binding = this.BoundForage(targetX, targetY);
            ExecutionManager executions = this.Manager("pickup_forage");
            executions.SetSceneTargetResolver(binding.Resolve);
            return executions.RequestLocalPickupForage(
                $"req_forage_{targetX}_{targetY}",
                targetX,
                targetY,
                "(O)18",
                "forage_target_1",
                null,
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

        /// <summary>The scene binding the Mod's own resolver would publish for this tile, in its own shape.</summary>
        private BoundarySceneBinding BoundForage(int targetX, int targetY) => new(targetX, targetY);

        private readonly record struct BoundarySceneBinding(int TileX, int TileY)
        {
            public bool Resolve(ObservationBindingV1? requested, out SceneAffordanceBinding? binding, out string reasonCode)
            {
                binding = new SceneAffordanceBinding(
                    SceneAffordanceKind.Forage,
                    "(O)18",
                    Game1.player.currentLocation!.NameOrUniqueName,
                    this.TileX,
                    this.TileY,
                    1);
                reasonCode = "accepted";
                return true;
            }
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
