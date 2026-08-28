using System.Text;
using System.Text.Json;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Navigation;

internal sealed record WorldMapProjectionEntry(
    string Label,
    string? ContextLabel,
    string? NodeRef,
    NavigationDestinationSelector? Destination
);

internal sealed record WorldMapProjectionResult(
    IReadOnlyList<WorldMapProjectionEntry>? Entries,
    string? NextCursor,
    string? BlockedReason)
{
    internal static WorldMapProjectionResult Succeeded(IReadOnlyList<WorldMapProjectionEntry> entries, string? nextCursor) => new(entries, nextCursor, null);
    internal static WorldMapProjectionResult Blocked(string reason) => new(null, null, reason);
}

/// <summary>
/// Converts one immutable, already condition-filtered DerivedDestinationSet
/// into the compact decision frontier contract. It never exposes source IDs,
/// positions, routes, conditions, or source provenance.
/// </summary>
internal sealed class WorldMapProjection
{
    private const int MaximumEntries = 20;
    private readonly NavigationReferenceStore references;
    private readonly int maximumResultBytes;

    internal WorldMapProjection(NavigationReferenceStore references, int maximumResultBytes = 4096)
    {
        this.references = references ?? throw new ArgumentNullException(nameof(references));
        this.maximumResultBytes = maximumResultBytes;
    }

    internal WorldMapProjectionResult ProjectRoot(DerivedDestinationSet set, NavigationBindingContext context) =>
        this.Project(set, set.Root, context, 0, null);

    internal WorldMapProjectionResult ProjectNode(DerivedDestinationSet set, string nodeRef, NavigationBindingContext context)
    {
        if (!this.references.TryResolveNode(nodeRef, context, out NavigationNodeBinding? binding, out string reason))
            return WorldMapProjectionResult.Blocked(reason);
        if (binding!.SourceGeneration != set.Generation)
            return WorldMapProjectionResult.Blocked("world_map_node_stale");
        NavigationSourceNode? node = FindNode(set.Root, binding.CanonicalDestinationIdentity);
        return node is null
            ? WorldMapProjectionResult.Blocked("world_map_node_not_found")
            : this.Project(set, node, context, 0, null);
    }

    internal WorldMapProjectionResult ProjectCursor(DerivedDestinationSet set, string cursor, NavigationBindingContext context)
    {
        if (!this.references.TryResolveCursor(cursor, context, out NavigationCursorBinding? binding, out string reason))
            return WorldMapProjectionResult.Blocked(reason);
        if (binding!.SourceGeneration != set.Generation)
            return WorldMapProjectionResult.Blocked("world_map_cursor_stale");
        NavigationSourceNode? node = FindNode(set.Root, binding.CanonicalDestinationIdentity);
        if (node is null)
            return WorldMapProjectionResult.Blocked("world_map_cursor_stale");
        if (!int.TryParse(binding.ImmutableFrontierSnapshot, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out int offset) || offset < 0)
            return WorldMapProjectionResult.Blocked("world_map_cursor_stale");
        return this.Project(set, node, context, offset, binding.ImmutableFrontierSnapshot);
    }

    private WorldMapProjectionResult Project(
        DerivedDestinationSet set,
        NavigationSourceNode requested,
        NavigationBindingContext context,
        int offset,
        string? expectedSnapshot)
    {
        IReadOnlyList<NavigationSourceNode> frontier = FoldToFrontier(requested);
        string snapshot = offset.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (expectedSnapshot is not null && expectedSnapshot != snapshot)
            return WorldMapProjectionResult.Blocked("world_map_cursor_stale");
        if (offset >= frontier.Count)
            return WorldMapProjectionResult.Blocked("world_map_cursor_stale");

        HashSet<string> labels = frontier
            .Where(node => node.Destination is not null)
            .GroupBy(node => node.Destination!.CanonicalLabel, StringComparer.Ordinal)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key)
            .ToHashSet(StringComparer.Ordinal);

