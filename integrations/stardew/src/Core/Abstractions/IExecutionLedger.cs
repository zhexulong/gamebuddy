using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.Abstractions;

public interface IExecutionLedger
{
    long CurrentRevision { get; }
    bool IsBodyBusy { get; }
    bool TryGetExistingReceipt(string requestId, out LocalExecutionReceipt receipt);
    LocalExecutionReceipt Remember(LocalExecutionReceipt receipt);
    LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence);
    void AddTrace(LocalExecutionReceipt receipt);
}
