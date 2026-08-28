using FsCheck;
using FsCheck.Xunit;
using GameBuddy.Stardew.Core.Policy;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class ActionPolicyEnginePropertyTests
{
    private static readonly string[] PublishedActionIds = FarmhandActionCatalog.Registrations
        .Where(d => d.Lifecycle == FarmhandActionLifecycle.Published)
        .Select(d => d.ActionId)
        .ToArray();

    [Property(MaxTest = 100)]
    public Property EnabledActions_AreAlwaysSubsetOfTheSingleFarmhandCatalog(
        PositiveInt actionIndex,
        PositiveInt familyIndex,
        bool denyAction,
        bool denyFamily,
        bool useExperimentalPolicy)
    {
        if (FarmhandActionCatalog.Registrations.Count == 0) return true.ToProperty();

        string action = FarmhandActionCatalog.Registrations[actionIndex.Get % FarmhandActionCatalog.Registrations.Count].ActionId;
        string family = FarmhandActionCatalog.Registrations[familyIndex.Get % FarmhandActionCatalog.Registrations.Count].FamilyId;
        var options = new ActionPolicyOptions(
            useExperimentalPolicy ? 1 : 0,
            denyAction ? new[] { action } : Array.Empty<string>(),
            denyFamily ? new[] { family } : Array.Empty<string>()
        );

        IReadOnlySet<string> enabled = ActionPolicyEngine.ComputeEnabledActions(options);
        IReadOnlySet<string> registered = FarmhandActionCatalog.Registrations
            .Select(registration => registration.ActionId)
            .ToHashSet(StringComparer.Ordinal);
        return enabled.All(registered.Contains).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property DeniedAction_NeverAppearsInEnabledSet(PositiveInt indexGenerator)
    {
        if (PublishedActionIds.Length == 0) return true.ToProperty();

        string denied = PublishedActionIds[indexGenerator.Get % PublishedActionIds.Length];
        var options = new ActionPolicyOptions(
            ActionPolicyVersion: 1,
            DeniedActions: new[] { denied }
        );

        var enabled = ActionPolicyEngine.ComputeEnabledActions(options);
        return (!enabled.Contains(denied)).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property DeniedFamily_ExcludesAllFamilyMembers(PositiveInt indexGenerator)
    {
        var families = FarmhandActionCatalog.Registrations.Select(d => d.FamilyId).Distinct().ToArray();
        string deniedFamily = families[indexGenerator.Get % families.Length];

        var options = new ActionPolicyOptions(
            ActionPolicyVersion: 1,
            DeniedActionFamilies: new[] { deniedFamily }
        );

        var enabled = ActionPolicyEngine.ComputeEnabledActions(options);
        var expectedExcluded = FarmhandActionCatalog.Registrations
            .Where(d => d.FamilyId == deniedFamily)
            .Select(d => d.ActionId);

        return expectedExcluded.All(action => !enabled.Contains(action)).ToProperty();
    }
}
