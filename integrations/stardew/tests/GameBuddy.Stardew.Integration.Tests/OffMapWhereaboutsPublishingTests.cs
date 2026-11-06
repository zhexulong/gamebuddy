using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The whole-map crop counts, as the Mod actually publishes them: a row for EVERY loaded map that has work, with a
/// coordinate only on the map the actor stands on.
///
/// <para>
/// The shipped defect: both discovery loops counted a location's crops and then discarded the row unless it also had a
/// nearest tile, and the nearest tile was computed only for the player's own map. So a companion standing in the
/// farmhouse read `wateringWhereabouts: []` while the farm outside was dry, and its fact line said "none on any map" -
/// the exact false negative the whole-map family exists to prevent. A count is a fact every loaded map can answer; the
/// nearest tile is a separate fact only one map can answer.
/// </para>
/// <para>
/// These cases drive the SHIPPED discovery through reflection against a real headless world
/// (<c>TargetFamilyCompletenessTests.TargetFamilyWorld</c>'s construction, including its content-free <c>Crop</c>), so
/// the predicates that decide what is dry and what is ripe are the engine's own. Nothing here re-implements the
/// projection, and the last case serialises the row with the Mod's own serializer to prove the pair is OMITTED rather
/// than written as null - which is what the Host validator and the wire schema both require.
/// </para>
/// </summary>
public sealed class OffMapWhereaboutsPublishingTests
{
    [Fact]
    public void ADryFarmIsReportedWhileTheCompanionStandsInTheFarmhouse()
    {
        using var world = WhereaboutsWorld.Create();
        world.PlaceDryCrop(world.Farm, x: 4, y: 9);
        world.PlaceDryCrop(world.Farm, x: 12, y: 20);
        world.StandIn(world.FarmHouse, x: 3, y: 5);

        IReadOnlyList<BridgeWateringWhereabouts> rows = world.Watering();

        rows.Should().ContainSingle("the farm is one of two loaded maps and it is the one with dry crops");
        rows[0].Location.Should().Be("ProbeFarm");
        rows[0].NeedsWaterCount.Should().Be(2, "the count is the whole map's, not a radius scan");
        // The defect: this row was dropped entirely, so the companion read "nothing needs water on any map".
        rows[0].NearestX.Should().BeNull("a tile on another map is not an address the companion can walk to");
        rows[0].NearestY.Should().BeNull();
    }

    [Fact]
    public void TheNearestDryCropOnThePlayersOwnMapKeepsItsTile()
    {
        using var world = WhereaboutsWorld.Create();
        world.PlaceDryCrop(world.Farm, x: 9, y: 9);
        world.PlaceDryCrop(world.Farm, x: 4, y: 4);
        world.StandIn(world.Farm, x: 5, y: 4);

        BridgeWateringWhereabouts row = world.Watering().Should().ContainSingle().Subject;

        row.Location.Should().Be("ProbeFarm");
        row.NeedsWaterCount.Should().Be(2);
        row.NearestX.Should().Be(4, "the nearest tile is the fact that makes the count actionable");
        row.NearestY.Should().Be(4);
    }

    [Fact]
    public void ARipeFarmIsReportedWhileTheCompanionStandsInTheFarmhouse()
    {
        using var world = WhereaboutsWorld.Create();
        world.PlaceRipeCrop(world.Farm, x: 7, y: 2);
        world.StandIn(world.FarmHouse, x: 3, y: 5);

        IReadOnlyList<BridgeHarvestWhereabouts> rows = world.Harvest();

        rows.Should().ContainSingle("the harvest family has the same shape and had the same defect");
        rows[0].Location.Should().Be("ProbeFarm");
        rows[0].ReadyForHarvestCount.Should().Be(1);
        rows[0].NearestX.Should().BeNull("a ripe crop on another map is a plan, not a place");
        rows[0].NearestY.Should().BeNull();
    }

