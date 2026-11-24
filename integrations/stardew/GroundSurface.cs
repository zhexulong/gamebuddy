using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Buildings;

namespace GameBuddy.Stardew;

/// <summary>
/// WHAT ONE TILE'S GROUND IS, said in the engine's own words, asked of the map and of the building that covers it -
/// and the ONE place this Mod answers it.
///
/// <para>
/// WHY ONE PLACE. There are exactly two things in this engine that say "this ground is built, not farmed": a tile
/// carrying a <c>Buildings</c>-layer tile (that layer is the engine's own "something stands here" -
/// <c>GameLocation.isTilePlaceable</c> asks it before anything may be placed, GameLocation.cs:7532), and a tile whose
/// own layer data carries <c>Type</c> = <c>Stone</c> or <c>Wood</c> (the two hard-surface words in the engine's ground
/// switch, <c>GameLocation.playTerrainSound</c>, GameLocation.cs:7560-7580: <c>Dirt</c>, <c>Stone</c>, <c>Grass</c>,
/// <c>Wood</c>). A second spelling of "is this paved" is the defect this file exists to remove, so the fixture that
/// must not hand-make dirt and the observation the companion reads both come through <see cref="Of"/>.
/// </para>
///
/// <para>
/// MEASURED `round98` (2026-11-23), and the reason the building is asked DIRECTLY. The ruined greenhouse's stone
/// doorstep is drawn at runtime on <c>Back</c> by <c>GreenhouseBuilding.DrawEntranceTiles</c>; the map's own tile under
/// it is ordinary farm soil with <c>Diggable</c>; and <c>GreenhouseBuilding.doesTileHaveProperty</c>
/// (GreenhouseBuilding.cs:60-97) answers <c>Type = "Stone"</c> for exactly the tiles it draws - columns <c>tileX +
/// humanDoor.X - 1 .. +1</c>, rows <c>tileY + humanDoor.Y + 1 .. +2</c>, which on the standard Farm (tile 25,10, 7x6,
/// humanDoor 3,5) is <c>27..29 x 16..17</c>. The LOCATION-level lookup only reaches a building while
/// <c>occupiesTile(tile, applyTilePropertyRadius: true)</c> covers the tile, and the porch's second row (17) sits two
/// rows below the footprint - so <c>29,17</c> reads as soil to every producer that asked the map, which is how a
/// cauliflower came to grow in a doorway. Asking each building's own <c>doesTileHaveProperty</c> removes that gate.
/// </para>
///
/// <para>
/// THE ANSWER IS A WORD THE ENGINE ALREADY USES, plus the structure that owns the ground when one does. <see
/// cref="Stone"/>/<see cref="Wood"/>/<see cref="Grass"/>/<see cref="Dirt"/> are the engine's own <c>Type</c> words
/// lower-cased; <see cref="Path"/> is a <c>Flooring</c> terrain feature, the player's own laid path (the engine reads
/// its footstep sound at GameLocation.cs:7582-7585); <see cref="Soil"/> is "the map declares no surface word on this
/// tile", which is a fact rather than a fallback - a tile the map cannot answer at all says
/// <see cref="NotMeasured"/> and why, because defaulting to soil is the same lie the fixture's <c>SpreadDirt</c> was.
/// </para>
/// </summary>
internal sealed class GroundSurface
{
    /// <summary>The map declares no surface word on this tile: ordinary ground, which is what a field is made of.</summary>
    internal const string Soil = "soil";

    /// <summary>The map's <c>Type=Grass</c>.</summary>
    internal const string Grass = "grass";

    /// <summary>The map's or a building's <c>Type=Stone</c>: the greenhouse doorstep and a stone deck.</summary>
    internal const string Stone = "stone";

    /// <summary>The map's or a building's <c>Type=Wood</c>: the wooden deck at a door.</summary>
    internal const string Wood = "wood";

    /// <summary>The map's <c>Type=Dirt</c>: the farm's own tillable ground.</summary>
    internal const string Dirt = "dirt";

    /// <summary>A <c>Flooring</c> terrain feature: ground the player paved.</summary>
    internal const string Path = "path";

    /// <summary>
    /// The prefix of an answer that is a REFUSAL TO GUESS: <c>not_measured:&lt;x&gt;,&lt;y&gt;:&lt;why&gt;</c>. It is a
    /// value of the same field rather than a missing field, so a tile nobody could measure reads as measured-and-blind
    /// instead of reading as soil.
    /// </summary>
    internal const string NotMeasured = "not_measured";

