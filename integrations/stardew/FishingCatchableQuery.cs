using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using GameBuddy.Stardew.Core;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.GameData;
using StardewValley.GameData.Locations;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

/// <summary>
/// The engine half of "what may be caught here and now": read the two tables the engine's sampler reads, join them, and
/// hand one <see cref="FishingMoment"/> to <see cref="FishingCatchable.CatchableNow"/>.
///
/// <para>
/// ONE READER, TWO CALLERS. The `data` lookup's `LocationFish` answer and the `fish_here` admission guard both call THIS
/// method, so the set the lookup prints and the set the guard refuses on are the same set by construction. A second
/// evaluation is the defect this file exists to prevent.
/// </para>
///
/// <para>
/// THE TABLES, AND WHY BOTH. `Data/Locations` holds the spawn row: fish area, season, minimum fishing level, distance from
/// shore, chance (`GameLocation.cs:13940-13969`). `Data/Fish` holds the SPECIES row, joined on the raw item id
/// (`:14044`), and it is where the time of day, the weather and the species' own minimum level live (`:14091`, `:14116`,
/// `:14132`). A reader that consulted only one table would be right about where a fish is and wrong about whether it is
/// there now.
/// </para>
///
/// <para>
/// NO ROLL, AND THE ONE CHANCE IT ASKS ABOUT. `SpawnFishData.GetChance` is the engine's own arithmetic, so it is CALLED
/// here rather than re-implemented; what the answer does with the number is <see cref="MayProduceChance"/>: a chance of
/// zero can never be rolled and any positive one may. `Game1.random` is never touched on this path - the engine's own
/// sampler is left to be the only randomization in the system.
/// </para>
///
/// <para>
/// WHY SOME LOCATIONS ARE NOT MEASURED. Five location classes override `getFish` (`MineShaft`, `Railroad`, `Farm`,
/// `IslandSouthEast`, `IslandLocation`), and each can produce a fish the location's table does not name - the mine's own
/// depth table, the railroad's one flagged fish. On such a location the table is not the authority for "what may bite",
/// so the answer is <c>not measured</c> rather than a table reading wearing the authority's clothes.
/// </para>
/// </summary>
internal static class FishingCatchableQuery
{
    /// <summary>The key a caller uses for the location the actor is standing in.</summary>
    internal const string HereKey = "here";

    /// <summary>
    /// The widest reading of a declared chance: `NextBool(chance)` accepts iff one draw is below it, so every positive
    /// chance may produce and zero never can.
    ///
    /// <para>
    /// A private static lambda rather than a method group, so nothing else can substitute a source of randomness for it.
    /// </para>
    /// </summary>
    internal static readonly Func<double, bool> MayProduceChance = static chance => chance > 0.0;

    /// <summary>The one answer: a measured report with its moment, or a named absence with no moment at all.</summary>
    internal sealed record FishingCatchAnswer(FishingCatchReport Report, FishingMoment? Moment)
    {
        internal string Location => this.Moment?.Location ?? string.Empty;
    }

    /// <summary>
    /// The answer for <paramref name="locationName"/>: the empty string or <see cref="HereKey"/> means the actor's current
    /// location, and a name means that loaded location.
    ///
    /// <para>
    /// <paramref name="bobberX"/>/<paramref name="bobberY"/> are the tile a cast would land on, which only the guard knows;
    /// with them the distance-from-shore bounds and the two position rectangles filter, and without them the answer says
    /// the depth was not applied.
    /// </para>
    /// </summary>
    internal static FishingCatchAnswer Answer(Farmer? player, string locationName, int? bobberX = null, int? bobberY = null)
    {
        try
        {
            return AnswerCore(player, locationName, bobberX, bobberY);
        }
        catch (Exception exception)
        {
            // SOUND-OR-SILENT, at the outermost layer: a table this process cannot read, a location type a mod replaced, an
            // engine call that throws on an unloaded world - every one of them is "not measured", never "nothing bites".
            return Unmeasured($"fishing_data_unreadable:{exception.GetType().Name}");
        }
    }

