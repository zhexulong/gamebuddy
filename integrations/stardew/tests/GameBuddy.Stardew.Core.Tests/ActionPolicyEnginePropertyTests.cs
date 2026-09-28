using FsCheck;
using FsCheck.Xunit;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class ActionPolicyEnginePropertyTests
{
    private static readonly string[] PublishedActionIds = FarmhandActionCatalog.Registrations
        .Where(d => d.Lifecycle == FarmhandActionLifecycle.Published)
        .Select(d => d.ActionId)
        .ToArray();

    [Fact]
    public void DefaultConsentCoversPublishedAndLiveVerifiedButNotExperimental()
    {
        // live_verified means the action already ran on its required target topology and
        // produced a native receipt/postcondition; that is enough to be visible. Full
        // publication adds the independent reviewer pass, so both states are default-consent.
        Assert.True(ActionPolicyEngine.IsDefaultConsentLifecycle(FarmhandActionLifecycle.Published));
        Assert.True(ActionPolicyEngine.IsDefaultConsentLifecycle(FarmhandActionLifecycle.LiveVerified));
        Assert.False(ActionPolicyEngine.IsDefaultConsentLifecycle(FarmhandActionLifecycle.Experimental));
    }

    [Fact]
    public void LiveVerifiedLifecycleWireValueIsSnakeCase()
    {
        Assert.Equal("live_verified", FarmhandActionLifecycle.LiveVerified.ToWireValue());
    }

    [Fact]
    public void ExperimentalActionsCannotBeNamedInTheLiveVerifiedSet()
    {
        // A policy that lists an experimental action under ExperimentalActions must not
        // accidentally treat it as live-verified; and a live-verified action must be
        // enabled by default consent without being named explicitly.
        var liveVerified = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Lifecycle == FarmhandActionLifecycle.LiveVerified)
            .Select(registration => registration.ActionId)
            .ToArray();
        if (liveVerified.Length == 0) return;

        IReadOnlySet<string> enabled = ActionPolicyEngine.ComputeEnabledActions(new ActionPolicyOptions());
        Assert.All(liveVerified, actionId => Assert.Contains(actionId, enabled));
    }

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
