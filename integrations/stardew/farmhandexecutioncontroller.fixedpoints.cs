using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using StardewValley;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    /// <summary>The Buildings-layer tile sheet <c>MineShaft.checkAction</c> filters by (<c>MineShaft.cs:3057</c>).</summary>
    private const string MineShaftTileSheetId = "mine";

    /// <summary>
    /// The cap on published fixed interaction points.
    ///
    /// <para>
    /// Read by <c>tools/check-stardew-snapshot-family-bounds.mjs</c> as the producer's ceiling for
    /// <c>fixedInteractionPoints</c>, and it must stay at or below the Host's <c>maxItems</c> for that field:
    /// one entry past the ceiling closes the bridge with <c>invalid_snapshot</c>.
    /// </para>
    /// </summary>
    internal const int MaximumFixedInteractionPoints = 64;

    /// <summary>The longest engine word <c>fixedInteractionPoints[].actionWord</c> may quote.</summary>
    private const int MaximumFixedInteractionPointActionWordLength = 64;

    /// <summary>
    /// The map's OWN fixed interaction points, whole-map: every tile the engine itself dispatches an
    /// interaction on, wherever it stands.
    ///
    /// <para>
    /// This family exists because reachability and topology are different facts. Every other discovery
    /// function here bounds its scan by <see cref="ExecutionManager.TargetDiscoveryRadius"/>, which is right
    /// for an entity - a watering can reaches one tile, so a crop six tiles away is a plan, not a target.
    /// It is wrong for a fixed point: a mine level's ladder-up is a Buildings-layer TILE INDEX, not an
    /// entity and not a <c>warp</c>, so no radius ever reaches it from anywhere, and no walk brings it
    /// inside one. Measured 2026-11-04: a companion in a mine level was published <c>warps: 0</c>,
    /// <c>doorTargets: 0</c> and no ladder it could name, and stayed until it passed out.
    /// </para>
    ///
    /// <para>
    /// Read-only: it names what the map offers, and no action is added beside it. A caller that wants one
    /// of these points still walks there and uses the action that already owns the tile.
    /// </para>
    ///
    /// <para>
    /// Order is the map's own row-major order, not nearest-first, because this list is topology rather
    /// than a walking order: a nearest-first list would reshuffle on every step and re-spend the reader's
    /// attention on a set that did not change. <paramref name="omitted"/> counts the points the cap left
    /// out, so a truncated list says so instead of reading as the whole map.
    /// </para>
    /// </summary>
    internal static IReadOnlyList<BridgeFixedInteractionPoint> DiscoverFixedInteractionPoints(Farmer player, out int omitted)
    {
        omitted = 0;
        GameLocation? location = player.currentLocation;
        if (location?.map is null) return Array.Empty<BridgeFixedInteractionPoint>();
        if (location.map.Layers.Count == 0) return Array.Empty<BridgeFixedInteractionPoint>();
        int width = location.map.Layers[0].LayerWidth;
        int height = location.map.Layers[0].LayerHeight;
        List<BridgeFixedInteractionPoint> result = new();
        for (int y = 0; y < height; y++)
        for (int x = 0; x < width; x++)
        {
            if (!TryDescribeFixedInteractionPoint(location, x, y, out string kind, out string? actionWord)) continue;
            if (result.Count < MaximumFixedInteractionPoints) result.Add(new BridgeFixedInteractionPoint(x, y, kind, actionWord));
            else omitted++;
        }

        return result;
    }

    /// <summary>
    /// What the map fixes at one tile, or false when it fixes nothing there.
    ///
    /// <para>
    /// Both sources are the engine's OWN reads rather than a second reading of the same map data:
    /// the Buildings-layer index is fetched through <c>GameLocation.getTileIndexAt</c> with the same
    /// tilesheet filter <c>MineShaft.checkAction</c> uses, and the two properties are fetched through
    /// <c>GameLocation.doesTileHaveProperty</c> on the layers the engine itself reads them from
    /// (<c>Action</c> on Buildings, <c>TouchAction</c> on Back - <c>GameLocation.cs:4225</c>). A tile
    /// that carries several of these publishes the first one in this order, so one coordinate is one
    /// point and the count means points rather than properties.
    /// </para>
    /// </summary>
    private static bool TryDescribeFixedInteractionPoint(GameLocation location, int x, int y, out string kind, out string? actionWord)
    {
        kind = string.Empty;
        actionWord = null;
        // The ladder index first: a mine level's ladder tile carries no tile property at all, so the
        // property reads below would report nothing for the one tile that matters most.
        string? mineKind = FixedInteractionPointKinds.ForMineShaftTileIndex(
            location.getTileIndexAt(x, y, "Buildings", MineShaftTileSheetId));
        if (mineKind is not null)
        {
            kind = mineKind;
            return true;
        }

        string? action = location.doesTileHaveProperty(x, y, "Action", "Buildings");
        if (action is not null)
        {
            kind = FixedInteractionPointKinds.ActionTile;
            actionWord = PublishedActionWord(action);
            return true;
        }

        string? touchAction = location.doesTileHaveProperty(x, y, "TouchAction", "Back");
        if (touchAction is not null)
        {
            kind = FixedInteractionPointKinds.TouchActionTile;
            actionWord = PublishedActionWord(touchAction);
            return true;
        }

        return false;
    }

    /// <summary>
    /// The engine's own first word of a tile-property value (<c>MinecartTransport</c> out of
    /// <c>MinecartTransport Default</c>), or null when there is no publishable word.
    ///
    /// <para>
    /// A word longer than the wire's bound is published as null rather than truncated to a corrupt
    /// token: the point's coordinate and kind are what an action addresses, and the word is the hint
    /// beside them. It is never a reason to refuse the whole snapshot.
    /// </para>
    /// </summary>
    private static string? PublishedActionWord(string propertyValue)
    {
        string? word = propertyValue.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        if (string.IsNullOrEmpty(word)) return null;
        return word.Length <= MaximumFixedInteractionPointActionWordLength ? word : null;
    }
}
