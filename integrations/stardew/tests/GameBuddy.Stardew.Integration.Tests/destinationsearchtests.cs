using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class DestinationSearchTests
{
    private static readonly BridgeScope Scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");
    private static readonly NavigationBindingContext Context = new("runtime_01", Scope, "generation_01", 1, DateTimeOffset.UtcNow);

    private static DestinationSearchResult Find(DerivedDestinationSet set, string? query) =>
        new DestinationSearch().Find(set, query, new NavigationReferenceStore(), Context);

    [Fact]
    public void Find_ResolvesOneExactCurrentLocaleLabel()
    {
        DestinationSearchResult result = Find(Set(Leaf("Mine", "Mine")), " mine ");

        result.Status.Should().Be("resolved");
        result.Reason.Should().Be("exact_current_locale");
        result.Destination.Should().Be(new NavigationDestinationSelector("label", "Mine", null));
        result.UnlockState.Should().Be("unknown");
    }

    [Fact]
    public void Find_ReturnsAtMostThreeFuzzyCandidatesWithoutScores()
    {
        DestinationSearchResult result = Find(Set(
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
        DestinationSearchResult result = Find(Set(
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
        DestinationSearchResult result = Find(Set(
            Leaf("Mine", "Mine_A"), Leaf("Mine", "Mine_B")), "mine");

        result.Status.Should().Be("candidates");
        result.Reason.Should().Be("ambiguous_exact");
        result.Candidates.Should().HaveCount(2);
        result.Candidates!.Select(candidate => candidate.Selector.Kind).Should().OnlyContain(kind => kind == "ref");
        result.Candidates!.Select(candidate => candidate.Selector.Ref).Should().OnlyContain(reference =>
            NavigationReferenceStore.IsWellFormedHandle(reference, "dr1_"));
    }

    [Fact]
    public void Find_OpaqueCandidatesResolveOnlyWithinTheirIssuingRuntimeScopeAndGeneration()
    {
        var store = new NavigationReferenceStore();
        DerivedDestinationSet set = Set(Leaf("Mine", "mine_west"), Leaf("Mine", "mine_east"));
        DestinationSearchResult result = new DestinationSearch().Find(set, "mine", store, Context);

        result.Candidates.Should().NotBeNull().And.HaveCount(2);
        foreach (DestinationSearchCandidate candidate in result.Candidates!)
        {
            store.TryResolveDestination(candidate.Selector, Context, out NavigationDestinationBinding? binding, out string reason)
                .Should().BeTrue(reason);
            binding!.CanonicalDestinationIdentity.Should().BeOneOf("mine_west", "mine_east");
            store.TryResolveDestination(candidate.Selector, Context with { Scope = new BridgeScope("stardew", "save_02", "world_01", "player_01", "companion_01") }, out _, out reason)
                .Should().BeFalse();
            reason.Should().Be("destination_ref_stale");
            store.TryResolveDestination(candidate.Selector, Context with { SourceGeneration = "generation_02" }, out _, out reason)
                .Should().BeFalse();
            reason.Should().Be("destination_ref_stale");
        }
    }

    [Fact]
    public void Find_FourExactMatches_ReturnsFirstThreeDeterministicCandidates()
    {
        DestinationSearchResult result = Find(Set(
            Leaf("Zulu", "Zulu", "mine"),
            Leaf("Bravo", "Bravo", "mine"),
            Leaf("Alpha", "Alpha", "mine"),
            Leaf("Charlie", "Charlie", "mine")),
            "mine");

        result.Status.Should().Be("candidates");
        result.Reason.Should().Be("ambiguous_exact");
        result.Candidates.Should().NotBeNull();
        result.Candidates!.Select(candidate => candidate.Label).Should().Equal("Alpha", "Bravo", "Charlie");
        result.Candidates.Should().OnlyContain(candidate =>
            candidate.Selector.Kind == "ref" && candidate.Selector.Label == null
                && NavigationReferenceStore.IsWellFormedHandle(candidate.Selector.Ref, "dr1_"));
    }

    private static readonly string[] NavigationActions =
    {
        "inspect_world_map",
        "find_destination",
        "navigate_to_destination",
    };

    [Fact]
    public void LegacyExplicitPolicy_PreservesTheExactPublishedNavigationSurface()
    {
        var config = new ModConfig
        {
            ActionPolicyVersion = 0,
            EnabledActions = NavigationActions.ToList(),
        };

        config.HasValidActionPolicy.Should().BeTrue();
        config.EnabledActionSet.Should().BeEquivalentTo(NavigationActions);
    }

    [Fact]
    public void DefaultPolicy_DeniedWorldNavigationFamilyWithdrawsEveryNavigationOperation()
    {
        var config = new ModConfig
        {
            ActionPolicyVersion = 1,
            DeniedActionFamilies = new List<string> { "world_navigation" },
        };

        config.HasValidActionPolicy.Should().BeTrue();
        config.EnabledActionSet.Should().NotContain(NavigationActions);
    }

    [Fact]
    public void NavigationMutationFixture_AllowsOnlyItsBoundedPrivateTargetField()
    {
        var fixture = new NativeLocalPlayerFixtureConfig
        {
            Enable = true,
            LogicalSaveName = "GameBuddyFixtureNavigation",
            ObservedSaveSlot = "GameBuddyFixtureNavigation_123456789",
            TimeoutSeconds = 120,
            FixtureScenario = "navigation_mutation_v1",
        };

        fixture.IsValid.Should().BeTrue();
        fixture.NavigationMutationTargetLabel = "Localized target";
        fixture.IsValid.Should().BeTrue();

        var unrelated = new NativeLocalPlayerFixtureConfig
        {
            Enable = true,
            LogicalSaveName = "GameBuddyFixtureNavigation",
            ObservedSaveSlot = "GameBuddyFixtureNavigation_123456789",
            TimeoutSeconds = 120,
            FixtureScenario = string.Empty,
            NavigationMutationTargetLabel = "Localized target",
        };
        unrelated.IsValid.Should().BeFalse();
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("1,2")]
    [InlineData("path/to/mine")]
    public void Find_RejectsMalformedAgentQueries(string query)
    {
        DestinationSearchResult result = Find(Set(Leaf("Mine", "Mine")), query);

        result.Status.Should().Be("invalid");
        result.Reason.Should().Be("destination_search_invalid");
    }

    private static DerivedDestinationSet Set(params NavigationSourceNode[] nodes) =>
        new("generation_01", new NavigationSourceNode("root", null, null, null, nodes));

    private static NavigationSourceNode Leaf(string label, string identity, params string[] aliases) =>
        new(identity, label, new NavigationDestination("stardew", identity, label, null, null, aliases), null, Array.Empty<NavigationSourceNode>());
}
