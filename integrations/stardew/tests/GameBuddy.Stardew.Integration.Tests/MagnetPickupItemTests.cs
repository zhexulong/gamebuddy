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
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The drop the magnet won.
///
/// <para>
/// The engine magnetizes ground debris to a nearby Farmer and collects it into that Farmer's backpack with no bridge
/// request involved (<c>Debris.updateChunks</c> → <c>Debris.collect</c>). So a plan node that observed a drop, walked
/// over, and then dispatched <c>pickup_item</c> arrives at a tile where the chunk is already gone - and the preflight
/// answered <c>item_target_changed</c> for an item the companion was <i>already carrying</i>. Measured in round 18:
/// six of these in one run, each followed by turns of re-observation over a drop that no longer existed.
/// </para>
///
/// <para>
/// The settled fact is not "the item vanished" - another magnet-bearing Farmer, a chest or a shipping bin produces
/// exactly that while leaving THIS farmer's backpack untouched. It is "the chunk left the ground AND this actor's own
/// count of that item rose from the number it held when the target was last published with the chunk still there".
/// The cases below are written around that distinction: the satisfying one, the three ways it is NOT satisfying, and
/// the chunk that merely moved (which no pickup may ever explain).
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the cases that drive a real ExecutionManager against a headless farm and a real Debris
// are behaviour tests; the two pins at the end read the Mod's source to prove the recording discovery is the one the
// snapshot publishes through and that pickup_forage does not share this predicate.
public sealed class MagnetPickupItemTests
{
    private const long ActorId = 1001;
    private const string DroppedItemId = "(O)24";

    // ---- the gate: the magnet's delivery IS this action's success -----------------

    /// <summary>
    /// Before this change the preflight refused with <c>item_target_changed</c> because it asked only "is the chunk on
    /// the tile" - which is false for a drop the actor has in their bag. The receipt must now be the action's own
    /// success, carrying the evidence the Host parses for that success.
    /// </summary>
    [Fact]
    public void TheMagnetDeliveredDrop_SettlesAsTheActionsSuccess()
    {
        using var harness = MagnetPickupHarness.Create(debrisTileX: 2, debrisTileY: 2, heldAtPublication: 0);
        string targetId = harness.PublishTargetId();
        ExecutionManager manager = harness.Manager;

        // The engine collects the drop during the walk: it leaves the ground and lands in this actor's backpack.
        harness.MagnetCollects();

        LocalExecutionReceipt receipt = manager.RequestLocalPickupItem(
            "req_magnet", 2, 2, DroppedItemId, targetId, harness.DeadlineMs);

        receipt.State.Should().Be(
            ExecutionState.Succeeded,
            "the drop the companion is already carrying satisfies this action's postcondition");
        receipt.ReasonCode.Should().Be("item_picked_up");
        receipt.ReasonCode.Should().NotBe("item_target_changed");

        // ADR-006: a success is proved by action-specific evidence, and for this action the Host decides it by
        // parsing exactly these nine keys (host/src/stardew-game-integration-adapter.ts,
        // hasPickupItemCompletionEvidence) with stack >= 1, both flags true and after >= before + stack.
        Dictionary<string, string> evidence = ParseEvidence(receipt.Evidence!);
        evidence.Keys.Should().BeEquivalentTo(new[]
        {
            "location", "target", "tile", "item", "stack",
            "native_auto_collect", "chunk_removed", "inventory_before", "inventory_after",
        });
        evidence["location"].Should().Be("Farm");
        evidence["target"].Should().Be(targetId, "the evidence names the opaque target the request named");
        evidence["tile"].Should().Be("2,2");
        evidence["item"].Should().Be(DroppedItemId);
        evidence["stack"].Should().Be("1");
        evidence["native_auto_collect"].Should().Be("true", "the magnet, not a click, delivered this chunk");
        evidence["chunk_removed"].Should().Be("true", "no chunk of this identity is left anywhere in the location");
        evidence["inventory_before"].Should().Be(
            "0", "the baseline is the count measured while the chunk was still on the ground");
        evidence["inventory_after"].Should().Be("1");
    }

    // ---- the three ways a vanished chunk is NOT this farmer's pickup --------------

