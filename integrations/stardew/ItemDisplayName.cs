using System;

namespace GameBuddy.Stardew;

/// <summary>
/// What a raw item value is called, or the reason this layer cannot name it - the one spelling both readers of such a
/// value share.
///
/// <para>
/// WHY ONE READER. `SpawnFishData` and `ShopItemData` both carry `ISpawnItemData.ItemId`, whose documented value is
/// "either a qualified item ID, or an item query like <c>ALL_ITEMS</c>" (<c>StardewValley.GameData.xml:1863-1865</c>), and
/// the engine's reader for it is <c>ItemRegistry.GetData</c>, which takes a qualified OR unqualified id and answers for
/// every item type (<c>ItemRegistry.cs:316-323</c>). The fish answer and the destination directory therefore land here, so
/// a name that is missing is missing in the same words on both surfaces.
/// </para>
///
/// <para>
/// A MISSING NAME IS STATED, NOT SILENT. `null` downstream reads as "this row names nothing", which is indistinguishable
/// from a reader that never looked. <see cref="UnresolvedPrefix"/> followed by the raw value says WHICH value went
/// unnamed, so a caller - or the player reading the answer - can go and look at it.
/// </para>
///
/// <para>
/// WHAT THE TESTS DO NOT PROVE, and why. The name arrives as an argument because it cannot be produced in this process:
/// <c>ItemRegistry.GetData</c> needs a content manager and answers null for every id without one, and the two fallbacks
/// throw (measured: <c>GetData("(O)128")</c> =&gt; null, <c>ItemQueryResolver.TryResolve</c> =&gt;
/// NullReferenceException, <c>GetDataOrErrorItem</c> =&gt; KeyNotFoundException "No item type definition found with ID
/// '(O)'"). So the tests assert the DECISION and the FALLBACK, and each call site is pinned to the engine reader with the
/// line cited. Nothing here proves that a retail item data row actually names a fish or a shop item.
/// </para>
/// </summary>
internal static class ItemDisplayName
{
    /// <summary>The one spelling of "this value was not named", immediately followed by the value itself.</summary>
    internal const string UnresolvedPrefix = "display_name_unresolved:";

    /// <summary>
    /// <paramref name="engineDisplayName"/> when the engine's reader answered one, else
    /// <see cref="UnresolvedPrefix"/> followed by <paramref name="rawId"/>.
    ///
    /// <para>
    /// <paramref name="rawId"/> is never rewritten on the way out: not sliced after its type tag, not retyped, not dropped.
    /// The engine's reader is the only thing that decides what a value names, so a caller that pre-digests the value is
    /// deciding by guessing - the defect that read <c>int.TryParse("(O)128")</c> as "this value is an item query".
    /// </para>
    /// </summary>
    internal static string Resolve(string? rawId, string? engineDisplayName) =>
        string.IsNullOrWhiteSpace(engineDisplayName) ? UnresolvedPrefix + (rawId ?? string.Empty) : engineDisplayName;

    /// <summary>Whether <paramref name="resolved"/> is a stated reason rather than a name.</summary>
    internal static bool IsReason(string resolved) =>
        resolved.StartsWith(UnresolvedPrefix, StringComparison.Ordinal);
}
