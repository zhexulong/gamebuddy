using GameBuddy.Desktop.Tests.Fixtures;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The broker owns the resident Guardian, so these are the facts about WHO owns it (ADR-0015 §3, §7):
/// the launcher mounts a factory and holds no lease, a session that never arms creates no Guardian at
/// all, the mount is refused twice or after the Host is gone, and a refused mount never creates one.
/// </summary>
public sealed class RuntimeSupervisorGuardianResidentIntegrationTests
{
    [Fact]
    public async Task A_host_session_that_never_arms_creates_no_resident_guardian()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await StartedFixture.CreateAsync();
        await using var guardianSupervisor = new GuardianSupervisor();
        await using var image = await fixture.AdmitGuardianAsync();
        var created = 0;

        await fixture.Host.AttachResidentGuardianFactory(async token => { _ = Interlocked.Increment(ref created); return await guardianSupervisor.StartResidentAsync(image, token); }, CancellationToken.None);

        // A Chat-only Host run, and a Game run whose player never started a game, both look like this: the
        // broker serves, and no Guardian exists because no attempt was ever armed.
        fixture.RequestHostExit();
        Assert.True(await fixture.Host.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.Equal(0, Volatile.Read(ref created));
    }

    [Fact]
    public async Task Host_eof_while_native_role_is_queued_prevents_role_activation_and_settles_the_attempts_guardian()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await StartedFixture.CreateAsync();
        var barrierDirectory = Path.Combine(fixture.Layout.DataRoot, "guardian-eof-barrier");
        Directory.CreateDirectory(barrierDirectory);
        var executable = WindowsNative.CreateFile(fixture.Generation.TestGuardianExePath, WindowsNative.FileReadData | WindowsNative.FileExecute, WindowsNative.FileShareRead, IntPtr.Zero, WindowsNative.OpenExisting, WindowsNative.FileAttributeNormal, IntPtr.Zero);
        Assert.False(executable.IsInvalid);
        Assert.True(WindowsNative.GetFileInformationByHandle(executable, out var identity));
        await using var image = new AdmittedGuardianImage(executable, fixture.Generation.TestGuardianExePath, "test", identity);
        var controlClosed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var guardianSupervisor = new GuardianSupervisor { TestBarrierDirectory = barrierDirectory, TestBarrierPhase = "after-create", ControlClosedForTesting = controlClosed };
        var attemptGuardianPid = 0u;
        await fixture.Host.AttachResidentGuardianFactory(async token =>
        {
            var created = await guardianSupervisor.StartResidentAsync(image, token);
            attemptGuardianPid = created.Pid;
            return created;
        }, CancellationToken.None);

        File.WriteAllText(Path.Combine(fixture.Layout.DataRoot, "broker-eof-race.trigger"), "trigger");
        var queued = Path.Combine(fixture.Layout.DataRoot, "broker-eof-race.queued");
        var queuedDeadline = DateTimeOffset.UtcNow.AddSeconds(10);
        while (!File.Exists(queued) && DateTimeOffset.UtcNow < queuedDeadline) await Task.Delay(10);
        Assert.True(File.Exists(queued));
        Assert.NotEqual(0u, attemptGuardianPid);
        fixture.RequestHostExit();

        await controlClosed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        File.WriteAllText(Path.Combine(barrierDirectory, "after-create.release"), "release");
        Assert.True(await fixture.Host.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.True(File.Exists(Path.Combine(barrierDirectory, "after-create.ready")));
        // The attempt's Guardian is the broker's to end, and the settlement proves that exact process gone.
        var deadline = DateTimeOffset.UtcNow.AddSeconds(30);
        while (LivePid(attemptGuardianPid) && DateTimeOffset.UtcNow < deadline) await Task.Delay(25);
        Assert.False(LivePid(attemptGuardianPid), $"the attempt's Guardian (pid {attemptGuardianPid}) outlived its session");
    }