    [Fact]
    public void TheNearestRipeCropOnThePlayersOwnMapKeepsItsTile()
    {
        using var world = WhereaboutsWorld.Create();
        world.PlaceRipeCrop(world.Farm, x: 9, y: 9);
        world.PlaceRipeCrop(world.Farm, x: 4, y: 4);
        world.StandIn(world.Farm, x: 5, y: 4);

        BridgeHarvestWhereabouts row = world.Harvest().Should().ContainSingle().Subject;

        row.ReadyForHarvestCount.Should().Be(2);
        row.NearestX.Should().Be(4);
        row.NearestY.Should().Be(4);
    }

    [Fact]
    public void AnOffMapRowIsSerialisedWithoutItsCoordinateKeys()
    {
        // ABSENT, not null. The Host refuses a `nearestX: null` (its predicate demands a tile when the key is there) and
        // the wire schema makes the pair both-or-neither, so a null written onto the wire would close the bridge on the
        // companion's first snapshot taken indoors. The serializer's own output is the authority this asserts against.
        using var world = WhereaboutsWorld.Create();
        world.PlaceDryCrop(world.Farm, x: 4, y: 9);
        world.PlaceRipeCrop(world.Farm, x: 7, y: 2);
        world.StandIn(world.FarmHouse, x: 3, y: 5);

        string watering = JsonSerializer.Serialize(world.Watering()[0], BridgeProtocol.JsonOptions);
        string harvest = JsonSerializer.Serialize(world.Harvest()[0], BridgeProtocol.JsonOptions);

        watering.Should().Be("{\"location\":\"ProbeFarm\",\"needsWaterCount\":1}");
        harvest.Should().Be("{\"location\":\"ProbeFarm\",\"readyForHarvestCount\":1}");
    }

    /// <summary>
    /// Two real locations, a real farmer, and a content-free <c>Crop</c> - the <c>TargetFamilyWorld</c> construction,
    /// reduced to what these two discovery methods read (<c>Game1.locations</c>, the actor's tile and current location,
    /// and each location's <c>terrainFeatures</c>).
    /// </summary>
    private sealed class WhereaboutsWorld : IDisposable
    {
        private const long ActorId = 1001;

        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;
        private readonly IList<GameLocation>? locationsBefore;

        private WhereaboutsWorld()
        {
            this.gameBefore = Game1.game1;
            this.playerBefore = Game1.player;
            this.worldStateBefore = typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.GetValue(null);
            this.locationsBefore = Game1.game1?._locations;
        }

        internal GameLocation Farm { get; private set; } = null!;

        internal GameLocation FarmHouse { get; private set; } = null!;

        internal Farmer Actor { get; private set; } = null!;

        internal static WhereaboutsWorld Create()
        {
            var world = new WhereaboutsWorld();

            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, root);
            // `Crop`'s own data lookup reads `Game1.cropData` (Data/Crops), which a process without content never loads. An
            // EMPTY dictionary is honest: every crop then takes the engine's documented default harvest method (Grab), so
            // the shipped predicates decide.
            Game1.cropData ??= new Dictionary<string, StardewValley.GameData.Crops.CropData>(StringComparer.Ordinal);

            world.Farm = NewLocation("ProbeFarm");
            world.FarmHouse = NewLocation("ProbeFarmHouse");
            // The two maps the loading order would have hidden: an EMPTY farmhouse listed beside the dry farm. Before the
            // fix the farmhouse's own (zero-crop) row replaced nothing, and the farm's row was dropped for having no tile.
            Game1.game1!._locations = new List<GameLocation> { world.FarmHouse, world.Farm };

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetInstanceField(actor, "position", new NetPosition());
            SetInstanceField(actor, "currentLocationRef", new NetLocationRef());
            SetInstanceField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            // `Farmer.Tile` goes through `GetBoundingBox()` -> `Sprite`, exactly as the real game does, so the farmer needs
            // a sprite with a size rather than a hand-written tile.
            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            SetInstanceField(sprite, "spriteWidth", new NetInt(16));
            SetInstanceField(sprite, "spriteHeight", new NetInt(32));
            SetInstanceField(sprite, "tempSpriteHeight", -1);
            SetInstanceField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            actor.position.Set(new Vector2(3 * 64 + 8, 5 * 64));
            actor.currentLocation = world.FarmHouse;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);
            world.Actor = actor;

