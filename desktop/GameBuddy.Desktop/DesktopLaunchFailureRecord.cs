using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// The launcher's own record of a launch that failed before it could present anything.
///
/// It is written in the child's own schema and its own directory
/// (<c>&lt;operationalRoot&gt;\host-exit</c>), because that is the one place an operator already looks
/// after a launch that did not go well: the child names the steps of an exit it ran
/// (<c>gamebuddy-desktop-host-exit-record/v1</c>), and this names the launch whose composition never
/// returned. A composition failure used to leave the disk unchanged - the child computes its record
/// path only after the composition exists - so the only survivor of the measured failure was one
/// stderr line.
///
/// Every field is a bounded token or a number by construction, and a record that cannot be written is
/// never a second failure of the launch it describes: nothing here throws.
/// </summary>
internal static class DesktopLaunchFailureRecord
{
    /// <summary>What the launch did: it stopped while the composition was being built.</summary>
    internal const string CrashKind = "crash";

    /// <summary>The step's own status, beside the outcome the record already names.</summary>
    internal const string FailedStatus = "failed";

    /// <summary>What a step is called when the launch named no step at all.</summary>
    internal const string UnnamedStep = "unknown_step";

    /// <summary>What a reason is called when no bounded code survived: never a blank field.</summary>
    internal const string UnattributedReason = "desktop_host_exit_unattributed";

    private static readonly JsonSerializerOptions RecordShape = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    /// <summary>
    /// Writes one record and returns its path, or <c>null</c> when there is no operational root to write
    /// into or the write failed. <paramref name="reason"/> is the most specific bounded code the failure
    /// produced (the Host child's own when it named one), <paramref name="stage"/> is the step it was at.
    /// </summary>
    internal static string? Write(string? operationalRoot, string? reason, string? stage, string? childCode)
    {
        if (operationalRoot is null) return null;
        try
        {
            var directory = Path.Combine(operationalRoot, DesktopHostTeardownRecord.HostExitRecordDirectory);
            Directory.CreateDirectory(directory);
            var recordedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var record = new
            {
                schema = DesktopHostTeardownRecord.HostExitRecordSchema,
                version = 1,
                kind = CrashKind,
                reason = Bounded(reason) ?? UnattributedReason,
                pid = Environment.ProcessId,
                recordedAtUnixMs,
                steps = new[]
                {
                    new { step = Bounded(stage) ?? UnnamedStep, status = FailedStatus, failure = Bounded(childCode) },
                },
            };
            var stamp = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH-mm-ss-fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
            var path = Path.Combine(directory, $"host-exit-{stamp}-{Environment.ProcessId}.json");
            File.WriteAllText(path, JsonSerializer.Serialize(record, RecordShape) + "\n");
            return path;
        }
        catch
        {
            // A record that cannot be written is never a second failure of the launch it describes.
            return null;
        }
    }

    /// <summary>
    /// The only shape a reason, a step name or a code may have in this record: a bounded lowercase
    /// token. A value that is not already one is dropped rather than copied.
    /// </summary>
    internal static string? Bounded(string? value)
    {
        if (value is null || value.Length is < 2 or > 160) return null;
        if (value[0] is < 'a' or > 'z') return null;
        foreach (var character in value)
            if (character is not (>= 'a' and <= 'z') and not (>= '0' and <= '9') and not '_' and not '.' and not ':' and not '-')
                return null;
        return value;
    }
}
