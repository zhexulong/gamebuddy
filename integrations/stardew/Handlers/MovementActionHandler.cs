using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;

namespace GameBuddy.Stardew.Handlers;

internal sealed class MovementActionHandler : IFarmhandActionHandler
{
    private readonly ExecutionManager executions;

    public MovementActionHandler(ExecutionManager executions)
    {
        this.executions = executions ?? throw new ArgumentNullException(nameof(executions));
    }

    public IReadOnlyCollection<string> SupportedActions { get; } = new[]
    {
        "move_to_tile",
        "travel",
        "enter_exit",
    };

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

            _ => new LocalExecutionReceipt(Guid.NewGuid().ToString("N"), request.RequestId, ExecutionState.Blocked, "unsupported_action", ledger.CurrentRevision, null),
        };
    }
}
