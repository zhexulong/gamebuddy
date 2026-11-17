using System.Diagnostics;
using System.Text.Json;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The launcher's own record of the one resident Guardian attempt it has armed, and the reader that acts
/// on whatever an earlier launch left behind (ADR-0015 §4.3).
///
/// The process in these tests is a stand-in, deliberately: what is under test is the record and the
/// decision, not the native Guardian. What is NOT stood in for is the OS - every pid, start instant and
/// image path in every assertion comes from a real process the test started, and the reap is observed by
/// asking the process table whether that pid still exists.
/// </summary>
public sealed class DesktopGuardianAttemptRecordTests
{
    [Fact]
    public void An_armed_record_reads_back_what_it_recorded_and_is_retired_without_a_process()
    {
        using var root = new RecordRoot();
        var identity = new GuardianProcessIdentity(4321, 1_700_000_000_000, @"C:\Programs\GameBuddy\generations\g-1\native\guardian.exe");

        DesktopGuardianAttemptRecord.Armed(root.Root, Digest(), Guid.NewGuid().ToString("D"), identity);

        var written = Read(root.Root)!;
        Assert.Equal(DesktopGuardianAttemptRecord.Schema, written.Schema);
        Assert.Equal(DesktopGuardianAttemptRecord.ArmedOutcome, written.Outcome);
        Assert.Equal(identity.Pid, written.Pid);
        Assert.Equal(identity.StartedAtUnixMs, written.StartedAtUnixMs);
        Assert.Equal(identity.ExecutablePath, written.ExecutablePath, ignoreCase: true);

        DesktopGuardianAttemptRecord.Retire(root.Root);
        Assert.False(File.Exists(DesktopGuardianAttemptRecord.RecordPath(root.Root)));
    }

    [Fact]
    public void The_next_start_ends_the_exact_process_a_surviving_record_names()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var root = new RecordRoot();
        using var standIn = StandInProcess.Start();
        // The record is built from THIS process's own facts, the way the broker builds it from the lease
        // of the Guardian it just armed: pid, the instant the OS says it started, and the image it runs.
        DesktopGuardianAttemptRecord.Armed(root.Root, Digest(), Guid.NewGuid().ToString("D"), standIn.Identity);

        DesktopGuardianAttemptRecord.Recover(root.Root);

