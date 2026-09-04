using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class FarmhandActionSurfaceExportTests
{
    [Fact]
    public void Publication_BindsExactlyToCatalogDescriptorProjection()
    {
        FarmhandActionDescriptorArtifact artifact = FarmhandActionSurfaceExport.CreateArtifact();

        artifact.Schema.Should().Be("gamebuddy-action-descriptors/v1");
        artifact.CatalogRevision.Should().Be(FarmhandActionSurfacePublication.CatalogRevision);
        artifact.Actions.Should().HaveSameCount(FarmhandActionCatalog.Registrations);
        artifact.Actions.Select(action => action.ActionId)
            .Should().Equal(FarmhandActionCatalog.Registrations.Select(registration => registration.ActionId));

        for (int index = 0; index < artifact.Actions.Count; index++)
        {
            FarmhandActionRegistration source = FarmhandActionCatalog.Registrations[index];
            FarmhandActionDescriptorProjection projection = artifact.Actions[index];
            FarmhandActionDescriptor descriptor = source.Descriptor
                ?? throw new InvalidOperationException("Catalog registration needs a descriptor.");

            projection.ActionId.Should().Be(source.ActionId);
            projection.IdentityVersion.Should().Be(source.IdentityVersion);
            projection.Lifecycle.Should().Be(source.Lifecycle.ToWireValue());
            projection.Kind.Should().Be(source.Kind.ToWireValue());
            projection.ArgumentSchema.Should().Equal(descriptor.Arguments.ToDictionary(
                argument => argument.Name,
                argument => new FarmhandActionArgumentSchema(argument.Type)));
            projection.OutputFacts.Should().Equal(descriptor.OutputFacts);
            projection.ResourceTemplate.Claims.Should().Equal(descriptor.ResourceTemplate.Select(claim =>
                new FarmhandActionResourceTemplateValueProjection(claim.Key, claim.Value.ToString())));
            projection.Effect.Should().Be(descriptor.Effect);
            projection.Postcondition.Name.Should().Be(descriptor.Postcondition);
        }
    }

    [Fact]
    public void PublicationDeclaresEmbodiedActorScopePlayerInModOwnedRegistration()
    {
        FarmhandActionRegistration move = FarmhandActionCatalog.Registrations.Single(registration => registration.ActionId == "move_to_tile");

        move.Descriptor!.ResourceTemplate.Should().ContainSingle().Which.Should().Be(new FarmhandActionResourceTemplateClaim("embodied_actor", FarmhandResourceTemplateValue.ScopePlayer));
    }

    [Fact]
    public void SerializeToJson_IsCanonicalAndDeterministic()
    {
        string first = FarmhandActionSurfaceExport.SerializeToJson();
        string second = FarmhandActionSurfaceExport.SerializeToJson();

        first.Should().Be(second);
        first.Should().NotContain("\n");
        first.Should().NotContain("\r");
        first.Should().NotContain(" ");
        first.Should().NotContain("\t");
        first.Should().Contain("{\"schema\":\"gamebuddy-action-descriptors/v1\"");
        first.Should().Contain("\"catalogRevision\":1");
        first.Should().Contain("\"actionId\":\"move_to_tile\"");
        first.Should().Contain("\"actionId\":\"pet_animal\"");
        first.Should().Contain("\"lifecycle\":\"experimental\"");
        first.Should().Contain("\"kind\":\"read_only\"");
    }

    [Fact]
    public void SerializeToJson_ContainsExactDescriptorValidatorShape()
    {
        using JsonDocument document = JsonDocument.Parse(FarmhandActionSurfaceExport.SerializeToJson());
        JsonElement root = document.RootElement;

        root.EnumerateObject().Select(property => property.Name)
            .Should().Equal("schema", "catalogRevision", "actions");
        root.GetProperty("actions").GetArrayLength().Should().Be(FarmhandActionCatalog.Registrations.Count);

        foreach (JsonElement action in root.GetProperty("actions").EnumerateArray())
        {
            action.EnumerateObject().Select(property => property.Name)
                .Should().Equal("actionId", "identityVersion", "lifecycle", "kind", "argumentSchema", "outputFacts", "resourceTemplate", "effect", "postcondition");
            action.GetProperty("resourceTemplate").EnumerateObject().Select(property => property.Name)
                .Should().Equal("claims");
            action.GetProperty("postcondition").EnumerateObject().Select(property => property.Name)
                .Should().Equal("name");
            action.TryGetProperty("familyId", out _).Should().BeFalse();
            action.TryGetProperty("handlerGroup", out _).Should().BeFalse();
            action.TryGetProperty("enabledActionIds", out _).Should().BeFalse();
            action.TryGetProperty("capabilities", out _).Should().BeFalse();
        }
    }

    [Fact]
    public void Publication_CatalogIdentitiesMatchFrozenSchemaPattern()
    {
        FarmhandActionCatalog.Registrations.Should().OnlyContain(registration =>
            MatchesFrozenIdentifier(registration.ActionId)
            && MatchesFrozenIdentifier(registration.FamilyId));

        FarmhandActionSurfacePublication.Actions.Should().OnlyContain(action =>
            MatchesFrozenIdentifier(action.ActionId));
    }

    private static bool MatchesFrozenIdentifier(string value) =>
        value.Length is >= 2 and <= FarmhandActionSurfacePublication.MaximumIdentityLength
        && value[0] is >= 'a' and <= 'z'
        && value.Skip(1).All(character =>
        character is >= 'a' and <= 'z'
        or >= '0' and <= '9'
        or '_');

    [Fact]
    public void Publication_DoesNotExposeMutableProducerInput()
    {
        FarmhandActionDescriptorArtifact artifact = FarmhandActionSurfaceExport.CreateArtifact();
        ((object)artifact.Actions).Should().NotBeSameAs(FarmhandActionCatalog.Registrations);
        artifact.Actions.Should().BeAssignableTo<IReadOnlyList<FarmhandActionDescriptorProjection>>();
        FarmhandActionSurfacePublication.Actions.Should().BeAssignableTo<IReadOnlyList<FarmhandActionDescriptorProjection>>();

        Action mutate = () => ((IList<FarmhandActionDescriptorProjection>)FarmhandActionSurfacePublication.Actions)
            .Add(new FarmhandActionDescriptorProjection("unexpected", 1, "published", "read_only", new Dictionary<string, FarmhandActionArgumentSchema>(), new Dictionary<string, string>(), new FarmhandActionResourceTemplate(Array.Empty<FarmhandActionResourceTemplateValueProjection>()), "read", new FarmhandActionPostcondition("none")));
        mutate.Should().Throw<NotSupportedException>();

        artifact.Actions[0].ActionId.Should().Be(FarmhandActionCatalog.Registrations[0].ActionId);
        FarmhandActionSurfaceExport.CreateArtifact().Actions[0].ActionId
            .Should().Be(FarmhandActionCatalog.Registrations[0].ActionId);
    }

    [Fact]
    public void Publication_RetainsExperimentalAndReadOnlyCatalogEntries()
    {
        IReadOnlyList<FarmhandActionDescriptorProjection> actions = FarmhandActionSurfacePublication.Actions;

        actions.Should().Contain(action => action.Kind == "read_only");
        actions.Should().Contain(action => action.ActionId == "inspect_world_map");
        actions.Should().Contain(action => action.ActionId == "clear_debris");
    }
}
