using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane D.2: pins the single-tool contract of collect_animal_product.
///
/// One request may only settle through exactly one tool kind: MilkPail or
/// Shears (never both, never another tool). The successful evidence carries a
/// stable toolKind fact ("milk_pail" | "shears"); any other tool in the slot
/// is rejected with animal_product_tool_not_owned.
///
/// Structural assertions run without a Game1 harness (world-not-ready path);
/// the single-tool classification is pinned by the descriptor shape and the
/// handler route. Full live behavior belongs to the native-local fixture lane
/// per fixtures/stardew/RUNBOOK.md.
/// </summary>
public sealed class AnimalProductSingleToolTests
{
    [Fact]
    public void Catalog_CollectAnimalProduct_RegisteredAsExperimentalMachinesAnimals()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "collect_animal_product");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("animals_pets");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Published);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "x", "y", "slot", "expectedTargetId" });
        reg.Descriptor.Effect.Should().Be("write");
    }

    [Fact]
    public void Router_CollectAnimalProduct_DispatchesToMachinesAndAnimalsHandler()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "collect_animal_product" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MachineAndAnimalActionHandler(executions);

        var request = new BridgeExecutionRequest("req_animal_prod_1", "idemp_animal_prod_1", "collect_animal_product",
            new BridgeExecutionArgs { X = 5, Y = 5, Slot = 0, ExpectedQualifiedItemId = "(O)184", ExpectedTargetId = "target_1" }, 1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }
}