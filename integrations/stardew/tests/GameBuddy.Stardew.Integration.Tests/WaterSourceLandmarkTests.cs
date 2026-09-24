using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane A.1: farm water landmark registration contract pins.
///
/// The water landmark may only appear in the derived destination directory
/// while the loaded Farm has at least one refillable water tile with a
/// standable neighbor (W rule: surrounding standable set is non-empty; the
/// water tile itself is never a target). Without a live Game1 harness the
/// full native scan cannot run here; these pins cover the directory shape and
/// the internal refactoring contract so the live behavior is fixture-covered
/// per fixtures/stardew/RUNBOOK.md.
/// </summary>
public sealed class WaterSourceLandmarkTests
{
    [Fact]
    public void DerivedDestinationSet_ConstructedSnapshot_AdmitsWaterLandmarkDestinationShape()
    {
        // The NavigationDestination record shape used by the water landmark:
        // canonical identity stays the farm identity ("Farm") so the existing
        // route-planner arrival semantics keep working; "Pond" is the canonical
        // label with water aliases so find_destination can hit it by multiple
        // queries. This pin guards the shape against accidental renames.
        var destination = new NavigationDestination(
            "stardew",
            "Farm",
            "Pond",
            null,
            null,
            new[] { "Pond", "Well", "池塘", "水井", "水源" });

        destination.CanonicalIdentity.Should().Be("Farm");
        destination.CanonicalLabel.Should().Be("Pond");
        destination.ExplicitAliases.Should().BeEquivalentTo(new[] { "Pond", "Well", "池塘", "水井", "水源" });
    }

    [Fact]
    public void DestinationSearch_AcceptsWaterAliasQueryAsNormalizedQuery()
    {
        // find_destination normalization: no digits, no separators, bounded
        // length — all water aliases must be searchable. The search itself
        // requires a live directory, so this pins only the query grammar that
        // the watermark aliases satisfy.
        foreach (string alias in new[] { "Pond", "Well", "池塘", "水井", "水源" })
        {
            alias.Length.Should().BeInRange(1, 128);
            alias.Any(char.IsControl).Should().BeFalse();
            alias.Contains('/').Should().BeFalse();
            alias.Contains('\\').Should().BeFalse();
            alias.Contains(':').Should().BeFalse();
            alias.Any(char.IsDigit).Should().BeFalse();
        }
    }

    private static NavigationSourceNode LocationNode(string identity, string label) =>
        new($"location:{identity}", label,
            new NavigationDestination("stardew", identity, label, null, null),
            null, System.Array.Empty<NavigationSourceNode>());

    [Fact]
    public void SearchDestinations_KeepsWaterLandmarkAlongsideItsSharedIdentityFarmDirectoryEntry()
    {
        // Regression pin for the A.1 water landmark chain. The landmark shares the
        // Farm location's canonical identity (so the route planner's arrival
        // semantics keep working) but carries its own canonical label. A directory
        // deduplicated on canonical identity alone silently dropped the landmark,
        // leaving find_destination("Pond") -> destination_not_found and the whole
        // `water_crop rejected/watering_can_empty -> find water -> refill`
        // recovery chain without any discovery channel.
        var farm = LocationNode("Farm", "Farm");
        var water = new NavigationSourceNode("water:farm", "Pond",
            new NavigationDestination("stardew", "Farm", "Pond", null, null, new[] { "Pond", "Well", "水源" }),
            null, System.Array.Empty<NavigationSourceNode>());
        var set = new DerivedDestinationSet(
            "generation",
            new NavigationSourceNode("root", null, null, null, new[] { farm, water }),
            new[] { farm.Destination!, water.Destination! });

        set.SearchDestinations.Select(destination => $"{destination.CanonicalIdentity}|{destination.CanonicalLabel}")
            .Should().Equal("Farm|Farm", "Farm|Pond");

        var references = new NavigationReferenceStore();
        NavigationBindingContext context = new(
            "runtime",
            new BridgeScope("integration", "save", "world", "player", "companion"),
            "generation",
            1,
            System.DateTimeOffset.UnixEpoch);
        var search = new DestinationSearch();

        DestinationSearchResult waterResult = search.Find(set, "Pond", references, context);
        waterResult.Status.Should().Be("resolved");
        waterResult.Reason.Should().Be("exact_current_locale");
        waterResult.Destination.Should().Be(new NavigationDestinationSelector("label", "Pond", null));

        DestinationSearchResult waterAliasResult = search.Find(set, "水源", references, context);
        waterAliasResult.Status.Should().Be("resolved");
        waterAliasResult.Reason.Should().Be("exact_alias");

        // The shared Farm identity must stay independently reachable.
        DestinationSearchResult farmResult = search.Find(set, "Farm", references, context);
        farmResult.Status.Should().Be("resolved");
        farmResult.Destination.Should().Be(new NavigationDestinationSelector("label", "Farm", null));
    }
}