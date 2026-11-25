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
    internal const string SaveLoadedSpanName = "mod.lifecycle.save_loaded";
    internal const string SavingSpanName = "mod.lifecycle.saving";
    internal const string SavedSpanName = "mod.lifecycle.saved";
    internal const string ReturnedToTitleSpanName = "mod.lifecycle.returned_to_title";

    /// <summary>
    /// The engine's own lifecycle edges, in the order a session meets them. Each is written as an INSTANT event:
    /// it marks when the edge happened and claims no duration, so no reader can take it for something that was
    /// still running when the process ended.
    /// </summary>
    internal static readonly string[] LifecycleSpanNames =
    {
        SaveLoadedSpanName,
        SavingSpanName,
        SavedSpanName,
        ReturnedToTitleSpanName,
    };

    private static readonly HashSet<string> InstantSpanNames = new(LifecycleSpanNames, StringComparer.Ordinal);

    private static Activity? heldTickGate;

    /// <summary>
    /// Whether a span marks a moment rather than an interval. The recorder asks this, and it is derived from
    /// <see cref="LifecycleSpanNames" /> so the writer and the trace cannot disagree about a span's shape.
    /// </summary>
    internal static bool IsInstantSpan(string name) => InstantSpanNames.Contains(name);

    /// <summary>
    /// One engine lifecycle edge, as an instant event: the same envelope as every other span, with no duration.
    /// </summary>
    /// <remarks>
    /// The Player Host's only surviving per-run record is this file (<c>.tmp/lane-whycrah.md</c> §1: the game's
    /// SMAPI log was truncated by a sibling game 7 s after the process ended). Without these edges a run can say
    /// nothing about WHEN its world was saved, went unavailable or was left, which is exactly the question a death
    /// during a save raises. Measured 2026-11-26: the last advertisement the Mod served was stamped 1.3 s before
    /// the trace's last flush, and "a save began and never finished" was the remaining candidate with no
    /// instrument to settle it.
    /// </remarks>
    internal static void NoteLifecycleEdge(string spanName)
    {
        Activity? span = ModActivitySource.Source.StartActivity(spanName);
        span?.Stop();
    }

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
