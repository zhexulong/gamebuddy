using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using GameBuddy.Stardew.Core.Diagnostics;
using StardewModdingAPI;

namespace GameBuddy.Stardew;

/// <summary>
/// Writes one Chrome-trace (Perfetto-importable) file per game run next to the SMAPI log.
///
/// It is the authoritative timing record of the Mod lane: the log lines say WHAT happened and
/// stay greppable, while this file says when each span started, how long it took and which
/// receipt it published. A run whose tick stopped returning used to be reconstructed from three
/// different files; the span that never ended is here as an in-progress event.
///
/// The writer runs on a timer thread, never on the tick, for the same reason the stalled-tick
/// report does: the lane it observes may be exactly the one that stopped.
/// </summary>
internal sealed class ModTraceRecorder : IDisposable
{
    private const int FlushPeriodMs = 2_000;
    private const int MaximumRecordedSpans = 50_000;

    private readonly IMonitor? monitor;
    private readonly string runId;
    private readonly string path;
    private readonly object gate = new();
    private readonly object writeGate = new();
    private readonly List<TraceEvent> spans = new();
    private readonly Dictionary<string, TraceEvent> openSpans = new(StringComparer.Ordinal);
    private readonly ActivityListener listener;
    private readonly Timer flushTimer;
    private bool writeFailureReported;

    internal ModTraceRecorder(string directory, string runId, IMonitor? monitor)
    {
        ArgumentNullException.ThrowIfNull(directory);
        ArgumentNullException.ThrowIfNull(runId);
        Directory.CreateDirectory(directory);
        this.monitor = monitor;
        this.runId = runId;
        this.path = Path.Combine(directory, "gamebuddy-trace-" + runId + ".json");
        this.listener = new ActivityListener
        {
            ShouldListenTo = source => string.Equals(source.Name, ModActivitySource.Name, StringComparison.Ordinal),
            Sample = (ref ActivityCreationOptions<ActivityContext> options) => ActivitySamplingResult.AllDataAndRecorded,
            SampleUsingParentId = (ref ActivityCreationOptions<string> options) => ActivitySamplingResult.AllDataAndRecorded,
            ActivityStarted = this.OnActivityStarted,
            ActivityStopped = this.OnActivityStopped,
        };
        ActivitySource.AddActivityListener(this.listener);
        this.flushTimer = new Timer(_ => this.Flush(), null, FlushPeriodMs, FlushPeriodMs);
    }

    internal string FilePath => this.path;

    /// <summary>
    /// Rewrites the whole file from what has been recorded so far. A span still open is written
    /// with the duration it has reached, which is how a frozen tick shows up as the growing last
    /// event of the trace.
    /// </summary>
    internal void Flush()
    {
        lock (this.writeGate)
        {
            try
            {
                string json;
                lock (this.gate)
                    json = this.SerializeLocked();
                // Staged then moved: a reader (or a killed process) never sees half a document.
                string staging = this.path + ".staging";
                File.WriteAllText(staging, json);
                File.Move(staging, this.path, overwrite: true);
            }
            catch (Exception exception)
            {
                // A timer callback may not throw: this is a diagnostic writer, and taking the game down with it
                // would be worse than losing the trace.
                this.ReportWriteFailure(exception);
            }
        }
    }

    public void Dispose()
    {
        this.flushTimer.Dispose();
        this.listener.Dispose();
        this.Flush();
        GC.SuppressFinalize(this);
    }

    private void OnActivityStarted(Activity activity)
    {
        lock (this.gate)
        {
            if (this.spans.Count >= MaximumRecordedSpans)
                return;
            TraceEvent span = new()
            {
                Name = activity.OperationName,
                StartMicroseconds = ToMicroseconds(activity.StartTimeUtc),
                ThreadId = Environment.CurrentManagedThreadId,
                Live = activity,
            };
            this.spans.Add(span);
            this.openSpans[activity.SpanId.ToHexString()] = span;
        }
    }

    private void OnActivityStopped(Activity activity)
    {
        Dictionary<string, object?> arguments = CollectArguments(activity);
        string spanId = activity.SpanId.ToHexString();
        lock (this.gate)
        {
            if (!this.openSpans.Remove(spanId, out TraceEvent? span))
                return;
            span.DurationMicroseconds = ToMicroseconds(activity.Duration);
            span.Arguments = arguments;
            span.Live = null;
        }
    }

    private static Dictionary<string, object?> CollectArguments(Activity activity)
    {
        Dictionary<string, object?> arguments = new(StringComparer.Ordinal);
        foreach (KeyValuePair<string, object?> tag in activity.TagObjects)
            arguments[tag.Key] = tag.Value;
        return arguments;
    }

    private string SerializeLocked()
    {
        long nowMicroseconds = ToMicroseconds(DateTimeOffset.UtcNow);
        using MemoryStream buffer = new();
        using (Utf8JsonWriter writer = new(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("displayTimeUnit", "ms");
            writer.WriteStartObject("otherData");
            writer.WriteString("source", ModActivitySource.Name);
            writer.WriteString("runId", this.runId);
            writer.WriteEndObject();
            writer.WriteStartArray("traceEvents");
            foreach (TraceEvent span in this.spans)
            {
                writer.WriteStartObject();
                writer.WriteString("name", span.Name);
                writer.WriteString("ph", "X");
                writer.WriteNumber("ts", span.StartMicroseconds);
                writer.WriteNumber("dur", span.DurationMicroseconds ?? nowMicroseconds - span.StartMicroseconds);
                writer.WriteNumber("pid", Environment.ProcessId);
                writer.WriteNumber("tid", span.ThreadId);
                writer.WriteString("cat", "mod");
                writer.WriteStartObject("args");
                // An open span reads its tags live, so the span that never ended still names the receipt it was
                // publishing when the lane stopped - the one fact a frozen trace has to carry.
                Dictionary<string, object?> arguments = span.DurationMicroseconds is null && span.Live is not null
                    ? CollectArguments(span.Live)
                    : span.Arguments;
                foreach (KeyValuePair<string, object?> argument in arguments)
                    WriteArgument(writer, argument.Key, argument.Value);
                if (span.DurationMicroseconds is null)
                    writer.WriteBoolean("inProgress", true);
                writer.WriteEndObject();
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    private static void WriteArgument(Utf8JsonWriter writer, string name, object? value)
    {
        switch (value)
        {
            case long number:
                writer.WriteNumber(name, number);
                break;
            case int number:
                writer.WriteNumber(name, number);
                break;
            default:
                writer.WriteString(name, Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty);
                break;
        }
    }

    private void ReportWriteFailure(Exception exception)
    {
        if (this.writeFailureReported)
            return;
        this.writeFailureReported = true;
        this.monitor?.Log($"GameBuddy could not write its span trace: {exception.GetType().Name}.", LogLevel.Warn);
    }

    private static long ToMicroseconds(DateTimeOffset instant) =>
        (instant.UtcTicks - DateTimeOffset.UnixEpoch.UtcTicks) / 10L;

    private static long ToMicroseconds(TimeSpan duration) => duration.Ticks / 10L;

    private sealed class TraceEvent
    {
        internal string Name = string.Empty;
        internal long StartMicroseconds;
        internal long? DurationMicroseconds;
        internal int ThreadId;
        internal Activity? Live;
        internal Dictionary<string, object?> Arguments = new(StringComparer.Ordinal);
    }
}
