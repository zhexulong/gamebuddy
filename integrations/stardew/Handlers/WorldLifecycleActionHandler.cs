using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Handlers;

/// <summary>
/// Handler for the cross-day lifecycle action. The dispatch is deliberately a
/// single non-blocking admission: the night is an owned multi-frame execution
/// that the ordinary game-thread update advances, because a save and a day
/// transition cannot be observed inside one <c>Execute</c> call.
/// </summary>
internal sealed class WorldLifecycleActionHandler : IFarmhandActionHandler
{
    private readonly ExecutionManager executions;

    public WorldLifecycleActionHandler(ExecutionManager executions)
    {
        this.executions = executions ?? throw new ArgumentNullException(nameof(executions));
    }

    public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(ledger);

        return request.Action switch
        {
            "advance_day" => this.executions.RequestLocalAdvanceDay(request.RequestId, request.DeadlineMs),
            "accept_daily_quest" => this.executions.RequestLocalAcceptDailyQuest(request.RequestId, request.Args.ExpectedTargetId!, request.DeadlineMs),
            "accept_special_order" => this.executions.RequestLocalAcceptSpecialOrder(request.RequestId, request.Args.ExpectedTargetId!, request.DeadlineMs),
            "claim_museum_reward" => this.executions.RequestLocalClaimMuseumReward(request.RequestId, request.Args.ExpectedTargetId!, request.DeadlineMs),
            "redeem_prize_ticket" => this.executions.RequestLocalRedeemPrizeTicket(request.RequestId, request.DeadlineMs),
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
