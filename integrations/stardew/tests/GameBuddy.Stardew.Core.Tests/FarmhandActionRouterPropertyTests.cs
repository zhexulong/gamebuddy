using FluentAssertions;
using FsCheck;
using FsCheck.Xunit;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class FarmhandActionRouterPropertyTests
{
    private sealed class StubLedger : IExecutionLedger
    {
        public long CurrentRevision => 1;
        public bool IsBodyBusy => false;
        public bool TryGetExistingReceipt(string requestId, out LocalExecutionReceipt receipt) { receipt = default!; return false; }
        public void BindAction(string requestId, string actionId) { }
        public LocalExecutionReceipt Remember(LocalExecutionReceipt receipt) => receipt;
        public LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence) => new(executionId, requestId, state, reasonCode, 1, evidence);
        public void AddTrace(LocalExecutionReceipt receipt) { }
    }

    private sealed class FixedHandler : IFarmhandActionHandler
    {
        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger) =>
            ledger.RememberTerminal(request.RequestId, "exec_pbt", ExecutionState.Succeeded, "handled", null);
    }

    [Property(MaxTest = 100)]
    public Property UnregisteredActions_AlwaysFailClosed_WithActionNotAvailable(NonNull<string> randomAction)
    {
        string action = randomAction.Get;
        bool isRegistered = action == "known_action";
        var router = new FarmhandActionRouter();
        router.Register(new FarmhandActionRegistration("known_action", "test", 1, FarmhandActionLifecycle.Published, FarmhandOperationKind.Execution, FarmhandActionHandlerGroup.Farming), new FixedHandler());

        bool routed = router.TryRoute(new BridgeExecutionRequest("req_pbt", "idemp_pbt", action, new BridgeExecutionArgs(), 1, 5000), new StubLedger(), out LocalExecutionReceipt receipt, out string reasonCode);

        return isRegistered
            ? (routed && reasonCode == "accepted" && receipt != null).ToProperty()
            : (!routed && reasonCode == "action_not_available" && receipt == null).ToProperty();
    }
}
