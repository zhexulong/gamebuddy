using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// What can be caught at one place and moment, derived from the game's own two tables - the answer for both the planning
/// lookup and the <c>fish_here</c> admission guard.
///
/// <para>
/// WHY ONE FUNCTION. The engine decides what bites in <c>GameLocation.GetFishFromLocationData</c>
/// (<c>GameLocation.cs:13901-14029</c>) by walking the location's <c>Data/Locations</c> fish rows and then the species'
/// <c>Data/Fish</c> row (<c>CheckGenericFishRequirements</c>, <c>:14042-14189</c>). A companion that wants to know "can I
/// catch a pufferfish here" and a handler that wants to refuse a cast that cannot succeed are asking THAT question, so
/// they call THIS function. Two evaluations of one fact is the defect this file exists to make impossible: the lookup
/// prints exactly the rows the guard refuses on.
/// </para>
///
/// <para>
/// WHERE EACH FACT COMES FROM, cited at the line that reads it. The candidate set is the location's own rows plus
/// <c>Game1.locationData["Default"]</c> (`:13940-13944`); the season is <c>Game1.GetSeasonForLocation(location)</c>
/// (`:13909`); the fish area is <c>GameLocation.TryGetFishAreaForTile</c> (`:13910`). The per-row filters are, in the
/// engine's own order: <c>FishAreaId</c>, <c>Season</c> (`:13955`), <c>PlayerPosition</c>, <c>BobberPosition</c>,
/// <c>MinFishingLevel</c>, <c>MinDistanceFromShore</c>, <c>MaxDistanceFromShore</c> and <c>RequireMagicBait</c>
/// (`:13959-13965`), then <c>CatchLimit</c> (`:14002`), and then the species row: difficulty at index 1, time spans at
/// index 5, weather at index 7 and minimum fishing level at index 12 (`:14062`, `:14091`, `:14116`, `:14132`), with the
/// tutorial flag at index 13 (`:14078`). The member DECLARATIONS for <c>SpawnFishData</c>/<c>LocationData</c> live in
/// <c>StardewValley.GameData.dll</c>, which the locked decompilation tree does not contain (948 files, all from
/// <c>Stardew Valley.dll</c>); every member above is therefore cited where the engine READS it, not where it is declared.
/// </para>
///
/// <para>
/// WHAT IS DELIBERATELY NOT MODELLED, because it is the engine's RANDOM and a second copy of it would agree today and
/// disagree the first time either moved: <c>SpawnFishData.GetChance</c> and the <c>NextBool</c> roll after it
/// (`:13969-13980`), the depth/luck chance arithmetic (`:14140-14181`), <c>UseFishCaughtSeededRandom</c>, and any
/// <c>GameStateQuery</c> <c>Condition</c> (`:13981`). Every one of those can only REMOVE a row the deterministic filters
/// already admitted, so a row that passes the deterministic filters but might be dropped by a roll counts as CATCHABLE.
/// That is the direction that keeps the guard sound: it makes a refusal harder, never easier.
/// </para>
///
/// <para>
/// SOUND-OR-SILENT. <see cref="FishingCatchReport.RefusalFor"/> answers a code only when a species is POSITIVELY
/// blocked, and <see cref="NotMeasured"/> is what a caller with unreadable data gets - never an empty report, because an
/// empty report reads as "nothing bites here". The guard admits on both.
/// </para>
///
/// <para>
/// PARITY, AND WHAT IT DOES NOT PROVE. The forward direction of the parity claim - "every fish the engine's sampler
/// produces is in this candidate set" - is NOT provable in this process: <c>getFish</c> reads
/// <c>DataLoader.Fish(Game1.content)</c> and <c>Game1.locationData</c>, and the Mod's test process has no content manager
/// (the same limit <c>FishingActionTests</c> records for the engine's own catch). It is a live-run gate. What IS proven
/// headless is the arithmetic: the field indices and the filter order below are pinned from the engine's own source by
/// <c>FishingCatchableTests</c>, and the reverse direction - a species this file calls catchable that the sampler never
/// produces - cannot be excluded at any finite N either, because the sampler is a sampler. Both directions need the
/// game running; neither is claimed here.
/// </para>
/// </summary>
public static class FishingCatchable
{
    /// <summary>The <c>Data/Fish</c> index the engine reads for a species' difficulty (<c>GameLocation.cs:14066</c>).</summary>
    public const int FishRowDifficultyIndex = 1;

