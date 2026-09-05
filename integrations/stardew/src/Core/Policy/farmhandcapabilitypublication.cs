namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// Opaque identity minted only by a live Mod capability publication. Its value
/// has no policy semantics and exists solely for exact identity comparison.
/// </summary>
public sealed record FarmhandPolicyIdentity
{
    internal FarmhandPolicyIdentity(string value)
    {
        if (!Guid.TryParseExact(value, "N", out _))
            throw new ArgumentException("Policy identity must be an opaque GUID.", nameof(value));
        this.Value = value;
    }

    public string Value { get; }

    internal static FarmhandPolicyIdentity Mint() => new(Guid.NewGuid().ToString("N"));
}

/// <summary>
/// Immutable, Mod-owned publication of the enabled subset of the fixed
/// Farmhand action catalog. Its revision orders capability changes within one
/// loaded Mod embodiment; it is not a hash or version of registrations.
/// </summary>
public sealed class FarmhandCapabilityPublication
{
    private FarmhandCapabilityPublication(long capabilityRevision, FarmhandCapabilitySet capabilitySet, FarmhandPolicyIdentity policyIdentity)
    {
        this.CapabilityRevision = capabilityRevision;
        this.CapabilitySet = capabilitySet;
        this.PolicyIdentity = policyIdentity;
    }

    public long CapabilityRevision { get; }
    public FarmhandCapabilitySet CapabilitySet { get; }
    /// <summary>Non-reusable opaque identity for this exact live publication.</summary>
    public FarmhandPolicyIdentity PolicyIdentity { get; }
    /// <summary>Only execution IDs; read-only membership is published via CapabilitySet.AdvertisedCapabilityIds.</summary>
    public IReadOnlyList<string> EnabledActionIds => this.CapabilitySet.EnabledActionIds;

    public static FarmhandCapabilityPublication Initial(IReadOnlySet<string> enabledActions)
    {
        ArgumentNullException.ThrowIfNull(enabledActions);
        return new(1, FarmhandCapabilitySet.FromPolicyEnabledOperations(enabledActions), FarmhandPolicyIdentity.Mint());
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
            : new FarmhandCapabilityPublication(this.CapabilityRevision + 1, next, FarmhandPolicyIdentity.Mint());
    }
}
