using System.Globalization;
using System.Linq;
using System.Text;
using Raffinert.FuzzySharp;

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
/// Bounded lexical ranking over the current Mod-derived destination directory.
/// It never exposes scores or canonical identities and never turns a fuzzy
/// match into an automatic destination choice.
/// </summary>
internal sealed class DestinationSearch
{
    private const int MaximumCandidates = 3;
    private const int MinimumFuzzyScore = 60;
    private const int AmbiguousFuzzyScoreMargin = 5;
    private const int MaximumResultUtf8Bytes = 2048;

    internal DestinationSearchResult Find(DerivedDestinationSet set, string? query)
    {
        if (!TryNormalizeQuery(query, out string normalized))
            return DestinationSearchResult.Invalid();

        IReadOnlyList<NavigationDestination> destinations = set.SearchDestinations;
        NavigationDestination[] exactCurrent = MatchExact(destinations,
            destination => StringComparer.Ordinal.Equals(Normalize(destination.CanonicalLabel), normalized));
        NavigationDestination[] exactFallback = MatchExact(destinations,
            destination => destination.FallbackLabel is not null
                && StringComparer.Ordinal.Equals(Normalize(destination.FallbackLabel), normalized));
        NavigationDestination[] exactAlias = MatchExact(destinations,
            destination => (destination.ExplicitAliases ?? Array.Empty<string>())
                .Any(alias => StringComparer.Ordinal.Equals(Normalize(alias), normalized)));
        NavigationDestination[] exact = exactCurrent.Concat(exactFallback).Concat(exactAlias)
            .GroupBy(destination => destination.CanonicalIdentity, StringComparer.Ordinal)
            .Select(group => group.First())
            .OrderBy(destination => destination.CanonicalLabel, StringComparer.Ordinal)
            .ThenBy(destination => destination.CanonicalIdentity, StringComparer.Ordinal)
            .ToArray();

        if (exact.Length > MaximumCandidates)
            return DestinationSearchResult.Unavailable();
        if (exact.Length > 1)
        {
            DestinationSearchResult exactResult = DestinationSearchResult.WithCandidates("ambiguous_exact",
                exact.Select(destination => ToCandidate(destination, destinations, forceOpaqueSelector: true)).ToArray());
            return IsWithinResultByteLimit(exactResult) ? exactResult : DestinationSearchResult.Unavailable();
        }
        if (exactCurrent.Length == 1)
        {
            DestinationSearchResult exactResult = DestinationSearchResult.Resolved("exact_current_locale", ToCandidate(exactCurrent[0], destinations));
            return IsWithinResultByteLimit(exactResult) ? exactResult : DestinationSearchResult.Unavailable();
        }
        if (exactFallback.Length == 1)
        {
            DestinationSearchResult exactResult = DestinationSearchResult.Resolved("exact_fallback_locale", ToCandidate(exactFallback[0], destinations));
            return IsWithinResultByteLimit(exactResult) ? exactResult : DestinationSearchResult.Unavailable();
        }
        if (exactAlias.Length == 1)
        {
            DestinationSearchResult exactResult = DestinationSearchResult.Resolved("exact_alias", ToCandidate(exactAlias[0], destinations, forceOpaqueSelector: true));
            return IsWithinResultByteLimit(exactResult) ? exactResult : DestinationSearchResult.Unavailable();
        }

        var fuzzy = destinations
            .Select(destination => new { Destination = destination, Score = BestScore(normalized, destination) })
            .Where(match => match.Score >= MinimumFuzzyScore)
            .OrderByDescending(match => match.Score)
            .ThenBy(match => match.Destination.CanonicalLabel, StringComparer.Ordinal)
            .ThenBy(match => match.Destination.CanonicalIdentity, StringComparer.Ordinal)
            .ToArray();
        if (fuzzy.Length == 0)
            return DestinationSearchResult.NotFound();

        int cutoff = fuzzy[0].Score - AmbiguousFuzzyScoreMargin;
        NavigationDestination[] candidates = fuzzy.Where(match => match.Score >= cutoff)
            .Take(MaximumCandidates)
            .Select(match => match.Destination)
            .ToArray();
        DestinationSearchResult result = DestinationSearchResult.WithCandidates("fuzzy_match",
            candidates.Select(destination => ToCandidate(destination, destinations, forceOpaqueSelector: true)).ToArray());
        return IsWithinResultByteLimit(result) ? result : DestinationSearchResult.Unavailable();
    }

    private static bool IsWithinResultByteLimit(DestinationSearchResult result)
    {
        object payload = result.Status switch
        {
            "resolved" => new { status = result.Status, reason = result.Reason, destination = result.Destination },
            "candidates" => new { status = result.Status, reason = result.Reason, candidates = result.Candidates },
            _ => new { status = result.Status, reason = result.Reason },
        };
        return Encoding.UTF8.GetByteCount(System.Text.Json.JsonSerializer.Serialize(payload)) <= MaximumResultUtf8Bytes;
    }

    private static int BestScore(string normalizedQuery, NavigationDestination destination)
    {
        IEnumerable<string> labels = new[] { destination.CanonicalLabel, destination.FallbackLabel }
            .Concat(destination.ExplicitAliases ?? Array.Empty<string>())
            .OfType<string>()
            .Where(label => !string.IsNullOrWhiteSpace(label));
        return labels.Select(label => Fuzz.WeightedRatio(normalizedQuery, Normalize(label))).DefaultIfEmpty(0).Max();
    }

    private static DestinationSearchCandidate ToCandidate(
        NavigationDestination destination,
        IReadOnlyList<NavigationDestination> all,
        bool forceOpaqueSelector = false)
    {
        bool ambiguous = all.Count(other =>
            StringComparer.Ordinal.Equals(other.CanonicalLabel, destination.CanonicalLabel)) > 1;
        NavigationDestinationSelector selector = ambiguous || forceOpaqueSelector
            ? new("ref", null, null)
            : new("label", destination.CanonicalLabel, null);
        // Search only ranks candidates. It never mints a reference or chooses a
        // fuzzy match as an executable destination.
        return new DestinationSearchCandidate(destination.CanonicalLabel, destination.ContextLabel, selector, "unknown");
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
        normalized = Normalize(value);
        return normalized.Length > 0;
    }

    private static string Normalize(string value)
    {
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
