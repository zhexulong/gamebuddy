using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace GameBuddy.Desktop;

/// <summary>What names one resident Guardian process: its pid, the instant it started and the image it runs.</summary>
internal readonly record struct GuardianProcessIdentity(uint Pid, long StartedAtUnixMs, string ExecutablePath);

/// <summary>
/// The launcher's own durable record of the one resident Guardian attempt it currently has armed, and
/// the reader that acts on whatever an earlier launch left behind.
///
/// The record exists because nothing else can name the process (ADR-0015 §4.3): the durable bootstrap
/// owner record carries a lease name and a player Job name and no process identity at all, so a Guardian
/// left behind by a dead Desktop keeps holding its lease mutex and the player Job while no artifact says
/// which process to end. This one does: pid, that process's own start instant, the image it runs, the
/// Host run and the attempt it belonged to.
///
/// Its lifecycle is the whole point, so it has exactly one file:
/// * written when an attempt arms;
/// * deleted when a settlement proves the exact process is gone (nothing was left behind);
/// * rewritten with <see cref="UnsettledOutcome"/> when a settlement could not prove that;
/// * left exactly as it is when the launch itself dies, which is the one case where nothing else in the
///   world can name the process it left holding a lease mutex and the player Job;
/// * read at the next start by <see cref="Recover"/>, which ends the exact process the record names -
///   only after the pid, the start instant AND the image all still match - or names why it did not.
///
/// One file, one live attempt: it cannot pile up, and the next attempt's record replaces the last one.
/// Every field is a bounded token or a number by construction; nothing here holds a bridge credential,
/// a player's words or a stack, and nothing here throws. A record that cannot be written or read is
/// never allowed to become a second failure of the launch it describes.
/// </summary>
internal static class DesktopGuardianAttemptRecord
{
    internal const string Schema = "gamebuddy-desktop-guardian-attempt/v1";
    // Written when the attempt arms.
    internal const string ArmedOutcome = "guardian_armed";
    // Written when a settlement could not prove the process gone. It stays for the next start.
    internal const string UnsettledOutcome = "guardian_settle_unverified";
    // Written by the next start, for what it found and did.
    internal const string ReapedOutcome = "guardian_reaped";
    internal const string AbsentOutcome = "guardian_process_already_absent";
    internal const string ForeignOutcome = "guardian_pid_belongs_to_another_process";
    internal const string UnreadableOutcome = "guardian_attempt_record_unreadable";

    // Beside host-exit, the directory an operator already reads after an exit that did not go well.
    private const string DirectoryName = "guardian-attempt";
    private const string FileName = "guardian-attempt.json";
    private const int ReapWaitMilliseconds = 30_000;