    /// <summary>
    /// The engine's two HARD-surface <c>Type</c> words, taken from the ground switch in
    /// <c>GameLocation.playTerrainSound</c> (GameLocation.cs:7560-7580). <c>Dirt</c> and <c>Grass</c> are the soil words
    /// and are deliberately absent: a field tile is not this predicate's business.
    /// </summary>
    private static readonly HashSet<string> PavedTypeWords = new(StringComparer.Ordinal) { "Stone", "Wood" };

    /// <summary>The tag the per-observation cost line starts with, so a run's log answers what this lookup cost.</summary>
    internal const string CostLinePrefix = "[ground-surface]";

    private readonly GameLocation? location;
    private readonly Dictionary<Vector2, Reading> measured = new();
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly Dictionary<string, int> answers = new(StringComparer.Ordinal);
    private int buildingQuestions;

    private GroundSurface(GameLocation? location) => this.location = location;

    /// <summary>
    /// One observation's reading of one location. THE CACHE LIVES EXACTLY THIS LONG: a new call is a new reading, so no
    /// answer outlives the snapshot it was taken for, and two families in one snapshot share one measurement. A null
    /// location (the frame between worlds) measures nothing and says so per tile rather than reading as soil.
    /// </summary>
    internal static GroundSurface Of(GameLocation? location) => new(location);

    /// <summary>How many tiles this reading was asked about. Reported beside the cost, because a cost over nothing is zero.</summary>
    internal int TilesMeasured => this.measured.Count;

    /// <summary>
    /// What the ground at this tile is - the cached answer, measured at most once per tile per observation.
    /// </summary>
    internal Reading At(int x, int y)
    {
        Vector2 tile = new(x, y);
        if (this.measured.TryGetValue(tile, out Reading known))
            return known;
        Reading reading = this.Measure(x, y);
        this.measured[tile] = reading;
        this.answers[reading.Route] = this.answers.TryGetValue(reading.Route, out int seen) ? seen + 1 : 1;
        return reading;
    }

    /// <summary>
    /// The surface word for this tile: a member of this type's vocabulary, or
    /// <c>not_measured:&lt;x&gt;,&lt;y&gt;:&lt;why&gt;</c> when the engine cannot answer.
    /// </summary>
    internal string Describe(int x, int y) => this.At(x, y).Surface;

    /// <summary>
    /// Why this tile is PAVED rather than soil - the route that said so, so the caller can print WHICH predicate fired -
    /// or null when the tile is soil or grass. This is the fixture's half of the same reading.
    /// </summary>
    internal string? Paving(int x, int y)
    {
        Reading reading = this.At(x, y);
        return reading.Paved ? reading.Route : null;
    }

    /// <summary>
    /// The one line an observation logs: what it cost and how the tiles divided. A lookup nobody can price is a lookup
    /// that grows until a player feels it, and the game thread is where it would be felt.
    ///
    /// <para>
    /// MEASURED (headless harness, Debug build, the round98 world: one greenhouse, a 13x13 window): <c>0.093 ms</c> for
    /// 169 tiles once the code is warm, and <c>0.116 ms</c> for sixteen further passes over the same 169 - the cache makes
    /// a second family's questions free. The FIRST call in a fresh process read <c>248.6 ms</c>, which is the engine
    /// methods this touches being JITted for the first time, not the walk: in the game those paths run every frame.
    /// </para>
    /// </summary>
    internal string CostLine()
    {
        string histogram = this.answers.Count == 0
            ? "none"
            : string.Join(
                "|",
                this.answers.OrderBy(entry => entry.Key, StringComparer.Ordinal)
                    .Select(entry => $"{entry.Key}={entry.Value.ToString(CultureInfo.InvariantCulture)}"));
        var line = new StringBuilder(CostLinePrefix);
        return line
            .Append(" location=").Append(this.location?.NameOrUniqueName ?? "none")
            .Append(";tiles=").Append(this.measured.Count.ToString(CultureInfo.InvariantCulture))
            .Append(";building_questions=").Append(this.buildingQuestions.ToString(CultureInfo.InvariantCulture))
            .Append(";answers=").Append(histogram)
            .Append(";ms=").Append(this.clock.Elapsed.TotalMilliseconds.ToString("0.000", CultureInfo.InvariantCulture))
            .ToString();
    }

