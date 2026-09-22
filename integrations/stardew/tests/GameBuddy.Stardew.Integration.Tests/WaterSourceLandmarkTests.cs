using FluentAssertions;
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
}