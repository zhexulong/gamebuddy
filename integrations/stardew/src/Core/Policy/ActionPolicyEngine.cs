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
            HashSet<string> result = new(FarmhandActionCatalog.Definitions
                .Where(definition => definition.Lifecycle == FarmhandActionLifecycle.Published
                    && !deniedActions.Contains(definition.ActionId)
                    && !deniedFamilies.Contains(definition.FamilyId))
                .Select(definition => definition.ActionId), StringComparer.Ordinal);

            if (options.ExperimentalActions is { Count: > 0 })
            {
                result.UnionWith(options.ExperimentalActions
                    .Join(FarmhandActionCatalog.Definitions.Where(definition => definition.Lifecycle == FarmhandActionLifecycle.Experimental),
                        action => action,
                        definition => definition.ActionId,
                        (_, definition) => definition)
                    .Where(definition => !deniedActions.Contains(definition.ActionId) && !deniedFamilies.Contains(definition.FamilyId))
                    .Select(definition => definition.ActionId));
            }

            return result;
        }

        // Legacy explicit allowlist semantics (ActionPolicyVersion 0)
        HashSet<string> definedActions = new(FarmhandActionCatalog.Definitions.Select(definition => definition.ActionId), StringComparer.Ordinal);
        return new HashSet<string>((options.EnabledActions ?? Array.Empty<string>()).Where(definedActions.Contains), StringComparer.Ordinal);
    }

    public static bool ValidateActionPolicy(ActionPolicyOptions options)
    {
        if (options.ActionPolicyVersion is not (0 or 1)) return false;
        if (options.ActionPolicyVersion == 0 && ((options.DeniedActions?.Count ?? 0) > 0 || (options.DeniedActionFamilies?.Count ?? 0) > 0)) return false;
        if (options.ActionPolicyVersion == 1 && options.EnabledActions is not null) return false;

        HashSet<string> actionIds = new(FarmhandActionCatalog.Definitions.Select(definition => definition.ActionId), StringComparer.Ordinal);
        HashSet<string> familyIds = new(FarmhandActionCatalog.Definitions.Select(definition => definition.FamilyId), StringComparer.Ordinal);
        HashSet<string> experimentalActionIds = new(FarmhandActionCatalog.Definitions
            .Where(definition => definition.Lifecycle == FarmhandActionLifecycle.Experimental)
            .Select(definition => definition.ActionId), StringComparer.Ordinal);

        return (options.DeniedActions ?? Array.Empty<string>()).All(actionIds.Contains)
            && (options.DeniedActionFamilies ?? Array.Empty<string>()).All(familyIds.Contains)
            && (options.ExperimentalActions ?? Array.Empty<string>()).All(experimentalActionIds.Contains);
    }
}
