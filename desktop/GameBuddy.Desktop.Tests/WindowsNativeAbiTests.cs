using System.Runtime.InteropServices;
using System.Text;

namespace GameBuddy.Desktop.Tests;

public sealed class WindowsNativeAbiTests
{
    [Fact]
    public void StartupInfoEx_has_the_native_pointer_sized_layout_required_by_CreateProcessW()
    {
        Assert.Equal(IntPtr.Size == 8 ? 104 : 68, Marshal.SizeOf<WindowsNative.StartupInfo>());
        Assert.Equal(IntPtr.Size == 8 ? 112 : 72, Marshal.SizeOf<WindowsNative.StartupInfoEx>());

        Assert.Equal(IntPtr.Size == 8 ? 72 : 52, Marshal.OffsetOf<WindowsNative.StartupInfo>(nameof(WindowsNative.StartupInfo.lpReserved2)).ToInt32());
        Assert.Equal(IntPtr.Size == 8 ? 80 : 56, Marshal.OffsetOf<WindowsNative.StartupInfo>(nameof(WindowsNative.StartupInfo.hStdInput)).ToInt32());
        Assert.Equal(IntPtr.Size == 8 ? 88 : 60, Marshal.OffsetOf<WindowsNative.StartupInfo>(nameof(WindowsNative.StartupInfo.hStdOutput)).ToInt32());
        Assert.Equal(IntPtr.Size == 8 ? 96 : 64, Marshal.OffsetOf<WindowsNative.StartupInfo>(nameof(WindowsNative.StartupInfo.hStdError)).ToInt32());
        Assert.Equal(Marshal.SizeOf<WindowsNative.StartupInfo>(), Marshal.OffsetOf<WindowsNative.StartupInfoEx>(nameof(WindowsNative.StartupInfoEx.AttributeList)).ToInt32());
    }

