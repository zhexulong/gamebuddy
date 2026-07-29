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
    long RouteRevision,
    int DeadlineTick,
    long DeadlineMs);

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
