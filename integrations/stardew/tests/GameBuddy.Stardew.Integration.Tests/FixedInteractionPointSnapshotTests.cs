using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using Netcode;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The two whole-map halves of C (addressability), proven as BEHAVIOUR on a real <see cref="GameLocation"/> and a
/// real <see cref="Farmer"/> rather than as source shape.
///
/// <para>
/// (1) FIXED INTERACTION POINTS ARE TOPOLOGY, NOT ENTITIES. A mine level's ladder-up is a Buildings-layer tile
/// index: it is not in <c>location.warps</c>, not in <c>location.objects</c>, and no walk ever brings it inside the
/// Mod's six-tile discovery radius, because the radius is measured from the actor and the tile does not move.
/// Measured 2026-11-04: a companion in a mine level was published <c>warps: 0</c>, <c>doorTargets: 0</c> and no
/// ladder it could name, and stayed until it passed out.
/// </para>
///
/// <para>
/// (2) WATER IS TOPOLOGY TOO. <c>DiscoverRefillWateringCanTargets</c> scanned six tiles, so on a farm whose pond sits
/// ten or twenty tiles away it published ZERO refill targets and a watering plan dead-ended on an empty can. Both
/// halves now read the whole map, keep a bounded nearest-first slice, and state what the cap left out.
/// </para>
///
/// <para>
/// The radius below is READ from <see cref="ExecutionManager.TargetDiscoveryRadius"/>, never typed here: the point of
/// these cases is that they stand outside whatever radius the entity families use.
/// </para>
/// </summary>
public sealed class FixedInteractionPointSnapshotTests
{
    /// <summary>
    /// The defect, as a case: water the actor can walk to but never sees.
    ///
    /// Two water tiles are placed far outside <c>TargetDiscoveryRadius</c> and both must be published. The assertion
    /// names the distance so a reader can see the ring the old scan stopped at.
    /// </summary>
    [Fact]
    public void WaterFarOutsideTheDiscoveryRadiusIsStillPublished()
    {
        using FixedPointHarness harness = FixedPointHarness.Create();
        harness.SetWater(30, 4);
        harness.SetWater(12, 20);

        IReadOnlyList<BridgeRefillWateringCanTarget> targets = ExecutionManager.DiscoverRefillWateringCanTargets(harness.Actor);

        targets.Select(target => $"{target.X},{target.Y}").Should().BeEquivalentTo(
            new[] { "30,4", "12,20" },
            "a pond is a map feature: the tile the actor must walk to is the one the old six-tile ring dropped, and a "
            + "dropped one is a watering plan that dead-ends on an empty can");
        foreach (BridgeRefillWateringCanTarget target in targets)
            ChebyshevFrom(harness.Actor, target.X, target.Y).Should().BeGreaterThan(
                ExecutionManager.TargetDiscoveryRadius,
                "this case only proves anything while the water stands outside the entity radius");
    }

    /// <summary>
    /// The other half of the same fix: what the cap keeps is the NEAREST water, then X, then Y.
    ///
    /// A nearest-first truncation is the only one a refill plan cannot be misled by: every dropped tile is strictly
    /// farther than every published one, so walking to the first published tile is still the right move.
    /// </summary>
    [Fact]
    public void ThePublishedWaterIsTheNearestAndInAStableOrder()
    {
        using FixedPointHarness harness = FixedPointHarness.Create();
        for (int x = 0; x < FixedPointHarness.Width; x++)
            harness.SetWater(x, FixedPointHarness.Height - 1);

        IReadOnlyList<BridgeRefillWateringCanTarget> first = ExecutionManager.DiscoverRefillWateringCanTargets(harness.Actor);
        IReadOnlyList<BridgeRefillWateringCanTarget> second = ExecutionManager.DiscoverRefillWateringCanTargets(harness.Actor);

        first.Should().NotBeEmpty("the map carries water on its south row");
        first.Select(target => (target.X, target.Y)).Should().Equal(
            second.Select(target => (target.X, target.Y)),
            "the same world must publish the same order twice: an order that drifts makes two identical programs differ");
        first.Select(target => ChebyshevFrom(harness.Actor, target.X, target.Y))
            .Should()
            .BeInAscendingOrder("the cap keeps the nearest, so nothing published can be farther than what it kept out");
        first.Should().OnlyHaveUniqueItems();
        first.Select(target => (target.X, target.Y)).Should().OnlyHaveUniqueItems();
    }

