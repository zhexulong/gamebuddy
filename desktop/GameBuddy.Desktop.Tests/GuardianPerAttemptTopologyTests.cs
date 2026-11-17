using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameBuddy.Desktop.Tests.Fixtures;
using Microsoft.Win32.SafeHandles;
using Xunit.Abstractions;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// ADR-0015 topology A ("one resident Guardian per attempt") at the Desktop's own launcher seam:
/// two real resident Guardians, armed, settled and re-armed inside ONE Desktop process.
///
/// Everything here is the production path — the published generation's own guardian image admitted
/// through <see cref="InstalledGenerationAdmission"/>, <see cref="GuardianSupervisor.StartResidentAsync"/>
/// with its real <c>CreatePipe</c> control/stdout pair and host-attribute <c>CreateProcessW</c>, and
/// <see cref="GuardianSupervisorLease.RelayResidentAsync"/> for the arm exchange including the private
/// pipe token injection. The only two test-owned facts are the private ingress pipe NAME
/// (<c>TestObservationPipeName</c> is the same name the production launch would have generated at
/// random) and the five opaque attempt names, which production draws from one owner reservation and
/// this test draws the same way. No role is launched, so no game process exists at any point.
///
/// What it answers (§2.4, §4.1-§4.3 and §6 U1 of the ADR):
///  * settlement is "the process is gone", observed on a handle the test opened itself;
///  * a second attempt in the same process re-arms on fresh names;
///  * the first attempt's lease mutex and both Job objects are UNREACHABLE afterwards;
///  * the exit code is quoted, and deliberately not asserted: the Desktop never reads it
///    (<see cref="GuardianSupervisorLease.WaitForExitAsync(CancellationToken)"/> answers
///    <see cref="GuardianSupervisorExit.ControlClosed"/> once <c>GetExitCodeProcess</c> succeeds).
/// </summary>
public sealed class GuardianPerAttemptTopologyTests(ITestOutputHelper output)
{

    [Fact]
    public async Task Two_resident_guardians_arm_settle_and_rearm_inside_one_desktop_process()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        await using var selection = InstalledGenerationSelection.Acquire(generation.ProgramRoot);
        await using var image = await new InstalledGenerationAdmission(generation.ProgramRoot).AdmitGuardianAsync(selection, CancellationToken.None);
        Assert.Equal(generation.GuardianExePath, image.VerifiedAbsolutePath, StringComparer.OrdinalIgnoreCase);
        output.WriteLine($"generation={generation.GenerationId}");
        output.WriteLine($"admitted-guardian-image={image.VerifiedAbsolutePath}");

        await using var first = await ArmedAttempt.StartAsync(image, "attempt-1", output);
        Assert.Equal("armed", first.ArmStatus);

        // Attempt 2 stands up in the SAME Desktop process while attempt 1 is still armed: a second
        // resident Guardian must be able to draw a name triple nobody else holds.
        await using var second = await ArmedAttempt.StartAsync(image, "attempt-2", output);
        Assert.Equal("armed", second.ArmStatus);
        Assert.True(first.IsAlive && second.IsAlive, "both Guardians must be resident at the same instant for this claim");
        Assert.NotEqual(first.Pid, second.Pid);
        Assert.NotEqual(first.PipeName, second.PipeName);
        Assert.NotEqual(first.Identity.GuardianInstanceId, second.Identity.GuardianInstanceId);
        Assert.NotEqual(first.Identity.AttemptId, second.Identity.AttemptId);
        Assert.NotEqual(first.Identity.Revision, second.Identity.Revision);
        Assert.NotEqual(first.Identity.LeaseName, second.Identity.LeaseName);
        Assert.NotEqual(first.Identity.PlayerJobName, second.Identity.PlayerJobName);
        Assert.NotEqual(first.Identity.AiJobName, second.Identity.AiJobName);
        Assert.Equal(3, new[] { second.Identity.LeaseName, second.Identity.PlayerJobName, second.Identity.AiJobName }.Distinct(StringComparer.Ordinal).Count());
        // Positive control: each armed Guardian really is the holder of its own three kernel objects,
        // so their absence after settlement is an absence and not a probe that never worked.
        foreach (var attempt in new[] { first, second })
        {
            Assert.True(NamedObjectProbe.LeaseExists(attempt.Identity.LeaseName), $"{attempt.Label} must hold its lease mutex while armed: {attempt.Identity.LeaseName}");
            Assert.True(NamedObjectProbe.JobExists(attempt.Identity.PlayerJobName), $"{attempt.Label} must hold its player Job while armed: {attempt.Identity.PlayerJobName}");
            Assert.True(NamedObjectProbe.JobExists(attempt.Identity.AiJobName), $"{attempt.Label} must hold its AI Job while armed: {attempt.Identity.AiJobName}");
        }

