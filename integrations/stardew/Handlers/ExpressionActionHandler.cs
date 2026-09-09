using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Handlers;

internal sealed class ExpressionActionHandler : IFarmhandActionHandler
{
    private readonly ExecutionManager executions;

    public ExpressionActionHandler(ExecutionManager executions)
    {
        this.executions = executions ?? throw new ArgumentNullException(nameof(executions));
    }

    public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(ledger);

        return request.Action switch
        {
            "express_emote" => this.executions.RequestLocalExpressEmote(request, ledger),
            _ => new LocalExecutionReceipt(
                Guid.NewGuid().ToString("N"),
                request.RequestId,
                ExecutionState.Blocked,
                "unsupported_action",
                ledger.CurrentRevision,
                null),
        };
    }
}
