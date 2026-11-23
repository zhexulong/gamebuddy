using System;
using System.Globalization;
using StardewValley.GameData.Shops;

namespace GameBuddy.Stardew;

/// <summary>
/// The trading window a shop's OWN `Data/Shops` row declares, in the engine's own 24h minutes.
///
/// <para>
/// WHY IT EXISTS. Measured `round96`: a companion walked to Pierre's door at 08:00 and again after, and the hour she was
/// missing (9:00~21:00) existed only inside the `door_gate_refused` receipt the walk produced. A counter's window is the
/// same fact one subject over, and `shopTargets` published `stockCount` and every price without it. This reader is that
/// half, and it is deliberately a READER: it states what the entry says and refuses to infer anything the entry does not.
/// </para>
///
/// <para>
/// The two halves are separate functions because they answer two different questions - the window the entry declares,
/// and why a declared window could not be stated - and a row that mixed them would be a row whose reader has to guess
/// which half to believe.
/// </para>
/// </summary>
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// The trading window one owner entry declares, in the engine's own 24h minutes - or null when it cannot be stated.
    ///
    /// <para>
    /// THE ENGINE'S OWN SPELLING. <c>ShopOwnerData.Condition</c> is the game-state query <c>ShopBuilder.GetCurrentOwners</c>
    /// evaluates (<c>ShopBuilder.cs:209-212</c>), and vanilla writes a counter's hours into it as <c>TIME 900 1600</c> on
    /// the entry that RUNS the counter (<c>!TIME 900 1600</c> on the twin that only draws the <c>ClosedMessage</c>). The
    /// numbers are already the unit <c>Game1.timeOfDay</c> and <c>lockedDoorWarp</c>'s sign use, so nothing is converted.
    /// </para>
    /// <para>
    /// ONE SHAPE, AND ANYTHING ELSE IS NOT MEASURED. Only a lone <c>TIME a b</c> on an entry with no <c>ClosedMessage</c>
    /// is a window: that entry runs the counter and <c>TIME</c>'s arguments are the bounds it runs between. A negated
    /// clause, a day or season clause beside it, or two windows in one query are spellings whose meaning this reader
    /// would have to guess - and they publish <see cref="DeclaredWindowUnreadable"/> instead, because an hour the Mod
    /// inferred is worse than no hour at all.
    /// </para>
    /// </summary>
    internal static (int OpensAt, int ClosesAt)? DeclaredOwnerWindow(ShopOwnerData? owner)
    {
        if (owner is null || owner.ClosedMessage is not null)
            return null;
        string[] tokens = (owner.Condition ?? string.Empty).Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (tokens.Length != 3 || !string.Equals(tokens[0], "TIME", StringComparison.Ordinal))
            return null;
        return int.TryParse(tokens[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out int opensAt)
            && int.TryParse(tokens[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out int closesAt)
            && opensAt >= 0
            && closesAt > opensAt
            && closesAt <= 2400
            ? (opensAt, closesAt)
            : null;
    }

    /// <summary>
    /// Why an owner entry's DECLARED window could not be stated, or null when nothing is owed.
    ///
    /// <para>
    /// Owed only when the entry actually mentions <c>TIME</c>: a counter whose entry declares no hours (a stall, a menu
    /// open all day) owes nothing and must carry no field, because a row saying "hours unknown" on every shop would be
    /// the same silence as no field. When the entry DOES declare a window and <see cref="DeclaredOwnerWindow"/> could not
    /// state it, the reader is told the hour is missing rather than shown one the Mod invented.
    /// </para>
    /// </summary>
    internal static string? OwnerWindowUnknown(ShopOwnerData? owner)
    {
        if (owner is null || owner.ClosedMessage is not null || DeclaredOwnerWindow(owner) is not null)
            return null;
        foreach (string token in (owner.Condition ?? string.Empty).Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            if (string.Equals(token.TrimStart('!'), "TIME", StringComparison.Ordinal))
                return DeclaredWindowUnreadable;
        }
        return null;
    }
}
