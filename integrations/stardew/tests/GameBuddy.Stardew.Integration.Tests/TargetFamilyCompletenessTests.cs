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

    /// <summary>
    /// The summary counts the LOCATION, not the radius-6 window `chests` publishes.
    ///
    /// <para>
    /// This is the distinction the field exists for and the one a reader would get wrong: `DiscoverChestStates` is
    /// bounded to `TargetDiscoveryRadius` so a container out of reach is not offered as an action, and a summary counted
    /// from that list would print `chests here: 0` while a chest stands ten tiles away. That is the false-zero shape
    /// `待浇水作物: 0` was, measured 2026-10-31.
    /// </para>
    /// <para>
    /// So the world below holds one chest INSIDE the radius and one FAR OUTSIDE it, and the two numbers must disagree:
    /// the entity family publishes one row, the summary counts both. The counts themselves are the shape the formatter
    /// renders - three chests holding two, one and no items.
    /// </para>
    /// </summary>
    [Fact]
    public void ChestsSummaryCountsTheWholeLocationRatherThanTheRadiusWindow()
    {
        using var world = TargetFamilyWorld.Create();
        world.FreeOnePackSlot();
        world.PlaceOrdinaryChest(x: 2, y: 2, items: new[] { new ChestItem(WeedsQualifiedItemId, 2) });
        world.PlaceOrdinaryChest(x: 3, y: 2, items: new[] { new ChestItem(DiamondQualifiedItemId, 1) });
        world.PlaceOrdinaryChest(x: 4, y: 2, items: Array.Empty<ChestItem>());
        // Well past the six-tile discovery radius, and still this location's chest.
        world.PlaceOrdinaryChest(x: 14, y: 14, items: new[] { new ChestItem("(O)388", 9) });
        world.StandAt(1, 2);

        IReadOnlyList<BridgeChestState> published = world.ChestStates();
        BridgeChestsSummary summary = world.ChestsSummary();

        published.Should().HaveCount(3, "the entity family keeps its radius bound: the far chest is not offered as an action");
        summary.ChestCount.Should().Be(
            4,
            "the summary answers 'what is in my chests', so a container across the farm is still this location's chest");
        summary.ItemCount.Should().Be(12, "2 + 1 + 9 items: the sum of every occupied slot's stack, not the slot count");
        summary.FullCount.Should().Be(0, "every chest here has free slots");
    }

    /// <summary>
    /// A chest with no free slot is counted as full, at the engine's own capacity.
    ///
    /// The threshold is `Chest.GetActualCapacity()` (36 for an ordinary chest), not a number written here: `Chest.addItem`
    /// refuses a new stack at exactly that count (Chest.cs:883-888). Both sides of the boundary are built, because a
    /// predicate that reported every chest full and one that reported none would each pass a single-sided test.
    /// </summary>
    [Fact]
    public void ChestsSummaryCountsAContainerAtTheEnginesOwnCapacityAsFull()
    {
        using var world = TargetFamilyWorld.Create();
        world.FreeOnePackSlot();
        world.PlaceOrdinaryChest(
            x: 2,
            y: 2,
            items: Enumerable.Range(0, 36).Select(index => new ChestItem($"(O){100 + index}", 1)).ToArray());
        world.PlaceOrdinaryChest(
            x: 3,
            y: 2,
            items: Enumerable.Range(0, 35).Select(index => new ChestItem($"(O){200 + index}", 1)).ToArray());
        world.StandAt(1, 2);

        BridgeChestsSummary summary = world.ChestsSummary();

        summary.ChestCount.Should().Be(2);
        summary.FullCount.Should().Be(1, "36 occupied slots is `GetActualCapacity()`, and 35 is one short of it");
        summary.ItemCount.Should().Be(71, "every occupied slot holds one item");
    }

    /// <summary>
    /// A location with no chests says ZERO rather than publishing nothing.
    ///
    /// The two states must stay distinguishable: an ABSENT summary means the Mod did not measure it (the container actions
    /// were not advertised), while a present one holding zeroes is the answer to "do I have any chests here". A projection
    /// that omitted the row when the count was zero would make those two the same fact on the wire.
    /// </summary>
    [Fact]
    public void ChestsSummaryReportsZeroForALocationWithNoChests()
    {
        using var world = TargetFamilyWorld.Create();
        world.FreeOnePackSlot();
        world.StandAt(1, 2);

        BridgeChestsSummary summary = world.ChestsSummary();

        summary.Should().Be(new BridgeChestsSummary(0, 0, 0), "a measured zero is an answer, not an absence");
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

    /// <summary>
    /// A bush is a `LargeTerrainFeature`, and `location.largeTerrainFeatures` is the only collection the engine
    /// inserts one into (GameLocation.cs:17403-17421). A bush stored there has to be published, because a bush the
    /// snapshot omits is a bush the companion cannot harvest, shake or even see.
    ///
    /// <para>
    /// This is the exact shape the observation-gap report named as `collection_never_read:largeTerrainFeatures`
    /// while the discovery walked `location.terrainFeatures` - a collection a bush cannot stand in in a saved game.
    /// </para>
    /// </summary>
    [Fact]
    public void BushPublishesABushStoredInLargeTerrainFeatures()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(1, 2);
        world.PlaceHarvestableBush(x: 3, y: 2);

        BridgeBushTarget bush = world.BushTargets().Should().ContainSingle().Subject;

        bush.X.Should().Be(3);
        bush.Y.Should().Be(2);
        bush.Location.Should().Be("ProbeFarm");
        bush.TargetId.Should().StartWith("bush_");
    }

    /// <summary>
    /// One bush is ONE row. `largeTerrainFeatures` and `terrainFeatures` are both keyed by tile, so a bush reachable
    /// from both is the same bush at the same tile and cannot be published twice: the model would otherwise be
    /// offered two targets that are one, and a plan naming either would look like a second bush to harvest.
    /// </summary>
    [Fact]
    public void BushReachableFromBothCollectionsIsPublishedOnce()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(1, 2);
        StardewValley.TerrainFeatures.Bush bush = world.PlaceHarvestableBush(x: 3, y: 2);
        world.PlaceBushInTerrainFeatures(x: 3, y: 2, bush);

        world.BushTargets().Should().ContainSingle("one bush at one tile is one target, however many collections reach it");
    }

    /// <summary>
    /// The row published from `largeTerrainFeatures` carries the identity the execution path resolves, so the Host
    /// contract is unchanged: the id comes from the one `BuildBushTargetId` function both halves already share, and
    /// `TryGetHarvestableBush` - the native re-check every `harvest_bush` request begins with - accepts it.
    /// </summary>
    [Fact]
    public void BushPublishedFromLargeTerrainFeaturesIsTheIdExecutionAccepts()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(1, 2);
        world.PlaceHarvestableBush(x: 3, y: 2);
        string targetId = world.BushTargets().Should().ContainSingle().Subject.TargetId;

        MethodInfo tryGet = typeof(ExecutionManager)
            .GetMethod("TryGetHarvestableBush", BindingFlags.NonPublic | BindingFlags.Static)!;
        object?[] arguments = { world.Farm, 3, 2, targetId, null };
        bool accepted = (bool)tryGet.Invoke(null, arguments)!;

        accepted.Should().BeTrue("the id the snapshot publishes is the id the handler re-checks the bush against");
        arguments[4].Should().BeOfType<StardewValley.TerrainFeatures.Bush>();
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

        private readonly Dictionary<string, object?> staticsBefore;

        /// <summary>
        /// SMAPI's readiness flag, reached the way `ApproachClassificationTests.HeadlessWorld` reaches it:
        /// `Context.IsWorldReady` is not settable, it reads `PerScreen&lt;bool&gt;.States[Context.ScreenId]`.
        /// </summary>
        private static readonly FieldInfo WorldReadyPerScreen = typeof(StardewModdingAPI.Context)
            .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
            .GetGetMethod()!
            .Module.ResolveField(BitConverter.ToInt32(typeof(StardewModdingAPI.Context)
                .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
                .GetGetMethod()!.GetMethodBody()!.GetILAsByteArray()!, 1))!;

        private TargetFamilyWorld()
        {
            this.staticsBefore = HeadlessGameWorld.CaptureStatics();
        }

        internal GameLocation Farm { get; private set; } = null!;

        internal Farmer Actor { get; private set; } = null!;

        internal static TargetFamilyWorld Create()
        {
            var world = new TargetFamilyWorld();

            // A world fixture owns the `Game1` singleton while it runs: reusing a leftover instance would write this
            // world's location book on somebody else's singleton, and `getLocationFromName` answers from that book for
            // every later class that reuses the name.
            Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, root);
            // `Game1.random` is a plain static assigned during game startup. `Bush`'s own constructor calls
            // `Game1.random.NextBool()` (Bush.cs:109), and so do several other engine constructors this world drives.
            Game1.random ??= new Random(1);
            // `Game1.recentMultiplayerRandom` is the same kind of plain static (`new Random()`, Game1.cs:817/:2238), and
            // every native DEBRIS spawn reads it: `Debris.InitializeChunks` builds each chunk from
            // `Game1.recentMultiplayerRandom.Next(...)` (:557). An uninitialized `Game1` leaves it null, so the FIRST
            // cosmetic chunk of any tool swing threw inside `Game1.createRadialDebris` - which is why
            // `break_resource_clump`, `clear_debris` and `break_rock` were each reported as a harness limit there
            // rather than at whatever they actually reach next.
            Game1.recentMultiplayerRandom ??= new Random(1);
            // Two more plain statics the preflights dereference once the actor survives admission: `otherFarmers`
            // backs `FarmerCollection.Any` (`isPlayerPresent` reads it while building a native path), and
            // `hudMessages` is read by `Farmer.couldInventoryAcceptThisItem` (Farmer.cs:4741) whenever the pack is
            // full. Both are assigned in `Game1`'s own startup, so an uninitialized `Game1` leaves them null.
            Game1.otherFarmers ??= new NetRootDictionary<long, Farmer>();
            Game1.hudMessages ??= new List<HUDMessage>();
            // `Game1.options` is created in `Game1`'s constructor, and its own constructor calls `setToDefaults` which
            // reads game content (Options.cs:624). `Rumble.rumble` - reached by every native tool swing that lands a
            // hit - reads only `gamepadControls` and `rumble`, so those two plain bools are seeded and both stay false:
            // a headless process has no gamepad, which is the honest value rather than a convenience one.
            var options = (Options)FormatterServices.GetUninitializedObject(typeof(Options));
            SetInstanceField(options, "gamepadControls", false);
            SetInstanceField(options, "rumble", false);
            Game1.options ??= options;
            // `Game1.locations` is `game1._locations`, an instance field on the uninitialized `Game1` singleton.
            if (Game1.game1!._locations is null) Game1.game1._locations = new List<GameLocation>();
            // `LocationContexts.Require` (LocationContexts.cs:29) indexes `Game1.locationContextData`, loaded from
            // `Data/LocationContexts`. One `Default` row is what every outdoor location carries; the fields the shipped
            // predicates read stay at their type defaults, exactly as an empty `cropData` does.
            Game1.locationContextData ??= new Dictionary<string, StardewValley.GameData.LocationContexts.LocationContextData>(StringComparer.Ordinal)
            {
                ["Default"] = new StardewValley.GameData.LocationContexts.LocationContextData(),
            };
            // `Pet.GetPetData` -> `Pet.TryGetData` -> `Game1.petData.TryGetValue` (Pet.cs:265) with no null guard, so a
            // process without a save leaves every pet read throwing. One `Dog` row is enough for the projections: the
            // behaviour list is empty, which is `GetCurrentPetBehavior() == null` and therefore the `Stationary: true`
            // the discovery publishes for a pet that is not walking. `GiftChance` stays at its type default (0), so the
            // native petting body's drop roll never fires and no item type registry is read.
            Game1.petData ??= new Dictionary<string, StardewValley.GameData.Pets.PetData>(StringComparer.Ordinal)
            {
                ["Dog"] = new StardewValley.GameData.Pets.PetData(),
            };

            var farm = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            // `Bush`'s own constructor reads `location.map.RequireLayer("Front")` (Bush.cs:91), and `GameLocation`
            // reads the same layer for several of its own predicates, so the map declares it like a real farm map does.
            map.AddLayer(new xTile.Layers.Layer("Front", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            farm.map = map;
            farm.IsFarm = true;
            SetInstanceField(farm, "name", new NetString("ProbeFarm"));
            world.Farm = farm;

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            SetInstanceField(sprite, "spriteWidth", new NetInt(16));
            SetInstanceField(sprite, "spriteHeight", new NetInt(32));
            SetInstanceField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SeedMissingNetFields(actor);
            SetInstanceField(actor, "position", new NetPosition());
            SetInstanceField(actor, "currentLocationRef", new NetLocationRef());
            SetInstanceField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetInstanceField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            SetInstanceField(actor, "uniqueMultiplayerID", new NetLong(ActorId));
            SetInstanceField(actor, "netStamina", new NetFloat(270f));
            // `Farmer.maxStamina` is `new NetInt(270)` (Farmer.cs:599) and `MaxStamina` is
            // `Math.Max(maxStamina.Value + buffs.MaxStamina, 0)` (Farmer.cs:1842). An uninitialized instance never ran
            // the initializer, so it reports a maximum of ZERO, and `Farmer.Stamina`'s setter clamps every write to
            // `Math.Min(MaxStamina, ...)` (Farmer.cs:1836) - which meant the FIRST tool swing of any action drove the
            // probe actor to 0 stamina. That put every swing into `Farmer.checkForExhaustion`'s "you are exhausted"
            // branch, which reads `Game1.content` strings, so `break_resource_clump`, `clear_hoedirt` and the rest were
            // all reported as a harness limit at a seam none of them owns. A real farmer starts at 270.
            SetInstanceField(actor, "maxStamina", new NetInt(270));
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
            // It is created at its FULL capacity, because that is what a real farmer carries and what the engine's own
            // predicates assume: `Farmer.isInventoryFull()` (Farmer.cs:4702) walks `maxItems` slots and answers "full"
            // for every slot the list does not hold, so a zero-length `Inventory` reads as a FULL pack. That is not
            // cosmetic - `couldInventoryAcceptThisItem` then falls into its "pack is full" branch and calls
            // `Game1.content.LoadString` (Farmer.cs:4743), which is null here, so `pickup_item` and `chest_retrieve`
            // threw a NullReferenceException that the probe swallowed as a harness limit instead of reaching the
            // inventory question they were there to ask.
            var pack = new StardewValley.Inventories.Inventory();
            for (int slot = 0; slot < PackCapacity; slot++) pack.Add(null!);
            SetInstanceField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = pack });
            SetInstanceField(actor, "maxItems", new NetInt(PackCapacity));
            SetInstanceField(actor, "friendshipData", new NetStringDictionary<Friendship, NetRef<Friendship>>());
            // `Game1.stats` IS `player.stats` (Game1.cs:1671), and several engine constructors and predicates read it
            // (`Bush.loadSprite` calls `Utility.CreateRandom(Game1.stats.DaysPlayed, ...)`, Bush.cs:277). A real farmer
            // always carries one; an uninitialized instance has null.
            SetInstanceField(actor, "stats", new Stats());
            // `Farmer.experiencePoints` is `new NetArray<int, NetInt>(6)` in the field initializer - one slot per
            // skill. An uninitialized farmer carries an EMPTY array, and every native skill award indexes it directly
            // (`experiencePoints[which]`, Farmer.cs:3048-3049), so the destroying swing of `break_resource_clump`
            // (`t.getLastFarmerToUse().gainExperience(2, 25)`, ResourceClump.cs:239) threw
            // ArgumentOutOfRangeException from inside the game's own bookkeeping.
            SetInstanceField(actor, "experiencePoints", new NetArray<int, NetInt>(6));
            actor.position.Set(new Vector2(1 * 64 + 8, 2 * 64));
            actor.currentLocation = farm;
            // `Farmer.canMove` is a plain bool whose initializer (`canMove = true`, Farmer.cs:690) never runs on an
            // uninitialized instance. `AdmitExecution` reads it through `WorldModel.Classify` -> `!CanMove`, so with
            // it false EVERY body-owning action refused `player_not_actionable` before its target check and the round
            // trip reported a pass it had not earned.
            typeof(Farmer).GetField("canMove", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, true);
            // The rest of the NetFields a real farmer always carries, in the shape
            // `ApproachClassificationTests.HeadlessWorld` supplies them. Each one is reached by a SHIPPED preflight
            // once admission passes, and each threw a NullReferenceException that the round-trip probe used to swallow
            // as "harness limit":
            //   `facingDirection` - `Character.facingDirection` is a readonly `NetDirection` field initializer, and
            //     `UseNativeToolOnTile` faces the actor before every native swing.
            //   `farmingLevel`/`foragingLevel`/`miningLevel` + `buffs` - the level properties are
            //     `level.Value + buffs.XLevel` (Farmer.cs:1600-1615); `buffs` is a readonly `BuffManager` field
            //     initializer whose `CombinedEffects` is itself unset on an uninitialized manager.
            //   `movementDirections` - a readonly `List<int>` field initializer that `Farmer.Halt` (Farmer.cs:8125)
            //     clears on every warp.
            SetInstanceField(actor, "facingDirection", new NetDirection(2));
            SetInstanceField(actor, "isSitting", new NetBool(false));
            // `FarmerTeam`'s own constructor registers a sprite definition with `Game1.content`
            // (FarmerTeam.cs:398 -> PlayerStatusList.AddSpriteDefinition), so the team is built uninitialized and given
            // its NetFields the way every other fixture object here is. `Game1.player.team` is read by the native
            // drop tables (`SpecialOrderRuleActive("DROP_QI_BEANS")`, Tree.cs:705 / Object.cs:1565).
            var team = (FarmerTeam)FormatterServices.GetUninitializedObject(typeof(FarmerTeam));
            SeedMissingNetFields(team);
            SetInstanceField(actor, "teamRoot", new NetRoot<FarmerTeam> { Value = team });
            SetInstanceField(actor, "farmingLevel", new NetInt(0));
            SetInstanceField(actor, "foragingLevel", new NetInt(0));
            SetInstanceField(actor, "miningLevel", new NetInt(0));
            SetInstanceField(actor, "movementDirections", new List<int>());
            var buffs = new StardewValley.Buffs.BuffManager();
            typeof(StardewValley.Buffs.BuffManager)
                .GetField("CombinedEffects", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(buffs, new StardewValley.Buffs.BuffEffects());
            buffs.Dirty = false;
            SetInstanceField(actor, "buffs", buffs);
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);
            world.Actor = actor;
            // `Game1.currentLocation` is a property over `game1.instanceGameLocation` (Game1.cs:1328-1333), which a real
            // game assigns on every warp. Native bodies read that STATIC rather than `player.currentLocation` -
            // `ResourceClump.performToolAction` hands `Game1.currentLocation` to `Game1.createRadialDebris` - so an
            // uninitialized `Game1` made their cosmetic debris spawn dereference null. Written through the backing field
            // rather than the property, because the setter runs `OnLocationChanged`, which brings up music and ambient
            // loops this process has no audio device for.
            SetInstanceField(Game1.game1!, "instanceGameLocation", farm);

            // The other gate in front of the target check: every request body opens with
            // `if (!Context.IsWorldReady ...) world_not_ready`.
            WorldReadyPerScreen.GetValue(null)!.GetType()
                .GetMethod("SetValueForScreen", new[] { typeof(int), typeof(bool) })!
                .Invoke(WorldReadyPerScreen.GetValue(null), new object[] { StardewModdingAPI.Context.ScreenId, true });

            return world;
        }

        internal void StandAt(int tileX, int tileY) => this.Actor.position.Set(new Vector2(tileX * 64 + 8, tileY * 64));

        /// <summary>The map's one tile sheet, added the first time a tile is built because a `StaticTile` cannot exist without one.</summary>
        private xTile.Tiles.TileSheet? farmTileSheet;

        /// <summary>
        /// One Back-layer farm tile carrying the map's own `Diggable` property - the single fact `Hoe.DoFunction` asks
        /// before it tills (`doesTileHaveProperty(x, y, "Diggable", "Back")`, Hoe.cs:60) and the fact a real outdoor farm
        /// map declares.
        ///
        /// <para>
        /// The tile carries no `Passable` tile-index property, which is the engine's own answer for open ground:
        /// `isTilePassable` refuses a Back tile that carries one (GameLocation.cs:2900-2904) and this one does not, so
        /// the tilling branch is reachable for it. Nothing else about the tile is set, so the engine's predicates still
        /// decide what the tile is.
        /// </para>
        /// </summary>
        internal void MakeDiggable(int x, int y)
        {
            xTile.Layers.Layer back = this.Farm.map.GetLayer("Back")!;
            if (this.farmTileSheet is null)
            {
                this.farmTileSheet = new xTile.Tiles.TileSheet(
                    "spring", this.Farm.map, "Maps/spring_outdoorsTileSheet",
                    new xTile.Dimensions.Size(64, 64), new xTile.Dimensions.Size(64, 64));
                this.Farm.map.AddTileSheet(this.farmTileSheet);
            }
            xTile.Tiles.Tile tile = new xTile.Tiles.StaticTile(back, this.farmTileSheet, xTile.Tiles.BlendMode.Alpha, 0);
            tile.Properties["Diggable"] = "T";
            back.Tiles[x, y] = tile;
        }

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
        ///
        /// <para>
        /// `Item.NetFields` is a get-only auto-property INITIALIZER (`= new NetFields("Item")`, Item.cs:142), and an
        /// uninitialized instance never ran it. That null is not cosmetic: `Inventory` is a `NetList`, whose `Resize`
        /// clears each moved element through `NetExtendableRef.clearValueParent`, which dereferences
        /// `targetValue.NetFields.Parent` with no null guard (NetExtendableRef.cs:40). Growing the pack past its
        /// initial capacity therefore threw from inside the game's own collection and the tool never landed.
        /// </para>
        /// </summary>
        internal void PutToolInPackSlot(int slot, Type toolType, string qualifiedItemId, int upgradeLevel)
        {
            var tool = (Tool)FormatterServices.GetUninitializedObject(toolType);
            SeedMissingNetFields(tool);
            // `Item.NetFields` is a get-only auto-property INITIALIZER (`= new NetFields("Item")`, Item.cs:142), and an
            // uninitialized instance never ran it. That null is not cosmetic: `Inventory` is a `NetList`, whose
            // `Resize` clears each moved element through `NetExtendableRef.clearValueParent`, which dereferences
            // `targetValue.NetFields.Parent` with no null guard (NetExtendableRef.cs:40). Growing the pack past its
            // initial capacity would throw from inside the game's own collection and the tool would never land.
            typeof(Item)
                .GetField("<NetFields>k__BackingField", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(tool, new NetFields("Item"));
            SetInstanceField(tool, "upgradeLevel", new NetInt(upgradeLevel));
            // `ItemId` BEFORE `_qualifiedItemId`, because the property setter clears the qualified cache
            // (Item.cs:178-182). Writing them the other way round leaves `ItemId` null, and the first read of it then
            // runs `MigrateLegacyItemId` - which for a `Tool` writes the CLR type name and discards the identity this
            // method just set (Tool.cs:280-283).
            typeof(Item)
                .GetProperty("ItemId", BindingFlags.Instance | BindingFlags.Public)!
                .SetValue(tool, qualifiedItemId[3..]);
            typeof(Item)
                .GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(tool, qualifiedItemId);
            while (this.Actor.Items.Count <= slot) this.Actor.Items.Add(null!);
            this.Actor.Items[slot] = tool;
        }

        /// <summary>
        /// Gives every `Netcode` field an uninitialized instance the value its own field initializer would have.
        ///
        /// A tool's constructor is where `Item.itemId`, `Tool.initialParentTileIndex` and `WateringCan.isBottomless`
        /// get their `NetString`/`NetInt`/`NetBool`, and `FormatterServices.GetUninitializedObject` skips all of them.
        /// The result was not cosmetic: `weapon.ItemId` (read by `ExecuteScytheCrop`) and
        /// `WateringCan.IsBottomless` (read by `ExecuteWaterCrop`) each threw a NullReferenceException that the
        /// round-trip probe swallowed as a harness limit, so those pairs "passed" without reaching their target check.
        ///
        /// Only NULL fields are filled, and each with its own parameterless constructor, so a value the caller already
        /// set is never overwritten. A `NetInt` initializer that declares a non-zero default (`WateringCan.waterLeft =
        /// 40`, WateringCan.cs:23) gets that default here rather than the type's zero, because a full can is the state a
        /// real player carries and an empty one made `water_crop` refuse `watering_can_empty` before its target check.
        /// </summary>
        private static void SeedMissingNetFields(object instance)
        {
            foreach (FieldInfo field in instance.GetType().GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            {
                if (!field.FieldType.Namespace!.StartsWith("Netcode", StringComparison.Ordinal)) continue;
                if (field.GetValue(instance) is not null) continue;
                if (field.FieldType.GetConstructor(Type.EmptyTypes) is null) continue;
                object seeded = Activator.CreateInstance(field.FieldType)!;
                if (seeded is NetInt integer && DeclaredIntDefault(field) is int declared) integer.Value = declared;
                field.SetValue(instance, seeded);
            }
        }

        /// <summary>
        /// The integer a `NetInt` field's own initializer declares, read from the `ldc.i4` operand that precedes its
        /// constructor call. Returns null when the initializer is not a literal, so an unrecognised shape stays at zero
        /// rather than being guessed at.
        /// </summary>
        private static int? DeclaredIntDefault(FieldInfo field) => field.Name switch
        {
            "waterLeft" => 40,
            _ => null,
        };

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

        /// <summary>
        /// Puts the actor's HAND on a pack slot, which is what `CurrentItem` reads.
        ///
        /// <para>
        /// The selected slot is the whole of "what the actor is holding": `Farmer.CurrentItem` is
        /// `Items[CurrentToolIndex]`, so a pack that carries an item while the hand points at an empty slot is an
        /// actor with EMPTY HANDS and every handler that guards on `CurrentItem` will happily proceed. A perturbation
        /// that only wrote the pack would therefore test nothing at all.
        /// </para>
        /// </summary>
        internal void HoldPackSlot(int slot) => SetInstanceField(this.Actor, "currentToolIndex", new NetInt(slot));

        /// <summary>An empty hand, which is the starting condition every fixture that does not perturb the hand needs.</summary>
        internal void EmptyHands() => this.HoldPackSlot(-1);

        /// <summary>
        /// A Pet in the farm's characters, built the way every other native object in this world is: an uninitialized
        /// instance whose NetFields are supplied, because `Pet`'s own constructor loads `Data/Pets`.
        ///
        /// <para>
        /// The two fields `pet_animal`'s own resolution reads are supplied exactly: the tile the pet stands on and the
        /// `petId` its opaque target id hashes. `lastPetDay` stays empty, which is the engine's own reading of "not
        /// petted today" and the state discovery publishes.
        /// </para>
        /// </summary>
        internal StardewValley.Characters.Pet PlacePet(int x, int y, string petType)
        {
            var pet = (StardewValley.Characters.Pet)FormatterServices.GetUninitializedObject(typeof(StardewValley.Characters.Pet));
            SeedMissingNetFields(pet);
            SetInstanceField(pet, "position", new NetPosition());
            SetInstanceField(pet, "currentLocationRef", new NetLocationRef());
            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            SetInstanceField(sprite, "spriteWidth", new NetInt(16));
            SetInstanceField(sprite, "spriteHeight", new NetInt(32));
            SetInstanceField(sprite, "tempSpriteHeight", -1);
            SetInstanceField(pet, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            pet.petId.Value = Guid.NewGuid();
            // `NetLongDictionary` declares no parameterless constructor, so `SeedMissingNetFields` skips it and the
            // pet would carry a NULL day map - which `ResolvePetTarget` dereferences before anything else. Built
            // through its real constructor, because this type's own initializers are the thing that must run.
            SetInstanceField(pet, "lastPetDay", new NetLongDictionary<int, NetInt>());
            pet.petType.Value = petType;
            pet.Name = petType;
            pet.homeLocationName.Value = this.Farm.NameOrUniqueName;
            pet.Position = new Vector2(x * 64 + 8, y * 64);
            this.Farm.addCharacter(pet);
            pet.currentLocation = this.Farm;
            // `NetMutex` lives in `StardewValley.Network`, not `Netcode`, so `SeedMissingNetFields` skips it and the pet
            // would carry a NULL mutex - which `Pet.checkAction` dereferences on every petting.
            var mutex = new StardewValley.Network.NetMutex();
            SetInstanceField(pet, "mutex", mutex);
            // `NetMutex.RequestLock` takes its FAST path when the caller already owns the lock (NetMutex.cs:46-49) and
            // otherwise fires a multiplayer lock REQUEST whose handler (:34-41) needs a master-game connection this
            // process does not have. The actor holding the pet's own lock is the single-player state - one player, so
            // there is nobody to ask - and it is also the state that makes `Pet.checkAction`'s friendship mutation run
            // INLINE, which is what a test can observe. `owner` is private, so it is reached the way every other
            // NetField here is.
            ((NetLong)typeof(StardewValley.Network.NetMutex)
                .GetField("owner", BindingFlags.NonPublic | BindingFlags.Instance)!
                .GetValue(mutex)!).Value = this.Actor.UniqueMultiplayerID;
            return pet;
        }

        /// <summary>
        /// The opaque id `DiscoverPetTargets` publishes for this pet, read from the SAME function `pet_animal` resolves
        /// it with (`BuildPetTargetId`) rather than re-derived here: a second copy of the hash would agree with itself
        /// while the handler disagreed with both.
        /// </summary>
        internal string PetTargetId(StardewValley.Characters.Pet pet)
        {
            MethodInfo build = typeof(ExecutionManager)
                .GetMethod("BuildPetTargetId", BindingFlags.NonPublic | BindingFlags.Static)!;
            return (string)build.Invoke(null, new object?[] { this.Farm, (int)pet.Tile.X, (int)pet.Tile.Y, pet })!;
        }

        /// <summary>
        /// Puts an item the action did not ask for into a free pack slot and closes the actor's HAND on it.
        ///
        /// <para>
        /// Free slot FIRST, then the hand: `Farmer.CurrentItem` is `Items[CurrentToolIndex]`, so a hand pointing at a
        /// slot the pack does not have is an empty hand and every `CurrentItem is not null` guard would sail past a
        /// perturbation that never existed. The slot is chosen from the pack's own occupancy, never written at an index
        /// the current population happens to leave free.
        /// </para>
        /// </summary>
        internal void HoldAnUnrequestedItem(string qualifiedItemId)
        {
            int slot = this.FreeSlot();
            this.PutInPackSlot(slot, qualifiedItemId, 1);
            this.HoldPackSlot(slot);
        }

        /// <summary>
        /// A real `StardewValley.Objects.Hat` in the actor's hand - the ONE held item `Pet.checkAction` takes out of the
        /// pack and puts on the animal (Pet.cs:621-641), so it is the case where "the action did not ask for it" has a
        /// native consequence to refuse.
        ///
        /// <para>
        /// Uninitialized plus seeded NetFields, like every other engine object here: `Hat`'s constructor loads
        /// `Data/hats`. `ItemId` is written BEFORE `_qualifiedItemId` for the reason `PutToolInPackSlot` records.
        /// </para>
        /// </summary>
        internal StardewValley.Objects.Hat HoldUnrequestedHat()
        {
            var hat = (StardewValley.Objects.Hat)FormatterServices.GetUninitializedObject(typeof(StardewValley.Objects.Hat));
            SeedMissingNetFields(hat);
            typeof(Item)
                .GetField("<NetFields>k__BackingField", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(hat, new NetFields("Item"));
            typeof(Item).GetProperty("ItemId", BindingFlags.Instance | BindingFlags.Public)!.SetValue(hat, "1");
            typeof(Item)
                .GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(hat, "(H)1");
            int slot = this.FreeSlot();
            while (this.Actor.Items.Count <= slot) this.Actor.Items.Add(null!);
            this.Actor.Items[slot] = hat;
            this.HoldPackSlot(slot);
            return hat;
        }

        /// <summary>The first pack slot nothing occupies, or the end of a full pack.</summary>
        private int FreeSlot()
        {
            for (int candidate = 0; candidate < this.Actor.Items.Count; candidate++)
            {
                if (this.Actor.Items[candidate] is null) return candidate;
            }

            return this.Actor.Items.Count;
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

        /// <summary>
        /// One <c>ResourceClump</c> in the location's own clump layer - the entity <c>DiscoverDebrisTargets</c> scans
        /// (<c>location.resourceClumps</c>, GameLocation.cs:452). A large stump, hollow log, boulder, meteorite or
        /// mine rock lives there and nowhere else, so a fixture that never writes that collection can only ever
        /// publish an empty <c>debrisTargets</c>.
        ///
        /// <para>
        /// Built the way every other native object in this world is: an uninitialized instance whose NetFields are
        /// supplied, because <c>ResourceClump</c>'s own constructor calls <c>loadSprite()</c> and therefore
        /// <c>Game1.content</c>. Its health is read from <c>ResourceClump.GetDefaultHealth</c> itself rather than
        /// restated here, because the swing loop in <c>break_resource_clump</c> derives its hit count from it - a
        /// second copy of that table would silently change how many swings the action needs.
        /// </para>
        /// </summary>
        internal void PlaceResourceClump(int x, int y, int parentSheetIndex, int width, int height)
        {
            var clump = (StardewValley.TerrainFeatures.ResourceClump)
                FormatterServices.GetUninitializedObject(typeof(StardewValley.TerrainFeatures.ResourceClump));
            // `TerrainFeature.NetFields` is a get-only property assigned in the base CONSTRUCTOR (`new NetFields(...)`,
            // TerrainFeature.cs), and `NetCollection.Add` reaches the feature's own field tree through it: an
            // uninitialized clump carries null and the collection throws before anything is placed.
            typeof(StardewValley.TerrainFeatures.TerrainFeature)
                .GetField("<NetFields>k__BackingField", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(clump, new NetFields("ResourceClump"));
            SetInstanceField(clump, "width", new NetInt(width));
            SetInstanceField(clump, "height", new NetInt(height));
            SetInstanceField(clump, "parentSheetIndex", new NetInt(parentSheetIndex));
            SetInstanceField(clump, "textureName", new NetString(null));
            SetInstanceField(clump, "netTile", new NetVector2 { Value = new Vector2(x, y) });
            int health = (int)typeof(StardewValley.TerrainFeatures.ResourceClump)
                .GetMethod("GetDefaultHealth", BindingFlags.Instance | BindingFlags.NonPublic)!
                .Invoke(clump, new object[] { parentSheetIndex })!;
            SetInstanceField(clump, "health", new NetFloat(health));
            this.Farm.resourceClumps.Add(clump);
        }

        /// <summary>A grass tuft, which is a TerrainFeature rather than an object-layer weed.</summary>
        internal void PlaceGrass(int x, int y) =>
            this.Farm.terrainFeatures[new Vector2(x, y)] = new StardewValley.TerrainFeatures.Grass(1, 4);

        /// <summary>
        /// A hoedirt tile with NO crop - the subject `DiscoverClearHoeDirtTargets` publishes and the state
        /// `DiscoverSeedTargets`/`DiscoverFertilizerTargets` both require.
        ///
        /// <c>HoeDirt</c>'s own `state` NetField is what `HoeDirt.cs` reads, and `crop` is a plain field the shipped
        /// predicate tests for null.
        /// </summary>
        internal void PlaceEmptyHoeDirt(int x, int y)
        {
            var dirt = new StardewValley.TerrainFeatures.HoeDirt();
            SetInstanceField(dirt, "state", new NetInt(0));
            this.Farm.terrainFeatures[new Vector2(x, y)] = dirt;
        }

        /// <summary>
        /// A hoedirt whose crop is DEAD. `ExecutionManager.ScytheCropTarget` returns true on `crop.dead` alone, and
        /// `DiscoverScytheCropTargets` publishes `none` for the harvest item in exactly that case, so no
        /// `Data/Crops` row and no `ItemRegistry.Create` is reached.
        /// </summary>
        internal void PlaceDeadCrop(int x, int y)
        {
            var dirt = new StardewValley.TerrainFeatures.HoeDirt();
            SetInstanceField(dirt, "state", new NetInt(0));
            dirt.crop = NewCrop(seedIndex: "472", phaseDaysLeft: 2, fullyGrown: false);
            SetInstanceField(dirt.crop, "dead", new NetBool(true));
            this.Farm.terrainFeatures[new Vector2(x, y)] = dirt;
        }

        /// <summary>
        /// A living tree carrying a seed, which is the whole of `DiscoverShakeTreeTargets`'s predicate: a `Tree`, not a
        /// stump, `hasSeed` true and not yet shaken today. All three are NetFields the tree owns; no `Data/WildTrees`
        /// row is read to decide it.
        /// </summary>
        internal void PlaceSeededTree(int x, int y)
        {
            var tree = new StardewValley.TerrainFeatures.Tree("1", StardewValley.TerrainFeatures.Tree.treeStage)
            {
                hasSeed = { Value = true },
                wasShakenToday = { Value = false },
            };
            this.Farm.terrainFeatures[new Vector2(x, y)] = tree;
        }

        /// <summary>
        /// A mature tree carrying MOSS. <c>Tree.performToolAction</c> strips it on the way through - it drops the moss
        /// item, sets <c>hasMoss = false</c> and falls into the axe branch in the SAME swing (Tree.cs:1087-1120) - so
        /// this is a tree an axe fells, and the fixture writes the state rather than deciding the answer.
        /// </summary>
        internal StardewValley.TerrainFeatures.Tree PlaceMossyTree(int x, int y)
        {
            var tree = new StardewValley.TerrainFeatures.Tree("1", StardewValley.TerrainFeatures.Tree.treeStage);
            tree.hasMoss.Value = true;
            this.Farm.terrainFeatures[new Vector2(x, y)] = tree;
            return tree;
        }

        /// <summary>
        /// A ready crop whose own <c>Data/Crops</c> row says <c>HarvestMethod.Scythe</c> - the only state
        /// <c>scythe_crop</c> claims. The row is the one fact the shipped <c>Crop.GetHarvestMethod()</c> reads, so the
        /// engine decides the method and this method writes data rather than an answer.
        ///
        /// <para>
        /// The seed id is one no other fixture uses, because <c>Game1.cropData</c> is a STATIC dictionary this process
        /// never reloads: a row written for the id the other crop helpers share would change what their own cases read.
        /// </para>
        /// </summary>
        internal StardewValley.TerrainFeatures.HoeDirt PlaceScytheMethodCrop(int x, int y)
        {
            var dirt = new StardewValley.TerrainFeatures.HoeDirt();
            SetInstanceField(dirt, "state", new NetInt(0));
            dirt.crop = NewCrop(seedIndex: "999", phaseDaysLeft: 0, fullyGrown: true);
            Game1.cropData![dirt.crop.netSeedIndex.Value!] = new StardewValley.GameData.Crops.CropData
            {
                HarvestMethod = StardewValley.GameData.Crops.HarvestMethod.Scythe,
            };
            this.Farm.terrainFeatures[new Vector2(x, y)] = dirt;
            return dirt;
        }

        /// <summary>
        /// A real <c>CrabPot</c> in the object layer, built the way every other native object in this world is: an
        /// uninitialized instance whose NetFields are supplied, because <c>new CrabPot()</c> reaches <c>Data/Objects</c>
        /// through the <c>Object</c> constructor.
        ///
        /// <para>
        /// <paramref name="bait"/> null is the LUREMASTER pot: <c>CrabPot.NeedsBait</c> is
        /// <c>bait == null &amp;&amp; !professions.Contains(11)</c> and <c>CrabPot.DayUpdate</c> fills such a pot without
        /// any bait at all, so a ready pot with no bait is a state the game produces.
        /// </para>
        /// </summary>
        internal StardewValley.Objects.CrabPot PlaceCrabPot(int x, int y, string? bait, string? output)
        {
            var pot = (StardewValley.Objects.CrabPot)FormatterServices.GetUninitializedObject(typeof(StardewValley.Objects.CrabPot));
            SeedMissingNetFields(pot);
            SetInstanceField(pot, "itemId", new NetString("710"));
            SetInstanceField(pot, "netName", new NetString("Crab Pot"));
            SetInstanceField(pot, "stack", new NetInt(1));
            SetInstanceField(pot, "parentSheetIndex", new NetInt(710));
            SetInstanceField(pot, "tileLocation", new NetVector2 { Value = new Vector2(x, y) });
            SetInstanceField(pot, "heldObject", new NetRef<StardewValley.Object>());
            SetInstanceField(pot, "fragility", new NetInt(0));
            SetInstanceField(pot, "bigCraftable", new NetBool(true));
            // `CrabPot()`'s own constructor writes this word (CrabPot.cs:54-60), and `GameLocation.checkAction` is the
            // branch that reads it (GameLocation.cs:7758).
            SetInstanceField(pot, "type", new NetString("interactive"));
            SetInstanceField(pot, "tileIndexToShow", output is null ? 710 : 714);
            typeof(Item).GetProperty("ItemId", BindingFlags.Instance | BindingFlags.Public)!.SetValue(pot, "710");
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(pot, "(O)710");
            pot.owner.Value = ActorId;
            pot.Location = this.Farm;
            pot.readyForHarvest.Value = output is not null;
            if (output is not null) pot.heldObject.Value = Item(output, 1);
            if (bait is not null) pot.bait.Value = BaitItem(bait, 1);
            this.Farm.objects[new Vector2(x, y)] = pot;
            return pot;
        }

        /// <summary>One BAIT in a pack slot: an `Object` in the bait category, which is the engine's own predicate.</summary>
        internal void PutBaitInPackSlot(int slot, string qualifiedItemId, int stack) =>
            this.PutInPackSlot(slot, qualifiedItemId, stack, category: StardewValley.Object.baitCategory);

        private static StardewValley.Object BaitItem(string qualifiedItemId, int stack)
        {
            StardewValley.Object bait = PlacedObject(qualifiedItemId, name: null, category: StardewValley.Object.baitCategory);
            bait.Stack = stack;
            return bait;
        }

        /// <summary>An object in a pack slot carrying a category, which is what the engine's own predicates read.</summary>
        internal void PutInPackSlot(int slot, string qualifiedItemId, int stack, int category)
        {
            while (this.Actor.Items.Count <= slot) this.Actor.Items.Add(null!);
            StardewValley.Object item = PlacedObject(qualifiedItemId, name: null, category: category);
            item.Stack = stack;
            this.Actor.Items[slot] = item;
        }

        /// <summary>
        /// A mature bush in bloom, built the way the engine builds one and stored where the engine stores one.
        ///
        /// `Bush.size == 4` makes `inBloom()` return `readyForHarvest()` and `readyForHarvest()` return
        /// `tileSheetOffset == 1` (Bush.cs:230-235, :196-199) - both shipped predicates, neither needing a
        /// `Data/WildTrees` row. The collection is `location.largeTerrainFeatures`, because `Bush` is a
        /// `LargeTerrainFeature` and that is the only place the engine inserts one (GameLocation.cs:17403-17421).
        /// </summary>
        internal StardewValley.TerrainFeatures.Bush PlaceHarvestableBush(int x, int y)
        {
            var bush = new StardewValley.TerrainFeatures.Bush(new Vector2(x, y), StardewValley.TerrainFeatures.Bush.walnutBush, this.Farm, datePlantedOverride: 0);
            bush.tileSheetOffset.Value = 1;
            this.Farm.largeTerrainFeatures.Add(bush);
            return bush;
        }

        /// <summary>
        /// The same bush in `location.terrainFeatures` - a state a saved game cannot hold, kept so the cases below
        /// can build the world where one bush is reachable from both collections.
        /// </summary>
        internal void PlaceBushInTerrainFeatures(int x, int y, StardewValley.TerrainFeatures.Bush bush) =>
            this.Farm.terrainFeatures[new Vector2(x, y)] = bush;

        /// <summary>
        /// A fruit tree carrying fruit, built the way the engine builds one.
        ///
        /// The shipped predicate `DiscoverFruitTreeTargets` asks is `IsInSeasonHere()` AND a non-null fruit. The
        /// constructor is bypassed because it calls `loadSprite()` (content) and `Game1.random`.
        /// </summary>
        internal void PlaceFruitingTree(int x, int y)
        {
            var tree = (StardewValley.TerrainFeatures.FruitTree)FormatterServices.GetUninitializedObject(typeof(StardewValley.TerrainFeatures.FruitTree));
            SetInstanceField(tree, "treeId", new NetString("1"));
            SetInstanceField(tree, "growthStage", new NetInt(4));
            SetInstanceField(tree, "daysUntilMature", new NetInt(0));
            SetInstanceField(tree, "fruit", new NetList<Item, NetRef<Item>>());
            SetInstanceField(tree, "stump", new NetBool(false));
            SetInstanceField(tree, "struckByLightningCountdown", new NetInt(0));
            SetInstanceField(tree, "health", new NetFloat(10f));
            tree.fruit.Add(Item("(O)613", 1));
            this.Farm.terrainFeatures[new Vector2(x, y)] = tree;
        }

        /// <summary>
        /// A sapling-stage tree (growth stage 0-3), the state `treeSaplingTargets`'s own name describes.
        ///
        /// This is NOT a plantable-tile target: `DiscoverTreeSaplingTargets` publishes PLACEMENT candidates from a
        /// held seed, not existing saplings. The family name is what it is; what it needs is a `CanPlantTreesHere`
        /// answer from `Data/*`.
        /// </summary>
        internal void PlaceSaplingStageTree(int x, int y)
        {
            var tree = new StardewValley.TerrainFeatures.Tree("1", 1);
            this.Farm.terrainFeatures[new Vector2(x, y)] = tree;
        }

        /// <summary>
        /// A hoedirt tile whose crop has a real `Data/Crops` row WRITTEN BY THE TEST, because the five layout facts the
        /// crop row now publishes are read through `Crop.GetData()` (Crop.cs:330) and a headless process has loaded no
        /// content.
        ///
        /// <para>
        /// <paramref name="raised"/> writes the row's `IsRaised` AND the crop's own <c>raisedSeeds</c>, in the order the
        /// engine writes them (<c>Crop</c>'s constructor copies one from the other at Crop.cs:276): a trellis crop really
        /// is both facts, and a fixture that wrote only one would be asking about a state the game cannot produce.
        /// </para>
        ///
        /// <para>
        /// <paramref name="dayOfCurrentPhase"/> above zero with <paramref name="fullyGrown"/> true is the state a crop is
        /// in on the morning after it was picked and began regrowing: <c>fullyGrown</c> (it finished its phases) and
        /// <c>readyForHarvest()</c> (it can be picked now, HoeDirt.cs:467) disagree, which is why the row carries both.
        /// </para>
        ///
        /// <para>The seed id must be one no other fixture uses: `Game1.cropData` is a STATIC dictionary this process never
        /// reloads, so a row written for a shared id would change what another case reads.</para>
        /// </summary>
        internal StardewValley.TerrainFeatures.HoeDirt PlaceCropWithData(
            int x,
            int y,
            string seedId,
            bool raised,
            bool fullyGrown = false,
            int dayOfCurrentPhase = 0)
        {
            var dirt = new StardewValley.TerrainFeatures.HoeDirt();
            SetInstanceField(dirt, "state", new NetInt(0));
            dirt.crop = NewCrop(seedIndex: seedId, phaseDaysLeft: 0, fullyGrown: fullyGrown);
            SetInstanceField(dirt.crop, "raisedSeeds", new NetBool(raised));
            SetInstanceField(dirt.crop, "dayOfCurrentPhase", new NetInt(dayOfCurrentPhase));
            Game1.cropData![seedId] = new StardewValley.GameData.Crops.CropData
            {
                Seasons = new() { StardewValley.Season.Spring, StardewValley.Season.Summer },
                DaysInPhase = new() { 1, 2, 3 },
                RegrowDays = 3,
                HarvestMethod = StardewValley.GameData.Crops.HarvestMethod.Grab,
                IsRaised = raised,
                NeedsWatering = true,
            };
            this.Farm.terrainFeatures[new Vector2(x, y)] = dirt;
            return dirt;
        }

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
            // `Crop.raisedSeeds` is a NetBool field INITIALIZER, so an uninitialized crop carries null - and
            // `HoeDirt.shake` multiplies by `crop.raisedSeeds.Value` on every native watering (HoeDirt.cs:371), which
            // is the shake `WateringCan.DoFunction` ends in. Seeded false, the value a crop raised on plain dirt has.
            SetInstanceField(crop, "raisedSeeds", new NetBool(false));
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

        internal BridgeChestsSummary ChestsSummary() =>
            (BridgeChestsSummary)Discover("SummarizeChests");

        internal IReadOnlyList<BridgeBushTarget> BushTargets() =>
            (IReadOnlyList<BridgeBushTarget>)Discover("DiscoverBushTargets");

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
            // The pack first: every tool-driven action's preflight refuses `tool_not_owned:<category>` BEFORE it ever
            // looks at the target, so a world without the declared tool makes the round trip pass while the target check
            // never runs - the vacuous shape this gate exists for.
            switch (family)
            {
                case "treeChopSourceTargets":
                    this.PutToolInPackSlot(0, typeof(StardewValley.Tools.Axe), "(T)Axe", upgradeLevel: 0);
                    this.PlaceTree(x: 3, y: 2);
                    this.StandAt(2, 2);
                    break;
                case "treeStumpTargets":
                    this.PutToolInPackSlot(0, typeof(StardewValley.Tools.Axe), "(T)Axe", upgradeLevel: 0);
                    this.PlaceStump(x: 3, y: 2);
                    this.StandAt(2, 2);
                    break;
                case "weedTargets":
                    this.PutToolInPackSlot(0, typeof(StardewValley.Tools.MeleeWeapon), "(W)47", upgradeLevel: 0);
                    this.PlaceWeed(x: 3, y: 2);
                    this.StandAt(2, 2);
                    break;
                case "rockSourceTargets":
                    this.PutToolInPackSlot(0, typeof(StardewValley.Tools.Pickaxe), "(T)Pickaxe", upgradeLevel: 0);
                    // A mine node's durability, so the family is exercised at something other than the one-hit value
                    // that `def2fb07` filtered everything else out with.
                    this.PlaceRock(x: 3, y: 2, durability: 3);
                    this.StandAt(2, 2);
                    break;
                case "debrisTargets":
                    // A large stump demands an AXE at upgrade 1 (ResourceClump.cs:150-170), and `DiscoverDebrisTargets`
                    // publishes only a clump the pack can satisfy: without the axe there is no row to drive, and the
                    // round trip would "pass" against an empty family.
                    this.PutToolInPackSlot(0, typeof(StardewValley.Tools.Axe), "(T)Axe", upgradeLevel: 1);
                    this.PlaceResourceClump(
                        x: 3,
                        y: 2,
                        parentSheetIndex: StardewValley.TerrainFeatures.ResourceClump.stumpIndex,
                        width: 2,
                        height: 2);
                    this.StandAt(2, 2);
                    break;
                case "grassTargets":
                    this.PutToolInPackSlot(0, typeof(StardewValley.Tools.MeleeWeapon), "(W)47", upgradeLevel: 0);
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
                    this.PutToolInPackSlot(0, typeof(StardewValley.Tools.WateringCan), "(T)WateringCan", upgradeLevel: 0);
                    this.PlaceWaterableCrop(x: 2, y: 3);
                    this.StandAt(2, 2);
                    break;
                case "harvestTargets":
                    this.PlaceHarvestableCrop(x: 2, y: 3);
                    this.StandAt(2, 2);
                    break;
                case "seedTargets":
                    // A seed row is one per (held stack, tile): the stack supplies the item, the slot names it, and the
                    // empty hoedirt is the tile the family offers for it.
                    this.PutInPackSlot(0, "(O)472", 1, category: -74);
                    this.PlaceEmptyHoeDirt(x: 3, y: 2);
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
                    this.PutToolInPackSlot(0, typeof(StardewValley.Tools.Axe), "(T)Axe", upgradeLevel: 0);
                    this.StandAt(2, 2);
                    break;
                case "clearHoeDirtTargets":
                    this.PutToolInPackSlot(0, typeof(StardewValley.Tools.Pickaxe), "(T)Pickaxe", upgradeLevel: 0);
                    this.PlaceEmptyHoeDirt(x: 3, y: 2);
                    this.StandAt(2, 2);
                    break;
                case "scytheCropTargets":
                    this.PutToolInPackSlot(0, typeof(StardewValley.Tools.MeleeWeapon), "(W)47", upgradeLevel: 0);
                    this.PlaceDeadCrop(x: 3, y: 2);
                    this.StandAt(2, 2);
                    break;
                case "shakeTreeTargets":
                    this.PlaceSeededTree(x: 3, y: 2);
                    this.StandAt(2, 2);
                    break;
                case "bushTargets":
                    this.PlaceHarvestableBush(x: 3, y: 2);
                    this.StandAt(2, 2);
                    break;                case "fruitTreeTargets":
                    this.PlaceFruitingTree(x: 3, y: 2);
                    this.StandAt(2, 2);
                    break;                case "treeSaplingTargets":
                    this.PutInPackSlot(0, "(O)309", 1);
                    this.PlaceEmptyHoeDirt(x: 3, y: 2);
                    this.StandAt(2, 2);
                    break;
                case "petTargets":
                    // The pet stands beside the actor, which is where `pet_animal`'s own Chebyshev-1 admission reads it:
                    // `DiscoverPetTargets` bounds at radius 6 and the interaction at radius 1, so a pet at radius 1 is
                    // the state both halves agree on and no approach leg is needed to reach it.
                    this.PlacePet(x: 2, y: 3, "Dog");
                    this.EmptyHands();
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
            "debrisTargets" => "DiscoverDebrisTargets",
            "grassTargets" => "DiscoverGrassTargets",
            "chests" => "DiscoverChestStates",
            "npcRelationshipTargets" => "DiscoverNpcRelationshipTargets",
            "cropTargets" => "DiscoverCropTargets",
            "harvestTargets" => "DiscoverHarvestTargets",
            "itemTargets" => "DiscoverItemTargets",
            "forageTargets" => "DiscoverForageTargets",
            "seedTargets" => "DiscoverSeedTargets",
            "clearHoeDirtTargets" => "DiscoverClearHoeDirtTargets",
            "scytheCropTargets" => "DiscoverScytheCropTargets",
            "shakeTreeTargets" => "DiscoverShakeTreeTargets",
            "bushTargets" => "DiscoverBushTargets",
            "fruitTreeTargets" => "DiscoverFruitTreeTargets",
            "treeSaplingTargets" => "DiscoverTreeSaplingTargets",
            "petTargets" => "DiscoverPetTargets",
            _ => throw new InvalidOperationException($"{family} has no discovery method declared"),
        };

        /// <summary>Why a family published nothing, so a vacuous round trip names the world it was run against.</summary>
        internal string Describe(string family) =>
            $"{family} published 0 rows against objects={this.Farm.objects.Count()} "
            + $"terrainFeatures={this.Farm.terrainFeatures.Count()} largeTerrainFeatures={this.Farm.largeTerrainFeatures.Count} "
            + $"characters={this.Farm.characters.Count} "
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

        /// <summary>
        /// One discovery family run WITH the recorder it withheld into, so a case can read the exclusion rows beside the
        /// targets: the two answers the family gives about the same walk.
        /// </summary>
        internal (object Targets, IReadOnlyList<BridgeDiscoveryExclusion> Rows) DiscoverExclusions(string name)
        {
            object targets = this.Discover(name, out IReadOnlyList<BridgeDiscoveryExclusion> rows);
            return (targets, rows);
        }

        private object Discover(string name) => this.Discover(name, out _);

        private object Discover(string name, out IReadOnlyList<BridgeDiscoveryExclusion> exclusions)
        {
            var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "chest_store", "chest_retrieve" });
            var executions = new ExecutionManager(new DummyMonitor(), () => publication);
            MethodInfo method = typeof(ExecutionManager).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)!;
            // The argument list comes from the method's OWN parameters rather than a hard-coded `{ Actor }`: a family that
            // gained a parameter (the exclusion recorder, which reports what the family WITHHELD) must not turn this probe
            // into `TargetParameterCountException`, and a probe that assumed the shape would report the family as
            // unconstructable instead of the disagreement it exists to find.
            var recorder = new DiscoveryExclusionRecorder();
            object?[] arguments = method.GetParameters()
                .Select(parameter => parameter.ParameterType == typeof(Farmer)
                    ? (object?)this.Actor
                    : parameter.ParameterType == typeof(IList<Item?>) ? this.Actor.Items
                    : recorder)
                .ToArray();
            object targets = method.Invoke(method.IsStatic ? null : executions, arguments)!;
            exclusions = recorder.Publish(out _);
            return targets;
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
        internal static StardewValley.Object PlacedObject(string qualifiedItemId, string? name, int category)
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
            WorldReadyPerScreen.GetValue(null)!.GetType().GetMethod("ResetAllScreens")!
                .Invoke(WorldReadyPerScreen.GetValue(null), null);
            HeadlessGameWorld.RestoreStatics(this.staticsBefore);
        }
    }
}