        var recovered = Read(root.Root, allowMissing: true);
        // Nothing was left behind, so there is nothing for an operator to act on and no record to read.
        Assert.Null(recovered);
        Assert.True(standIn.EndedWithin(TimeSpan.FromSeconds(30)), $"pid {standIn.Identity.Pid} still exists after the next start reaped it");
    }

    [Fact]
    public void A_record_whose_pid_belongs_to_another_process_is_named_and_nothing_is_ended()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var root = new RecordRoot();
        using var standIn = StandInProcess.Start();
        // Same pid, an instant this process never started at: exactly what a reused pid looks like.
        var foreign = standIn.Identity with { StartedAtUnixMs = standIn.Identity.StartedAtUnixMs - 60_000 };
        DesktopGuardianAttemptRecord.Armed(root.Root, Digest(), Guid.NewGuid().ToString("D"), foreign);

        DesktopGuardianAttemptRecord.Recover(root.Root);

        // A pid that now belongs to another process is the answer an operator must be able to read: the
        // Guardian named here was never verified gone, and a record that vanished would hide that.
        var named = Read(root.Root);
        Assert.Equal(DesktopGuardianAttemptRecord.ForeignOutcome, named!.Outcome);
        Assert.Equal(standIn.Identity.Pid, named.Pid);
        Assert.False(standIn.EndedWithin(TimeSpan.FromMilliseconds(250)), "a pid that is not the recorded process must never be ended");
    }

    [Fact]
    public void A_record_whose_process_is_already_gone_is_retired_without_touching_anything()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var root = new RecordRoot();
        var standIn = StandInProcess.Start();
        var identity = standIn.Identity;
        standIn.EndWithin(TimeSpan.FromSeconds(30));
        DesktopGuardianAttemptRecord.Armed(root.Root, Digest(), Guid.NewGuid().ToString("D"), identity);

        DesktopGuardianAttemptRecord.Recover(root.Root);

        Assert.Null(Read(root.Root, allowMissing: true));
    }

    [Fact]
    public void An_unreadable_record_is_named_in_place_and_no_process_is_ended()
    {
        using var root = new RecordRoot();
        Directory.CreateDirectory(Path.GetDirectoryName(DesktopGuardianAttemptRecord.RecordPath(root.Root))!);
        File.WriteAllText(DesktopGuardianAttemptRecord.RecordPath(root.Root), "{\"schema\":\"something else\"}\n");

        DesktopGuardianAttemptRecord.Recover(root.Root);

        // The fact stays visible under a name an operator can act on, and the next attempt's record
        // replaces it: one file, never a pile.
        Assert.Equal(DesktopGuardianAttemptRecord.UnreadableOutcome, Read(root.Root)!.Outcome);
    }

    [Fact]
    public void An_undeletable_or_unwritable_record_never_fails_the_launch_that_describes_it()
    {
        using var root = new RecordRoot();
        // A path that cannot exist as a directory: the record's own directory is a regular file.
        var blocked = Path.Combine(root.Root, "guardian-attempt");
        File.WriteAllText(blocked, "not a directory");

        DesktopGuardianAttemptRecord.Armed(root.Root, Digest(), Guid.NewGuid().ToString("D"), new GuardianProcessIdentity(1, 1, "x"));
        DesktopGuardianAttemptRecord.Retire(root.Root);
        DesktopGuardianAttemptRecord.Unsettled(root.Root, Digest(), Guid.NewGuid().ToString("D"), new GuardianProcessIdentity(1, 1, "x"));
        DesktopGuardianAttemptRecord.Recover(root.Root);
    }

    // The broker's bootstrapId is the 64-hex digest shape the launcher validates at its own entry.
    private static string Digest() => Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");

    private static Record? Read(string operationalRoot, bool allowMissing = false)
    {
        var path = DesktopGuardianAttemptRecord.RecordPath(operationalRoot);
        if (!File.Exists(path))
        {
            if (allowMissing) return null;
            throw new XunitException($"expected a guardian-attempt record at {path}");
        }
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        var root = document.RootElement;
        return new Record(
            root.GetProperty("schema").GetString()!,
            root.GetProperty("outcome").GetString()!,
            root.TryGetProperty("pid", out var pid) ? pid.GetUInt32() : 0,
            root.TryGetProperty("startedAtUnixMs", out var started) ? started.GetInt64() : 0,
            root.TryGetProperty("executablePath", out var executable) ? executable.GetString()! : string.Empty);
    }

    private sealed record Record(string Schema, string Outcome, uint Pid, long StartedAtUnixMs, string ExecutablePath);

    private sealed class RecordRoot : IDisposable
    {
        private readonly string path = Path.Combine(Path.GetTempPath(), "GameBuddy.Desktop.Tests", "guardian-attempt-record", Guid.NewGuid().ToString("N"));
        internal string Root => path ?? string.Empty;
        internal RecordRoot() => Directory.CreateDirectory(path);
        public void Dispose() { try { if (Directory.Exists(path)) Directory.Delete(path, recursive: true); } catch { } }
    }

    /// <summary>
    /// A real process this test started and nothing else depends on, held alive by its own arguments.
    /// Its identity is read from the OS, not written by this test: that is what the record's later
    /// verification has to match.
    /// </summary>
    private sealed class StandInProcess : IDisposable
    {
        private readonly Process process;
        private StandInProcess(Process process, GuardianProcessIdentity identity) { this.process = process; Identity = identity; }

        internal GuardianProcessIdentity Identity { get; }

        internal static StandInProcess Start()
        {
            var system = Environment.GetFolderPath(Environment.SpecialFolder.System);
            var process = Process.Start(new ProcessStartInfo(Path.Combine(system, "ping.exe"), "-n 120 127.0.0.1")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            }) ?? throw new InvalidOperationException("could not start the stand-in process");
            // The OS answers for a process that exists, but a process that only just started may not have
            // its module list ready on the very first ask, so the identity read is retried until it does.
            var deadline = DateTimeOffset.UtcNow.AddSeconds(10);
            while (true)
            {
                try
                {
                    var startedAtUnixMs = new DateTimeOffset(process.StartTime.ToUniversalTime(), TimeSpan.Zero).ToUnixTimeMilliseconds();
                    if (process.MainModule?.FileName is { Length: > 0 } image)
                        return new StandInProcess(process, new GuardianProcessIdentity(checked((uint)process.Id), startedAtUnixMs, image));
                }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception) { }
                if (DateTimeOffset.UtcNow >= deadline) break;
                Thread.Sleep(25);
            }
            try { process.Kill(); } catch { }
            process.Dispose();
            throw new InvalidOperationException("the stand-in process has no readable image");
        }

        internal bool EndedWithin(TimeSpan budget) => WaitUntilGone(budget);

        internal void EndWithin(TimeSpan budget)
        {
            try { process.Kill(); } catch { }
            Assert.True(WaitUntilGone(budget), $"pid {Identity.Pid} could not be ended by this test");
        }

        /// <summary>
        /// Asks the process table, once per poll, whether this pid still names a live process - the same
        /// question the launcher's own settlement asks, and the only one that is about the process rather
        /// than about a handle this test happens to hold.
        /// </summary>
        private bool WaitUntilGone(TimeSpan budget)
        {
            var deadline = DateTimeOffset.UtcNow + budget;
            while (true)
            {
                try
                {
                    using (var live = Process.GetProcessById(checked((int)Identity.Pid))) if (live.HasExited) return true;
                }
                catch (ArgumentException) { return true; }
                catch (InvalidOperationException) { return true; }
                if (DateTimeOffset.UtcNow >= deadline) return false;
                Thread.Sleep(25);
            }
        }

        public void Dispose()
        {
            try { if (!WaitUntilGone(TimeSpan.Zero)) process.Kill(); } catch { }
            process.Dispose();
        }
    }
}
