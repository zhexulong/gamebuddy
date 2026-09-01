using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace GameBuddy.Desktop;

internal enum GuardianSupervisorExit { ControlClosed, Unavailable }

internal sealed class GuardianSupervisor : IAsyncDisposable
{
    // Test-only hooks; production entrypoint neither sets nor exposes them.
    internal Func<Task>? BeforeNativeCreateForTesting { get; set; }
    internal string? TestObservationPipeName { get; set; }

    internal async Task<GuardianSupervisorLease> StartResidentAsync(AdmittedGuardianImage image, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(image);
        cancellationToken.ThrowIfCancellationRequested();
        SafeFileHandle? reader = null;
        SafeFileHandle? writer = null;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr attributeSize = IntPtr.Zero;
        IntPtr handleList = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        try
        {
            image.VerifyStillLockedForCreate();
            CreateControlPipe(out reader, out writer);
            var environmentBlock = BuildGuardianEnvironment(TestObservationPipeName);
            environment = Marshal.StringToHGlobalUni(environmentBlock);
            _ = WindowsNative.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            attributeList = Marshal.AllocHGlobal(attributeSize);
            if (!WindowsNative.InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize)) WindowsNative.ThrowLastError("guardian_launch_unavailable");
            handleList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(handleList, reader.DangerousGetHandle());
            if (!WindowsNative.UpdateProcThreadAttribute(attributeList, 0, (IntPtr)WindowsNative.ProcThreadAttributeHandleList, handleList, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) WindowsNative.ThrowLastError("guardian_launch_unavailable");
            if (BeforeNativeCreateForTesting is not null) await BeforeNativeCreateForTesting().ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            image.VerifyStillLockedForCreate();
            var startup = new WindowsNative.StartupInfoEx
            {
                StartupInfo = new WindowsNative.StartupInfo
                {
                    // CreateProcessW receives STARTUPINFOEX because EXTENDED_STARTUPINFO_PRESENT is set.
                    cb = (uint)Marshal.SizeOf<WindowsNative.StartupInfoEx>(),
                    dwFlags = WindowsNative.StartfUseStdHandles,
                    hStdInput = reader.DangerousGetHandle(),
                    hStdOutput = IntPtr.Zero,
                    hStdError = IntPtr.Zero,
                },
                AttributeList = attributeList,
            };
            // CreateProcessW otherwise applies MAX_PATH to the same long installed
            // generation path admitted through the locked handle.
            var executablePath = WindowsNative.ToExtendedLengthPath(image.VerifiedAbsolutePath);
            var commandLine = new StringBuilder(Quote(executablePath));
            if (!WindowsNative.CreateProcess(executablePath, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                WindowsNative.ExtendedStartupInfoPresent | WindowsNative.CreateUnicodeEnvironment, environment, null, ref startup, out var processInformation)) WindowsNative.ThrowLastError("guardian_launch_unavailable");
            using var thread = new WindowsNative.SafeProcessHandle(processInformation.Thread);
            reader.Dispose();
            reader = null;
            var process = new WindowsNative.SafeProcessHandle(processInformation.Process);
            try
            {
                VerifyCreatedProcessIdentity(process, image);
                var lease = new GuardianSupervisorLease(process, writer, image.VerifiedAbsolutePath);
                process = null!;
                writer = null;
                return lease;
            }
            finally
            {
                process?.Dispose();
            }
        }
        catch (GuardianLaunchUnavailableException) { throw; }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or OutOfMemoryException)
        {
            throw new GuardianLaunchUnavailableException(innerException: exception);
        }
        finally
        {
            if (attributeList != IntPtr.Zero) { _ = WindowsNative.DeleteProcThreadAttributeList(attributeList); Marshal.FreeHGlobal(attributeList); }
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            reader?.Dispose();
            writer?.Dispose();
        }
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private static void CreateControlPipe(out SafeFileHandle reader, out SafeFileHandle writer)
    {
        if (!WindowsNative.CreatePipe(out reader, out writer, IntPtr.Zero, 0)) WindowsNative.ThrowLastError("guardian_launch_unavailable");
        if (!WindowsNative.SetHandleInformation(reader, WindowsNative.HandleFlagInherit, WindowsNative.HandleFlagInherit) ||
            !WindowsNative.SetHandleInformation(writer, WindowsNative.HandleFlagInherit, 0))
        {
            reader.Dispose(); writer.Dispose(); WindowsNative.ThrowLastError("guardian_launch_unavailable");
        }
    }