    /// <summary>
    /// The lookup itself, in the engine's own precedence: the structure that covers the tile first
    /// (<c>GameLocation.doesTileHaveProperty</c> asks buildings before furniture and the map, GameLocation.cs:13157-13193),
    /// then the map's own words, then the <c>Buildings</c> layer, and soil only when the map declares nothing.
    /// </summary>
    private Reading Measure(int x, int y)
    {
        if (this.location is null)
            return Unmeasured(x, y, "no_location");
        if (this.location.map is null)
            return Unmeasured(x, y, "no_map");
        if (!this.location.isTileOnMap(new Vector2(x, y)))
            return Unmeasured(x, y, "off_map");
        // The player's own laid path: a Flooring terrain feature, which the engine reads for its footstep sound
        // (GameLocation.cs:7582-7585). Asked before the map because it is what the tile IS, and a tile holds one
        // terrain feature so no dirt can be standing on a path.
        if (this.location.terrainFeatures.TryGetValue(new Vector2(x, y), out StardewValley.TerrainFeatures.TerrainFeature? feature)
            && feature is StardewValley.TerrainFeatures.Flooring)
            return new Reading(Path, null, "path", paved: true);
        // The building's OWN answer, asked directly rather than through the location: the greenhouse's doorstep is
        // painted at runtime and its second row is outside the property radius the location-level lookup stops at.
        foreach (Building building in this.location.buildings)
        {
            if (building.isMoving)
                continue;
            this.buildingQuestions++;
            string value = "";
            if (!building.doesTileHaveProperty(x, y, "Type", "Back", ref value) || value.Length == 0)
                continue;
            string owner = building.buildingType.Value;
            return new Reading(Word(value), owner, $"building_type:{value}@{owner}", PavedTypeWords.Contains(value));
        }
        if (this.location.doesTileHaveProperty(x, y, "Type", "Back") is { Length: > 0 } word)
            return new Reading(Word(word), null, $"back_type:{word}", PavedTypeWords.Contains(word));
        if (this.location.hasTileAt(x, y, "Buildings"))
        {
            // Built ground. The layer's own Type is a word when the map declares one, and its absence is NOT soil:
            // something stands here and nothing said what it is made of.
            string? built = this.location.doesTileHaveProperty(x, y, "Type", "Buildings");
            return built is { Length: > 0 }
                ? new Reading(Word(built), null, "buildings_layer", PavedTypeWords.Contains(built))
                : Unmeasured(x, y, "buildings_layer_without_surface_word", route: "buildings_layer", paved: true);
        }
        return new Reading(Soil, null, "none", paved: false);
    }

    private static Reading Unmeasured(int x, int y, string why, string route = "not_measured", bool paved = false) =>
        new($"{NotMeasured}:{x},{y}:{why}", null, route, paved);

    /// <summary>An engine word as the wire spells it: the ground words are lower-cased, and nothing is translated away.</summary>
    private static string Word(string engineWord) => engineWord.ToLowerInvariant();

    /// <summary>
    /// One tile's ground: the word, the building that owns it when one does, and the route that answered - so a reader
    /// can tell <c>stone</c> on a map tile from <c>stone</c> on a greenhouse doorstep.
    /// </summary>
    internal readonly struct Reading
    {
        internal Reading(string surface, string? owner, string route, bool paved)
        {
            this.Surface = surface;
            this.Owner = owner;
            this.Route = route;
            this.Paved = paved;
        }

        /// <summary>A member of the vocabulary above, or <c>not_measured:&lt;x&gt;,&lt;y&gt;:&lt;why&gt;</c>.</summary>
        internal string Surface { get; }

        /// <summary>The building type whose own tile data answered (<c>Greenhouse</c>), or null when the map did.</summary>
        internal string? Owner { get; }

        /// <summary>Which question fired: <c>path</c>, <c>building_type:Stone@Greenhouse</c>, <c>back_type:Dirt</c>, <c>buildings_layer</c>, <c>none</c>.</summary>
        internal string Route { get; }

        /// <summary>Whether the ground is built rather than farmed - the fact a fixture may not hand-make dirt over.</summary>
        internal bool Paved { get; }
    }
}