            return world;
        }

        internal void StandIn(GameLocation location, int x, int y)
        {
            this.Actor.currentLocation = location;
            this.Actor.position.Set(new Vector2(x * 64 + 8, y * 64));
        }

        internal void PlaceDryCrop(GameLocation location, int x, int y) =>
            location.terrainFeatures[new Vector2(x, y)] = Dirt(fullyGrown: false);

        internal void PlaceRipeCrop(GameLocation location, int x, int y) =>
            location.terrainFeatures[new Vector2(x, y)] = Dirt(fullyGrown: true);

        internal IReadOnlyList<BridgeWateringWhereabouts> Watering() =>
            (IReadOnlyList<BridgeWateringWhereabouts>)Discover("DiscoverWateringWhereabouts");

        internal IReadOnlyList<BridgeHarvestWhereabouts> Harvest() =>
            (IReadOnlyList<BridgeHarvestWhereabouts>)Discover("DiscoverHarvestWhereabouts");

        private static object Discover(string name)
        {
            MethodInfo method = typeof(ExecutionManager).GetMethod(
                name,
                BindingFlags.NonPublic | BindingFlags.Static)!;
            return method.Invoke(null, null)!;
        }

        private static GameLocation NewLocation(string name)
        {
            var location = new GameLocation();
            SetInstanceField(location, "name", new NetString(name));
            return location;
        }

        /// <summary>
        /// A hoedirt tile whose crop is in the state the two engine predicates read.
        ///
        /// <c>HoeDirt.needsWatering()</c> asks the tile's own <c>state</c>; <c>HoeDirt.readyForHarvest()</c> is
        /// <c>currentPhase &gt;= phaseDays.Count - 1</c> with a live <c>dead</c> flag, so the phase list and the current
        /// phase decide ripeness - never a flag this method writes.
        /// </summary>
        private static StardewValley.TerrainFeatures.HoeDirt Dirt(bool fullyGrown)
        {
            var dirt = new StardewValley.TerrainFeatures.HoeDirt();
            SetInstanceField(dirt, "state", new NetInt(0));
            dirt.crop = NewCrop(fullyGrown);
            return dirt;
        }

        private static StardewValley.Crop NewCrop(bool fullyGrown)
        {
            var crop = (StardewValley.Crop)FormatterServices.GetUninitializedObject(typeof(StardewValley.Crop));
            SetInstanceField(crop, "netSeedIndex", new NetString("472"));
            SetInstanceField(crop, "indexOfHarvest", new NetString("24"));
            SetInstanceField(crop, "overrideTexturePath", new NetString(null));
            SetInstanceField(crop, "rowInSpriteSheet", new NetInt(0));
            SetInstanceField(crop, "fullyGrown", new NetBool(fullyGrown));
            SetInstanceField(crop, "forageCrop", new NetBool(false));
            SetInstanceField(crop, "dead", new NetBool(false));
            SetInstanceField(crop, "dayOfCurrentPhase", new NetInt(0));
            var phases = new NetIntList();
            for (int index = 0; index < 5; index++) phases.Add(1);
            SetInstanceField(crop, "phaseDays", phases);
            SetInstanceField(crop, "currentPhase", new NetInt(fullyGrown ? 4 : 1));
            return crop;
        }

        private static void SetInstanceField(object target, string name, object? value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);

        public void Dispose()
        {
            Game1.game1!._locations = this.locationsBefore!;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, this.playerBefore);
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, this.worldStateBefore);
            Game1.game1 = this.gameBefore!;
        }
    }
}
