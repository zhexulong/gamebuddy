using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Handlers;

internal sealed class ResourceToolActionHandler : IFarmhandActionHandler
{
    private readonly ExecutionManager executions;

    public ResourceToolActionHandler(ExecutionManager executions)
    {
        this.executions = executions ?? throw new ArgumentNullException(nameof(executions));
    }

    public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        return request.Action switch
        {
            "equip_tool" => this.executions.RequestLocalEquipTool(
                request.RequestId,
                request.Args.Tool),

            "clear_debris" => this.executions.RequestLocalClearDebris(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "chop_tree_source" => this.executions.RequestLocalChopTreeSource(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "chop_stump" => this.executions.RequestLocalChopStump(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "cut_weeds" => this.executions.RequestLocalCutWeeds(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "cut_grass" => this.executions.RequestLocalCutGrass(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "toggle_fence_gate" => this.executions.RequestLocalToggleFenceGate(
                request.RequestId,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "clear_cask" => this.executions.RequestLocalClearCask(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "dress_mannequin" => this.executions.RequestLocalDressMannequin(request.RequestId, request.Args.Slot ?? 0, (int)(request.Args.X ?? 0), (int)(request.Args.Y ?? 0), request.Args.ExpectedTargetId ?? string.Empty, request.DeadlineMs),
            "set_sign_display" => this.executions.RequestLocalSetSignDisplay(request.RequestId, request.Args.Slot ?? 0, (int)(request.Args.X ?? 0), (int)(request.Args.Y ?? 0), request.Args.ExpectedTargetId ?? string.Empty, request.DeadlineMs),
            "deposit_silo_hay" => this.executions.RequestLocalDepositSiloHay(request.RequestId, request.Args.Slot ?? 0, (int)(request.Args.X ?? 0), (int)(request.Args.Y ?? 0), request.Args.ExpectedTargetId ?? string.Empty, request.DeadlineMs),
            "withdraw_silo_hay" => this.executions.RequestLocalWithdrawSiloHay(request.RequestId, (int)(request.Args.X ?? 0), (int)(request.Args.Y ?? 0), request.Args.ExpectedTargetId ?? string.Empty, request.DeadlineMs),
            "toggle_tool_light" => this.executions.RequestLocalToggleToolLight(request.RequestId, request.Args.Slot ?? 0, (int)(request.Args.X ?? 0), (int)(request.Args.Y ?? 0), request.DeadlineMs),

            "break_rock_source" => this.executions.RequestLocalBreakRockSource(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "dig_artifact_spot" => this.executions.RequestLocalDigArtifactSpot(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "refill_watering_can" => this.executions.RequestLocalRefillWateringCan(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "place_wood_fence" => this.executions.RequestLocalPlaceWoodFence(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedQualifiedItemId ?? string.Empty,
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "place_crab_pot" => this.executions.RequestLocalPlaceCrabPot(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedQualifiedItemId ?? string.Empty,
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "bait_crab_pot" => this.executions.RequestLocalBaitCrabPot(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedQualifiedItemId ?? string.Empty,
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            _ => new LocalExecutionReceipt(Guid.NewGuid().ToString("N"), request.RequestId, ExecutionState.Blocked, "unsupported_action", ledger.CurrentRevision, null),
        };
    }
}