    [Fact]
    public async Task Mounting_the_guardian_factory_after_the_host_exited_is_refused_and_creates_no_guardian()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await StartedFixture.CreateAsync();
        fixture.RequestHostExit();
        Assert.True(await fixture.Host.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)));
        await using var guardianSupervisor = new GuardianSupervisor();
        await using var image = await fixture.AdmitGuardianAsync();
        var created = 0;

        await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(() =>
            fixture.Host.AttachResidentGuardianFactory(async token => { _ = Interlocked.Increment(ref created); return await guardianSupervisor.StartResidentAsync(image, token); }, CancellationToken.None));
        Assert.Equal(0, Volatile.Read(ref created));
    }

    [Fact]
    public async Task Duplicate_and_cancelled_guardian_factory_mounts_are_refused_and_create_no_guardian()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await StartedFixture.CreateAsync();
        await using var guardianSupervisor = new GuardianSupervisor();
        await using var image = await fixture.AdmitGuardianAsync();
        var created = 0;

        Func<CancellationToken, Task<GuardianSupervisorLease>> factory = async token => { _ = Interlocked.Increment(ref created); return await guardianSupervisor.StartResidentAsync(image, token); };
        await fixture.Host.AttachResidentGuardianFactory(factory, CancellationToken.None);

        // The mount is what starts the command loop, so it is the one thing that may happen once: a second
        // mount would be a second loop over one pipe.
        await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(() => fixture.Host.AttachResidentGuardianFactory(factory, CancellationToken.None));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Host.AttachResidentGuardianFactory(factory, cancellation.Token));
        Assert.Equal(0, Volatile.Read(ref created));
    }

    private static bool LivePid(uint pid)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(checked((int)pid));
            return !process.HasExited;
        }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    private sealed class StartedFixture : IAsyncDisposable
    {
        private readonly DisposableInstalledGuardianGeneration generation;
        private readonly InstalledGenerationSelection selection;
        private readonly AdmittedHostRuntime runtime;
        private readonly RuntimeSupervisor supervisor;

        private StartedFixture(DisposableInstalledGuardianGeneration generation, CurrentUserRootLayout layout, InstalledGenerationSelection selection, AdmittedHostRuntime runtime, RuntimeSupervisor supervisor, RuntimeSupervisorLease host)
        {
            this.generation = generation;
            Layout = layout;
            this.selection = selection;
            this.runtime = runtime;
            this.supervisor = supervisor;
            Host = host;
        }

        internal CurrentUserRootLayout Layout { get; }
        internal DisposableInstalledGuardianGeneration Generation => generation;
        internal RuntimeSupervisorLease Host { get; }

        internal static async Task<StartedFixture> CreateAsync()
        {
            var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
            InstalledGenerationSelection? selection = null;
            AdmittedHostRuntime? runtime = null;
            RuntimeSupervisor? supervisor = null;
            RuntimeSupervisorLease? host = null;
            try
            {
                generation.ReplaceHostRuntimeWithFixture();
                var registration = new CurrentUserRootRegistrationRecord(CurrentUserRootRegistration.SchemaVersion, generation.ProgramRoot);
                var operationalRoot = Path.Combine(generation.LocalApplicationData, "GameBuddy", "operational");
                foreach (var path in new[] { Path.Combine(generation.LocalApplicationData, "GameBuddy", "data"), operationalRoot, Path.Combine(generation.LocalApplicationData, "GameBuddy", "presentation") }) Directory.CreateDirectory(path);
                TestDeploymentManifest.WriteDeploymentManifest(operationalRoot);
                var layout = CurrentUserRootLayout.DeriveForTesting(registration, new LocalApplicationDataProvider(generation.LocalApplicationData));
                selection = InstalledGenerationSelection.Acquire(generation.ProgramRoot);
                runtime = new InstalledHostRuntimeAdmission().Admit(selection);
                supervisor = new RuntimeSupervisor();
                host = await supervisor.StartHostAsync(selection, runtime, layout, CancellationToken.None);
                await File.ReadAllTextAsync(Path.Combine(layout.DataRoot, "desktop-host-runtime-fixture.ready")).WaitAsync(TimeSpan.FromSeconds(10));
                return new StartedFixture(generation, layout, selection, runtime, supervisor, host);
            }
            catch
            {
                if (host is not null) await host.DisposeAsync();
                if (supervisor is not null) await supervisor.DisposeAsync();
                if (runtime is not null) await runtime.DisposeAsync();
                if (selection is not null) await selection.DisposeAsync();
                await generation.DisposeAsync();
                throw;
            }
        }

        internal async Task<AdmittedGuardianImage> AdmitGuardianAsync() => await new InstalledGenerationAdmission(Layout).AdmitGuardianAsync(selection, CancellationToken.None);
        internal void RequestHostExit() => File.WriteAllText(Path.Combine(Layout.DataRoot, "desktop-host-runtime-fixture.ready.exit"), "exit");

        public async ValueTask DisposeAsync()
        {
            await Host.DisposeAsync();
            await supervisor.DisposeAsync();
            await runtime.DisposeAsync();
            await selection.DisposeAsync();
            await generation.DisposeAsync();
        }
    }

    private sealed class LocalApplicationDataProvider(string path) : ILocalApplicationDataProvider
    {
        public string GetLocalApplicationDataPath() => path;
    }
}
