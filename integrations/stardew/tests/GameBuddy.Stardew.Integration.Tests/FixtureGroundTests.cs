using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// What a fixture may call soil, against a real <see cref="Farm"/> whose tiles really are paved or really are field.
///
/// <para>
/// MEASURED `round98` (2026-11-23): `SpreadDirt` + `SpreadSeeds 474` + `GrowCrops 12` grew a ripe cauliflower on
/// <c>29,17</c> - the bottom-right tile of the greenhouse's 3x2 stone doorstep (greenhouse at <c>25,10</c>, 7x6,
/// humanDoor <c>3,5</c>, read off the run's own save) - and the play-session crop prop put its own <c>HoeDirt</c> there
/// one layer down. The companion harvested it (<c>plan_506</c>) and sowed seed on the bare dirt it left
/// (<c>plan_507</c>), because the world told her it was empty tilled ground. The world was telling the truth about a
/// lie the fixture had built.
/// </para>
///
/// <para>
/// The predicate is the map's, so it is tested against a map: a <c>Buildings</c>-layer tile, a <c>Back</c> tile carrying
/// <c>Type=Stone</c>/<c>Wood</c>, a field tile carrying <c>Diggable</c> only, and the greenhouse's own answer for the
/// porch it paints at runtime.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
[Trait("kind", "fixture-ground")]
public sealed class FixtureGroundTests : IDisposable
{
    private const BindingFlags AnyInstance = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
    private const string RepositoryRelativeRoot = "../../../../../../../";

    private readonly Dictionary<string, object?> statics = HeadlessGameWorld.CaptureStatics();
    private readonly object? buildingData =
        typeof(Game1).GetField("buildingData", BindingFlags.Public | BindingFlags.Static)!.GetValue(null);

    public void Dispose()
    {
        typeof(Game1).GetField("buildingData", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, this.buildingData);
        HeadlessGameWorld.RestoreStatics(this.statics);
    }

    /// <summary>
    /// The report exists because the next run's log has to answer "did the porch stay bare". A tile is only cleared when
    /// it is paved AND tilled; the field tile in this world keeps its dirt and its crop, which is the half of the rule the
    /// owner named first.
    /// </summary>
    [Fact]
    public void AFieldTileKeepsItsDirtAndItsCrop()
    {
        Farm farm = BuildFarm();
        MakePavedOrFieldTile(farm, 4, 4, type: null);
        StardewValley.TerrainFeatures.HoeDirt dirt = Till(farm, 4, 4);
        Crop crop = AttachCrop(dirt);

        string line = FixtureGround.ClearPavedDirt(farm);

        farm.terrainFeatures.ContainsKey(new Vector2(4, 4)).Should().BeTrue("ordinary yard ground is not this predicate's business");
        dirt.crop.Should().BeSameAs(crop, "a field crop is what the day's work is about");
        line.Should().Contain($"{FixtureGround.ClearedLogPrefix}: tiles=0;crops_removed=0;predicate=none");
    }

    /// <summary>
    /// THE ROUND98 TILE. <c>29,17</c> is the bottom-right tile of the doorstep <c>GreenhouseBuilding.DrawEntranceTiles</c>
    /// paints (columns <c>tileX + humanDoor.X - 1 .. +1</c>, rows <c>tileY + humanDoor.Y + 1 .. +2</c>), and it is that
    /// building - not the map - that answers <c>Type = Stone</c> for it.
    /// </summary>
    [Fact]
    public void TheGreenhouseStoneDoorstepLosesItsCropAndThenItsDirt()
    {
        Farm farm = BuildFarm();
        Greenhouse(farm);
        StardewValley.TerrainFeatures.HoeDirt dirt = Till(farm, 29, 17);
        Crop crop = AttachCrop(dirt);

        string line = FixtureGround.ClearPavedDirt(farm);

        farm.terrainFeatures.ContainsKey(new Vector2(29, 17)).Should().BeFalse("the doorstep is paved ground, not soil");
        dirt.crop.Should().BeNull("the crop is DETACHED from the dirt before the dirt is removed, never left living on nothing");
        crop.Should().NotBeNull();
        line.Should().Contain("tiles=1;crops_removed=1;predicate=building_type:Stone@Greenhouse=1");
        line.Should().Contain("cleared=29,17");
    }

