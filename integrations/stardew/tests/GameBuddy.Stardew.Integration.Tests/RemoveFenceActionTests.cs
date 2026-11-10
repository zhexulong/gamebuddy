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
using StardewValley.Tools;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// <c>remove_fence</c>: taking a standing fence down through the fence's own
/// <c>Fence.performToolAction</c> (Fence.cs:436-474), admitted by <c>Fence.IsValidRemovalTool</c> (Fence.cs:478-513).
///
/// <para>
/// WHY IT IS NOT <c>remove_placed_item</c>. That action mirrors the OBJECT-shaped guards of
/// <c>Object.performToolAction</c>; a fence overrides the whole method, so the only honest question is the fence's
/// own predicate - which reads <c>Data/Fences</c>'s <c>RemovalToolIds</c>/<c>RemovalToolTypes</c> - plus the
/// separate native branch a GATE has, where only an <c>Axe</c> or a <c>Pickaxe</c> removes one (:447-454). The case
/// <c>AGateRefusesAToolTheFenceDataAccepts</c> below is exactly the disagreement between the two predicates, and it
/// is the defect this action exists to name instead of swallowing.
/// </para>
///
/// <para>
/// The native call returns <c>false</c> on every branch, including the one that destroyed the fence (:473), so no
/// assertion here treats the return as the outcome. The world is: the fence's presence in <c>location.objects</c>.
/// </para>
///
/// <para>
/// END-TO-END REMOVAL IS NOT PROVEN HERE, and it cannot be: the branch that removes a non-gate fence builds four
/// <c>CosmeticDebris</c> from <c>fenceTexture.Value</c> and broadcasts sprites through <c>Game1.multiplayer</c>
/// (:462-467), and the gate branch calls <c>Game1.createObjectDebris</c>/<c>broadcastSprites</c> (:450-453). Neither
/// a content manager nor a multiplayer session exists in this process, so the swing reaches the native method and
/// throws - which the receipt reports honestly as <c>Uncertain</c>. The success path belongs to the lane's
/// native-local live gate, the same place the sibling placement/removal/rotation mutations are proven.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the shape pins below read the catalogue and handler source so a rename or a dropped declaration fails here, while the behaviour tests drive the handler and assert its postcondition; they are kept together because either half alone can be green while the action is wrong.
public sealed class RemoveFenceActionTests
{
    private const string ActionId = "remove_fence";
    private const string HandlerFile = "farmhandexecutioncontroller.furnituredecorationactions.cs";

    [Fact]
    public void Catalog_RegistersTheFenceRemovalWithTheTileTheToolSlotAndTheFenceIdentity()
    {
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == ActionId);

        registration.FamilyId.Should().Be("buildings_farm_management");
        registration.Kind.Should().Be(FarmhandOperationKind.Execution);
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        registration.Descriptor!.Arguments.Select(argument => argument.Name)
            .Should().Equal(new[] { "x", "y", "slot", "expectedTargetId" });
        registration.Descriptor.Postcondition.Should().Be("fence_removed");
        registration.Descriptor.NativeBinding.Should().Be("Fence.performToolAction");
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
    public void Handler_RoutesTheFenceRemovalToItsExecutionBody()
    {
        using var world = FenceWorld.Create();
        world.PlaceFence(x: 2, y: 2);
        world.EquipAxeInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.DispatchThroughTheResourceToolHandler(2, 2);

        receipt.ReasonCode.Should().NotBe("unsupported_action", "the resource-tool handler must own this action id");
        receipt.ReasonCode.Should().NotBe("world_not_ready", "the harness must satisfy the actor guard");
        (receipt.ReasonCode == "fence_removed" || receipt.ReasonCode.StartsWith("remove_fence", StringComparison.Ordinal))
            .Should().BeTrue($"the handler must reach this action's own body: {receipt.ReasonCode}");
    }

    [Fact]
    public void AnEmptyTile_IsRefusedByName()
    {
        using var world = FenceWorld.Create();
        world.EquipAxeInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("remove_fence_target_not_found");
        receipt.Evidence.Should().Contain("blocked_by=none");
    }

