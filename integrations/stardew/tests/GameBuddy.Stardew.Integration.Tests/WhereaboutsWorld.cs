using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.Serialization;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Two real locations, a real farmer, and a content-free <c>Crop</c> - the <c>TargetFamilyWorld</c> construction,
/// reduced to what the two whereabouts discovery methods read (<c>Game1.locations</c>, the actor's tile and current
/// location, and each location's <c>terrainFeatures</c>).
///
/// <para>
/// Shared by the suites that drive <c>DiscoverWateringWhereabouts</c> / <c>DiscoverHarvestWhereabouts</c> through the
/// SHIPPED discovery, so what those suites assert is the projection the Mod publishes rather than a re-implementation
/// of it. The tile it hands out is a real <c>HoeDirt</c> with a real <c>Crop</c>, which is what makes the engine's own
/// predicates (<c>needsWatering</c>, <c>isWatered</c>, <c>readyForHarvest</c>) the deciders.
/// </para>
/// </summary>
internal sealed class WhereaboutsWorld : IDisposable
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

    /// <summary>The recorder the shipped discovery writes into, one per world.</summary>
    internal DiscoveryExclusionRecorder Exclusions { get; } = new();

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

    /// <summary>
    /// A crop the season change killed: <c>Crop.dead</c> is the flag <c>Crop.harvest</c> refuses, and the whole-map
    /// counts read it before they read any growth stage.
    /// </summary>
    internal void PlaceDeadCrop(GameLocation location, int x, int y) =>
        location.terrainFeatures[new Vector2(x, y)] = Dirt(fullyGrown: true, dead: true);

    /// <summary>A hoed tile with no crop on it: the tile exists, the family's subject does not.</summary>
    internal void PlaceEmptyHoeDirt(GameLocation location, int x, int y)
    {
        var dirt = new StardewValley.TerrainFeatures.HoeDirt();
        SetInstanceField(dirt, "state", new NetInt(0));
        location.terrainFeatures[new Vector2(x, y)] = dirt;
    }

    /// <summary>
    /// The tile's own state as the native Watering Can leaves it: <c>HoeDirt.performToolAction</c> writes
    /// <c>state.Value = 1</c> for a watered tile (<c>HoeDirt.cs:702</c>, and the day-update rain pass at
    /// <c>HoeDirt.cs:932</c>). Nothing else about the tile changes, which is exactly why the dry-count must read it.
    /// </summary>
    internal void Water(GameLocation location, int x, int y) =>
        ((StardewValley.TerrainFeatures.HoeDirt)location.terrainFeatures[new Vector2(x, y)]).state.Value = 1;

    /// <summary>The same field back to dry, so a suite can show the count follows the tile both ways.</summary>
    internal void Dry(GameLocation location, int x, int y) =>
        ((StardewValley.TerrainFeatures.HoeDirt)location.terrainFeatures[new Vector2(x, y)]).state.Value = 0;

    internal IReadOnlyList<BridgeWateringWhereabouts> Watering() =>
        (IReadOnlyList<BridgeWateringWhereabouts>)Discover("DiscoverWateringWhereabouts");

    internal IReadOnlyList<BridgeHarvestWhereabouts> Harvest() =>
        (IReadOnlyList<BridgeHarvestWhereabouts>)Discover("DiscoverHarvestWhereabouts");

    /// <summary>
    /// What the same walk told the recorder it WITHHELD, in the wire order the snapshot publishes. Read from the one
    /// recorder the shipped discovery writes into, so the rows are the Mod's own answer rather than a re-derivation.
    /// </summary>
    internal IReadOnlyList<BridgeDiscoveryExclusion> ExclusionRows() => this.Exclusions.Publish(out _);

    private object Discover(string name)
    {
        MethodInfo method = typeof(ExecutionManager).GetMethod(
            name,
            BindingFlags.NonPublic | BindingFlags.Static)!;
        return method.Invoke(null, new object[] { this.Exclusions })!;
    }

    private static GameLocation NewLocation(string name)
    {
        var location = new GameLocation();
        SetInstanceField(location, "name", new NetString(name));
        return location;
    }

    /// <summary>
    /// A hoedirt tile whose crop is in the state the engine predicates read.
    ///
    /// <c>HoeDirt.readyForHarvest()</c> is <c>currentPhase &gt;= phaseDays.Count - 1</c> with a live <c>dead</c>
    /// flag, so the phase list and the current phase decide ripeness - never a flag this method writes.
    /// <c>HoeDirt.needsWatering()</c> asks the CROP's data (whether this kind of crop wants water at all), not the
    /// tile's <c>state</c>: water is the tile's own <c>state</c> field, which <see cref="Water"/> sets.
    /// </summary>
    private static StardewValley.TerrainFeatures.HoeDirt Dirt(bool fullyGrown, bool dead = false)
    {
        var dirt = new StardewValley.TerrainFeatures.HoeDirt();
        SetInstanceField(dirt, "state", new NetInt(0));
        dirt.crop = NewCrop(fullyGrown, dead);
        return dirt;
    }

    private static StardewValley.Crop NewCrop(bool fullyGrown, bool dead = false)
    {
        var crop = (StardewValley.Crop)FormatterServices.GetUninitializedObject(typeof(StardewValley.Crop));
        SetInstanceField(crop, "netSeedIndex", new NetString("472"));
        SetInstanceField(crop, "indexOfHarvest", new NetString("24"));
        SetInstanceField(crop, "overrideTexturePath", new NetString(null));
        SetInstanceField(crop, "rowInSpriteSheet", new NetInt(0));
        SetInstanceField(crop, "fullyGrown", new NetBool(fullyGrown));
        SetInstanceField(crop, "forageCrop", new NetBool(false));
        SetInstanceField(crop, "dead", new NetBool(dead));
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