    /// <summary>
    /// WHY EVERY PREDICATE BEFORE THIS ONE MISSED THE PORCH, as one assertion: the LOCATION-level lookup never asks the
    /// greenhouse about this tile. <c>GameLocation.doesTileHaveProperty</c> only consults a building while
    /// <c>occupiesTile(tile, applyTilePropertyRadius: true)</c> covers it, and that rectangle is the footprint (rows
    /// 10..15) inflated by the building's <c>AdditionalTilePropertyRadius</c> - so the porch's second row (17) is two rows
    /// below it. Asking the BUILDING is what names the porch, and that is what <see cref="FixtureGround"/> does.
    /// </summary>
    [Fact]
    public void TheLocationLookupCannotSeeTheDoorstepsSecondRowAndTheBuildingCan()
    {
        Farm farm = BuildFarm();
        Greenhouse(farm);

        farm.doesTileHaveProperty(29, 16, "Type", "Back").Should().BeNull(
            "the map's Back tile under the doorstep is field ground and the location lookup stops at the footprint");
        FixtureGround.DescribePaving(farm, 29, 16).Should().Be("building_type:Stone@Greenhouse");
        FixtureGround.DescribePaving(farm, 29, 17).Should().Be("building_type:Stone@Greenhouse");
        FixtureGround.DescribePaving(farm, 26, 17).Should().BeNull("columns 27..29 are the doorstep; 26 is the field beside it");
    }

    /// <summary>
    /// The two routes the owner named, each against the tile that carries it: a <c>Back</c> tile whose own data says
    /// <c>Type = Wood</c> (the wooden deck at a house door) and a tile with a <c>Buildings</c>-layer tile on it (built
    /// ground). The field tile between them keeps its dirt.
    /// </summary>
    [Fact]
    public void AWoodenDeckAndABuiltOnTileAreClearedAndTheFieldBetweenThemIsNot()
    {
        Farm farm = BuildFarm();
        MakePavedOrFieldTile(farm, 2, 2, type: "Wood");
        MakeBuiltOnTile(farm, 3, 2);
        MakePavedOrFieldTile(farm, 4, 2, type: null);
        Till(farm, 2, 2);
        Till(farm, 3, 2);
        Till(farm, 4, 2);

        string line = FixtureGround.ClearPavedDirt(farm);

        farm.terrainFeatures.ContainsKey(new Vector2(2, 2)).Should().BeFalse("a wooden deck is paved, not soil");
        farm.terrainFeatures.ContainsKey(new Vector2(3, 2)).Should().BeFalse("a Buildings-layer tile is built ground, not soil");
        farm.terrainFeatures.ContainsKey(new Vector2(4, 2)).Should().BeTrue("a field tile is untouched");
        line.Should().Contain("tiles=2;crops_removed=0");
        line.Should().Contain("back_type:Wood=1");
        line.Should().Contain("buildings_layer=1");
    }

    /// <summary>
    /// A fixture that HAND-MAKES dirt asks this first, and a paved tile is refused by name rather than by a silent world.
    /// </summary>
    [Fact]
    public void HandMadeDirtOnPavedGroundIsRefusedByName()
    {
        Farm farm = BuildFarm();
        Greenhouse(farm);
        MakePavedOrFieldTile(farm, 4, 4, type: null);

        Action onTheDoorstep = () => FixtureGround.RequireSoil(farm, 29, 17);
        Action onTheField = () => FixtureGround.RequireSoil(farm, 4, 4);

        onTheDoorstep.Should().Throw<InvalidOperationException>()
            .WithMessage($"{FixtureGround.NotSoilRefusal}:29,17:building_type:Stone@Greenhouse");
        onTheField.Should().NotThrow("field ground is exactly what a fixture may till");
    }

