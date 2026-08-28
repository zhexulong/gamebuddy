using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class FarmhandActionSurfaceExportTests
{
    [Fact]
    public void Publication_BindsExactlyToCatalogOrderAndIdentityProjection()
    {
        FarmhandActionSurfaceArtifact artifact = FarmhandActionSurfaceExport.CreateArtifact();

        artifact.Schema.Should().Be("gamebuddy-stardew-action-surface/v1");
        artifact.GameId.Should().Be("stardew");
        artifact.Registrations.Should().HaveSameCount(FarmhandActionCatalog.Registrations);
        artifact.Registrations.Select(registration => registration.ActionId)
            .Should().Equal(FarmhandActionCatalog.Registrations.Select(registration => registration.ActionId));

        for (int index = 0; index < artifact.Registrations.Count; index++)
        {
            FarmhandActionRegistration source = FarmhandActionCatalog.Registrations[index];
            FarmhandActionSurfaceRegistration projection = artifact.Registrations[index];
            projection.ActionId.Should().Be(source.ActionId);
            projection.FamilyId.Should().Be(source.FamilyId);
            projection.IdentityVersion.Should().Be(source.IdentityVersion);
            projection.Lifecycle.Should().Be(source.Lifecycle.ToWireValue());
            projection.Kind.Should().Be(source.Kind.ToWireValue());
        }
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
        first.Should().Contain("{\"schema\":\"gamebuddy-stardew-action-surface/v1\"");
        first.Should().Contain("\"actionId\":\"move_to_tile\"");
        first.Should().Contain("\"actionId\":\"pet_animal\"");
        first.Should().Contain("\"lifecycle\":\"experimental\"");
        first.Should().Contain("\"kind\":\"read_only\"");
    }

    [Fact]
    public void SerializeToJson_ContainsExactBoundedKeysAndNoAuthorityFields()
    {
        using JsonDocument document = JsonDocument.Parse(FarmhandActionSurfaceExport.SerializeToJson());
        JsonElement root = document.RootElement;

        root.EnumerateObject().Select(property => property.Name)
            .Should().Equal("schema", "gameId", "registrations");
        root.GetProperty("registrations").GetArrayLength().Should().Be(FarmhandActionCatalog.Registrations.Count);

        foreach (JsonElement registration in root.GetProperty("registrations").EnumerateArray())
        {
            registration.EnumerateObject().Select(property => property.Name)
                .Should().Equal("actionId", "familyId", "identityVersion", "lifecycle", "kind");
            registration.TryGetProperty("handlerGroup", out _).Should().BeFalse();
            registration.TryGetProperty("enabledActionIds", out _).Should().BeFalse();
            registration.TryGetProperty("catalogRevision", out _).Should().BeFalse();
            registration.TryGetProperty("capabilities", out _).Should().BeFalse();
        }
    }

    [Fact]
    public void Publication_CatalogIdentitiesMatchFrozenSchemaPattern()
    {
        FarmhandActionCatalog.Registrations.Should().OnlyContain(registration =>
            MatchesFrozenIdentifier(registration.ActionId)
            && MatchesFrozenIdentifier(registration.FamilyId));

        FarmhandActionSurfacePublication.Registrations.Should().OnlyContain(registration =>
            MatchesFrozenIdentifier(registration.ActionId)
            && MatchesFrozenIdentifier(registration.FamilyId));
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
        FarmhandActionSurfaceArtifact artifact = FarmhandActionSurfaceExport.CreateArtifact();
        ((object)artifact.Registrations).Should().NotBeSameAs(FarmhandActionCatalog.Registrations);
        artifact.Registrations.Should().BeAssignableTo<IReadOnlyList<FarmhandActionSurfaceRegistration>>();
        FarmhandActionSurfacePublication.Registrations.Should().BeAssignableTo<IReadOnlyList<FarmhandActionSurfaceRegistration>>();

        Action mutate = () => ((IList<FarmhandActionSurfaceRegistration>)FarmhandActionSurfacePublication.Registrations)
            .Add(new FarmhandActionSurfaceRegistration("unexpected", "unexpected", 1, "published", "execution"));
        mutate.Should().Throw<NotSupportedException>();

        artifact.Registrations[0].ActionId.Should().Be(FarmhandActionCatalog.Registrations[0].ActionId);
        FarmhandActionSurfaceExport.CreateArtifact().Registrations[0].ActionId
            .Should().Be(FarmhandActionCatalog.Registrations[0].ActionId);
    }

    [Fact]
    public void Publication_RetainsExperimentalAndReadOnlyCatalogEntries()
    {
        IReadOnlyList<FarmhandActionSurfaceRegistration> registrations = FarmhandActionSurfacePublication.Registrations;

        registrations.Should().Contain(registration => registration.Lifecycle == "experimental");
        registrations.Should().Contain(registration => registration.Kind == "read_only");
        registrations.Should().Contain(registration => registration.ActionId == "inspect_world_map");
        registrations.Should().Contain(registration => registration.ActionId == "clear_debris");
    }
}
