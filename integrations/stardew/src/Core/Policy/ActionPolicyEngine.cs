namespace GameBuddy.Stardew.Core.Policy;

public sealed record ActionPolicyOptions(
    IReadOnlyList<string>? DeniedActions = null,
    IReadOnlyList<string>? DeniedActionFamilies = null,
    IReadOnlyList<string>? ExperimentalActions = null
);

public static class ActionPolicyEngine
{
    public static IReadOnlySet<string> ComputeEnabledActions(ActionPolicyOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        HashSet<string> deniedActions = new(options.DeniedActions ?? Array.Empty<string>(), StringComparer.Ordinal);
        HashSet<string> deniedFamilies = new(options.DeniedActionFamilies ?? Array.Empty<string>(), StringComparer.Ordinal);
        HashSet<string> result = new(FarmhandActionCatalog.Registrations
            .Where(registration => IsDefaultConsentLifecycle(registration.Lifecycle)
                && !deniedActions.Contains(registration.ActionId)
                && !deniedFamilies.Contains(registration.FamilyId))
            .Select(registration => registration.ActionId), StringComparer.Ordinal);

        if (options.ExperimentalActions is { Count: > 0 })
        {
            result.UnionWith(options.ExperimentalActions
                .Join(FarmhandActionCatalog.Registrations.Where(registration => registration.Lifecycle == FarmhandActionLifecycle.Experimental),
                    action => action,
                    registration => registration.ActionId,
                    (_, registration) => registration)
                .Where(registration => !deniedActions.Contains(registration.ActionId) && !deniedFamilies.Contains(registration.FamilyId))
                .Select(registration => registration.ActionId));
        }

        return result;
    }

    /// <summary>
    /// A registration enters the default-consent set once it is either fully published or
    /// live-verified on its required target topology. <c>live_verified</c> means the action has
    /// really run on the target game version and produced a native receipt/postcondition, which
    /// is enough to be visible to the Agent; <c>published</c> additionally means the full
    /// publication admission (contract, BDD, cancellation/deadline/replay, multiplayer
    /// synchronization, migration) is complete.
    /// </summary>
    public static bool IsDefaultConsentLifecycle(FarmhandActionLifecycle lifecycle) =>
        lifecycle is FarmhandActionLifecycle.Published or FarmhandActionLifecycle.LiveVerified;

    public static bool ValidateActionPolicy(ActionPolicyOptions options)
    {
        HashSet<string> actionIds = new(FarmhandActionCatalog.Registrations.Select(registration => registration.ActionId), StringComparer.Ordinal);
        HashSet<string> familyIds = new(FarmhandActionCatalog.Registrations.Select(registration => registration.FamilyId), StringComparer.Ordinal);
        HashSet<string> experimentalActionIds = new(FarmhandActionCatalog.Registrations
            .Where(registration => registration.Lifecycle == FarmhandActionLifecycle.Experimental)
            .Select(registration => registration.ActionId), StringComparer.Ordinal);

        return (options.DeniedActions ?? Array.Empty<string>()).All(actionIds.Contains)
            && (options.DeniedActionFamilies ?? Array.Empty<string>()).All(familyIds.Contains)
            && (options.ExperimentalActions ?? Array.Empty<string>()).All(experimentalActionIds.Contains);
    }
}
