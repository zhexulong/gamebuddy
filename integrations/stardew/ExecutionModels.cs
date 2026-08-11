using Microsoft.Xna.Framework;

namespace GameBuddy.Stardew;

internal enum ExecutionState
{
    Accepted,
    Running,
    MeaningfulProgress,
    Blocked,
    Invalidated,
    Succeeded,
    PartiallySucceeded,
    Failed,
    Cancelled,
    Rejected,
    Expired,
    Uncertain,
}

/// <summary>Bounded, meaningful-only replay correlation record. It never logs
/// every tick: route/body facts are recorded on receipt/state transitions.</summary>
internal sealed record ExecutionTrace(
    long Revision,
    string TimestampUtc,
    string ExecutionId,
    string RequestId,
    long RouteRevision,
    ExecutionState State,
    string ReasonCode,
    string? Location,
    Vector2? ActorTile,
    string? Evidence);

internal sealed record LocalMoveSpec(
    string ExecutionId,
    string RequestId,
    Vector2 TargetTile,
    bool AllowAdjacentArrival,
    long RouteRevision,
    int DeadlineTick,
    long DeadlineMs);

internal sealed record LocalTravelSpec(
    string ExecutionId,
    string RequestId,
    string Action,
    string SourceLocation,
    int SourceX,
    int SourceY,
    string TargetLocation,
    int TargetX,
    int TargetY,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalSoilTillingSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int TargetX,
    int TargetY,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalForagePickupSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int TargetX,
    int TargetY,
    string TargetId,
    string QualifiedItemId,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalItemPickupSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int TargetX,
    int TargetY,
    string TargetId,
    string QualifiedItemId,
    int Stack,
    int InventoryBefore,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalCropWateringSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int TargetX,
    int TargetY,
    string TargetId,
    string CropId,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalCropHarvestingSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int TargetX,
    int TargetY,
    string TargetId,
    string CropId,
    string QualifiedHarvestItemId,
    bool RegrowsAfterHarvest,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalSeedPlantingSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int Slot,
    int TargetX,
    int TargetY,
    string TargetId,
    string QualifiedItemId,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalFertilizerApplicationSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int Slot,
    int TargetX,
    int TargetY,
    string TargetId,
    string QualifiedItemId,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalWoodFencePlacementSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int Slot,
    int TargetX,
    int TargetY,
    string TargetId,
    string QualifiedItemId,
    int InventoryBefore,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalCrabPotPlacementSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int Slot,
    int TargetX,
    int TargetY,
    string TargetId,
    string QualifiedItemId,
    int InventoryBefore,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalDebrisClearingSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int Slot,
    int TargetX,
    int TargetY,
    string TargetId,
    int ParentSheetIndex,
    float HealthBefore,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalMachineInspectionSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int TargetX,
    int TargetY,
    string TargetId,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalNpcRelationshipInspectionSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int TargetX,
    int TargetY,
    string TargetId,
    string NpcName,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalPettingSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int TargetX,
    int TargetY,
    string TargetId,
    string PetIdentity,
    int FriendshipBefore,
    int ExpectedFriendshipAfter,
    int PetDay,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalFeedTroughSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int Slot,
    int TargetX,
    int TargetY,
    string TargetId,
    int HayStackBefore,
    int PreviousSlot,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalAnimalProductCollectionSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int Slot,
    int TargetX,
    int TargetY,
    string TargetId,
    long AnimalId,
    string AnimalType,
    string QualifiedProduceItemId,
    string ToolKind,
    int ProduceStack,
    int InventoryBefore,
    int PreviousSlot,
    long RouteRevision,
    long DeadlineMs,
    ExecutionState? DeferredTerminalState = null,
    string? DeferredTerminalReason = null);

internal sealed record LocalItemUseSpec(
    string ExecutionId,
    string RequestId,
    int Slot,
    string QualifiedItemId,
    int StackBefore,
    int Edibility,
    bool IsDrink,
    float StaminaBefore,
    int HealthBefore,
    long RouteRevision,
    long DeadlineMs,
    ExecutionState? DeferredTerminalState = null,
    string? DeferredTerminalReason = null);

internal static class ExecutionStateWire
{
    internal static string ToWireValue(this ExecutionState state) => state switch
    {
        ExecutionState.Accepted => "accepted",
        ExecutionState.Running => "running",
        ExecutionState.MeaningfulProgress => "meaningful_progress",
        ExecutionState.Blocked => "blocked",
        ExecutionState.Invalidated => "invalidated",
        ExecutionState.Succeeded => "succeeded",
        ExecutionState.PartiallySucceeded => "partially_succeeded",
        ExecutionState.Failed => "failed",
        ExecutionState.Cancelled => "cancelled",
        ExecutionState.Rejected => "rejected",
        ExecutionState.Expired => "expired",
        ExecutionState.Uncertain => "uncertain",
        _ => throw new ArgumentOutOfRangeException(nameof(state), state, "Unknown execution state."),
    };
}

internal sealed record LocalExecutionReceipt(
    string ExecutionId,
    string RequestId,
    ExecutionState State,
    string ReasonCode,
    long Revision,
    string? Evidence);
