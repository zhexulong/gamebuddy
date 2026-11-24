using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The navigation action surface as policy publishes it, and the fixture's one bounded private target field.
///
/// These three cases lived in `destinationsearchtests.cs` because the file was named after the action family rather than
/// after the search. The search itself is the Host's now (`host/src/stardew-destination-search.test.ts`); what is left
/// here is the Mod-side policy surface that decides whether the family is published at all.
/// </summary>
public sealed class NavigationPolicySurfaceTests
{
    private static readonly string[] NavigationActions =
    {
        "inspect_world_map",
        "find_destination",
        "navigate_to_destination",
    };

    [Fact]
    public void DefaultPolicy_ContainsThePublishedNavigationSurface()
    {
        // There is no allowlist any more: the visible set is derived from the Mod
        // registration catalog, so these actions are on unless a deny removes them.
        var config = new ModConfig();

        config.HasValidActionPolicy.Should().BeTrue();
        config.EnabledActionSet.Should().Contain(NavigationActions);
    }

    [Fact]
    public void DefaultPolicy_DeniedWorldNavigationFamilyWithdrawsEveryNavigationOperation()
    {
        var config = new ModConfig
        {
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

    [Fact]
    public void TheNavigationReadOperation_CoversTheWorldMapAndNotTheSearch()
    {
        // `find_destination` is answered by the Host from the published directory (`DestinationIndexPublication`), so the
        // Mod's own read route names the world map and the search type is GONE rather than kept as a second reader. This
        // is the seam's own statement: the wire still carries both operations, and only one of them is read here.
        typeof(BridgeSession)
            .GetMethod("TryDestinationIndex", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
            .Should().NotBeNull("the directory publication is the Mod's whole part in the search");
        typeof(BridgeSession).Assembly.GetType("GameBuddy.Stardew.Navigation.DestinationSearch")
            .Should().BeNull("the search is not a Mod type any more: it is the Host's (`stardew-destination-search.ts`)");
        typeof(BridgeSession).Assembly.GetType("GameBuddy.Stardew.Navigation.DestinationSearchIndex")
            .Should().BeNull("the inverted index is the Host's too");
    }
}
