using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane C.1: chop_stump contract pins.
///
/// Target-entity orthogonality (2026-09-23 decision): chop_stump listens ONLY
/// to TerrainFeature Tree with stump.Value == true; ResourceClump stumps
/// (600/602) stay exclusively in clear_debris. Any Axe upgrades are accepted
/// (no tool_level_insufficient reject); success requires the stump to be gone
/// after the single native Axe.DoFunction swing.
///
/// Structural assertions run without a Game1 harness (world-not-ready path);
/// full native behavior belongs to the native-local fixture lane per
/// fixtures/stardew/RUNBOOK.md.
/// </summary>
public sealed class StumpActionTests
{
    [Fact]
    public void Catalog_ChopStump_RegisteredAsLiveVerifiedResourceToolsWithSlotTarget()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "chop_stump");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("resource_gathering");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "x", "y", "slot", "expectedTargetId" });
        reg.Descriptor.Effect.Should().Be("write");
    }

    [Fact]
    public void Router_ChopStump_WhenWorldNotReady_Rejects()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "chop_stump" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new ResourceToolActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_stump_1", "idemp_stump_1", "chop_stump",
            new BridgeExecutionArgs { X = 5, Y = 5, Slot = 0, ExpectedTargetId = "stump_target_1" },
            1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }
}