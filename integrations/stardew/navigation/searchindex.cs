using System.Globalization;
using System.Text;

namespace GameBuddy.Stardew.Navigation;

internal enum SearchTokenKind
{
    LatinWord,
    CjkUnigram,
    CjkBigram,
}

/// <summary>
/// One token of a normalized search field or query. <see cref="Text"/> doubles as
/// the index key: a code point is classified as either CJK or alphanumeric, so
/// CJK unigrams, CJK bigrams and latin words can never collide.
/// </summary>
internal readonly record struct SearchToken(string Text, SearchTokenKind Kind);

/// <summary>
/// Splits search text into the tokens <see cref="DestinationSearchIndex"/> is
/// keyed by. Normalization is idempotent: case, width and separator runs are
/// folded once, so already-normalized text can be re-tokenized safely.
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

    /// <summary>
    /// CJK text is written without word separators, so it is tokenized as single
    /// characters plus adjacent character pairs; every other letter or digit run
    /// becomes one lower-case latin word. Anything else separates runs.
    /// </summary>
    internal static IReadOnlyList<SearchToken> Tokenize(string? text)
    {
        List<SearchToken> tokens = new();
        string normalized = Normalize(text);
        if (normalized.Length == 0)
            return tokens;
        StringBuilder latinRun = new();
        List<string> cjkRun = new();
        foreach (Rune rune in normalized.EnumerateRunes())
        {
            if (IsCjk(rune))
            {
                AppendLatinWord(tokens, latinRun);
                cjkRun.Add(rune.ToString());
                continue;
            }
            if (Rune.IsLetterOrDigit(rune))
            {
                AppendCjkRun(tokens, cjkRun);
                latinRun.Append(rune);
                continue;
            }
            AppendLatinWord(tokens, latinRun);
            AppendCjkRun(tokens, cjkRun);
        }
        AppendLatinWord(tokens, latinRun);
        AppendCjkRun(tokens, cjkRun);
        return tokens;
    }

    private static void AppendLatinWord(List<SearchToken> tokens, StringBuilder word)
    {
        if (word.Length == 0)
            return;
        tokens.Add(new SearchToken(word.ToString(), SearchTokenKind.LatinWord));
        word.Clear();
    }

    private static void AppendCjkRun(List<SearchToken> tokens, List<string> run)
    {
        if (run.Count == 0)
            return;
        foreach (string character in run)
            tokens.Add(new SearchToken(character, SearchTokenKind.CjkUnigram));
        for (int index = 0; index + 1 < run.Count; index++)
            tokens.Add(new SearchToken(run[index] + run[index + 1], SearchTokenKind.CjkBigram));
        run.Clear();
    }

    private static bool IsCjk(Rune rune)
    {
        int value = rune.Value;
        return value is (>= 0x3005 and <= 0x3007)     // iteration marks within CJK symbols
            or (>= 0x3040 and <= 0x30FF)              // Hiragana + Katakana
            or (>= 0x3400 and <= 0x4DBF)              // CJK Unified Ideographs Extension A
            or (>= 0x4E00 and <= 0x9FFF)              // CJK Unified Ideographs
            or (>= 0xAC00 and <= 0xD7AF)              // Hangul Syllables
            or (>= 0xF900 and <= 0xFAFF)              // CJK Compatibility Ideographs
            or (>= 0x20000 and <= 0x2FA1F);           // CJK Unified Ideographs Extensions B-F
    }
}

/// <summary>
/// Pure managed multi-field index over the current Mod-derived destination
/// directory. Every destination contributes six weighted fields: the canonical
/// label, resident NPCs, service and stock terms, explicit aliases, the
/// fallback-locale label and the area label. Fields are tokenized into CJK
/// unigrams/bigrams and latin words, and latin words also index their prefixes so
/// a partial word still recalls the destination. Scores order candidates inside
/// the Mod only: they are never projected into a bridge payload, and a fuzzy
/// match never becomes an automatic destination choice.
/// </summary>
internal sealed class DestinationSearchIndex
{
    /// <summary>
    /// Field weights: the canonical label is the strongest signal, then the
    /// residents that live there, then what is bought or done there, then name
    /// variants, and last the weaker fallback-locale and area labels.
    /// </summary>
    private const double CanonicalLabelWeight = 10.0;
    private const double RelatedNpcWeight = 5.0;
    private const double ServiceTermWeight = 3.0;
    private const double AliasWeight = 2.0;
    private const double FallbackLocaleWeight = 1.5;
    private const double AreaLabelWeight = 1.0;

