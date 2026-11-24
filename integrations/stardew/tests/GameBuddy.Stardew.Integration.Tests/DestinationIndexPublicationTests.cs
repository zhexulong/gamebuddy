using System;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The Mod's whole part in `find_destination`: publish the names, and mint one handle per destination identity.
///
/// <para>
/// The matching cases moved with the matcher to `host/src/stardew-destination-search.test.ts`, and the one case that could
/// NOT move is here, because it is not a matching question: resolving a `dr1_` handle back to a destination is this side's
/// reference store, and the Host has no such thing.
/// </para>
/// </summary>
public sealed class DestinationIndexPublicationTests
{
    private static readonly BridgeScope Scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");
    private static readonly NavigationBindingContext Context = new("runtime_01", Scope, "generation_01", 1, DateTimeOffset.UtcNow);

    private readonly ITestOutputHelper output;

    public DestinationIndexPublicationTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryDestinationIsPublishedOnceWithTheNamesAndHandleItsOwnRowDeclares()
    {
        DerivedDestinationSet set = Set(
            Leaf("矿井", "Mine", null, "Mines", new[] { "Mines" }, null),
            NpcLeaf("乔迪，肯特和山姆的家", "SamHouse", new[] { "Jodi", "乔迪" }, new[] { "DesertFestival_Jodi", "山洞萝卜" }),
            new NavigationSourceNode("water", "Pond", new NavigationDestination(
                "stardew", "Farm", "Pond", "Farm", null, new[] { "Pond", "水源" }), null, Array.Empty<NavigationSourceNode>()),
            Leaf("Farm", "Farm", "Farm", null, new[] { "Farm" }, null));

        BridgeDestinationIndexResult publication = Publish(set);

        publication.Status.Should().Be("index");
        publication.Reason.Should().Be("destination_index_published");
        publication.Generation.Should().Be(set.Generation);
        publication.Destinations.Should().NotBeNull().And.HaveCount(set.SearchDestinations.Count);
        BridgeDestinationIndexRow mine = publication.Destinations!.Single(row => row.Label == "矿井");
        mine.FallbackLabel.Should().Be("Mines");
        mine.Aliases.Should().Equal("Mines");
        mine.RelatedNpcs.Should().BeEmpty();
        mine.ServiceTerms.Should().BeEmpty();
        BridgeDestinationIndexRow home = publication.Destinations!.Single(row => row.Label == "乔迪，肯特和山姆的家");
        home.RelatedNpcs.Should().Equal("Jodi", "乔迪");
        home.ServiceTerms.Should().Equal("DesertFestival_Jodi", "山洞萝卜");

        // A name is published in the field its own row derived it into, and a field with nothing in it is published as an
        // EMPTY list rather than as null: the Host reads lists, and a null would be a second spelling of "no names".
        foreach (BridgeDestinationIndexRow row in publication.Destinations!)
        {
            row.Aliases.Should().NotBeNull();
            row.RelatedNpcs.Should().NotBeNull();
            row.ServiceTerms.Should().NotBeNull();
        }

        this.output.WriteLine($"destinations published {publication.Destinations!.Count}");
    }

    [Fact]
    public void OneHandleNamesOneIdentity_SoTheWaterLandmarkAndItsFarmShareIt()
    {
        // The landmark declares the farm's identity on purpose: the arrival rule is the farm's, and a handle names the
        // IDENTITY, not a spelling. Two rows therefore share one handle and both resolve to the same place.
        DerivedDestinationSet set = Set(
            Leaf("Farm", "Farm", "Farm", null, new[] { "Farm" }, null),
            new NavigationSourceNode("water", "Pond", new NavigationDestination(
                "stardew", "Farm", "Pond", null, null, new[] { "Pond", "水源" }), null, Array.Empty<NavigationSourceNode>()));

        BridgeDestinationIndexResult publication = Publish(set);

        BridgeDestinationIndexRow farm = publication.Destinations!.Single(row => row.Label == "Farm");
        BridgeDestinationIndexRow pond = publication.Destinations!.Single(row => row.Label == "Pond");
        pond.Ref.Should().Be(farm.Ref);
        publication.Destinations!.Select(row => row.Ref).Distinct().Should().HaveCount(1);
    }

