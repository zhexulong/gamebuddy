using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane C.3: cut_weeds / scythe_crop contract pins.
///
/// Both actions require the requested scythe slot to be the current tool.
/// cut_weeds targets Weed objects only (Object.performToolAction weeds
/// branch); stones/twigs/debris clumps stay in their own actions. scythe_crop
/// targets ready Scythe-method crops only (HoeDirt.performToolAction scythe
/// branch) and never uses the Golden Scythe grab override — ordinary
/// Grab-method crops stay exclusively in harvest_crop.
///
/// Structural assertions run without a Game1 harness (world-not-ready path);
/// full native cutting/harvesting belongs to the native-local fixture lane per
/// fixtures/stardew/RUNBOOK.md.
/// </summary>
public sealed class ScytheActionTests
{
    [Fact]
    public void Catalog_CutWeeds_RegisteredAsExperimentalResourceToolsWithSlotTarget()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "cut_weeds");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("resource_gathering");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "x", "y", "slot", "expectedTargetId" });
    }

    [Fact]
    public void Catalog_ScytheCrop_RegisteredAsExperimentalFarmingWithSlotTarget()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "scythe_crop");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("farming_crops");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.Farming);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "x", "y", "slot", "expectedTargetId" });
    }

    [Fact]
    public void Router_CutWeeds_WhenWorldNotReady_Rejects()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "cut_weeds" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new ResourceToolActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_weeds_1", "idemp_weeds_1", "cut_weeds",
            new BridgeExecutionArgs { X = 5, Y = 5, Slot = 0, ExpectedTargetId = "weed_target_1" },
            1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("native_local_player_required");
    }

    [Fact]
    public void Router_ScytheCrop_WhenWorldNotReady_Rejects()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "scythe_crop" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new FarmingActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_scythe_1", "idemp_scythe_1", "scythe_crop",
            new BridgeExecutionArgs { X = 5, Y = 5, Slot = 0, ExpectedTargetId = "scythe_target_1" },
            1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("native_local_player_required");
    }
}