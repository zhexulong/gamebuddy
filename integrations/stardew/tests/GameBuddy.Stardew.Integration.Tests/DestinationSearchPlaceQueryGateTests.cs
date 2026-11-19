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
/// `a_query_for_a_place_finds_that_place_or_says_it_does_not:&lt;query&gt;` - one directory, one answer per
/// name it holds, and "no such place" for a word it holds none of.
///
/// <para>
/// MEASURED `round77`: <c>find_destination("矿洞")</c> and <c>find_destination("矿洞入口 Mine entrance")</c>
/// both answered <c>乔迪，肯特和山姆的家</c> - a villager's house - and nothing else, so the day that asked
/// for the mine went somewhere else. The directory declares 矿井 / "Mines" for that place, and
/// 乔迪，肯特和山姆的家 / "Home of Jodi, Kent &amp; Sam" for the house, whose residents (the Desert
/// Festival stalls) sell the cave carrot - the only 洞 in the directory. The retired floor let the house
/// answer both queries; <see cref="DestinationSearchIndex"/> names the mechanism.
/// </para>
///
/// <para>
/// The POPULATION is every destination the set holds, crossed with every name it DECLARES for it - its
/// localised display name, its fallback-locale name and each alias (which always carries the internal
/// identity) - plus the pair measured in `round77`, because a place she can name is found or refused and
/// a word no place declares is the case this gate exists for. All of it comes from
/// <see cref="DerivedDestinationSet"/> and the recording, never from a list of places kept here, so a
/// location added tomorrow is in this gate without anybody remembering it. The property is that the
/// answer names the place asked for or says there is no such place; M&gt;0 fails with the place, the query
/// and what it returned.
/// </para>
/// </summary>
public sealed class DestinationSearchPlaceQueryGateTests
{
    private static readonly BridgeScope Scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");

    /// <summary>
    /// The live entries the measured defect ran through, with the names, residents and stock terms their
    /// own rows give them: `Data/Locations` keys, and the display names as the game's
    /// `StringsFromCSFiles` table resolves them in Chinese, with the English row beside.
    /// </summary>
    private static readonly NavigationDestination[] Directory =
    {
        new("stardew", "Mine", "矿井", null, "Mines", new[] { "Mines" }),
        new("stardew", "Forest", "煤矿森林", null, "Cindersap Forest", new[] { "Cindersap Forest" }),
        new("stardew", "Mountain", "山", null, "Mountain", new[] { "Mountain" }),
        new("stardew", "SamHouse", "乔迪，肯特和山姆的家", null, "Home of Jodi, Kent & Sam",
            new[] { "Home of Jodi, Kent & Sam" },
            new[] { "Jodi", "Kent", "Sam", "Vincent", "乔迪", "肯特", "山姆", "文森特" },
            new[]
            {
                "DesertFestival_Jodi", "DesertFestival_Kent", "DesertFestival_Sam", "DesertFestival_Vincent",
                "枫糖棒", "Joja 可乐", "香酥鲈鱼", "混合种子", "蕨菜", "榛子", "纤维", "虫肉", "树液",
                "山洞萝卜", "手部骨骼", "粘土", "有缺口的土罐", "混合花卉种子",
            }),
        new("stardew", "ScienceHouse", "木匠的商店", null, "Carpenter's Shop",
            new[] { "Carpenter's Shop" },
            new[] { "Robin", "Demetrius", "Sebastian", "Maru", "罗宾", "德米特里厄斯", "塞巴斯蒂安", "玛鲁" },
            new[] { "Carpenter", "木材", "石头", "农场建筑" }),
        new("stardew", "SeedShop", "皮埃尔的杂货店", null, "Pierre's General Store",
            new[] { "Pierre's General Store" },
            new[] { "Pierre", "Caroline", "Abigail", "皮埃尔", "卡洛琳", "阿比盖尔" },
            new[] { "SeedShop", "种子", "肥料" }),
    };

