using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Navigation;

/// <summary>
/// Publishes one generation's destination directory as a flat, read-only list of names.
///
/// <para>
/// WHY THIS EXISTS AT ALL. Searching a destination needs no game thread, no engine object and no world state - it is text
/// matching over a name list - so the search belongs to the Host (`design/adr/0014-thin-stardew-mod.md`), and the second of
/// the ADR's three questions decides what is left here: the Mod is the only side that can read `Data/Locations`, the
/// world-map areas, `Data/Characters` and `Data/Shops`, so it publishes the facts and stops. Every name travels with WHERE
/// IT CAME FROM - the place's own label, the fallback-locale label, the spellings its row declares, its residents, its
/// shop's stock - and no weight travels with it: how much a resident's name counts towards a match is ranking, and ranking
/// is the Host's business.
/// </para>
/// <para>
/// WHY ONE HANDLE PER IDENTITY. A caller copies a candidate's `ref` into `navigate_to_destination`, and a handle names the
/// destination IDENTITY, not a spelling: the farm's water landmark declares the farm's identity on purpose so the existing
/// arrival semantics keep working, so two rows share one handle and both resolve to the same place. Minting one handle per
/// ROW instead would publish two handles for one place and make the arrival rule depend on which spelling the caller
/// copied.
/// </para>
/// </summary>
internal static class DestinationIndexPublication
{
    /// <summary>
    /// Rows one publication may carry.
    ///
    /// <para>
    /// The population is `Game1.locations`, which a real save holds in the tens (87 measured on an island-complete world).
    /// A modded world can raise it, and past this ceiling the answer is `destination_index_too_large` rather than a partial
    /// list: a directory missing a row makes the Host answer "no such place" for a place it holds, which is a false
    /// statement rather than an incomplete one. The Host bounds the frame separately
    /// (`host/src/protocol.ts` `DESTINATION_INDEX_ROW_LIMIT`); the two numbers exist because each side refuses a different
    /// thing.
    /// </para>
    /// </summary>
    internal const int MaximumDestinations = 512;

    internal static BridgeDestinationIndexResult Build(
        DerivedDestinationSet set,
        NavigationReferenceStore references,
        NavigationBindingContext context)
    {
        IReadOnlyList<NavigationDestination> destinations = set.SearchDestinations;
        if (destinations.Count > MaximumDestinations)
            return new BridgeDestinationIndexResult("blocked", "destination_index_too_large", null, null);

        Dictionary<string, string> referencesByIdentity = new(StringComparer.Ordinal);
        BridgeDestinationIndexRow[] rows = new BridgeDestinationIndexRow[destinations.Count];
        for (int index = 0; index < destinations.Count; index++)
        {
            NavigationDestination destination = destinations[index];
            if (!referencesByIdentity.TryGetValue(destination.CanonicalIdentity, out string? reference))
            {
                reference = references.IssueDestination(context, new NavigationDestinationBinding(
                    destination.ContentOwner,
                    destination.CanonicalIdentity,
                    set.Generation,
                    context.ObservationSequence));
                referencesByIdentity[destination.CanonicalIdentity] = reference;
            }
            rows[index] = new BridgeDestinationIndexRow(
                destination.CanonicalLabel,
                destination.ContextLabel,
                destination.FallbackLabel,
                destination.ExplicitAliases ?? Array.Empty<string>(),
                destination.RelatedNpcs ?? Array.Empty<string>(),
                destination.ServiceTerms ?? Array.Empty<string>(),
                reference);
        }
        return new BridgeDestinationIndexResult("index", "destination_index_published", set.Generation, rows);
    }
}
