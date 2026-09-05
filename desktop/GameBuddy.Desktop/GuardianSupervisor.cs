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

    internal async Task<GuardianSupervisorLease> StartResidentAsync(AdmittedGuardianImage image, CancellationToken cancellationToken) =>
        new(await StartGuardianAsync(image, "resident", cancellationToken).ConfigureAwait(false));

    internal async Task<GuardianRecoverySupervisorLease> StartRecoveryAsync(AdmittedGuardianImage image, CancellationToken cancellationToken) =>
        new(await StartGuardianAsync(image, "recovery", cancellationToken).ConfigureAwait(false));

    private async Task<GuardianProcessResources> StartGuardianAsync(AdmittedGuardianImage image, string mode, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(image);
        if (mode is not ("resident" or "recovery")) throw new ArgumentOutOfRangeException(nameof(mode));
        cancellationToken.ThrowIfCancellationRequested();
        SafeFileHandle? reader = null;
        SafeFileHandle? writer = null;
        SafeFileHandle? stdoutReader = null;
        SafeFileHandle? stdoutWriter = null;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr attributeSize = IntPtr.Zero;
        var attributeListInitialized = false;
        IntPtr handleList = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        WindowsNative.SafeProcessHandle? createdProcess = null;
        GuardianPrivateIngress? privateIngress = null;
        try
        {
            image.VerifyStillLockedForCreate();
            CreateControlPipe(out reader, out writer);
            CreateOutputPipe(out stdoutReader, out stdoutWriter);
            privateIngress = GuardianPrivateIngress.Create(mode == "resident" ? TestObservationPipeName : null);
            var environmentBlock = BuildGuardianEnvironment(privateIngress, mode);
            environment = Marshal.StringToHGlobalUni(environmentBlock);
            _ = WindowsNative.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            attributeList = Marshal.AllocHGlobal(attributeSize);
            if (!WindowsNative.InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize)) WindowsNative.ThrowLastError("guardian_launch_unavailable");
            attributeListInitialized = true;
            handleList = Marshal.AllocHGlobal(checked(IntPtr.Size * 2));
            Marshal.WriteIntPtr(handleList, 0, reader.DangerousGetHandle());
            Marshal.WriteIntPtr(handleList, IntPtr.Size, stdoutWriter.DangerousGetHandle());
            if (!WindowsNative.UpdateProcThreadAttribute(attributeList, 0, (IntPtr)WindowsNative.ProcThreadAttributeHandleList, handleList, (IntPtr)(IntPtr.Size * 2), IntPtr.Zero, IntPtr.Zero)) WindowsNative.ThrowLastError("guardian_launch_unavailable");
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
                    hStdOutput = stdoutWriter.DangerousGetHandle(),
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
            createdProcess = new WindowsNative.SafeProcessHandle(processInformation.Process);
            using var thread = new WindowsNative.SafeProcessHandle(processInformation.Thread);
            reader.Dispose();
            reader = null;
            stdoutWriter.Dispose();
            stdoutWriter = null;
            VerifyCreatedProcessIdentity(createdProcess, image);
            var resources = new GuardianProcessResources(createdProcess, writer, stdoutReader, privateIngress, image.VerifiedAbsolutePath);
            createdProcess = null;
            writer = null;
            stdoutReader = null;
            privateIngress = null;
            return resources;
        }
        catch (GuardianLaunchUnavailableException) { throw; }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or OutOfMemoryException)
        {
            throw new GuardianLaunchUnavailableException(innerException: exception);
        }
        finally
        {
            if (attributeList != IntPtr.Zero)
            {
                if (attributeListInitialized) WindowsNative.DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (createdProcess is not null)
            {
                await TerminateAndWaitForExitAsync(createdProcess).ConfigureAwait(false);
                createdProcess.Dispose();
            }
            privateIngress?.Dispose();
            reader?.Dispose();
            writer?.Dispose();
            stdoutReader?.Dispose();
            stdoutWriter?.Dispose();
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

    private static void CreateOutputPipe(out SafeFileHandle reader, out SafeFileHandle writer)
    {
        if (!WindowsNative.CreatePipe(out reader, out writer, IntPtr.Zero, 0)) WindowsNative.ThrowLastError("guardian_launch_unavailable");
        if (!WindowsNative.SetHandleInformation(reader, WindowsNative.HandleFlagInherit, 0) ||
            !WindowsNative.SetHandleInformation(writer, WindowsNative.HandleFlagInherit, WindowsNative.HandleFlagInherit))
        {
            reader.Dispose(); writer.Dispose(); WindowsNative.ThrowLastError("guardian_launch_unavailable");
        }
    }

    private static string BuildGuardianEnvironment(GuardianPrivateIngress privateIngress, string mode)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["SystemRoot"] = RequiredEnvironment("SystemRoot"),
            ["TEMP"] = RequiredEnvironment("TEMP"),
            ["TMP"] = RequiredEnvironment("TMP"),
            ["GAMEBUDDY_GUARDIAN_MODE"] = mode,
            ["GAMEBUDDY_GUARDIAN_CONTROL_PIPE"] = privateIngress.PipeName,
            ["GAMEBUDDY_GUARDIAN_CONTROL_TOKEN"] = privateIngress.Token,
        };
        return string.Concat(values.OrderBy(item => item.Key, StringComparer.OrdinalIgnoreCase).Select(item => $"{item.Key}={item.Value}\0")) + "\0";
    }

    private static string RequiredEnvironment(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(value) || value.Contains('\0')) throw new GuardianLaunchUnavailableException();
        return value;
    }

    private static async Task TerminateAndWaitForExitAsync(WindowsNative.SafeProcessHandle process)
    {
        _ = WindowsNative.TerminateProcess(process, 1);
        _ = await Task.Run(() => WindowsNative.WaitForSingleObject(process, 30_000), CancellationToken.None).ConfigureAwait(false);
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

internal sealed record GuardianProcessResources(WindowsNative.SafeProcessHandle Process, SafeFileHandle ControlWriter, SafeFileHandle PublicOutput, GuardianPrivateIngress PrivateIngress, string ExecutablePath);

internal sealed class GuardianSupervisorLease : IAsyncDisposable
{
    private const int MaxNativeFrameBytes = 16_384;
    private SafeFileHandle? controlWriter;
    private SafeFileHandle? publicOutput;
    private readonly WindowsNative.SafeProcessHandle process;
    private readonly GuardianPrivateIngress privateIngress;
    private readonly SemaphoreSlim relayGate = new(1, 1);
    private bool closed;
    private FileStream? publicInputStream;
    private FileStream? publicOutputStream;

    internal GuardianSupervisorLease(GuardianProcessResources resources)
    {
        process = resources.Process;
        controlWriter = resources.ControlWriter;
        publicOutput = resources.PublicOutput;
        privateIngress = resources.PrivateIngress;
        ExecutablePath = resources.ExecutablePath;
    }

    internal string ExecutablePath { get; }

    internal async Task<GuardianRelayResult> RelayResidentAsync(GuardianRelayCommand command, CancellationToken cancellationToken)
    {
        var relayGateHeld = false;
        try
        {
            using var deadline = command.BindDeadline(cancellationToken);
            var commandCancellation = deadline.Token;
            await relayGate.WaitAsync(commandCancellation).ConfigureAwait(false);
            relayGateHeld = true;
            if (closed) throw new GuardianLaunchUnavailableException();
            command.ThrowIfExpired(commandCancellation);
            await WritePublicCommandAsync(command, commandCancellation).ConfigureAwait(false);
            if (command.Operation is "arm_attempt" or "launch_role")
            {
                command.ThrowIfExpired(commandCancellation);
                var ingress = await privateIngress.ConnectAsync(commandCancellation).ConfigureAwait(false);
                var privateFrame = command.Operation == "arm_attempt"
                    ? privateIngress.InjectArmToken(command.PrivateFrame!)
                    : command.PrivateFrame!;
                command.ThrowIfExpired(commandCancellation);
                await ingress.WriteAsync(privateFrame, commandCancellation).ConfigureAwait(false);
                command.ThrowIfExpired(commandCancellation);
                await ingress.WriteAsync(new byte[] { (byte)'\n' }, commandCancellation).ConfigureAwait(false);
                command.ThrowIfExpired(commandCancellation);
                await ingress.FlushAsync(commandCancellation).ConfigureAwait(false);
                command.ThrowIfExpired(commandCancellation);
                if (await ReadLineAsync(ingress, commandCancellation).ConfigureAwait(false) != "accepted") throw new GuardianLaunchUnavailableException();
            }
            var expected = command.Operation switch { "arm_attempt" => "armed", "launch_role" => "role_active", "contain_role" => "role_contained", _ => throw new GuardianLaunchUnavailableException() };
            command.ThrowIfExpired(commandCancellation);
            if (await ReadPublicResultAsync(commandCancellation).ConfigureAwait(false) != expected) throw new GuardianLaunchUnavailableException();
            return new GuardianRelayResult(expected);
        }
        catch
        {
            await CloseControlAsync(CancellationToken.None).ConfigureAwait(false);
            throw;
        }
        finally
        {
            if (relayGateHeld) relayGate.Release();
        }
    }

    internal Task CloseControlAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!closed)
        {
            closed = true;
            Interlocked.Exchange(ref controlWriter, null)?.Dispose();
            Interlocked.Exchange(ref publicOutput, null)?.Dispose();
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
        if (await WaitForExitAsync(CancellationToken.None).ConfigureAwait(false) is GuardianSupervisorExit.Unavailable)
        {
            _ = WindowsNative.TerminateProcess(process, 1);
            _ = await Task.Run(() => WindowsNative.WaitForSingleObject(process, 30_000), CancellationToken.None).ConfigureAwait(false);
        }
        publicInputStream?.Dispose();
        publicOutputStream?.Dispose();
        privateIngress.Dispose();
        process.Dispose();
        relayGate.Dispose();
    }

    private async Task WritePublicCommandAsync(GuardianRelayCommand command, CancellationToken cancellationToken)
    {
        var writer = controlWriter ?? throw new GuardianLaunchUnavailableException();
        var stream = publicInputStream ??= new FileStream(writer, FileAccess.Write, bufferSize: 4096, isAsync: true);
        await stream.WriteAsync(command.ToNativeFrame(), cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task<string> ReadPublicResultAsync(CancellationToken cancellationToken)
    {
        var output = publicOutput ?? throw new GuardianLaunchUnavailableException();
        var stream = publicOutputStream ??= new FileStream(output, FileAccess.Read, bufferSize: 4096, isAsync: true);
        var line = await ReadLineAsync(stream, cancellationToken).ConfigureAwait(false);
        using var document = System.Text.Json.JsonDocument.Parse(line);
        var root = document.RootElement;
        if (root.ValueKind != System.Text.Json.JsonValueKind.Object || !root.EnumerateObject().Select(value => value.Name).SequenceEqual(new[] { "schemaVersion", "result" }, StringComparer.Ordinal) || root.GetProperty("schemaVersion").GetInt32() != 1 || root.GetProperty("result").ValueKind != System.Text.Json.JsonValueKind.String) throw new GuardianLaunchUnavailableException();
        return root.GetProperty("result").GetString()!;
    }

    internal static async Task<string> ReadLineAsync(Stream stream, CancellationToken cancellationToken)
    {
        using var output = new MemoryStream();
        var one = new byte[1];
        while (output.Length < MaxNativeFrameBytes)
        {
            if (await stream.ReadAsync(one, cancellationToken).ConfigureAwait(false) != 1) throw new GuardianLaunchUnavailableException();
            if (one[0] is (byte)'\r' or 0) throw new GuardianLaunchUnavailableException();
            if (one[0] == (byte)'\n') return Encoding.UTF8.GetString(output.ToArray());
            output.WriteByte(one[0]);
        }
        throw new GuardianLaunchUnavailableException();
    }
}

internal sealed class GuardianPrivateIngress : IDisposable
{
    private readonly string token;
    private System.IO.Pipes.NamedPipeClientStream? stream;
    private GuardianPrivateIngress(string pipeName, string token) { PipeName = pipeName; this.token = token; }
    internal string PipeName { get; }
    internal string Token => token;
    internal static GuardianPrivateIngress Create(string? testObservationPipeName)
    {
        if (testObservationPipeName is not null && !testObservationPipeName.StartsWith("GameBuddy.Guardian.TestObservation.", StringComparison.Ordinal)) throw new InvalidOperationException("Invalid test observation pipe.");
        return new GuardianPrivateIngress(testObservationPipeName ?? $"GameBuddy.Guardian.{Guid.NewGuid():N}", Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant());
    }
    internal async Task<System.IO.Pipes.NamedPipeClientStream> ConnectAsync(CancellationToken cancellationToken)
    {
        if (stream is not null) return stream;
        var candidate = new System.IO.Pipes.NamedPipeClientStream(".", PipeName, System.IO.Pipes.PipeDirection.InOut, System.IO.Pipes.PipeOptions.Asynchronous);
        try { await candidate.ConnectAsync(cancellationToken).ConfigureAwait(false); stream = candidate; return candidate; } catch { await candidate.DisposeAsync().ConfigureAwait(false); throw; }
    }
    internal byte[] InjectArmToken(byte[] body) => InjectToken(body);
    internal byte[] InjectRecoveryToken(byte[] body) => InjectToken(body);
    private byte[] InjectToken(byte[] body)
    {
        if (body.Length < 2 || body[0] != (byte)'{' || body[^1] != (byte)'}' || body.Contains((byte)'\n') || body.Contains((byte)'\r') || body.Contains((byte)0) || Encoding.UTF8.GetString(body).Contains("\"token\"", StringComparison.Ordinal)) throw new GuardianLaunchUnavailableException();
        var prefix = Encoding.UTF8.GetBytes($"{{\"token\":\"{token}\",");
        return prefix.Concat(body[1..]).ToArray();
    }
    public void Dispose() => stream?.Dispose();
}

internal sealed record GuardianRelayResult(string Status);
internal sealed record GuardianRelayCommand(string Operation, string GuardianInstanceId, int GuardianEpoch, string AttemptId, string? Role, byte[]? PrivateFrame, long DeadlineUnixMs)
{
    internal CancellationTokenSource BindDeadline(CancellationToken cancellationToken)
    {
        ThrowIfExpired(cancellationToken);
        var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var remaining = TimeSpan.FromMilliseconds(DeadlineUnixMs - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        if (remaining <= TimeSpan.Zero)
        {
            deadline.Dispose();
            throw new OperationCanceledException(cancellationToken);
        }
        deadline.CancelAfter(remaining);
        return deadline;
    }

    internal void ThrowIfExpired(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (DeadlineUnixMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) throw new OperationCanceledException(cancellationToken);
    }

    internal byte[] ToNativeFrame()
    {
        var frame = Role is null
            ? $"{{\"schemaVersion\":1,\"operation\":\"{Operation}\",\"guardianInstanceId\":\"{GuardianInstanceId}\",\"guardianEpoch\":{GuardianEpoch},\"attemptId\":\"{AttemptId}\"}}\n"
            : $"{{\"schemaVersion\":1,\"operation\":\"{Operation}\",\"guardianInstanceId\":\"{GuardianInstanceId}\",\"guardianEpoch\":{GuardianEpoch},\"attemptId\":\"{AttemptId}\",\"role\":\"{Role}\"}}\n";
        return Encoding.UTF8.GetBytes(frame);
    }
}


/// <summary>Recovery-only Guardian child resources. This type is Desktop-private and cannot be substituted for a resident lease.</summary>
internal sealed class GuardianRecoverySupervisorLease : IAsyncDisposable
{
    private const int MaxNativeFrameBytes = 16_384;
    private readonly WindowsNative.SafeProcessHandle process;
    private readonly GuardianPrivateIngress privateIngress;
    private SafeFileHandle? controlWriter;
    private SafeFileHandle? publicOutput;
    private FileStream? publicInputStream;
    private System.IO.Pipes.NamedPipeClientStream? privateStream;
    private bool closed;

    internal GuardianRecoverySupervisorLease(GuardianProcessResources resources)
    {
        process = resources.Process;
        controlWriter = resources.ControlWriter;
        publicOutput = resources.PublicOutput;
        privateIngress = resources.PrivateIngress;
    }

    internal async Task<string> SendPreCasAsync(byte[] frame, CancellationToken cancellationToken)
    {
        var stream = await ConnectPrivateAsync(cancellationToken).ConfigureAwait(false);
        await WritePrivateFrameAsync(stream, privateIngress.InjectRecoveryToken(frame), cancellationToken).ConfigureAwait(false);
        var result = await GuardianSupervisorLease.ReadLineAsync(stream, cancellationToken).ConfigureAwait(false);
        if (result is not ("acquired" or "held")) throw new GuardianLaunchUnavailableException();
        return result;
    }

    internal async Task SendPostCasAsync(byte[] frame, CancellationToken cancellationToken)
    {
        var stream = await ConnectPrivateAsync(cancellationToken).ConfigureAwait(false);
        await WritePrivateFrameAsync(stream, frame, cancellationToken).ConfigureAwait(false);
    }

    internal async Task<string> ClassifyAsync(string role, CancellationToken cancellationToken)
    {
        if (role is not ("playerHost" or "aiClient")) throw new GuardianLaunchUnavailableException();
        var stream = await ConnectPrivateAsync(cancellationToken).ConfigureAwait(false);
        await WritePrivateFrameAsync(stream, Encoding.UTF8.GetBytes($"{{\"operation\":\"classify\",\"role\":\"{role}\"}}"), cancellationToken).ConfigureAwait(false);
        var result = await GuardianSupervisorLease.ReadLineAsync(stream, cancellationToken).ConfigureAwait(false);
        if (result is not ("contained" or "unavailable" or "quarantined")) throw new GuardianLaunchUnavailableException();
        return result;
    }

    internal async Task RecoverAttemptAsync(byte[] frame, CancellationToken cancellationToken)
    {
        var writer = controlWriter ?? throw new GuardianLaunchUnavailableException();
        publicInputStream ??= new FileStream(writer, FileAccess.Write, bufferSize: 4096, isAsync: true);
        await publicInputStream.WriteAsync(frame, cancellationToken).ConfigureAwait(false);
        await publicInputStream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    internal async Task ReleaseAndVerifyExitAsync(CancellationToken cancellationToken)
    {
        var stream = await ConnectPrivateAsync(cancellationToken).ConfigureAwait(false);
        await WritePrivateFrameAsync(stream, Encoding.UTF8.GetBytes("{\"operation\":\"release\"}"), cancellationToken).ConfigureAwait(false);
        await CloseControlAsync(CancellationToken.None).ConfigureAwait(false);
        var wait = await Task.Run(() => WindowsNative.WaitForSingleObject(process, 30_000), CancellationToken.None).ConfigureAwait(false);
        if (wait != WindowsNative.WaitObject0 || !WindowsNative.GetExitCodeProcess(process, out var exitCode) || exitCode != 0)
            throw new GuardianLaunchUnavailableException();
    }

    internal async Task CloseControlAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (closed) return;
        closed = true;
        Interlocked.Exchange(ref controlWriter, null)?.Dispose();
        Interlocked.Exchange(ref publicOutput, null)?.Dispose();
        await Task.CompletedTask;
    }

    private async Task<System.IO.Pipes.NamedPipeClientStream> ConnectPrivateAsync(CancellationToken cancellationToken) =>
        privateStream ??= await privateIngress.ConnectAsync(cancellationToken).ConfigureAwait(false);

    private static async Task WritePrivateFrameAsync(Stream stream, byte[] frame, CancellationToken cancellationToken)
    {
        if (frame.Length == 0 || frame.Length > 65_536 || frame.Contains((byte)'\n') || frame.Contains((byte)'\r') || frame.Contains((byte)0)) throw new GuardianLaunchUnavailableException();
        await stream.WriteAsync(frame, cancellationToken).ConfigureAwait(false);
        await stream.WriteAsync(new byte[] { (byte)'\n' }, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync()
    {
        await CloseControlAsync(CancellationToken.None).ConfigureAwait(false);
        if (WindowsNative.WaitForSingleObject(process, 0) == WindowsNative.WaitTimeout)
        {
            _ = WindowsNative.TerminateProcess(process, 1);
            _ = await Task.Run(() => WindowsNative.WaitForSingleObject(process, 30_000), CancellationToken.None).ConfigureAwait(false);
        }
        publicInputStream?.Dispose();
        privateIngress.Dispose();
        process.Dispose();
    }
}