    /// <summary>
    /// A chest on the tile is not this action's subject. The refusal names what IS there rather than guessing, so the
    /// companion learns it aimed at the wrong thing instead of "there is no fence anywhere".
    /// </summary>
    [Fact]
    public void SomethingThatIsNotAFence_IsRefusedByName()
    {
        using var world = FenceWorld.Create();
        world.PlaceOrdinaryObject(x: 2, y: 2);
        world.EquipAxeInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("remove_fence_target_is_not_a_fence");
        receipt.Evidence.Should().Contain("blocked_by=object:");
    }

    [Fact]
    public void StaleTargetId_IsRefusedByNameAndLeavesTheFenceStanding()
    {
        using var world = FenceWorld.Create();
        StardewValley.Fence fence = world.PlaceFence(x: 2, y: 2);
        world.EquipAxeInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2, expectedTargetId: "placed_item_0000000000000000");

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("remove_fence_target_changed");
        world.Location.objects[new Vector2(2, 2)].Should().BeSameAs(fence);
    }

    /// <summary>
    /// THE TOOL COMES OUT OF THE PACK, NOT OUT OF THE HAND. <c>Fence.performToolAction</c> is reached through
    /// <c>Tool.DoFunction</c>, which this handler calls with the tool itself (<c>UseNativeToolOnTile</c>), so the
    /// selection the actor happens to be holding is not an input - the same shape <c>clear_debris</c> takes its tool
    /// in. The old guard demanded <c>CurrentToolIndex == slot</c> and refused a caller that owned the axe.
    /// </summary>
    [Fact]
    public void AToolInANamedSlotIsUsedEvenWhenTheActorHoldsSomethingElse()
    {
        using var world = FenceWorld.Create();
        world.PlaceFence(x: 2, y: 2);
        world.PutAxeInSlotAwayFromTheHand(3);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2, slot: 3);

        receipt.ReasonCode.Should().NotBe(
            "remove_fence_tool_not_equipped_in_requested_slot",
            "the axe IS in the slot the caller named, and the swing is driven with that tool object");
        receipt.State.Should().Be(
            ExecutionState.Uncertain,
            "the swing ran with the named slot's axe; the fence's own removal sound is the harness limit this process cannot finish");
        receipt.ReasonCode.Should().Be("remove_fence_native_exception");
        receipt.Evidence.Should().Contain("slot=3");
        receipt.Evidence.Should().Contain("item=(O)322");
    }

    /// <summary>
    /// The refusal that SURVIVES: the named slot holds no tool at all, so no swing could be driven from it.
    /// </summary>
    [Fact]
    public void ASlotHoldingNoToolIsRefusedByName()
    {
        using var world = FenceWorld.Create();
        world.PlaceFence(x: 2, y: 2);
        world.PutAxeInSlotAwayFromTheHand(3);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2, slot: 4);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("remove_fence_tool_not_owned_in_slot");
        receipt.Evidence.Should().Contain("blocked_by=tool:");
        world.Location.objects.ContainsKey(new Vector2(2, 2)).Should().BeTrue("nothing was swung, so the fence still stands");
    }

    /// <summary>
    /// THE CASE THAT SEPARATES THIS ACTION FROM `remove_placed_item`. A fence GATE is removed only by an Axe or a
    /// Pickaxe (Fence.cs:447-454) while `Fence.IsValidRemovalTool` is data-driven and answers TRUE for a scythe when the
    /// fence declares no tool lists. Asking only the data predicate would swing at the gate, watch it stay, and report an
    /// uncertain postcondition; asking both refuses by name before any mutation.
    /// </summary>
    [Fact]
    public void AGateRefusesAToolTheFenceDataAccepts()
    {
        using var world = FenceWorld.Create();
        StardewValley.Fence gate = world.PlaceFence(x: 2, y: 2, isGate: true);
        world.EquipHoeInSlot(0);
        world.StandAt(2, 3);
        gate.IsValidRemovalTool(Game1.player.CurrentTool!).Should().BeTrue(
            "the data predicate alone accepts the hoe, which is why both halves are asked");

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("remove_fence_tool_cannot_remove_target");
        receipt.Evidence.Should().Contain("is_gate=true");
        world.Location.objects.ContainsKey(new Vector2(2, 2)).Should().BeTrue("nothing was swung, so the gate still stands");
    }

    /// <summary>
    /// Out of the native tool reach the body WALKS IN rather than refusing (the lane's 5.2 policy, the same one
    /// `remove_placed_item` and `break_container` follow), so the answer is the approach leg's own <c>Accepted</c> and the
    /// fence is untouched until the walk arrives.
    /// </summary>
    [Fact]
    public void OutOfReach_StartsTheApproachLegAndLeavesTheFenceStanding()
    {
        using var world = FenceWorld.Create();
        StardewValley.Fence fence = world.PlaceFence(x: 2, y: 2);
        world.EquipAxeInSlot(0);
        world.StandAt(14, 14);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Accepted, "an out-of-reach tool request walks in first");
        world.Location.objects[new Vector2(2, 2)].Should().BeSameAs(fence);
    }

    /// <summary>
    /// The swing IS reached, and the receipt is the world's answer rather than the native return: this process cannot
    /// finish the native removal (see the class summary), so the honest outcome is <c>Uncertain</c> with the exception
    /// named - never a claimed success, and never a silent no-op.
    /// </summary>
    [Fact]
    public void TheSwingIsReachedAndAnUnfinishableNativeCallIsReportedAsUncertain()
    {
        using var world = FenceWorld.Create();
        StardewValley.Fence fence = world.PlaceFence(x: 2, y: 2);
        world.EquipAxeInSlot(0);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        if (receipt.State == ExecutionState.Succeeded)
        {
            receipt.ReasonCode.Should().Be("fence_removed");
            world.Location.objects.ContainsKey(new Vector2(2, 2)).Should().BeFalse("the fence is gone from the collection the engine keeps it in");
        }
        else
        {
            receipt.State.Should().Be(ExecutionState.Uncertain, receipt.Evidence);
            receipt.ReasonCode.Should().BeOneOf("remove_fence_native_exception", "remove_fence_postcondition_not_observed");
            receipt.Evidence.Should().Contain("swings=");
            receipt.Evidence.Should().Contain("item=(O)322");
            world.Location.objects.ContainsKey(new Vector2(2, 2)).Should().BeTrue("a fence nobody removed is still a fence");
        }
        fence.Should().NotBeNull();
    }

    /// <summary>
    /// The ORDER the body must keep: identity, then the FENCE's own tool predicate, then reach, then the swing, then a
    /// fresh read of the collection. The postcondition can never come from the native return value, which is false even
    /// for the branch that destroyed the fence.
    /// </summary>
    [Fact]
    public void SourceShape_ValidatesTheFenceAndItsToolBeforeSwingingAndReadsTheWorldAfter()
    {
        string source = File.ReadAllText(RepositoryFile("integrations", "stardew", HandlerFile));
        string request = MethodBody(source, "public LocalExecutionReceipt RequestLocalRemoveFence(");
        string execute = MethodBody(source, "private LocalExecutionReceipt ExecuteRemoveFence(");

        int fenceCheck = request.IndexOf("TryDescribeFence(", StringComparison.Ordinal);
        int toolCheck = request.IndexOf("TryDescribeFenceTool(", StringComparison.Ordinal);
        int approach = request.IndexOf("TryBeginToolApproach(", StringComparison.Ordinal);
        fenceCheck.Should().BeGreaterThanOrEqualTo(0);
        toolCheck.Should().BeGreaterThan(fenceCheck, "the tile is resolved before the fence's own predicate is asked");
        approach.Should().BeGreaterThan(toolCheck, "no walk starts for a request the fence or the tool already refuses");

        int swing = execute.IndexOf("UseNativeToolOnTile(", StringComparison.Ordinal);
        int recheck = execute.LastIndexOf("TryDescribeFenceTool(", StringComparison.Ordinal);
        int read = execute.IndexOf("location.objects.TryGetValue(tile, out StardewValley.Object? after)", StringComparison.Ordinal);
        recheck.Should().BeLessThan(swing, "the tool is re-validated after a possible walk and before the swing");
        swing.Should().BeLessThan(read, "the postcondition reads the collection AFTER the swing");
        execute.Should().Contain("bool removed =", "success is the fence being GONE, not the native return value");
        execute.Should().NotContain("return fence.performToolAction", "the native return proves nothing (Fence.cs:473)");
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
    /// A real room with a real objects collection, a real farmer and a real pack holding an axe. The fence is built
    /// UNINITIALISED and its NetFields are seeded: `Fence(Vector2, string, bool)` calls `ResetHealth` ->
    /// `GetMaximumHealth` -> `Data/Fences`, and this process loads no content manager - so the values a save would have
    /// derived are declared here instead.
    /// </summary>
    private sealed class FenceWorld : IDisposable
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

        private FenceWorld()
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

        internal static FenceWorld Create() => new();

        /// <summary>
        /// A real <see cref="StardewValley.Fence"/> in the location's own objects collection. Built uninitialised because
        /// the public constructor asks <c>Data/Fences</c> for the fence's health; every NetField the native branch reads
        /// is seeded instead, and `fenceTexture` is a lazy that yields null because nothing in this process draws.
        /// </summary>
        internal StardewValley.Fence PlaceFence(int x, int y, bool isGate = false)
        {
            var fence = (StardewValley.Fence)FormatterServices.GetUninitializedObject(typeof(StardewValley.Fence));
            SeedMissingNetFields(fence);
            SetField(fence, "itemId", new NetString(isGate ? "325" : "322"));
            SetField(fence, "netName", new NetString(isGate ? "Gate" : "Wood Fence"));
            SetField(fence, "stack", new NetInt(1));
            SetField(fence, "parentSheetIndex", new NetInt(0));
            SetField(fence, "tileLocation", new NetVector2 { Value = new Vector2(x, y) });
            SetField(fence, "boundingBox", new NetRectangle { Value = new Rectangle(x * 64, y * 64, 64, 64) });
            SetField(fence, "heldObject", new NetRef<StardewValley.Object>());
            SetField(fence, "fragility", new NetInt(0));
            SetField(fence, "health", new NetFloat(10f));
            SetField(fence, "maxHealth", new NetFloat(10f));
            SetField(fence, "gatePosition", new NetInt(0));
            SetField(fence, "isGate", new NetBool(isGate));
            SetField(fence, "repairQueued", new NetBool(false));
            SetField(fence, "fenceTexture", new Lazy<Microsoft.Xna.Framework.Graphics.Texture2D>(() => null!));
            // `Fence.GetData()` answers `_data` when it is already set and only falls back to `DataLoader.Fences` when it
            // is not (Fence.cs:240-247), and `IsValidRemovalTool` reads that row's RemovalToolIds/RemovalToolTypes
            // (:478-513). An empty row is what a vanilla wood fence declares: both lists absent, so any tool the gate
            // branch does not refuse is accepted. The asset is not loaded here, so the row is declared instead.
            SetField(fence, "_data", new StardewValley.GameData.Fences.FenceData());
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(fence, isGate ? "(O)325" : "(O)322");
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(fence, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(fence, false);
            typeof(StardewValley.Object).GetProperty("Type", BindingFlags.Instance | BindingFlags.Public)!
                .SetValue(fence, "Crafting");
            this.Location.objects[new Vector2(x, y)] = fence;
            return fence;
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
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(placed, "(BC)130");
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(placed, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(placed, false);
            this.Location.objects[new Vector2(x, y)] = placed;
        }

        internal void EquipAxeInSlot(int slot) => this.EquipInSlot(slot, MakeTool(typeof(Axe), "(T)Axe"));

        /// <summary>
        /// A tool the FENCE DATA accepts and a GATE refuses: <c>Fence.IsValidRemovalTool</c> (Fence.cs:478-513) answers
        /// true for any tool when the fence declares no tool lists, while the gate branch (:447-454) requires an Axe or a
        /// Pickaxe. The disagreement between those two predicates is what this action asks both halves for.
        /// </summary>
        internal void EquipHoeInSlot(int slot) => this.EquipInSlot(slot, MakeTool(typeof(Hoe), "(T)Hoe"));

        internal void PutAxeInSlotWithoutEquipping(int slot) => Game1.player.Items[slot] = MakeTool(typeof(Axe), "(T)Axe");

        /// <summary>Puts an axe in a slot that is NOT the current tool, so the named slot and the held tool disagree.</summary>
        internal void PutAxeInSlotAwayFromTheHand(int slot)
        {
            Game1.player.Items[slot] = MakeTool(typeof(Axe), "(T)Axe");
            Game1.player.CurrentToolIndex = 0;
            Game1.player.Items[0] = null!;
        }

        /// <summary>
        /// A real Tool built WITHOUT its constructor, which is where `Item.itemId`, `Tool.initialParentTileIndex` and a
        /// tool's own data are written. `ItemId` is set BEFORE `_qualifiedItemId` because the property setter clears the
        /// qualified cache (Item.cs:178-182), and the `NetFields` backing field is seeded because an uninitialized
        /// instance never ran that initializer.
        /// </summary>
        private static Tool MakeTool(Type toolType, string qualifiedItemId)
        {
            var tool = (Tool)FormatterServices.GetUninitializedObject(toolType);
            SeedMissingNetFields(tool);
            typeof(Item)
                .GetField("<NetFields>k__BackingField", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(tool, new NetFields("Item"));
            SetField(tool, "upgradeLevel", new NetInt(0));
            typeof(Item).GetProperty("ItemId", BindingFlags.Instance | BindingFlags.Public)!
                .SetValue(tool, qualifiedItemId[3..]);
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(tool, qualifiedItemId);
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(tool, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(tool, false);
            SetField(tool, "netName", new NetString(toolType.Name));
            return tool;
        }

        private void EquipInSlot(int slot, Tool tool)
        {
            Game1.player.Items[slot] = tool;
            Game1.player.CurrentToolIndex = slot;
        }

        internal void StandAt(int x, int y) => Game1.player.position.Set(new Vector2(x * 64 + 8, y * 64));

        /// <summary>The target id the snapshot publishes for this tile, read off the production builder.</summary>
        internal string TargetIdAt(int x, int y) => ExecutionManager.BuildPlacedItemTargetId(
            this.Location,
            x,
            y,
            this.Location.objects[new Vector2(x, y)]);

        private string TargetIdOrSynthetic(int x, int y) =>
            this.Location.objects.ContainsKey(new Vector2(x, y))
                ? this.TargetIdAt(x, y)
                : "placed_item_0000000000000000";

        internal LocalExecutionReceipt Request(int x, int y, string? expectedTargetId = null, int? slot = null) =>
            this.Manager().RequestLocalRemoveFence(
                $"req_fence_{x}_{y}_{expectedTargetId ?? "live"}",
                slot ?? Game1.player.CurrentToolIndex,
                x,
                y,
                expectedTargetId ?? this.TargetIdOrSynthetic(x, y),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);

        internal LocalExecutionReceipt DispatchThroughTheResourceToolHandler(int x, int y)
        {
            ExecutionManager executions = this.Manager();
            var request = new BridgeExecutionRequest(
                $"req_fence_handler_{x}_{y}",
                $"idem_fence_handler_{x}_{y}",
                ActionId,
                new BridgeExecutionArgs { X = x, Y = y, Slot = Game1.player.CurrentToolIndex, ExpectedTargetId = this.TargetIdAt(x, y) },
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