    /// <summary>
    /// A mine level's four topology tiles, published whole-map: each Buildings-layer index arrives with the kind the
    /// engine dispatches on it, wherever it stands on the map.
    ///
    /// The expectation comes from <see cref="FixedInteractionPointKinds.MineShaftTiles"/> - which
    /// <c>FixedInteractionPointMineTileSourceShapeTests</c> holds to <c>MineShaft.checkAction</c> itself - so this case
    /// is about the SCAN reaching them, not about what the indices mean.
    /// </summary>
    [Fact]
    public void AMineLevelsTopologyTilesArePublishedWhereverTheyStand()
    {
        using FixedPointHarness harness = FixedPointHarness.Create();
        foreach (MineShaftFixedTile tile in FixedInteractionPointKinds.MineShaftTiles)
        {
            (int x, int y) = harness.FarCorner(tile.TileIndex);
            harness.SetMineTile(x, y, tile.TileIndex);
        }

        IReadOnlyList<BridgeFixedInteractionPoint> points =
            ExecutionManager.DiscoverFixedInteractionPoints(harness.Actor, out int omitted);

        omitted.Should().Be(0);
        points.Should().HaveCount(
            FixedInteractionPointKinds.MineShaftTiles.Count,
            "one entry per fixed tile, and nothing else on a map that carries no tile properties");
        foreach (MineShaftFixedTile tile in FixedInteractionPointKinds.MineShaftTiles)
        {
            BridgeFixedInteractionPoint point = points.Should()
                .ContainSingle(candidate => string.Equals(candidate.Kind, tile.Kind, StringComparison.Ordinal)).Subject;
            // A ladder is a tile INDEX, not a property, so the engine carries no word to quote.
            point.ActionWord.Should().BeNull($"tile {tile.TileIndex} is an index, not an Action property");
            ChebyshevFrom(harness.Actor, point.X, point.Y).Should().BeGreaterThan(
                ExecutionManager.TargetDiscoveryRadius,
                "the whole point is that this tile is outside every radius an entity scan could reach");
        }
    }

    /// <summary>
    /// The two PROPERTY sources, with the engine's own word beside each: an <c>Action</c> on the Buildings layer and a
    /// <c>TouchAction</c> on the Back layer, which is the layer <c>GameLocation.cs:4225</c> reads it from.
    ///
    /// The words are the engine's, not the Mod's: <c>MinecartTransport</c> out of
    /// <c>Action: MinecartTransport Default</c>, which is the first word <c>ArgUtility.Get(action, 1)</c> hashes out.
    /// </summary>
    [Fact]
    public void PropertyTilesArePublishedWithTheEnginesOwnWord()
    {
        using FixedPointHarness harness = FixedPointHarness.Create();
        harness.SetActionTile(31, 2, "MinecartTransport Default");
        harness.SetTouchActionTile(2, 21, "BuyBackpack 1701");

        IReadOnlyList<BridgeFixedInteractionPoint> points =
            ExecutionManager.DiscoverFixedInteractionPoints(harness.Actor, out _);

        points.Should().BeEquivalentTo(new[]
        {
            new BridgeFixedInteractionPoint(31, 2, FixedInteractionPointKinds.ActionTile, "MinecartTransport"),
            new BridgeFixedInteractionPoint(2, 21, FixedInteractionPointKinds.TouchActionTile, "BuyBackpack"),
        });
    }