        var firstSettlement = await first.SettleAsync();
        Assert.Equal(GuardianSupervisorExit.ControlClosed, firstSettlement.Exit);
        Assert.True(firstSettlement.Gone, $"attempt-1 pid {first.Pid} still exists after settlement");
        Assert.False(NamedObjectProbe.LeaseExists(first.Identity.LeaseName), $"attempt-1 lease mutex outlived its Guardian: {first.Identity.LeaseName}");
        Assert.False(NamedObjectProbe.JobExists(first.Identity.PlayerJobName), $"attempt-1 player Job outlived its Guardian: {first.Identity.PlayerJobName}");
        Assert.False(NamedObjectProbe.JobExists(first.Identity.AiJobName), $"attempt-1 AI Job outlived its Guardian: {first.Identity.AiJobName}");
        // Settling one attempt must not reach the other: that is what "no shared object" means.
        Assert.True(second.IsAlive, $"settling attempt-1 ended attempt-2 pid {second.Pid}");
        Assert.True(NamedObjectProbe.LeaseExists(second.Identity.LeaseName), $"settling attempt-1 released attempt-2's lease mutex: {second.Identity.LeaseName}");
        Assert.True(NamedObjectProbe.JobExists(second.Identity.PlayerJobName), $"settling attempt-1 released attempt-2's player Job: {second.Identity.PlayerJobName}");
        Assert.False(NamedObjectProbe.LeaseExists(first.Identity.LeaseName), $"attempt-2 still sees attempt-1's lease mutex: {first.Identity.LeaseName}");

