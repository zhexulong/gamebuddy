using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class NavigationReferenceStoreTests
{
    private static readonly BridgeScope Scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");
    private static readonly DateTimeOffset Now = DateTimeOffset.FromUnixTimeMilliseconds(1_000_000);

    [Fact]
    public void Node_HandleIsOpaqueScopeBoundAndGenerationBound()
    {
        var store = new NavigationReferenceStore();
        NavigationBindingContext context = Context();
        string handle = store.IssueNode(context, new NavigationNodeBinding("owner_01", "location_01", "generation_01", 7));

        handle.Should().MatchRegex("^nr1_[A-Za-z0-9_-]{22}$");
        store.TryResolveNode(handle, context, out NavigationNodeBinding? binding, out string reason).Should().BeTrue(reason);
        binding!.CanonicalDestinationIdentity.Should().Be("location_01");
        store.TryResolveNode(handle, context with { SourceGeneration = "generation_02" }, out _, out reason).Should().BeFalse();
        reason.Should().Be("world_map_node_stale");
        store.TryResolveCursor(handle, context, out _, out reason).Should().BeFalse();
        reason.Should().Be("world_map_cursor_invalid");
    }

    [Fact]
    public void Cursor_ResolvesOnlyItsOwnImmutableFrontierAndNotAfterExpiry()
    {
        var store = new NavigationReferenceStore();
        NavigationBindingContext context = Context();
        string cursor = store.IssueCursor(context, new NavigationCursorBinding("owner_01", "location_01", "generation_01", 7, "frontier_snapshot_01"));

        store.TryResolveCursor(cursor, context, out NavigationCursorBinding? binding, out string reason).Should().BeTrue(reason);
        binding!.ImmutableFrontierSnapshot.Should().Be("frontier_snapshot_01");
        store.TryResolveCursor(cursor, context with { Now = Now.AddMinutes(5) }, out _, out reason).Should().BeFalse();
        reason.Should().Be("world_map_cursor_stale");
    }

    [Fact]
    public void DestinationRef_RequiresExactRefSelectorAndClearsOnRuntimeClose()
    {
        var store = new NavigationReferenceStore();
        NavigationBindingContext context = Context();
        string destinationRef = store.IssueDestination(context, new NavigationDestinationBinding("owner_01", "location_01", "generation_01", 7));

        NavigationDestinationSelector.TryCreate("ref", null, destinationRef, out NavigationDestinationSelector? selector).Should().BeTrue();
        store.TryResolveDestination(selector!, context, out NavigationDestinationBinding? binding, out string reason).Should().BeTrue(reason);
        binding!.ContentOwner.Should().Be("owner_01");
        store.Close();
        store.TryResolveDestination(selector!, context, out _, out reason).Should().BeFalse();
        reason.Should().Be("destination_ref_stale");
    }

    private static NavigationBindingContext Context() => new("runtime_01", Scope, "generation_01", 7, Now);
}