    /// <summary>The <c>Data/Fish</c> index holding the catchable time spans (<c>GameLocation.cs:14091</c>).</summary>
    public const int FishRowTimeSpansIndex = 5;

    /// <summary>The <c>Data/Fish</c> index holding the weather requirement (<c>GameLocation.cs:14116</c>).</summary>
    public const int FishRowWeatherIndex = 7;

    /// <summary>The <c>Data/Fish</c> index holding the minimum fishing level (<c>GameLocation.cs:14132</c>).</summary>
    public const int FishRowMinimumLevelIndex = 12;

    /// <summary>The <c>Data/Fish</c> index holding the tutorial-fish flag (<c>GameLocation.cs:14078</c>).</summary>
    public const int FishRowTutorialIndex = 13;

    /// <summary>The difficulty cell that means "this row is a trap, not a fish" (<c>GameLocation.cs:14049</c>).</summary>
    public const string TrapMarker = "trap";

    /// <summary>The weather cell that requires rain here (<c>GameLocation.cs:14120</c>).</summary>
    public const string RainyMarker = "rainy";

    /// <summary>The weather cell that requires no rain here (<c>GameLocation.cs:14122</c>).</summary>
    public const string SunnyMarker = "sunny";

    /// <summary>The difficulty at which a training rod refuses a species (<c>GameLocation.cs:14070</c>).</summary>
    public const int TrainingRodDifficultyCeiling = 50;

    /// <summary>The spelling of "this row declares no constraint", used by the answer for time and weather.</summary>
    public const string AnyValue = "any";

    /// <summary>
    /// The one answer, from a moment and the location's fish rows.
    ///
    /// <para>
    /// <paramref name="moment"/> carries the facts the engine reads from the world; each <see cref="FishingSpawn"/> is one
    /// <c>Data/Locations</c> row joined to its species' raw <c>Data/Fish</c> row (<see cref="FishingSpawn.FishRow"/>), so
    /// this file parses the species table itself rather than trusting a second parse elsewhere.
    /// </para>
    /// </summary>
    public static FishingCatchReport CatchableNow(FishingMoment moment, IReadOnlyList<FishingSpawn> spawns)
    {
        ArgumentNullException.ThrowIfNull(moment);
        ArgumentNullException.ThrowIfNull(spawns);

        List<FishingSpeciesRow> catchable = new();
        List<FishingSpeciesRow> blocked = new();
        for (int index = 0; index < spawns.Count; index++)
        {
            FishingSpawn spawn = spawns[index];
            FishRowSpec spec = spawn.FishRow is null ? FishRowSpec.None : FishRowSpec.Parse(spawn.FishRow);
            FishingSpeciesRow row = Describe(spawn, spec);
            string? code = BlockingCode(moment, spawn, row, spec, out string fact);
            if (code is null) catchable.Add(row);
            else blocked.Add(row with { BlockedCode = code, BlockedFact = fact });
        }

        return new FishingCatchReport(true, null, catchable, blocked, spawns.Count, moment.WaterDepth.HasValue);
    }

    /// <summary>
    /// The answer when the data could not be read at all: named, never empty.
    ///
    /// <para>
    /// A report with no rows is a claim about the world; this is the admission that no claim was made. Both callers treat
    /// it differently and both are correct: the lookup prints <c>not measured: reason</c>, and the guard admits the cast.
    /// </para>
    /// </summary>
    public static FishingCatchReport NotMeasured(string reason) =>
        new(false, reason, Array.Empty<FishingSpeciesRow>(), Array.Empty<FishingSpeciesRow>(), 0, false);

