using System.Linq;
using System.Text;

namespace GameBuddy.Stardew.Navigation;

internal sealed record DestinationSearchCandidate(
    string Label,
    string? ContextLabel,
    NavigationDestinationSelector Selector,
    string UnlockState
);

internal sealed record DestinationSearchResult(
    string Status,
    string Reason,
    IReadOnlyList<DestinationSearchCandidate>? Candidates,
    NavigationDestinationSelector? Destination,
    string? UnlockState
)
{
    internal static DestinationSearchResult Resolved(string reason, DestinationSearchCandidate destination) =>
        new("resolved", reason, null, destination.Selector, destination.UnlockState);
    internal static DestinationSearchResult WithCandidates(string reason, IReadOnlyList<DestinationSearchCandidate> candidates) =>
        new("candidates", reason, candidates, null, null);
    internal static DestinationSearchResult NotFound() => new("not_found", "destination_not_found", null, null, null);
    internal static DestinationSearchResult Invalid() => new("invalid", "destination_search_invalid", null, null, null);
    internal static DestinationSearchResult Unavailable() => new("blocked", "destination_search_unavailable", null, null, null);
}

/// <summary>
/// Scores one normalized query against a destination directory. The returned
/// array is aligned with the directory order; scores order candidates only and
/// are never projected into a result. Production uses
/// <see cref="DestinationSearchIndex"/>; tests inject fixed scores.
/// </summary>
internal delegate double[] DestinationScorer(
    IReadOnlyList<NavigationDestination> destinations,
    string normalizedQuery
);

/// <summary>
/// Bounded lexical ranking over the current Mod-derived destination directory.
/// It never exposes scores or canonical identities and never turns a fuzzy
/// match into an automatic destination choice.
/// </summary>
internal sealed class DestinationSearch
{
    private const int MaximumCandidates = 3;
    private const int MaximumResultUtf8Bytes = 2048;

    /// <summary>
    /// Fuzzy candidates must score within 25% of the best candidate. The managed
    /// index reports directory-relative BM25 magnitudes rather than the retired
    /// edit-distance scorer's fixed 0-100 ratio, so the ambiguity margin is taken
    /// relative to the best score.
    /// </summary>
    private const double AmbiguousScoreRatioMargin = 0.25;

    private readonly DestinationScorer? scorer;

    internal DestinationSearch(DestinationScorer? scorer = null) => this.scorer = scorer;

