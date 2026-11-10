using System.Globalization;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.TerrainFeatures;

namespace GameBuddy.Stardew;

/// <summary>
/// One rectangle of the actor's location, answered in one round trip.
///
/// <para>
/// The published soil family is a square window around the actor with a cap, and the tasks this companion is given have
/// shapes: measured round42, she was asked for a 3x20 patch and received a 7x8 blob at 55% density, because the only
/// question she could ask was "what soil is near me". A planner that cannot ask "what is at (44..46, 12..31)" plans
/// from what it happened to see, which is how a strip becomes a blob.
/// </para>
/// <para>
/// It is a QUERY, not an action: no receipt, no postcondition, no program node, and no capability gate - the answer is a
/// reading of the world the actor is already standing in. Every fact in a row is owned by exactly one function, named
/// once in <see cref="PublishedFacts"/>: <c>tillable</c> is the predicate the soil discovery itself calls,
/// <c>passable</c> is the wrapper over the pathfinder's own step test, and the rest are the engine's stored state for the
/// tile. A fact this class computed a second way would be a second answer to a question the game already answers.
/// </para>
/// </summary>
internal static class TileAreaQuery
{
    /// <summary>
    /// The largest rectangle one answer carries, in tiles, and the only bound this query has: over it the answer REFUSES
    /// by name rather than truncating, because a 3x20 strip is 60 tiles and a bound that silently cut it would be the
    /// same defect one layer down.
    /// </summary>
    internal const int AreaLimit = 100;

    /// <summary>The bound on one coordinate and one side of the rectangle, shared with the wire validators on both sides.</summary>
    internal const int CoordinateLimit = 1000;

    /// <summary>
    /// Every fact a row publishes, and the ONE function that owns it.
    ///
    /// <para>
    /// This table is the declaration <c>tools/audit-stardew-discovery-channels.mjs</c> reads against the wire: a field
    /// added to the row without an owner here is a finding, and an owner that no longer exists is a finding. The
    /// <c>SharedWith</c> column names the OTHER publication that must be computed from the same owner - the soil
    /// discovery calls <see cref="ExecutionManager.IsTillableTile"/> for the same tiles this query calls it for, so
    /// "tillable here" and "soil there" cannot become two different questions.
    /// </para>
    /// </summary>
    internal static readonly (string Fact, string Owner, string? SharedWith)[] PublishedFacts =
    {
        ("x", "TileAreaQuery.DescribeTile", null),
        ("y", "TileAreaQuery.DescribeTile", null),
        ("tillable", "ExecutionManager.IsTillableTile", "ExecutionManager.DiscoverSoilTiles"),
        ("occupant", "ExecutionManager.DescribeTileOccupant", null),
        ("hoed", "TileAreaQuery.DescribeTile", null),
        ("watered", "TileAreaQuery.DescribeTile", null),
        ("crop", "TileAreaQuery.DescribeTile", null),
        ("passable", "StardewBodyController.IsWalkableTile", null),
    };

    /// <summary>
    /// The answer to one rectangle, decided in a fixed order so a refusal never depends on the world it could not read:
    /// a malformed rectangle, then the area bound, then whether there is a world, then the map's own edges.
    ///
    /// <para>
    /// The actor is a parameter rather than a read of <c>Game1.player</c>, for the same reason
    /// <see cref="ExecutionManager.DiscoverSoilTiles"/> takes it: the projection is then driveable against a built
    /// world, and "which tiles" stays a question about the argument instead of about process state.
    /// </para>
    /// </summary>
    internal static BridgeTileAreaQueryResult Answer(Farmer? actor, int x, int y, int w, int h, int revision)
    {
        if (w < 1 || h < 1)
            return Refused("invalid_rectangle", $"inspect_tiles_invalid_rectangle:{Text(w)}x{Text(h)}", x, y, w, h, revision);

        if ((long)w * h > AreaLimit)
            return Refused("area_too_large", $"inspect_tiles_area_too_large:{Text(AreaLimit)}:{Text(w)}x{Text(h)}", x, y, w, h, revision);

        GameLocation? location = actor?.currentLocation;
        if (actor is null || location is null)
            return Refused("world_unavailable", "inspect_tiles_world_unavailable", x, y, w, h, revision);

        List<string> outside = OutsideCorners(location, x, y, w, h, out string bounds);
        if (outside.Count > 0)
            return Refused("off_map", $"inspect_tiles_off_map:{string.Join(",", outside)}:map={bounds}", x, y, w, h, revision);

        List<BridgeTileAreaRow> rows = new(w * h);
        for (int tileY = y; tileY < y + h; tileY++)
            for (int tileX = x; tileX < x + w; tileX++)
                rows.Add(DescribeTile(location, actor, tileX, tileY));

        return new BridgeTileAreaQueryResult(
            "answered",
            null,
            x,
            y,
            w,
            h,
            location.NameOrUniqueName,
            revision,
            AreaLimit,
            rows,
            Omitted: w * h - rows.Count);
    }

    /// <summary>
    /// One tile's facts, read once each: the <c>HoeDirt</c> is fetched a single time so <c>hoed</c>, <c>watered</c> and
    /// <c>crop</c> cannot describe three different readings of one tile.
    /// </summary>
    private static BridgeTileAreaRow DescribeTile(GameLocation location, Farmer actor, int x, int y)
    {
        HoeDirt? soil = location.GetHoeDirtAtTile(new Vector2(x, y));
        return new BridgeTileAreaRow(
            X: x,
            Y: y,
            Tillable: ExecutionManager.IsTillableTile(location, x, y),
            Occupant: ExecutionManager.DescribeTileOccupant(location, x, y),
            Hoed: soil is not null,
            Watered: soil is not null && soil.state.Value == HoeDirt.watered,
            Crop: soil?.crop is not null,
            Passable: StardewBodyController.IsWalkableTile(location, actor, new Vector2(x, y)));
    }

    /// <summary>
    /// The named edges of the rectangle that fall outside the map's own bounds, and the map size they were measured
    /// against.
    ///
    /// <para>
    /// Naming the CORNER is what lets a caller repair the request: "off the map" alone leaves it guessing whether to
    /// move the origin, shrink the rectangle or ask a different location. The map is the one authority on its own size,
    /// and a rectangle that starts on the map and runs off the east edge satisfies the area bound while describing
    /// ground that does not exist.
    /// </para>
    /// </summary>
    private static List<string> OutsideCorners(GameLocation location, int x, int y, int w, int h, out string bounds)
    {
        int width = location.map.Layers[0].LayerWidth;
        int height = location.map.Layers[0].LayerHeight;
        bounds = $"{Text(width)}x{Text(height)}";
        List<string> corners = new(2);
        if (x < 0) corners.Add("west");
        if (y < 0) corners.Add("north");
        if ((long)x + w > width) corners.Add("east");
        if ((long)y + h > height) corners.Add("south");
        return corners;
    }

    private static BridgeTileAreaQueryResult Refused(
        string status,
        string detail,
        int x,
        int y,
        int w,
        int h,
        int revision) =>
        new(status, detail, x, y, w, h, null, revision, AreaLimit, null, Omitted: 0);

    private static string Text(int value) => value.ToString(CultureInfo.InvariantCulture);
}
