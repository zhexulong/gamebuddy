using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// What a fixture may call SOIL - asked of the map and of the engine, never assumed - and the one place a fixture takes
/// back the dirt it spread over ground that is not soil.
///
/// <para>
/// MEASURED `round98` (2026-11-23): the jodi-harvest ladder's <c>SpreadDirt</c> + <c>SpreadSeeds 474</c> +
/// <c>GrowCrops 12</c> grew a RIPE cauliflower on <c>29,17</c> - the bottom-right tile of a 3x2 stone doorstep - and the
/// companion then harvested it (<c>plan_506</c>) and sowed cauliflower seed on the bare <c>HoeDirt</c> it left
/// (<c>plan_507</c>), because the world told her it was empty tilled ground. It was: the fixture had made it so.
/// <c>HoeDirt</c> on a doorstep is not a state the engine ever produces, so a fixture may not produce it either, and the
/// fixtures that spread dirt by debug command need the paving taken back out of the world they just built.
/// </para>
///
/// <para>
/// THE PREDICATE IS <see cref="GroundSurface"/>, and it is not spelled here. The lookup - which building covers a tile,
/// what the map's own <c>Type</c> word says, whether the engine's <c>Buildings</c> layer stands on it - is the SAME
/// reading the observation publishes to the companion, so the fixture and the world she reads cannot disagree about
/// what is paved. This type keeps only the two things a fixture does with that answer: refuse to hand-make dirt on it,
/// and take dirt it already spread back off.
/// </para>
/// </summary>
internal static class FixtureGround
{
    /// <summary>
    /// The line one fixture setup prints after taking its own dirt back off paved ground, so the next run's log answers
    /// "did the porch stay bare" without reading the save.
    /// </summary>
    internal const string ClearedLogPrefix = "fixture_dirt_cleared_on_paved_ground";

    /// <summary>
    /// The refusal a fixture raises when it would hand-make dirt on ground that is not soil. Named rather than generic
    /// because the failure this replaces was silent: the world simply carried a tilled doorstep and the companion had no
    /// way to know the fixture was the liar.
    /// </summary>
    internal const string NotSoilRefusal = "fixture_tilled_a_tile_the_engine_would_not";

    /// <summary>
    /// Why this tile is a building's porch, walkway or deck rather than soil - as the route that named it, so the run can
    /// say WHICH predicate fired - or null when the tile is soil or grass.
    ///
    /// <para>
    /// ONE TILE, ONE READING: this is the fixture's door onto <see cref="GroundSurface"/>, and it exists because a caller
    /// asking about a single tile should not have to build an observation-scoped reader to do it.
    /// </para>
    /// </summary>
    internal static string? DescribePaving(GameLocation location, int x, int y) =>
        GroundSurface.Of(location).Paving(x, y);

    /// <summary>
    /// A fixture that wants soil at this tile, or the named refusal. Called where a fixture HAND-MAKES <c>HoeDirt</c>:
    /// the engine's own rule for a tilled tile is that the map says it is diggable, and a paved tile is the one place
    /// that answer and the world disagree.
    /// </summary>
    internal static void RequireSoil(GameLocation location, int x, int y)
    {
        if (DescribePaving(location, x, y) is { } paving)
            throw new InvalidOperationException($"{NotSoilRefusal}:{x},{y}:{paving}");
    }

    /// <summary>
    /// What this tile's ground IS, for a fixture that wants to state it in its own log - the same word the observation
    /// publishes, so a fixture and the companion never read two vocabularies for one tile.
    /// </summary>
    internal static string DescribeSurface(GameLocation location, int x, int y) =>
        GroundSurface.Of(location).Describe(x, y);

    /// <summary>
    /// Takes tilled dirt - and the crop standing on it - off every PAVED tile of the location, leaving every other
    /// tilled tile exactly where it was, and answers the line the setup logs.
    ///
    /// <para>
    /// THE CROP GOES FIRST, and that order is the point. <c>HoeDirt.crop</c> is the feature's own child: the engine
    /// reaches a crop only through the <c>HoeDirt</c> it was found in (<c>HoeDirt.performUseAction</c>,
    /// <c>HoeDirt.performToolAction</c>, <c>Crop.harvest</c> all start from the terrain feature). Removing the feature
    /// while a crop still hung off it would leave a living crop nothing can water, harvest or even see - a state no
    /// engine path produces. So the crop is destroyed through the engine's own entry point for it
    /// (<c>HoeDirt.destroyCrop(false)</c>, HoeDirt.cs:665-687, which the engine also calls when a crop is harvested), and
    /// only then is the dirt removed.
    /// </para>
    /// </summary>
    internal static string ClearPavedDirt(GameLocation location)
    {
        GroundSurface surfaces = GroundSurface.Of(location);
        List<string> cleared = new();
        Dictionary<string, int> byPredicate = new(StringComparer.Ordinal);
        int cropsRemoved = 0;
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs.ToArray())
        {
            if (pair.Value is not StardewValley.TerrainFeatures.HoeDirt dirt)
                continue;
            int x = (int)pair.Key.X;
            int y = (int)pair.Key.Y;
            if (surfaces.Paving(x, y) is not { } predicate)
                continue;
            if (dirt.crop is not null)
            {
                dirt.destroyCrop(showAnimation: false);
                cropsRemoved++;
            }
            location.terrainFeatures.Remove(pair.Key);
            cleared.Add($"{x},{y}");
            byPredicate[predicate] = byPredicate.TryGetValue(predicate, out int seen) ? seen + 1 : 1;
        }

        string predicateText = byPredicate.Count == 0
            ? "none"
            : string.Join(
                "|",
                byPredicate.OrderBy(entry => entry.Key, StringComparer.Ordinal)
                    .Select(entry => $"{entry.Key}={entry.Value}"));
        return $"{ClearedLogPrefix}: tiles={cleared.Count};crops_removed={cropsRemoved};predicate={predicateText};"
            + $"cleared={(cleared.Count == 0 ? "none" : string.Join("|", cleared))};location={location.NameOrUniqueName}";
    }
}
