using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    private static (ExecutionState State, string ReasonCode) PostconditionVerdict(
        bool observed,
        string observedCode,
        string unobservedCode) =>
        observed
            ? (ExecutionState.Succeeded, observedCode)
            : (ExecutionState.Uncertain, unobservedCode);

    private LocalExecutionReceipt SettlePostcondition(
        string requestId,
        string executionId,
        bool observed,
        string observedCode,
        string unobservedCode,
        string? evidence)
    {
        (ExecutionState state, string reasonCode) = PostconditionVerdict(observed, observedCode, unobservedCode);
        return this.RememberTerminal(requestId, executionId, state, reasonCode, evidence);
    }
}
