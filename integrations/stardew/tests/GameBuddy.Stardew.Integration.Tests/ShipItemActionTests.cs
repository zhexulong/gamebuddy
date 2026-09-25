using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane E: ship_item contract pins.
///
/// Seam decision (recorded in
/// design/tasks/active/loop-closure-lane-e-ship-item-seam-decision.md):
/// ship_item calls the native <c>Farm.shipItem(Item, Farmer)</c>
/// (Farm.cs:1034) after a fail-closed <c>item is Object obj &amp;&amp;
/// obj.canBeShipped()</c> admission guard (Object.cs:1566). The night
/// settlement stays native (Game1.cs:7601-7627 money, Game1.cs:7753 bin
/// clear), so the Mod never writes money or bin contents.
///
/// Structural assertions run without a Game1 harness (world-not-ready path);
/// the native shipment, its bin write and the tool-rejection path belong to the
/// native-local fixture gate (scenario native_ship_item_v1).
/// </summary>
public sealed class ShipItemActionTests
{
    [Fact]
    public void Catalog_ShipItem_RegisteredAsExperimentalShopsEconomyWithSlotItemTarget()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "ship_item");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("shops_economy");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId" });
        reg.Descriptor.Effect.Should().Be("write");
        reg.Descriptor.Postcondition.Should().Be("native_action_postcondition");
    }

    /// <summary>
    /// W0a froze this cross-lane signature; Lane E only replaces the body. A
    /// silent signature change would break the shared handler dispatch.
    /// </summary>
    [Fact]
    public void RequestLocalShipItem_KeepsFrozenCrossLaneSignature()
    {
        MethodInfo? method = typeof(ExecutionManager).GetMethod(
            "RequestLocalShipItem",
            BindingFlags.Public | BindingFlags.Instance,
            binder: null,
            types: new[] { typeof(string), typeof(int), typeof(int), typeof(int), typeof(string), typeof(string), typeof(long) },
            modifiers: null);

        method.Should().NotBeNull();
        method!.ReturnType.Should().Be<LocalExecutionReceipt>();
    }

    [Fact]
    public void Router_ShipItem_WhenWorldNotReady_Rejects()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "ship_item" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MachineAndAnimalActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_ship_item_1", "idemp_ship_item_1", "ship_item",
            new BridgeExecutionArgs { X = 71, Y = 14, Slot = 2, ExpectedQualifiedItemId = "(O)24", ExpectedTargetId = "shipping_bin_0123456789abcdef" },
            1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        // Scope-bound actor proof precedes the Farm-scoped readiness check, so in a
        // world-less probe the identity guard is what refuses: TryGetBoundActor
        // reports world_not_ready when there is no world to read an actor from.
        // farm_required is still the code a real Farm-less world returns, and it is
        // pinned by the live-gated behaviour, not by this probe.
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Fact]
    public void Router_ShipItem_RepeatedRequestId_ReturnsSameTerminalReceipt()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "ship_item" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);

        LocalExecutionReceipt first = executions.RequestLocalShipItem(
            "req_ship_item_repeat", 2, 71, 14, "(O)24", "shipping_bin_0123456789abcdef", 5000);
        LocalExecutionReceipt second = executions.RequestLocalShipItem(
            "req_ship_item_repeat", 2, 71, 14, "(O)24", "shipping_bin_0123456789abcdef", 5000);

        first.ExecutionId.Should().Be(second.ExecutionId);
        first.State.Should().Be(second.State);
        first.ReasonCode.Should().Be(second.ReasonCode);
    }
}
