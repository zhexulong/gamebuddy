using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class NativeToolContractTests
{
    [Fact]
    public void FarmhandActionCatalog_RegistersCoreToolCapabilitiesOnce()
    {
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.HandlerGroup == FarmhandActionHandlerGroup.ResourceTools)
            .Select(registration => registration.ActionId)
            .Should().Contain(new[]
            {
                "equip_tool",
                "clear_debris",
                "chop_tree_source",
                "break_rock_source",
                "dig_artifact_spot",
                "refill_watering_can",
                "place_wood_fence",
                "place_crab_pot",
                "bait_crab_pot",
            });
    }

    [Fact]
    public void ChopTreeSource_WhenWorldNotReady_ReturnsRejectedReceipt()
    {
        var surface = FarmhandCapabilitySurface.FromEnabledActions(new HashSet<string>(new[] { "chop_tree_source" }));
        var executions = new ExecutionManager(new DummyMonitor(), surface);
        var handler = new ResourceToolActionHandler(executions);

        var request = new BridgeExecutionRequest("req_chop_1", "idemp_chop_1", "chop_tree_source", new BridgeExecutionArgs { X = 5, Y = 5, Slot = 0, ExpectedTargetId = "target_1" }, 1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("native_local_player_required");
    }
}
