namespace GameBuddy.Stardew.Core.Policy;

public sealed record ActionPolicyOptions(
    int ActionPolicyVersion = 1,
    IReadOnlyList<string>? DeniedActions = null,
    IReadOnlyList<string>? DeniedActionFamilies = null,
    IReadOnlyList<string>? ExperimentalActions = null,
    IReadOnlyList<string>? EnabledActions = null
);

public static class ActionPolicyEngine
{
    public static IReadOnlySet<string> ComputeEnabledActions(ActionPolicyOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        if (options.ActionPolicyVersion == 1)
        {
            HashSet<string> deniedActions = new(options.DeniedActions ?? Array.Empty<string>(), StringComparer.Ordinal);
            HashSet<string> deniedFamilies = new(options.DeniedActionFamilies ?? Array.Empty<string>(), StringComparer.Ordinal);
            HashSet<string> result = new(FarmhandActionCatalog.Registrations
                .Where(registration => registration.Lifecycle == FarmhandActionLifecycle.Published
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

        HashSet<string> definedActions = new(FarmhandActionCatalog.Registrations.Select(registration => registration.ActionId), StringComparer.Ordinal);
        return new HashSet<string>((options.EnabledActions ?? Array.Empty<string>()).Where(definedActions.Contains), StringComparer.Ordinal);
    }

    public static bool ValidateActionPolicy(ActionPolicyOptions options)
    {
        if (options.ActionPolicyVersion is not (0 or 1)) return false;
        if (options.ActionPolicyVersion == 0 && ((options.DeniedActions?.Count ?? 0) > 0 || (options.DeniedActionFamilies?.Count ?? 0) > 0)) return false;
        if (options.ActionPolicyVersion == 1 && options.EnabledActions is not null) return false;

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
