namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// One Buildings-layer tile index inside a mine level, and the kind of fixed interaction point that
/// index IS.
///
/// <para>
/// The index is read exactly the way <c>MineShaft.checkAction</c> reads it
/// (<c>MineShaft.cs:3057</c>: <c>switch (getTileIndexAt(tileLocation, "Buildings", "mine"))</c>), so
/// this table is a projection of that dispatch rather than a second opinion about it.
/// <c>FixedInteractionPointMineTileSourceShapeTests</c> derives each expectation from the engine's
/// own <c>case</c> body and fails by line when the game renumbers a ladder.
/// </para>
/// </summary>
public sealed record MineShaftFixedTile(int TileIndex, string Kind);

/// <summary>
/// The CLOSED vocabulary of location-fixed interaction points, and the mine tile indices that
/// belong to it.
///
/// <para>
/// A location's fixed interaction points (a mine level's ladders, a shop counter, a television) are
/// map topology, not entities: they are neither in <c>location.warps</c> nor in
/// <c>location.objects</c>, so no radius-bounded entity discovery can ever publish them and no
/// amount of walking toward them makes them appear. Measured 2026-11-04: a companion that entered a
/// mine level was published <c>warps: 0</c>, <c>doorTargets: 0</c> and no ladder it could name, and
/// stayed there until it passed out.
/// </para>
///
/// <para>
/// The vocabulary is mirrored on the wire (<c>protocol/bridge-v1.schema.json</c>
/// <c>$defs/fixedInteractionPoint.properties.kind.enum</c>) and in the Host's predicate. The schema
/// is the authority: <c>FixedInteractionPointKindsTests</c> reads the enum out of it and compares it
/// with <see cref="All"/>, so a token added on one side alone fails by name.
/// </para>
/// </summary>
public static class FixedInteractionPointKinds
{
    /// <summary>Tile 112 opens the floor list (<c>MineShaft.cs:3066-3070</c>).</summary>
    public const string MineElevator = "mine_elevator";

    /// <summary>Tile 115 asks the exit question (<c>MineShaft.cs:3073-3080</c>).</summary>
    public const string MineLadderUp = "mine_ladder_up";

    /// <summary>Tile 173 descends a level (<c>MineShaft.cs:3083-3084</c>).</summary>
    public const string MineLadderDown = "mine_ladder_down";

    /// <summary>Tile 174 asks the shaft-jump question (<c>MineShaft.cs:3087-3094</c>).</summary>
    public const string MineShaftHole = "mine_shaft";

    /// <summary>A tile carrying an <c>Action</c> property on its Buildings layer entry.</summary>
    public const string ActionTile = "action_tile";

    /// <summary>A tile carrying a <c>TouchAction</c> property on its Back layer entry.</summary>
    public const string TouchActionTile = "touch_action_tile";

    /// <summary>Every kind the Mod may publish, in a stable order.</summary>
    public static readonly IReadOnlyList<string> All = Array.AsReadOnly(new[]
    {
        MineElevator,
        MineLadderUp,
        MineLadderDown,
        MineShaftHole,
        ActionTile,
        TouchActionTile,
    });

    /// <summary>
    /// The four Buildings-layer indices <c>MineShaft.checkAction</c> dispatches to a fixed interaction
    /// point, in the order the engine's own switch declares them.
    /// </summary>
    public static readonly IReadOnlyList<MineShaftFixedTile> MineShaftTiles = Array.AsReadOnly(new[]
    {
        new MineShaftFixedTile(112, MineElevator),
        new MineShaftFixedTile(115, MineLadderUp),
        new MineShaftFixedTile(173, MineLadderDown),
        new MineShaftFixedTile(174, MineShaftHole),
    });

    /// <summary>
    /// The kind a mine Buildings-layer tile index means, or null when it is not one of the fixed
    /// points this family publishes.
    ///
    /// <para>
    /// The SAME switch also handles 284 (the calico statue), 194 (a mine crate) and 315-317 (the
    /// shrine of challenge). Those are deliberately NOT mapped: they are decorations and optional
    /// rule toggles rather than the level's topology, and this family exists to make the way OUT of
    /// a place addressable. A run that needs one of them gets it from the tile's own <c>Action</c>
    /// property, which the action-tile scan publishes.
    /// </para>
    /// </summary>
    public static string? ForMineShaftTileIndex(int tileIndex)
    {
        foreach (MineShaftFixedTile tile in MineShaftTiles)
            if (tile.TileIndex == tileIndex)
                return tile.Kind;
        return null;
    }
}
