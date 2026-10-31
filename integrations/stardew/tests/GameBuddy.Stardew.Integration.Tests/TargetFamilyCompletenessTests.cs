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
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A family whose rows pair two independently-sized sets multiplies them, and that multiplication is the defect.
///
/// The two container families did exactly this: one row per (container x storable pack slot), one per (container x
/// chest item). Every fix before this one was a budget tweak, because a budget is what you add when you cannot say
/// why the set is that large. Measured 2026-10-31 on the real projection: a 36-item chest reached the model as 16
/// rows, and four chests of 16 items saturated the whole 64-row family limit. The cross product is gone; a container
/// is published once, carrying its whole contents (`chests`).
///
/// The remaining cases here are the shapes that stay and must keep holding: an entity published whole, in slot
/// order, under the identity its own execution resolves, and a villager the player has never met still published as
/// the zeroed relationship the engine is about to create.
///
/// These cases build the world the defect needs and read the REAL discovery projection through it: a headless
/// farm, a probe farmer with a real pack, and real chests in the location's object layer. Nothing here re-implements
/// the projection.
/// </summary>
public sealed class TargetFamilyCompletenessTests
{
    private const string WeedsQualifiedItemId = "(O)389";
    private const string DiamondQualifiedItemId = "(O)72";
    private const string VillagerName = "Abigail";

    /// <summary>
    /// One container is ONE row carrying its whole contents, in slot order - the shape the ruling asks for.
    ///
    /// The two cross-product families answer "which (container, item) pairs exist", which is a transaction
    /// address rather than a fact about the world: a chest holding three items became three rows, and a chest
    /// holding 36 became a TRUNCATED window of 16. This family is the sensed entity: the container once, and
    /// every occupied slot inside it.
    /// </summary>
    [Fact]
    public void ChestStatePublishesOneContainerRowCarryingEveryItemItHolds()
    {
        const string woodQualifiedItemId = "(O)388";
        using var world = TargetFamilyWorld.Create();
        world.FreeOnePackSlot();
        world.PlaceOrdinaryChest(
            x: 2,
            y: 2,
            items: new[]
            {
                new ChestItem(WeedsQualifiedItemId, 5),
                new ChestItem(DiamondQualifiedItemId, 3),
                new ChestItem(woodQualifiedItemId, 99),
            });
        world.StandAt(1, 2);

        BridgeChestState chest = world.ChestStates().Should().ContainSingle().Subject;

        // Slot order, and every item: three items in the container is one row with three entries, never three
        // rows and never a window of them.
        chest.Items.Should().HaveCount(3, "the container's contents are a fact about THAT container, published whole");
        chest.Items.Select(item => item.Slot).Should().Equal(new[] { 0, 1, 2 }, "the container's own slot order");
        chest.Items.Select(item => item.QualifiedItemId)
            .Should().Equal(WeedsQualifiedItemId, DiamondQualifiedItemId, woodQualifiedItemId);
        chest.Items.Select(item => item.Stack).Should().Equal(5, 3, 99);
    }

    /// <summary>
    /// The identity the row carries is the SAME identity `chest_store`/`chest_retrieve` take as `chestId`, so a
    /// plan that names a container from this radar and the container the execution resolves are one spelling -
    /// not a second id minted for this family.
    ///
    /// Proved through the PRODUCTION resolution path (`ResolveStorageContainerById`, the function both handlers
    /// call), not by re-deriving the hash here: a test that recomputed the id could agree with itself while the
    /// handler disagreed with both.
    /// </summary>
    [Fact]
    public void ChestStateNamesTheContainerWithTheExistingExecutionTargetId()
    {
        using var world = TargetFamilyWorld.Create();
        world.FreeOnePackSlot();
        world.PlaceOrdinaryChest(x: 2, y: 2, items: new[] { new ChestItem(DiamondQualifiedItemId, 3) });
        world.StandAt(1, 2);

        string chestId = world.ChestStates().Should().ContainSingle().Subject.ChestId;

        ExecutionManager.StorageContainerResolution resolved = ExecutionManager.ResolveStorageContainerById(world.Farm, chestId);
        resolved.Resolved.Should().BeTrue("the id the radar publishes is the address an execution resolves");
        resolved.X.Should().Be(2);
        resolved.Y.Should().Be(2);
        resolved.IsFridge.Should().BeFalse();
        chestId.Should().StartWith("chest_");
    }