    [Fact]
    public void Extended_length_path_preserves_the_admitted_absolute_target()
    {
        const string admitted = @"C:\\Users\\player\\AppData\\Local\\Programs\\GameBuddy\\generations\\g-mtiugve1-73288-0a0d298406044e94b65d4b9e4e0108d6\\native\\windows-stardew-bootstrap-guardian\\win-x64\\GameBuddy.WindowsStardewBootstrapGuardian.exe";

        Assert.Equal(@"\\?\" + admitted, WindowsNative.ToExtendedLengthPath(admitted));
        Assert.Equal(@"\\?\C:\\already-extended.exe", WindowsNative.ToExtendedLengthPath(@"\\?\C:\\already-extended.exe"));
    }

    [Fact]
    public void Admitted_runtime_files_request_execute_access_with_documented_read_only_sharing()
    {
        var nativeSource = File.ReadAllText(DesktopSource("WindowsNative.cs"));
        var admissionSource = File.ReadAllText(DesktopSource("InstalledHostRuntimeAdmission.cs"));

        Assert.Contains("internal const uint FileExecute = 0x0020", nativeSource, StringComparison.Ordinal);
        Assert.DoesNotContain("FileShareExecute", nativeSource, StringComparison.Ordinal);
        Assert.Contains("WindowsNative.FileReadData | WindowsNative.FileExecute, WindowsNative.FileShareRead", admissionSource, StringComparison.Ordinal);
        Assert.DoesNotContain("FileShareWrite", admissionSource, StringComparison.Ordinal);
        Assert.DoesNotContain("FileShareDelete", admissionSource, StringComparison.Ordinal);
    }

    [Fact]
    public void Windows_CreateFileW_read_share_handle_allows_direct_CreateProcessW_of_a_disposable_fixture()
    {
        if (!OperatingSystem.IsWindows()) return;

        var directory = Path.Combine(Path.GetTempPath(), "GameBuddy.Desktop.Tests", "WindowsNativeAbi", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var executable = Path.Combine(directory, "RoleRootFixture.exe");
            File.Copy(DisposableFixtureExecutable(), executable);
            var report = Path.Combine(directory, "report.txt");
            using var admitted = WindowsNative.CreateFile(
                WindowsNative.ToExtendedLengthPath(executable),
                WindowsNative.FileReadData | WindowsNative.FileExecute,
                WindowsNative.FileShareRead,
                IntPtr.Zero,
                WindowsNative.OpenExisting,
                WindowsNative.FileAttributeNormal,
                IntPtr.Zero);
            Assert.False(admitted.IsInvalid);

            var startup = new WindowsNative.StartupInfoEx
            {
                StartupInfo = new WindowsNative.StartupInfo { cb = (uint)Marshal.SizeOf<WindowsNative.StartupInfo>() },
            };
            var nativeExecutable = WindowsNative.ToExtendedLengthPath(executable);
            var commandLine = new StringBuilder($"\"{nativeExecutable}\" --signal \"{report}\" --exit-after-report");
            Assert.True(WindowsNative.CreateProcess(
                nativeExecutable,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                WindowsNative.CreateUnicodeEnvironment,
                IntPtr.Zero,
                directory,
                ref startup,
                out var processInformation));
            using var process = new WindowsNative.SafeProcessHandle(processInformation.Process);
            using var thread = new WindowsNative.SafeProcessHandle(processInformation.Thread);
            Assert.Equal(WindowsNative.WaitObject0, WindowsNative.WaitForSingleObject(process, 10_000));
            Assert.True(WindowsNative.GetExitCodeProcess(process, out var exitCode));
            Assert.Equal(0u, exitCode);
            Assert.Matches("^member=(true|false)\\n$", File.ReadAllText(report));
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task Windows_synchronous_bootstrap_pipe_io_writes_reads_closes_and_cancels_without_an_async_handle_mode()
    {
        if (!OperatingSystem.IsWindows()) return;

        Assert.True(WindowsNative.CreatePipe(out var reader, out var writer, IntPtr.Zero, 0));
        using (reader)
        using (writer)
        {
            var payload = "bootstrap-frame"u8.ToArray();
            var read = HostBootstrapPipeIo.ReadOneFrameAsync(reader, 32_768, CancellationToken.None);
            await HostBootstrapPipeIo.WriteOneFrameAsync(writer, payload, CancellationToken.None);
            writer.Dispose();
            Assert.Equal(payload, await read);
        }

        Assert.True(WindowsNative.CreatePipe(out var blockedReader, out var blockedWriter, IntPtr.Zero, 0));
        using (blockedReader)
        using (blockedWriter)
        using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2)))
        {
            var blockedRead = HostBootstrapPipeIo.ReadOneFrameAsync(blockedReader, 32_768, timeout.Token);
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => blockedRead);
            Assert.True(blockedReader.IsClosed);
        }
    }

    [Fact]
    public void Runtime_supervisor_uses_the_native_token_and_process_identity_abi()
    {
        var source = File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "WindowsNative.cs")));

        Assert.Contains("internal static extern uint GetProcessId(SafeProcessHandle process)", source, StringComparison.Ordinal);
        Assert.Contains("OpenProcessToken(SafeProcessHandle processHandle", source, StringComparison.Ordinal);
        Assert.Contains("GetTokenInformation(SafeAccessTokenHandle tokenHandle", source, StringComparison.Ordinal);
        Assert.Contains("internal static extern bool EqualSid", source, StringComparison.Ordinal);
        Assert.Contains("internal const int TokenUser = 1", source, StringComparison.Ordinal);
        Assert.Contains("internal static extern bool CancelSynchronousIo(SafeThreadHandle thread)", source, StringComparison.Ordinal);
        Assert.Contains("internal static extern bool DuplicateHandle", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Runtime_supervisor_source_sets_cb_to_the_actual_StartupInfoEx_size()
    {
        var source = File.ReadAllText(DesktopSource("RuntimeSupervisor.cs"));

        Assert.Contains("cb = (uint)Marshal.SizeOf<WindowsNative.StartupInfoEx>()", source, StringComparison.Ordinal);
        Assert.Contains("var runtimePath = WindowsNative.ToExtendedLengthPath(runtime.RuntimePath)", source, StringComparison.Ordinal);
        Assert.Contains("new StringBuilder(Quote(WindowsNative.ToExtendedLengthPath(runtime.BootstrapPath)))", source, StringComparison.Ordinal);
        Assert.Contains("WindowsNative.ExtendedStartupInfoPresent | WindowsNative.CreateUnicodeEnvironment", source, StringComparison.Ordinal);
    }

    private static string DesktopSource(string fileName) => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", fileName));

    private static string DisposableFixtureExecutable()
    {
        var path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "host", "native", "windows-stardew-bootstrap-guardian", ".dist", "fixtures", "RoleRootFixture.exe"));
        Assert.True(File.Exists(path), $"The Windows-native ABI fixture is unavailable: {path}");
        return path;
    }
}
