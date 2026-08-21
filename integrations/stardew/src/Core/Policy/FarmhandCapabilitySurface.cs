namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// Immutable deterministic Farmhand publication. Game action membership comes
/// from policy resolution; control entries are fixed protocol capabilities.
/// </summary>
public sealed class FarmhandCapabilitySurface
{
    private static readonly IReadOnlyList<string> ProtocolControls = Array.AsReadOnly(new[]
    {
        "inspect_self",
        "cancel_active_execution",
    });

    private readonly IReadOnlySet<string> gameActions;

    private FarmhandCapabilitySurface(IReadOnlySet<string> gameActions, IReadOnlyList<string> capabilities)
    {
        this.gameActions = gameActions;
        this.Capabilities = capabilities;
    }

    public IReadOnlyList<string> Capabilities { get; }

    public bool ContainsGameAction(string action) => this.gameActions.Contains(action);

    public static FarmhandCapabilitySurface FromEnabledActions(IReadOnlySet<string> enabledActions)
    {
        ArgumentNullException.ThrowIfNull(enabledActions);
        string[] orderedActions = enabledActions.OrderBy(action => action, StringComparer.Ordinal).ToArray();
        HashSet<string> immutableMembership = new(orderedActions, StringComparer.Ordinal);
        return new FarmhandCapabilitySurface(
            immutableMembership,
            Array.AsReadOnly(orderedActions.Concat(ProtocolControls).ToArray()));
    }
}
