using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `plant_sapling` walked in instead of refusing: every case below drives the product's own entry point
/// and reads the receipt, the armed approach and the world that is left behind. Nothing here searches a
/// source file.
///
/// <para>
/// The defect: its four siblings in the same partial (<c>water_crop</c>, <c>plant_seed</c>,
/// <c>fertilize_tile</c>, <c>scythe_crop</c>) were migrated to walk-in in 36cba658 - outside the native
/// Chebyshev-1 radius they begin an approach and one execution body runs on arrival. <c>plant_sapling</c>
/// kept a bare <c>target_out_of_range</c> refusal, so a companion three tiles from an open, plantable
/// tile was told the tile was unavailable and had nothing to learn from the answer. A sapling tile does
/// not move, so that refusal was a dead end rather than a race it could win by re-observing.
/// </para>
///
/// <para>
/// The fixture is a headless farm: a 16x16 map with the two layers the engine reads, a probe farmer, and
/// the one native static the wild-tree branch consults (<c>Tree._WildTreeSeedLookup</c>, the cache of
/// <c>Data/WildTrees</c> that a process without a content manager cannot load by itself). The seeding is
/// the minimum that makes the real predicates answer, never a replacement for them.
/// </para>
/// </summary>
public sealed class SaplingApproachWiringTests
{
    /// <summary>The actor stands here: three tiles west of the target, outside the Chebyshev-1 radius.</summary>
    private const int ActorTileX = 2;
    private const int ActorTileY = 3;

    /// <summary>An open, plantable tile three tiles away.</summary>
    private const int TargetTileX = 5;
    private const int TargetTileY = 3;

    private const int Slot = 0;

    /// <summary>
    /// Two saplings, not one. Consuming the LAST one drops the farmer through `removeItemFromInventory` into
    /// `showNotCarrying`, which repaints the sprite through a content-loaded frame table a headless process has
    /// none of - a fixture concern, not an action one. Two also makes the postcondition stricter: 2 -> 1 catches
    /// both "planted nothing" and "planted twice", where 1 -> 0 would satisfy only the first.
    /// </summary>
    private const int SaplingsInSlot = 2;

    /// <summary>Acorn: the wild-tree seed every fixture in this project uses.</summary>
    private const string SaplingQualifiedItemId = "(O)309";

    // ---- the refusal became a walk -------------------------------------------

    [Fact]
    public void PlantingFromThreeTilesAway_BeginsAnApproach_InsteadOfRefusing()
    {
        using var harness = SaplingHarness.Create();
        harness.StandAt(ActorTileX, ActorTileY);
        ExecutionManager manager = harness.CreateManager();
        string targetId = harness.TargetId();

        LocalExecutionReceipt receipt = manager.RequestLocalPlantSapling(
            "req_sapling_far", Slot, TargetTileX, TargetTileY, SaplingQualifiedItemId, targetId, harness.DeadlineMs);

        // The whole point of the migration, said as the two facts a caller acts on.
        receipt.ReasonCode.Should().NotBe(
            "target_out_of_range",
            "a tile the actor can walk to is not a tile the actor cannot have");
        receipt.State.Should().Be(ExecutionState.Accepted);
        receipt.ReasonCode.Should().Be("accepted");

        // The walk it armed, named by where it is going and which action owns it - so a snapshot during
        // the walk publishes an operation the caller recognises instead of an internal phase.
        LocalApproachSpec? approach = harness.ArmedApproach(manager);
        approach.Should().NotBeNull("the request path hands the geometry to the shared approach leg");
        approach!.ActionId.Should().Be("plant_sapling");
        approach.TargetX.Should().Be(TargetTileX);
        approach.TargetY.Should().Be(TargetTileY);
        approach.ExpectedTargetId.Should().Be(targetId);

        // Nothing was planted by asking: the sapling is still in the slot and the tile is still open.
        harness.SaplingCount().Should().Be(SaplingsInSlot, "a walk plants nothing");
        harness.HasTreeAt(TargetTileX, TargetTileY).Should().BeFalse("the tile is still open ground");
    }

    // ---- the arrival re-validates the world the walk took ticks to cross -----

