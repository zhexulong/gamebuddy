using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The plan form as a Mod-owned declaration: admitted by the Body Program catalog, absent from the action catalog, and the
/// only id that can reach the plan-form branch.
///
/// <para>
/// WHY THE ABSENCE IS A TEST. A form registered as an ACTION would be composed into the router (ModEntry registers every
/// execution registration with a handler) and would gain a flat request path beside the program one - the second
/// execution route this design exists to avoid. So "not in <see cref="FarmhandActionCatalog.Registrations"/>" is a
/// property, not an incidental fact.
/// </para>
/// </summary>
public sealed class FarmhandPlanFormCatalogTests
{
    [Fact]
    public void TheFormIsAdmittedByTheBodyProgramCatalogWithoutBecomingAnAction()
    {
        FarmhandBodyProgramCatalogProjectionResult projection = FarmhandBodyProgramCatalogProjection.Create();

        projection.IsPublished.Should().BeTrue();
        projection.Catalog!.TryGetAction(FarmhandPlanFormCatalog.ForEachActionId, out BodyProgramActionDescriptor? form).Should().BeTrue(
            "a plan-form node is admitted, verified and journaled exactly like an action node, so it must be a catalog member");
        form!.Arguments.Should().Equal(
            new[] { new BodyProgramArgumentDescriptor(FarmhandForEachArguments.LoopArgument, BodyProgramArgumentKind.String) },
            "the loop is one declared argument, and its canonical value is the document as a string");
        form.ResourceTemplate.Should().ContainSingle().Which.Should().Be(
            new BodyProgramResourceTemplateClaim("embodied_actor", BodyProgramResourceTemplateValue.ScopePlayer),
            "a pass holds the embodied actor for as long as it runs, exactly as one action does");
        form.WatchdogMs.Should().Be(FarmhandPlanFormCatalog.WatchdogMs);
        form.OutputFacts.Should().BeEmpty("a pass declares no fact a later node could bind to");

        FarmhandActionCatalog.Registrations.Should().NotContain(
            registration => registration.ActionId == FarmhandPlanFormCatalog.ForEachActionId,
            "a form is not an action: registering it would compose a router handler and a second execution path");
        FarmhandActionSurfacePublication.Actions.Should().NotContain(
            action => action.ActionId == FarmhandPlanFormCatalog.ForEachActionId,
            "the action surface artifact is what the Host builds tools from, and a form is not a tool");
    }

    /// <summary>
    /// The form's wire shape is one of the four canonical kinds, which is why it can cross the frozen contract at all.
    /// </summary>
    [Fact]
    public void TheFormsDescriptorProjectsThroughTheSameProjectionAnActionUses()
    {
        FarmhandActionDescriptorProjection projection =
            FarmhandActionSurfacePublication.ProjectAction(FarmhandPlanFormCatalog.Registrations.Single());

        projection.ActionId.Should().Be(FarmhandPlanFormCatalog.ForEachActionId);
        projection.Kind.Should().Be("execution");
        projection.Lifecycle.Should().Be("published");
        projection.ArgumentSchema.Should().ContainKey(FarmhandForEachArguments.LoopArgument);
        projection.ArgumentSchema[FarmhandForEachArguments.LoopArgument].Type.Should().Be("string");
    }

    [Fact]
    public void OnlyTheFormsOwnIdIsAPlanForm()
    {
        FarmhandPlanFormCatalog.IsPlanForm(FarmhandPlanFormCatalog.ForEachActionId).Should().BeTrue();
        FarmhandPlanFormCatalog.IsPlanForm("till_soil").Should().BeFalse("an ordinary action must never take the form's path");
        FarmhandPlanFormCatalog.IsPlanForm(null).Should().BeFalse();
        FarmhandPlanFormCatalog.IsPlanForm("for_each_").Should().BeFalse();
    }

    /// <summary>
    /// `by_kind` resolves to actions that EXIST. A renamed or removed action fails here instead of becoming a per-row
    /// `row_action_unavailable` in the field.
    /// </summary>
    [Fact]
    public void EveryKindTheClassifierNamesAnswersAPublishedOrLiveVerifiedAction()
    {
        string[] kinds = { "weed", "grass", "crop", "stump" };

        foreach (string kind in kinds)
        {
            string? actionId = FarmhandForEachKindActions.ActionFor(kind);
            actionId.Should().NotBeNull($"{kind} is a kind this farm publishes, so a row of it must name an action");
            FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
                .Single(entry => entry.ActionId == actionId);
            registration.Kind.Should().Be(FarmhandOperationKind.Execution, $"{actionId} must be dispatchable");
            registration.Lifecycle.Should().BeOneOf(
                new[] { FarmhandActionLifecycle.Published, FarmhandActionLifecycle.LiveVerified },
                "a program node may only name a published or live-verified action");
        }

        // `empty_tillable` is the kind whose action declares `charge`, which a `by_kind` step has nowhere to put: it is
        // answered by the row's own `no_action_for_kind` rather than by a mapping that always refuses.
        FarmhandForEachKindActions.ActionFor(FarmhandForEachKindActions.EmptyTillableKind).Should().BeNull(
            "till_soil declares an argument only the caller can supply, so a `by_kind` row cannot dispatch it");
    }

    /// <summary>
    /// A kind with no action is a NAMED answer, not a guess at the nearest tool: a boulder has no published action that
    /// removes it, so the row says so.
    /// </summary>
    [Fact]
    public void AKindNoActionClearsAnswersNothingRatherThanTheNearestTool()
    {
        FarmhandForEachKindActions.ActionFor("rock").Should().BeNull();
        FarmhandForEachKindActions.ActionFor("ground").Should().BeNull();
        FarmhandForEachKindActions.ActionFor(FarmhandForEachKindActions.ObjectKind).Should().BeNull();
        FarmhandForEachKindActions.ActionFor(FarmhandForEachKindActions.SoilKind).Should().BeNull();
        FarmhandForEachKindActions.ActionFor("unknown").Should().BeNull();
    }
}
