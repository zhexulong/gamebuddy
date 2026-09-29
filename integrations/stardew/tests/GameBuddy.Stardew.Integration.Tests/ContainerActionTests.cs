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
    public void Catalog_ChestStore_RegisteredAsLiveVerifiedMachinesAnimalsWithSlotItemTarget()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "chest_store");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("inventory_items");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId" });
        reg.Descriptor.Effect.Should().Be("write");
    }

    [Fact]
    public void Catalog_ChestRetrieve_RegisteredAsLiveVerifiedMachinesAnimalsWithSlotItemTarget()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "chest_retrieve");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("inventory_items");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId" });
    }

    [Fact]
    public void Container_Handlers_ResolveTheBuiltInKitchenFridgeAsAnEligibleTarget()
    {
        // The fridge is the same store/take intent as a placed chest because it IS a
        // Chest (FarmHouse.fridge / IslandFarmHouse.fridge are NetRef<Chest> built with
        // playerChest: true). It never enters location.objects, so the handler must
        // reach it through GameLocation.GetFridge() and the room's map tile. This pins
        // that resolution so a refactor cannot silently shrink the container family
        // back to placed chests only.
        string? source = TryFindRepoFile(@"integrations\stardew\farmhandexecutioncontroller.cs");
        source.Should().NotBeNull("the execution controller source must exist (looked upward from test output and working dir)");
        string? handlers = TryFindRepoFile(@"integrations\stardew\farmhandexecutioncontroller.containeractions.cs");
        handlers.Should().NotBeNull();
        string controller = File.ReadAllText(source!);
        string containers = File.ReadAllText(handlers!);

        controller.Should().Contain("location.GetFridge()", "the fridge target must resolve through the native accessor");
        controller.Should().Contain("fridgePosition", "the fridge map tile comes from the room's cached position");
        controller.Should().Contain("BuildFridgeTargetId", "the fridge needs its own opaque target identity");
        controller.Should().Contain("ResolveStorageContainerAt", "both container handlers share one resolver");
        // Both handlers must go through the shared resolver rather than reading
        // location.objects directly: a direct object-layer lookup cannot see a fridge.
        containers.Should().Contain("ResolveStorageContainerAt(location, targetX, targetY)");
        containers.Should().NotContain(
            "location.objects.TryGetValue",
            "a direct object-layer lookup would silently exclude the built-in fridge");
        // The native transaction stays identical for both target kinds.
        containers.Should().Contain("chest.addItem(storedItem)");
        containers.Should().Contain("chest.GetItemsForPlayer().Remove(target)");
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

    private static string? TryFindRepoFile(string relativePath)
    {
        // Tests can run from the project directory or from the bin output directory;
        // walk upward from both until the committed file (which sits at the repo root)
        // is found.
        string[] starts = { AppContext.BaseDirectory, Environment.CurrentDirectory };
        foreach (string start in starts)
        {
            DirectoryInfo? dir = new(start);
            for (int depth = 0; dir is not null && depth < 12; depth++, dir = dir.Parent)
            {
                string candidate = Path.Combine(dir.FullName, relativePath);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }
}