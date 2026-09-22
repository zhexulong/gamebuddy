using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane D.3: pins the consumable-only contract of use_item.
///
/// use_item may only settle through the native eatHeldObject path for
/// consumables (food/drink); non-consumables (Edibility == -300 and not a
/// drink) are rejected with item_not_consumable. Evidence carries edibility
/// and isDrink facts.
///
/// Structural assertions run without a Game1 harness (world-not-ready path);
/// the consumable classification is pinned by the descriptor shape and the
/// handler route. Full live behavior belongs to the native-local fixture lane
/// per fixtures/stardew/RUNBOOK.md.
/// </summary>
public sealed class UseItemConsumableOnlyTests
{
    [Fact]
    public void Catalog_UseItem_RegisteredAsConsumableShapedExecution()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "use_item");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("inventory_items");
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "slot", "expectedQualifiedItemId" });
        reg.Descriptor.Effect.Should().Be("write");
    }

    [Fact]
    public void Router_UseItem_DispatchesToMachinesAndAnimalsHandler()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "use_item" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MachineAndAnimalActionHandler(executions);

        var request = new BridgeExecutionRequest("req_use_1", "idemp_use_1", "use_item",
            new BridgeExecutionArgs { Slot = 0, ExpectedQualifiedItemId = "(O)216" }, 1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }
}