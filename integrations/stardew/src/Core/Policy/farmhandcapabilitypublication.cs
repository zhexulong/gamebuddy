namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// Immutable, Mod-owned publication of the enabled subset of the fixed
/// Farmhand action catalog. Its revision orders capability changes within one
/// loaded Mod embodiment; it is not a hash or version of registrations.
/// </summary>
public sealed class FarmhandCapabilityPublication
{
    private FarmhandCapabilityPublication(long capabilityRevision, FarmhandCapabilitySet capabilitySet)
    {
        this.CapabilityRevision = capabilityRevision;
        this.CapabilitySet = capabilitySet;
    }

    public long CapabilityRevision { get; }
    public FarmhandCapabilitySet CapabilitySet { get; }
    /// <summary>Only execution IDs; read-only membership is published via CapabilitySet.AdvertisedCapabilityIds.</summary>
    public IReadOnlyList<string> EnabledActionIds => this.CapabilitySet.EnabledActionIds;

    public static FarmhandCapabilityPublication Initial(IReadOnlySet<string> enabledActions)
    {
        ArgumentNullException.ThrowIfNull(enabledActions);
        return new(1, FarmhandCapabilitySet.FromPolicyEnabledOperations(enabledActions));
    }

    /// <summary>
    /// Returns this exact immutable publication when policy resolution has not
    /// changed semantic membership; otherwise returns one complete successor.
    /// Call only on the game thread that owns admission and bridge projection.
    /// </summary>
    public FarmhandCapabilityPublication WithEnabledActions(IReadOnlySet<string> enabledActions)
    {
        ArgumentNullException.ThrowIfNull(enabledActions);
        FarmhandCapabilitySet next = FarmhandCapabilitySet.FromPolicyEnabledOperations(enabledActions);
        return this.CapabilitySet.AdvertisedCapabilityIds.SequenceEqual(next.AdvertisedCapabilityIds, StringComparer.Ordinal)
            ? this
            : new FarmhandCapabilityPublication(this.CapabilityRevision + 1, next);
    }
}