    [Fact]
    public void TheArrival_SucceedsOnAnUnchangedWorld_AndPlantsExactlyOneSapling()
    {
        // The positive control for every refusal below: same fixture, same request, same arrival - only the
        // world differs. Without it a green refusal case could just be a body that always refuses.
        using var harness = SaplingHarness.Create();
        harness.StandAt(ActorTileX, ActorTileY);
        ExecutionManager manager = harness.CreateManager();
        string targetId = harness.TargetId();

        manager.RequestLocalPlantSapling("req_sapling_ok", Slot, TargetTileX, TargetTileY, SaplingQualifiedItemId, targetId, harness.DeadlineMs);
        harness.StandAt(TargetTileX - 1, TargetTileY);

        LocalExecutionReceipt arrival = harness.RunArrival(manager, "req_sapling_ok");

        arrival.State.Should().Be(ExecutionState.Succeeded, harness.Describe(arrival, manager));
        arrival.ReasonCode.Should().Be("sapling_planted");
        arrival.Evidence.Should().Contain($"target={targetId}");
        harness.SaplingCount().Should().Be(SaplingsInSlot - 1, "the native placement consumes exactly one sapling");
    }

    [Fact]
    public void ASaplingThatLeftTheSlotDuringTheWalk_IsRefusedOnArrival_AndNothingIsPlanted()
    {
        using var harness = SaplingHarness.Create();
        harness.StandAt(ActorTileX, ActorTileY);
        ExecutionManager manager = harness.CreateManager();
        string targetId = harness.TargetId();

        manager.RequestLocalPlantSapling("req_sapling_gone", Slot, TargetTileX, TargetTileY, SaplingQualifiedItemId, targetId, harness.DeadlineMs);

        // The companion spent the sapling on something else mid-walk, or the inventory moved under it.
        harness.EmptySlot();
        harness.StandAt(TargetTileX - 1, TargetTileY);

        LocalExecutionReceipt arrival = harness.RunArrival(manager, "req_sapling_gone");

        arrival.State.Should().Be(ExecutionState.Rejected);
        arrival.ReasonCode.Should().Be("sapling_not_owned_in_slot");
        harness.HasTreeAt(TargetTileX, TargetTileY).Should().BeFalse("the native placement was never reached");
    }

    [Fact]
    public void ADifferentItemInTheSlotDuringTheWalk_IsRefusedOnArrival()
    {
        using var harness = SaplingHarness.Create();
        harness.StandAt(ActorTileX, ActorTileY);
        ExecutionManager manager = harness.CreateManager();
        string targetId = harness.TargetId();

        manager.RequestLocalPlantSapling("req_sapling_swapped", Slot, TargetTileX, TargetTileY, SaplingQualifiedItemId, targetId, harness.DeadlineMs);

        // A different wild-tree seed is still a wild-tree seed, so only the identity check can catch it.
        harness.PutInSlot(SaplingHarness.WildTreeSeed("(O)310", stack: 1));
        harness.StandAt(TargetTileX - 1, TargetTileY);

        LocalExecutionReceipt arrival = harness.RunArrival(manager, "req_sapling_swapped");

        arrival.State.Should().Be(ExecutionState.Rejected);
        arrival.ReasonCode.Should().Be("sapling_slot_changed");
        harness.HasTreeAt(TargetTileX, TargetTileY).Should().BeFalse();
    }

    [Fact]
    public void ATileTakenDuringTheWalk_IsRefusedOnArrival_AndTheSapingIsKept()
    {
        using var harness = SaplingHarness.Create();
        harness.StandAt(ActorTileX, ActorTileY);
        ExecutionManager manager = harness.CreateManager();
        string targetId = harness.TargetId();

        manager.RequestLocalPlantSapling("req_sapling_taken", Slot, TargetTileX, TargetTileY, SaplingQualifiedItemId, targetId, harness.DeadlineMs);

        // Somebody put something on the tile while the actor walked.
        harness.OccupyTile(TargetTileX, TargetTileY);
        harness.StandAt(TargetTileX - 1, TargetTileY);

        LocalExecutionReceipt arrival = harness.RunArrival(manager, "req_sapling_taken");

        arrival.State.Should().Be(ExecutionState.Rejected);
        arrival.ReasonCode.Should().Be("sapling_target_unavailable");
        harness.SaplingCount().Should().Be(SaplingsInSlot, "a refused placement does not consume the seed");
        harness.HasTreeAt(TargetTileX, TargetTileY).Should().BeFalse();
    }

