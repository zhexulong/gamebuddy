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
        // on the required topology IS the visibility gate).
        enabled.Should().Contain("pet_animal");
        enabled.Should().Contain("clear_debris");
        enabled.Should().Contain("advance_day");
        // ride_minecart was promoted to live_verified with its native-local live
        // gate, so it is default-consent too.
        enabled.Should().Contain("ride_minecart");
        // The default surface is every published/live_verified action and nothing
        // else: experimental registrations need their own explicit opt-in.
        foreach (var registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Lifecycle == FarmhandActionLifecycle.Experimental)
                enabled.Should().NotContain(registration.ActionId);
            else
                enabled.Should().Contain(registration.ActionId);
        }
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
        // default-consent. cut_grass is the one experimental subject again (it
        // awaits its live gate); every other registration is published or
        // live_verified.
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.Lifecycle == FarmhandActionLifecycle.Experimental)
            .Select(registration => registration.ActionId)
            .Should().Equal("cut_grass");
        var options = new ActionPolicyOptions(
            ExperimentalActions: new[] { "cut_grass", "ride_minecart", "non_existent_action" }
        );
        var enabled = ActionPolicyEngine.ComputeEnabledActions(options);

        // An opted-in experimental action is enabled.
        enabled.Should().Contain("cut_grass");
        // A former experimental action that is now live_verified is already
        // default-consent; naming it changes nothing.
        enabled.Should().Contain("ride_minecart");
        // An unknown name is inert: opting in cannot invent a capability.
        enabled.Should().NotContain("non_existent_action");
        enabled.Should().NotContain("sop_composite_pipeline");
    }

    [Fact]
    public void ComputeEnabledActions_LiveVerifiedActions_AreEnabledWithoutOptIn()
    {
        var enabled = ActionPolicyEngine.ComputeEnabledActions(new ActionPolicyOptions());

        // The live_verified rung is player-visible without an explicit opt-in; an
        // experimental action needs one. Every registration is currently
        // published or live_verified, so the partition is asserted rather than
        // assumed: no action may be silently invisible.
        foreach (var registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Lifecycle == FarmhandActionLifecycle.Experimental)
                enabled.Should().NotContain(registration.ActionId);
            else
                enabled.Should().Contain(registration.ActionId);
        }

        // ride_minecart is now live_verified: its native-local live gate passed
        // (RUNBOOK: station Farm (2,9), network Default, destination Town), so it
        // is enabled without any opt-in.
        enabled.Should().Contain("ride_minecart");
        ActionPolicyEngine.ValidateActionPolicy(new ActionPolicyOptions())
            .Should().BeTrue();
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
        // typo would silently look accepted. There are no experimental
        // registrations right now (ride_minecart cleared its live gate), but the
        // contract is tested against whatever the catalog holds.
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
