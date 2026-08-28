namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// Immutable deterministic Farmhand capability set. Policy resolves both
/// execution actions and read-only operations; control entries are fixed
/// protocol capabilities.
/// </summary>
public sealed class FarmhandCapabilitySet
{
    private static readonly IReadOnlyList<string> ProtocolControls = Array.AsReadOnly(new[]
    {
        "inspect_self",
        "cancel_active_execution",
    });

    private readonly IReadOnlySet<string> gameActions;
    private readonly IReadOnlySet<string> readOnlyOperations;

    private FarmhandCapabilitySet(
        IReadOnlySet<string> gameActions,
        IReadOnlySet<string> readOnlyOperations,
        IReadOnlyList<string> advertisedCapabilityIds)
    {
        this.gameActions = gameActions;
        this.readOnlyOperations = readOnlyOperations;
        this.AdvertisedCapabilityIds = advertisedCapabilityIds;
    }

    public IReadOnlyList<string> AdvertisedCapabilityIds { get; }

    /// <summary>Sorted enabled ordinary action IDs; protocol controls are excluded.</summary>
    public IReadOnlyList<string> EnabledActionIds => this.gameActions.OrderBy(action => action, StringComparer.Ordinal).ToArray();

    public bool AllowsExecutionAction(string action) => this.gameActions.Contains(action);

    public bool AllowsReadOperation(string operation) => this.readOnlyOperations.Contains(operation);

    public static FarmhandCapabilitySet FromPolicyEnabledOperations(IReadOnlySet<string> enabledActions)
    {
        ArgumentNullException.ThrowIfNull(enabledActions);
        HashSet<string> knownOperations = new(FarmhandActionCatalog.Registrations.Select(registration => registration.ActionId), StringComparer.Ordinal);
        HashSet<string> requested = new(enabledActions.Where(knownOperations.Contains), StringComparer.Ordinal);
        string[] orderedActions = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Kind == FarmhandOperationKind.Execution && requested.Contains(registration.ActionId))
            .Select(registration => registration.ActionId)
            .OrderBy(action => action, StringComparer.Ordinal)
            .ToArray();
        string[] orderedReadOnlyOperations = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Kind == FarmhandOperationKind.ReadOnly && requested.Contains(registration.ActionId))
            .Select(registration => registration.ActionId)
            .OrderBy(action => action, StringComparer.Ordinal)
            .ToArray();
        return new FarmhandCapabilitySet(
            new HashSet<string>(orderedActions, StringComparer.Ordinal),
            new HashSet<string>(orderedReadOnlyOperations, StringComparer.Ordinal),
            Array.AsReadOnly(orderedActions.Concat(orderedReadOnlyOperations).Concat(ProtocolControls).ToArray()));
    }
}
