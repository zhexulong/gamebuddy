using System.Text.Json;
using System.Text.RegularExpressions;

namespace GameBuddy.Desktop;

/// <summary>
/// The launcher's own fact about a Host child it had to terminate: the child outlived the exit
/// deadline it published in its bootstrap acknowledgement.
///
/// It is a DIAGNOSTIC, not product state, and it lives beside the child's own exit records
/// (<c>&lt;operationalRoot&gt;\host-exit</c>) because that is the one directory an operator already
/// reads after an exit that did not go well. The two facts have two owners and two schemas: the child
/// names its own failed steps (<c>gamebuddy-desktop-host-exit-record/v1</c>), and this names the
/// launcher's own kill (<c>gamebuddy-desktop-host-teardown/v1</c>) with what the launcher waited and
/// what the child had reported before the watch expired.
///
/// Every field is a bounded token or a number by construction: no path, no bridge credential, no
/// player text and no stack, so it can be handed to an operator without a second redaction pass. A
/// record that cannot be written is never allowed to become a second failure of the exit it
/// describes, so nothing here throws.
/// </summary>
internal static class DesktopHostTeardownRecord
{
    internal const string Schema = "gamebuddy-desktop-host-teardown/v1";
    internal const string TimeoutOutcome = "host_teardown_timeout";

    // The child's own diagnostic, in the directory it writes and this reads back.
    internal const string HostExitRecordDirectory = "host-exit";
    internal const string HostExitRecordSchema = "gamebuddy-desktop-host-exit-record/v1";

    /// <summary>
    /// The one shape a reason, a step name or a failure code may have: a bounded lowercase token.
    /// A value that is not already one of those is dropped rather than copied.
    /// </summary>
    private static readonly Regex BoundedToken = new("^[a-z][a-z0-9_.:-]{1,159}$", RegexOptions.CultureInvariant);

    private static readonly JsonSerializerOptions RecordShape = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    /// <summary>One step as the child reported it, kept only in the shape the record may carry.</summary>
    private readonly record struct ReportedStep(string Step, string Status, string? Failure);

    /// <summary>
    /// Records that this launcher terminated the child after waiting <paramref name="elapsedMs"/> for
    /// it, against the <paramref name="drainDeadlineMs"/> the child itself declared, and carries the
    /// steps the child had reported by then - if it got as far as writing them.
    /// </summary>
    internal static void Write(string operationalRoot, uint pid, long elapsedMs, long drainDeadlineMs)
    {
        try
        {
            var directory = Path.Combine(operationalRoot, HostExitRecordDirectory);
            Directory.CreateDirectory(directory);
            var recordedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var record = new
            {
                schema = Schema,
                version = 1,
                outcome = TimeoutOutcome,
                elapsedMs,
                drainDeadlineMs,
                pid,
                recordedAtUnixMs,
                steps = HostReportedSteps(directory, pid),
            };
            var stamp = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH-mm-ss-fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
            File.WriteAllText(Path.Combine(directory, $"host-teardown-{stamp}-{pid}.json"), JsonSerializer.Serialize(record, RecordShape) + "\n");
        }
        catch
        {
            // A diagnostic that cannot be written is never a second failure of the exit it describes.
        }
    }

    /// <summary>
    /// The steps the child itself reported for this exact process, if it wrote its own record before
    /// the watch expired - the newest one when there is more than one. An absent, unreadable or
    /// foreign record is an empty list, never an error: most kills happen before the child wrote
    /// anything at all.
    /// </summary>
    private static IReadOnlyList<ReportedStep> HostReportedSteps(string directory, uint pid)
    {
        var reported = new List<ReportedStep>();
        string? newest = null;
        foreach (var path in Directory.EnumerateFiles(directory, $"host-exit-*-{pid}.json"))
        {
            if (newest is null || string.CompareOrdinal(Path.GetFileName(path), Path.GetFileName(newest)) > 0) newest = path;
        }
        if (newest is null) return reported;
        using var document = JsonDocument.Parse(File.ReadAllBytes(newest));
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object ||
            !root.TryGetProperty("schema", out var schema) || schema.GetString() != HostExitRecordSchema ||
            !root.TryGetProperty("steps", out var steps) || steps.ValueKind != JsonValueKind.Array) return reported;
        foreach (var step in steps.EnumerateArray())
        {
            if (step.ValueKind != JsonValueKind.Object) continue;
            var reportedStep = ReadToken(step, "step");
            var status = ReadToken(step, "status");
            if (reportedStep is null || status is null) continue;
            reported.Add(new ReportedStep(reportedStep, status, ReadToken(step, "failure")));
        }
        return reported;
    }

    private static string? ReadToken(JsonElement value, string name) =>
        value.TryGetProperty(name, out var property) &&
        property.ValueKind == JsonValueKind.String &&
        property.GetString() is { } token &&
        BoundedToken.IsMatch(token)
            ? token
            : null;
}
