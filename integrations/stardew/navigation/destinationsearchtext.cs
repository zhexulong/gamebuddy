using System.Globalization;
using System.Text;

namespace GameBuddy.Stardew.Navigation;

/// <summary>
/// The ONE spelling rule for a destination name, shared by every reader of the directory that runs on this side of the
/// wire.
///
/// <para>
/// MEASURED `plan_339`: `{kind:'label', label:'Farmhouse'}` answered <c>destination_selector_invalid</c> while the room sat
/// in the directory under <c>FarmHouse</c>, because two readers compared one table with two spellings of "equal". They now
/// compare with this one: `navigate_to_destination`'s label selector (<see cref="AcceptedNavigationExecution"/>) and the
/// Host's destination search, which states the same rule in TypeScript
/// (`host/src/stardew-destination-search.ts` `normalizeText`) because it is the side that answers `find_destination` now.
/// </para>
/// <para>
/// It is a normalization, not a search: case, width and separator runs are folded once, so an already-normalized name can be
/// normalized again safely. The tokenization that used to live beside it belonged to the index, and the index is the Host's
/// (`design/adr/0014-thin-stardew-mod.md`: searching needs no game thread, no engine object and no world state).
/// </para>
/// </summary>
internal static class DestinationSearchText
{
    internal static string Normalize(string? value)
    {
        if (string.IsNullOrEmpty(value))
            return string.Empty;
        StringBuilder builder = new();
        bool pendingSpace = false;
        foreach (Rune rune in value.Normalize(NormalizationForm.FormKC).ToLowerInvariant().EnumerateRunes())
        {
            UnicodeCategory category = Rune.GetUnicodeCategory(rune);
            if (Rune.IsWhiteSpace(rune) || category is UnicodeCategory.ConnectorPunctuation or UnicodeCategory.DashPunctuation or UnicodeCategory.OtherPunctuation)
            {
                pendingSpace = builder.Length > 0;
                continue;
            }
            if (pendingSpace)
            {
                builder.Append(' ');
                pendingSpace = false;
            }
            builder.Append(rune);
        }
        return builder.ToString().Trim();
    }
}