    /// <summary>
    /// Whether <paramref name="requestedQualifiedItemId"/> is positively blocked here and now, with the fact that would
    /// have to change.
    ///
    /// <para>
    /// A species the table does not name at all is blocked by name: the engine only ever produces a row from this table
    /// (its last resort is the junk fallback at <c>GameLocation.cs:13874</c>), so a species absent from it cannot bite
    /// here. A row whose <c>ItemId</c> is an item QUERY (<c>ALL_ITEMS</c>, <c>RANDOM_ITEMS</c>, ...) resolves to no
    /// species, so it can never be excluded and answers null.
    /// </para>
    /// </summary>
    public static FishingRefusal? RefusalFor(this FishingCatchReport report, string requestedQualifiedItemId)
    {
        ArgumentNullException.ThrowIfNull(report);
        if (!report.Measured || string.IsNullOrEmpty(requestedQualifiedItemId)) return null;
        foreach (FishingSpeciesRow row in report.Blocked)
            if (string.Equals(row.Species, requestedQualifiedItemId, StringComparison.Ordinal))
                return new FishingRefusal(row.BlockedCode, row.BlockedFact);
        foreach (FishingSpeciesRow row in report.Catchable)
            if (string.Equals(row.Species, requestedQualifiedItemId, StringComparison.Ordinal))
                return null;
        foreach (FishingSpeciesRow row in report.Catchable.Concat(report.Blocked))
            if (row.SpeciesIsItemQuery) return null;
        return new FishingRefusal(
            $"not_in_this_location:{requestedQualifiedItemId}",
            $"requested={requestedQualifiedItemId};species_rows={report.Examined.ToString(CultureInfo.InvariantCulture)};"
            + "detail=the engine only produces a species from this location's fish table (junk fallback aside)");
    }

    /// <summary>
    /// The answer for a cast that named NO species: the junk facts only.
    ///
    /// <para>
    /// Never a refusal, and the reason is the engine's own last line: <c>getFish</c> returns
    /// <c>ItemRegistry.Create("(O)168")</c> when no row matched (<c>GameLocation.cs:13874</c>), so a cast always yields
    /// SOMETHING and "nothing is catchable here" is never true. A guard that refused here would block the capability to
    /// remove a wait.
    /// </para>
    /// </summary>
    public const string JunkFallbackSpecies = "(O)168";

    // ------------------------------------------------------------------
    // The engine's filter order, one clause per line it is read from.
    // ------------------------------------------------------------------