    /// <summary>
    /// A full chest is published in full. This is the measurement that condemned the cross product: 36 occupied
    /// slots used to reach the model as 16 rows, so twenty items of that chest could not be planned for at all.
    /// </summary>
    [Fact]
    public void ChestStateDoesNotTruncateAFullChest()
    {
        using var world = TargetFamilyWorld.Create();
        world.FreeOnePackSlot();
        world.PlaceOrdinaryChest(
            x: 2,
            y: 2,
            items: Enumerable.Range(0, 36).Select(index => new ChestItem($"(O){100 + index}", index + 1)).ToArray());
        world.StandAt(1, 2);

        BridgeChestState chest = world.ChestStates().Should().ContainSingle().Subject;

        chest.Items.Should().HaveCount(36, "a full chest's contents are not a budget decision");
        chest.Items.Select(item => item.Slot).Should().Equal(Enumerable.Range(0, 36));
    }

    /// <summary>
    /// Two containers are two rows, each with its own contents. The family's row count is the CONTAINER count,
    /// which is why it can no longer grow with the contents of its members.
    /// </summary>
    [Fact]
    public void ChestStatePublishesOneRowPerContainer()
    {
        using var world = TargetFamilyWorld.Create();
        world.FreeOnePackSlot();
        world.PlaceOrdinaryChest(x: 2, y: 2, items: new[] { new ChestItem(WeedsQualifiedItemId, 5) });
        world.PlaceOrdinaryChest(
            x: 3,
            y: 2,
            items: new[] { new ChestItem(DiamondQualifiedItemId, 3), new ChestItem("(O)388", 7) });
        world.StandAt(1, 2);

        IReadOnlyList<BridgeChestState> chests = world.ChestStates();

        chests.Should().HaveCount(2, "one row per container, whatever each one holds");
        chests.Select(chest => chest.ChestId).Distinct().Should().HaveCount(2);
        chests.Select(chest => chest.Items.Count).Should().BeEquivalentTo(new[] { 1, 2 });
        // Nearest first, the ordering every bounded radar family applies before its own cap.
        chests[0].X.Should().Be(2);
    }

    [Fact]
    public void NpcRelationshipPublishesAVillagerThePlayerHasNeverMet()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(1, 2);
        world.PlaceVillager(VillagerName, x: 2, y: 2, friendship: null);

        IReadOnlyList<BridgeNpcRelationshipTarget> rows = world.NpcRelationshipTargets();

        BridgeNpcRelationshipTarget villager = rows.Should().ContainSingle().Subject;
        villager.NpcName.Should().Be(VillagerName);

