using System;
using System.Collections.Generic;
using System.Linq;
using GameBuddy.Stardew.Core.Policy;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// Which of the Mod's own actions can remove the thing standing in a route, read from the published action surface.
///
/// <para>
/// The clearing search already names the tile to remove and where to stand to hit it. What it cannot answer is which
/// ACTION does the hitting, and the alternative - a kind-to-action table living beside the catalog - is the two
/// spellings this file keeps paying for: the table would go on naming an action after that action's own declaration
/// stopped accepting the occupant. So the question is put to the surface: one action, one `Clears` declaration, and
/// this function is the join.
/// </para>
/// <para>
/// It answers with EVERY action that qualifies, in catalog order, because the surface is a set and picking one would be
/// a policy decision this function has no basis for: a rock is removed by `break_rock` and, when it is a clump, by
/// `clear_debris`, and which of the two the caller wants depends on which it can actually invoke.
/// </para>
/// </summary>
public static class ClearingActionSurface
{
    /// <summary>The actions whose declared occupant kinds include <paramref name="occupant"/>, in catalog order.</summary>
    public static IReadOnlyList<string> ActionsThatClear(string occupant, IEnumerable<FarmhandActionRegistration> surface)
    {
        ArgumentNullException.ThrowIfNull(occupant);
        ArgumentNullException.ThrowIfNull(surface);
        return surface
            .Where(registration => registration.Descriptor?.Clears is { } clears
                && clears.Contains(occupant, StringComparer.Ordinal))
            .Select(registration => registration.ActionId)
            .ToArray();
    }
}