    private static string? BlockingCode(
        FishingMoment moment,
        FishingSpawn spawn,
        FishingSpeciesRow row,
        FishRowSpec spec,
        out string fact)
    {
        fact = string.Empty;
        string species = row.Species;

        // :13955 - the fish area, then the season. Magic bait bypasses the season but never the area.
        if (spawn.FishAreaId is { Length: > 0 } area && !string.Equals(area, moment.FishAreaId, StringComparison.Ordinal))
        {
            fact = Describe(moment, spawn, row, $"fish_area={area};here_area={moment.FishAreaId ?? "none"}");
            return $"fish_area_mismatch:{species}:{area}";
        }
        if (spawn.Season is { Length: > 0 } season
            && !moment.MagicBait
            && !string.Equals(season, moment.Season, StringComparison.OrdinalIgnoreCase))
        {
            fact = Describe(moment, spawn, row, $"season={season};world_season={moment.Season}");
            return $"season_mismatch:{species}:{season}";
        }

        // :13959-13960 - the player's own tile must be inside the row's `PlayerPosition` when it declares one.
        if (spawn.PlayerPosition is { } playerRect
            && moment.PlayerTile is { } playerTile
            && !playerRect.Contains(playerTile.X, playerTile.Y))
        {
            fact = Describe(moment, spawn, row, $"player_rect={playerRect.Describe()};player_tile={playerTile.X},{playerTile.Y}");
            return $"player_position_excluded:{species}";
        }

        // :13964-13965 - the bobber's tile, then the level and the two depth bounds. The bobber tile and the depth are
        // known only to the guard (the lookup has no tile to ask about), so these filter only when they were measured.
        if (spawn.BobberPosition is { } bobberRect
            && moment.BobberTile is { } bobberTile
            && !bobberRect.Contains(bobberTile.X, bobberTile.Y))
        {
            fact = Describe(moment, spawn, row, $"bobber_rect={bobberRect.Describe()};bobber_tile={bobberTile.X},{bobberTile.Y}");
            return $"bobber_position_excluded:{species}";
        }
        if (moment.FishingLevel < spawn.MinimumFishingLevel)
        {
            fact = Describe(moment, spawn, row, $"required={spawn.MinimumFishingLevel};yours={moment.FishingLevel}");
            return $"skill_too_low:{species}:{spawn.MinimumFishingLevel}:{moment.FishingLevel}";
        }
        if (moment.WaterDepth is { } depth)
        {
            if (depth < spawn.MinimumDistanceFromShore)
            {
                fact = Describe(moment, spawn, row, $"required={spawn.MinimumDistanceFromShore};yours={depth}");
                return $"needs_deeper_water:{species}:{spawn.MinimumDistanceFromShore}:{depth}";
            }
            if (spawn.MaximumDistanceFromShore > -1 && depth > spawn.MaximumDistanceFromShore)
            {
                fact = Describe(moment, spawn, row, $"required_at_most={spawn.MaximumDistanceFromShore};yours={depth}");
                return $"needs_shallower_water:{species}:{spawn.MaximumDistanceFromShore}:{depth}";
            }
        }
        if (spawn.RequiresMagicBait && !moment.MagicBait)
        {
            fact = Describe(moment, spawn, row, "requires_magic_bait=true;magic_bait=false");
            return $"requires_magic_bait:{species}";
        }

        // :14002 - the catch limit, read from the farmer's own record. A row with no resolvable species carries no limit
        // this file can compare, and an uncomparable limit is not a block.
        if (spawn.Species is not null
            && spawn.CatchLimit > -1
            && spawn.CaughtSoFar >= spawn.CatchLimit)
        {
            fact = Describe(moment, spawn, row, $"limit={spawn.CatchLimit};caught={spawn.CaughtSoFar}");
            return $"catch_limit_reached:{species}:{spawn.CatchLimit}";
        }

        return BlockingCodeFromSpeciesData(moment, spawn, row, spec, out fact);
    }

