using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Handlers;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class FarmhandTypedReceiptContractTests
{
    [Fact]
    public void RegisteredMachineInspect_ProducesExactWorldNotReadyReceipt()
    {
        FarmhandCapabilitySurface surface = FarmhandCapabilitySurface.FromEnabledActions(new HashSet<string>(StringComparer.Ordinal) { "machine_inspect" });
        var executions = new ExecutionManager(new DummyMonitor(), surface);
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations.Single(candidate => candidate.ActionId == "machine_inspect");
        var router = new FarmhandActionRouter();
        router.Register(registration, new MachineAndAnimalActionHandler(executions));

        bool routed = router.TryRoute(
            new BridgeExecutionRequest("typed_request_router", "typed_idempotency_router", "machine_inspect", new BridgeExecutionArgs { X = 1, Y = 1, ExpectedTargetId = "machine_target_contract" }, 0, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000),
            executions,
            out LocalExecutionReceipt receipt,
            out string reasonCode);

        routed.Should().BeTrue();
        reasonCode.Should().Be("accepted");
        receipt.RequestId.Should().Be("typed_request_router");
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
        receipt.Revision.Should().Be(1);
    }
}
