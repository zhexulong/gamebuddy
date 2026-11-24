namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// ONE FACILITY PER SCOPE, OR THE NAMED ANSWER WHEN THE SCOPE HOLDS NONE OR SEVERAL.
///
/// <para>
/// WHY THIS IS A DIFFERENT QUESTION FROM A TILE-ADDRESSED TARGET. A tile-addressed action is answered by
/// <c>TileTargetMint</c>: her intent is the tile, and the identity of whatever stands on it is the executor's to read.
/// A good part of the catalogue is not addressed by a tile at all - the farm's shipping bin, the way out of a mine
/// floor, the counter a shop runs from - and there the caller names a SCOPE (what to ship, which floor she is on) while
/// the executor names the one facility in it. That only holds where the scope really does hold one, so the count is read
/// at execution and this type states what zero and two answer.
/// </para>
///
/// <para>
/// TWO CODES, BECAUSE THEY SEND THE CALLER TO TWO DIFFERENT PLACES. <c>facility_absent</c> says the scope offers nothing
/// to act on - the wrong map, a floor with no way out - and <c>facility_ambiguous</c> says it offers several and the
/// request did not say which. Collapsing them into one "not available" would leave a reader unable to tell "go
/// somewhere else" from "name which", and the second is a request the caller can still make.
/// </para>
///
/// <para>
/// WHICH FACILITY ACTION EARNS THE OMISSION IS THE ENGINE'S ANSWER, NOT A PREFERENCE, and four of the five were refused it
/// after being checked:
/// <list type="bullet">
/// <item><c>ship_item</c> - <c>Data/Buildings</c> carries a <c>Shipping Bin</c> row and <c>BuildingData</c> has no per-type
/// instance cap, so a farm can hold two bins; the id says which footprint the body walks to, even though every bin writes
/// the same shipment inventory (<c>Farm.getShippingBin</c>).</item>
/// <item><c>enter_mine</c> - the descent ladder (tile 173) is written at run time by two paths, one of them
/// (<c>MineShaft.doCreateLadderAt</c>) without the <c>ladderHasSpawned</c> guard the other has, so a floor can hold
/// two.</item>
/// <item><c>ride_minecart</c> - the id names a (station, destination) RIDE, so it is her intent rather than a facility the
/// executor could pick.</item>
/// <item><c>shop_purchase</c> - a room can hold several counters (one per open shop whose owner is present, plus one per
/// <c>DesertVendor</c> stall) and the engine has no "the counter she is at": only tile counters are radius-gated, while
/// <c>Utility.TryOpenShopMenu</c>'s room overload opens from anywhere.</item>
/// </list>
/// <c>use_mine_ladder</c> is the one that qualifies: <c>MineShaft.findLadder</c> keeps a single <c>tileBeneathLadder</c>
/// for tile 115, nothing at run time writes a 115, and <c>ExitMine_Leave</c> is a pure function of <c>mineLevel</c> - so
/// the way out is the FLOOR's, not a particular tile's, and the caller names the floor by standing on it.
/// </para>
/// </summary>
public static class SingletonFacility
{
    /// <summary>The way out of a mine floor: the level's own exit ladder (Buildings tile 115).</summary>
    public const string MineExitLadder = "mine_exit_ladder";

    /// <summary>The scope holds none of <paramref name="kind"/> at <paramref name="location"/>.</summary>
    public static string Absent(string kind, string location) => $"facility_absent:{kind}:{location}";

    /// <summary>The scope holds <paramref name="count"/> of <paramref name="kind"/> at <paramref name="location"/>.</summary>
    public static string Ambiguous(string kind, string location, int count) =>
        $"facility_ambiguous:{kind}:{location}:count={count}";

    /// <summary>
    /// The refusal a scope holding <paramref name="count"/> facilities is answered with, or null when it holds exactly
    /// one and there is nothing left for the caller to decide.
    /// </summary>
    public static string? RefusalFor(string kind, string location, int count) => count switch
    {
        0 => Absent(kind, location),
        1 => null,
        _ => Ambiguous(kind, location, count),
    };
}