    private static readonly Regex BoundedToken = new("^[a-z][a-z0-9_.:-]{1,159}$", RegexOptions.CultureInvariant);
    private static readonly Regex Opaque = new("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOptions.CultureInvariant);
    private static readonly Regex Digest = new("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);
    private static readonly JsonSerializerOptions RecordShape = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    /// <summary>The one file this launcher's records live in.</summary>
    internal static string RecordPath(string operationalRoot) => Path.Combine(operationalRoot, DirectoryName, FileName);

    /// <summary>
    /// Records the attempt that has just armed: the exact process this launcher started, and the Host
    /// run and attempt it belongs to. From here until the settlement proves that process gone, this file
    /// is the only artifact that could find it.
    /// </summary>
    internal static void Armed(string operationalRoot, string bootstrapId, string attemptId, GuardianProcessIdentity guardian) =>
        Write(operationalRoot, ArmedOutcome, bootstrapId, attemptId, guardian);

    /// <summary>
    /// Rewrites the record to say the settlement could not prove the process gone, and leaves it in
    /// place: the next start reads it and ends the exact process, or names why it could not.
    /// </summary>
    internal static void Unsettled(string operationalRoot, string bootstrapId, string attemptId, GuardianProcessIdentity guardian) =>
        Write(operationalRoot, UnsettledOutcome, bootstrapId, attemptId, guardian);

    /// <summary>
    /// Drops the record: the settlement proved the exact process gone, so nothing was left behind and
    /// there is nothing for a later launch to find.
    /// </summary>
    internal static void Retire(string operationalRoot)
    {
        try { File.Delete(RecordPath(operationalRoot)); }
        catch { /* an undeletable record is re-examined, harmlessly, by the next start */ }
    }

    /// <summary>
    /// Reads what an earlier launch left behind and acts on it, then writes down what it found:
    /// the exact process the record names is ended here when pid, start instant and image all still
    /// match; a process that is already gone, or whose pid now belongs to another process, is recorded
    /// as such and nothing is ended; anything that cannot be verified is recorded as such and the
    /// record stays. Never throws - a launch must not fail on its own bookkeeping.
    /// </summary>
    internal static void Recover(string operationalRoot)
    {
        Snapshot snapshot;
        try
        {
            var path = RecordPath(operationalRoot);
            if (!File.Exists(path)) return;
            if (!TryRead(path, out snapshot))
            {
                // An unreadable record names no process, so nothing can be ended; the fact stays visible
                // under a name an operator can act on, and the next attempt's record replaces it.
                WriteUnreadable(operationalRoot);
                return;
            }
        }
        catch
        {
            return;
        }

        var outcome = RecoverProcess(snapshot);
        if (outcome == snapshot.Outcome) return;
        // "Nothing was left behind" is the only answer that leaves nothing for an operator to read: the
        // process was ended here, or it was already gone. Every other answer is a fact worth keeping, and
        // the one that matters most is a pid that now belongs to another process - a record that vanished
        // on that answer would make an unverified Guardian look like a clean start.
        if (outcome is ReapedOutcome or AbsentOutcome) Retire(operationalRoot);
        else Write(operationalRoot, outcome, snapshot.BootstrapId, snapshot.AttemptId, snapshot.Identity);
    }

    private static string RecoverProcess(Snapshot snapshot)
    {
        Process process;
        try { process = Process.GetProcessById(checked((int)snapshot.Pid)); }
        catch (ArgumentException) { return AbsentOutcome; }
        catch (InvalidOperationException) { return AbsentOutcome; }
        catch { return UnsettledOutcome; }
        using (process)
        {
            // The identity check runs on the same process object the kill would use, so the pid cannot
            // be recycled between deciding and acting.
            if (!IsExactProcess(process, snapshot)) return ForeignOutcome;
            try { process.Kill(); }
            catch { /* a process that ended on its own, or refused: the wait below is what answers */ }
            return process.WaitForExit(ReapWaitMilliseconds) ? ReapedOutcome : UnsettledOutcome;
        }
    }

    /// <summary>
    /// Whether the process that owns this pid is the one the record names. A pid alone never identifies a
    /// process - the OS reuses them - so the image it runs and the instant it started must match too. An
    /// identity that cannot be read at all is not a match: "cannot verify" never counts as "mine".
    /// </summary>
    private static bool IsExactProcess(Process process, Snapshot snapshot)
    {
        if (snapshot.StartedAtUnixMs <= 0 || snapshot.ExecutablePath.Length == 0) return false;
        try
        {
            if (process.HasExited) return false;
            var startedAtUnixMs = new DateTimeOffset(process.StartTime.ToUniversalTime(), TimeSpan.Zero).ToUnixTimeMilliseconds();
            var imagePath = process.MainModule?.FileName;
            return startedAtUnixMs == snapshot.StartedAtUnixMs && imagePath is not null &&
                StringComparer.OrdinalIgnoreCase.Equals(Normalize(imagePath), Normalize(snapshot.ExecutablePath));
        }
        catch
        {
            // A process this launcher may not inspect is not one it may end.
            return false;
        }
    }

    private static string Normalize(string path) => path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path[4..] : path;

    private static void Write(string operationalRoot, string outcome, string bootstrapId, string attemptId, GuardianProcessIdentity guardian)
    {
        try
        {
            var directory = Path.Combine(operationalRoot, DirectoryName);
            Directory.CreateDirectory(directory);
            var record = new
            {
                schema = Schema,
                version = 1,
                outcome,
                bootstrapId,
                attemptId,
                pid = guardian.Pid,
                startedAtUnixMs = guardian.StartedAtUnixMs,
                executablePath = guardian.ExecutablePath,
                recordedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            File.WriteAllText(Path.Combine(directory, FileName), JsonSerializer.Serialize(record, RecordShape) + "\n");
        }
        catch
        {
            // A record that cannot be written is never a second failure of the launch it describes.
        }
    }

    private static void WriteUnreadable(string operationalRoot)
    {
        try
        {
            var directory = Path.Combine(operationalRoot, DirectoryName);
            Directory.CreateDirectory(directory);
            var record = new
            {
                schema = Schema,
                version = 1,
                outcome = UnreadableOutcome,
                recordedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            File.WriteAllText(Path.Combine(directory, FileName), JsonSerializer.Serialize(record, RecordShape) + "\n");
        }
        catch
        {
            // Same as above: naming the fact must never be what fails a launch.
        }
    }

    private static bool TryRead(string path, out Snapshot snapshot)
    {
        snapshot = default;
        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object ||
            !root.EnumerateObject().Select(property => property.Name).SequenceEqual(
                new[] { "schema", "version", "outcome", "bootstrapId", "attemptId", "pid", "startedAtUnixMs", "executablePath", "recordedAtUnixMs" }, StringComparer.Ordinal) ||
            root.GetProperty("schema").GetString() != Schema || root.GetProperty("version").GetInt32() != 1) return false;
        var outcome = root.GetProperty("outcome").GetString();
        var bootstrapId = root.GetProperty("bootstrapId").GetString();
        var attemptId = root.GetProperty("attemptId").GetString();
        var executablePath = root.GetProperty("executablePath").GetString();
        if (outcome is null || !BoundedToken.IsMatch(outcome) || bootstrapId is null || !Digest.IsMatch(bootstrapId) ||
            attemptId is null || !Opaque.IsMatch(attemptId) || executablePath is null || executablePath.Length == 0 || executablePath.Any(char.IsControl) ||
            !root.GetProperty("pid").TryGetUInt32(out var pid) || pid == 0 ||
            !root.GetProperty("startedAtUnixMs").TryGetInt64(out var startedAtUnixMs) || startedAtUnixMs <= 0) return false;
        snapshot = new Snapshot(outcome, bootstrapId, attemptId, new GuardianProcessIdentity(pid, startedAtUnixMs, executablePath));
        return true;
    }

    private readonly record struct Snapshot(string Outcome, string BootstrapId, string AttemptId, GuardianProcessIdentity Identity)
    {
        internal uint Pid => Identity.Pid;
        internal long StartedAtUnixMs => Identity.StartedAtUnixMs;
        internal string ExecutablePath => Identity.ExecutablePath;
    }
}