    /// <summary>
    /// A handle a caller copies out of the publication is the SAME kind of thing `find_destination` used to mint: it
    /// resolves inside its issuing runtime, scope and source generation, and nowhere else. This is the case that could not
    /// move to the Host - `NavigationReferenceStore` is this side's.
    /// </summary>
    [Fact]
    public void PublishedHandlesResolveOnlyWithinTheirRuntimeScopeAndGeneration()
    {
        var store = new NavigationReferenceStore();
        DerivedDestinationSet set = Set(Leaf("Mine", "mine_west", "Mine", null, null, null));
        BridgeDestinationIndexResult publication = DestinationIndexPublication.Build(set, store, Context);
        string reference = publication.Destinations!.Single().Ref;
        var selector = new NavigationDestinationSelector("ref", null, reference);

        store.TryResolveDestination(selector, Context, out NavigationDestinationBinding? binding, out string reason, out _).Should().BeTrue(reason);
        binding!.CanonicalDestinationIdentity.Should().Be("mine_west");

        store.TryResolveDestination(
            selector,
            Context with { Scope = new BridgeScope("stardew", "save_02", "world_01", "player_01", "companion_01") },
            out _, out reason, out string? detail).Should().BeFalse();
        reason.Should().Be("destination_ref_scope_changed");
        detail.Should().Be("stale=scope_changed");

        store.TryResolveDestination(selector, Context with { SourceGeneration = "generation_02" }, out _, out reason, out detail)
            .Should().BeFalse();
        reason.Should().Be("destination_ref_source_generation_changed");
        detail.Should().Be("stale=source_generation_changed");
    }

    [Fact]
    public void APublicationPastTheRowBoundIsRefusedByNameRatherThanTruncated()
    {
        // 513 destinations: every row would be published, the report says so by name, and no partial list is offered - a
        // directory missing a row would make the Host answer "no such place" for a place it holds.
        NavigationSourceNode[] nodes = Enumerable.Range(0, DestinationIndexPublication.MaximumDestinations + 1)
            .Select(index => Leaf($"Place {index:D3}", $"place_{index:D3}", null, null, null, null))
            .ToArray();
        DerivedDestinationSet set = new("generation_01", new NavigationSourceNode("root", null, null, null, nodes));

        BridgeDestinationIndexResult publication = DestinationIndexPublication.Build(set, new NavigationReferenceStore(), Context);

        publication.Status.Should().Be("blocked");
        publication.Reason.Should().Be("destination_index_too_large");
        publication.Generation.Should().BeNull();
        publication.Destinations.Should().BeNull();
    }

    private static BridgeDestinationIndexResult Publish(DerivedDestinationSet set) =>
        DestinationIndexPublication.Build(set, new NavigationReferenceStore(), Context);

    private static DerivedDestinationSet Set(params NavigationSourceNode[] nodes) =>
        new("generation_01", new NavigationSourceNode("root", null, null, null, nodes));

    private static NavigationSourceNode Leaf(
        string label,
        string identity,
        string? contextLabel,
        string? fallbackLabel,
        string[]? aliases,
        string[]? serviceTerms) =>
        new(identity, label, new NavigationDestination("stardew", identity, label, contextLabel, fallbackLabel, aliases, null, serviceTerms),
            null, Array.Empty<NavigationSourceNode>());

    private static NavigationSourceNode NpcLeaf(string label, string identity, string[]? relatedNpcs, string[]? serviceTerms) =>
        new(identity, label, new NavigationDestination("stardew", identity, label, null, null, null, relatedNpcs, serviceTerms),
            null, Array.Empty<NavigationSourceNode>());
}