    /// <summary>
    /// The cap is STATED, never silent: the published array holds exactly the cap and
    /// <c>fixedInteractionPointsOmitted</c> counts the rest, so a truncated map cannot read as a complete one.
    ///
    /// The count is derived from the map this case writes, not typed: one more tile past the cap must move the
    /// omitted count by exactly one, which is what makes this a property rather than a pinned number.
    /// </summary>
    [Fact]
    public void TheCapIsStatedAndNothingIsLostUnexplained()
    {
        using FixedPointHarness harness = FixedPointHarness.Create();
        int placed = ExecutionManager.MaximumFixedInteractionPoints + 7;
        for (int index = 0; index < placed; index++)
        {
            int x = index % FixedPointHarness.Width;
            int y = index / FixedPointHarness.Width;
            harness.SetActionTile(x, y, "Shop");
        }

        IReadOnlyList<BridgeFixedInteractionPoint> points =
            ExecutionManager.DiscoverFixedInteractionPoints(harness.Actor, out int omitted);

        points.Should().HaveCount(ExecutionManager.MaximumFixedInteractionPoints);
        omitted.Should().Be(placed - ExecutionManager.MaximumFixedInteractionPoints);
        (points.Count + omitted).Should().Be(placed, "published plus stated-omitted is the whole map, by arithmetic");

        // Row-major, so the published set is the map's own first N and the dropped ones are strictly later.
        (int X, int Y) last = (points[^1].X, points[^1].Y);
        (last.Y, last.X).Should().Be((
            (ExecutionManager.MaximumFixedInteractionPoints - 1) / FixedPointHarness.Width,
            (ExecutionManager.MaximumFixedInteractionPoints - 1) % FixedPointHarness.Width),
            "the family is topology, so it is published in the map's own order and truncates at the end of it");

        harness.SetActionTile(placed % FixedPointHarness.Width, placed / FixedPointHarness.Width, "Shop");
        ExecutionManager.DiscoverFixedInteractionPoints(harness.Actor, out int omittedAfterOneMore);
        omittedAfterOneMore.Should().Be(omitted + 1, "one more point past the cap is one more stated omission");
    }

    /// <summary>
    /// The wire keeps a null <c>actionWord</c>.
    ///
    /// This is not decoration: the bridge's serializer drops null members
    /// (<c>BridgeProtocol.JsonOptions.DefaultIgnoreCondition = WhenWritingNull</c>) and the Host demands the exact key
    /// set <c>["x","y","kind","actionWord"]</c>, so a vanished member refuses the WHOLE snapshot on every mine level -
    /// the <c>invalid_snapshot:&lt;family&gt;</c> that has killed runs here before. The member is required by the wire
    /// schema for the same reason.
    /// </summary>
    [Fact]
    public void ANullActionWordStillReachesTheWire()
    {
        string json = JsonSerializer.Serialize(
            new BridgeFixedInteractionPoint(12, 9, FixedInteractionPointKinds.MineLadderUp, null),
            BridgeProtocol.JsonOptions);
        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement root = document.RootElement;

        root.EnumerateObject().Select(property => property.Name).Should().BeEquivalentTo(
            new[] { "x", "y", "kind", "actionWord" },
            "the Host validates this row with hasExactKeys over exactly these four names");
        root.GetProperty("actionWord").ValueKind.Should().Be(
            JsonValueKind.Null,
            "a mine ladder has no engine word, and the wire schema requires the member to be present with null rather "
            + "than absent");
        root.GetProperty("kind").GetString().Should().Be(FixedInteractionPointKinds.MineLadderUp);
    }

    /// <summary>The distance the entity families are bounded by, measured the way they measure it.</summary>
    private static int ChebyshevFrom(Farmer player, int x, int y) => Math.Max(
        Math.Abs(x - (int)player.Tile.X),
        Math.Abs(y - (int)player.Tile.Y));

    /// <summary>
    /// A real <see cref="GameLocation"/> with the two layers the engine's tile reads need, real tiles carrying real
    /// properties, and a real <see cref="Farmer"/> standing at a known tile.
    ///
    /// The map is deliberately larger than the discovery radius in both directions so every case can place its
    /// subject outside it: <c>Width</c> 40 and <c>Height</c> 24 put the far corner 37 tiles away.
    /// </summary>
    private sealed class FixedPointHarness : IDisposable
    {
        internal const int Width = 40;
        internal const int Height = 24;
        private const int PlayerX = 2;
        private const int PlayerY = 2;

