using FluentAssertions;
using FsCheck;
using FsCheck.Xunit;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Routing;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class FarmhandActionRouterPropertyTests
{
    private sealed class StubLedger : IExecutionLedger
    {
        public long CurrentRevision => 1;
        public bool IsBodyBusy => false;
        public bool TryGetExistingReceipt(string requestId, out LocalExecutionReceipt receipt)
        {
            receipt = default!;
            return false;
        }
        public LocalExecutionReceipt Remember(LocalExecutionReceipt receipt) => receipt;
        public LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence) =>
            new(executionId, requestId, state, reasonCode, 1, evidence);
        public void AddTrace(LocalExecutionReceipt receipt) {}
    }

    private sealed class FixedHandler : IFarmhandActionHandler
    {
        public FixedHandler(params string[] actions) => this.SupportedActions = actions;
        public IReadOnlyCollection<string> SupportedActions { get; }
        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger) =>
            ledger.RememberTerminal(request.RequestId, "exec_pbt", ExecutionState.Succeeded, "handled", null);
    }

    [Property(MaxTest = 100)]
    public Property UnregisteredActions_AlwaysFailClosed_WithActionNotAvailable(NonNull<string> randomAction)
    {
        string action = randomAction.Get;
        bool isRegistered = action == "known_action";

        var router = new FarmhandActionRouter();
        router.Register(new FixedHandler("known_action"));
        var ledger = new StubLedger();

        var request = new BridgeExecutionRequest("req_pbt", "idemp_pbt", action, new BridgeExecutionArgs(), 1, 5000);
        bool routed = router.TryRoute(request, ledger, out LocalExecutionReceipt receipt, out string reasonCode);

        if (!isRegistered)
        {
            return (!routed && reasonCode == "action_not_available" && receipt == null).ToProperty();
        }
        else
        {
            return (routed && reasonCode == "accepted" && receipt != null).ToProperty();
        }
    }
}