    /// <summary>
    /// Another magnet-bearing Farmer in a shared world, a chest, or a shipping bin all take the chunk and leave this
    /// farmer's backpack alone. "Gone" on its own therefore proves nothing, and the refusal has to survive.
    /// </summary>
    [Fact]
    public void AVanishedChunkThatNeverEnteredThisBackpack_IsStillRefused()
    {
        using var harness = MagnetPickupHarness.Create(debrisTileX: 2, debrisTileY: 2, heldAtPublication: 0);
        string targetId = harness.PublishTargetId();
        ExecutionManager manager = harness.Manager;

        harness.SomeoneElseTakesIt();

        LocalExecutionReceipt receipt = manager.RequestLocalPickupItem(
            "req_elsewhere", 2, 2, DroppedItemId, targetId, harness.DeadlineMs);

        receipt.State.Should().Be(ExecutionState.Rejected, "the actor's own backpack is the evidence, and it is untouched");
        receipt.ReasonCode.Should().Be("item_target_changed");
    }

    /// <summary>
    /// The trap the naive check falls into: the actor's backpack DOES hold this item id - it held it before the drop
    /// ever existed. Possession is not collection, so the comparison is against the count measured at publication and
    /// not against "holds it at all".
    /// </summary>
    [Fact]
    public void AHeldStackIsNotProofThatThisDropWasDelivered()
    {
        using var harness = MagnetPickupHarness.Create(debrisTileX: 2, debrisTileY: 2, heldAtPublication: 1);
        string targetId = harness.PublishTargetId();
        ExecutionManager manager = harness.Manager;

        harness.SomeoneElseTakesIt();
        harness.Actor.Items.Count(item => item is StardewValley.Object).Should().Be(
            1, "the actor is holding one of these and holding it proves nothing about the chunk that vanished");

        LocalExecutionReceipt receipt = manager.RequestLocalPickupItem(
            "req_already_held", 2, 2, DroppedItemId, targetId, harness.DeadlineMs);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("item_target_changed");
    }

    /// <summary>
    /// A chunk that is still lying on the ground is a MOVE, never a collection: settling it as a pickup would claim an
    /// item the actor does not have. The refusal names both tiles so the plan can see what actually happened.
    /// </summary>
    [Fact]
    public void AChunkStillOnTheGround_IsAMoveAndNeverACollection()
    {
        using var harness = MagnetPickupHarness.Create(debrisTileX: 12, debrisTileY: 2, heldAtPublication: 0);
        string targetId = harness.PublishTargetId();
        ExecutionManager manager = harness.Manager;

        // The actor stands ten tiles west, with the chunk untouched on the ground.
        harness.StandAt(2, 2);

        LocalExecutionReceipt receipt = manager.RequestLocalPickupItem(
            "req_moved", 12, 2, DroppedItemId, targetId, harness.DeadlineMs);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be(
            "item_target_moved",
            "the chunk is still there, so this is a target that is out of the action's reach, not a pickup");
        receipt.Evidence.Should().Contain("expected=12,2");
        receipt.Evidence.Should().Contain("actual=12,2");
    }

    // ---- the rule itself ----------------------------------------------------------

    [Fact]
    public void TheMagnetRuleRequiresTheWholeStackToHaveArrived()
    {
        var publication = new GroundItemPublication("item_0123456789abcdef", "Farm", 2, 2, DroppedItemId, Stack: 3, InventoryAtPublication: 4, PublishedTick: 10);

        publication.MagnetDeliveredIt(7).Should().BeTrue("three arrived on top of the four already held");
        publication.MagnetDeliveredIt(6).Should().BeFalse("one short of the stack that was on that tile");
        publication.MagnetDeliveredIt(4).Should().BeFalse("an unchanged backpack is not a delivery");

        // A stack below one cannot be measured - `before + 0` is satisfied by nothing at all - so it never proves a
        // delivery, however large the backpack count is.
        new GroundItemPublication("item_0123456789abcdef", "Farm", 2, 2, DroppedItemId, Stack: 0, InventoryAtPublication: 4, PublishedTick: 10)
            .MagnetDeliveredIt(400).Should().BeFalse();
    }