        var secondSettlement = await second.SettleAsync();
        Assert.Equal(GuardianSupervisorExit.ControlClosed, secondSettlement.Exit);
        Assert.True(secondSettlement.Gone, $"attempt-2 pid {second.Pid} still exists after settlement");
        Assert.False(NamedObjectProbe.LeaseExists(second.Identity.LeaseName), $"attempt-2 lease mutex outlived its Guardian: {second.Identity.LeaseName}");
        Assert.False(NamedObjectProbe.JobExists(second.Identity.PlayerJobName), $"attempt-2 player Job outlived its Guardian: {second.Identity.PlayerJobName}");
        Assert.False(NamedObjectProbe.JobExists(second.Identity.AiJobName), $"attempt-2 AI Job outlived its Guardian: {second.Identity.AiJobName}");
    }

    /// <summary>
    /// The Guardian's own words when control EOF arrives, which the launcher can never hear: the
    /// launcher passes <c>hStdError = IntPtr.Zero</c> (<c>GuardianSupervisor.cs:70</c>), so a .NET child
    /// writes its error stream to nothing and only the exit code survives.
    ///
    /// This runs the same admitted image with the launcher's own five-variable environment block and
    /// an anonymous-pipe stdin — the same <c>CreatePipe</c> shape the launcher gives it, which is the
    /// variable the Node-hosted ADR measurement could not isolate. The probe writes no frame at all:
    /// staying alive past the launch proves the environment was accepted and the process sits in its
    /// command loop, so the EOF that follows is a legitimate EOF and nothing else can have failed.
    ///
    /// This pins a DEFECT, not a contract. If the native Guardian is later fixed to leave cleanly on
    /// control EOF, this test is the one that goes red, on purpose: ADR-0015 §2.4 says the settle
    /// criterion is "the process is gone" precisely because this exit code is not a product fact.
    /// </summary>
    [Fact]
    public async Task Published_guardian_word_on_a_legitimate_control_eof_is_its_own_invalid_request()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        await using var selection = InstalledGenerationSelection.Acquire(generation.ProgramRoot);
        await using var image = await new InstalledGenerationAdmission(generation.ProgramRoot).AdmitGuardianAsync(selection, CancellationToken.None);

        // The launcher builds exactly these five variables and nothing else, so the replica does too.
        var start = new ProcessStartInfo(image.VerifiedAbsolutePath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.Environment.Clear();
        foreach (var name in new[] { "SystemRoot", "TEMP", "TMP" }) start.Environment[name] = Environment.GetEnvironmentVariable(name)!;
        start.Environment["GAMEBUDDY_GUARDIAN_MODE"] = "resident";
        start.Environment["GAMEBUDDY_GUARDIAN_CONTROL_PIPE"] = $"GameBuddy.Guardian.TestObservation.{Guid.NewGuid():N}";
        start.Environment["GAMEBUDDY_GUARDIAN_CONTROL_TOKEN"] = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();

        using var guardian = Process.Start(start) ?? throw new InvalidOperationException("could not start the admitted Guardian");
        await Task.Delay(500);
        Assert.False(guardian.HasExited, "the Guardian left before its control pipe could close, so its environment was refused and this probe would prove nothing");

        guardian.StandardInput.Close();
        var stderr = await guardian.StandardError.ReadToEndAsync().WaitAsync(TimeSpan.FromSeconds(30));
        await guardian.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
        output.WriteLine($"guardian: pid={guardian.Id} exit-code={guardian.ExitCode} stderr={stderr.Trim()}");

        Assert.Equal(1, guardian.ExitCode);
        Assert.Equal("windows_bootstrap_guardian_invalid_request", stderr.Trim());
    }

    /// <summary>
    /// One armed, settled resident Guardian, with the readings the ADR's U1 asks for.
    ///
    /// The pid is not exposed by the supervisor, so it is found the read-only way: the difference
    /// between the process table filtered to the exact admitted image before and after the launch.
    /// The exit code comes from a handle this test opens on that pid while it is still alive.
    /// </summary>
    private sealed class ArmedAttempt : IAsyncDisposable
    {
        private readonly GuardianSupervisor supervisor;
        private readonly GuardianSupervisorLease lease;
        private readonly ProcessProbe processHandle;
        private readonly ITestOutputHelper output;

        private ArmedAttempt(string label, GuardianSupervisor supervisor, GuardianSupervisorLease lease, ProcessProbe processHandle,
            AttemptIdentity identity, string pipeName, int pid, string armStatus, TimeSpan spawn, TimeSpan arm, ITestOutputHelper output)
        {
            this.supervisor = supervisor;
            this.lease = lease;
            this.processHandle = processHandle;
            this.output = output;
            Label = label;
            Identity = identity;
            PipeName = pipeName;
            Pid = pid;
            ArmStatus = armStatus;
            Spawn = spawn;
            Arm = arm;
        }

        internal string Label { get; }
        internal AttemptIdentity Identity { get; }
        internal string PipeName { get; }
        internal int Pid { get; }
        internal string ArmStatus { get; }
        internal TimeSpan Spawn { get; }
        internal TimeSpan Arm { get; }
        internal bool IsAlive => LivePid(Pid);

        internal static async Task<ArmedAttempt> StartAsync(AdmittedGuardianImage image, string label, ITestOutputHelper output)
        {
            var identity = AttemptIdentity.Create(image.VerifiedAbsolutePath);
            var pipeName = $"GameBuddy.Guardian.TestObservation.{Guid.NewGuid():N}";
            var before = GuardianProcessProbe.Pids(image.VerifiedAbsolutePath);
            var supervisor = new GuardianSupervisor { TestObservationPipeName = pipeName };
            GuardianSupervisorLease? lease = null;
            ProcessProbe? processHandle = null;
            try
            {
                var clock = Stopwatch.StartNew();
                lease = await supervisor.StartResidentAsync(image, CancellationToken.None);
                var spawn = clock.Elapsed;
                var pid = GuardianProcessProbe.NewPid(image.VerifiedAbsolutePath, before);
                processHandle = ProcessProbe.Open(pid);
                clock.Restart();
                var result = await lease.RelayResidentAsync(
                    new GuardianRelayCommand("arm_attempt", identity.GuardianInstanceId, identity.GuardianEpoch, identity.AttemptId, null, identity.ArmBody(), 0, 30_000),
                    CancellationToken.None);
                var arm = clock.Elapsed;
                var attempt = new ArmedAttempt(label, supervisor, lease, processHandle, identity, pipeName, pid, result.Status, spawn, arm, output);
                lease = null;
                processHandle = null;
                output.WriteLine($"{label}: pid={pid} private-pipe={pipeName}");
                output.WriteLine($"{label}: lease={identity.LeaseName} player-job={identity.PlayerJobName} ai-job={identity.AiJobName}");
                output.WriteLine($"{label}: arm={result.Status} spawn={spawn.TotalMilliseconds:F1}ms arm-handshake={arm.TotalMilliseconds:F1}ms spawn-to-armed={(spawn + arm).TotalMilliseconds:F1}ms");
                return attempt;
            }
            finally
            {
                // A launch or arm that failed still has to take its own process down here,
                // otherwise a red test leaves a resident Guardian holding a lease and two Jobs.
                processHandle?.Dispose();
                if (lease is not null) await lease.DisposeAsync();
                await supervisor.DisposeAsync();
            }
        }

        internal async Task<AttemptSettlement> SettleAsync()
        {
            var clock = Stopwatch.StartNew();
            await lease.CloseControlAsync(CancellationToken.None);
            var exit = await lease.WaitForExitAsync(CancellationToken.None);
            var wait = clock.Elapsed;
            var exitCode = await WaitForExitCodeAsync(processHandle, TimeSpan.FromSeconds(30));
            var gone = !LivePid(Pid);
            var settlement = new AttemptSettlement(exit, exitCode, gone, wait);
            output.WriteLine($"{Label}: exit={settlement.Exit} exit-code={settlement.ExitCode} gone={settlement.Gone} wait-for-exit={settlement.Wait.TotalMilliseconds:F0}ms");
            return settlement;
        }

        private static bool LivePid(int pid)
        {
            try
            {
                using var process = Process.GetProcessById(pid);
                return !process.HasExited;
            }
            catch (ArgumentException)
            {
                return false;
            }
        }

        private static async Task<uint> WaitForExitCodeAsync(ProcessProbe probe, TimeSpan budget)
        {
            var deadline = DateTimeOffset.UtcNow + budget;
            while (true)
            {
                var code = probe.ExitCode();
                // STILL_ACTIVE is the OS saying "running", not an exit code the process chose.
                if (code != ProcessProbe.StillActive) return code;
                if (DateTimeOffset.UtcNow >= deadline) throw new TimeoutException("the Guardian is still present after control EOF");
                await Task.Delay(20).ConfigureAwait(false);
            }
        }

        public async ValueTask DisposeAsync()
        {
            await lease.DisposeAsync();
            await supervisor.DisposeAsync();
            processHandle.Dispose();
        }
    }

    private sealed record AttemptSettlement(GuardianSupervisorExit Exit, uint ExitCode, bool Gone, TimeSpan Wait);

    /// <summary>
    /// A read-only query handle on one pid, opened while the process is alive so its exit code
    /// survives the exit.
    ///
    /// This is declared here instead of reused from <see cref="WindowsNative.OpenProcess"/> because
    /// that declaration reports success but never hands the handle back: measured on this machine on
    /// 2026-11-17, <c>OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)</c> returned true with
    /// <c>handle == 0</c> for both the current process and a fresh child, so every caller of it holds
    /// an invalid handle. That is a defect in the launcher's own test-support declaration
    /// (<c>desktop/GameBuddy.Desktop/WindowsNative.cs:95-97</c>) and is reported, not fixed, here.
    /// </summary>
    private sealed class ProcessProbe : IDisposable
    {
        private const uint ProcessQueryLimitedInformation = 0x1000;
        internal const uint StillActive = 259;
        private IntPtr handle;

        private ProcessProbe(IntPtr handle) => this.handle = handle;

        internal static ProcessProbe Open(int pid)
        {
            var handle = OpenProcess(ProcessQueryLimitedInformation, false, (uint)pid);
            if (handle == IntPtr.Zero) throw new InvalidOperationException($"could not open pid {pid} read-only: error {Marshal.GetLastWin32Error()}");
            return new ProcessProbe(handle);
        }

        internal uint ExitCode()
        {
            if (!GetExitCodeProcess(handle, out var code)) throw new InvalidOperationException($"GetExitCodeProcess failed: error {Marshal.GetLastWin32Error()}");
            return code;
        }

        public void Dispose()
        {
            var owned = handle;
            handle = IntPtr.Zero;
            if (owned != IntPtr.Zero) CloseHandle(owned);
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
    }

    /// <summary>
    /// The five opaque attempt names plus the approved executable, drawn the way one production
    /// owner reservation draws them (<c>stardew-private-bootstrap-composer.core.internal.ts:600-606</c>).
    /// </summary>
    private sealed record AttemptIdentity(string GuardianInstanceId, int GuardianEpoch, string AttemptId, string Revision,
        string LeaseName, string PlayerJobName, string AiJobName, string ApprovedExecutable)
    {
        internal static AttemptIdentity Create(string approvedExecutable) => new(
            Guid.NewGuid().ToString("D"), 1, Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"),
            NewKernelName(), NewKernelName(), NewKernelName(), approvedExecutable);

        private static string NewKernelName() => $"Local\\GameBuddy-{Guid.NewGuid():N}";

        /// <summary>
        /// The eight arm facts the Guardian parses; the ninth key (<c>token</c>) is injected by
        /// <see cref="GuardianPrivateIngress.InjectArmToken"/> on the private pipe, exactly as the
        /// production relay does, so the token never exists in this test.
        /// </summary>
        internal byte[] ArmBody() => Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
        {
            guardianInstanceId = GuardianInstanceId,
            guardianEpoch = GuardianEpoch,
            attemptId = AttemptId,
            revision = Revision,
            leaseName = LeaseName,
            playerJobName = PlayerJobName,
            aiJobName = AiJobName,
            approvedExecutable = ApprovedExecutable,
        }));
    }

    /// <summary>Read-only presence of the two named kernel objects a settled attempt must not leave behind.</summary>
    private static class NamedObjectProbe
    {
        private const uint JobObjectQuery = 0x0004;

        internal static bool LeaseExists(string name)
        {
            if (!Mutex.TryOpenExisting(name, out var mutex)) return false;
            mutex.Dispose();
            return true;
        }

        internal static bool JobExists(string name)
        {
            var handle = OpenJobObjectW(JobObjectQuery, false, name);
            if (handle.IsInvalid) return false;
            handle.Dispose();
            return true;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle OpenJobObjectW(uint desiredAccess, bool inheritHandle, string name);
    }

    /// <summary>Process-table reading filtered to the exact admitted image, so a foreign pid can never be mistaken for ours.</summary>
    private static class GuardianProcessProbe
    {
        internal static HashSet<int> Pids(string imagePath)
        {
            var pids = new HashSet<int>();
            foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(imagePath)))
            {
                using (process)
                {
                    try
                    {
                        var path = process.MainModule?.FileName;
                        if (path is not null && string.Equals(Normalize(path), Normalize(imagePath), StringComparison.OrdinalIgnoreCase)) pids.Add(process.Id);
                    }
                    catch (Exception error) when (error is Win32Exception or InvalidOperationException or NotSupportedException)
                    {
                        // A process we cannot inspect is not ours to claim.
                    }
                }
            }
            return pids;
        }

        internal static int NewPid(string imagePath, HashSet<int> before)
        {
            var added = Pids(imagePath);
            added.ExceptWith(before);
            if (added.Count != 1)
                throw new InvalidOperationException($"expected exactly one new Guardian process for {imagePath}, observed {added.Count}: {string.Join(",", added)}");
            return added.Single();
        }

        private static string Normalize(string path) => path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path[4..] : path;
    }
}