    private static FishingCatchAnswer AnswerCore(Farmer? player, string locationName, int? bobberX, int? bobberY)
    {
        if (player?.currentLocation is null) return Unmeasured("world_not_ready");
        GameLocation? here = player.currentLocation;
        string name = (locationName ?? string.Empty).Trim();
        GameLocation location = name.Length == 0 || string.Equals(name, HereKey, StringComparison.Ordinal)
            ? here
            : Game1.getLocationFromName(name);
        if (location is null) return Unmeasured($"location_not_loaded:{name}");
        if (OverridesGetFish(location)) return Unmeasured($"location_overrides_get_fish:{location.GetType().Name}");

        // The two tables, read through the engine's own loaders. `Game1.locationData` is the parsed `Data/Locations`; a
        // location's own row may be absent (`GetData()` answers null) and its `Default` row is the shared half the engine
        // concatenates first (`GameLocation.cs:13940-13944`).
        LocationData? locationData = location.GetData();
        if (!Game1.locationData.TryGetValue("Default", out LocationData? defaultData))
            return Unmeasured("locations_default_row_missing");
        List<SpawnFishData> rows = new();
        if (defaultData.Fish is { } defaultFish) rows.AddRange(defaultFish);
        if (locationData?.Fish is { } locationFish) rows.AddRange(locationFish);
        Dictionary<string, string> fishRows = DataLoader.Fish(Game1.content);

        FishingTile? bobberTile = bobberX is { } bx && bobberY is { } by ? new FishingTile(bx, by) : null;
        int? depth = bobberTile is { } tile ? FishingRod.distanceToLand(tile.X, tile.Y, location) : null;
        bool magicBait = player.CurrentTool is FishingRod rod && rod.HasMagicBait();
        bool curiosityLure = player.CurrentTool is FishingRod lureRod && lureRod.HasCuriosityLure();
        bool targetBait = magicBait == false && string.Equals(TargetBaitSpecies(player), string.Empty, StringComparison.Ordinal);
        FishingMoment moment = new(
            location.NameOrUniqueName,
            Game1.GetSeasonForLocation(location).ToString(),
            Game1.dayOfMonth,
            Game1.timeOfDay,
            location.IsRainingHere(),
            player.FishingLevel,
            location.TryGetFishAreaForTile(bobberTile is { } areaTile ? new Vector2(areaTile.X, areaTile.Y) : player.Tile, out string fishAreaId, out _)
                ? fishAreaId
                : null,
            magicBait,
            string.Equals(player.CurrentTool?.QualifiedItemId, "(T)TrainingRod", StringComparison.Ordinal),
            player.fishCaught.Length == 0,
            depth,
            new FishingTile((int)player.Tile.X, (int)player.Tile.Y),
            bobberTile);

        List<FishingSpawn> spawns = new(rows.Count);
        foreach (SpawnFishData row in rows)
            spawns.Add(Project(row, player, location, fishRows, curiosityLure, targetBait));

        return new FishingCatchAnswer(
            FishingCatchable.CatchableNow(moment, spawns, MayProduceChance),
            moment);
    }

    private static FishingSpawn Project(
        SpawnFishData row,
        Farmer player,
        GameLocation location,
        Dictionary<string, string> fishRows,
        bool curiosityLure,
        bool usingTargetBait)
    {
        string itemId = row.ItemId ?? string.Empty;
        bool isItemQuery = !int.TryParse(itemId, NumberStyles.Integer, CultureInfo.InvariantCulture, out _);
        string? species = isItemQuery ? null : ItemRegistry.QualifyItemId(itemId);
        string? displayName = null;
        string? fishRow = null;
        if (species is not null)
        {
            var metadata = ItemRegistry.GetDataOrErrorItem(species);
            displayName = metadata.IsErrorItem ? null : metadata.DisplayName;
            if (fishRows.TryGetValue(itemId, out string? raw)) fishRow = raw;
        }

        return new FishingSpawn(
            itemId,
            species,
            displayName,
            row.Season?.ToString(),
            row.FishAreaId,
            row.MinFishingLevel,
            row.MinDistanceFromShore,
            row.MaxDistanceFromShore,
            row.RequireMagicBait,
            row.IgnoreFishDataRequirements,
            row.CatchLimit,
            species is null ? 0 : ExecutionManager.ReadCaughtCount(player, species),
            isItemQuery,
            fishRow,
            // The engine's own chance arithmetic, asked for a number; whether a number may produce is the answer's call.
            DeclaredChance: row.GetChance(
                curiosityLure,
                player.DailyLuck,
                player.LuckLevel,
                (float value, IList<QuantityModifier> modifiers, QuantityModifier.QuantityModifierMode mode) =>
                    Utility.ApplyQuantityModifiers(value, modifiers, mode, location),
                usingTargetBait),
            CanUseTrainingRod: row.CanUseTrainingRod,
            PlayerPosition: ToRectangle(row.PlayerPosition),
            BobberPosition: ToRectangle(row.BobberPosition));
    }

    /// <summary>The species a target bait names, or the empty string: `(O)SpecificBait` carries it in `preservedParentSheetIndex` (<c>GameLocation.cs:13925-13928</c>).</summary>
    private static string TargetBaitSpecies(Farmer player) =>
        player.CurrentTool is FishingRod rod
        && rod.GetBait() is { } bait
        && string.Equals(bait.QualifiedItemId, "(O)SpecificBait", StringComparison.Ordinal)
        && bait.preservedParentSheetIndex.Value is { } preserved
            ? ItemRegistry.QualifyItemId(preserved)
            : string.Empty;

    private static FishingRectangle? ToRectangle(Rectangle? source) =>
        source is { } rectangle ? new FishingRectangle(rectangle.X, rectangle.Y, rectangle.Width, rectangle.Height) : null;

    /// <summary>
    /// Whether this location's class answers <c>getFish</c> itself, in which case the fish table is not the whole answer.
    ///
    /// The five overrides are found through the ENGINE's own virtual method rather than by a list of type names here, so a
    /// mod or a game update that overrides it is treated the same way as the five that ship.
    /// </summary>
    private static bool OverridesGetFish(GameLocation location)
    {
        MethodInfo? method = location.GetType().GetMethod(
            "getFish",
            new[] { typeof(float), typeof(string), typeof(int), typeof(Farmer), typeof(double), typeof(Vector2), typeof(string) });
        return method?.DeclaringType is not { } declaring || declaring != typeof(GameLocation);
    }

    private static FishingCatchAnswer Unmeasured(string reason) =>
        new(FishingCatchable.NotMeasured(reason), null);
}
