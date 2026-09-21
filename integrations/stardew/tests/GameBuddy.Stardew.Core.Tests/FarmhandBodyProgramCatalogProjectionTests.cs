using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class FarmhandBodyProgramCatalogProjectionTests
{
    [Fact]
    public void CurrentModCatalogPublishesScalarExecutionSubsetAtIndependentRevision()
    {
        FarmhandBodyProgramCatalogProjectionResult result = FarmhandBodyProgramCatalogProjection.Create();

        result.IsPublished.Should().BeTrue();
        result.Catalog!.Revision.Should().Be(FarmhandActionSurfacePublication.CatalogRevision);
        result.Catalog.TryGetAction("move_to_tile", out BodyProgramActionDescriptor? action).Should().BeTrue();
        action!.ResourceTemplate.Should().ContainSingle().Which.Should().Be(new BodyProgramResourceTemplateClaim("embodied_actor", BodyProgramResourceTemplateValue.ScopePlayer));
        action.Metadata.Should().Be(new BodyProgramActionMetadata("published", "execution", "write", "native_action_postcondition"));
    }

    [Fact]
    public void ResourceTemplateScopePlayerIsProjectedFromModOwnedRegistration()
    {
        FarmhandBodyProgramCatalogProjectionResult result = FarmhandBodyProgramCatalogProjection.Create(
            Artifact(42, new FarmhandActionDescriptorProjection(
                "resource_action", 3, "published", "execution",
                new Dictionary<string, FarmhandActionArgumentSchema>(),
                new Dictionary<string, string>(),
                new FarmhandActionResourceTemplate(new[] { new FarmhandActionResourceTemplateValueProjection("embodied_actor", "ScopePlayer") }), "write",
                new FarmhandActionPostcondition("native_action_postcondition"))));

        result.IsPublished.Should().BeTrue();
        result.Catalog!.Revision.Should().Be(42);
        result.Catalog.TryGetAction("resource_action", out BodyProgramActionDescriptor? action).Should().BeTrue();
        action!.ResourceTemplate.Should().ContainSingle().Which.Should().Be(new BodyProgramResourceTemplateClaim("embodied_actor", BodyProgramResourceTemplateValue.ScopePlayer));
    }

    [Fact]
    public void NavigateProjectsTypedDestinationContractIntoExecutionCatalog()
    {
        FarmhandBodyProgramCatalogProjectionResult result = FarmhandBodyProgramCatalogProjection.Create();

        result.IsPublished.Should().BeTrue();
        result.Rejections.Should().NotContain(rejection =>
            rejection.ActionId == "navigate_to_destination");
        result.Catalog!.TryGetAction("navigate_to_destination", out BodyProgramActionDescriptor? navigate).Should().BeTrue();
        navigate!.Arguments.Should().Contain(new BodyProgramArgumentDescriptor("destination", BodyProgramArgumentKind.DestinationSelector));
        navigate.OutputFacts.Should().Contain(new BodyProgramFactDescriptor("arrival", BodyProgramArgumentKind.DestinationArrival));
        navigate.Metadata.Should().Be(new BodyProgramActionMetadata("published", "execution", "write", "arrived_at_destination"));
        // Watchdog authority: navigate carries an action-specific 10-minute budget
        // matching its ordinary deadline ceiling; ordinary short actions keep the
        // descriptor default of 60s.
        navigate.WatchdogMs.Should().Be(FarmhandActionCatalog.NavigationWatchdogMs);
        result.Catalog.TryGetAction("machine_load", out BodyProgramActionDescriptor? load).Should().BeTrue();
        load!.WatchdogMs.Should().Be(FarmhandActionCatalog.DefaultWatchdogMs);
    }

    [Fact]
    public void SurfaceArtifactOmitsWatchdogMsToPreserveExactKeyContract()
    {
        string json = FarmhandActionSurfaceExport.SerializeToJson();

        json.Should().NotContain("watchdogMs");
        FarmhandActionSurfacePublication.Actions
            .Should().OnlyContain(action => action.WatchdogMs > 0);
        FarmhandActionSurfacePublication.Actions
            .Single(action => action.ActionId == "navigate_to_destination")
            .WatchdogMs.Should().Be(FarmhandActionCatalog.NavigationWatchdogMs);
    }

    [Fact]
    public void ReadOnlyAndExperimentalRegistrationsRemainOutsideExecutionCatalog()
    {
        FarmhandBodyProgramCatalogProjectionResult result = FarmhandBodyProgramCatalogProjection.Create();

        result.Rejections.Should().Contain(rejection => rejection.ActionId == "inspect_world_map" && rejection.Code == "read_only_not_execution");
        result.Rejections.Should().Contain(rejection => rejection.ActionId == "clear_debris" && rejection.Code == "lifecycle_not_published");
    }

    [Theory]
    [InlineData(-1, false)]
    [InlineData(0, true)]
    [InlineData(42, true)]
    public void CatalogRevisionMustBeNonNegative(long revision, bool accepted)
    {
        FarmhandBodyProgramCatalogProjectionResult result = FarmhandBodyProgramCatalogProjection.Create(
            Artifact(revision, new FarmhandActionDescriptorProjection(
                "scalar_action", 3, "published", "execution",
                new Dictionary<string, FarmhandActionArgumentSchema>(),
                new Dictionary<string, string>(),
                new FarmhandActionResourceTemplate(Array.Empty<FarmhandActionResourceTemplateValueProjection>()), "write",
                new FarmhandActionPostcondition("ignored"))));

        result.IsPublished.Should().Be(accepted);
        if (!accepted)
            result.Rejections.Should().Contain(rejection => rejection.ActionId == "<catalog>" && rejection.Code == "catalog_revision_blocked");
    }

    [Fact]
    public void AlternateArtifactSchemaIsBlocked()
    {
        FarmhandBodyProgramCatalogProjectionResult result = FarmhandBodyProgramCatalogProjection.Create(
            new FarmhandActionDescriptorArtifact(
                "alternate-schema/v1",
                42,
                Array.Empty<FarmhandActionDescriptorProjection>()));

        result.Status.Should().Be(FarmhandBodyProgramCatalogProjectionStatus.Blocked);
        result.Catalog.Should().BeNull();
        result.Rejections.Should().ContainSingle(rejection =>
            rejection.ActionId == "<catalog>" && rejection.Code == "catalog_schema_blocked");
    }

    [Fact]
    public void CurrentModSurfaceRejectsReadOnlyRegistrationsAsExecution()
    {
        FarmhandBodyProgramCatalogProjectionResult result = FarmhandBodyProgramCatalogProjection.Create();

        result.Rejections.Should().Contain(rejection =>
            rejection.ActionId == "inspect_world_map"
            && rejection.Code == "read_only_not_execution");
    }

    [Fact]
    public void FrozenMachineInspectProjectsMachineTargetIdStringOutputFactAsReadAction()
    {
        FarmhandBodyProgramCatalogProjectionResult result = FarmhandBodyProgramCatalogProjection.Create();

        result.IsPublished.Should().BeTrue();
        result.Catalog!.TryGetAction("machine_inspect", out BodyProgramActionDescriptor? inspect).Should().BeTrue();
        inspect!.OutputFacts.Should().ContainSingle().Which.Should().Be(new BodyProgramFactDescriptor("machine_target_id", BodyProgramArgumentKind.String));
        inspect.Arguments.Should().Contain(new BodyProgramArgumentDescriptor("expectedTargetId", BodyProgramArgumentKind.String));
        inspect.Metadata.Should().Be(new BodyProgramActionMetadata("published", "execution", "read", "native_action_postcondition"));
    }

    [Fact]
    public void FrozenMachineLoadProjectsBindableExpectedTargetIdStringArgument()
    {
        FarmhandBodyProgramCatalogProjectionResult result = FarmhandBodyProgramCatalogProjection.Create();

        result.Catalog!.TryGetAction("machine_load", out BodyProgramActionDescriptor? load).Should().BeTrue();
        load!.Arguments.Should().Contain(new BodyProgramArgumentDescriptor("expectedTargetId", BodyProgramArgumentKind.String));
        load.OutputFacts.Should().BeEmpty();
    }

    private static FarmhandActionDescriptorArtifact Artifact(long revision, params FarmhandActionDescriptorProjection[] actions) =>
        new(FarmhandActionSurfaceExport.Schema, revision, actions);
}
