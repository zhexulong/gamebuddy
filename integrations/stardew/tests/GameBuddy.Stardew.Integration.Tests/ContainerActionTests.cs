using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane B.2/B.3: chest_store / chest_retrieve contract pins.
///
/// Seam decision recorded in tools/stardew-chest-seam-probe.md: chest_store
/// uses the menu-free Chest.addItem path; chest_retrieve removes the exact
/// target through GetItemsForPlayer().Remove + clearNulls and hands it to the
/// native player inventory. Neither mounts ItemGrabMenu; only player-owned
/// ordinary Chests are eligible.
///
/// Structural assertions run without a Game1 harness (world-not-ready path);
/// full native put/take behavior belongs to the native-local fixture lane per
/// fixtures/stardew/RUNBOOK.md.
/// </summary>
public sealed class ContainerActionTests
{
    [Fact]
    public void Catalog_ChestStore_RegisteredAsExperimentalMachinesAnimalsWithSlotItemTarget()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "chest_store");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("inventory_items");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId" });
        reg.Descriptor.Effect.Should().Be("write");
    }

    [Fact]
    public void Catalog_ChestRetrieve_RegisteredAsExperimentalMachinesAnimalsWithSlotItemTarget()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "chest_retrieve");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("inventory_items");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId" });
    }

    [Fact]
    public void Router_ChestRetrieve_WhenWorldNotReady_Rejects()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "chest_retrieve" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MachineAndAnimalActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_chest_retrieve_1", "idemp_chest_retrieve_1", "chest_retrieve",
            new BridgeExecutionArgs { X = 5, Y = 5, Slot = 2, ExpectedQualifiedItemId = "(O)24", ExpectedTargetId = "chest_target_1" },
            1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Fact]
    public void Router_ChestStore_WhenWorldNotReady_Rejects()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "chest_store" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MachineAndAnimalActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_chest_store_1", "idemp_chest_store_1", "chest_store",
            new BridgeExecutionArgs { X = 5, Y = 5, Slot = 2, ExpectedQualifiedItemId = "(O)24", ExpectedTargetId = "chest_target_1" },
            1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }
}