        var entries = new List<WorldMapProjectionEntry>();
        for (int index = offset; index < frontier.Count && entries.Count < MaximumEntries; index++)
        {
            NavigationSourceNode node = frontier[index];
            string? nodeRef = HasEffectiveChildren(node)
                ? this.references.IssueNode(context, new NavigationNodeBinding("world_map", node.InternalId, set.Generation, context.ObservationSequence))
                : null;
            NavigationDestinationSelector? selector = node.Destination is null
                ? null
                : CreateSelector(node.Destination, labels.Contains(node.Destination.CanonicalLabel), set, context);
            if (nodeRef is null && selector is null)
                continue;
            entries.Add(new WorldMapProjectionEntry(node.Label!, node.ContextLabel, nodeRef, selector));
        }

        int nextOffset = offset + entries.Count;
        string? nextCursor = nextOffset < frontier.Count
            ? this.references.IssueCursor(context, new NavigationCursorBinding("world_map", requested.InternalId, set.Generation, context.ObservationSequence, nextOffset.ToString(System.Globalization.CultureInfo.InvariantCulture)))
            : null;
        WorldMapProjectionResult result = WorldMapProjectionResult.Succeeded(entries, nextCursor);
        return SerializedBytes(result) <= this.maximumResultBytes
            ? result
            : WorldMapProjectionResult.Blocked("world_map_projection_too_large");
    }

    private NavigationDestinationSelector CreateSelector(NavigationDestination destination, bool isAmbiguous, DerivedDestinationSet set, NavigationBindingContext context)
    {
        if (!isAmbiguous)
            return new NavigationDestinationSelector("label", destination.CanonicalLabel, null);
        string reference = this.references.IssueDestination(context, new NavigationDestinationBinding(destination.ContentOwner, destination.CanonicalIdentity, set.Generation, context.ObservationSequence));
        return new NavigationDestinationSelector("ref", null, reference);
    }

    private static IReadOnlyList<NavigationSourceNode> FoldToFrontier(NavigationSourceNode source) =>
        ExpandForDecision(source).Where(IsProjectable).ToArray();

    private static IReadOnlyList<NavigationSourceNode> ExpandForDecision(NavigationSourceNode node)
    {
        IReadOnlyList<NavigationSourceNode> children = EffectiveChildren(node);
        if (node.Label is null)
            return children.SelectMany(ExpandForDecision).ToArray();
        if (node.Destination is not null || children.Count != 1)
            return new[] { node };
        return ExpandForDecision(children[0]);
    }

    private static IReadOnlyList<NavigationSourceNode> EffectiveChildren(NavigationSourceNode node) =>
        node.Children.Where(IsProjectable).ToArray();

    private static bool IsProjectable(NavigationSourceNode node) =>
        node.Label is not null
            ? node.Destination is not null || node.Children.Any(IsProjectable)
            : node.Children.Any(IsProjectable);

    private static bool HasEffectiveChildren(NavigationSourceNode node) => EffectiveChildren(node).Count > 0;

    private static NavigationSourceNode? FindNode(NavigationSourceNode node, string internalId)
    {
        if (node.InternalId == internalId) return node;
        foreach (NavigationSourceNode child in node.Children)
        {
            NavigationSourceNode? match = FindNode(child, internalId);
            if (match is not null) return match;
        }
        return null;
    }

    private static int SerializedBytes(WorldMapProjectionResult result)
    {
        object payload = result.BlockedReason is null
            ? new
            {
                status = "succeeded",
                reason = "world_map_observed",
                entries = result.Entries!.Select(entry => new
                {
                    label = entry.Label,
                    contextLabel = entry.ContextLabel,
                    nodeRef = entry.NodeRef,
                    destination = entry.Destination is null ? null : new { kind = entry.Destination.Kind, label = entry.Destination.Label, destinationRef = entry.Destination.Ref },
                }),
                nextCursor = result.NextCursor,
            }
            : new { status = "blocked", reason = result.BlockedReason };
        return Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(payload));
    }
}
