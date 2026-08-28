using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Navigation;

/// <summary>
/// The complete private binding context for one Navigation reference lookup.
/// It is never serialized into a bridge message.
/// </summary>
internal sealed record NavigationBindingContext(
    string RuntimeInstanceId,
    BridgeScope Scope,
    string SourceGeneration,
    long ObservationSequence,
    DateTimeOffset Now
);

internal sealed record NavigationNodeBinding(
    string ContentOwner,
    string CanonicalDestinationIdentity,
    string SourceGeneration,
    long ObservationSequence
);

internal sealed record NavigationCursorBinding(
    string ContentOwner,
    string CanonicalDestinationIdentity,
    string SourceGeneration,
    long ObservationSequence,
    string ImmutableFrontierSnapshot
);

internal sealed record NavigationDestinationBinding(
    string ContentOwner,
    string CanonicalDestinationIdentity,
    string SourceGeneration,
    long ObservationSequence
);

internal sealed record NavigationDestinationSelector(string Kind, string? Label, string? Ref)
{
    internal static bool TryCreate(string kind, string? label, string? reference, out NavigationDestinationSelector? selector)
    {
        selector = null;
        if (kind == "label" && label is not null && label.Length is >= 1 and <= 128 && reference is null)
        {
            selector = new NavigationDestinationSelector(kind, label, null);
            return true;
        }
        if (kind == "ref" && label is null && NavigationReferenceStore.IsWellFormedHandle(reference, "dr1_"))
        {
            selector = new NavigationDestinationSelector(kind, null, reference);
            return true;
        }
        return false;
    }

    /// <summary>Parses a wire selector into a private bound selector, fail closed.</summary>
    internal static bool TryCreateFromWire(Core.Models.BridgeNavigationDestinationSelector? wire, out NavigationDestinationSelector? selector)
    {
        selector = null;
        return wire is not null && TryCreate(wire.Kind, wire.Label, wire.Ref, out selector);
    }
}