    private static string BuildGuardianEnvironment(string? testObservationPipeName)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["SystemRoot"] = RequiredEnvironment("SystemRoot"),
            ["TEMP"] = RequiredEnvironment("TEMP"),
            ["TMP"] = RequiredEnvironment("TMP"),
            ["GAMEBUDDY_GUARDIAN_MODE"] = "resident",
            ["GAMEBUDDY_GUARDIAN_CONTROL_PIPE"] = testObservationPipeName ?? $"GameBuddy.Guardian.{Guid.NewGuid():N}",
            ["GAMEBUDDY_GUARDIAN_CONTROL_TOKEN"] = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant(),
        };
        if (testObservationPipeName is not null && !testObservationPipeName.StartsWith("GameBuddy.Guardian.TestObservation.", StringComparison.Ordinal)) throw new InvalidOperationException("Invalid test observation pipe.");
        return string.Concat(values.OrderBy(item => item.Key, StringComparer.OrdinalIgnoreCase).Select(item => $"{item.Key}={item.Value}\0")) + "\0";
    }

    private static string RequiredEnvironment(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(value) || value.Contains('\0')) throw new GuardianLaunchUnavailableException();
        return value;
    }

    private static void VerifyCreatedProcessIdentity(WindowsNative.SafeProcessHandle process, AdmittedGuardianImage image)
    {
        var buffer = new char[32768];
        uint length = (uint)buffer.Length;
        if (!WindowsNative.QueryFullProcessImageName(process, 0, buffer, ref length) || length == 0 ||
            !StringComparer.OrdinalIgnoreCase.Equals(Path.GetFullPath(new string(buffer, 0, checked((int)length))), image.VerifiedAbsolutePath))
        {
            throw new GuardianLaunchUnavailableException();
        }
    }

    private static string Quote(string value) => $"\"{value.Replace("\"", "\\\"")}\"";
}

internal sealed class GuardianSupervisorLease : IAsyncDisposable
{
    private SafeFileHandle? controlWriter;
    private readonly WindowsNative.SafeProcessHandle process;
    private bool closed;

    internal GuardianSupervisorLease(WindowsNative.SafeProcessHandle process, SafeFileHandle controlWriter, string executablePath)
    {
        this.process = process;
        this.controlWriter = controlWriter;
        ExecutablePath = executablePath;
    }

    internal string ExecutablePath { get; }

    internal Task CloseControlAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!closed)
        {
            closed = true;
            Interlocked.Exchange(ref controlWriter, null)?.Dispose();
        }
        return Task.CompletedTask;
    }

    internal Task<GuardianSupervisorExit> WaitForExitAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var result = WindowsNative.WaitForSingleObject(process, 30_000);
        if (result == WindowsNative.WaitTimeout) return Task.FromResult(GuardianSupervisorExit.Unavailable);
        if (result != WindowsNative.WaitObject0 || !WindowsNative.GetExitCodeProcess(process, out _)) return Task.FromResult(GuardianSupervisorExit.Unavailable);
        return Task.FromResult(closed ? GuardianSupervisorExit.ControlClosed : GuardianSupervisorExit.Unavailable);
    }

    public async ValueTask DisposeAsync()
    {
        await CloseControlAsync(CancellationToken.None).ConfigureAwait(false);
        _ = await WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
        process.Dispose();
    }
}
