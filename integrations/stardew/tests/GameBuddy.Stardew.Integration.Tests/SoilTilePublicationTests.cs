using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// What the actor's own neighbourhood says about the soil it is standing in.
///
/// <para>
/// Measured 2026-11-06 on the clear-and-plant run: across 64 <c>stardew_observe</c> results the published
/// <c>soilTiles</c> array had min 0, median 2, max 32 rows, while the companion was asked to clear and plant a
/// 3x20 patch. The actor explained the consequence herself: "I don't have the whole patch map... every 3-4 tiles
/// I observed again, and inferred the tiles I had already tilled from 'this list no longer has it'."
/// </para>
///
/// <para>
/// The rows were dropped by <c>ExecutionManager.DiscoverSoilTiles</c> in two places, and these cases are one per
/// place. (1) A tile carrying a <c>HoeDirt</c> was skipped outright, so tilling a tile REMOVED it from the list:
/// the one state a plan most needs to see, and the one it had to infer. (2) The cap was <c>32</c> while the Host
/// and the wire schema admit <c>64</c>, and it truncated silently, so a patch larger than the cap read as complete.
/// </para>
///
/// <para>
/// The counts below are derived, never typed: the in-radius population comes from the map this file writes, the
/// bound comes from <see cref="ExecutionManager.MaximumDiscoveredSoilTiles"/>, and the radius comes from
/// <see cref="ExecutionManager.TargetDiscoveryRadius"/>. A case that hard-coded 39 rows would pass the day the
/// radius changed for a reason.
/// </para>
/// </summary>
public sealed class SoilTilePublicationTests
{
    /// <summary>
    /// The defect, as a case: 60 tiles the actor has already tilled, all inside the discovery radius, and the
    /// snapshot publishes none of them.
    ///
    /// This is the shape the companion described. She tills a tile, the next observation no longer lists it, and
    /// nothing in the payload distinguishes "tilled" from "gone". Every row carries <c>hoeDirt</c> for exactly this
    /// reason - before this fix the flag was computed and then always false, because the tilled row never survived
    /// the filter long enough to carry it.
    /// </summary>
    [Fact]
    public void TilledTilesInsideTheRadiusArePublishedWithTheirState()
    {
        using SoilHarness harness = SoilHarness.Create();
        var tilled = new List<(int X, int Y)>();
        for (int x = 7; x < 17; x++)
            for (int y = 7; y < 13; y++)
            {
                harness.PlaceHoeDirt(x, y);
                tilled.Add((x, y));
            }

        IReadOnlyList<BridgeSoilTile> published = ExecutionManager.DiscoverSoilTiles(harness.Actor, out int omitted);

        tilled.Should().HaveCount(60, "the fixture is the measured case: sixty tilled tiles");
        foreach ((int x, int y) in tilled)
            SoilHarness.ChebyshevFrom(harness.Actor, x, y).Should().BeLessThanOrEqualTo(
                ExecutionManager.TargetDiscoveryRadius,
                "this case only proves anything while every tilled tile is inside the radius the actor scans");

        published.Select(row => (row.X, row.Y)).Should().BeEquivalentTo(
            tilled,
            "a tile the actor has tilled is a soil tile the next plan must see: dropping it left the companion "
            + "inferring her own work from the list's silence");
        published.Should().OnlyContain(row => row.HoeDirt, "each row states which of the two states the tile is in");
        omitted.Should().Be(0, "sixty tiles fit inside the bound, so nothing was truncated");
    }

    /// <summary>
    /// The patch the companion was actually given: three rows by twenty columns of tillable ground, the actor
    /// standing in the middle of it.
    ///
    /// The radius, not a cap, is what bounds this case - a 13x13 neighbourhood cannot hold a row of twenty - so the
    /// assertion is that EVERY patch tile inside the radius is published, and that the bound truncated nothing
    /// (<c>omitted: 0</c>). A 32-row cap failed here with seven tiles missing and no way for the reader to tell.
    /// </summary>
    [Fact]
    public void AThreeByTwentyPatchPublishesEveryTileInsideTheRadius()
    {
        using SoilHarness harness = SoilHarness.Create();
        var patch = new List<(int X, int Y)>();
        for (int x = 2; x < 22; x++)
            for (int y = 8; y < 11; y++)
            {
                harness.SetDiggable(x, y);
                patch.Add((x, y));
            }

        int[] reachable = patch
            .Where(tile => SoilHarness.ChebyshevFrom(harness.Actor, tile.X, tile.Y) <= ExecutionManager.TargetDiscoveryRadius)
            .Select(tile => tile.Y * SoilHarness.Width + tile.X)
            .OrderBy(tile => tile)
            .ToArray();
        reachable.Should().HaveCountLessThan(
            patch.Count,
            "twenty tiles across cannot all fit in the actor's window, which is why the radius bounds this case");
        reachable.Should().HaveCountGreaterThan(
            32,
            "thirty-two was the cap this case was written against: a list that stops there is seven tiles short of "
            + "the ground under the actor, and the reader could not tell");

        IReadOnlyList<BridgeSoilTile> published = ExecutionManager.DiscoverSoilTiles(harness.Actor, out int omitted);

        published.Select(row => row.Y * SoilHarness.Width + row.X).OrderBy(tile => tile).Should().Equal(
            reachable,
            "every tillable tile the actor can walk to is a row the plan can name");
        omitted.Should().Be(0, "the reachable patch fits inside the bound, so the bound took nothing");
        published.Should().OnlyContain(row => !row.HoeDirt, "none of these tiles has been tilled yet");
    }

