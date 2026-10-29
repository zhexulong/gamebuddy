using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Netcode;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// <c>ship_item</c> measured reach against the bin's whole footprint - correct, and deliberately kept - but
/// then REFUSED a bin two tiles away with <c>target_out_of_range</c> instead of walking to it.
///
/// <para>
/// The shape it now follows is the one the facility family already uses: a thin request path that validates the
/// bin and the item, hands the geometry to <c>TryBeginToolApproach</c>, and ONE <c>ExecuteShipItem</c> body
/// reached both in range and on arrival - re-reading the bin and the footprint distance because the walk takes
/// ticks.
/// </para>
///
/// <para>
/// The preservation that matters most: a shipping bin is MULTI-TILE (2x1 on the Farm, 2x2 on Ginger Island). The
/// approach footprint is the bin's occupied tile set, not its anchor, so the selector can never choose a tile
/// beside the anchor that is inside the bin, and a farmer standing at the bin's south face is admitted - the
/// anchor's own eight-neighbour ring does not contain that tile for a bin two rows tall.
/// </para>
///
/// <para>
/// Most cases here drive the real <see cref="ExecutionManager"/> against a headless farm and assert the returned
/// receipt. The exception is <see cref="TheApproachIsHandedTheFootprint_NotTheAnchorAlone"/>, which is a
/// call-shape pin and says so.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class ShipItemApproachWiringTests
{
    private const long ActorId = 1001;
    private const string ShippableItemId = "(O)24";

    // ---- the refusal became a walk -------------------------------------------

    [Fact]
    public void AnOutOfRangeShippingBin_AdmitsAnApproach_InsteadOfRefusing()
    {
        using var harness = ShipItemHarness.Create(binTileX: 20, binTileY: 20, binWidth: 2, binHeight: 1);
        // Ten tiles south of the bin: far outside the footprint's Chebyshev-1 ring.
        harness.StandAt(20, 30);
        ExecutionManager manager = harness.CreateManager();

        LocalExecutionReceipt receipt = manager.RequestLocalShipItem(
            "req_ship_far", 0, 20, 20, ShippableItemId, harness.TargetId, harness.DeadlineMs);

        // THE assertion: the actor is sent walking. `target_out_of_range` was the defect - a bin the actor
        // can simply walk to is not out of range.
        receipt.State.Should().Be(ExecutionState.Accepted, "being far from a shipping bin is a walk, not a refusal");
        receipt.ReasonCode.Should().Be("accepted");
        receipt.ReasonCode.Should().NotBe("target_out_of_range");
        receipt.State.Should().NotBe(ExecutionState.Rejected);

        // The armed walk names where the actor will stand and which bin tile that standing tile reaches, so
        // the receipt says "on my way" rather than claiming anything shipped.
        receipt.Evidence.Should().Contain("approach=adjacent");
        receipt.Evidence.Should().Contain("reach=1");
        receipt.Evidence.Should().Contain($"anchor=20,20");
        receipt.Evidence.Should().Contain("reached=footprint");

        LocalApproachSpec armed = harness.ArmedApproach();
        armed.ActionId.Should().Be("ship_item", "the snapshot must publish the real action id");
        armed.ExpectedTargetId.Should().Be(harness.TargetId);

        // Nothing shipped: a walk performs no native settlement.
        harness.Actor.Items[0].Should().NotBeNull("the request path claims nothing while the actor is walking");
    }

    // ---- arrival re-reads the live bin, by two different names ---------------

    [Fact]
    public void TheArrival_RefusesByNameWhenTheBinChangedIdentityDuringTheWalk()
    {
        using var harness = ShipItemHarness.Create(binTileX: 20, binTileY: 20, binWidth: 2, binHeight: 1);
        harness.StandAt(20, 30);
        ExecutionManager manager = harness.CreateManager();
        string armedTarget = harness.TargetId;

        LocalExecutionReceipt request = manager.RequestLocalShipItem(
            "req_ship_moved", 0, 20, 20, ShippableItemId, armedTarget, harness.DeadlineMs);
        request.State.Should().Be(ExecutionState.Accepted);

        // The bin MOVES while the actor walks. Its opaque id hashes the farm, the origin tile and the extent,
        // so the same building at a new origin is a different target.
        harness.MoveBin(30, 20);
        harness.TargetId.Should().NotBe(armedTarget, "the identity must actually change, or this proves nothing");

        LocalExecutionReceipt arrival = harness.RunArrival(manager);

        arrival.State.Should().Be(ExecutionState.Rejected);
        arrival.ReasonCode.Should().Be(
            "shipping_bin_target_changed",
            "an arrival whose bin is no longer the requested one refuses by THAT name, not by a distance");
        arrival.Evidence.Should().Contain($"expected={armedTarget}");
        arrival.Evidence.Should().Contain($"actual={harness.TargetId}");
        harness.Actor.Items[0].Should().NotBeNull("nothing may ship into a bin that changed identity");
    }

    [Fact]
    public void TheArrival_KeepsTheOutOfRangeName_WhenTheActorDidNotReachTheBin()
    {
        using var harness = ShipItemHarness.Create(binTileX: 20, binTileY: 20, binWidth: 2, binHeight: 1);
        harness.StandAt(20, 30);
        ExecutionManager manager = harness.CreateManager();

        LocalExecutionReceipt request = manager.RequestLocalShipItem(
            "req_ship_short", 0, 20, 20, ShippableItemId, harness.TargetId, harness.DeadlineMs);
        request.State.Should().Be(ExecutionState.Accepted);

        // The bin is unchanged and its identity still matches; the WALK fell short. Same request, same body,
        // a different fact - and therefore a different name from the case above.
        LocalExecutionReceipt arrival = harness.RunArrival(manager);

        arrival.State.Should().Be(ExecutionState.Rejected);
        arrival.ReasonCode.Should().Be("target_out_of_range", "a footprint still out of reach after a walk names THAT fact");
        arrival.Evidence.Should().Contain("approach=arrived");
        arrival.Evidence.Should().Contain("footprint_tiles=2", "the refusal reports the extent it measured");

        // The two arrival failures are distinct names, which is the whole point of re-checking both.
        arrival.ReasonCode.Should().NotBe("shipping_bin_target_changed");
    }

    // ---- the footprint rule is preserved --------------------------------------

    [Theory]
    // The two real extents: the Farm's 2x1 building and Ginger Island's 2x2 native footprint.
    [InlineData(2, 1)]
    [InlineData(2, 2)]
    public void AMultiTileBin_IsWorkedFromAnyFace_IncludingTheOnesTheAnchorRuleRefuses(int width, int height)
    {
        const int anchorX = 5;
        const int anchorY = 5;
        var footprintRule = new FootprintRect(anchorX, anchorY, width, height);
        (int X, int Y)[] footprint = footprintRule.Tiles().Select(tile => (tile.X, tile.Y)).ToArray();

        // Every tile of the dilated ring, with the distance the anchor rule would measure for it.
        (int X, int Y, int AnchorDistance)[] ring = footprintRule.RingTiles()
            .Select(tile => (X: tile.X, Y: tile.Y, AnchorDistance: Math.Max(Math.Abs(tile.X - anchorX), Math.Abs(tile.Y - anchorY))))
            .ToArray();
        ring.Should().NotBeEmpty();

        foreach ((int X, int Y, int _) tile in ring)
            footprintRule.IsWithinRing(new TilePoint(tile.X, tile.Y))
                .Should().BeTrue($"({tile.X},{tile.Y}) is a face of a {width}x{height} bin");

        // The rule this change exists for: some faces are Chebyshev-2 (or more) from the anchor, and the anchor-only
        // rule refuses exactly those. A bin whose every face is anchor-adjacent would make the footprint moot.
        (int X, int Y, int AnchorDistance)[] anchorRefused = ring.Where(tile => tile.AnchorDistance > 1).ToArray();
        anchorRefused.Should().NotBeEmpty(
            $"a {width}x{height} bin has faces the anchor rule refuses; otherwise the footprint would be decoration");

        foreach ((int X, int Y, int _) face in anchorRefused)
        {
            // A farmer one row/column beyond that face walks IN to it: the selector must choose the face itself.
            (int X, int Y) approachFrom = face.X == anchorX - 1 ? (face.X - 1, face.Y)
                : face.X == anchorX + width ? (face.X + 1, face.Y)
                : face.Y == anchorY - 1 ? (face.X, face.Y - 1)
                : (face.X, face.Y + 1);
            ExecutionManager.SelectToolApproachTile(footprint, approachFrom, _ => true, _ => true)
                .Should().NotBeNull("every face of the bin is approachable from just outside it");
        }

        // The worked example the guidance names: the SOUTH face of a bin at least two tall. Its tiles sit two rows
        // below the anchor, so the anchor-only rule refuses them while the footprint rule admits them.
        if (height >= 2)
        {
            foreach (int x in Enumerable.Range(anchorX, width))
            {
                var southFace = (X: x, Y: anchorY + height);
                footprintRule.IsWithinRing(new TilePoint(southFace.X, southFace.Y))
                    .Should().BeTrue($"({southFace.X},{southFace.Y}) is the south face of a {width}x{height} bin");
                Math.Max(Math.Abs(southFace.X - anchorX), Math.Abs(southFace.Y - anchorY))
                    .Should().BeGreaterThan(1, "and the anchor rule refuses it - that is the defect");

                // Walking in from one further south lands ON the south face, never at the anchor.
                ExecutionManager.SelectToolApproachTile(footprint, (southFace.X, southFace.Y + 1), _ => true, _ => true)
                    .Should().Be(southFace);

                // The arrival is measured against the footprint tile that standing tile reaches, so a walk that
                // ended exactly where it was sent is admitted by the same rule the request path used.
                (int X, int Y) reached = ExecutionManager.SelectReachTile(footprint, southFace);
                footprint.Should().Contain(reached, "the reach tile is a tile of the bin, never a point beside it");
                Chebyshev(reached, southFace).Should().Be(1);
            }
        }

        // A tile INSIDE the bin is contact for the distance rule but is never an approach: nobody stands in the
        // bin, so the selector's occupied-set exclusion keeps it out.
        footprintRule.IsWithinRing(new TilePoint(anchorX, anchorY)).Should().BeFalse();
    }

    /// <summary>
    /// The 2x2 south-east corner case as ONE observation: an actor one tile south of the footprint's south-east
    /// corner is already inside the native reach, AND the tile an approach would choose is on the south side.
    ///
    /// Both halves are asked of the production rule, not of a restatement: the distance comes from
    /// <c>ShippingBinChebyshevDistance</c> over the bin's real extent, and the tile from the same
    /// <c>SelectToolApproachTile</c> the approach leg calls. If the distance rule and the approach footprint
    /// drifted apart, this would admit an actor the walk then cannot place, or vice versa.
    /// </summary>
    [Fact]
    public void A2x2Bin_FromOneTileSouthOfItsSouthEastCorner_IsInRange_AndTheApproachTileIsSouth()
    {
        using var harness = ShipItemHarness.Create(binTileX: 5, binTileY: 5, binWidth: 2, binHeight: 2);
        // South-east corner of the 2x2 footprint is (6,6); one tile south of it is (6,7).
        harness.StandAt(6, 7);

        harness.ShippingBinDistanceToOwnBin().Should().Be(
            1, "the footprint rule admits every tile adjacent to ANY occupied tile, including the anchor-refused ones");

        (int X, int Y)[] footprint = harness.OwnFootprint();
        (int X, int Y)? standing = ExecutionManager.SelectToolApproachTile(footprint, (6, 7), _ => true, _ => true);
        standing.Should().NotBeNull();
        footprint.Should().NotContain(standing!.Value, "an approach tile inside the bin is not an approach");
        standing.Value.Y.Should().Be(
            7, "the chosen tile is on the SOUTH side (anchorY + height = 5 + 2), never the north-west corner");
        Chebyshev(standing.Value, (6, 7)).Should().Be(0, "the actor already stands on that tile");
    }

    /// <summary>
    /// CALL-SHAPE PIN, and this is its limit: it reads the request path's source to assert the approach call
    /// passes a footprint argument as well as an anchor, because the two overloads of
    /// <c>TryBeginToolApproach</c> are not distinguishable from a receipt - both produce an <c>accepted</c>
    /// receipt naming a tile. What it can prove is that a revert to the single-tile overload fails
    /// (verified by injecting that exact revert). What it cannot prove is that the footprint is the RIGHT set;
    /// that is <see cref="AMultiTileBin_IsWorkedFromAnyFace_IncludingTheOnesTheAnchorRuleRefuses"/> and
    /// <see cref="A2x2Bin_FromOneTileSouthOfItsSouthEastCorner_IsInRange_AndTheApproachTileIsSouth"/>.
    /// </summary>
    [Fact]
    public void TheApproachIsHandedTheFootprint_NotTheAnchorAlone()
    {
        string source = File.ReadAllText(RepositorySourcePath(
            Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.shippingactions.cs")));
        string request = MethodBody(source, "public LocalExecutionReceipt RequestLocalShipItem(");

        int call = request.IndexOf("this.TryBeginToolApproach(", StringComparison.Ordinal);
        call.Should().BeGreaterThanOrEqualTo(0);
        int argumentEnd = request.IndexOf("expectedTargetId,", call, StringComparison.Ordinal);
        argumentEnd.Should().BeGreaterThan(call, "the approach must still bind the bin's opaque identity");
        string arguments = request[call..argumentEnd];

        arguments.Should().Contain("ShippingBinFootprintTiles(bin)",
            "the multi-tile overload's footprint parameter is what lets the selector pick a face other than the anchor's");
        arguments.Should().Contain("(bin.TileX, bin.TileY)",
            "the anchor is passed as the overload's separate anchor parameter, for receipt evidence only");
        // Anchor BEFORE footprint: that is the multi-tile overload's parameter order. The one-tile overload has no
        // footprint parameter, so passing the anchor alone puts `expectedTargetId` right after it.
        arguments.IndexOf("(bin.TileX, bin.TileY)", StringComparison.Ordinal)
            .Should().BeLessThan(
                arguments.IndexOf("ShippingBinFootprintTiles(bin)", StringComparison.Ordinal),
                "the anchor parameter precedes the footprint parameter in the multi-tile overload");
    }

    // -------------------------------------------------------------------------

    private static int Chebyshev((int X, int Y) a, (int X, int Y) b) =>
        Math.Max(Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));

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

    /// <summary>
    /// A headless Farm with one shipping bin of a chosen extent, the game statics the shipping path
    /// dereferences, and a probe farmer whose tile the cases move. The whole assembly runs without
    /// parallelization, so restoring the statics on dispose is sufficient.
    /// </summary>
    private sealed class ShipItemHarness : IDisposable
    {
        private const BindingFlags Any =
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;

        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;
        private readonly object? otherFarmersBefore;
        private readonly object? locationLookupBefore;
        private readonly bool worldReadyBefore;
        private readonly object? objectDataBefore;
        private readonly object? buildingDataBefore;
        private readonly StardewValley.Buildings.ShippingBin bin;
        private readonly List<ExecutionManager> managers = new();

        private ShipItemHarness(int binTileX, int binTileY, int binWidth, int binHeight)
        {
            this.gameBefore = Game1.game1;
            this.playerBefore = Game1.player;
            this.worldStateBefore = Field(typeof(Game1), "netWorldState").GetValue(null);
            this.otherFarmersBefore = Field(typeof(Game1), "otherFarmers").GetValue(null);
            this.locationLookupBefore = Field(typeof(Game1), "_locationLookup").GetValue(null);
            this.objectDataBefore = Field(typeof(Game1), "objectData").GetValue(null);
            this.buildingDataBefore = Field(typeof(Game1), "buildingData").GetValue(null);
            this.worldReadyBefore = Context.IsWorldReady;

            // `Context.IsWorldReady` gates the request path before any geometry, and the module has no public
            // setter; its generated one is reachable here and the assembly disables parallelization.
            typeof(Context).GetProperty("IsWorldReady", Any)!.GetSetMethod(nonPublic: true)!
                .Invoke(null, new object[] { true });

            // The shipping path reads item and building data through these tables; without them
            // `canBeShipped` and `Building.GetData` dereference null.
            Field(typeof(Game1), "objectData").SetValue(null, new Dictionary<string, StardewValley.GameData.Objects.ObjectData>());
            Field(typeof(Game1), "buildingData").SetValue(null, new Dictionary<string, StardewValley.GameData.Buildings.BuildingData>());

            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            Field(typeof(Game1), "netWorldState").SetValue(null, root);
            Field(typeof(Game1), "otherFarmers").SetValue(null, new NetRootDictionary<long, Farmer>());
            var lookup = new Dictionary<string, GameLocation>(StringComparer.OrdinalIgnoreCase);
            Field(typeof(Game1), "_locationLookup").SetValue(null, lookup);
            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));

            var farm = new Farm();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(80, 40), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(80, 40), new xTile.Dimensions.Size(64, 64)));
            farm.map = map;
            Set(farm, "name", new NetString("Farm"));
            lookup["Farm"] = farm;
            Game1.game1.instanceGameLocation = farm;
            this.Farm = farm;

            // The buildings collection's OnValueAdded handler calls into world state we do not simulate, so the
            // collection is replaced before the bin is added: the resolver only needs the list to enumerate.
            Set(farm, "buildings", new NetCollection<StardewValley.Buildings.Building>());
            this.bin = (StardewValley.Buildings.ShippingBin)FormatterServices.GetUninitializedObject(
                typeof(StardewValley.Buildings.ShippingBin));
            Set(this.bin, "daysOfConstructionLeft", new NetInt(0));
            Set(this.bin, "buildingType", new NetString("Shipping Bin"));
            Set(this.bin, "parentLocationName", new NetString("Farm"));
            Set(this.bin, "humanDoor", new NetPoint(new Microsoft.Xna.Framework.Point(-1, -1)));
            Set(this.bin, "animalDoor", new NetPoint(new Microsoft.Xna.Framework.Point(-1, -1)));
            this.SetBinExtent(binTileX, binTileY, binWidth, binHeight);
            farm.buildings.Add(this.bin);

            var inventory = new StardewValley.Inventories.Inventory();
            var item = (StardewValley.Object)FormatterServices.GetUninitializedObject(typeof(StardewValley.Object));
            Set(item, "itemId", new NetString("24"));
            Set(item, "stack", new NetInt(5));
            Set(item, "quality", new NetInt(0));
            Set(item, "bigCraftable", new NetBool(false));
            Set(item, "type", new NetString("Basic"));
            Set(item, "questItem", new NetBool(false));
            Set(item, "isRecipe", new NetBool(false));
            inventory.Add(item);

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

            this.DeadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
        }

        internal Farm Farm { get; }

        internal Farmer Actor { get; }

        internal long DeadlineMs { get; }

        internal string TargetId => (string)Private(
            "BuildShippingBinTargetId", BindingFlags.NonPublic | BindingFlags.Static,
            new object[] { this.Farm, this.bin })!;

        internal static ShipItemHarness Create(int binTileX, int binTileY, int binWidth, int binHeight) =>
            new(binTileX, binTileY, binWidth, binHeight);

        /// <summary>Sets the actor's tile through the engine's own position, as a warp would.</summary>
        internal void StandAt(int tileX, int tileY) =>
            this.Actor.position.Set(new Microsoft.Xna.Framework.Vector2(tileX * 64 + 8, tileY * 64));

        internal void MoveBin(int tileX, int tileY) =>
            this.SetBinExtent(tileX, tileY, this.bin.tilesWide.Value, this.bin.tilesHigh.Value);

        internal ExecutionManager CreateManager()
        {
            var manager = new ExecutionManager(
                new DummyMonitor(),
                () => FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "ship_item" }));
            manager.SetTestActorResolver(() => this.Actor);
            this.managers.Add(manager);
            return manager;
        }

        /// <summary>The walk the request path armed.</summary>
        internal LocalApproachSpec ArmedApproach()
        {
            ExecutionManager manager = this.managers.Last();
            return (LocalApproachSpec?)Field(typeof(ExecutionManager), "activeToolApproach")
                    .GetValue(manager)
                ?? throw new InvalidOperationException("no approach is armed");
        }

        /// <summary>
        /// Runs the action's OWN arrival body - the closure the request path handed the approach - and returns
        /// the terminal it minted. This bypasses <c>CompleteToolApproach</c>'s shared location/radius gate on
        /// purpose: the case is what the body itself does when it is entered.
        /// </summary>
        internal LocalExecutionReceipt RunArrival(ExecutionManager manager)
        {
            LocalApproachSpec approach = this.ArmedApproach();
            _ = manager;
            return approach.Execute($"{approach.ExecutionId}_arrival", $"{approach.RequestId}_arrival");
        }

        /// <summary>The bin's occupied tiles, via the production helper the walk target and the distance share.</summary>
        internal (int X, int Y)[] OwnFootprint() =>
            ((int X, int Y)[])Private("ShippingBinFootprintTiles", BindingFlags.NonPublic | BindingFlags.Static,
                new[] { ResolvedBin() })!;

        /// <summary>The production footprint distance from the actor to this bin.</summary>
        internal int ShippingBinDistanceToOwnBin() =>
            (int)Private("ShippingBinChebyshevDistance", BindingFlags.NonPublic | BindingFlags.Static,
                new object[] { this.Actor, ResolvedBin() })!;

        private object ResolvedBin()
        {
            Type resolved = typeof(ExecutionManager).GetNestedType("ResolvedShippingBin", BindingFlags.NonPublic)
                ?? throw new InvalidOperationException("ResolvedShippingBin is missing");
            return Activator.CreateInstance(
                resolved,
                this.TargetId,
                this.bin.tileX.Value,
                this.bin.tileY.Value,
                this.bin.tilesWide.Value,
                this.bin.tilesHigh.Value,
                "Farm")!;
        }

        private object? Private(string name, BindingFlags flags, object[] arguments) =>
            typeof(ExecutionManager).GetMethod(name, flags | BindingFlags.Public | BindingFlags.NonPublic)!
                .Invoke(null, arguments);

        private void SetBinExtent(int tileX, int tileY, int width, int height)
        {
            Set(this.bin, "tileX", new NetInt(tileX));
            Set(this.bin, "tileY", new NetInt(tileY));
            Set(this.bin, "tilesWide", new NetInt(width));
            Set(this.bin, "tilesHigh", new NetInt(height));
        }

        public void Dispose()
        {
            typeof(Context).GetProperty("IsWorldReady", Any)!.GetSetMethod(nonPublic: true)!
                .Invoke(null, new object[] { this.worldReadyBefore });
            Field(typeof(Game1), "netWorldState").SetValue(null, this.worldStateBefore);
            Field(typeof(Game1), "otherFarmers").SetValue(null, this.otherFarmersBefore);
            Field(typeof(Game1), "_locationLookup").SetValue(null, this.locationLookupBefore);
            Field(typeof(Game1), "objectData").SetValue(null, this.objectDataBefore);
            Field(typeof(Game1), "buildingData").SetValue(null, this.buildingDataBefore);
            Field(typeof(Game1), "_player").SetValue(null, this.playerBefore);
            Game1.game1 = this.gameBefore;
        }

        private static FieldInfo Field(Type type, string name) =>
            type.GetField(name, Any) ?? throw new InvalidOperationException($"{type.Name}.{name} is missing");

        private static void Set(object target, string name, object value) =>
            Field(target.GetType(), name).SetValue(target, value);
    }
}