    /// <summary>
    /// The species row half: <c>CheckGenericFishRequirements</c> in its own order.
    ///
    /// The three early returns at <c>GameLocation.cs:14044-14052</c> are the ones a naive reader gets wrong in the unsafe
    /// direction: a row that is not an object, has no <c>Data/Fish</c> entry, or is a trap PASSES every requirement. So a
    /// missing species row is never a block.
    /// </summary>
    private static string? BlockingCodeFromSpeciesData(
        FishingMoment moment,
        FishingSpawn spawn,
        FishingSpeciesRow row,
        FishRowSpec spec,
        out string fact)
    {
        fact = string.Empty;
        if (spawn.FishRow is null) return null;
        if (spec.MalformedIndex is { } malformed)
        {
            // The engine logs a warning and returns false: the row is skipped forever, not "every requirement met".
            fact = Describe(moment, spawn, row, $"malformed_field_index={malformed}");
            return $"fish_data_malformed:{row.Species}:{malformed}";
        }
        if (spec.Trap) return null;

        // :14053-14075 - a training rod cannot take a species at difficulty 50 or harder unless the row overrides it.
        if (moment.TrainingRod
            && spawn.CanUseTrainingRod != true
            && spec.Difficulty is { } rodDifficulty
            && rodDifficulty >= TrainingRodDifficultyCeiling)
        {
            fact = Describe(moment, spawn, row, $"difficulty={rodDifficulty};training_rod_ceiling={TrainingRodDifficultyCeiling}");
            return $"training_rod_too_weak:{row.Species}:{rodDifficulty}";
        }

        // :14076-14086 - the first catch accepts only the species the table marks as a tutorial fish.
        if (moment.FirstCatch && spec.TutorialFish != true)
        {
            fact = Describe(moment, spawn, row, "first_catch=true;tutorial_fish=false");
            return $"first_catch_accepts_only_tutorial_fish:{row.Species}";
        }

        if (spawn.IgnoresFishDataRequirements) return null;

        // :14089-14113 - the time spans. Magic bait bypasses them. A blank cell is NOT "any time": `SplitBySpace` returns
        // no pair, no pair matches, and the engine returns false - the species is uncatchable, and this says so.
        if (!moment.MagicBait)
        {
            if (spec.TimeSpans.Count == 0)
            {
                fact = Describe(moment, spawn, row, $"declared_window=none;time_of_day={moment.TimeOfDay}");
                return $"time_outside_window:{row.Species}:none";
            }
            if (!spec.TimeSpans.Any(window => window.Contains(moment.TimeOfDay)))
            {
                fact = Describe(moment, spawn, row, $"declared_window={spec.DescribeWindow()};time_of_day={moment.TimeOfDay}");
                return $"time_outside_window:{row.Species}:{spec.DescribeWindow()}";
            }
        }

        // :14114-14131 - the weather. Only the two literals constrain anything, and magic bait bypasses them.
        if (!moment.MagicBait)
        {
            if (string.Equals(spec.Weather, RainyMarker, StringComparison.Ordinal) && !moment.Raining)
            {
                fact = Describe(moment, spawn, row, "declared_weather=rainy;raining_here=false");
                return $"weather_mismatch:{row.Species}:{RainyMarker}";
            }
            if (string.Equals(spec.Weather, SunnyMarker, StringComparison.Ordinal) && moment.Raining)
            {
                fact = Describe(moment, spawn, row, "declared_weather=sunny;raining_here=true");
                return $"weather_mismatch:{row.Species}:{SunnyMarker}";
            }
        }

        // :14132-14139 - the species' own minimum level. NOT bypassed by magic bait: it sits outside both
        // `if (!usingMagicBait)` blocks, in the same `if (!spawn.IgnoreFishDataRequirements)` body.
        if (spec.MinimumFishingLevel is { } required && moment.FishingLevel < required)
        {
            fact = Describe(moment, spawn, row, $"required={required};yours={moment.FishingLevel}");
            return $"skill_too_low:{row.Species}:{required}:{moment.FishingLevel}";
        }

        return null;
    }

    private static FishingSpeciesRow Describe(FishingSpawn spawn, FishRowSpec spec)
    {
        string species = spawn.Species
            ?? (spawn.SpeciesIsItemQuery ? spawn.ItemId : spawn.ItemId.Length == 0 ? "unknown" : spawn.ItemId);
        return new FishingSpeciesRow(
            species,
            spawn.DisplayName,
            spec.Difficulty,
            spawn.MinimumFishingLevel,
            spec.MalformedIndex is null && spec.TimeSpans.Count > 0 ? spec.DescribeWindow() : AnyValue,
            spec.Weather is { Length: > 0 } weather ? weather : AnyValue,
            spawn.Season,
            spawn.SpeciesIsItemQuery,
            string.Empty,
            string.Empty);
    }

    private static string Describe(FishingMoment moment, FishingSpawn spawn, FishingSpeciesRow row, string decision) =>
        $"location={moment.Location};season={moment.Season};day={moment.DayOfMonth.ToString(CultureInfo.InvariantCulture)};"
        + $"time={moment.TimeOfDay.ToString(CultureInfo.InvariantCulture)};raining={moment.Raining};"
        + $"level={moment.FishingLevel.ToString(CultureInfo.InvariantCulture)};"
        + $"depth={(moment.WaterDepth?.ToString(CultureInfo.InvariantCulture) ?? "unmeasured")};"
        + $"magic_bait={moment.MagicBait};training_rod={moment.TrainingRod};"
        + $"row_item={spawn.ItemId};species={row.Species};{decision}";
}

/// <summary>One tile, kept plain so the derivation stays engine-free.</summary>
public readonly record struct FishingTile(int X, int Y);