    internal DestinationSearchResult Find(
        DerivedDestinationSet set,
        string? query,
        NavigationReferenceStore references,
        NavigationBindingContext context)
    {
        if (!TryNormalizeQuery(query, out string normalized))
            return DestinationSearchResult.Invalid();

        IReadOnlyList<NavigationDestination> destinations = set.SearchDestinations;
        NavigationDestination[] exactCurrent = MatchExact(destinations,
            destination => StringComparer.Ordinal.Equals(DestinationSearchText.Normalize(destination.CanonicalLabel), normalized));
        NavigationDestination[] exactFallback = MatchExact(destinations,
            destination => destination.FallbackLabel is not null
                && StringComparer.Ordinal.Equals(DestinationSearchText.Normalize(destination.FallbackLabel), normalized));
        NavigationDestination[] exactAlias = MatchExact(destinations,
            destination => (destination.ExplicitAliases ?? Array.Empty<string>())
                .Any(alias => StringComparer.Ordinal.Equals(DestinationSearchText.Normalize(alias), normalized)));
        NavigationDestination[] exact = exactCurrent.Concat(exactFallback).Concat(exactAlias)
            .GroupBy(destination => destination.CanonicalIdentity, StringComparer.Ordinal)
            .Select(group => group.First())
            .OrderBy(destination => destination.CanonicalLabel, StringComparer.Ordinal)
            .ThenBy(destination => destination.CanonicalIdentity, StringComparer.Ordinal)
            .ToArray();

        if (exact.Length > 1)
        {
            DestinationSearchResult exactResult = DestinationSearchResult.WithCandidates("ambiguous_exact",
                exact.Take(MaximumCandidates)
                    .Select(destination => ToCandidate(destination, destinations, set, references, context, forceOpaqueSelector: true))
                    .ToArray());
            return IsWithinResultByteLimit(exactResult) ? exactResult : DestinationSearchResult.Unavailable();
        }
        if (exactCurrent.Length == 1)
        {
            DestinationSearchResult exactResult = DestinationSearchResult.Resolved("exact_current_locale", ToCandidate(exactCurrent[0], destinations, set, references, context));
            return IsWithinResultByteLimit(exactResult) ? exactResult : DestinationSearchResult.Unavailable();
        }
        if (exactFallback.Length == 1)
        {
            DestinationSearchResult exactResult = DestinationSearchResult.Resolved("exact_fallback_locale", ToCandidate(exactFallback[0], destinations, set, references, context));
            return IsWithinResultByteLimit(exactResult) ? exactResult : DestinationSearchResult.Unavailable();
        }
        if (exactAlias.Length == 1)
        {
            DestinationSearchResult exactResult = DestinationSearchResult.Resolved("exact_alias", ToCandidate(exactAlias[0], destinations, set, references, context, forceOpaqueSelector: true));
            return IsWithinResultByteLimit(exactResult) ? exactResult : DestinationSearchResult.Unavailable();
        }

        double[] scores = this.Score(destinations, normalized);
        var fuzzy = Enumerable.Range(0, destinations.Count)
            .Select(index => new
            {
                Destination = destinations[index],
                Score = index < scores.Length ? scores[index] : 0.0,
            })
            .Where(match => match.Score > 0.0)
            .OrderByDescending(match => match.Score)
            .ThenBy(match => match.Destination.CanonicalLabel, StringComparer.Ordinal)
            .ThenBy(match => match.Destination.CanonicalIdentity, StringComparer.Ordinal)
            .ToArray();
        if (fuzzy.Length == 0)
            return DestinationSearchResult.NotFound();

        double cutoff = fuzzy[0].Score * (1.0 - AmbiguousScoreRatioMargin);
        NavigationDestination[] candidates = fuzzy.Where(match => match.Score >= cutoff)
            .Take(MaximumCandidates)
            .Select(match => match.Destination)
            .ToArray();
        DestinationSearchResult result = DestinationSearchResult.WithCandidates("fuzzy_match",
            candidates.Select(destination => ToCandidate(destination, destinations, set, references, context, forceOpaqueSelector: true)).ToArray());
        return IsWithinResultByteLimit(result) ? result : DestinationSearchResult.Unavailable();
    }

    private static bool IsWithinResultByteLimit(DestinationSearchResult result) =>
        DestinationSearchBudget.MeasureUtf8Bytes(result) <= MaximumResultUtf8Bytes;

    private double[] Score(IReadOnlyList<NavigationDestination> destinations, string normalizedQuery) =>
        this.scorer is null
            ? DestinationSearchIndex.Build(destinations).ScoreAll(normalizedQuery)
            : this.scorer(destinations, normalizedQuery);

    private static DestinationSearchCandidate ToCandidate(
        NavigationDestination destination,
        IReadOnlyList<NavigationDestination> all,
        DerivedDestinationSet set,
        NavigationReferenceStore references,
        NavigationBindingContext context,
        bool forceOpaqueSelector = false)
    {
        bool ambiguous = all.Count(other =>
            StringComparer.Ordinal.Equals(other.CanonicalLabel, destination.CanonicalLabel)) > 1;
        if (ambiguous || forceOpaqueSelector)
        {
            string reference = references.IssueDestination(context, new NavigationDestinationBinding(
                destination.ContentOwner, destination.CanonicalIdentity, set.Generation, context.ObservationSequence));
            return new DestinationSearchCandidate(destination.CanonicalLabel, destination.ContextLabel,
                new NavigationDestinationSelector("ref", null, reference), "unknown");
        }
        return new DestinationSearchCandidate(destination.CanonicalLabel, destination.ContextLabel,
            new NavigationDestinationSelector("label", destination.CanonicalLabel, null), "unknown");
    }

