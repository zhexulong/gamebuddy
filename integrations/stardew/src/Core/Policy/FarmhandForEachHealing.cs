using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>What a refused row's tile says it needs, in the words the answer already uses.</summary>
public enum FarmhandForEachClearanceOutcome
{
    /// <summary>
    /// The row keeps the refusal it already has: nothing stands on the tile, or the row has already dispatched the action
    /// that removes what does. A second swing at the same tile is not a heal, it is the same refusal twice.
    /// </summary>
    KeepRefusal = 1,

    /// <summary>One action removes the occupant, and it is the action to dispatch before the row is retried.</summary>
    Clear = 2,

    /// <summary>The occupant is named and NO published declaration removes it; <see cref="FarmhandForEachClearance.RefusalReasonCode"/> says so.</summary>
    NoPublishedActionClears = 3,
}

/// <summary>One refused row's answer about the thing standing on its tile.</summary>
public sealed record FarmhandForEachClearance(
    FarmhandForEachClearanceOutcome Outcome,
    string Occupant,
    FarmhandClearingOffer? Clearer,
    string? RefusalReasonCode);

/// <summary>
/// Which published action removes what stands on a tile, read from the catalogue's own `Clears` declarations.
///
/// <para>
/// WHY THIS EXISTS. A `for_each` pass decides a row once and dispatches ONE action on it, so a tile that carries something
/// the requested action cannot work is refused - and the refusal names the requested action's own complaint, not the thing
/// in the way. Measured `round44`: one pass over a strip answered `worked 34 · not_matched 26`, and the tiles it did not
/// work were the ones with something standing on them. The knowledge needed to open those tiles was already in the
/// catalogue (<see cref="FarmhandActionDescriptor.Clears"/> names, per action, the occupants it removes); the pass simply
/// never consulted it.
/// </para>
/// <para>
/// IT IS A JOIN AND NOT A TABLE. The occupant comes from the row the live world published (<see cref="OccupantField"/>) and
/// the clearing action comes from the declaration that names that occupant, so a declaration and its consequence stay one
/// edit: an action that stops accepting a weed stops being offered as the clearer of one. A kind-to-action table beside the
/// catalogue is the defect <see cref="GameBuddy.Stardew.Core.ClearingActionSurface"/> exists to remove.
/// </para>
/// <para>
/// AN OCCUPANT NO DECLARATION NAMES IS REFUSED BY NAME, never guessed at and never cleared:
/// <c>no_published_action_clears:&lt;occupant&gt;</c> is the honest answer, and it is the one that tells the next pass what
/// to do about it.
/// </para>
/// </summary>
public static class FarmhandForEachHealing
{
    /// <summary>
    /// The row field that carries the ENGINE's own name for what stands on the tile (`weed`, `stone`, `tree`, ...).
    ///
    /// It is spelled in <see cref="FarmhandClearingDeclaration.Occupants"/>' own vocabulary, so a declaration is read
    /// against a live row with no translation step between them.
    /// </summary>
    public const string OccupantField = "occupant";

    /// <summary>A tile nothing stands on: there is nothing to clear and nothing to refuse.</summary>
    public const string NoOccupant = "none";

    /// <summary>The refusal an occupant no published declaration removes reports.</summary>
    public const string NoPublishedActionClears = "no_published_action_clears";

    /// <summary>What one healed row says it removed, before the action it was asked for ran.</summary>
    public static string HealedToken(string occupant, string clearingAction)
    {
        ArgumentNullException.ThrowIfNull(occupant);
        ArgumentNullException.ThrowIfNull(clearingAction);
        return string.Create(CultureInfo.InvariantCulture, $"healed={occupant}:{clearingAction}");
    }

    /// <summary>The row's occupant, or <see cref="NoOccupant"/> when the row carries none this pass can name.</summary>
    public static string OccupantOf(IReadOnlyDictionary<string, FarmhandForEachValue> fields)
    {
        ArgumentNullException.ThrowIfNull(fields);
        return fields.TryGetValue(OccupantField, out FarmhandForEachValue? value) && value?.Text is { Length: > 0 } text
            ? text
            : NoOccupant;
    }

    /// <summary>Every published action whose own declaration removes <paramref name="occupant"/>, in catalogue order.</summary>
    public static IReadOnlyList<FarmhandClearingOffer> DeclaredClearersOf(string occupant)
    {
        ArgumentNullException.ThrowIfNull(occupant);
        return ClearingActionSurface.ClearersOf(occupant, FarmhandActionCatalog.Registrations);
    }

    /// <summary>
    /// What the tile under a REFUSED row says: the one action that removes what stands there, or the refusal that says
    /// nothing published does.
    ///
    /// <para>
    /// THE CLEARING ACTION IS POLICY-CHECKED LIKE EVERY OTHER ROW. It is dispatched through the same dispatch table a single
    /// action uses, so a clearer the live policy disables is refused by that gate - but the pass prefers a clearer the live
    /// policy DOES enable, because otherwise the first declaration in catalogue order would hide every later one and a
    /// declaration nothing can ever reach is a promise the catalogue cannot keep.
    /// </para>
    /// <para>
    /// It answers <see cref="FarmhandForEachClearanceOutcome.KeepRefusal"/> when the refused action is ITSELF one of the
    /// occupant's clearers (`break_rock` on a stone, `cut_weeds` on a weed): the row already swung the right tool, and its
    /// own reason is the thing to report.
    /// </para>
    /// </summary>
    public static FarmhandForEachClearance ClearanceFor(
        IReadOnlyDictionary<string, FarmhandForEachValue> fields,
        string requestedActionId,
        Func<string, bool> isActionEnabled)
    {
        ArgumentNullException.ThrowIfNull(requestedActionId);
        ArgumentNullException.ThrowIfNull(isActionEnabled);
        string occupant = OccupantOf(fields);
        if (string.Equals(occupant, NoOccupant, StringComparison.Ordinal))
            return new FarmhandForEachClearance(FarmhandForEachClearanceOutcome.KeepRefusal, occupant, null, null);

        IReadOnlyList<FarmhandClearingOffer> declared = DeclaredClearersOf(occupant);
        if (declared.Count == 0)
            return new FarmhandForEachClearance(
                FarmhandForEachClearanceOutcome.NoPublishedActionClears,
                occupant,
                null,
                $"{NoPublishedActionClears}:{occupant}");
        if (declared.Any(offer => string.Equals(offer.ActionId, requestedActionId, StringComparison.Ordinal)))
            return new FarmhandForEachClearance(FarmhandForEachClearanceOutcome.KeepRefusal, occupant, null, null);

        // A clearer the live policy disables is still the honest thing to name: its dispatch refuses with the policy's own
        // reason (`row_action_not_enabled:<action>`), which is a fact about the tile the caller can act on. Falling back to
        // `no_published_action_clears` would claim the catalogue has no answer when it has one that is switched off.
        FarmhandClearingOffer clearer = declared.FirstOrDefault(offer => isActionEnabled(offer.ActionId)) ?? declared[0];
        return new FarmhandForEachClearance(FarmhandForEachClearanceOutcome.Clear, occupant, clearer, null);
    }
}