    /// <summary>
    /// Tilling a tile does not remove it from the next observation.
    ///
    /// This is the same list read twice with a real change between the reads: the tile the actor just hoed stays,
    /// and only its <c>hoeDirt</c> flips. That is the fact the companion had to infer, and inferring it is what
    /// made her re-obsess every three or four tiles.
    /// </summary>
    [Fact]
    public void ATileSurvivesBeingTilledAndOnlyItsStateChanges()
    {
        using SoilHarness harness = SoilHarness.Create();
        for (int x = 2; x < 22; x++)
            for (int y = 8; y < 11; y++)
                harness.SetDiggable(x, y);

        IReadOnlyList<BridgeSoilTile> before = ExecutionManager.DiscoverSoilTiles(harness.Actor, out _);
        var tilled = before.Take(15).Select(row => (row.X, row.Y)).ToArray();
        foreach ((int x, int y) in tilled)
            harness.PlaceHoeDirt(x, y);
        IReadOnlyList<BridgeSoilTile> after = ExecutionManager.DiscoverSoilTiles(harness.Actor, out _);

        after.Select(row => (row.X, row.Y)).Should().Equal(
            before.Select(row => (row.X, row.Y)),
            "tilling fifteen tiles must not move or shorten the list: the same ground is still under the actor");
        after.Count(row => row.HoeDirt).Should().Be(
            tilled.Length,
            "the fifteen hoed tiles report their state instead of disappearing from it");
        before.Should().OnlyContain(row => !row.HoeDirt, "the first read happened before anything was tilled");
    }

    /// <summary>
    /// A neighbourhood larger than the bound is TRUNCATED AND STATED.
    ///
    /// The whole 13x13 window is tillable, so the published list is the bound and <c>omitted</c> is the rest.
    /// The arithmetic is the assertion - published plus stated-omitted is the in-radius population - because that
    /// is what makes a truncated list honest, and it is the property a cap cannot satisfy while staying silent.
    /// </summary>
    [Fact]
    public void ANeighbourhoodLargerThanTheBoundStatesWhatTheCapLeftOut()
    {
        using SoilHarness harness = SoilHarness.Create();
        int radius = ExecutionManager.TargetDiscoveryRadius;
        var window = new List<(int X, int Y)>();
        for (int x = SoilHarness.ActorX - radius; x <= SoilHarness.ActorX + radius; x++)
            for (int y = SoilHarness.ActorY - radius; y <= SoilHarness.ActorY + radius; y++)
            {
                harness.SetDiggable(x, y);
                window.Add((x, y));
            }

        IReadOnlyList<BridgeSoilTile> published = ExecutionManager.DiscoverSoilTiles(harness.Actor, out int omitted);

        window.Should().HaveCount(
            (2 * radius + 1) * (2 * radius + 1),
            "the fixture fills the whole neighbourhood the scan looks at");
        published.Should().HaveCount(ExecutionManager.MaximumDiscoveredSoilTiles);
        (published.Count + omitted).Should().Be(
            window.Count,
            "published plus stated-omitted is the whole in-radius population, so nothing is lost unexplained");
        published.Select(row => SoilHarness.ChebyshevFrom(harness.Actor, row.X, row.Y))
            .Should()
            .BeInAscendingOrder("the bound keeps the nearest, so every dropped tile is strictly farther than every kept one");

        // One tile fewer inside the window moves the stated omission by exactly one: the count is measured from
        // this map, not typed.
        (int droppedX, int droppedY) = window[^1];
        harness.SetNotDiggable(droppedX, droppedY);
        ExecutionManager.DiscoverSoilTiles(harness.Actor, out int omittedAfterOneFewer);
        omittedAfterOneFewer.Should().Be(omitted - 1, "one fewer tillable tile inside the radius is one fewer omission");
    }

    /// <summary>
    /// The Mod's cap is the number of rows the wire admits - read from the schema, never typed here.
    ///
    /// The bound is one fact owned by two layers: the Mod decides how many soil rows to publish and the Host
    /// rejects a snapshot with more than <c>maxItems</c> of them. A Mod cap below the admitted number spends that
    /// headroom for nothing, and a cap above it turns a big patch into <c>invalid_snapshot</c> for the whole
    /// observation. Measured before this fix: the Mod published 32 while the schema admitted 64.
    /// </summary>
    [Fact]
    public void TheSoilCapIsTheNumberOfRowsTheWireAdmits()
    {
        using JsonDocument schema = JsonDocument.Parse(File.ReadAllText(RepositoryFile("protocol/bridge-v1.schema.json")));
        JsonElement family = schema.RootElement.GetProperty("$defs").GetProperty("snapshot").GetProperty("properties")
            .GetProperty("soilTiles");

        family.GetProperty("maxItems").GetInt32().Should().Be(
            ExecutionManager.MaximumDiscoveredSoilTiles,
            "the Mod's bound and the wire's bound are one fact: a Mod list longer than maxItems refuses the whole "
            + "snapshot, and a shorter one hides tiles the wire was willing to carry");
    }

