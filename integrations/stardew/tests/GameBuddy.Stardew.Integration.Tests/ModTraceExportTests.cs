using System.Diagnostics;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Diagnostics;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The run's trace is the authoritative timing record, so it must be a document Perfetto can open and it must
/// carry the identity the grep lines already report.
///
/// The failure this replaces: a night's freeze was reconstructed from the SMAPI log, the stalled-tick file and
/// the bridge's own log, and none of the three said how long the step before the freeze had been running. The
/// exporter is therefore held to the format here - <c>ph: "X"</c>, microsecond <c>ts</c>/<c>dur</c>, nested
/// spans from one process - and the publish span is held to the same receipt the marker line names.
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class ModTraceExportTests
{
    private const string RepositoryRelativeRoot = "../../../../../../../";

    [Fact]
    public void ThreeNestedSpansAreWrittenAsPerfettoSlices()
    {
        using TraceDirectory directory = new();
        using ModTraceRecorder recorder = new(directory.Path, "nested", monitor: null);
        BridgeExecutionRequest request = new("req_nested", "idem_nested", "trace_probe_action", new BridgeExecutionArgs(), 1, 5000);
        LocalExecutionReceipt receipt = new("exec_nested", "req_nested", ExecutionState.Succeeded, "trace_probe_settled", 7, null);
        {
            // Declared outermost first, so disposal stops them innermost first and the spans nest.
            using Activity dispatch = ModTrace.StartBridgeDispatch("execution_request", "corr_nested")!;
            Thread.Sleep(2);
            using Activity execute = ModActivitySource.StartActionExecution(request, "exec_nested")!;
            Thread.Sleep(2);
            using Activity publish = ModTrace.StartReceiptPublish(receipt)!;
            Thread.Sleep(2);
        }
        recorder.Flush();

        JsonElement[] events = ReadEvents(recorder.FilePath);
        JsonElement dispatchSpan = Find(events, ModTrace.DispatchSpanName);
        JsonElement executeSpan = Find(events, ModActivitySource.ActionExecutionSpanName("trace_probe_action"));
        JsonElement publishSpan = Find(events, ModTrace.ReceiptPublishSpanName);

        foreach (JsonElement span in new[] { dispatchSpan, executeSpan, publishSpan })
        {
            span.GetProperty("ph").GetString().Should().Be("X", "a finished span is a complete Perfetto slice");
            span.GetProperty("dur").GetInt64().Should().BeGreaterThan(0, "the durations are microsecond integers");
            span.GetProperty("pid").GetInt32().Should().Be(Environment.ProcessId);
        }

        long dispatchStart = dispatchSpan.GetProperty("ts").GetInt64();
        long dispatchEnd = dispatchStart + dispatchSpan.GetProperty("dur").GetInt64();
        long executeStart = executeSpan.GetProperty("ts").GetInt64();
        long executeEnd = executeStart + executeSpan.GetProperty("dur").GetInt64();
        long publishStart = publishSpan.GetProperty("ts").GetInt64();
        long publishEnd = publishStart + publishSpan.GetProperty("dur").GetInt64();
        dispatchSpan.GetProperty("tid").GetInt32().Should().Be(executeSpan.GetProperty("tid").GetInt32());
        executeStart.Should().BeGreaterOrEqualTo(dispatchStart);
        executeEnd.Should().BeLessOrEqualTo(dispatchEnd);
        publishStart.Should().BeGreaterOrEqualTo(executeStart);
        publishEnd.Should().BeLessOrEqualTo(executeEnd);

        JsonElement publishArguments = publishSpan.GetProperty("args");
        publishArguments.GetProperty("requestId").GetString().Should().Be("req_nested");
        publishArguments.GetProperty("executionId").GetString().Should().Be("exec_nested");
        publishArguments.GetProperty("revision").GetInt64().Should().Be(7);
    }

    [Fact]
    public void ThePublishSpanAndTheMarkerLineReportTheSameReceiptIdentity()
    {
        LocalExecutionReceipt receipt = new("exec_publish", "req_publish", ExecutionState.Succeeded, "crop_harvested", 41, null);
        using TraceDirectory directory = new();
        using ModTraceRecorder recorder = new(directory.Path, "publish", monitor: null);
        using (ModTrace.StartReceiptPublish(receipt))
        {
            // Left OPEN on purpose: that is what a frozen night leaves behind, and it still has to name the
            // receipt it was publishing when the lane stopped.
            recorder.Flush();
            JsonElement span = Find(ReadEvents(recorder.FilePath), ModTrace.ReceiptPublishSpanName);
            JsonElement arguments = span.GetProperty("args");
            arguments.GetProperty("inProgress").GetBoolean().Should().BeTrue();

            string markerLine = ModTrace.ReceiptPublishLogLine(receipt);
            markerLine.Should().Be(
                "[receipt-publish-marker] request=req_publish;state=Succeeded;reason=crop_harvested;revision=41",
                "the grep line keeps its exact shape");
            arguments.GetProperty("requestId").GetString().Should().Be("req_publish");
            arguments.GetProperty("executionId").GetString().Should().Be("exec_publish");
            arguments.GetProperty("revision").GetInt64().Should().Be(41);
        }
    }

    [Fact]
    public void TheProductionCallSitesEmitTheseSpans()
    {
        FunnelBody(ReadRepositoryFile("integrations/stardew/farmhandexecutioncontroller.cs"))
            .Should()
            .Contain("ModTrace.StartReceiptPublish(published)")
            .And.Contain("ModTrace.ReceiptPublishLogLine(published)");
        ReadRepositoryFile("integrations/stardew/src/Core/Routing/FarmhandActionRouter.cs")
            .Should()
            .Contain("ModActivitySource.StartActionExecution(request, executionId)");
        string modEntry = ReadRepositoryFile("integrations/stardew/ModEntry.cs");
        modEntry.Should().Contain("ModTrace.StartBridgeDispatch(").And.Contain("ModTrace.NoteTickGatePassed();");
        // One trace per run, written where the SMAPI log is.
        modEntry.Should().Contain("Constants.LogDir");
        ReadRepositoryFile("integrations/stardew/ModEntry.Instrumentation.cs")
            .Should()
            .Contain("ModTrace.NoteTickGateHeld(reason);");
    }

    private static JsonElement[] ReadEvents(string path)
    {
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
        document.RootElement.TryGetProperty("traceEvents", out JsonElement traceEvents)
            .Should()
            .BeTrue("a Chrome trace carries its slices under traceEvents");
        return traceEvents.EnumerateArray().Select(span => span.Clone()).ToArray();
    }

    private static JsonElement Find(JsonElement[] events, string name) =>
        events.Single(span => span.GetProperty("name").GetString() == name);

    private static string ReadRepositoryFile(params string[] segments) =>
        File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, Path.Combine(segments))));

    private static string FunnelBody(string controllerSource)
    {
        int start = controllerSource.IndexOf("private LocalExecutionReceipt AddTrace(LocalExecutionReceipt receipt)", StringComparison.Ordinal);
        start.Should().BeGreaterThan(0, "the one delivery funnel must exist");
        int end = controllerSource.IndexOf("\n    }\n", start, StringComparison.Ordinal);
        end.Should().BeGreaterThan(start);
        return controllerSource[start..end];
    }

    private sealed class TraceDirectory : IDisposable
    {
        internal TraceDirectory() =>
            this.Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "gamebuddy-trace-" + Guid.NewGuid().ToString("N"));

        internal string Path { get; }

        public void Dispose()
        {
            if (Directory.Exists(this.Path))
                Directory.Delete(this.Path, recursive: true);
        }
    }
}