    [Fact]
    public void AWalkThatStoppedShort_IsRefusedByReach_AndTheWorldIsUnchanged()
    {
        // The arrival leg measures reach before it calls the action body, and the body measures it again.
        // Running the armed arrival closure directly is the one way to ask the BODY that question: in
        // production the leg answers first, so this is the case that proves the body's own check is not
        // decoration. The actor is still three tiles away, exactly where the walk began.
        using var harness = SaplingHarness.Create();
        harness.StandAt(ActorTileX, ActorTileY);
        ExecutionManager manager = harness.CreateManager();
        string targetId = harness.TargetId();

        manager.RequestLocalPlantSapling("req_sapling_short", Slot, TargetTileX, TargetTileY, SaplingQualifiedItemId, targetId, harness.DeadlineMs);

        LocalExecutionReceipt arrival = harness.RunArrival(manager, "req_sapling_short");

        arrival.State.Should().Be(ExecutionState.Rejected);
        arrival.ReasonCode.Should().Be(
            "target_out_of_reach",
            "an arrival that never got close is a reach failure, not the planner's stale-target `target_out_of_range`");
        arrival.Evidence.Should().Contain("approach=did_not_arrive");
        harness.HasTreeAt(TargetTileX, TargetTileY).Should().BeFalse("the native placement never ran from outside the radius");
        harness.SaplingCount().Should().Be(SaplingsInSlot, "nothing was consumed");
    }

    // ---- one body, two routes: the same world change is refused the same way --

    [Fact]
    public void TheInRangeRouteAndTheArrivalRoute_RefuseTheSameWorldChangeTheSameWay()
    {
        // The shared-body claim, as a behaviour rather than as a text match: whatever the in-range path does
        // to a world that changed, the arrival path does identically - because it is the same body and not a
        // second copy that could drift. A duplicate body would have to reproduce these codes AND the world it
        // leaves behind, which is the drift this pins.
        string inRange = RefusalOfWorldChangeThatLeftTheSlot(approach: false);
        string onArrival = RefusalOfWorldChangeThatLeftTheSlot(approach: true);

        inRange.Should().Be("sapling_not_owned_in_slot");
        onArrival.Should().Be(inRange, "both routes run the one execution body");

        static string RefusalOfWorldChangeThatLeftTheSlot(bool approach)
        {
            using SaplingHarness harness = SaplingHarness.Create();
            harness.StandAt(approach ? ActorTileX : TargetTileX - 1, ActorTileY);
            ExecutionManager manager = harness.CreateManager();
            string targetId = harness.TargetId();

            // The two runs differ in ONE thing: whether a walk sits between the request and the body. In
            // range the request acts immediately, so the empty slot is arranged first; out of range the
            // request arms a walk, the slot empties while it walks, and the arrival runs the same body.
            if (!approach)
            {
                harness.EmptySlot();
                return manager.RequestLocalPlantSapling(
                    "req_sapling_shared", Slot, TargetTileX, TargetTileY, SaplingQualifiedItemId, targetId, harness.DeadlineMs).ReasonCode;
            }

            LocalExecutionReceipt request = manager.RequestLocalPlantSapling(
                "req_sapling_shared", Slot, TargetTileX, TargetTileY, SaplingQualifiedItemId, targetId, harness.DeadlineMs);
            request.ReasonCode.Should().Be("accepted", "out of range the request arms a walk instead of acting");
            harness.EmptySlot();
            return harness.RunArrival(manager, "req_sapling_shared").ReasonCode;
        }
    }

    // ---- the declaration the companion reads ---------------------------------