/// <summary>One rectangle in tiles, the shape `SpawnFishData.PlayerPosition`/`BobberPosition` declare.</summary>
public readonly record struct FishingRectangle(int X, int Y, int Width, int Height)
{
    /// <summary>Whether the tile is inside, by the engine's own <c>Rectangle.Contains</c> rule (<c>GameLocation.cs:13960</c>).</summary>
    public bool Contains(int x, int y) => x >= this.X && x < this.X + this.Width && y >= this.Y && y < this.Y + this.Height;

    public string Describe() => $"{this.X},{this.Y} {this.Width}x{this.Height}";
}

/// <summary>
/// The moment the answer is about: the facts the engine reads from the live world (<c>GameLocation.cs:13909-13965</c>).
///
/// <paramref name="WaterDepth"/> and <paramref name="BobberTile"/> are null for a lookup, which has no bobber to ask
/// about: the two depth bounds and the bobber rectangle then filter nothing, and the report says
/// <see cref="FishingCatchReport.DepthApplied"/> is false so a reader can see which question was answered.
/// </summary>
public sealed record FishingMoment(
    string Location,
    string Season,
    int DayOfMonth,
    int TimeOfDay,
    bool Raining,
    int FishingLevel,
    string? FishAreaId,
    bool MagicBait,
    bool TrainingRod,
    bool FirstCatch,
    int? WaterDepth,
    FishingTile? PlayerTile,
    FishingTile? BobberTile);

/// <summary>
/// One fish row of the location's <c>Data/Locations</c> entry, joined to its raw <c>Data/Fish</c> row.
///
/// <paramref name="Species"/> is the qualified item id when the row's <c>ItemId</c> is a plain item id and null when it is
/// an item query, in which case <paramref name="SpeciesIsItemQuery"/> is true and the row can never be excluded by name.
/// <paramref name="CanUseTrainingRod"/> is <c>SpawnFishData.CanUseTrainingRod</c>, the row's own override of the training
/// rod's difficulty ceiling (<c>GameLocation.cs:14056</c>) - null when it does not declare one.
/// </summary>
public sealed record FishingSpawn(
    string ItemId,
    string? Species,
    string? DisplayName,
    string? Season,
    string? FishAreaId,
    int MinimumFishingLevel,
    int MinimumDistanceFromShore,
    int MaximumDistanceFromShore,
    bool RequiresMagicBait,
    bool IgnoresFishDataRequirements,
    int CatchLimit,
    int CaughtSoFar,
    bool SpeciesIsItemQuery,
    string? FishRow,
    bool? CanUseTrainingRod = null,
    FishingRectangle? PlayerPosition = null,
    FishingRectangle? BobberPosition = null);

/// <summary>One species in the answer, with the facts that decide it and the code when it is blocked.</summary>
public sealed record FishingSpeciesRow(
    string Species,
    string? DisplayName,
    int? Difficulty,
    int MinimumFishingLevel,
    string TimeWindow,
    string Weather,
    string? Season,
    bool SpeciesIsItemQuery,
    string BlockedCode,
    string BlockedFact);

/// <summary>A refusal: the code a reader can act on, and the evidence that decided it.</summary>
public sealed record FishingRefusal(string Code, string Fact);

/// <summary>
/// The answer. <see cref="Measured"/> is false exactly when no reading was taken, and a caller must then neither refuse
/// nor print an empty set.
/// </summary>
public sealed record FishingCatchReport(
    bool Measured,
    string? NotMeasuredReason,
    IReadOnlyList<FishingSpeciesRow> Catchable,
    IReadOnlyList<FishingSpeciesRow> Blocked,
    int Examined,
    bool DepthApplied);

