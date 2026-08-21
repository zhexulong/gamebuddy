using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class FarmhandActionRouterTests
{
    private sealed class StubLedger : IExecutionLedger
    {
        private readonly Dictionary<string, LocalExecutionReceipt> receipts = new(StringComparer.Ordinal);
        public long CurrentRevision { get; set; } = 1;
        public bool IsBodyBusy { get; set; }
        public bool TryGetExistingReceipt(string requestId, out LocalExecutionReceipt receipt) => this.receipts.TryGetValue(requestId, out receipt!);
        public LocalExecutionReceipt Remember(LocalExecutionReceipt receipt) => this.receipts[receipt.RequestId] = receipt;
        public LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence)
        {
            var receipt = new LocalExecutionReceipt(executionId, requestId, state, reasonCode, ++this.CurrentRevision, evidence);
            this.receipts[requestId] = receipt;
            return receipt;
        }
        public void AddTrace(LocalExecutionReceipt receipt) { }
    }

    private sealed class StubActionHandler : IFarmhandActionHandler
    {
        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger) =>
            ledger.RememberTerminal(request.RequestId, "exec_123", ExecutionState.Succeeded, "test_succeeded", null);
    }

    [Fact]
    public void TryRoute_WithRegisteredAction_DispatchesSuccessfully()
    {
        var router = new FarmhandActionRouter();
        router.Register(TestRegistration("till_soil"), new StubActionHandler());
        var ledger = new StubLedger();

        bool routed = router.TryRoute(new BridgeExecutionRequest("req_1", "idemp_1", "till_soil", new BridgeExecutionArgs { X = 10, Y = 20 }, 1, 5000), ledger, out LocalExecutionReceipt receipt, out string reasonCode);

        routed.Should().BeTrue();
        reasonCode.Should().Be("accepted");
        receipt.State.Should().Be(ExecutionState.Succeeded);
        receipt.ReasonCode.Should().Be("test_succeeded");
    }

    [Fact]
    public void TryRoute_WithUnregisteredAction_FailsClosed()
    {
        var router = new FarmhandActionRouter();
        router.Register(TestRegistration("till_soil"), new StubActionHandler());

        bool routed = router.TryRoute(new BridgeExecutionRequest("req_2", "idemp_2", "unknown_action", new BridgeExecutionArgs(), 1, 5000), new StubLedger(), out LocalExecutionReceipt receipt, out string reasonCode);

        routed.Should().BeFalse();
        reasonCode.Should().Be("action_not_available");
        receipt.Should().BeNull();
    }

    [Fact]
    public void TryRoute_WhenReceiptExistsInLedger_ReturnsCachedReceiptWithoutExecutingHandler()
    {
        var router = new FarmhandActionRouter();
        router.Register(TestRegistration("till_soil"), new StubActionHandler());
        var ledger = new StubLedger();
        var cachedReceipt = new LocalExecutionReceipt("exec_old", "req_cached", ExecutionState.Succeeded, "already_completed", 1, null);
        ledger.Remember(cachedReceipt);

        bool routed = router.TryRoute(new BridgeExecutionRequest("req_cached", "idemp_cached", "till_soil", new BridgeExecutionArgs(), 1, 5000), ledger, out LocalExecutionReceipt receipt, out string reasonCode);

        routed.Should().BeTrue();
        reasonCode.Should().Be("replayed_existing_receipt");
        receipt.Should().BeSameAs(cachedReceipt);
    }

    [Fact]
    public void TryRoute_WhenCalledFromDifferentThread_RejectsWithGameThreadRequired()
    {
        var router = new FarmhandActionRouter(ownerManagedThreadId: Environment.CurrentManagedThreadId);
        router.Register(TestRegistration("till_soil"), new StubActionHandler());
        var ledger = new StubLedger();
        var request = new BridgeExecutionRequest("req_3", "idemp_3", "till_soil", new BridgeExecutionArgs(), 1, 5000);
        bool routed = false;
        string? reason = null;
        var thread = new Thread(() => { routed = router.TryRoute(request, ledger, out _, out string r); reason = r; });
        thread.Start();
        thread.Join();

        routed.Should().BeFalse();
        reason.Should().Be("game_thread_required");
    }

    [Fact]
    public void Register_DuplicateAction_ThrowsInvalidOperationException()
    {
        var router = new FarmhandActionRouter();
        router.Register(TestRegistration("till_soil"), new StubActionHandler());
        Action act = () => router.Register(TestRegistration("till_soil"), new StubActionHandler());
        act.Should().Throw<InvalidOperationException>().WithMessage("*Duplicate farmhand action handler registration*");
    }

    private static FarmhandActionRegistration TestRegistration(string actionId) =>
        new(actionId, "test", 1, FarmhandActionLifecycle.Published, FarmhandActionHandlerGroup.Farming);
}