    [Fact]
    public void TheSelfWalkingActionPublishesNoStandingPrecondition()
    {
        // `approachRequirement` is published through `plan_shape`. Once an action walks in itself, "you must
        // already stand beside this" would be a false sentence in front of the companion - it would spend a
        // separate `move_to_tile` on a precondition the action now satisfies on its own. Read from the
        // catalog and from the projection the Host is generated from, which are runtime facts.
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == "plant_sapling");
        registration.Descriptor!.Approach.Should().BeNull(
            "plant_sapling walks in itself, so it declares no standing precondition");

        FarmhandActionDescriptorProjection published = FarmhandActionSurfacePublication.Actions
            .Single(candidate => candidate.ActionId == "plant_sapling");
        published.Approach.Should().BeNull("plant_sapling publishes no approach requirement");

        // The actions that DO still refuse from afar keep their declaration, so the null above cannot be
        // satisfied by a catalog that forgot to project anything at all.
        FarmhandActionSurfacePublication.Actions
            .Single(candidate => candidate.ActionId == "pickup_forage")
            .Approach.Should().Be(new FarmhandActionApproachRequirementProjection("adjacent", 1));
    }

    // -------------------------------------------------------------------------

    /// <summary>
    /// A headless farm: the two map layers the engine reads, a probe farmer whose tile the cases move, and
    /// the wild-tree seed lookup a process without a content manager cannot load. The whole assembly runs
    /// without parallelization, so restoring the statics on dispose is sufficient.
    /// </summary>
    private sealed class SaplingHarness : IDisposable
    {
        private const long ActorId = 1001;

        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly Dictionary<string, object?> gameStaticsBefore = new();
        private readonly Dictionary<string, object?> treeStaticsBefore = new();

        /// <summary>
        /// The content tables and engine statics the NATIVE placement walks, captured before the fixture
        /// overwrites them and restored verbatim on dispose. A headless process has loaded none of them, so
        /// each one is supplied here rather than left to dereference null inside the native call.
        /// </summary>
        private static readonly string[] GameStatics =
        {
            "netWorldState", "otherFarmers", "_locationLookup", "_player",
            "cropData", "fruitTreeData", "objectData", "hash", "random", "sounds", "uniqueIDForThisGame",
        };

        private static readonly string[] TreeStatics = { "_WildTreeSeedLookup", "_WildTreeData" };

        private SaplingHarness()
        {
            this.gameBefore = Game1.game1;
            this.playerBefore = Game1.player;
            foreach (string name in GameStatics)
                this.gameStaticsBefore[name] = StaticField(typeof(Game1), name).GetValue(null);
            foreach (string name in TreeStatics)
                this.treeStaticsBefore[name] = StaticField(typeof(StardewValley.TerrainFeatures.Tree), name).GetValue(null);
            this.Farm = null!;
            this.Actor = null!;
        }

        internal Farm Farm { get; private set; }

        internal Farmer Actor { get; private set; }

        internal long DeadlineMs { get; private set; }

        internal static SaplingHarness Create()
        {
            var harness = new SaplingHarness();
            // `NetPosition.Get` reads Game1.HostPaused, and the native path finder resolves locations through
            // the book, so the world state and the location lookup both have to exist.
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            StaticField(typeof(Game1), "netWorldState").SetValue(null, root);
            StaticField(typeof(Game1), "otherFarmers").SetValue(null, new NetRootDictionary<long, Farmer>());
            StaticField(typeof(Game1), "_locationLookup").SetValue(null, new Dictionary<string, GameLocation>(StringComparer.OrdinalIgnoreCase));
            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));

            // `Object.isWildTreeSeed` reads this cache, and the loader behind it needs a content manager a
            // headless process does not have. The one entry the fixture plants is supplied directly, which is
            // the same reading `Data/WildTrees` would give for an Acorn.
            var seedLookup = new Dictionary<string, List<string>>(StringComparer.Ordinal)
            {
                ["309"] = new() { "1" },
                ["(O)309"] = new() { "1" },
                ["310"] = new() { "1" },
                ["(O)310"] = new() { "1" },
            };
            StaticField(typeof(StardewValley.TerrainFeatures.Tree), "_WildTreeSeedLookup").SetValue(null, seedLookup);
            // `Tree.TryGetData` (the second branch of `CheckItemPlantRules`) reads this one; an empty table is
            // the honest headless reading - no wild-tree entry has been loaded, so no type resolves from it.
            StaticField(typeof(StardewValley.TerrainFeatures.Tree), "_WildTreeData")
                .SetValue(null, new Dictionary<string, StardewValley.GameData.WildTrees.WildTreeData>(StringComparer.Ordinal));

            // The content tables the native placement walks. `Object.placementAction` reaches
            // `GameLocation.CheckItemPlantRules`, which asks all three of them in turn; a null table there is an
            // NRE inside the game, not a refusal, so each is supplied as the empty table a save-less process
            // would have. `Game1.stats` and `Game1.hash` are read by `Tree.ResolveTreeTypeFromSeed` when a seed
            // DOES resolve, and `Game1.random`/`sounds` by the tree the native branch installs.
            StaticField(typeof(Game1), "cropData").SetValue(null, new Dictionary<string, StardewValley.GameData.Crops.CropData>(StringComparer.Ordinal));
            StaticField(typeof(Game1), "fruitTreeData").SetValue(null, new Dictionary<string, StardewValley.GameData.FruitTrees.FruitTreeData>(StringComparer.Ordinal));
            StaticField(typeof(Game1), "objectData").SetValue(null, new Dictionary<string, StardewValley.GameData.Objects.ObjectData>(StringComparer.Ordinal));
            StaticField(typeof(Game1), "hash").SetValue(null, new StardewValley.Hashing.HashUtility());
            StaticField(typeof(Game1), "random").SetValue(null, new Random(0));
            StaticField(typeof(Game1), "sounds").SetValue(null, new SilentSoundsHelper());

            var farm = new Farm();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            farm.map = map;
            farm.IsOutdoors = true;
            // `isTilePlaceable` requires a real Back-layer tile, so the fixture paints one across the map the way
            // a loaded farm map would already have them; an empty layer would refuse the placement for a reason
            // that has nothing to do with the action.
            PaintBackLayer(map);
            // `CanPlantTreesHere` defaults to `IsGreenhouse || IsFarm || GetData()?.CanPlantHere`, and the
            // last of those needs the `Data/Locations` table a headless process has not loaded. A farm is
            // the honest answer here, and it is the location the sapling action is authored for.
            farm.IsFarm = true;
            InstanceField(farm, "name", new NetString("ProbeFarm"));
            // The native path finder resolves the active location through the instance's own book, so the
            // probe farm is registered the same way a loaded save would register it.
            InstanceField(Game1.game1, "_locations", new List<GameLocation> { farm });
            Game1.game1.instanceGameLocation = farm;

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            InstanceField(sprite, "spriteWidth", new NetInt(16));
            InstanceField(sprite, "spriteHeight", new NetInt(32));
            InstanceField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            InstanceField(actor, "uniqueMultiplayerID", new NetLong(ActorId));
            InstanceField(actor, "position", new NetPosition());
            InstanceField(actor, "currentLocationRef", new NetLocationRef());
            InstanceField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            InstanceField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            InstanceField(actor, "usingTool", new NetBool(false));
            InstanceField(actor, "netStamina", new NetFloat(270f));
            InstanceField(actor, "toolPower", new NetInt(0));
            InstanceField(actor, "currentToolIndex", new NetInt(0));
            // The CurrentToolIndex setter writes this flag on every slot change, and an uninitialized farmer
            // never ran its field initializer. It also reads CurrentItem, which reads these two refs first.
            InstanceField(actor, "netItemStowed", new NetBool(false));
            InstanceField(actor, "temporaryItem", new NetRef<Item>());
            InstanceField(actor, "cursorSlotItem", new NetRef<Item>());
            InstanceField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = new StardewValley.Inventories.Inventory() });
            // `Game1.stats` is `player.stats`, and the native placement increments `wildtreesplanted` before it
            // installs the tree. It is a plain field initializer an uninitialized farmer never ran.
            InstanceField(actor, "stats", new Stats());
            // `Game1.UseLegacyRandom` is `player.team.useLegacyRandom`, and the seed-to-tree-type resolution asks
            // it before it can choose a type. The real constructor loads sprite content a headless process has
            // none of, so the team is built uninitialized with only the one flag this path reads.
            var team = (FarmerTeam)FormatterServices.GetUninitializedObject(typeof(FarmerTeam));
            InstanceField(team, "useLegacyRandom", new NetBool(true));
            InstanceField(actor, "teamRoot", new NetRoot<FarmerTeam>(team));
            // `TryStart` refuses a body it cannot move, and `Farmer.canMove` is a plain bool that defaults to
            // false on an uninitialized actor.
            typeof(Farmer).GetField("canMove", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, true);
            actor.currentLocation = farm;
            StaticField(typeof(Game1), "_player").SetValue(null, actor);

            harness.Farm = farm;
            harness.Actor = actor;
            harness.DeadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
            harness.PutInSlot(WildTreeSeed(SaplingQualifiedItemId, stack: SaplingsInSlot));
            return harness;
        }

        /// <summary>
        /// An item with exactly the three facts the sapling branch reads: its unqualified id, its qualified id
        /// and its stack. Built through the empty constructor, which initialises every NetField the native
        /// placement touches (bounding box, tile location) without reading the content tables a headless
        /// process has not loaded.
        /// </summary>
        internal static StardewValley.Object WildTreeSeed(string qualifiedItemId, int stack)
        {
            var seed = new StardewValley.Object();
            // "(O)" is three characters: the unqualified id follows it.
            seed.Stack = stack;
            seed.ItemId = qualifiedItemId[3..];
            // ItemId clears the qualified cache, so the qualified value the action compares is written after it.
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(seed, qualifiedItemId);
            return seed;
        }

        /// <summary>Sets the actor's tile through the engine's own position, as a warp would.</summary>
        internal void StandAt(int tileX, int tileY) =>
            this.Actor.position.Set(new Microsoft.Xna.Framework.Vector2(tileX * 64 + 8, tileY * 64));

        internal void PutInSlot(Item? item)
        {
            this.Actor.Items.Clear();
            this.Actor.Items.Add(item!);
        }

        internal void EmptySlot() => this.Actor.Items.Clear();

        /// <summary>How many saplings the pack still holds: the postcondition a placement must not fake.</summary>
        internal int SaplingCount()
        {
            int total = 0;
            foreach (Item? item in this.Actor.Items)
            {
                if (item is not null && string.Equals(item.QualifiedItemId, SaplingQualifiedItemId, StringComparison.Ordinal))
                    total += item.Stack;
            }
            return total;
        }

        internal bool HasTreeAt(int tileX, int tileY) =>
            this.Farm.terrainFeatures.TryGetValue(new Microsoft.Xna.Framework.Vector2(tileX, tileY), out StardewValley.TerrainFeatures.TerrainFeature? feature)
            && feature is StardewValley.TerrainFeatures.Tree;

        /// <summary>Puts an ordinary object on the tile, which the wild-tree branch refuses as occupied.</summary>
        internal void OccupyTile(int tileX, int tileY) =>
            this.Farm.objects[new Microsoft.Xna.Framework.Vector2(tileX, tileY)] = WildTreeSeed(SaplingQualifiedItemId, stack: 1);

        /// <summary>
        /// The opaque identity the request must carry, from the ONE builder the request path and discovery
        /// share - so a target id the test invents can never agree with the product by coincidence.
        /// </summary>
        internal string TargetId() =>
            (string)typeof(ExecutionManager)
                .GetMethod("BuildTreeSaplingTargetId", BindingFlags.NonPublic | BindingFlags.Static)!
                .Invoke(null, new object[] { this.Farm, Slot, TargetTileX, TargetTileY, SaplingQualifiedItemId })!;

        internal string Describe(LocalExecutionReceipt receipt, ExecutionManager manager)
        {
            int count = this.Actor.Items.Count;
            Item? first = count > 0 ? this.Actor.Items[0] : null;
            return $"reason={receipt.ReasonCode};evidence={receipt.Evidence};count={count}"
                + $";same_actor={ReferenceEquals(this.Actor, Game1.player)}"
                + $";item={first?.GetType().Name ?? "null"}"
                + $";qid={first?.QualifiedItemId ?? "null"}"
                + $";stack={first?.Stack.ToString() ?? "null"}"
                + $";wild={first is StardewValley.Object seed && StardewValley.Object.isWildTreeSeed(seed.ItemId)}"
                + $";raw_id={first?.ItemId ?? "null"}"
                + $";lookup={(StaticField(typeof(StardewValley.TerrainFeatures.Tree), "_WildTreeSeedLookup").GetValue(null) is Dictionary<string, List<string>> map ? $"{map.Count}:{string.Join(",", map.Keys)}" : "null")}"
                + $";armed={this.ArmedApproach(manager)?.ActionId ?? "none"}";
        }

        /// <summary>
        /// Paints one ordinary ground tile on every Back-layer cell, the way a loaded farm map already has them.
        /// `isTilePlaceable` refuses a cell with no tile at all, so without this the placement would be refused
        /// for a fixture reason rather than for the action's own.
        /// </summary>
        private static void PaintBackLayer(xTile.Map map)
        {
            var sheet = new xTile.Tiles.TileSheet(
                "probe", map, "Maps/probe", new xTile.Dimensions.Size(64, 64), new xTile.Dimensions.Size(16, 16));
            map.AddTileSheet(sheet);
            xTile.Layers.Layer back = map.GetLayer("Back");
            for (int x = 0; x < back.LayerWidth; x++)
            {
                for (int y = 0; y < back.LayerHeight; y++)
                    back.Tiles[x, y] = new xTile.Tiles.StaticTile(back, sheet, xTile.Tiles.BlendMode.Alpha, 0);
            }
        }

        /// <summary>An audio helper that answers every cue as unplayable, so no game audio device is touched.</summary>
        private sealed class SilentSoundsHelper : StardewValley.Audio.SoundsHelper
        {
            public override bool PlayLocal(string cueName, GameLocation location, Microsoft.Xna.Framework.Vector2? position, int? pitch, StardewValley.Audio.SoundContext context, out ICue cue)
            {
                cue = null!;
                return false;
            }

            public override void PlayAll(string cueName, GameLocation location, Microsoft.Xna.Framework.Vector2? position, int? pitch, StardewValley.Audio.SoundContext context)
            {
            }
        }

        internal ExecutionManager CreateManager()
        {
            var manager = new ExecutionManager(
                new DummyMonitor(),
                () => FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "plant_sapling" }));
            manager.SetTestActorResolver(() => this.Actor);
            return manager;
        }

        internal LocalApproachSpec? ArmedApproach(ExecutionManager manager) =>
            (LocalApproachSpec?)InstanceFieldValue(manager, "activeToolApproach");

        /// <summary>
        /// The completion pass's own last step: the armed approach's arrival closure, run against the world as
        /// it stands now. The production caller reaches it from <c>Update</c>; this calls the same delegate, so
        /// the case exercises the arrival path and not a second copy of it.
        /// </summary>
        internal LocalExecutionReceipt RunArrival(ExecutionManager manager, string requestId)
        {
            LocalApproachSpec approach = this.ArmedApproach(manager)
                ?? throw new InvalidOperationException($"no approach is armed for {requestId}");
            return approach.Execute($"{approach.ExecutionId}_arrival", $"{approach.RequestId}_arrival");
        }

        private static FieldInfo StaticField(Type type, string name) =>
            type.GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException($"{type.Name}.{name} is missing");

        private static FieldInfo InstanceFieldInfo(Type type, string name) =>
            type.GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException($"{type.Name}.{name} is missing");

        private static void InstanceField(object target, string name, object value) =>
            InstanceFieldInfo(target.GetType(), name).SetValue(target, value);

        private static object? InstanceFieldValue(object target, string name) =>
            InstanceFieldInfo(target.GetType(), name).GetValue(target);

        public void Dispose()
        {
            foreach (KeyValuePair<string, object?> entry in this.gameStaticsBefore)
                StaticField(typeof(Game1), entry.Key).SetValue(null, entry.Value);
            foreach (KeyValuePair<string, object?> entry in this.treeStaticsBefore)
                StaticField(typeof(StardewValley.TerrainFeatures.Tree), entry.Key).SetValue(null, entry.Value);
            Game1.game1 = this.gameBefore!;
        }
    }
}
