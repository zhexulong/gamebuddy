using System.Text.Json.Serialization;

namespace GameBuddy.Stardew.Core.Models;

/// <summary>
/// The two transition rows this wire publishes - a map's <c>warps</c> and its <c>doorTargets</c> - together, because
/// they are one shape and one question ("where does this tile take me") asked of two tables.
///
/// <para>
/// They live here rather than beside the rest of the protocol models because each now carries a fact of its own: the
/// accessibility verdict on a warp, and the trading window the map declares on a door. Both are optional and LAST, and
/// the Mod's serializer omits a null member (WhenWritingNull), so ABSENT is a measurement
/// (<c>BridgeWarp.Accessible</c>: not measured, never <c>false</c>) and never a default.
/// </para>
///

/// <summary>
/// One exit the CURRENT location declares, published so the Agent can choose a real hop
/// instead of probing. <see cref="Accessible"/> is the leg's own survival of the engine's
/// accessibility gate (<c>Game1.isLocationAccessible(targetLocation)</c>, the same gate
/// <c>TryCreateCurrentOrdinaryWarpTopology</c> applies at
/// <c>game1navigationworldsource.cs:135</c>). Optional and LAST: the Mod's serializer omits
/// a null member (WhenWritingNull), so ABSENT means NOT MEASURED and must never be read as
/// <c>false</c>.
/// </summary>
public sealed record BridgeWarp(
    int SourceX,
    int SourceY,
    string TargetLocation,
    int TargetX,
    int TargetY,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? Accessible = null
);

/// <summary>
/// One doorway of this map: the tile it is clicked on, and where it leads.
///
/// <para>
/// <c>OpensAt</c>/<c>ClosesAt</c> are the trading window the MAP declares for this tile, in the engine's own 24h minutes -
/// <c>LockedDoorWarp &lt;x&gt; &lt;y&gt; &lt;location&gt; &lt;openTime&gt; &lt;closeTime&gt;</c> (GameLocation.cs:9537-9544 reads the same two
/// tokens, and <c>lockedDoorWarp</c> :10362-10368 quotes them back to the player as
/// <c>Strings\\Locations:LockedDoor_OpenRange</c>). Published so the hour arrives with the door instead of only after a
/// refusal: measured round96, a companion walked to Pierre's at 08:00 twice and the only place the 9:00~21:00 sign
/// existed was inside the <c>door_gate_refused</c> receipt. See <see cref="BridgeShopTarget"/> for the same pair on a
/// counter.
/// </para>
/// <para>
/// <c>HoursUnknown</c> is the not-measured half: present ONLY when the tile declares a window this reader could not
/// state, so ABSENT means "this doorway declares no hours at all" (a plain warp has none) and is never read as a window.
/// A wrong hour is worse than none.
/// </para>
/// <para>
/// WHAT IS DELIBERATELY NOT RESTATED. The engine's gate is wider than the window: <c>lockedDoorWarp</c> also honours the
/// town key, the SeedShop Wednesday rule, <c>willyHours</c>' 800 opening and year-1 green rain
/// (GameLocation.cs:10321-10366). Those are engine CODE, not map data, and the Mod does not transcribe them - the door's
/// own dialogue stays the verdict, and this row only states the number the sign would quote.
/// </para>
/// </summary>
public sealed record BridgeDoor(
    int SourceX,
    int SourceY,
    string TargetLocation,
    int TargetX,
    int TargetY,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? OpensAt = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? ClosesAt = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? HoursUnknown = null
);
