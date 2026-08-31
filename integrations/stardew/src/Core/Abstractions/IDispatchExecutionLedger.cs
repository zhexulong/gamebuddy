using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.Abstractions;

/// <summary>
/// Optional dispatch seam for a caller that has already minted one execution
/// identity for a native action lineage. The binding is immutable and must be
/// established before a handler can start a native body.
/// </summary>
public interface IDispatchExecutionLedger
{
    bool TryBindDispatch(string requestId, string actionId, string executionId, out string reasonCode);


    bool TryGetBoundExecutionId(string requestId, out string executionId);
}