    /// <summary>A complete CJK bigram hit is a precision signal, so it counts double.</summary>
    private const double CjkBigramBoost = 2.0;

    /// <summary>BM25 term-frequency saturation (k1).</summary>
    private const double TermFrequencySaturation = 1.2;

    /// <summary>Latin words are not indexed as prefixes below this length.</summary>
    private const int MinimumLatinPrefixLength = 2;

    /// <summary>
    /// A destination must be recalled by at least half of the query's
    /// information mass, measured over the idf-weighted query tokens that exist
    /// anywhere in the directory. BM25 magnitudes depend on the directory
    /// contents, so this relative floor replaces the fixed 0-100 ratio floor of
    /// the retired edit-distance scorer while keeping its "no junk candidate"
    /// intent.
    /// </summary>
    private const double MinimumQueryCoverage = 0.5;

    private readonly int destinationCount;
    private readonly Dictionary<string, PostingList> postings;

    private DestinationSearchIndex(int destinationCount, Dictionary<string, PostingList> postings)
    {
        this.destinationCount = destinationCount;
        this.postings = postings;
    }

    /// <summary>Number of destinations this index scores, in directory order.</summary>
    internal int Count => this.destinationCount;

    /// <summary>
    /// Builds the index for one immutable destination directory. A null or empty
    /// directory yields an empty index that scores everything as zero.
    /// </summary>
    internal static DestinationSearchIndex Build(IReadOnlyList<NavigationDestination>? destinations)
    {
        if (destinations is null || destinations.Count == 0)
            return new DestinationSearchIndex(0, new Dictionary<string, PostingList>(StringComparer.Ordinal));

        int count = destinations.Count;
        Dictionary<string, List<(int Destination, double WeightedFrequency)>> recalled =
            new(StringComparer.Ordinal);
        for (int index = 0; index < count; index++)
        foreach (KeyValuePair<string, double> term in WeightedTerms(destinations[index]))
        {
            if (!recalled.TryGetValue(term.Key, out List<(int Destination, double WeightedFrequency)>? list))
                recalled[term.Key] = list = new List<(int Destination, double WeightedFrequency)>();
            list.Add((index, term.Value));
        }

        Dictionary<string, PostingList> built = new(StringComparer.Ordinal);
        foreach (KeyValuePair<string, List<(int Destination, double WeightedFrequency)>> recalledTerm in recalled)
        {
            List<(int Destination, double WeightedFrequency)> entries = recalledTerm.Value;
            int[] entryDestinations = new int[entries.Count];
            double[] entryFrequencies = new double[entries.Count];
            for (int entry = 0; entry < entries.Count; entry++)
            {
                entryDestinations[entry] = entries[entry].Destination;
                entryFrequencies[entry] = entries[entry].WeightedFrequency;
            }
            built[recalledTerm.Key] = new PostingList
            {
                InverseDocumentFrequency = Math.Log(
                    1.0 + (count - entries.Count + 0.5) / (entries.Count + 0.5)),
                Destinations = entryDestinations,
                WeightedFrequencies = entryFrequencies,
            };
        }
        return new DestinationSearchIndex(count, built);
    }

