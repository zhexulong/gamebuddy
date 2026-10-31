using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// <c>ship_item</c> names an item, not a pack slot.
///
/// <para>
/// The action closes over its request's <c>slot</c> and re-validates it AFTER the approach walk, but a walk to a
/// shipping bin takes tens of ticks and the pack is not frozen meanwhile: a magnet pickup or a stack merge shifts
/// every slot after the one that changed. A slot is therefore perception - which stack the snapshot happened to row
/// up - and not intent, which is why <c>chest_store</c> already dropped it and resolves the first carried stack of
/// the item id on arrival (<c>farmhandexecutioncontroller.containeractions.cs</c>).
/// </para>
/// </summary>
public sealed class ShipItemCarriedItemTests
{
    [Fact]
    public void AShipRequestThatNamesAnItemAndNoSlotIsAccepted()
    {
        FarmhandActionDescriptor descriptor = FarmhandActionCatalog.Registrations
            .Single(registration => registration.ActionId == "ship_item").Descriptor!;
        var args = new BridgeExecutionArgs
        {
            X = 71,
            Y = 14,
            ExpectedQualifiedItemId = "(O)24",
            ExpectedTargetId = "shipping_bin_0123456789abcdef",
        };

        FarmhandExecutionAcceptance.TryValidate(descriptor, args, out string reasonCode)
            .Should().BeTrue($"ship_item must accept the facts it declares; it answered '{reasonCode}'");
    }

    [Fact]
    public void AShipRequestThatStillSendsASlotIsRefused()
    {
        // The other half of the same rule: a stale plan is not silently reinterpreted onto whatever now occupies the
        // slot the caller named - it fails loudly.
        FarmhandActionDescriptor descriptor = FarmhandActionCatalog.Registrations
            .Single(registration => registration.ActionId == "ship_item").Descriptor!;
        var args = new BridgeExecutionArgs
        {
            X = 71,
            Y = 14,
            Slot = 2,
            ExpectedQualifiedItemId = "(O)24",
            ExpectedTargetId = "shipping_bin_0123456789abcdef",
        };

        FarmhandExecutionAcceptance.TryValidate(descriptor, args, out string reasonCode).Should().BeFalse();
        reasonCode.Should().Be("invalid_execution_request");
    }

    [Fact]
    public void TheDescriptorPublishesWhatTheItemIdMeans()
    {
        // `plan_shape` answers from these descriptions, so the caller must be able to read that the item id IS the
        // address and that there is no slot beside it.
        FarmhandActionDescriptor descriptor = FarmhandActionCatalog.Registrations
            .Single(registration => registration.ActionId == "ship_item").Descriptor!;

        descriptor.Arguments.Select(argument => argument.Name)
            .Should().BeEquivalentTo(new[] { "x", "y", "expectedQualifiedItemId", "expectedTargetId" });
        descriptor.Arguments.Single(argument => argument.Name == "expectedQualifiedItemId").Description
            .Should().NotBeNullOrWhiteSpace().And.Contain("FIRST");
    }
}
