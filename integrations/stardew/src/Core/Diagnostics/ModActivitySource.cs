using System.Diagnostics;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.Diagnostics;

/// <summary>
/// The one ActivitySource every Mod span is created from, so a single listener in the Mod
/// (<c>ModTraceRecorder</c>) sees the whole lane: the Core router's action execution and the
/// Mod's bridge dispatch, tick gate and receipt publish.
/// </summary>
/// <remarks>
/// The source lives in Core because the action router is Core-owned, and no span is created
/// unless a listener is attached, so a run without the recorder pays nothing for the calls.
/// </remarks>
public static class ModActivitySource
{
    public const string Name = "GameBuddy.Stardew.Mod";

    public static ActivitySource Source { get; } = new(Name, "1.0.0");

    /// <summary>The span name of one native action execution, so a reader and the router agree on it.</summary>
    public static string ActionExecutionSpanName(string actionId) => "mod.execute." + actionId;

    /// <summary>
    /// Opens <c>mod.execute.&lt;actionId&gt;</c> for one native handler invocation. The receipt
    /// revision is recorded by the caller once the handler has minted it.
    /// </summary>
    public static Activity? StartActionExecution(BridgeExecutionRequest request, string? executionId)
    {
        Activity? span = Source.StartActivity(ActionExecutionSpanName(request.Action));
        if (span is null)
            return null;
        span.SetTag("actionId", request.Action);
        span.SetTag("requestId", request.RequestId);
        if (executionId is not null)
            span.SetTag("executionId", executionId);
        return span;
    }
}