    [Fact]
    public void TheLedgerIsBoundedAndKeepsTheLatestBaselineForATarget()
    {
        var ledger = new GroundItemPickupLedger();
        for (int index = 0; index < GroundItemPickupLedger.MaximumRememberedTargets + 5; index++)
            ledger.Record(new GroundItemPublication($"item_{index:x16}", "Farm", 2, 2, DroppedItemId, 1, 0, index));

        ledger.Count.Should().Be(GroundItemPickupLedger.MaximumRememberedTargets, "the ledger is bounded like the receipt ledger");
        ledger.Recall("item_0000000000000000").Should().BeNull("the oldest publication is evicted first");
        ledger.Recall($"item_{GroundItemPickupLedger.MaximumRememberedTargets + 4:x16}").Should().NotBeNull();

        // Re-publication of the SAME chunk refreshes the baseline: the last publication that still saw the chunk on
        // the ground is the only count that can prove anything about the moment after it left.
        ledger.Record(new GroundItemPublication("item_stable", "Farm", 2, 2, DroppedItemId, 1, 0, 10));
        ledger.Record(new GroundItemPublication("item_stable", "Farm", 2, 2, DroppedItemId, 1, 3, 40));
        ledger.Recall("item_stable")!.InventoryAtPublication.Should().Be(3, "the latest measurement wins");
        ledger.Recall("item_stable")!.PublishedTick.Should().Be(40);
    }

    // ---- the sibling, and the publication the baseline comes from ------------------

    /// <summary>
    /// <c>pickup_forage</c> is the other half of the gathering family and it does NOT share this predicate, because it
    /// cannot: its subject is a foraged <c>Object</c> in <c>location.objects</c>, and the engine magnetizes only
    /// <c>Debris</c> chunks. Pinned rather than asserted in prose, so a future change that made the forage path
    /// answer a debris question has to say so here.
    /// </summary>
    [Fact]
    public void PickupForageDoesNotShareTheMagnetPredicate()
    {
        string source = Read("farmhandexecutioncontroller.gatheringactions.cs");
        string forage = MethodBody(source, "public LocalExecutionReceipt RequestLocalPickupForage(");
        string item = MethodBody(source, "public LocalExecutionReceipt RequestLocalPickupItem(");

        forage.Should().NotContain("FindItemTarget(", "forage targets are location objects, not debris chunks");
        forage.Should().NotContain("item_target_changed", "the forage path never answered with this action's code");
        forage.Should().NotContain("TrySettleMagnetCollectedItem");
        forage.Should().Contain("\"forage_picked_up\"", "the forage success is unchanged");

        item.Should().Contain("this.TrySettleMagnetCollectedItem(", "the one action whose subject IS magnetizable asks the rule");
    }

    /// <summary>
    /// The baseline exists only if the recording happens in the publication the Agent reads targets from: the number
    /// must be measured at the moment the chunk is published, never after its delivery.
    /// </summary>
    [Fact]
    public void TheSnapshotPublishesThroughTheRecordingDiscovery()
    {
        string controller = Read("farmhandexecutioncontroller.cs");
        string discovery = MethodBody(controller, "private IReadOnlyList<BridgeItemTarget> DiscoverItemTargets(");

        controller.Should().Contain(
            "advertisedCapabilities.Contains(\"pickup_item\", StringComparer.Ordinal) ? DiscoverItemTargets(player) : null",
            "the snapshot's item channel must be this discovery, or no published target id is ever recorded");
        discovery.Should().Contain("this.groundItemTargets.Record(", "the discovery records what it published");
        discovery.Should().Contain(
            "CountQualifiedItem(player, qualifiedItemId)",
            "the baseline is this actor's own count, measured while the chunk is still on the ground");
    }

    // -------------------------------------------------------------------------

    private static Dictionary<string, string> ParseEvidence(string evidence) =>
        evidence.Split(';', StringSplitOptions.RemoveEmptyEntries)
            .Select(pair => pair.Split('=', 2))
            .ToDictionary(parts => parts[0], parts => parts.Length > 1 ? parts[1] : string.Empty);

