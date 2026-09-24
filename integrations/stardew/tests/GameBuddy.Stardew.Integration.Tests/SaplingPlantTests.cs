using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane C.2: plant_sapling contract pins.
///
/// The sapling item must be a wild-tree seed (Data/WildTrees SeedItemId,
/// e.g. (O)309 Acorn); the tile must pass the native Object.placementAction
/// wild-tree branch preconditions (mirrored by CanPlantWildTreeSeedAt);
/// success requires a new TerrainFeature Tree on the tile and a one-item
/// inventory decrement, all via the single native placement call.
///
/// Structural assertions run without a Game1 harness (world-not-ready path);
/// full native planting belongs to the native-local fixture lane per
/// fixtures/stardew/RUNBOOK.md.
/// </summary>
public sealed class SaplingPlantTests
{
    [Fact]
    public void Catalog_PlantSapling_RegisteredAsExperimentalFarmingWithSlotItemTarget()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "plant_sapling");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("farming_crops");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.Farming);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId" });
        reg.Descriptor.Effect.Should().Be("write");
    }

    [Fact]
    public void Router_PlantSapling_WhenWorldNotReady_Rejects()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "plant_sapling" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new FarmingActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_sapling_1", "idemp_sapling_1", "plant_sapling",
            new BridgeExecutionArgs { X = 5, Y = 5, Slot = 2, ExpectedQualifiedItemId = "(O)309", ExpectedTargetId = "sapling_target_1" },
            1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }
}