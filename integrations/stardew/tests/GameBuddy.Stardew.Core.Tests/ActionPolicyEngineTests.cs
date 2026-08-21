using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class ActionPolicyEngineTests
{
    [Fact]
    public void ComputeEnabledActions_DefaultPolicy_ReturnsAllPublishedActions()
    {
        var options = new ActionPolicyOptions(ActionPolicyVersion: 1);
        var enabled = ActionPolicyEngine.ComputeEnabledActions(options);

        // Published actions should be present, experimental actions should NOT be present by default
        enabled.Should().Contain("till_soil");
        enabled.Should().Contain("water_crop");
        enabled.Should().Contain("plant_seed");
        enabled.Should().NotContain("clear_debris"); // Experimental
        enabled.Should().NotContain("pet_animal");   // Experimental
    }

    [Fact]
    public void ComputeEnabledActions_WithDeniedActions_ExcludesExplicitActions()
    {
        var options = new ActionPolicyOptions(
            ActionPolicyVersion: 1,
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
            ActionPolicyVersion: 1,
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
            ActionPolicyVersion: 1,
            ExperimentalActions: new[] { "pet_animal" }
        );
        var enabled = ActionPolicyEngine.ComputeEnabledActions(options);

        enabled.Should().Contain("pet_animal");
        enabled.Should().NotContain("clear_debris"); // Not opted in
    }

    [Fact]
    public void ValidateActionPolicy_ValidOptions_ReturnsTrue()
    {
        var options = new ActionPolicyOptions(
            ActionPolicyVersion: 1,
            DeniedActions: new[] { "till_soil" },
            DeniedActionFamilies: new[] { "farming_crops" },
            ExperimentalActions: new[] { "pet_animal" }
        );
        ActionPolicyEngine.ValidateActionPolicy(options).Should().BeTrue();
    }

    [Fact]
    public void ValidateActionPolicy_InvalidActionId_ReturnsFalse()
    {
        var options = new ActionPolicyOptions(
            ActionPolicyVersion: 1,
            DeniedActions: new[] { "non_existent_action" }
        );
        ActionPolicyEngine.ValidateActionPolicy(options).Should().BeFalse();
    }
}
