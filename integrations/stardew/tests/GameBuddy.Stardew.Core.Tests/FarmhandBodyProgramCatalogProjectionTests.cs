using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class FarmhandBodyProgramCatalogProjectionTests
{
    [Fact]
    public void CurrentModSurfaceFailsClosedWhenDescriptorRevisionIsNotNumeric()
    {
        FarmhandBodyProgramCatalogProjectionResult result = FarmhandBodyProgramCatalogProjection.Create();

        result.Status.Should().Be(FarmhandBodyProgramCatalogProjectionStatus.Blocked);
        result.Catalog.Should().BeNull();
        result.Rejections.Should().Contain(rejection =>
            rejection.ActionId == "<catalog>" && rejection.Code == "catalog_revision_blocked");
    }

    [Fact]
    public void ScalarExecutionRegistrationProjectsToNonEmptySubset()
    {
        FarmhandBodyProgramCatalogProjectionResult result = FarmhandBodyProgramCatalogProjection.Create(
            Artifact("42", new FarmhandActionDescriptorProjection(
                "scalar_action", 3, "execution",
                new Dictionary<string, FarmhandActionArgumentSchema>
                {
                    ["count"] = new("integer"),
                    ["enabled"] = new("boolean"),
                },
                 new Dictionary<string, string> { ["done"] = "string" },
                 new FarmhandActionResourceTemplate(Array.Empty<string>()), "write",
                new FarmhandActionPostcondition("ignored"))));

        result.IsPublished.Should().BeTrue();
        result.Catalog!.Revision.Should().Be(42);
        result.Catalog.TryGetAction("scalar_action", out BodyProgramActionDescriptor? action).Should().BeTrue();
        action!.Arguments.Should().Contain(new BodyProgramArgumentDescriptor("count", BodyProgramArgumentKind.Integer));
        action.Arguments.Should().Contain(new BodyProgramArgumentDescriptor("enabled", BodyProgramArgumentKind.Boolean));
         action.OutputFacts.Should().Contain(new BodyProgramFactDescriptor("done", BodyProgramArgumentKind.String));
         action.ResourceTemplate.Should().BeEmpty();
    }

    [Fact]
    public void ResourceTemplateKeysAreBlockedWithoutSymbolicTemplateSemantics()
    {
        FarmhandBodyProgramCatalogProjectionResult result = FarmhandBodyProgramCatalogProjection.Create(
            Artifact("42", new FarmhandActionDescriptorProjection(
                "resource_action", 3, "execution",
                new Dictionary<string, FarmhandActionArgumentSchema>(),
                new Dictionary<string, string>(),
                new FarmhandActionResourceTemplate(new[] { "embodied_actor" }), "write",
                new FarmhandActionPostcondition("ignored"))));

        result.Status.Should().Be(FarmhandBodyProgramCatalogProjectionStatus.Blocked);
        result.Catalog.Should().BeNull();
        result.Rejections.Should().Contain(rejection =>
            rejection.ActionId == "resource_action" && rejection.Code == "resource_mapping_blocked");
    }

    [Fact]
    public void CurrentModSurfaceRejectsNavigationObjectsWithoutStringifyingThem()
    {
        FarmhandBodyProgramCatalogProjectionResult result = FarmhandBodyProgramCatalogProjection.Create();

        result.Rejections.Should().Contain(rejection =>
            rejection.ActionId == "navigate_to_destination"
            && rejection.Code == "object_or_unsupported_argument");
    }

    [Fact]
    public void CurrentModSurfaceRejectsReadOnlyRegistrationsAsExecution()
    {
        FarmhandBodyProgramCatalogProjectionResult result = FarmhandBodyProgramCatalogProjection.Create();

        result.Rejections.Should().Contain(rejection =>
            rejection.ActionId == "inspect_world_map"
            && rejection.Code == "read_only_not_execution");
    }

    private static FarmhandActionDescriptorArtifact Artifact(string revision, params FarmhandActionDescriptorProjection[] actions) =>
        new(FarmhandActionSurfaceExport.Schema, revision, actions);
}
