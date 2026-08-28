using System.Text;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class WorldMapProjectionTests
{
    private static readonly BridgeScope Scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");
    private static readonly NavigationBindingContext Context = new("runtime_01", Scope, "generation_01", 1, DateTimeOffset.FromUnixTimeMilliseconds(1_000_000));

    [Fact]
    public void Root_FlattensUnlabeledValleyAndGingerIslandContainers()
    {
        DerivedDestinationSet set = Set(
            Node.Root(
                Node.Structural("Valley", Leaf("Farm", "farm")),
                Node.Structural("GingerIsland", Leaf("Island Farm", "island_farm"))));

        WorldMapProjectionResult result = new WorldMapProjection(new NavigationReferenceStore()).ProjectRoot(set, Context);

        result.Entries!.Select(entry => entry.Label).Should().BeEquivalentTo("Farm", "Island Farm");
        result.Entries.Should().NotContain(entry => entry.Label == "Valley" || entry.Label == "GingerIsland");
        result.Entries.Should().OnlyContain(entry => entry.NodeRef != null || entry.Destination != null);
    }

    [Fact]
    public void LabeledSingleton_IsFolded_ButLabeledBranchIsReturned()
    {
        DerivedDestinationSet set = Set(
            Node.Root(
                Node.Group("Only choice", Leaf("Farm", "farm")),
                Node.Group("Choose area", Leaf("Town", "town"), Leaf("Beach", "beach"))));

        WorldMapProjectionResult result = new WorldMapProjection(new NavigationReferenceStore()).ProjectRoot(set, Context);

        result.Entries!.Select(entry => entry.Label).Should().BeEquivalentTo("Farm", "Choose area");
        result.Entries!.Single(entry => entry.Label == "Farm").Destination.Should().NotBeNull();
        result.Entries!.Single(entry => entry.Label == "Choose area").NodeRef.Should().MatchRegex("^nr1_[A-Za-z0-9_-]{22}$");
    }

    [Fact]
    public void ExpandableDestination_IsOneEntryWithNodeAndDestination()
    {
        DerivedDestinationSet set = Set(Node.Root(Node.Group("Farm", "farm", Leaf("Farmhouse", "farmhouse"))));

        WorldMapProjectionResult result = new WorldMapProjection(new NavigationReferenceStore()).ProjectRoot(set, Context);

        WorldMapProjectionEntry entry = result.Entries.Should().ContainSingle().Subject;
        entry.Label.Should().Be("Farm");
        entry.NodeRef.Should().MatchRegex("^nr1_[A-Za-z0-9_-]{22}$");
        entry.Destination.Should().NotBeNull();
    }

    [Fact]
    public void DuplicateLabels_UseRefsAndContextLabels()
    {
        DerivedDestinationSet set = Set(Node.Root(
            Leaf("Cabin", "cabin_a", "West"),
            Leaf("Cabin", "cabin_b", "East")));

        WorldMapProjectionResult result = new WorldMapProjection(new NavigationReferenceStore()).ProjectRoot(set, Context);

        result.Entries.Should().NotBeNull();
        result.Entries!.Should().HaveCount(2);
        result.Entries.Should().OnlyContain(entry => entry.Destination != null && entry.Destination.Kind == "ref");
        result.Entries!.Select(entry => entry.ContextLabel).Should().BeEquivalentTo("West", "East");
    }

    [Fact]
    public void UnresolvedLeaf_IsOmitted()
    {
        DerivedDestinationSet set = Set(Node.Root(
            Node.Leaf("Unresolved", null, null),
            Leaf("Farm", "farm")));

        WorldMapProjectionResult result = new WorldMapProjection(new NavigationReferenceStore()).ProjectRoot(set, Context);

        result.Entries.Should().ContainSingle().Which.Label.Should().Be("Farm");
    }

    [Fact]
    public void Pagination_IssuesCursorOnlyWhenA21stValidItemExists()
    {
        DerivedDestinationSet set = Set(Node.Root(Enumerable.Range(1, 21).Select(index => Leaf($"Location {index}", $"location_{index}")).ToArray()));
        var store = new NavigationReferenceStore();
        var projection = new WorldMapProjection(store);

        WorldMapProjectionResult first = projection.ProjectRoot(set, Context);
        first.Entries.Should().HaveCount(20);
        first.NextCursor.Should().MatchRegex("^wc1_[A-Za-z0-9_-]{22}$");

        WorldMapProjectionResult second = projection.ProjectCursor(set, first.NextCursor!, Context);
        second.Entries.Should().ContainSingle().Which.Label.Should().Be("Location 21");
        second.NextCursor.Should().BeNull();
    }

    [Fact]
    public void OversizedEntry_FailsRatherThanTruncatingSelector()
    {
        string label = new('x', 128);
        string context = new('y', 128);
        DerivedDestinationSet set = Set(Node.Root(Leaf(label, "farm", context)));
        var projection = new WorldMapProjection(new NavigationReferenceStore(), maximumResultBytes: Encoding.UTF8.GetByteCount("{\"status\":\"succeeded\"}"));

        WorldMapProjectionResult result = projection.ProjectRoot(set, Context);

        result.Should().BeEquivalentTo(WorldMapProjectionResult.Blocked("world_map_projection_too_large"));
    }

    private static DerivedDestinationSet Set(NavigationSourceNode root) => new("generation_01", root);

    private static NavigationSourceNode Leaf(string label, string identity, string? contextLabel = null) =>
        Node.Leaf(label, new NavigationDestination("stardew", identity, label, contextLabel), contextLabel);

    private static class Node
    {
        internal static NavigationSourceNode Root(params NavigationSourceNode[] children) => new("root", null, null, null, children);
        internal static NavigationSourceNode Structural(string internalId, params NavigationSourceNode[] children) => new(internalId, null, null, null, children);
        internal static NavigationSourceNode Group(string label, params NavigationSourceNode[] children) => new(label, label, null, null, children);
        internal static NavigationSourceNode Group(string label, string identity, params NavigationSourceNode[] children) => new(label, label, new NavigationDestination("stardew", identity, label, null), null, children);
        internal static NavigationSourceNode Leaf(string label, NavigationDestination? destination, string? contextLabel) => new(label, label, destination, contextLabel, Array.Empty<NavigationSourceNode>());
    }
}
