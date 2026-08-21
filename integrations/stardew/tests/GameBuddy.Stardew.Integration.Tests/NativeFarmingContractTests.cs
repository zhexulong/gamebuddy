using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class NativeFarmingContractTests
{
    [Fact]
    public void FarmhandActionCatalog_RegistersCoreFarmingCapabilitiesOnce()
    {
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.HandlerGroup == FarmhandActionHandlerGroup.Farming)
            .Select(registration => registration.ActionId)
            .Should().Contain(new[]
            {
                "till_soil",
                "water_crop",
                "plant_seed",
                "fertilize_tile",
                "harvest_crop",
                "clear_hoedirt",
            });
    }

    [Fact]
    public void TillSoil_WhenWorldNotReady_ReturnsBlockedReceipt()
    {
        var surface = FarmhandCapabilitySurface.FromEnabledActions(new HashSet<string>(new[] { "till_soil" }));
        var executions = new ExecutionManager(new DummyMonitor(), surface);
        var handler = new FarmingActionHandler(executions);

        var request = new BridgeExecutionRequest("req_till_1", "idemp_till_1", "till_soil", new BridgeExecutionArgs { X = 10, Y = 10 }, 1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }
}

internal sealed class DummyMonitor : StardewModdingAPI.IMonitor
{
    public bool IsVerbose => false;
    public void Log(string message, StardewModdingAPI.LogLevel level = StardewModdingAPI.LogLevel.Trace) {}
    public void LogOnce(string message, StardewModdingAPI.LogLevel level = StardewModdingAPI.LogLevel.Trace) {}
    public void VerboseLog(string message) {}
    public void VerboseLog(ref StardewModdingAPI.Framework.Logging.VerboseLogStringHandler message) {}
}
