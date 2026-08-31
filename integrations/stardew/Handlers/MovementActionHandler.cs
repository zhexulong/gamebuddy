using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Microsoft.Xna.Framework;

namespace GameBuddy.Stardew.Handlers;

internal sealed class MovementActionHandler : IFarmhandActionHandler
{
    private readonly ExecutionManager executions;

    public MovementActionHandler(ExecutionManager executions)
    {
        this.executions = executions ?? throw new ArgumentNullException(nameof(executions));
    }

    public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        return request.Action switch
        {
            "move_to_tile" => this.executions.RequestLocalMove(
                request.RequestId,
                new Vector2(request.Args.X ?? 0, request.Args.Y ?? 0),
                request.DeadlineMs),

            "travel" => this.executions.RequestLocalTravel(
                request.RequestId,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.DeadlineMs),

            "enter_exit" => this.executions.RequestLocalEnterExit(
                request.RequestId,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.DeadlineMs),

            "navigate_to_destination" => this.Navigate(request, ledger),

            _ => new LocalExecutionReceipt(Guid.NewGuid().ToString("N"), request.RequestId, ExecutionState.Blocked, "unsupported_action", ledger.CurrentRevision, null),
        };
    }

    private LocalExecutionReceipt Navigate(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        if (!NavigationDestinationSelector.TryCreateFromWire(request.Args.Destination, out NavigationDestinationSelector? selector) || selector is null)
        {
            string executionId = ledger is IDispatchExecutionLedger dispatchLedger
                && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
                ? boundExecutionId
                : Guid.NewGuid().ToString("N");
            return new LocalExecutionReceipt(executionId, request.RequestId, ExecutionState.Rejected, "destination_selector_invalid", this.executions.CurrentRevision, null);
        }
        return this.executions.RequestNavigate(request.RequestId, selector, request.DeadlineMs);
    }
}
