using System.Diagnostics;
using GameBuddy.Stardew.Core.Diagnostics;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew;

/// <summary>
/// The Mod's own spans. All of them ride the one <see cref="ModActivitySource"/>, and they are
/// created only while <see cref="ModTraceRecorder"/> is listening, so a run without a recorder
/// costs the call sites a null check.
/// </summary>
internal static class ModTrace
{
    internal const string DispatchSpanName = "mod.dispatch";
    internal const string TickGateSpanName = "mod.tick.gate";
    internal const string ReceiptPublishSpanName = "mod.bridge.publish_receipt";

    private static Activity? heldTickGate;

    /// <summary>One inbound bridge frame, from the type switch to the response it produced.</summary>
    internal static Activity? StartBridgeDispatch(string? messageType, string? correlationId)
    {
        Activity? span = ModActivitySource.Source.StartActivity(DispatchSpanName);
        if (span is null)
            return null;
        span.SetTag("type", messageType ?? "unknown");
        if (!string.IsNullOrEmpty(correlationId))
            span.SetTag("correlationId", correlationId);
        return span;
    }

    /// <summary>
    /// The gate currently holding the fixture tick. It stays open across ticks on purpose: it is
    /// the span that answers "which gate, and for how long", and a gate that never releases leaves
    /// the only in-flight span of the trace, which the recorder writes as in-progress.
    /// </summary>
    internal static void NoteTickGateHeld(string reason)
    {
        heldTickGate ??= ModActivitySource.Source.StartActivity(TickGateSpanName);
        heldTickGate?.SetTag("held", reason);
    }

    internal static void NoteTickGatePassed()
    {
        Activity? gate = heldTickGate;
        heldTickGate = null;
        gate?.Stop();
    }

    internal static Activity? StartReceiptPublish(LocalExecutionReceipt published)
    {
        Activity? span = ModActivitySource.Source.StartActivity(ReceiptPublishSpanName);
        if (span is null)
            return null;
        span.SetTag("requestId", published.RequestId);
        span.SetTag("executionId", published.ExecutionId);
        span.SetTag("revision", published.Revision);
        span.SetTag("state", published.State.ToString());
        span.SetTag("reason", published.ReasonCode);
        return span;
    }

    /// <summary>
    /// The publish span's identity and the grep line are formatted from the same receipt, so the
    /// two can never disagree about which request a published revision belongs to.
    /// </summary>
    internal static string ReceiptPublishLogLine(LocalExecutionReceipt published) =>
        $"[receipt-publish-marker] request={published.RequestId};state={published.State};reason={published.ReasonCode};revision={published.Revision}";
}
