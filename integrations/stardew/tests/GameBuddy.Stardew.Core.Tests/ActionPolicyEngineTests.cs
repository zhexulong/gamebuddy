using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class ActionPolicyEngineTests
{
    [Fact]
    public void ComputeEnabledActions_DefaultPolicy_ReturnsAllPublishedActions()
    {
        var options = new ActionPolicyOptions();
        var enabled = ActionPolicyEngine.ComputeEnabledActions(options);

        // Published actions should be present; experimental actions should NOT be present by default.
        enabled.Should().Contain("till_soil");
        enabled.Should().Contain("water_crop");
        enabled.Should().Contain("plant_seed");
        enabled.Should().NotContain("sop_composite_pipeline"); // Retired generic composition runtime
        // live_verified actions are default-consent (design/10 3.1.1: the live run
        // on the required topology IS the visibility gate). Every action in the
        // catalog has now reached at least live_verified, so the whole catalog is
        // present by default and no action is withheld here.
        enabled.Should().Contain("pet_animal");
        enabled.Should().Contain("clear_debris");
        enabled.Should().Contain("advance_day");
        foreach (var registration in FarmhandActionCatalog.Registrations)
            enabled.Should().Contain(registration.ActionId);
    }

    [Fact]
    public void ComputeEnabledActions_DefaultPolicy_DoesNotPublishRetiredSopPipeline()
    {
        var enabled = ActionPolicyEngine.ComputeEnabledActions(new ActionPolicyOptions());

        enabled.Should().NotContain("sop_composite_pipeline");
        FarmhandActionCatalog.Registrations.Select(registration => registration.ActionId).Should().NotContain("sop_composite_pipeline");
    }

    [Fact]
    public void ComputeEnabledActions_WithDeniedActions_ExcludesExplicitActions()
    {
        var options = new ActionPolicyOptions(
            DeniedActions: new[] { "till_soil", "plant_seed" }
        );
        var enabled = ActionPolicyEngine.ComputeEnabledActions(options);

        enabled.Should().NotContain("till_soil");
        enabled.Should().NotContain("plant_seed");
        enabled.Should().Contain("water_crop");
    }

    [Fact]
    public void ComputeEnabledActions_WithDeniedFamily_ExcludesAllActionsInFamily()
    {
        var options = new ActionPolicyOptions(
            DeniedActionFamilies: new[] { "farming_crops" }
        );
        var enabled = ActionPolicyEngine.ComputeEnabledActions(options);

        enabled.Should().NotContain("till_soil");
        enabled.Should().NotContain("water_crop");
        enabled.Should().NotContain("plant_seed");
        enabled.Should().NotContain("fertilize_tile");
        enabled.Should().NotContain("harvest_crop");
        enabled.Should().Contain("move_to_tile"); // Different family
    }

    [Fact]
    public void ComputeEnabledActions_WithExperimentalActions_IncludesOptedInExperimentalActions()
    {
        // Opting a name in is only meaningful for an action that is NOT already
        // default-consent, so this exercises the opt-in path against a name the
        // catalog withholds rather than against a live_verified action (which the
        // default policy already enables).
        var options = new ActionPolicyOptions(
            ExperimentalActions: new[] { "clear_debris", "non_existent_action" }
        );
        var enabled = ActionPolicyEngine.ComputeEnabledActions(options);

        enabled.Should().Contain("clear_debris");
        // An unknown name is inert: opting in cannot invent a capability.
        enabled.Should().NotContain("non_existent_action");
        enabled.Should().NotContain("sop_composite_pipeline");
    }

    [Fact]
    public void ComputeEnabledActions_LiveVerifiedActions_AreEnabledWithoutOptIn()
    {
        var enabled = ActionPolicyEngine.ComputeEnabledActions(new ActionPolicyOptions());

        // The live_verified rung is player-visible without an explicit opt-in; only
        // experimental actions would need one, and the catalog currently has none.
        foreach (var registration in FarmhandActionCatalog.Registrations)
        {
            registration.Lifecycle.Should().NotBe(FarmhandActionLifecycle.Experimental);
            enabled.Should().Contain(registration.ActionId);
        }
    }

    [Fact]
    public void ValidateActionPolicy_ValidOptions_ReturnsTrue()
    {
        var options = new ActionPolicyOptions(
            DeniedActions: new[] { "till_soil" },
            DeniedActionFamilies: new[] { "farming_crops" }
        );
        ActionPolicyEngine.ValidateActionPolicy(options).Should().BeTrue();
    }

    [Fact]
    public void ValidateActionPolicy_ExperimentalOptInMustNameAnExperimentalAction()
    {
        // The opt-in list is a closed set of actions that are actually on the
        // experimental rung. Naming anything else -- including a live_verified
        // action that is already default-consent -- must fail closed, otherwise a
        // typo would silently look accepted.
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.Lifecycle != FarmhandActionLifecycle.Experimental)
            .Should().NotBeEmpty();
        foreach (var registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Lifecycle == FarmhandActionLifecycle.Experimental) continue;
            bool valid = ActionPolicyEngine.ValidateActionPolicy(
                new ActionPolicyOptions(ExperimentalActions: new[] { registration.ActionId }));
            valid.Should().BeFalse(
                $"opting in {registration.ActionId} must fail: it is not on the experimental rung");
        }

        var validExperimental = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Lifecycle == FarmhandActionLifecycle.Experimental)
            .Select(registration => registration.ActionId)
            .ToArray();
        foreach (string actionId in validExperimental)
            ActionPolicyEngine.ValidateActionPolicy(
                new ActionPolicyOptions(ExperimentalActions: new[] { actionId })).Should().BeTrue();
    }

    [Fact]
    public void ValidateActionPolicy_ValidPolicyHonoursTheDomain_ReturnsTrue()
    {
        foreach (var registration in FarmhandActionCatalog.Registrations)
        {
            bool valid = ActionPolicyEngine.ValidateActionPolicy(
                new ActionPolicyOptions(DeniedActions: new[] { registration.ActionId }));
            valid.Should().BeTrue($"denying {registration.ActionId} must be a legal policy");
        }
    }

    [Fact]
    public void ValidateActionPolicy_InvalidActionId_ReturnsFalse()
    {
        var options = new ActionPolicyOptions(
            DeniedActions: new[] { "non_existent_action" }
        );
        ActionPolicyEngine.ValidateActionPolicy(options).Should().BeFalse();
    }
}
