using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class ExecutionManagerQueueTests
{
    [Fact]
    public void EnqueueAction_WhenBodySettled_ExecutesImmediately()
    {
        var surface = FarmhandCapabilitySurface.FromEnabledActions(new HashSet<string>(new[] { "equip_tool" }));
        var executions = new ExecutionManager(new DummyMonitor(), surface);

        bool executed = false;
        var receipt = executions.EnqueueAction("req_01", "test_action", () =>
        {
            executed = true;
            return new LocalExecutionReceipt("exec_01", "req_01", ExecutionState.Succeeded, "ok", 1, null);
        });

        executed.Should().BeTrue();
        receipt.State.Should().Be(ExecutionState.Succeeded);
        executions.PendingActionCount.Should().Be(0);
    }

    [Fact]
    public void EnqueueAction_MultipleActions_QueuedAndDrivenSequentiallyOnUpdate()
    {
        var surface = FarmhandCapabilitySurface.FromEnabledActions(new HashSet<string>(new[] { "equip_tool" }));
        var executions = new ExecutionManager(new DummyMonitor(), surface);

        int executedCount = 0;
        // First action runs immediately
        var r1 = executions.EnqueueAction("req_1", "action_1", () =>
        {
            executedCount++;
            return new LocalExecutionReceipt("exec_1", "req_1", ExecutionState.Succeeded, "ok", 1, null);
        });

        // Next actions are enqueued into pending queue
        var r2 = executions.EnqueueAction("req_2", "action_2", () =>
        {
            executedCount++;
            return new LocalExecutionReceipt("exec_2", "req_2", ExecutionState.Succeeded, "ok", 2, null);
        }, forceQueue: true);

        var r3 = executions.EnqueueAction("req_3", "action_3", () =>
        {
            executedCount++;
            return new LocalExecutionReceipt("exec_3", "req_3", ExecutionState.Succeeded, "ok", 3, null);
        }, forceQueue: true);

        executedCount.Should().Be(1);
        r1.State.Should().Be(ExecutionState.Succeeded);
        r2.State.Should().Be(ExecutionState.Accepted);
        r2.ReasonCode.Should().Be("queued");
        r3.State.Should().Be(ExecutionState.Accepted);
        r3.ReasonCode.Should().Be("queued");
        executions.PendingActionCount.Should().Be(2);

        // Drive update tick: next action runs
        executions.Update();
        executedCount.Should().Be(2);
        executions.PendingActionCount.Should().Be(1);

        // Drive another update tick: final action runs
        executions.Update();
        executedCount.Should().Be(3);
        executions.PendingActionCount.Should().Be(0);
    }

    [Fact]
    public void Halt_ClearsPendingActionQueueAndMarksCancelled()
    {
        var surface = FarmhandCapabilitySurface.FromEnabledActions(new HashSet<string>(new[] { "equip_tool" }));
        var executions = new ExecutionManager(new DummyMonitor(), surface);

        executions.EnqueueAction("req_1", "action_1", () => new LocalExecutionReceipt("exec_1", "req_1", ExecutionState.Succeeded, "ok", 1, null));
        executions.EnqueueAction("req_2", "action_2", () => new LocalExecutionReceipt("exec_2", "req_2", ExecutionState.Succeeded, "ok", 2, null), forceQueue: true);
        executions.EnqueueAction("req_3", "action_3", () => new LocalExecutionReceipt("exec_3", "req_3", ExecutionState.Succeeded, "ok", 3, null), forceQueue: true);

        executions.PendingActionCount.Should().Be(2);

        executions.Halt("voice_and_body_interrupted");
        executions.PendingActionCount.Should().Be(0);
        executions.IsBodySettled.Should().BeTrue();

        executions.TryGetReceipt("req_2", out var r2).Should().BeTrue();
        r2.State.Should().Be(ExecutionState.Cancelled);
        r2.ReasonCode.Should().Be("voice_and_body_interrupted");

        executions.TryGetReceipt("req_3", out var r3).Should().BeTrue();
        r3.State.Should().Be(ExecutionState.Cancelled);
        r3.ReasonCode.Should().Be("voice_and_body_interrupted");
    }
}
