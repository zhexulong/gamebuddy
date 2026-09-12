using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class FarmhandActionDevelopmentContractTests
{
    [Fact]
    public void PickupForageContract_DerivesSceneTargetAndExistingArgs()
    {
        ActionDevelopmentContract contract = FarmhandActionDevelopmentContract.DeriveContract("pickup_forage");

        contract.Args.RequiredProperties.Should().Equal(new[] { "x", "y", "expectedQualifiedItemId", "expectedTargetId" });
        contract.Args.ToolAllowedValues.Should().BeNull();
        contract.Args.SceneTarget.Should().BeEquivalentTo(new ActionDevelopmentContractSceneTarget("ObservationBinding", 1, true, new[] { "observationId", "ref" }));
        contract.Terminal.SuccessReasonCodes.Should().Equal(new[] { "forage_picked_up" });
        contract.Terminal.EvidenceFields.Should().Equal(new[] { "location", "tile", "item", "removed", "inventory_before", "inventory_after" });
    }

    [Fact]
    public void EquipToolContract_DerivesExactIdentityFromCatalog()
    {
        ActionDevelopmentContract contract = FarmhandActionDevelopmentContract.DeriveContract("equip_tool");

        contract.Schema.Should().Be("gamebuddy-action-development-contract/v2");
        contract.GameId.Should().Be("stardew");
        contract.ActionId.Should().Be("equip_tool");
        contract.FamilyId.Should().Be("body_tools");
        contract.IdentityVersion.Should().Be(1);
        contract.Lifecycle.Should().Be("published");
        contract.Kind.Should().Be("execution");
    }

    [Fact]
    public void EquipToolContract_DerivesExactSemanticArgs()
    {
        ActionDevelopmentContract contract = FarmhandActionDevelopmentContract.DeriveContract("equip_tool");

        contract.Args.RequiredProperties.Should().Equal(new[] { "tool" });
        contract.Args.ToolAllowedValues.Should().Equal(new[]
        {
            "axe",
            "pickaxe",
            "hoe",
            "watering_can",
            "fishing_rod",
            "weapon",
            "scythe",
            "shears",
            "milk_pail",
            "pan",
        });
    }

    [Fact]
    public void EquipToolContract_DerivesExactTerminalEvidenceFromHandler()
    {
        ActionDevelopmentContract contract = FarmhandActionDevelopmentContract.DeriveContract("equip_tool");

        contract.Terminal.AcceptableStates.Should().Equal(new[] { "succeeded", "uncertain" });
        contract.Terminal.SuccessReasonCodes.Should().Equal(new[] { "tool_equipped", "already_equipped" });
        contract.Terminal.EvidenceFields.Should().Equal(new[] { "tool", "before", "expected", "after" });
        contract.Terminal.EvidenceRelation.Should().Be("after_equals_expected");
    }

    [Fact]
    public void DeriveContract_SerializesToDeterministicJson()
    {
        ActionDevelopmentContract contract = FarmhandActionDevelopmentContract.DeriveContract("equip_tool");
        string json = FarmhandActionDevelopmentContract.SerializeToJson(contract);

        json.Should().Contain("\"schema\": \"gamebuddy-action-development-contract/v2\"");
        json.Should().Contain("\"actionId\": \"equip_tool\"");
        json.Should().Contain("\"successReasonCodes\": [");
        json.Should().Contain("\"tool_equipped\"");
        json.Should().Contain("\"already_equipped\"");
        json.Should().Contain("\"after_equals_expected\"");

        var deserialized = System.Text.Json.JsonSerializer.Deserialize<ActionDevelopmentContract>(json,
            new System.Text.Json.JsonSerializerOptions { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase });
        deserialized.Should().NotBeNull();
        deserialized!.ActionId.Should().Be("equip_tool");
    }

    [Fact]
    public void DeriveContract_FailsClosedForUnknownAction()
    {
        Action act = () => FarmhandActionDevelopmentContract.DeriveContract("unknown_action");
        act.Should().Throw<KeyNotFoundException>();
    }

    [Fact]
    public void DeriveContract_FailsClosedForNullAction()
    {
        Action act = () => FarmhandActionDevelopmentContract.DeriveContract(null!);
        act.Should().Throw<ArgumentException>();
    }
}