        // The zeroed relationship is the game's own reading of "no record yet": NPC.checkAction creates exactly
        // this record on the first conversation (NPC.cs:2511-2513, `new Friendship(0)`), so the projection is
        // publishing the state the engine is about to write rather than an invention.
        villager.FriendshipPoints.Should().Be(0);
        villager.FriendshipStatus.Should().Be("Friendly");
        villager.TalkedToToday.Should().BeFalse();
        villager.GiftsToday.Should().Be(0);
        villager.GiftsThisWeek.Should().Be(0);
    }

    [Fact]
    public void NpcRelationshipKeepsTheMetVillagersOwnRecord()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(1, 2);
        world.PlaceVillager(VillagerName, x: 2, y: 2, friendship: new Friendship(750) { TalkedToToday = true, GiftsToday = 1, GiftsThisWeek = 2 });

        BridgeNpcRelationshipTarget villager = world.NpcRelationshipTargets().Should().ContainSingle().Subject;

        villager.FriendshipPoints.Should().Be(750, "an existing record must be published as it is, not zeroed");
        villager.TalkedToToday.Should().BeTrue();
        villager.GiftsToday.Should().Be(1);
        villager.GiftsThisWeek.Should().Be(2);
    }

    /// <summary>One item a fixture puts into a chest: the two facts the retrieve projection reads.</summary>
    internal readonly record struct ChestItem(string QualifiedItemId, int Stack);

    /// <summary>
    /// A headless farm with a real farmer, real ordinary chests and real villagers.
    ///
    /// The shape follows the two existing game-thread-less harnesses (`ApproachClassificationTests.HeadlessWorld`,
    /// `SaplingApproachWiringTests.SaplingHarness`): an uninitialized `Game1`, a real `GameLocation` with the map
    /// layers the engine reads, and a `Farmer` whose NetFields are supplied because a process without a save never
    /// ran their initializers. The assembly disables xUnit parallelization, so mutating the statics is safe.
    /// </summary>
    private sealed class TargetFamilyWorld : IDisposable
    {
        private const long ActorId = 1001;
        private const int PackCapacity = 36;

        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;

        private TargetFamilyWorld()
        {
            this.gameBefore = Game1.game1;
            this.playerBefore = Game1.player;
            this.worldStateBefore = typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.GetValue(null);
        }

        internal GameLocation Farm { get; private set; } = null!;

        internal Farmer Actor { get; private set; } = null!;

        internal static TargetFamilyWorld Create()
        {
            var world = new TargetFamilyWorld();

            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, root);

            var farm = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            farm.map = map;
            farm.IsFarm = true;
            SetInstanceField(farm, "name", new NetString("ProbeFarm"));
            world.Farm = farm;

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            SetInstanceField(sprite, "spriteWidth", new NetInt(16));
            SetInstanceField(sprite, "spriteHeight", new NetInt(32));
            SetInstanceField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetInstanceField(actor, "position", new NetPosition());
            SetInstanceField(actor, "currentLocationRef", new NetLocationRef());
            SetInstanceField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetInstanceField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            SetInstanceField(actor, "uniqueMultiplayerID", new NetLong(ActorId));
            SetInstanceField(actor, "netStamina", new NetFloat(270f));
            SetInstanceField(actor, "temporaryItem", new NetRef<Item>());
            SetInstanceField(actor, "cursorSlotItem", new NetRef<Item>());
            SetInstanceField(actor, "currentToolIndex", new NetInt(0));
            SetInstanceField(actor, "netItemStowed", new NetBool(false));
            // The pack is the item source `chest_store` publishes and the capacity `chest_retrieve` tests.
            SetInstanceField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = new StardewValley.Inventories.Inventory() });
            SetInstanceField(actor, "maxItems", new NetInt(PackCapacity));
            SetInstanceField(actor, "friendshipData", new NetStringDictionary<Friendship, NetRef<Friendship>>());
            actor.position.Set(new Vector2(1 * 64 + 8, 2 * 64));
            actor.currentLocation = farm;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);
            world.Actor = actor;

            return world;
        }

        internal void StandAt(int tileX, int tileY) => this.Actor.position.Set(new Vector2(tileX * 64 + 8, tileY * 64));

        internal void PutInPackSlot(int slot, string qualifiedItemId, int stack)
        {
            while (this.Actor.Items.Count <= slot) this.Actor.Items.Add(null!);
            this.Actor.Items[slot] = Item(qualifiedItemId, stack);
        }

        /// <summary>Leaves one empty pack slot, which is what `couldInventoryAcceptThisItem` needs to say yes.</summary>
        internal void FreeOnePackSlot() => this.Actor.Items.Add(null!);

        internal void PlaceOrdinaryChest(int x, int y, IReadOnlyList<ChestItem> items)
        {
            var chest = new StardewValley.Objects.Chest();
            chest.playerChest.Value = true;
            chest.globalInventoryId.Value = null;
            chest.ItemId = "130";
            chest.TileLocation = new Vector2(x, y);
            foreach (ChestItem item in items) chest.Items.Add(Item(item.QualifiedItemId, item.Stack));
            this.Farm.objects[new Vector2(x, y)] = chest;
        }

        internal void PlaceVillager(string name, int x, int y, Friendship? friendship)
        {
            var npc = new NPC
            {
                Name = name,
                Position = new Vector2(x * 64, y * 64),
            };
            if (friendship is not null) this.Actor.friendshipData[name] = friendship;
            this.Farm.characters.Add(npc);
        }

        internal IReadOnlyList<BridgeChestState> ChestStates() =>
            (IReadOnlyList<BridgeChestState>)Discover("DiscoverChestStates");

        internal IReadOnlyList<BridgeNpcRelationshipTarget> NpcRelationshipTargets() =>
            (IReadOnlyList<BridgeNpcRelationshipTarget>)Discover("DiscoverNpcRelationshipTargets");

        private object Discover(string name)
        {
            var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "chest_store", "chest_retrieve" });
            var executions = new ExecutionManager(new DummyMonitor(), () => publication);
            MethodInfo method = typeof(ExecutionManager).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)!;
            object?[] arguments = method.IsStatic ? new object?[] { this.Actor } : new object?[] { this.Actor };
            return method.Invoke(method.IsStatic ? null : executions, arguments)!;
        }

        /// <summary>One item carrying exactly the identity the projections read, built without a content manager.</summary>
        private static StardewValley.Object Item(string qualifiedItemId, int stack)
        {
            var item = new StardewValley.Object();
            item.Stack = stack;
            item.ItemId = qualifiedItemId[3..];
            // ItemId clears the qualified cache, so the qualified value the projection compares is written after it.
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(item, qualifiedItemId);
            return item;
        }

        private static void SetInstanceField(object target, string name, object value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);

        public void Dispose()
        {
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, this.playerBefore);
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, this.worldStateBefore);
            Game1.game1 = this.gameBefore!;
        }
    }
}
