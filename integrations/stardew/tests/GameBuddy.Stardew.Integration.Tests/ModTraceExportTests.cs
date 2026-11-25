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
/// held to the format here - <c>ph: "X"</c> with microsecond <c>ts</c>/<c>dur</c> for an interval, and
/// <c>ph: "i"</c> with no <c>dur</c> at all for a moment - and the publish span is held to the same receipt the
/// marker line names.
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

    /// <summary>
    /// The engine's lifecycle edges are INSTANT events, and the tick-gate span closes on the production lane.
    ///
    /// Measured 2026-11-26 (`.tmp/lane-whycrah.md` §4): a Player Host's only surviving per-run record is its trace,
    /// and that trace held ONE event - `mod.tick.gate`, `dur = 11273932` µs, `inProgress = true` - because the only
    /// call that ever closed the gate span sat inside the native-local fixture block, which a production lane never
    /// enters. Read as written, the trace said a gate held for the run's whole life on a lane that was serving a
    /// `ready` advertisement. A record that lies about the run's whole life is worse than no record, so:
    ///
    ///   - the four engine edges (SaveLoaded/Saving/Saved/ReturnedToTitle) are written as instants, which claim no
    ///     duration and therefore cannot be read as a hold;
    ///   - the gate span is closed where both lanes pass every gate they can enter, so a production tick closes the
    ///     span an earlier tick opened.
    /// </summary>
    [Fact]
    public void TheEngineLifecycleEdgesAreInstantEventsThatClaimNoDuration()
    {
        using TraceDirectory directory = new();
        using ModTraceRecorder recorder = new(directory.Path, "lifecycle", monitor: null);
        foreach (string spanName in ModTrace.LifecycleSpanNames)
            ModTrace.NoteLifecycleEdge(spanName);
        recorder.Flush();

        JsonElement[] events = ReadEvents(recorder.FilePath);
        foreach (string spanName in ModTrace.LifecycleSpanNames)
        {
            JsonElement edge = Find(events, spanName);
            edge.GetProperty("ph").GetString().Should().Be("i", $"{spanName} marks a moment, not an interval");
            edge.GetProperty("s").GetString().Should().Be("t", "the instant is scoped to the thread that saw the edge");
            edge.TryGetProperty("dur", out _).Should().BeFalse("an instant event that carried a duration could be read as a hold");
            edge.TryGetProperty("args", out JsonElement arguments).Should().BeTrue();
            arguments.TryGetProperty("inProgress", out _).Should().BeFalse("a recorded edge is never in progress");
            edge.GetProperty("pid").GetInt32().Should().Be(Environment.ProcessId);
            edge.GetProperty("cat").GetString().Should().Be("mod", "it travels in the same envelope as every other span");
        }
    }

    // source-invariant: the tick gate span must close BEFORE the fixture-only block, or a production Player Host
    //                   lane - which never enters that block - leaves it open for the role's whole life.
    // source-expiry: delete when the tick handler stops being source-only, i.e. when a headless runner can enter
    //                `OnUpdateTicked`; the behavioural half is `TheEngineLifecycleEdgesAreInstantEventsThatClaimNoDuration`.
    [Fact]
    public void TheTickGateSpanClosesOnTheProductionLane()
    {
        string modEntry = ReadRepositoryFile("integrations/stardew/ModEntry.cs");
        int tick = modEntry.IndexOf("private void OnUpdateTicked(", StringComparison.Ordinal);
        tick.Should().BeGreaterThan(0, "the tick handler is what this invariant is about");
        // The last shared gate (the armed world-creation bootstrap), the close, and the fixture-only block it used to
        // live in. The three positions, in the tick handler, are the whole invariant.
        int sharedGate = modEntry.IndexOf("this.worldCreationBootstrap is { IsArmed: true }", tick, StringComparison.Ordinal);
        int close = modEntry.IndexOf("ModTrace.NoteTickGatePassed();", tick, StringComparison.Ordinal);
        int fixtureLane = modEntry.IndexOf("if (this.config.NativeLocalPlayerFixture?.Enable == true)", tick, StringComparison.Ordinal);
        sharedGate.Should().BeGreaterThan(tick);
        close.Should().BeGreaterThan(tick);
        fixtureLane.Should().BeGreaterThan(tick);
        close.Should().BeGreaterThan(sharedGate, "the close follows the last gate both lanes can enter");
        close.Should().BeLessThan(
            fixtureLane,
            "a close inside the fixture block is the defect: a production Player Host never executes it and the span then claims a hold for the run's whole life");
        modEntry
            .IndexOf("ModTrace.NoteTickGatePassed();", close + 1, StringComparison.Ordinal)
            .Should()
            .Be(-1, "one close: a second one can drift back inside the fixture block and outlive the lane that needed it");
    }

    // source-invariant: each of the engine's four lifecycle events is recorded by the handler the engine calls, so a
    //                   run's trace says WHEN its world was loaded, saved, saved-to-disk and left.
    // source-expiry: delete when the four handlers are constructible in a headless runner (they read `Game1` and
    //                SMAPI's event args), the same reason `FixtureTickGateLivenessTests` reads its population.
    [Fact]
    public void EveryEngineLifecycleEdgeIsRecordedAtItsHandler()
    {
        string modEntry = ReadRepositoryFile("integrations/stardew/ModEntry.cs");
        // By the MEMBER each handler passes (`nameof`), so the pin cannot drift from the declaration it names.
        foreach (
            string member in new[]
            {
                nameof(ModTrace.SaveLoadedSpanName),
                nameof(ModTrace.SavingSpanName),
                nameof(ModTrace.SavedSpanName),
                nameof(ModTrace.ReturnedToTitleSpanName),
            })
            modEntry.Should().Contain($"ModTrace.NoteLifecycleEdge(ModTrace.{member});", $"{member} has no handler emitting it");
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
        // By its declaration, not by its parameter list: the funnel's parameter list grew the producer's own
        // "is this NEWS" answer, which moved the signature and not the funnel.
        int start = controllerSource.IndexOf("private LocalExecutionReceipt AddTrace(", StringComparison.Ordinal);
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
