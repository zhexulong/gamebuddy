using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;

namespace GameBuddy.Stardew.Handlers;

internal sealed class FarmingActionHandler : IFarmhandActionHandler
{
    private readonly ExecutionManager executions;

    public FarmingActionHandler(ExecutionManager executions)
    {
        this.executions = executions ?? throw new ArgumentNullException(nameof(executions));
    }

    public IReadOnlyCollection<string> SupportedActions { get; } = new[]
    {
        "till_soil",
        "water_crop",
        "plant_seed",
        "fertilize_tile",
        "harvest_crop",
        "clear_hoedirt",
    };

    public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        return request.Action switch
        {
            "till_soil" => this.executions.RequestLocalTillSoil(
                request.RequestId,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.DeadlineMs),

            "water_crop" => this.executions.RequestLocalWaterCrop(
                request.RequestId,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "plant_seed" => this.executions.RequestLocalPlantSeed(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedQualifiedItemId ?? string.Empty,
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "fertilize_tile" => this.executions.RequestLocalFertilizeTile(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedQualifiedItemId ?? string.Empty,
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "harvest_crop" => this.executions.RequestLocalHarvestCrop(
                request.RequestId,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedQualifiedItemId ?? string.Empty,
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "clear_hoedirt" => this.executions.RequestLocalClearHoeDirt(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            _ => new LocalExecutionReceipt(Guid.NewGuid().ToString("N"), request.RequestId, ExecutionState.Blocked, "unsupported_action", ledger.CurrentRevision, null),
        };
    }
}
