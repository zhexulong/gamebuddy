using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `a_spelling_the_directory_declares_resolves_on_every_surface:&lt;spelling&gt;` - one destination table, one answer from every
/// reader of it.
///
/// <para>
/// MEASURED `plan_339`: `{kind:'label', label:'Farmhouse'}` answered <c>destination_selector_invalid</c>, while the same room
/// sat in the directory under <c>FarmHouse</c> and <c>皮埃尔的杂货店</c> - spelled exactly - resolved. Two readers were
/// comparing one table with two spellings of "equal": the destination search normalized (FormKC + lower case + whitespace)
/// and matched the English fallback label, while the label selector compared raw strings ordinally and ignored the fallback
/// label entirely. So a caller who wrote the game's own name in another case was told the place did not exist.
/// </para>
///
/// <para>
/// THIS FILE IS THE SELECTOR HALF. The search half moved with the matcher to
/// `host/src/stardew-destination-search.test.ts` (`every declared spelling is answered by the place that declares it`),
/// because `navigate_to_destination`'s admission is this side's and the search is not any more. Both halves run over every
/// spelling the table declares - so a destination added tomorrow is in both without anybody remembering it - and the
/// property is unchanged: a spelling the directory declares names that destination, and a spelling nothing declares is
/// refused.
/// </para>
/// </summary>
public sealed class DestinationSpellingAgreementTests
{
    private static readonly BridgeScope Scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");

    /// <summary>
    /// The four shapes the game's own data produces: a room with a localized name and an English one (the farmhouse), two
    /// shops named the way the world map names them, and a location with no display name at all - whose only spelling is
    /// its identity.
    /// </summary>
    private static readonly NavigationDestination[] Directory =
    {
        new("stardew", "FarmHouse", "农舍", null, "Farmhouse", new[] { "Farmhouse", "FarmHouse" }),
        new("stardew", "SeedShop", "皮埃尔的杂货店", null, "Pierre's General Store", new[] { "Pierre's General Store", "SeedShop" }),
        new("stardew", "ScienceHouse", "木匠的商店", null, "Carpenter's Shop", new[] { "Carpenter's Shop", "ScienceHouse" }),
        new("stardew", "Backwoods", "Backwoods", null, null, new[] { "Backwoods" }),
    };

    private readonly ITestOutputHelper output;

    public DestinationSpellingAgreementTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryDeclaredSpellingBindsItsDestination()
    {
        DerivedDestinationSet set = Set();
        var examined = new List<string>();
        var refusals = new List<string>();

        foreach (string spelling in DeclaredSpellings(set))
        {
            examined.Add(spelling);
            if (Select(set, spelling) is not null)
                continue;
            refusals.Add($"{spelling}: {SelectFailure(set, spelling)}");
        }

        this.output.WriteLine($"spellings examined {examined.Count} · refused {refusals.Count}");

        examined.Count.Should().BeGreaterThan(0, "a gate whose population is empty agrees with itself");
        refusals.Should().BeEmpty("the directory's own spellings must be answerable");
    }

    /// <summary>
    /// The measured sentence, as a case: the farmhouse answers to the English spelling in the case a caller writes it, so
    /// `Farmhouse`, `farmhouse` and `FarmHouse` are one destination and not a `destination_selector_invalid`.
    /// </summary>
    [Fact]
    public void TheFarmhouseAnswersToTheEnglishSpellingRegardlessOfCase()
    {
        DerivedDestinationSet set = Set();

        foreach (string spelling in new[] { "Farmhouse", "farmhouse", "FARMHOUSE", "FarmHouse", "农舍" })
            Select(set, spelling).Should().Be("FarmHouse", $"{spelling} is a spelling the directory declares for that room");

        set.SearchDestinations.Should().Contain(destination => destination.CanonicalIdentity == "FarmHouse");
    }

    /// <summary>
    /// The other side: a spelling no destination declares is refused, by both, with the selector's own word for it - a gate
    /// that resolves everything would be as useless as one that resolves nothing.
    /// </summary>
    [Fact]
    public void ASpellingNothingDeclaresIsRefused()
    {
        DerivedDestinationSet set = Set();

        Select(set, "Town Hall").Should().BeNull();
        SelectFailure(set, "Town Hall").Should().Be("destination_selector_invalid");
    }

    /// <summary>The falsifier's shape: an ambiguous spelling is named as ambiguous, never silently bound to one of the two.</summary>
    [Fact]
    public void AnAmbiguousSpellingIsNamedRatherThanBound()
    {
        var destinations = new[]
        {
            new NavigationDestination("stardew", "Cabin1", "Cabin", null, null, new[] { "Cabin" }),
            new NavigationDestination("stardew", "Cabin2", "Cabin", null, null, new[] { "Cabin" }),
        };
        DerivedDestinationSet set = Set(destinations);

        SelectFailure(set, "cabin").Should().Be("destination_selector_ambiguous");
    }

    private static DerivedDestinationSet Set() => Set(Directory);

    private static DerivedDestinationSet Set(IReadOnlyList<NavigationDestination> destinations) =>
        new("generation_01",
            new NavigationSourceNode("root", null, null, null, Array.Empty<NavigationSourceNode>()),
            destinations);

    /// <summary>Every spelling the set itself declares, plus each spelling's other-case twin.</summary>
    private static IEnumerable<string> DeclaredSpellings(DerivedDestinationSet set) =>
        set.SearchDestinations
            .SelectMany(destination => new[] { destination.CanonicalLabel, destination.FallbackLabel }
                .OfType<string>()
                .Concat(destination.ExplicitAliases ?? Array.Empty<string>()))
            .Where(spelling => !string.IsNullOrWhiteSpace(spelling))
            .SelectMany(spelling => new[] { spelling, spelling.ToUpperInvariant(), spelling.ToLowerInvariant() })
            .Distinct(StringComparer.Ordinal)
            .OrderBy(spelling => spelling, StringComparer.Ordinal)
            .ToArray();

    /// <summary>The one matcher <c>navigate_to_destination</c>'s label selector uses, driven through production admission.</summary>
    private static string? Select(DerivedDestinationSet set, string label)
    {
        NavigationAdmission admission = Admit(set, label);
        return admission.IsAccepted ? admission.Resolution.Binding!.CanonicalDestinationIdentity : null;
    }

    private static string? SelectFailure(DerivedDestinationSet set, string label)
    {
        NavigationAdmission admission = Admit(set, label);
        return admission.IsAccepted ? null : admission.Resolution.FailureReason;
    }

    private static NavigationAdmission Admit(DerivedDestinationSet set, string label)
    {
        var runtime = new NavigationRuntimeSnapshot(
            new NavigationReferenceStore(),
            "runtime_01",
            Scope,
            () => set,
            new EmptyWorldSource(),
            null);
        return AcceptedNavigationExecution.Admit(new NavigationDestinationSelector("label", label, null), runtime);
    }

    private sealed class EmptyWorldSource : INavigationWorldSource
    {
        public NavigationWorldView CurrentView(NavigationDestinationBinding binding) =>
            new(false, null, null, 0, 0, false, Array.Empty<NavigationTransitionLeg>(), false, false, false, false);
    }
}
