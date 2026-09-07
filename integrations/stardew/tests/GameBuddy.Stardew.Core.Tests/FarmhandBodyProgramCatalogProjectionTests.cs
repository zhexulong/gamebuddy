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
    public void NavigateRemainsWithdrawnWhenItsTypedObjectContractIsUnavailable()
    {
        FarmhandBodyProgramCatalogProjectionResult result = FarmhandBodyProgramCatalogProjection.Create();

        result.Rejections.Should().Contain(rejection =>
            rejection.ActionId == "navigate_to_destination"
            && rejection.Code == "object_or_unsupported_argument");
        result.Catalog!.TryGetAction("navigate_to_destination", out _).Should().BeFalse();
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

    private static FarmhandActionDescriptorArtifact Artifact(long revision, params FarmhandActionDescriptorProjection[] actions) =>
        new(FarmhandActionSurfaceExport.Schema, revision, actions);
}
