using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class FarmhandActionRouterTests
{
    private sealed class StubLedger : IExecutionLedger, IDispatchExecutionLedger
    {
        private readonly Dictionary<string, LocalExecutionReceipt> receipts = new(StringComparer.Ordinal);
        public long CurrentRevision { get; set; } = 1;
        public bool IsBodyBusy { get; set; }
        public string? BoundActionId { get; private set; }
        public string? BoundExecutionId { get; private set; }
        public bool TryBindDispatch(string requestId, string actionId, string executionId, out string reasonCode)
        {
            if (BoundExecutionId is not null)
            {
                reasonCode = "execution_identity_conflict";
                return false;
            }
            BoundActionId = actionId;
            BoundExecutionId = executionId;
            reasonCode = "bound";
            return true;
        }
        public bool TryGetBoundExecutionId(string requestId, out string executionId)
        {
            executionId = BoundExecutionId!;
            return BoundExecutionId is not null;
        }
        public bool TryGetExistingReceipt(string requestId, out LocalExecutionReceipt receipt) => this.receipts.TryGetValue(requestId, out receipt!);
        public void BindAction(string requestId, string actionId) => this.BoundActionId = actionId;
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
        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            string executionId = ledger is IDispatchExecutionLedger dispatchLedger
                && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
                ? boundExecutionId
                : "exec_123";
            return ledger.RememberTerminal(request.RequestId, executionId, ExecutionState.Succeeded, "test_succeeded", null);
        }
    }

    [Fact]
    public void TryRoute_NavigateToDestination_DispatchesToExecutionHandler_NoPrimitive()
    {
        var router = new FarmhandActionRouter();
        var handler = new StubActionHandler();
        router.Register(TestRegistration("navigate_to_destination"), handler);
        var ledger = new StubLedger();
        var request = new BridgeExecutionRequest(
            "req_nav",
            "idemp_nav",
            "navigate_to_destination",
            new BridgeExecutionArgs { Destination = new BridgeNavigationDestinationSelector("label", "Mine", null) },
            1,
            5000);

        bool routed = router.TryRoute(request, ledger, out LocalExecutionReceipt receipt, out string reasonCode);

        routed.Should().BeTrue();
        reasonCode.Should().Be("accepted");
        receipt.State.Should().Be(ExecutionState.Succeeded);
        ledger.BoundActionId.Should().Be("navigate_to_destination");
    }

    [Fact]
    public void TryRoute_WithDispatchExecutionId_BindsIdentityBeforeHandlerRuns()
    {
        var router = new FarmhandActionRouter();
        router.Register(TestRegistration("till_soil"), new StubActionHandler());
        var ledger = new StubLedger();
        var request = new BridgeExecutionRequest("req_bound", "idemp_bound", "till_soil", new BridgeExecutionArgs { X = 10, Y = 20 }, 1, 5000);

        bool routed = router.TryRoute(request, ledger, "exec_bound", out LocalExecutionReceipt receipt, out string reasonCode);

        routed.Should().BeTrue(reasonCode);
        reasonCode.Should().Be("accepted");
        ledger.BoundExecutionId.Should().Be("exec_bound");
        receipt.ExecutionId.Should().Be("exec_bound");
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
        ledger.BoundActionId.Should().Be("till_soil");
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
    public void TryRoute_ReplayWithDifferentDispatchExecutionId_FailsClosed()
    {
        var router = new FarmhandActionRouter();
        var handler = new StubActionHandler();
        router.Register(TestRegistration("till_soil"), handler);
        var ledger = new StubLedger();
        var request = new BridgeExecutionRequest("req_replay", "idemp_replay", "till_soil", new BridgeExecutionArgs(), 1, 5000);

        router.TryRoute(request, ledger, "exec_first", out _, out _).Should().BeTrue();
        bool replayed = router.TryRoute(request, ledger, "exec_other", out _, out string reasonCode);

        replayed.Should().BeFalse();
        reasonCode.Should().Be("execution_identity_conflict");
        ledger.BoundExecutionId.Should().Be("exec_first");
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

    [Fact]
    public void Register_ReadOnlyOperation_ThrowsBeforeExecutionDispatch()
    {
        var router = new FarmhandActionRouter();
        var operation = new FarmhandActionRegistration(
            "inspect_world_map", "world_navigation", 1, FarmhandActionLifecycle.Published,
            FarmhandOperationKind.ReadOnly, null);

        router.Invoking(candidate => candidate.Register(operation, new StubActionHandler()))
            .Should().Throw<InvalidOperationException>()
            .WithMessage("Read-only Farmhand operations cannot be registered for execution.");
    }

    private static FarmhandActionRegistration TestRegistration(string actionId) =>
        new(actionId, "test", 1, FarmhandActionLifecycle.Published, FarmhandOperationKind.Execution, FarmhandActionHandlerGroup.Farming);
}
