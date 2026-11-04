using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// `machine_load`'s item is the MACHINE's, not this catalog's.
///
/// <para>
/// WHY THIS EXISTS. The action used to pin `expectedQualifiedItemId` to `(O)433` through
/// <see cref="FarmhandExecutionAcceptanceFacts.ExactExpectedQualifiedItemId"/>, so a request naming a furnace's copper
/// ore was refused before any native code ran - measured 2026-10-31: a furnace, a preserves jar and a cheese press were
/// all refused by an action whose name promised machines generally. Which inputs a machine takes is content
/// (`Data/Machines`), so the Mod now asks the machine (`Object.performObjectDropInAction(probe: true)`) and the catalog
/// states where a caller can read the value (`loadInputQualifiedItemId` on the machine row).
/// </para>
/// <para>
/// The test drives the real acceptance layer, so it fails if the pin comes back - by any spelling, including a hidden
/// one in the composition of <c>SlotItemTarget</c>.
/// </para>
/// </summary>
public sealed class MachineLoadDeclarationTests
{
    private static FarmhandActionDescriptor MachineLoad() =>
        FarmhandActionCatalog.Registrations.Single(registration => registration.ActionId == "machine_load").Descriptor!;

    [Fact]
    public void TheCatalogNoLongerPinsOneItemAndSaysWhereTheItemComesFrom()
    {
        FarmhandActionDescriptor descriptor = MachineLoad();

        descriptor.Acceptance?.ExactExpectedQualifiedItemId.Should().BeNull(
            "the accepted input is one machine's own Data/Machines row, so this catalog cannot name a single item");

        FarmhandActionArgument argument = descriptor.Arguments.Single(candidate => candidate.Name == "expectedQualifiedItemId");
        argument.Description.Should().NotBeNull(
            "a caller reads this sentence through plan_shape instead of learning the rule from a refusal");
        argument.Description.Should().Contain(
            "loadInputQualifiedItemId",
            "the value a caller copies is the one discovery published on that machine's row");
        argument.Description.Should().Contain(
            "machine_load_unsupported_input",
            "the refusal a caller reaches with the wrong item has to be named where the value is described");
    }

    [Theory]
    // One native machine rule each: a Keg's coffee beans, a Furnace's copper ore, a Preserves Jar's produce.
    [InlineData("(O)433")]
    [InlineData("(O)378")]
    [InlineData("(O)258")]
    public void TheAcceptanceLayerAdmitsEveryMachinesOwnInput(string qualifiedItemId)
    {
        (bool accepted, string reasonCode) = Accept(qualifiedItemId);

        accepted.Should().BeTrue(
            $"{qualifiedItemId} is a real machine input; the acceptance layer answered '{reasonCode}' and the decision "
            + "belongs to the machine's own data, not to this catalog");
    }

    [Theory]
    [InlineData("")]
    [InlineData("(O)" + "433433433433433433433433433433433433433433433433433433433433433433433433433433433433433433433433433433433433433433433433433433433")]
    public void TheArgumentStillRefusesAnEmptyOrOversizedValue(string qualifiedItemId)
    {
        (bool accepted, string reasonCode) = Accept(qualifiedItemId);

        accepted.Should().BeFalse("the argument's own rule survives the pin: a value that names nothing, or one past the wire bound, must not reach the game thread");
        reasonCode.Should().Be("invalid_execution_request");
    }

    private static (bool Accepted, string ReasonCode) Accept(string qualifiedItemId)
    {
        FarmhandActionDescriptor descriptor = MachineLoad();
        BridgeExecutionArgs args = new()
        {
            X = 10,
            Y = 12,
            Slot = 3,
            ExpectedQualifiedItemId = qualifiedItemId,
            ExpectedTargetId = "machine_0000000000000000",
        };
        bool accepted = FarmhandExecutionAcceptance.TryValidate(descriptor, args, out string reasonCode);
        return (accepted, reasonCode);
    }
}
