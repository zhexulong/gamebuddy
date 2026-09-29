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

        // Published actions should be present, experimental actions should NOT be present by default
        enabled.Should().Contain("till_soil");
        enabled.Should().Contain("water_crop");
        enabled.Should().Contain("plant_seed");
        enabled.Should().NotContain("sop_composite_pipeline"); // Retired generic composition runtime
        enabled.Should().NotContain("clear_debris"); // Experimental
        // pet_animal is live_verified on the shared-world topology (design/10 3.1.1:
        // live run on required topology IS the visibility gate), so it is default-consent.
        enabled.Should().Contain("pet_animal");
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
        var options = new ActionPolicyOptions(
            ExperimentalActions: new[] { "clear_debris" }
        );
        var enabled = ActionPolicyEngine.ComputeEnabledActions(options);

        enabled.Should().Contain("clear_debris");
        enabled.Should().NotContain("cut_weeds"); // Not opted in
    }

    [Fact]
    public void ValidateActionPolicy_ValidOptions_ReturnsTrue()
    {
        var options = new ActionPolicyOptions(
            DeniedActions: new[] { "till_soil" },
            DeniedActionFamilies: new[] { "farming_crops" },
            ExperimentalActions: new[] { "clear_debris" }
        );
        ActionPolicyEngine.ValidateActionPolicy(options).Should().BeTrue();
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