    private static NavigationDestination[] MatchExact(
        IReadOnlyList<NavigationDestination> destinations,
        Func<NavigationDestination, bool> predicate) => destinations
        .Where(predicate)
        .OrderBy(destination => destination.CanonicalLabel, StringComparer.Ordinal)
        .ThenBy(destination => destination.CanonicalIdentity, StringComparer.Ordinal)
        .ToArray();

    private static bool TryNormalizeQuery(string? value, out string normalized)
    {
        normalized = string.Empty;
        if (value is null || value.EnumerateRunes().Count() is < 1 or > 128)
            return false;
        if (value.Any(char.IsControl) || value.Contains('/') || value.Contains('\\') || value.Contains(':')
            || value.Any(char.IsDigit))
            return false;
        normalized = DestinationSearchText.Normalize(value);
        return normalized.Length > 0;
    }
}

/// <summary>
/// Byte-exact measurement of the serialized JSON size of a
/// <see cref="DestinationSearchResult"/>, computed field-by-field so no
/// whole-payload string is ever materialized on the managed heap.
///
/// <para>
/// Every leaf is serialized individually with the default encoder (so escaping
/// — quotes, backslashes, non-ASCII — is byte-identical to a whole-payload
/// serialization), and the fixed structural overhead of the JSON document is
/// added as constants. The result is therefore byte-identical to the payload
/// the previous implementation serialized, as pinned by
/// DestinationSearchByteBudgetEquivalenceTests.
/// </para>
/// </summary>
internal static class DestinationSearchBudget
{
    internal static int MeasureUtf8Bytes(DestinationSearchResult result)
    {
        int size = 0;
        if (result.Candidates is not null)
        {
            size += 1; // {
            size += StructuralKey("status") + LeafBytes(result.Status);
            size += 1; // ,
            size += StructuralKey("reason") + LeafBytes(result.Reason);
            size += 1; // ,
            size += StructuralKey("candidates");
            size += 1; // [
            for (int index = 0; index < result.Candidates.Count; index++)
            {
                if (index > 0) size += 1; // ,
                DestinationSearchCandidate candidate = result.Candidates[index];
                size += 1; // {
                size += StructuralKey("Label") + LeafBytes(candidate.Label);
                size += 1; // ,
                size += StructuralKey("ContextLabel") + LeafBytes(candidate.ContextLabel);
                size += 1; // ,
                size += StructuralKey("Selector") + SelectorBytes(candidate.Selector);
                size += 1; // ,
                size += StructuralKey("UnlockState") + LeafBytes(candidate.UnlockState);
                size += 1; // }
            }
            size += 1; // ]
            size += 1; // }
        }
        else if (result.Destination is not null)
        {
            size += 1; // {
            size += StructuralKey("status") + LeafBytes(result.Status);
            size += 1; // ,
            size += StructuralKey("reason") + LeafBytes(result.Reason);
            size += 1; // ,
            size += StructuralKey("destination") + SelectorBytes(result.Destination);
            size += 1; // }
        }
        else
        {
            size += 1; // {
            size += StructuralKey("status") + LeafBytes(result.Status);
            size += 1; // ,
            size += StructuralKey("reason") + LeafBytes(result.Reason);
            size += 1; // }
        }
        return size;
    }

    /// <summary>The serialized size of a <c>"name":</c> property prefix (quotes, name, colon).</summary>
    private static int StructuralKey(string name) => name.Length + 3;

    /// <summary>The serialized size of one string leaf: quotes, the value, and its escapes.</summary>
    private static int LeafBytes(string? value) =>
        value is null
            ? 4 // null
            : Encoding.UTF8.GetByteCount(System.Text.Json.JsonSerializer.Serialize(value));

    /// <summary>The serialized size of a <c>NavigationDestinationSelector</c> record.</summary>
    private static int SelectorBytes(NavigationDestinationSelector selector) =>
        1 // {
        + StructuralKey("Kind") + LeafBytes(selector.Kind)
        + 1 // ,
        + StructuralKey("Label") + LeafBytes(selector.Label)
        + 1 // ,
        + StructuralKey("Ref") + LeafBytes(selector.Ref)
        + 1; // }
}
