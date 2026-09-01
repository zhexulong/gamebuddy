using GameBuddy.Desktop.Tests.Fixtures;

namespace GameBuddy.Desktop.Tests;

public sealed class GuardianSupervisorTests
{
    [Fact]
    public async Task StartResident_test_guardian_observes_exact_environment_only_stdin_inheritance_and_actual_eof()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        var executable = WindowsNative.CreateFile(generation.TestGuardianExePath, WindowsNative.FileReadData | WindowsNative.FileExecute, WindowsNative.FileShareRead, IntPtr.Zero, WindowsNative.OpenExisting, WindowsNative.FileAttributeNormal, IntPtr.Zero);
        Assert.False(executable.IsInvalid);
        Assert.True(WindowsNative.GetFileInformationByHandle(executable, out var identity));
        await using var image = new AdmittedGuardianImage(executable, generation.TestGuardianExePath, "test", identity);
        var pipeName = $"GameBuddy.Guardian.TestObservation.{Guid.NewGuid():N}";
        using var observation = new System.IO.Pipes.NamedPipeServerStream(pipeName, System.IO.Pipes.PipeDirection.In, 1, System.IO.Pipes.PipeTransmissionMode.Byte, System.IO.Pipes.PipeOptions.Asynchronous);
        await using var supervisor = new GuardianSupervisor { TestObservationPipeName = pipeName };
        await using var lease = await supervisor.StartResidentAsync(image, CancellationToken.None);
        await observation.WaitForConnectionAsync().WaitAsync(TimeSpan.FromSeconds(10));
        using var reader = new StreamReader(observation);
        var lines = new List<string>();
        while (lines.Count < 4) lines.Add((await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10)))!);

        Assert.Equal("allowed_environment=true", lines[1]);
        Assert.Equal("startup_stdin=stdin", lines[2]);
        Assert.Equal("stdin_only=true", lines[3]);
        Assert.DoesNotContain("LAUNCHER_SECRET_SENTINEL", lines[0], StringComparison.Ordinal);
        Assert.DoesNotContain("GAMEBUDDY_GUARDIAN_TEST", lines[0], StringComparison.Ordinal);

        await lease.CloseControlAsync(CancellationToken.None);
        Assert.Equal(GuardianSupervisorExit.ControlClosed, await lease.WaitForExitAsync(CancellationToken.None));
    }

    [Fact]
    public async Task StartResident_host_published_guardian_receives_stdin_eof_when_parent_control_writer_closes()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        var admission = new InstalledGenerationAdmission(generation.ProgramRoot);
        await using var image = await admission.AdmitGuardianAsync(CancellationToken.None);
        await using var supervisor = new GuardianSupervisor();
        await using var lease = await supervisor.StartResidentAsync(image, CancellationToken.None);

        await lease.CloseControlAsync(CancellationToken.None);

        Assert.Equal(GuardianSupervisorExit.ControlClosed, await lease.WaitForExitAsync(CancellationToken.None));
    }

    [Fact]
    public async Task StartResident_keeps_the_host_admitted_executable_locked_and_does_not_reresolve_current_during_native_create_window()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        var admission = new InstalledGenerationAdmission(generation.ProgramRoot);
        await using var image = await admission.AdmitGuardianAsync(CancellationToken.None);
        await using var supervisor = new GuardianSupervisor();
        var reachedCreate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseCreate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        supervisor.BeforeNativeCreateForTesting = async () => { reachedCreate.SetResult(); await releaseCreate.Task.ConfigureAwait(false); };

        var start = supervisor.StartResidentAsync(image, CancellationToken.None);
        try
        {
            await reachedCreate.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.ThrowsAny<IOException>(() => File.Delete(generation.GuardianExePath));
            Assert.ThrowsAny<IOException>(() => File.Move(generation.GuardianExePath, generation.GuardianExePath + ".replacement"));
            // The no-delete share lock intentionally also prevents moving an
            // ancestor containing the admitted image; exact image identity is
            // already proven by the failed delete/move operations above.
            releaseCreate.SetResult();
            await using var lease = await start;
            Assert.Equal(image.VerifiedAbsolutePath, lease.ExecutablePath, ignoreCase: true);
            await lease.CloseControlAsync(CancellationToken.None);
            Assert.Equal(GuardianSupervisorExit.ControlClosed, await lease.WaitForExitAsync(CancellationToken.None));
        }
        finally
        {
            releaseCreate.TrySetResult();
            try { await start.WaitAsync(TimeSpan.FromSeconds(10)); } catch { }
        }
    }

    [Fact]
    public async Task StartResident_launches_only_the_host_admitted_executable()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        var admission = new InstalledGenerationAdmission(generation.ProgramRoot);
        await using var image = await admission.AdmitGuardianAsync(CancellationToken.None);
        await using var supervisor = new GuardianSupervisor();
        await using var lease = await supervisor.StartResidentAsync(image, CancellationToken.None);

        Assert.Equal(image.VerifiedAbsolutePath, lease.ExecutablePath, ignoreCase: true);
        await lease.CloseControlAsync(CancellationToken.None);
        Assert.Equal(GuardianSupervisorExit.ControlClosed, await lease.WaitForExitAsync(CancellationToken.None));
    }
}
