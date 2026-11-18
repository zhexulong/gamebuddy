using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The clearing vocabulary as a GATE: every word the Mod publishes for what stands on a tile is either removed by a
/// published action's own <c>Clears</c> declaration or DECLARED unclearable with a reason, and every declaration names a
/// word the world really publishes.
///
/// <para>
/// WHY THIS IS A GATE AND NOT A TEST OF TODAY'S ROWS. Measured `round58`: over a 60-tile strip the companion was handed
/// <c>occupantKind: object</c> on the tiles she could not work, filtered for <c>stone</c> and matched none of them, and
/// the turn settled <c>no_published_action_clears:object</c> - a word no declaration answers, so "we have nothing" and
/// "nobody wrote it down" were the same sentence and neither was in the vocabulary she reads. The population here is the
/// vocabulary the Mod DECLARES (<see cref="TileOccupantKind.Published"/>) crossed with the catalogue's own declarations,
/// so the next word somebody publishes without an answer fails by name instead of reaching a planner as a tile it cannot
/// work. <c>tools/audit-stardew-clearing-vocabulary.mjs</c> reads the same two populations out of the sources; this is
/// the runtime half, on the compiled catalogue.
/// </para>
/// </summary>
public sealed class ClearingVocabularyCoverageTests
{
    /// <summary>
    /// The gate itself, fed a population. Pure, so the honest population and a synthetic one are judged by one function:
    /// the synthetic case below is the falsifier, and a guard that cannot be made red on purpose is decoration.
    /// </summary>
    internal static IReadOnlyList<string> Findings(
        IReadOnlyList<string> published,
        IReadOnlyList<(string Kind, string Reason)> unclearable,
        IReadOnlyList<FarmhandActionRegistration> registrations)
    {
        var findings = new List<string>();
        var cleared = registrations
            .Where(registration => registration.Descriptor?.Clears is not null)
            .SelectMany(registration => registration.Descriptor!.Clears!.Occupants)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        var reasons = unclearable.ToDictionary(entry => entry.Kind, entry => entry.Reason, StringComparer.Ordinal);

        if (published.Count == 0)
            findings.Add("stardew_clearing_vocabulary_unmeasured:no published kind was declared");

        foreach (string kind in published)
        {
            bool isCleared = cleared.Contains(kind, StringComparer.Ordinal);
            bool hasReason = reasons.TryGetValue(kind, out string? reason) && !string.IsNullOrWhiteSpace(reason);
            if (!isCleared && !hasReason) findings.Add($"published_kind_no_action_clears:{kind}");
            if (isCleared && reasons.ContainsKey(kind)) findings.Add($"declared_kind_both_ways:{kind}");
        }

        foreach (string kind in cleared)
            if (!published.Contains(kind, StringComparer.Ordinal)) findings.Add($"cleared_kind_not_published:{kind}");

        foreach ((string kind, string reason) in unclearable)
        {
            if (!published.Contains(kind, StringComparer.Ordinal)) findings.Add($"unclearable_kind_not_published:{kind}");
            if (string.IsNullOrWhiteSpace(reason)) findings.Add($"unclearable_kind_without_reason:{kind}");
        }

        return findings;
    }

    [Fact]
    public void EveryPublishedKindIsEitherClearedByAPublishedActionOrDeclaredUnclearableWithAReason()
    {
        IReadOnlyList<string> findings = Findings(
            TileOccupantKind.Published,
            TileOccupantKind.Unclearable,
            FarmhandActionCatalog.Registrations);

        int cleared = TileOccupantKind.Published.Count(kind =>
            FarmhandActionCatalog.Registrations.Any(registration =>
                registration.Descriptor?.Clears?.Occupants.Contains(kind, StringComparer.Ordinal) ?? false));

        findings.Should().BeEmpty(
            "kinds published {0} · cleared by >=1 action {1} · unclearable {2}: {3}",
            TileOccupantKind.Published.Count,
            cleared,
            TileOccupantKind.Unclearable.Count,
            string.Join(" ", findings));
    }

    /// <summary>
    /// The FALSIFIER: the same published population with the unclearable declarations removed is red on exactly the words
    /// those declarations answer - and on no others. A guard that could not be turned red on purpose would be decoration.
    /// </summary>
    [Fact]
    public void RemovingTheDeclarationsIsRedOnExactlyTheKindsTheyAnswer()
    {
        IReadOnlyList<string> findings = Findings(
            TileOccupantKind.Published,
            Array.Empty<(string, string)>(),
            FarmhandActionCatalog.Registrations);

        findings.Should().BeEquivalentTo(
            TileOccupantKind.Unclearable
                .Select(entry => $"published_kind_no_action_clears:{entry.Kind}")
                .ToArray());
        findings.Should().Contain("published_kind_no_action_clears:object",
            "`object` is the word round58 settled on and no declaration answers");
    }

    /// <summary>
    /// The other direction, on one word: a declaration for a kind the vocabulary never publishes is a clearer nobody can
    /// aim, so it is red by name.
    /// </summary>
    [Fact]
    public void AClearerForAWordNothingPublishesIsNamed()
    {
        IReadOnlyList<string> findings = Findings(
            new[] { TileOccupantKind.Stone },
            Array.Empty<(string, string)>(),
            FarmhandActionCatalog.Registrations);

        findings.Should().Contain("cleared_kind_not_published:twig");
    }

    /// <summary>
    /// The free-tile word is the absence of an occupant, so it is not a kind and no action is declared to clear it: a
    /// vocabulary that listed it would make every empty tile a tile something has to be dispatched at.
    /// </summary>
    [Fact]
    public void TheFreeTileWordIsNotAPublishedKind()
    {
        TileOccupantKind.None.Should().Be(FarmhandForEachHealing.NoOccupant);
        TileOccupantKind.Published.Should().NotContain(TileOccupantKind.None);
    }

    /// <summary>
    /// ONE WORD, ONE MEANING: the list has no duplicates, because two spellings of one entry would let a kind be declared
    /// twice with two answers and only one of them would be read.
    /// </summary>
    [Fact]
    public void TheVocabularyDeclaresEachKindOnce()
    {
        TileOccupantKind.Published.Should().OnlyHaveUniqueItems();
        TileOccupantKind.Unclearable.Select(entry => entry.Kind).Should().OnlyHaveUniqueItems();
    }
}
