using GameBuddy.Desktop.Tests.Fixtures;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

public sealed class RuntimeSupervisorGuardianResidentIntegrationTests
{
    [Fact]
    public async Task Host_eof_closes_the_broker_and_resident_guardian_exits_cleanly_from_control_eof()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await StartedFixture.CreateAsync();
        await using var guardianSupervisor = new GuardianSupervisor();
        await using var image = await fixture.AdmitGuardianAsync();
        await using var guardian = await guardianSupervisor.StartResidentAsync(image, CancellationToken.None);
        await fixture.Host.AttachResidentGuardianAsync(guardian, CancellationToken.None);

        fixture.RequestHostExit();
        Assert.True(await fixture.Host.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.Equal(GuardianSupervisorExit.ControlClosed, await guardian.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)));
    }

    [Fact]
    public async Task Host_eof_while_native_role_is_queued_prevents_role_activation_and_cleanly_closes_guardian()
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
        await using var guardian = await guardianSupervisor.StartResidentAsync(image, CancellationToken.None);
        await fixture.Host.AttachResidentGuardianAsync(guardian, CancellationToken.None);

        File.WriteAllText(Path.Combine(fixture.Layout.DataRoot, "broker-eof-race.trigger"), "trigger");
        var queued = Path.Combine(fixture.Layout.DataRoot, "broker-eof-race.queued");
        var queuedDeadline = DateTimeOffset.UtcNow.AddSeconds(10);
        while (!File.Exists(queued) && DateTimeOffset.UtcNow < queuedDeadline) await Task.Delay(10);
        Assert.True(File.Exists(queued));
        fixture.RequestHostExit();

        await controlClosed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        File.WriteAllText(Path.Combine(barrierDirectory, "after-create.release"), "release");
        Assert.True(await fixture.Host.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.True(File.Exists(Path.Combine(barrierDirectory, "after-create.ready")));
        Assert.Equal(GuardianSupervisorExit.ControlClosed, await guardian.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)));
    }

    [Fact]
    public async Task Attach_failure_when_host_has_exited_closes_the_unattached_guardian_without_timeout_kill()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await StartedFixture.CreateAsync();
        fixture.RequestHostExit();
        Assert.True(await fixture.Host.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)));
        await using var guardianSupervisor = new GuardianSupervisor();
        await using var image = await fixture.AdmitGuardianAsync();
        await using var guardian = await guardianSupervisor.StartResidentAsync(image, CancellationToken.None);

        await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(() => fixture.Host.AttachResidentGuardianAsync(guardian, CancellationToken.None));
        await guardian.CloseControlAsync(CancellationToken.None);
        Assert.Equal(GuardianSupervisorExit.ControlClosed, await guardian.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)));
    }

    [Fact]
    public async Task Duplicate_and_cancelled_attach_failures_clean_up_unattached_guardians_with_control_eof()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var fixture = await StartedFixture.CreateAsync();
        await using var guardianSupervisor = new GuardianSupervisor();
        await using var firstImage = await fixture.AdmitGuardianAsync();
        await using var first = await guardianSupervisor.StartResidentAsync(firstImage, CancellationToken.None);
        await fixture.Host.AttachResidentGuardianAsync(first, CancellationToken.None);

        await using var duplicateImage = await fixture.AdmitGuardianAsync();
        await using var duplicate = await guardianSupervisor.StartResidentAsync(duplicateImage, CancellationToken.None);
        await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(() => fixture.Host.AttachResidentGuardianAsync(duplicate, CancellationToken.None));
        await duplicate.CloseControlAsync(CancellationToken.None);
        Assert.Equal(GuardianSupervisorExit.ControlClosed, await duplicate.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)));

        await using var cancelledImage = await fixture.AdmitGuardianAsync();
        await using var cancelled = await guardianSupervisor.StartResidentAsync(cancelledImage, CancellationToken.None);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Host.AttachResidentGuardianAsync(cancelled, cancellation.Token));
        await cancelled.CloseControlAsync(CancellationToken.None);
        Assert.Equal(GuardianSupervisorExit.ControlClosed, await cancelled.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)));
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
                var registration = new CurrentUserRootRegistrationRecord(CurrentUserRootRegistration.SchemaVersion, generation.ProgramRoot,
                    Path.Combine(generation.LocalApplicationData, "GameBuddy", "data"), Path.Combine(generation.LocalApplicationData, "GameBuddy", "operational"), Path.Combine(generation.LocalApplicationData, "GameBuddy", "presentation"));
                foreach (var path in new[] { registration.DataRoot, registration.OperationalRoot, registration.PresentationRoot }) Directory.CreateDirectory(path);
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
