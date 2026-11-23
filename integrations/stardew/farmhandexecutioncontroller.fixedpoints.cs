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

    private const int MaximumFixedInteractionPointActionWordLength = 64;

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
    internal static bool TryDescribeFixedInteractionPoint(GameLocation location, int x, int y, out string kind, out string? actionWord)
    {
        kind = string.Empty;
        actionWord = null;
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

    private static string? PublishedActionWord(string propertyValue)
    {
        string? word = propertyValue.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        if (string.IsNullOrEmpty(word)) return null;
        return word.Length <= MaximumFixedInteractionPointActionWordLength ? word : null;
    }
}
