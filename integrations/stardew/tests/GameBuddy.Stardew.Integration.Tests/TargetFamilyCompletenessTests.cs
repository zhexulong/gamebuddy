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
    ///
    /// <para>
    /// `internal` rather than `private` because `SnapshotLoopbackExportTests` drives this SAME world to publish the
    /// snapshot sample the Host validates: a second copy of the harness would be a second authority over what
    /// "a headless farm" means, and the sample would then prove nothing about the world these tests build.
    /// </para>
    /// </summary>
    internal sealed class TargetFamilyWorld : IDisposable
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
            // WIA admission reads the per-tick disposition (WorldModel.ReadFacts), so a probe Farmer must supply every
            // NetField it touches. The round-trip probe drives each action's REAL preflight, which means this world's
            // actor now has to survive admission as well as discovery.
            SetInstanceField(actor, "usingTool", new NetBool(false));
            SetInstanceField(actor, "toolPower", new NetInt(0));
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

        internal void FreeOnePackSlot() => this.Actor.Items.Add(null!);

        /// <summary>
        /// A real TOOL in a pack slot. `DiscoverToolSlots` selects `items[slot] is Tool`, so an `Object` carrying a
        /// tool's item id is not the same fact: the identity and the upgrade level are seeded through the fields
        /// `Tool.UpgradeLevel` and `Item.QualifiedItemId` are backed by, because `new Axe()` loads game content.
        /// </summary>
        internal void PutToolInPackSlot(int slot, string qualifiedItemId, int upgradeLevel)
        {
            var tool = (StardewValley.Tools.Axe)FormatterServices.GetUninitializedObject(typeof(StardewValley.Tools.Axe));
            SetInstanceField(tool, "upgradeLevel", new NetInt(upgradeLevel));
            typeof(Item)
                .GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(tool, qualifiedItemId);
            while (this.Actor.Items.Count <= slot) this.Actor.Items.Add(null!);
            this.Actor.Items[slot] = tool;
        }

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

        /// <summary>
        /// A living tree at the durability the ENGINE gives one, not a fixture's convenience value.
        ///
        /// <c>new Tree(id, growthStage)</c> assigns <c>health.Value = 10f</c> itself (Tree.cs:181), and <c>10</c> is what a
        /// real farm carries. The chop-tree fixture in `ModEntry.Fixtures.cs` writes <c>1f</c> so one axe swing fells it,
        /// which is exactly how a Host bound of <c>=== 1</c> stayed green against a fixture nobody farms.
        /// </summary>
        internal void PlaceTree(int x, int y)
        {
            var tree = new StardewValley.TerrainFeatures.Tree("1", StardewValley.TerrainFeatures.Tree.treeStage);
            this.Farm.terrainFeatures[new Vector2(x, y)] = tree;
        }

        /// <summary>A felled tree's stump at the health the engine assigns when it falls (<c>stump = true; health = 5f</c>).</summary>
        internal void PlaceStump(int x, int y)
        {
            var tree = new StardewValley.TerrainFeatures.Tree("1", StardewValley.TerrainFeatures.Tree.treeStage)
            {
                health = { Value = 5f },
            };
            tree.stump.Value = true;
            this.Farm.terrainFeatures[new Vector2(x, y)] = tree;
        }

        /// <summary>
        /// A weed in the object layer. `Object.IsWeeds()` is `Category == -999 && Name.ContainsIgnoreCase("weeds")`
        /// (Object.cs:6117), so the object is built from exactly those two facts and the projection's own predicate
        /// decides whether it is published - the fixture never asserts the answer.
        /// </summary>
        internal void PlaceWeed(int x, int y)
        {
            StardewValley.Object weed = PlacedObject("(O)313", name: "Weeds", category: -999);
            weed.MinutesUntilReady = 1;
            this.Farm.objects[new Vector2(x, y)] = weed;
        }

        /// <summary>A breakable stone at a real multi-hit durability, so the family is published at something other than 1.</summary>
        internal void PlaceRock(int x, int y, int durability)
        {
            StardewValley.Object rock = PlacedObject("(O)2", name: "Stone", category: -999);
            rock.MinutesUntilReady = durability;
            this.Farm.objects[new Vector2(x, y)] = rock;
        }

        /// <summary>A grass tuft, which is a TerrainFeature rather than an object-layer weed.</summary>
        internal void PlaceGrass(int x, int y) =>
            this.Farm.terrainFeatures[new Vector2(x, y)] = new StardewValley.TerrainFeatures.Grass(1, 4);

        /// <summary>
        /// A hoedirt tile carrying a crop that wants water, built from the two facts `DiscoverCropTargets` reads
        /// (`needsWatering()` / `isWatered()`), never from a hand-written row.
        /// </summary>
        internal void PlaceWaterableCrop(int x, int y)
        {
            var dirt = new StardewValley.TerrainFeatures.HoeDirt();
            SetInstanceField(dirt, "state", new NetInt(0));
            dirt.crop = NewCrop(seedIndex: "472", phaseDaysLeft: 2, fullyGrown: false);
            this.Farm.terrainFeatures[new Vector2(x, y)] = dirt;
        }

        /// <summary>
        /// A hoedirt tile whose crop reports `readyForHarvest()` through the engine's own day counter, so
        /// `DiscoverHarvestTargets` decides it - the family whose season-killed case was `24d8168e`.
        /// </summary>
        internal void PlaceHarvestableCrop(int x, int y)
        {
            var dirt = new StardewValley.TerrainFeatures.HoeDirt();
            SetInstanceField(dirt, "state", new NetInt(0));
            dirt.crop = NewCrop(seedIndex: "472", phaseDaysLeft: 0, fullyGrown: true);
            this.Farm.terrainFeatures[new Vector2(x, y)] = dirt;
        }

        /// <summary>One object-layer forageable, the subject `DiscoverForageTargets` scans for.</summary>
        internal void PlaceForage(int x, int y, string qualifiedItemId)
        {
            StardewValley.Object forage = PlacedObject(qualifiedItemId, name: "Daffodil", category: -81);
            forage.IsSpawnedObject = true;
            forage.Stack = 1;
            this.Farm.objects[new Vector2(x, y)] = forage;
        }

        /// <summary>One Debris chunk on a tile, the subject `DiscoverItemTargets` publishes.</summary>
        internal void PlaceGroundDrop(int x, int y, string qualifiedItemId)
        {
            var chunks = new NetObjectShrinkList<Chunk>();
            chunks.Add(new Chunk(new Vector2(x * 64, y * 64), 0f, 0f, 0));
            var debris = (Debris)FormatterServices.GetUninitializedObject(typeof(Debris));
            SetInstanceField(debris, "chunks", chunks);
            SetInstanceField(debris, "debrisType", new NetEnum<Debris.DebrisType>(Debris.DebrisType.OBJECT));
            SetInstanceField(debris, "itemId", new NetString(qualifiedItemId[3..]));
            SetInstanceField(debris, "netItem", new NetRef<Item> { Value = Item(qualifiedItemId, 1) });
            SetInstanceField(debris, "netItemQuality", new NetInt(0));
            SetInstanceField(debris, "DroppedByPlayerID", new NetLong(ActorId));
            this.Farm.debris.Add(debris);
        }

        /// <summary>
        /// One edge warp the location declares. The `warps` family is projected INLINE in `CreateBridgeSnapshot`
        /// (`player.currentLocation.warps.Select(...)`), not by a `Discover*` method, which is why it has no entry in
        /// <see cref="DiscoveryMethodFor"/> and gets its own row projection below.
        /// </summary>
        internal void PlaceEdgeWarp(int sourceX, int sourceY, string targetLocation, int targetX, int targetY) =>
            this.Farm.warps.Add(new StardewValley.Warp(sourceX, sourceY, targetLocation, targetX, targetY, flipFarmer: false));

        /// <summary>
        /// The `warps` rows in the shape `CreateBridgeSnapshot` publishes: the location's own warp list, filtered by
        /// the same bounds the snapshot applies. The one projection this file restates, because the family has no
        /// `Discover*` method to drive - stated here rather than leaving the family in `Undriven` as though a headless
        /// world could not declare a warp, which it plainly can.
        /// </summary>
        internal IReadOnlyList<object> WarpRows() =>
            this.Farm.warps
                .Where(warp => !warp.npcOnly.Value
                    && !string.IsNullOrWhiteSpace(warp.TargetName)
                    && warp.X >= -1 && warp.Y >= -1 && warp.X <= 1000 && warp.Y <= 1000
                    && warp.TargetX >= 0 && warp.TargetY >= 0 && warp.TargetX <= 1000 && warp.TargetY <= 1000)
                .Select(warp => (object)new RoundTripWarpRow(warp.X, warp.Y, warp.TargetName, warp.TargetX, warp.TargetY))
                .ToArray();

        /// <summary>One published warp, carrying the field names `travel`/`enter_exit` read (`sourceX`, `sourceY`).</summary>
        internal sealed record RoundTripWarpRow(int SourceX, int SourceY, string Target, int TargetX, int TargetY);

        /// <summary>
        /// A crop built without a content manager: `netSeedIndex`, `indexOfHarvest` and the day counters are the fields
        /// the two crop projections read, and `new Crop(id, ...)` needs `Data/Crops` which this process never loads.
        ///
        /// The four fields below are exactly what `HoeDirt.readyForHarvest()` (`HoeDirt.cs:465-476`) and
        /// `HoeDirt.isWatered()` (`:391`) read, so the shipped predicates decide - this method writes state, never an
        /// answer.
        /// </summary>
        private static StardewValley.Crop NewCrop(string seedIndex, int phaseDaysLeft, bool fullyGrown)
        {
            var crop = (StardewValley.Crop)FormatterServices.GetUninitializedObject(typeof(StardewValley.Crop));
            SetInstanceField(crop, "netSeedIndex", new NetString(seedIndex));
            SetInstanceField(crop, "indexOfHarvest", new NetString("24"));
            SetInstanceField(crop, "overrideTexturePath", new NetString(null));
            SetInstanceField(crop, "rowInSpriteSheet", new NetInt(0));
            SetInstanceField(crop, "fullyGrown", new NetBool(fullyGrown));
            SetInstanceField(crop, "forageCrop", new NetBool(false));
            SetInstanceField(crop, "dead", new NetBool(false));
            SetInstanceField(crop, "dayOfCurrentPhase", new NetInt(0));
            // `HoeDirt.readyForHarvest()` is `currentPhase >= phaseDays.Count - 1` (HoeDirt.cs:467), so the phase list
            // and the current phase are what decide it - never a flag this method writes.
            var phases = new NetIntList();
            for (int index = 0; index < 5; index++) phases.Add(1);
            SetInstanceField(crop, "phaseDays", phases);
            SetInstanceField(crop, "currentPhase", new NetInt(fullyGrown ? 4 : 1));
            // `Crop.GetData()` reads `Game1.cropData` (Data/Crops), which a process without content never loads. An
            // EMPTY dictionary is honest: every crop then takes the engine's own documented default
            // (`GetHarvestMethod()?.HarvestMethod ?? HarvestMethod.Grab`, `RegrowsAfterHarvest() -> false`), so the
            // shipped predicates still decide.
            Game1.cropData ??= new Dictionary<string, StardewValley.GameData.Crops.CropData>(StringComparer.Ordinal);
            return crop;
        }

        internal IReadOnlyList<BridgeChestState> ChestStates() =>
            (IReadOnlyList<BridgeChestState>)Discover("DiscoverChestStates");

        internal IReadOnlyList<BridgeNpcRelationshipTarget> NpcRelationshipTargets() =>
            (IReadOnlyList<BridgeNpcRelationshipTarget>)Discover("DiscoverNpcRelationshipTargets");

        /// <summary>
        /// Builds one honest instance of every family this headless world can construct, through the SAME placement
        /// helpers the completeness cases use.
        ///
        /// Nothing is written into a projection's input by hand to make a family appear: each family is built from the
        /// game types the engine itself would build and the SHIPPED `Discover*` method decides whether it publishes.
        /// A family this world cannot build is not silently empty - `TargetFamilyRoundTripTests` names it in `Undriven`
        /// with the blocker, so the gap is a count rather than an absence.
        /// </summary>
        internal void PopulateFor(string family)
        {
            // The pack first: every tool-driven action's preflight refuses `*_not_equipped_in_requested_slot` or
            // `tool_not_owned:<category>` BEFORE it ever looks at the target, so a world without the declared tool
            // makes the round trip pass while the target check never runs - the vacuous shape this gate exists for.
            switch (family)
            {
                case "treeChopSourceTargets":
                    this.PlaceTree(x: 3, y: 2);
                    this.StandAt(2, 2);
                    break;
                case "treeStumpTargets":
                    this.PlaceStump(x: 3, y: 2);
                    this.StandAt(2, 2);
                    break;
                case "weedTargets":
                    this.PlaceWeed(x: 3, y: 2);
                    this.StandAt(2, 2);
                    break;
                case "rockSourceTargets":
                    // A mine node's durability, so the family is exercised at something other than the one-hit value
                    // that `def2fb07` filtered everything else out with.
                    this.PlaceRock(x: 3, y: 2, durability: 3);
                    this.StandAt(2, 2);
                    break;
                case "grassTargets":
                    this.PlaceGrass(x: 3, y: 2);
                    this.StandAt(2, 2);
                    break;
                case "chests":
                    this.FreeOnePackSlot();
                    this.PutInPackSlot(1, "(O)72", 1);
                    this.PlaceOrdinaryChest(x: 2, y: 3, items: new[] { new ChestItem("(O)72", 3) });
                    this.StandAt(2, 2);
                    break;
                case "npcRelationshipTargets":
                    this.PlaceVillager("Abigail", x: 2, y: 3, friendship: null);
                    this.StandAt(2, 2);
                    break;
                case "cropTargets":
                    this.PlaceWaterableCrop(x: 2, y: 3);
                    this.PutInPackSlot(1, "(T)WateringCan", 1);
                    this.StandAt(2, 2);
                    break;
                case "itemTargets":
                    this.PlaceGroundDrop(x: 2, y: 3, qualifiedItemId: "(O)24");
                    this.StandAt(2, 2);
                    break;
                case "forageTargets":
                    this.PlaceForage(x: 2, y: 3, qualifiedItemId: "(O)16");
                    this.StandAt(2, 2);
                    break;
                case "warps":
                    this.PlaceEdgeWarp(sourceX: 3, sourceY: 2, targetLocation: "Forest", targetX: 10, targetY: 10);
                    this.StandAt(2, 2);
                    break;
                case "toolSlots":
                    this.PutToolInPackSlot(0, "(T)Axe", upgradeLevel: 0);
                    this.StandAt(2, 2);
                    break;
                default:
                    throw new InvalidOperationException(
                        $"{family} has no populate rule: a family this file claims to drive must say how the world builds it");
            }
        }

        /// <summary>The rows the REAL `Discover*` publishes for one family, in the wire shape the snapshot carries.</summary>
        internal IReadOnlyList<object> Rows(string family) =>
            // `DiscoverToolSlots` reads the PACK, not the actor, so it takes a different argument from every other
            // discovery method. Named here rather than widening `Discover` with an optional parameter that no other
            // family would use.
            family == "toolSlots"
                ? (IReadOnlyList<object>)typeof(ExecutionManager)
                    .GetMethod("DiscoverToolSlots", BindingFlags.NonPublic | BindingFlags.Static)!
                    .Invoke(null, new object?[] { this.Actor.Items })!
                : (IReadOnlyList<object>)Discover(DiscoveryMethodFor(family));

        /// <summary>
        /// The discovery method each family's rows come from, read from the ONE family-to-method mapping the
        /// snapshot's own construction already uses rather than a second table here.
        ///
        /// `warps` is absent on purpose: it is projected INLINE in `CreateBridgeSnapshot`
        /// (`player.currentLocation.warps.Select(...)`), so it has no `Discover*` method to drive. Its round trip is
        /// asserted through <see cref="WarpRows"/> instead, which reads the same `location.warps` the snapshot reads.
        /// </summary>
        private static string DiscoveryMethodFor(string family) => family switch
        {
            "treeChopSourceTargets" => "DiscoverTreeChopSourceTargets",
            "treeStumpTargets" => "DiscoverTreeStumpTargets",
            "weedTargets" => "DiscoverWeedTargets",
            "rockSourceTargets" => "DiscoverRockSourceTargets",
            "grassTargets" => "DiscoverGrassTargets",
            "chests" => "DiscoverChestStates",
            "npcRelationshipTargets" => "DiscoverNpcRelationshipTargets",
            "cropTargets" => "DiscoverCropTargets",
            "harvestTargets" => "DiscoverHarvestTargets",
            "itemTargets" => "DiscoverItemTargets",
            "forageTargets" => "DiscoverForageTargets",
            _ => throw new InvalidOperationException($"{family} has no discovery method declared"),
        };

        /// <summary>Why a family published nothing, so a vacuous round trip names the world it was run against.</summary>
        internal string Describe(string family) =>
            $"{family} published 0 rows against objects={this.Farm.objects.Count()} "
            + $"terrainFeatures={this.Farm.terrainFeatures.Count()} characters={this.Farm.characters.Count} "
            + $"debris={this.Farm.debris.Count} warps={this.Farm.warps.Count} buildings={this.Farm.buildings.Count} "
            + $"actor={this.Actor.Tile.X},{this.Actor.Tile.Y}";

        /// <summary>
        /// A manager the action's own preflight can be driven through, with the scope bound to this probe actor so
        /// the admission guard passes and the target checks are the ones that decide.
        /// </summary>
        internal ExecutionManager NewExecutionManager(string actionId)
        {
            var scope = new BridgeScope("stardew", "save_probe", "world_probe", ActorId.ToString(System.Globalization.CultureInfo.InvariantCulture), "companion_probe");
            var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { actionId });
            var executions = new ExecutionManager(
                new DummyMonitor(),
                () => publication,
                executionJournal: new FarmhandExecutionJournal(new RoundTripPersistence()),
                executionScope: scope);
            executions.SetTestActorResolver(() => this.Actor);
            return executions;
        }

        /// <summary>An in-memory journal store: this probe never restarts, so nothing has to survive one.</summary>
        private sealed class RoundTripPersistence : IModGlobalDataPersistence
        {
            private FarmhandExecutionJournalState? state;

            public FarmhandExecutionJournalState? Read(string key) => this.state;

            public bool TryWrite(string key, FarmhandExecutionJournalState value)
            {
                this.state = value;
                return true;
            }
        }

        /// <summary>
        /// One real `Discover*` family by name, so a caller outside this file drives the SAME production projection this
        /// file's cases drive rather than a second copy of it.
        /// </summary>
        internal object DiscoverFamily(string name) => Discover(name);

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
            StardewValley.Object item = PlacedObject(qualifiedItemId, name: null, category: 0);
            item.Stack = stack;
            return item;
        }

        /// <summary>
        /// One object with the identity fields the projections read written explicitly.
        ///
        /// `ItemId` clears the qualified cache, so the qualified value is written AFTER it; a process without a content
        /// manager has no `Data/Objects` row to resolve one from, and the projections compare the qualified id.
        /// </summary>
        private static StardewValley.Object PlacedObject(string qualifiedItemId, string? name, int category)
        {
            var item = new StardewValley.Object();
            if (name is not null) item.Name = name;
            item.Category = category;
            item.ItemId = qualifiedItemId[3..];
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
