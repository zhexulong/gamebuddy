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
        // default-consent, so the names to opt in are read from the live partition rather than
        // hard-coded. Hard-coding is what broke this test when the partition emptied: it named
        // dismiss_modal, which has since been promoted.
        string[] experimentalIds = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Lifecycle == FarmhandActionLifecycle.Experimental)
            .Select(registration => registration.ActionId)
            .ToArray();
        string[] defaultEnabledIds = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Lifecycle != FarmhandActionLifecycle.Experimental)
            .Select(registration => registration.ActionId)
            .ToArray();

        var options = new ActionPolicyOptions(
            ExperimentalActions: experimentalIds.Concat(new[] { "ride_minecart", "non_existent_action" }).ToArray()
        );
        var enabled = ActionPolicyEngine.ComputeEnabledActions(options);
        var withoutOptIn = ActionPolicyEngine.ComputeEnabledActions(new ActionPolicyOptions());

        // THE OPT-IN RULE, asserted against the partition rather than against names: an opted-in
        // experimental action is enabled, and is NOT enabled without the opt-in. When the
        // partition is empty — as it is today — this loop has no data and is vacuous; it is
        // written this way so an action returning to the experimental rung starts exercising the
        // rule again on its own, instead of the rule being lost with its data.
        foreach (string id in experimentalIds)
        {
            enabled.Should().Contain(id);
            withoutOptIn.Should().NotContain(id);
        }

        // The half that IS non-vacuous today: opting in cannot widen the default surface. A
        // promoted name is already default-consent, so naming it changes nothing; an unknown
        // name is inert; a retired one stays retired.
        enabled.Should().Contain("ride_minecart");
        withoutOptIn.Should().Contain("ride_minecart");
        enabled.Should().NotContain("non_existent_action");
        enabled.Should().NotContain("sop_composite_pipeline");
        // The invariant is NOT that the two sets are equal — that was only true while the
        // experimental rung happened to be empty. The invariant is that naming an id in the opt-in
        // list grants nothing the partition does not already grant: every id it enables is an
        // Experimental registration that the list can only ever be naming because it is experimental.
        enabled.Should().BeEquivalentTo(
            withoutOptIn.Concat(FarmhandActionCatalog.Registrations
                .Where(registration => registration.Lifecycle == FarmhandActionLifecycle.Experimental)
                .Select(registration => registration.ActionId))
                .Distinct(),
            "the opt-in list may only add actions that are already on the experimental rung");

        // The promotion recorded as a pin rather than as prose. Both were promoted because WIA's
        // interrupt -> breakpoint -> continuation design DEADLOCKS an Agent that cannot answer or
        // dismiss a modal, so a silent regression back to the experimental rung would take the
        // companion's self-healing away. RUNBOOK 32 (dismiss chain) and 33 (answer question).
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.ActionId is "dismiss_modal" or "answer_dialogue")
            .Should().HaveCount(2)
            .And.OnlyContain(registration => registration.Lifecycle != FarmhandActionLifecycle.Experimental);

        // Every non-experimental action is on the default surface: the partition is asserted
        // rather than assumed, so no action can go silently invisible.
        foreach (string id in defaultEnabledIds)
        {
            withoutOptIn.Should().Contain(id);
        }
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
