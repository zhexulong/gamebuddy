using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class FarmhandActionDevelopmentContractTests
{
    [Fact]
    public void EquipToolContract_DerivesExactIdentityFromCatalog()
    {
        ActionDevelopmentContract contract = FarmhandActionDevelopmentContract.DeriveContract("equip_tool");

        contract.Schema.Should().Be("gamebuddy-action-development-contract/v1");
        contract.GameId.Should().Be("stardew");
        contract.ActionId.Should().Be("equip_tool");
        contract.FamilyId.Should().Be("body_tools");
        contract.IdentityVersion.Should().Be(1);
        contract.Lifecycle.Should().Be("published");
        contract.Kind.Should().Be("execution");
    }

    [Fact]
    public void EquipToolContract_DerivesExactWireArgsFromBridgeProtocol()
    {
        ActionDevelopmentContract contract = FarmhandActionDevelopmentContract.DeriveContract("equip_tool");

        contract.Args.RequiredProperties.Should().Equal(new[] { "slot" });
        contract.Args.SlotMinimum.Should().Be(0);
        contract.Args.SlotMaximum.Should().Be(36);
    }

    [Fact]
    public void EquipToolContract_DerivesExactTerminalEvidenceFromHandler()
    {
        ActionDevelopmentContract contract = FarmhandActionDevelopmentContract.DeriveContract("equip_tool");

        contract.Terminal.AcceptableStates.Should().Equal(new[] { "succeeded", "uncertain" });
        contract.Terminal.SuccessReasonCode.Should().Be("tool_selected");
        contract.Terminal.EvidenceFields.Should().Equal(new[] { "slot", "before", "expected", "after" });
        contract.Terminal.EvidenceRelation.Should().Be("after_equals_expected");
    }

    [Fact]
    public void DeriveContract_SerializesToDeterministicJson()
    {
        ActionDevelopmentContract contract = FarmhandActionDevelopmentContract.DeriveContract("equip_tool");
        string json = FarmhandActionDevelopmentContract.SerializeToJson(contract);

        json.Should().Contain("\"schema\": \"gamebuddy-action-development-contract/v1\"");
        json.Should().Contain("\"actionId\": \"equip_tool\"");
        json.Should().Contain("\"successReasonCode\": \"tool_selected\"");
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