    /// <summary>
    /// Scores one normalized query against every destination, aligned with the
    /// directory order it was built from. A destination that cannot be recalled,
    /// that covers too little of the query, or that is scored against an empty
    /// query scores exactly zero.
    /// </summary>
    internal double[] ScoreAll(string? normalizedQuery)
    {
        double[] scores = new double[this.destinationCount];
        if (this.destinationCount == 0)
            return scores;

        IReadOnlyList<SearchToken> tokens = DestinationSearchText.Tokenize(normalizedQuery);
        if (tokens.Count == 0)
            return scores;

        double[] coveredMass = new double[this.destinationCount];
        HashSet<string> visited = new(StringComparer.Ordinal);
        double queryMass = 0.0;
        foreach (SearchToken token in tokens)
        {
            if (!visited.Add(token.Text) || !this.postings.TryGetValue(token.Text, out PostingList? posting))
                continue;
            double mass = posting.InverseDocumentFrequency * TokenWeight(token);
            queryMass += mass;
            for (int entry = 0; entry < posting.Destinations.Length; entry++)
            {
                int destination = posting.Destinations[entry];
                scores[destination] += mass * posting.WeightedFrequencies[entry];
                coveredMass[destination] += mass;
            }
        }
        if (queryMass <= 0.0)
            return scores;

        double minimumMass = queryMass * MinimumQueryCoverage;
        for (int destination = 0; destination < scores.Length; destination++)
        {
            if (coveredMass[destination] < minimumMass)
                scores[destination] = 0.0;
        }
        return scores;
    }

    private static double TokenWeight(SearchToken token) =>
        token.Kind == SearchTokenKind.CjkBigram ? CjkBigramBoost : 1.0;

    private static IEnumerable<KeyValuePair<string, double>> WeightedTerms(NavigationDestination destination)
    {
        Dictionary<string, double> terms = new(StringComparer.Ordinal);
        AddField(terms, CanonicalLabelWeight, FieldText(destination.CanonicalLabel));
        AddField(terms, RelatedNpcWeight, destination.RelatedNpcs);
        AddField(terms, ServiceTermWeight, destination.ServiceTerms);
        AddField(terms, AliasWeight, destination.ExplicitAliases);
        AddField(terms, FallbackLocaleWeight, FieldText(destination.FallbackLabel));
        AddField(terms, AreaLabelWeight, FieldText(destination.ContextLabel));
        return terms;
    }

    private static IEnumerable<string?> FieldText(string? text)
    {
        if (text is not null)
            yield return text;
    }

    private static void AddField(Dictionary<string, double> terms, double fieldWeight, IEnumerable<string?>? texts)
    {
        if (texts is null)
            return;
        Dictionary<string, int> frequencies = new(StringComparer.Ordinal);
        foreach (string? text in texts)
        foreach (SearchToken token in DestinationSearchText.Tokenize(text))
        foreach (string key in IndexKeys(token))
        {
            frequencies.TryGetValue(key, out int frequency);
            frequencies[key] = frequency + 1;
        }
        foreach (KeyValuePair<string, int> frequency in frequencies)
        {
            double saturated = frequency.Value * (TermFrequencySaturation + 1.0)
                / (frequency.Value + TermFrequencySaturation);
            terms.TryGetValue(frequency.Key, out double existing);
            terms[frequency.Key] = existing + (fieldWeight * saturated);
        }
    }

    /// <summary>
    /// Keys one token contributes. A latin word is also keyed under every prefix
    /// of at least two runes, which is what lets the partial word "min" recall
    /// "Mine", "Mines", "Minecart" and "Mining Guild"; the per-key idf keeps such
    /// short prefixes from dominating a result.
    /// </summary>
    private static IEnumerable<string> IndexKeys(SearchToken token)
    {
        yield return token.Text;
        if (token.Kind != SearchTokenKind.LatinWord)
            yield break;

        List<Rune> runes = token.Text.EnumerateRunes().ToList();
        StringBuilder prefix = new();
        for (int length = 0; length + 1 < runes.Count; length++)
        {
            prefix.Append(runes[length]);
            if (length + 1 >= MinimumLatinPrefixLength)
                yield return prefix.ToString();
        }
    }

    private sealed class PostingList
    {
        internal double InverseDocumentFrequency;
        internal int[] Destinations = Array.Empty<int>();
        internal double[] WeightedFrequencies = Array.Empty<double>();
    }
}