    /// <summary>
    /// The two queries `round77` measured, each with the place she was asking for. `矿洞` is the word the
    /// Host's own world-state vocabulary prints for the mine entrance; `Mine` is the game's own name.
    /// </summary>
    private static readonly (string Query, string PlaceIdentity)[] RecordedQueries =
    {
        ("矿洞", "Mine"),
        ("矿洞入口 Mine entrance", "Mine"),
    };

    private readonly ITestOutputHelper output;

    public DestinationSearchPlaceQueryGateTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void AQueryForAPlaceFindsThatPlaceOrSaysItDoesNot()
    {
        DerivedDestinationSet set = Set();
        var examined = new List<string>();
        var foundOrRefused = new List<string>();
        var misled = new List<string>();

        foreach (NavigationDestination destination in set.SearchDestinations)
        foreach (string spelling in DeclaredNames(destination))
            Examine(destination, spelling);

        foreach ((string query, string identity) in RecordedQueries)
        {
            DestinationSearchResult recorded = Find(set, query);
            this.output.WriteLine($"recorded \"{query}\" -> {Describe(recorded)}");
            Examine(set.SearchDestinations.First(destination => destination.CanonicalIdentity == identity), query, recorded);
        }

        this.output.WriteLine(
            $"places examined {set.SearchDestinations.Count} · queries examined {examined.Count} · found-or-refused {foundOrRefused.Count} · misled {misled.Count}");
        foreach (string line in misled)
            this.output.WriteLine($"  MISLED {line}");

        set.SearchDestinations.Should().NotBeEmpty("a gate whose population is empty agrees with itself");
        examined.Should().NotBeEmpty("every place declares at least its own label");
        misled.Should().BeEmpty("a query for a place names that place, or is told there is no such place");

        void Examine(NavigationDestination destination, string query, DestinationSearchResult? recorded = null)
        {
            examined.Add(query);
            DestinationSearchResult result = recorded ?? Find(set, query);
            if (AnswersPlace(result, destination))
            {
                foundOrRefused.Add(query);
                return;
            }

            misled.Add($"{destination.CanonicalLabel} asked as \"{query}\" -> {Describe(result)}");
        }
    }

    private static DerivedDestinationSet Set() => new("generation_01",
        new NavigationSourceNode("root", null, null, null, Array.Empty<NavigationSourceNode>()), Directory);

    /// <summary>Every name the set itself declares for one destination, deduplicated and ordered.</summary>
    private static IEnumerable<string> DeclaredNames(NavigationDestination destination) =>
        new[] { destination.CanonicalLabel, destination.FallbackLabel }
            .OfType<string>()
            .Concat(destination.ExplicitAliases ?? Array.Empty<string>())
            .Where(spelling => !string.IsNullOrWhiteSpace(spelling))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(spelling => spelling, StringComparer.Ordinal);

    private static DestinationSearchResult Find(DerivedDestinationSet set, string query)
    {
        var context = new NavigationBindingContext("runtime_01", Scope, set.Generation, 1, DateTimeOffset.UtcNow);
        return new DestinationSearch().Find(set, query, new NavigationReferenceStore(), context);
    }

    /// <summary>
    /// Did the answer name the place asked for - resolved to it, or among its candidates - or say there is
    /// no such place? A candidate list of OTHER places is the mislead this gate counts.
    /// </summary>
    private static bool AnswersPlace(DestinationSearchResult result, NavigationDestination destination) =>
        result.Status == "not_found"
        || (result.Destination is not null
            ? StringComparer.Ordinal.Equals(result.Destination.Label, destination.CanonicalLabel)
            : (result.Candidates ?? Array.Empty<DestinationSearchCandidate>())
                .Any(candidate => StringComparer.Ordinal.Equals(candidate.Label, destination.CanonicalLabel)));

    private static string Describe(DestinationSearchResult result)
    {
        string named = result.Destination is not null
            ? result.Destination.Label ?? result.Destination.Ref ?? "nothing"
            : string.Join(", ", (result.Candidates ?? Array.Empty<DestinationSearchCandidate>()).Select(candidate => candidate.Label));
        return named.Length == 0 ? $"{result.Status}/{result.Reason}" : $"{result.Status}/{result.Reason}: {named}";
    }
}