    /// <summary>
    /// A spread call and the cleanup that answers for it travel together: the set of files is the fixture directory (so a
    /// new fixture partial is inside this gate the day it is added), and each file must call the cleanup as many times as
    /// it spreads. A ladder added with <c>SpreadDirt</c> and no cleanup fails here by name.
    /// </summary>
    [Fact]
    public void EverySpreadOfDirtIsAnsweredByACleanup()
    {
        string[] files = Directory.GetFiles(
                Path.Combine(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot)), "integrations", "stardew"),
                "ModEntry.Fixtures*.cs")
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToArray();
        files.Should().NotBeEmpty("the fixture directory is the population, and an empty one would agree with itself");

        var offenders = new List<string>();
        int spreads = 0;
        foreach (string file in files)
        {
            string source = File.ReadAllText(file);
            int spreadCount = Count(source, "parseDebugInput(\"SpreadDirt\"");
            int cleanupCount = Count(source, "FixtureGround.ClearPavedDirt(");
            spreads += spreadCount;
            if (spreadCount != cleanupCount)
                offenders.Add($"{Path.GetFileName(file)}:spreads={spreadCount};cleanups={cleanupCount}");
        }

        spreads.Should().BeGreaterThan(0, "a gate that examined no spread would be green about nothing");
        offenders.Should().BeEmpty("every debug spread of dirt must be followed by FixtureGround.ClearPavedDirt in the same file");
    }

    private static int Count(string source, string needle)
    {
        int count = 0;
        int index = source.IndexOf(needle, StringComparison.Ordinal);
        while (index >= 0)
        {
            count++;
            index = source.IndexOf(needle, index + needle.Length, StringComparison.Ordinal);
        }
        return count;
    }

    /// <summary>
    /// THE ROUND98 ROW as a published fact rather than a fixture defence: the doorstep's ground is `stone` and it is the
    /// greenhouse's, the field tile beside it is `soil` and it is nobody's, and the route says which question answered -
    /// so a reader of the row can tell a doorway from a plot without a rectangle of ours. The map's own `Type` word is
    /// the third answer (`Wood`), and `DescribeSurface` is the fixture's door onto the same reading.
    /// </summary>
    [Fact]
    public void TheDoorstepAndTheFieldPublishDifferentGrounds()
    {
        Farm farm = BuildFarm();
        Greenhouse(farm);
        MakePavedOrFieldTile(farm, 31, 17, type: null);
        MakePavedOrFieldTile(farm, 31, 18, type: "Wood");

        GroundSurface surfaces = GroundSurface.Of(farm);

        GroundSurface.Reading doorstep = surfaces.At(29, 17);
        doorstep.Surface.Should().Be("stone", "the greenhouse's own tile data says the porch is stone");
        doorstep.Owner.Should().Be("Greenhouse", "the building, not the map, answered - so the row says whose ground it is");
        doorstep.Paved.Should().BeTrue();
        doorstep.Route.Should().Be("building_type:Stone@Greenhouse");

        GroundSurface.Reading field = surfaces.At(31, 17);
        field.Surface.Should().Be("soil", "a map tile with no surface word is soil, and that is an ANSWER, not a default");
        field.Owner.Should().BeNull("the map answered, so no building owns this ground");
        field.Paved.Should().BeFalse();

        surfaces.At(31, 18).Surface.Should().Be("wood", "the map's own Type word is a surface the row can state");
        FixtureGround.DescribeSurface(farm, 29, 17).Should().Be(surfaces.Describe(29, 17), "one reading, two doors onto it");
    }

    /// <summary>
    /// A TILE NOBODY COULD MEASURE SAYS SO. Three shapes, one vocabulary: off the map, a location with no map at all, and
    /// the reason the answer is not soil - because a default here is the same lie the fixture's `SpreadDirt` was.
    /// </summary>
    [Fact]
    public void AnUnmeasurableTileSaysWhyRatherThanReadingAsSoil()
    {
        Farm farm = BuildFarm();
        GroundSurface surfaces = GroundSurface.Of(farm);

        surfaces.Describe(40, 40).Should().Be("not_measured:40,40:off_map");
        surfaces.Describe(39, 39).Should().Be("soil", "on the map with no surface word is measured soil, not a refusal");

        var mapLess = (Farm)FormatterServices.GetUninitializedObject(typeof(Farm));
        GroundSurface.Of(mapLess).Describe(0, 0).Should().Be("not_measured:0,0:no_map");
        GroundSurface.Of(null).Describe(0, 0).Should().Be("not_measured:0,0:no_location");
    }

    /// <summary>
    /// THE OBSERVATION PAYS FOR A TILE ONCE. The cache lives exactly as long as the reading, so two families in one
    /// snapshot share one measurement and no answer outlives it - and the line states what that cost, which is the number
    /// a game-thread hitch would be blamed on.
    /// </summary>
    [Fact]
    public void OneReadingMeasuresEachTileOnceAndStatesItsCost()
    {
        Farm farm = BuildFarm();
        Greenhouse(farm);
        GroundSurface surfaces = GroundSurface.Of(farm);

        surfaces.At(29, 17);
        surfaces.Describe(29, 17);
        surfaces.At(29, 17);
        surfaces.TilesMeasured.Should().Be(1, "three questions about one tile are one measurement");

        string line = surfaces.CostLine();
        line.Should().StartWith(GroundSurface.CostLinePrefix);
        line.Should().Contain("location=ProbeFarm");
        line.Should().Contain("tiles=1");
        line.Should().Contain("building_questions=1", "one tile of this farm asks the one building standing on it");
        line.Should().Contain("answers=building_type:Stone@Greenhouse=1");
        System.Text.RegularExpressions.Regex.IsMatch(line, @";ms=\d+\.\d{3}$").Should().BeTrue($"the line prices the reading: {line}");
    }

    /// <summary>
    /// A <c>Farm</c> with the two layers every real farm map has and nothing else. <c>Game1.buildingData</c> is EMPTY
    /// rather than absent: the engine reads a building's data through it, and an empty table is what makes
    /// <c>AdditionalTilePropertyRadius</c> answer 0 - the case in which the porch's second row is invisible to the
    /// location-level lookup, which is the defect this file is about.
    /// </summary>
    private static Farm BuildFarm()
    {
        Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
        typeof(Game1).GetField("buildingData", BindingFlags.Public | BindingFlags.Static)!
            .SetValue(null, new Dictionary<string, StardewValley.GameData.Buildings.BuildingData>(StringComparer.Ordinal));
        var farm = new Farm();
        var map = new xTile.Map();
        var size = new xTile.Dimensions.Size(40, 40);
        var tileSize = new xTile.Dimensions.Size(64, 64);
        map.AddLayer(new xTile.Layers.Layer("Back", map, size, tileSize));
        map.AddLayer(new xTile.Layers.Layer("Buildings", map, size, tileSize));
        farm.map = map;
        SetField(farm, "name", new NetString("ProbeFarm"));
        SetField(farm, "buildings", new NetCollection<Building>());
        // The terrain-feature collection's own OnValueAdded handler runs `HoeDirt.OnAdded`, which reads the location's
        // season/neighbour state a content-less process does not have; nothing here needs that handler, and the rules under
        // test read the collection itself.
        SetField(
            farm,
            "terrainFeatures",
            new NetVector2Dictionary<StardewValley.TerrainFeatures.TerrainFeature, NetRef<StardewValley.TerrainFeatures.TerrainFeature>>());
        Game1.game1.instanceGameLocation = farm;
        return farm;
    }

    /// <summary>One <c>Back</c> tile: the map's <c>Diggable</c> declaration, plus <c>Type</c> when the tile is paved.</summary>
    private static void MakePavedOrFieldTile(Farm farm, int x, int y, string? type)
    {
        xTile.Layers.Layer back = farm.map.GetLayer("Back")!;
        var tile = new xTile.Tiles.StaticTile(back, TileSheet(farm), xTile.Tiles.BlendMode.Alpha, 0);
        tile.Properties["Diggable"] = "T";
        if (type is not null)
            tile.Properties["Type"] = type;
        back.Tiles[x, y] = tile;
    }

    /// <summary>A tile something is BUILT on: the map's <c>Buildings</c> layer.</summary>
    private static void MakeBuiltOnTile(Farm farm, int x, int y)
    {
        xTile.Layers.Layer buildings = farm.map.GetLayer("Buildings")!;
        buildings.Tiles[x, y] = new xTile.Tiles.StaticTile(buildings, TileSheet(farm), xTile.Tiles.BlendMode.Alpha, 0);
    }

    private static xTile.Tiles.TileSheet TileSheet(Farm farm)
    {
        if (farm.map.TileSheets.Count > 0)
            return farm.map.TileSheets[0];
        var sheet = new xTile.Tiles.TileSheet(
            "spring", farm.map, "Maps/spring_outdoorsTilesheet",
            new xTile.Dimensions.Size(64, 64), new xTile.Dimensions.Size(64, 64));
        farm.map.AddTileSheet(sheet);
        return sheet;
    }

    private static StardewValley.TerrainFeatures.HoeDirt Till(Farm farm, int x, int y)
    {
        // Built uninitialised rather than constructed: `HoeDirt()` runs `initialize`, which asks the location's season
        // context - content a headless process does not load, and nothing here reads a season.
        var dirt = (StardewValley.TerrainFeatures.HoeDirt)FormatterServices.GetUninitializedObject(
            typeof(StardewValley.TerrainFeatures.HoeDirt));
        SeedMissingNetFields(dirt);
        farm.terrainFeatures[new Vector2(x, y)] = dirt;
        return dirt;
    }

    /// <summary>
    /// A crop REFERENCE and nothing else: this file is about which tiles may hold dirt, so the crop only has to exist for
    /// the detach order to be observable (the dirt's own crop reference is what has to be null afterwards).
    /// </summary>
    private static Crop AttachCrop(StardewValley.TerrainFeatures.HoeDirt dirt)
    {
        var crop = (Crop)FormatterServices.GetUninitializedObject(typeof(Crop));
        SeedMissingNetFields(crop);
        dirt.crop = crop;
        return crop;
    }

    /// <summary>
    /// THE RUN'S OWN GREENHOUSE, read off its save: tile <c>25,10</c>, <c>7x6</c>, humanDoor <c>3,5</c> - which is what
    /// makes the doorstep <c>27..29 x 16..17</c> and <c>29,17</c> the tile round98 farmed.
    /// </summary>
    private static GreenhouseBuilding Greenhouse(Farm farm)
    {
        var greenhouse = (GreenhouseBuilding)FormatterServices.GetUninitializedObject(typeof(GreenhouseBuilding));
        SeedMissingNetFields(greenhouse);
        SetField(greenhouse, "tileX", new NetInt(25));
        SetField(greenhouse, "tileY", new NetInt(10));
        SetField(greenhouse, "tilesWide", new NetInt(7));
        SetField(greenhouse, "tilesHigh", new NetInt(6));
        SetField(greenhouse, "humanDoor", new NetPoint(new Point(3, 5)));
        SetField(greenhouse, "animalDoor", new NetPoint(new Point(-1, -1)));
        SetField(greenhouse, "buildingType", new NetString("Greenhouse"));
        SetField(greenhouse, "daysOfConstructionLeft", new NetInt(0));
        SetField(greenhouse, "parentLocationName", new NetString(farm.NameOrUniqueName));
        farm.buildings.Add(greenhouse);
        return greenhouse;
    }

    /// <summary>The Netcode fields a <c>FormatterServices</c>-built instance never ran, in the shape the rest of this suite seeds them.</summary>
    private static void SeedMissingNetFields(object instance)
    {
        foreach (FieldInfo field in instance.GetType().GetFields(AnyInstance))
        {
            if (field.FieldType.Namespace is null || !field.FieldType.Namespace.StartsWith("Netcode", StringComparison.Ordinal))
                continue;
            if (field.GetValue(instance) is not null)
                continue;
            if (field.FieldType == typeof(NetFields))
            {
                field.SetValue(instance, new NetFields(instance.GetType().Name));
                continue;
            }
            if (field.FieldType.GetConstructor(Type.EmptyTypes) is null)
                continue;
            field.SetValue(instance, Activator.CreateInstance(field.FieldType)!);
        }
    }

    private static void SetField(object target, string name, object value)
    {
        FieldInfo? field = typeof(Building).GetField(name, AnyInstance)
            ?? target.GetType().GetField(name, AnyInstance)
            ?? throw new InvalidOperationException($"{target.GetType().Name} has no field {name}");
        field.SetValue(target, value);
    }
}