/// <summary>One `Data/Fish` row, parsed at the indices the engine reads (<c>GameLocation.cs:14044-14139</c>).</summary>
public sealed record FishRowSpec(
    int? Difficulty,
    bool Trap,
    IReadOnlyList<FishingTimeWindow> TimeSpans,
    string Weather,
    int? MinimumFishingLevel,
    bool? TutorialFish,
    int? MalformedIndex)
{
    /// <summary>The "no species row" reading: nothing constrains the row, which is what the engine's early return says.</summary>
    public static FishRowSpec None { get; } = new(null, false, Array.Empty<FishingTimeWindow>(), string.Empty, null, null, null);

    /// <summary>
    /// Parse one row by the engine's own indices.
    ///
    /// A field the engine's <c>ArgUtility.TryGetInt</c> would reject is reported as <see cref="MalformedIndex"/> rather
    /// than guessed: the engine logs and skips such a row (<c>:14184-14188</c>), so the row is uncatchable and the code
    /// should say which field is wrong.
    /// </summary>
    public static FishRowSpec Parse(string row)
    {
        string[] cells = row.Split('/');
        bool trap = string.Equals(CellAt(cells, FishingCatchable.FishRowDifficultyIndex), FishingCatchable.TrapMarker, StringComparison.Ordinal);
        int? difficulty = null;
        if (!trap
            && int.TryParse(CellAt(cells, FishingCatchable.FishRowDifficultyIndex), NumberStyles.Integer, CultureInfo.InvariantCulture, out int parsedDifficulty))
            difficulty = parsedDifficulty;

        List<FishingTimeWindow> spans = new();
        string rawSpans = CellAt(cells, FishingCatchable.FishRowTimeSpansIndex);
        string[] parts = rawSpans.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        for (int index = 0; index + 1 < parts.Length; index += 2)
        {
            if (int.TryParse(parts[index], NumberStyles.Integer, CultureInfo.InvariantCulture, out int start)
                && int.TryParse(parts[index + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out int end))
                spans.Add(new FishingTimeWindow(start, end));
            else
                return new FishRowSpec(difficulty, trap, spans, CellAt(cells, FishingCatchable.FishRowWeatherIndex),
                    null, null, FishingCatchable.FishRowTimeSpansIndex);
        }
        if (parts.Length % 2 != 0)
            return new FishRowSpec(difficulty, trap, spans, CellAt(cells, FishingCatchable.FishRowWeatherIndex),
                null, null, FishingCatchable.FishRowTimeSpansIndex);

        int? minimumLevel = null;
        string rawLevel = CellAt(cells, FishingCatchable.FishRowMinimumLevelIndex);
        if (int.TryParse(rawLevel, NumberStyles.Integer, CultureInfo.InvariantCulture, out int level)) minimumLevel = level;
        else if (!trap) return new FishRowSpec(difficulty, trap, spans, CellAt(cells, FishingCatchable.FishRowWeatherIndex),
            null, null, FishingCatchable.FishRowMinimumLevelIndex);

        bool? tutorial = null;
        string rawTutorial = CellAt(cells, FishingCatchable.FishRowTutorialIndex);
        if (rawTutorial.Length > 0)
        {
            if (bool.TryParse(rawTutorial, out bool parsedTutorial)) tutorial = parsedTutorial;
            else return new FishRowSpec(difficulty, trap, spans, CellAt(cells, FishingCatchable.FishRowWeatherIndex),
                minimumLevel, null, FishingCatchable.FishRowTutorialIndex);
        }

        return new FishRowSpec(difficulty, trap, spans, CellAt(cells, FishingCatchable.FishRowWeatherIndex),
            minimumLevel, tutorial, null);
    }

    /// <summary>The declared window as one stable spelling: <c>600-1900,1800-2600</c>, or <c>none</c>.</summary>
    public string DescribeWindow() =>
        this.TimeSpans.Count == 0
            ? "none"
            : string.Join(",", this.TimeSpans.Select(span =>
                $"{span.Start.ToString(CultureInfo.InvariantCulture)}-{span.End.ToString(CultureInfo.InvariantCulture)}"));

    private static string CellAt(string[] cells, int index) => index < cells.Length ? cells[index] : string.Empty;
}

/// <summary>
/// One catchable span of the game day, compared exactly as the engine compares it: <c>timeOfDay &gt;= start</c> and
/// <c>timeOfDay &lt; end</c> (<c>GameLocation.cs:14103</c>). End values above 2400 are the engine's own way of spelling a
/// window that runs past midnight, so they are neither clamped nor normalised.
/// </summary>
public readonly record struct FishingTimeWindow(int Start, int End)
{
    public bool Contains(int timeOfDay) => timeOfDay >= this.Start && timeOfDay < this.End;
}