    /// <summary>The repository root, found the way the other source-reading cases find it.</summary>
    private static string RepositoryFile(string relative)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "integrations")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the test must run inside the repository");
        return Path.Combine(directory!.FullName, relative);
    }

    /// <summary>
    /// A real <see cref="GameLocation"/> with the Back layer the engine's tile reads need, a real
    /// <see cref="Farmer"/> standing at a known tile, and real HoeDirt terrain features.
    ///
    /// The map is larger than the discovery window in both directions so a case can place soil outside the radius
    /// and watch it stay out: <c>Width</c> 24 and <c>Height</c> 20 put the actor's window at x/y -6..+6.
    /// </summary>
    private sealed class SoilHarness : IDisposable
    {
        internal const int Width = 24;
        internal const int Height = 20;
        internal const int ActorX = 12;
        internal const int ActorY = 10;

        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;

        private SoilHarness()
        {
            this.gameBefore = Game1.game1;
            this.playerBefore = Game1.player;
            this.worldStateBefore = typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .GetValue(null);
            this.Location = null!;
            this.Actor = null!;
            this.back = null!;
            this.sheet = null!;
        }

        internal GameLocation Location;

        internal Farmer Actor;

        private xTile.Layers.Layer back;
        private xTile.Tiles.TileSheet sheet;

        internal static SoilHarness Create()
        {
            var harness = new SoilHarness();
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, root);
            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));

            GameLocation location = new();
            var map = new xTile.Map();
            var size = new xTile.Dimensions.Size(Width, Height);
            var tileSize = new xTile.Dimensions.Size(64, 64);
            map.AddLayer(new xTile.Layers.Layer("Back", map, size, tileSize));
            // `GameLocation.isTileLocationOpen` requires it (`FrameworkExtensions.RequireLayer`, GameLocation.cs:7763):
            // a farm map declares both, and the discovery asks the engine whether a tile is free before offering it.
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, size, tileSize));
            map.AddLayer(new xTile.Layers.Layer("Front", map, size, tileSize));
            // The farm's own outdoor sheet: `doesTileHaveProperty(x, y, "Diggable", "Back")` reads the Back layer,
            // which is where a real farm map declares the property these cases place.
            var sheet = new xTile.Tiles.TileSheet("spring", map, "Maps/spring_outdoorsTileSheet", tileSize, tileSize);
            map.AddTileSheet(sheet);
            location.map = map;
            SetField(location, "name", new NetString("ProbeSoil"));

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            SetField(sprite, "spriteWidth", new NetInt(16));
            SetField(sprite, "spriteHeight", new NetInt(32));
            SetField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            actor.position.Set(new Vector2(ActorX * 64 + 8, ActorY * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            harness.Location = location;
            harness.Actor = actor;
            harness.back = map.GetLayer("Back");
            harness.sheet = sheet;
            return harness;
        }

        /// <summary>A Back-layer tile carrying the engine's own <c>Diggable</c> property.</summary>
        internal void SetDiggable(int x, int y)
        {
            xTile.Tiles.Tile tile = this.NewTile();
            tile.Properties["Diggable"] = "T";
            this.back.Tiles[x, y] = tile;
        }

        /// <summary>The same tile without the property: ground the Hoe refuses.</summary>
        internal void SetNotDiggable(int x, int y) => this.back.Tiles[x, y] = this.NewTile();

        /// <summary>
        /// A hoedirt tile with no crop, built the way `TargetFamilyCompletenessTests` builds one: `HoeDirt`'s own
        /// <c>state</c> NetField is what <c>HoeDirt.cs</c> reads, and <c>crop</c> is a plain field.
        /// </summary>
        internal void PlaceHoeDirt(int x, int y)
        {
            var dirt = new StardewValley.TerrainFeatures.HoeDirt();
            SetField(dirt, "state", new NetInt(0));
            this.Location.terrainFeatures[new Vector2(x, y)] = dirt;
        }

        internal static int ChebyshevFrom(Farmer player, int x, int y) =>
            Math.Max(Math.Abs(x - (int)player.Tile.X), Math.Abs(y - (int)player.Tile.Y));

        private xTile.Tiles.Tile NewTile() =>
            new xTile.Tiles.StaticTile(this.back, this.sheet, xTile.Tiles.BlendMode.Alpha, 0);

        public void Dispose()
        {
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, this.playerBefore);
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, this.worldStateBefore);
            if (this.gameBefore is null) Game1.game1 = null!;
        }

        private static void SetField(object target, string name, object value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);
    }
}
