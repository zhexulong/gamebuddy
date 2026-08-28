using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class DestinationSearchTests
{
    private static readonly BridgeScope Scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");
    private static readonly NavigationBindingContext Context = new("runtime_01", Scope, "generation_01", 1, DateTimeOffset.UtcNow);

    [Fact]
    public void Find_ResolvesOneExactCurrentLocaleLabel()
    {
        DestinationSearchResult result = new DestinationSearch().Find(Set(Leaf("Mine", "Mine")), " mine ");

        result.Status.Should().Be("resolved");
        result.Reason.Should().Be("exact_current_locale");
        result.Destination.Should().Be(new NavigationDestinationSelector("label", "Mine", null));
        result.UnlockState.Should().Be("unknown");
    }

    [Fact]
    public void Find_ReturnsAtMostThreeFuzzyCandidatesWithoutScores()
    {
        DestinationSearchResult result = new DestinationSearch().Find(Set(
            Leaf("Mine", "Mine"), Leaf("Mines", "Mines"), Leaf("Minecart", "Minecart"), Leaf("Mining Guild", "Guild")),
            "min");

        result.Status.Should().Be("candidates");
        result.Reason.Should().Be("fuzzy_match");
        result.Candidates.Should().NotBeNull().And.HaveCountLessOrEqualTo(3);
        result.Candidates!.Should().OnlyContain(candidate => candidate.UnlockState == "unknown");
        result.Candidates.Should().NotContain(candidate => candidate.Selector.Kind == "label");
    }

    [Fact]
    public void Find_ResolvesFallbackLabelOnlyWhenUnique()
    {
        DestinationSearchResult result = new DestinationSearch().Find(Set(
            new NavigationSourceNode("mine", "Mine", new NavigationDestination(
                "stardew", "Mine", "The Mines", null, "Mine"), null, Array.Empty<NavigationSourceNode>())),
            "mine");

        result.Status.Should().Be("resolved");
        result.Reason.Should().Be("exact_fallback_locale");
        result.Destination.Should().Be(new NavigationDestinationSelector("label", "The Mines", null));
    }

    [Fact]
    public void Find_UsesOpaqueCandidateMarkerForAmbiguousExactLabel()
    {
        DestinationSearchResult result = new DestinationSearch().Find(Set(
            Leaf("Mine", "Mine_A"), Leaf("Mine", "Mine_B")), "mine");

        result.Status.Should().Be("candidates");
        result.Reason.Should().Be("ambiguous_exact");
        result.Candidates.Should().HaveCount(2);
        result.Candidates!.Select(candidate => candidate.Selector.Kind).Should().OnlyContain(kind => kind == "ref");
        result.Candidates!.Select(candidate => candidate.Selector.Ref).Should().OnlyContain(reference => reference == null);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("1,2")]
    [InlineData("path/to/mine")]
    public void Find_RejectsMalformedAgentQueries(string query)
    {
        DestinationSearchResult result = new DestinationSearch().Find(Set(Leaf("Mine", "Mine")), query);

        result.Status.Should().Be("invalid");
        result.Reason.Should().Be("destination_search_invalid");
    }

    private static DerivedDestinationSet Set(params NavigationSourceNode[] nodes) =>
        new("generation_01", new NavigationSourceNode("root", null, null, null, nodes));

    private static NavigationSourceNode Leaf(string label, string identity) =>
        new(identity, label, new NavigationDestination("stardew", identity, label, null), null, Array.Empty<NavigationSourceNode>());
}
