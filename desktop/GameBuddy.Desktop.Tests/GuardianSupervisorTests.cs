using GameBuddy.Desktop.Tests.Fixtures;

namespace GameBuddy.Desktop.Tests;

public sealed class GuardianSupervisorTests
{
    [Fact]
    public void Guardian_supervisor_source_frees_an_uninitialized_attribute_list_without_deleting_it()
    {
        var source = File.ReadAllText(Source());
        var initialize = source.IndexOf("if (!WindowsNative.InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize))", StringComparison.Ordinal);
        var failure = source.IndexOf("WindowsNative.ThrowLastError(\"guardian_launch_unavailable\");", initialize, StringComparison.Ordinal);
        var initialized = source.IndexOf("attributeListInitialized = true;", failure, StringComparison.Ordinal);
        var cleanup = source.IndexOf("if (attributeList != IntPtr.Zero)", initialized, StringComparison.Ordinal);
        var delete = source.IndexOf("if (attributeListInitialized) WindowsNative.DeleteProcThreadAttributeList(attributeList);", cleanup, StringComparison.Ordinal);
        var free = source.IndexOf("Marshal.FreeHGlobal(attributeList);", delete, StringComparison.Ordinal);

        Assert.True(initialize >= 0 && failure > initialize && initialized > failure && cleanup > initialized && delete > cleanup && free > delete);
    }

    [Fact]
    public void Guardian_supervisor_source_terminates_and_waits_before_disposing_untransferred_process_handles()
    {
        var source = File.ReadAllText(Source());
        var cleanup = source.IndexOf("if (createdProcess is not null)", StringComparison.Ordinal);
        var terminate = source.IndexOf("await TerminateAndWaitForExitAsync(createdProcess)", cleanup, StringComparison.Ordinal);
        var dispose = source.IndexOf("createdProcess.Dispose()", cleanup, StringComparison.Ordinal);

        Assert.True(cleanup >= 0 && terminate > cleanup && dispose > terminate);
        Assert.Contains("WindowsNative.TerminateProcess(process, 1)", source, StringComparison.Ordinal);
        Assert.Contains("WindowsNative.WaitForSingleObject(process, 30_000)", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Guardian_lease_source_terminates_after_eof_timeout_before_releasing_process_handle()
    {
        var source = File.ReadAllText(Source());
        var dispose = source.IndexOf("public async ValueTask DisposeAsync()", StringComparison.Ordinal);
        var unavailable = source.IndexOf("is GuardianSupervisorExit.Unavailable", dispose, StringComparison.Ordinal);
        var terminate = source.IndexOf("WindowsNative.TerminateProcess(process, 1)", dispose, StringComparison.Ordinal);
        var wait = source.IndexOf("WindowsNative.WaitForSingleObject(process, 30_000)", terminate, StringComparison.Ordinal);
        var release = source.IndexOf("process.Dispose()", wait, StringComparison.Ordinal);

        Assert.True(dispose >= 0 && unavailable > dispose && terminate > unavailable && wait > terminate && release > wait);
    }

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
        Assert.Equal("stdin_only=false", lines[3]);
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
        await using var selection = InstalledGenerationSelection.Acquire(generation.ProgramRoot);
        await using var image = await admission.AdmitGuardianAsync(selection, CancellationToken.None);
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
        await using var selection = InstalledGenerationSelection.Acquire(generation.ProgramRoot);
        await using var image = await admission.AdmitGuardianAsync(selection, CancellationToken.None);
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
        await using var selection = InstalledGenerationSelection.Acquire(generation.ProgramRoot);
        await using var image = await admission.AdmitGuardianAsync(selection, CancellationToken.None);
        await using var supervisor = new GuardianSupervisor();
        await using var lease = await supervisor.StartResidentAsync(image, CancellationToken.None);

        Assert.Equal(image.VerifiedAbsolutePath, lease.ExecutablePath, ignoreCase: true);
        await lease.CloseControlAsync(CancellationToken.None);
        Assert.Equal(GuardianSupervisorExit.ControlClosed, await lease.WaitForExitAsync(CancellationToken.None));
    }

    private static string Source() => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "GuardianSupervisor.cs"));
}