    private static string Read(string fileName) => File.ReadAllText(RepositorySourcePath(
        Path.Combine("integrations", "stardew", fileName)));

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate)) return candidate;
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }

    /// <summary>Extracts a brace-balanced body starting at the first <c>{</c> after the signature.</summary>
    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");

        int depth = 0;
        for (int cursor = opening; cursor < source.Length; cursor++)
        {
            if (source[cursor] == '{') depth++;
            else if (source[cursor] == '}' && --depth == 0) return source[opening..(cursor + 1)];
        }

        throw new InvalidOperationException($"unbalanced body for {signature}");
    }

    /// <summary>
    /// A headless Farm with one real <see cref="Debris"/> chunk lying on a tile, a probe farmer whose backpack the
    /// cases move, and the <c>Game1</c> statics the admission and the discovery dereference. The assembly runs
    /// without parallelization, so restoring the statics on dispose is sufficient.
    /// </summary>
    private sealed class MagnetPickupHarness : IDisposable
    {
        private const BindingFlags Any =
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;

        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;
        private readonly object? locationLookupBefore;
        private readonly bool worldReadyBefore;
        private readonly Debris debris;
        private readonly int debrisTileX;
        private readonly int debrisTileY;

        private MagnetPickupHarness(int debrisTileX, int debrisTileY, int heldAtPublication)
        {
            this.debrisTileX = debrisTileX;
            this.debrisTileY = debrisTileY;
            this.gameBefore = Game1.game1;
            this.playerBefore = Game1.player;
            this.worldStateBefore = Field(typeof(Game1), "netWorldState").GetValue(null);
            this.locationLookupBefore = Field(typeof(Game1), "_locationLookup").GetValue(null);
            this.worldReadyBefore = Context.IsWorldReady;

            // `Context.IsWorldReady` gates the request path before anything else, and the module has no public setter;
            // its generated one is reachable here and the assembly disables parallelization.
            typeof(Context).GetProperty("IsWorldReady", Any)!.GetSetMethod(nonPublic: true)!
                .Invoke(null, new object[] { true });

            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            Field(typeof(Game1), "netWorldState").SetValue(null, root);
            var lookup = new Dictionary<string, GameLocation>(StringComparer.OrdinalIgnoreCase);
            Field(typeof(Game1), "_locationLookup").SetValue(null, lookup);
            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));

            var farm = new Farm();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(80, 40), new xTile.Dimensions.Size(64, 64)));
            farm.map = map;
            Set(farm, "name", new NetString("Farm"));
            lookup["Farm"] = farm;
            Game1.game1.instanceGameLocation = farm;
            this.Farm = farm;

            var inventory = new StardewValley.Inventories.Inventory();
            for (int held = 0; held < heldAtPublication; held++)
                inventory.Add(NewItem(stack: 1));

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            Set(sprite, "spriteWidth", new NetInt(16));
            Set(sprite, "spriteHeight", new NetInt(32));
            Set(sprite, "tempSpriteHeight", -1);
            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            Set(actor, "uniqueMultiplayerID", new NetLong(ActorId));
            Set(actor, "position", new NetPosition());
            Set(actor, "currentLocationRef", new NetLocationRef());
            Set(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            Set(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            Set(actor, "usingTool", new NetBool(false));
            Set(actor, "netStamina", new NetFloat(270f));
            Set(actor, "toolPower", new NetInt(0));
            Set(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory>(inventory));
            actor.CanMove = true;
            actor.freezePause = 0;
            actor.currentLocation = farm;
            Field(typeof(Game1), "_player").SetValue(null, actor);
            this.Actor = actor;

            this.debris = NewDebris(debrisTileX, debrisTileY);
            farm.debris.Add(this.debris);

            // Standing on the tile the drop was published at: the request is the arrival, not the walk.
            this.StandAt(debrisTileX, debrisTileY);
            this.DeadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
            this.Manager = new ExecutionManager(
                new DummyMonitor(),
                () => FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "pickup_item" }));
            this.Manager.SetTestActorResolver(() => this.Actor);
        }

        internal ExecutionManager Manager { get; }

        internal Farm Farm { get; }

        internal Farmer Actor { get; }

        internal long DeadlineMs { get; }

        internal static MagnetPickupHarness Create(int debrisTileX, int debrisTileY, int heldAtPublication) =>
            new(debrisTileX, debrisTileY, heldAtPublication);

        /// <summary>The target id the snapshot publishes for the drop, through the production discovery.</summary>
        internal string PublishTargetId()
        {
            IReadOnlyList<BridgeItemTarget> targets = (IReadOnlyList<BridgeItemTarget>)typeof(ExecutionManager)
                .GetMethod("DiscoverItemTargets", Any)!
                .Invoke(this.Manager, new object[] { this.Actor })!;
            if (targets.Count == 0)
                throw new InvalidOperationException(
                    $"the discovery published nothing: debris={this.Farm.debris.Count};"
                    + $"chunks={(this.Farm.debris.Count > 0 ? this.Farm.debris[0].Chunks.Count : -1)};"
                    + $"type={(this.Farm.debris.Count > 0 ? this.Farm.debris[0].debrisType.Value.ToString() : "<none>")};"
                    + $"item={(this.Farm.debris.Count > 0 ? (this.Farm.debris[0].item?.QualifiedItemId ?? "<null>") : "<none>")};"
                    + $"actor_tile={this.Actor.Tile.X},{this.Actor.Tile.Y}");
            return targets.Single(target => target.X == this.debrisTileX && target.Y == this.debrisTileY).TargetId;
        }

        /// <summary>
        /// The engine's own debris update, as this case needs it: the chunk leaves the ground and the actor's backpack
        /// gains it. Nothing here calls a production pickup path - that is the whole point of the defect.
        /// </summary>
        internal void MagnetCollects()
        {
            this.Farm.debris.Remove(this.debris);
            this.Actor.Items.Add(NewItem(stack: 1));
        }

        /// <summary>The chunk leaves the ground for a bag that is not this actor's.</summary>
        internal void SomeoneElseTakesIt() => this.Farm.debris.Remove(this.debris);

        /// <summary>Sets the actor's tile through the engine's own position, as a warp would.</summary>
        internal void StandAt(int tileX, int tileY) =>
            this.Actor.position.Set(new Vector2(tileX * 64 + 8, tileY * 64));

        public void Dispose()
        {
            typeof(Context).GetProperty("IsWorldReady", Any)!.GetSetMethod(nonPublic: true)!
                .Invoke(null, new object[] { this.worldReadyBefore });
            Field(typeof(Game1), "netWorldState").SetValue(null, this.worldStateBefore);
            Field(typeof(Game1), "_locationLookup").SetValue(null, this.locationLookupBefore);
            Field(typeof(Game1), "_player").SetValue(null, this.playerBefore);
            Game1.game1 = this.gameBefore;
        }

        /// <summary>
        /// A real <c>(O)24</c> stack. The net fields are supplied because a process without a save never ran their
        /// initializers, and <c>QualifiedItemId</c>/<c>Stack</c> are the two facts this action's count reads.
        /// </summary>
        private static StardewValley.Object NewItem(int stack)
        {
            var item = (StardewValley.Object)FormatterServices.GetUninitializedObject(typeof(StardewValley.Object));
            Set(item, "itemId", new NetString("24"));
            Set(item, "stack", new NetInt(stack));
            Set(item, "quality", new NetInt(0));
            Set(item, "bigCraftable", new NetBool(false));
            Set(item, "type", new NetString("Basic"));
            Set(item, "questItem", new NetBool(false));
            Set(item, "isRecipe", new NetBool(false));
            return item;
        }

        /// <summary>
        /// One OBJECT-type debris chunk on a tile, built the way the engine's own <c>Game1.createItemDebris</c> leaves
        /// it: the same fields the discovery, the identity hash and the postcondition read.
        /// </summary>
        private Debris NewDebris(int tileX, int tileY)
        {
            var chunks = new NetObjectShrinkList<Chunk>();
            // The tile a chunk reports is `GetChunkTile`: `(position + 32) / 64`, integer division. A chunk whose
            // position is `tile * 64` therefore reports exactly that tile in both the discovery and the preflight.
            chunks.Add(new Chunk(new Vector2(tileX * 64, tileY * 64), 0f, 0f, 0));
            var created = (Debris)FormatterServices.GetUninitializedObject(typeof(Debris));
            Set(created, "chunks", chunks);
            Set(created, "debrisType", new NetEnum<Debris.DebrisType>(Debris.DebrisType.OBJECT));
            Set(created, "itemId", new NetString("24"));
            Set(created, "netItem", new NetRef<Item> { Value = NewItem(stack: 1) });
            Set(created, "netItemQuality", new NetInt(0));
            Set(created, "DroppedByPlayerID", new NetLong(ActorId));
            return created;
        }

        private static FieldInfo Field(Type type, string name) =>
            type.GetField(name, Any) ?? throw new InvalidOperationException($"{type.Name}.{name} is missing");

        private static void Set(object target, string name, object value) =>
            Field(target.GetType(), name).SetValue(target, value);
    }
}
