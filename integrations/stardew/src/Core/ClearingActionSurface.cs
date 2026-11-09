using System;
using System.Collections.Generic;
using System.Linq;
using GameBuddy.Stardew.Core.Policy;

namespace GameBuddy.Stardew.Core;

/// <summary>One published action that removes an occupant, with the price its own declaration states.</summary>
public sealed record FarmhandClearingOffer(string ActionId, FarmhandClearingCost Cost);

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
/// `clear_debris`, and which of the two the caller wants depends on which it can actually invoke. Each offer carries
/// the declaration's own price, so the caller weighs a dispatch against a route instead of guessing at one.
/// </para>
/// <para>
/// An occupant no row declares answers with an empty list, and the refusal says so in one word
/// (`no_published_action_clears:&lt;occupant&gt;`). That is the honest answer for a bush: `harvest_bush` HARVES a bush,
/// it does not clear a way through one, and it therefore declares no `Clears`.
/// </para>
/// </summary>
public static class ClearingActionSurface
{
    /// <summary>The declarations whose occupant kinds include <paramref name="occupant"/>, in catalog order.</summary>
    public static IReadOnlyList<FarmhandClearingOffer> ClearersOf(string occupant, IEnumerable<FarmhandActionRegistration> surface)
    {
        ArgumentNullException.ThrowIfNull(occupant);
        ArgumentNullException.ThrowIfNull(surface);
        return surface
            .Where(registration => registration.Descriptor?.Clears is { } clears
                && clears.Occupants.Contains(occupant, StringComparer.Ordinal))
            .Select(registration => new FarmhandClearingOffer(registration.ActionId, registration.Descriptor!.Clears!.Cost))
            .ToArray();
    }
}