        private readonly Dictionary<string, object?> staticsBefore;

        private FixedPointHarness()
        {
            this.staticsBefore = HeadlessGameWorld.CaptureStatics();
            this.Location = null!;
            this.Actor = null!;
            this.back = null!;
            this.buildings = null!;
            this.sheet = null!;
        }

        internal GameLocation Location;

        internal Farmer Actor;

        private xTile.Layers.Layer back;
        private xTile.Layers.Layer buildings;
        private xTile.Tiles.TileSheet sheet;

        internal static FixedPointHarness Create()
        {
            var harness = new FixedPointHarness();
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, root);
            // A world fixture owns the `Game1` singleton while it runs: reusing a leftover instance would write this
            // world's location book on somebody else's singleton, and `getLocationFromName` answers from that book for
            // every later class that reuses the name.
            Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));

            GameLocation location = new();
            var map = new xTile.Map();
            var size = new xTile.Dimensions.Size(Width, Height);
            var tileSize = new xTile.Dimensions.Size(64, 64);
            map.AddLayer(new xTile.Layers.Layer("Back", map, size, tileSize));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, size, tileSize));
            // The mine tile sheet by its engine id: `MineShaft.checkAction` filters the Buildings layer by "mine", so
            // a tile on any other sheet is deliberately invisible to that dispatch.
            var sheet = new xTile.Tiles.TileSheet("mine", map, "Maps/mine", tileSize, tileSize);
            map.AddTileSheet(sheet);
            location.map = map;
            SetField(location, "name", new NetString("ProbeMine"));

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            SetField(sprite, "spriteWidth", new NetInt(16));
            SetField(sprite, "spriteHeight", new NetInt(32));
            SetField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            actor.position.Set(new Vector2(PlayerX * 64 + 8, PlayerY * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            harness.Location = location;
            harness.Actor = actor;
            harness.back = map.GetLayer("Back");
            harness.buildings = map.GetLayer("Buildings");
            harness.sheet = sheet;
            return harness;
        }

        /// <summary>A tile on the Back layer carrying the engine's own <c>Water</c> property.</summary>
        internal void SetWater(int x, int y)
        {
            xTile.Tiles.Tile tile = this.NewTile(this.back, 0);
            tile.Properties["Water"] = "T";
            this.back.Tiles[x, y] = tile;
        }

        internal void SetActionTile(int x, int y, string action)
        {
            xTile.Tiles.Tile tile = this.NewTile(this.buildings, 0);
            tile.Properties["Action"] = action;
            this.buildings.Tiles[x, y] = tile;
        }

        internal void SetTouchActionTile(int x, int y, string touchAction)
        {
            xTile.Tiles.Tile tile = this.NewTile(this.back, 0);
            tile.Properties["TouchAction"] = touchAction;
            this.back.Tiles[x, y] = tile;
        }

        /// <summary>A Buildings-layer tile with the given index on the <c>mine</c> tile sheet, as a mine level carries it.</summary>
        internal void SetMineTile(int x, int y, int tileIndex) =>
            this.buildings.Tiles[x, y] = this.NewTile(this.buildings, tileIndex);

        /// <summary>
        /// A tile far enough from the actor that no entity radius reaches it, deterministic per index so two cases
        /// placing different indices never collide.
        /// </summary>
        internal (int X, int Y) FarCorner(int variant)
        {
            int x = Width - 1 - variant % 5;
            int y = Height - 1 - variant % 4;
            return (x, y);
        }

        private xTile.Tiles.Tile NewTile(xTile.Layers.Layer layer, int tileIndex) =>
            new xTile.Tiles.StaticTile(layer, this.sheet, xTile.Tiles.BlendMode.Alpha, tileIndex);

        public void Dispose()
        {
            HeadlessGameWorld.RestoreStatics(this.staticsBefore);
        }

        private static void SetField(object target, string name, object value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);
    }
}
