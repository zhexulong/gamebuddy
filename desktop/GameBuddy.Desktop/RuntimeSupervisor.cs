using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>Starts the admitted bundled Host and completes its one-shot private bootstrap.</summary>
internal sealed class RuntimeSupervisor : IAsyncDisposable
{
    private const int MaxWireBytes = 32_768;
    private static readonly TimeSpan BootstrapTimeout = TimeSpan.FromSeconds(30);

    // Test-only hooks. Production composition neither sets nor exposes them.
    internal Func<Task>? BeforeFrameWriteForTesting { get; set; }

    internal async Task<RuntimeSupervisorLease> StartHostAsync(InstalledGenerationSelection selection, AdmittedHostRuntime runtime, CurrentUserRootLayout layout, CancellationToken cancellationToken, Func<CancellationToken, Task<GuardianRecoverySupervisorLease>>? startRecovery = null)
    {
        ArgumentNullException.ThrowIfNull(selection);
        ArgumentNullException.ThrowIfNull(runtime);
        ArgumentNullException.ThrowIfNull(layout);
        cancellationToken.ThrowIfCancellationRequested();

        SafeFileHandle? childStdinReader = null;
        SafeFileHandle? parentStdinWriter = null;
        SafeFileHandle? parentStdoutReader = null;
        SafeFileHandle? childStdoutWriter = null;
        WindowsNative.SafeProcessHandle? process = null;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr attributeSize = IntPtr.Zero;
        var attributeListInitialized = false;
        IntPtr handleList = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        var launched = false;
        DesktopHostBootstrapBroker? broker = null;
        var brokerTransferred = false;
        try
        {
            runtime.VerifyStillLocked();
            CreateBootstrapPipes(out childStdinReader, out parentStdinWriter, out parentStdoutReader, out childStdoutWriter);
            var environmentBlock = BuildBootstrapEnvironment();
            environment = Marshal.StringToHGlobalUni(environmentBlock);

            _ = WindowsNative.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            attributeList = Marshal.AllocHGlobal(attributeSize);
            if (!WindowsNative.InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize)) WindowsNative.ThrowLastError("host_runtime_unavailable");
            attributeListInitialized = true;
            handleList = Marshal.AllocHGlobal(checked(IntPtr.Size * 2));
            Marshal.WriteIntPtr(handleList, 0, childStdinReader.DangerousGetHandle());
            Marshal.WriteIntPtr(handleList, IntPtr.Size, childStdoutWriter.DangerousGetHandle());
            if (!WindowsNative.UpdateProcThreadAttribute(attributeList, 0, (IntPtr)WindowsNative.ProcThreadAttributeHandleList, handleList, (IntPtr)(IntPtr.Size * 2), IntPtr.Zero, IntPtr.Zero)) WindowsNative.ThrowLastError("host_runtime_unavailable");

            runtime.VerifyStillLocked();
            var startup = new WindowsNative.StartupInfoEx
            {
                StartupInfo = new WindowsNative.StartupInfo
                {
                    cb = (uint)Marshal.SizeOf<WindowsNative.StartupInfoEx>(),
                    dwFlags = WindowsNative.StartfUseStdHandles,
                    hStdInput = childStdinReader.DangerousGetHandle(),
                    hStdOutput = childStdoutWriter.DangerousGetHandle(),
                    hStdError = IntPtr.Zero,
                },
                AttributeList = attributeList,
            };
            var runtimePath = WindowsNative.ToExtendedLengthPath(runtime.RuntimePath);
            var commandLine = new StringBuilder(Quote(WindowsNative.ToExtendedLengthPath(runtime.BootstrapPath)));
            if (!WindowsNative.CreateProcess(runtimePath, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                WindowsNative.ExtendedStartupInfoPresent | WindowsNative.CreateUnicodeEnvironment, environment, null, ref startup, out var processInformation)) WindowsNative.ThrowLastError("host_runtime_unavailable");
            launched = true;
            using var thread = new WindowsNative.SafeProcessHandle(processInformation.Thread);
            process = new WindowsNative.SafeProcessHandle(processInformation.Process);
            childStdinReader.Dispose();
            childStdinReader = null;
            childStdoutWriter.Dispose();
            childStdoutWriter = null;

            VerifyCreatedProcessBeforeFrame(process, processInformation.ProcessId, runtime.RuntimePath);
            if (BeforeFrameWriteForTesting is not null) await BeforeFrameWriteForTesting().ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            runtime.VerifyStillLocked();

            var bootstrapId = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
            broker = DesktopHostBootstrapBroker.Create(bootstrapId, selection, startRecovery);
            var frame = BuildFrame(selection, layout, bootstrapId);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(BootstrapTimeout);
            await HostBootstrapPipeIo.WriteOneFrameAsync(parentStdinWriter, frame, timeout.Token).ConfigureAwait(false);
            parentStdinWriter.Dispose();
            parentStdinWriter = null;
            var ack = await ReadOneAcknowledgementAsync(parentStdoutReader, selection, bootstrapId, timeout.Token).ConfigureAwait(false);
            if (!WindowsNative.GetExitCodeProcess(process, out _) ||
                WindowsNative.WaitForSingleObject(process, 0) != WindowsNative.WaitTimeout) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
            parentStdoutReader.Dispose();
            parentStdoutReader = null;

            await broker.AuthenticateHostAsync(process, timeout.Token).ConfigureAwait(false);
            var locks = runtime.TransferLocks();
            var lease = new RuntimeSupervisorLease(process, locks.Runtime, locks.Bootstrap, ack, broker!);
            brokerTransferred = true;
            process = null;
            return lease;
        }
        catch (GuardianLaunchUnavailableException) { throw; }
        catch (OperationCanceledException exception)
        {
            throw new GuardianLaunchUnavailableException("host_runtime_unavailable", exception);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException or OutOfMemoryException or JsonException)
        {
            throw new GuardianLaunchUnavailableException("host_runtime_unavailable", exception);
        }
        finally
        {
            if (!brokerTransferred && broker is not null) await broker.DisposeAsync().ConfigureAwait(false);
            if (process is not null)
            {
                if (launched)
                {
                    _ = WindowsNative.TerminateProcess(process, 1);
                    _ = await Task.Run(() => WindowsNative.WaitForSingleObject(process, 30_000), CancellationToken.None).ConfigureAwait(false);
                }
                process.Dispose();
            }
            if (attributeList != IntPtr.Zero)
            {
                if (attributeListInitialized) WindowsNative.DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            childStdinReader?.Dispose();
            parentStdinWriter?.Dispose();
            parentStdoutReader?.Dispose();
            childStdoutWriter?.Dispose();
        }
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private static void CreateBootstrapPipes(out SafeFileHandle childStdinReader, out SafeFileHandle parentStdinWriter, out SafeFileHandle parentStdoutReader, out SafeFileHandle childStdoutWriter)
    {
        parentStdoutReader = null!;
        childStdoutWriter = null!;
        if (!WindowsNative.CreatePipe(out childStdinReader, out parentStdinWriter, IntPtr.Zero, 0)) WindowsNative.ThrowLastError("host_runtime_unavailable");
        try
        {
            if (!WindowsNative.CreatePipe(out parentStdoutReader, out childStdoutWriter, IntPtr.Zero, 0)) WindowsNative.ThrowLastError("host_runtime_unavailable");
            if (!WindowsNative.SetHandleInformation(childStdinReader, WindowsNative.HandleFlagInherit, WindowsNative.HandleFlagInherit) ||
                !WindowsNative.SetHandleInformation(childStdoutWriter, WindowsNative.HandleFlagInherit, WindowsNative.HandleFlagInherit) ||
                !WindowsNative.SetHandleInformation(parentStdinWriter, WindowsNative.HandleFlagInherit, 0) ||
                !WindowsNative.SetHandleInformation(parentStdoutReader, WindowsNative.HandleFlagInherit, 0))
                WindowsNative.ThrowLastError("host_runtime_unavailable");
        }
        catch
        {
            childStdinReader.Dispose();
            childStdinReader = null!;
            parentStdinWriter.Dispose();
            parentStdinWriter = null!;
            parentStdoutReader?.Dispose();
            parentStdoutReader = null!;
            childStdoutWriter?.Dispose();
            childStdoutWriter = null!;
            throw;
        }
    }

    private static string BuildBootstrapEnvironment()
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["SystemRoot"] = RequiredEnvironment("SystemRoot"),
            ["TEMP"] = RequiredEnvironment("TEMP"),
            ["TMP"] = RequiredEnvironment("TMP"),
            ["LOCALAPPDATA"] = RequiredEnvironment("LOCALAPPDATA"),
        };
        return string.Concat(values.OrderBy(item => item.Key, StringComparer.Ordinal).Select(item => $"{item.Key}={item.Value}\0")) + "\0";
    }

    private static string RequiredEnvironment(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(value) || value.Contains('\0')) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        return value;
    }

    private static void VerifyCreatedProcessBeforeFrame(WindowsNative.SafeProcessHandle process, uint expectedProcessId, string admittedRuntimePath)
    {
        if (WindowsNative.GetProcessId(process) != expectedProcessId) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        var buffer = new char[32768];
        uint length = (uint)buffer.Length;
        if (!WindowsNative.QueryFullProcessImageName(process, 0, buffer, ref length) || length == 0 ||
            !StringComparer.OrdinalIgnoreCase.Equals(Path.GetFullPath(new string(buffer, 0, checked((int)length))), Path.GetFullPath(admittedRuntimePath)))
            throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        VerifySameCurrentUserSid(process);
    }

    private static void VerifySameCurrentUserSid(WindowsNative.SafeProcessHandle child)
    {
        if (!WindowsNative.OpenProcessToken(WindowsNative.GetCurrentProcess(), WindowsNative.TokenQuery, out var currentToken)) WindowsNative.ThrowLastError("host_runtime_unavailable");
        using (currentToken)
        {
            if (!WindowsNative.OpenProcessToken(child, WindowsNative.TokenQuery, out var childToken)) WindowsNative.ThrowLastError("host_runtime_unavailable");
            using (childToken)
            {
                var currentSid = IntPtr.Zero;
                var childSid = IntPtr.Zero;
                try
                {
                    currentSid = ReadTokenUserSid(currentToken);
                    childSid = ReadTokenUserSid(childToken);
                    if (!WindowsNative.EqualSid(currentSid, childSid)) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
                }
                finally
                {
                    if (currentSid != IntPtr.Zero) Marshal.FreeHGlobal(currentSid);
                    if (childSid != IntPtr.Zero) Marshal.FreeHGlobal(childSid);
                }
            }
        }
    }

    private static IntPtr ReadTokenUserSid(SafeAccessTokenHandle token)
    {
        _ = WindowsNative.GetTokenInformation(token, WindowsNative.TokenUser, IntPtr.Zero, 0, out var required);
        if (required == 0) WindowsNative.ThrowLastError("host_runtime_unavailable");
        var buffer = Marshal.AllocHGlobal(checked((int)required));
        try
        {
            if (!WindowsNative.GetTokenInformation(token, WindowsNative.TokenUser, buffer, required, out var written) || written != required) WindowsNative.ThrowLastError("host_runtime_unavailable");
            var tokenUser = Marshal.PtrToStructure<WindowsNative.TokenUserInformation>(buffer);
            var sidLength = tokenUser.User.Sid == IntPtr.Zero ? 0 : WindowsNative.GetLengthSid(tokenUser.User.Sid);
            if (sidLength == 0) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
            var sid = Marshal.AllocHGlobal(checked((int)sidLength));
            var bytes = new byte[checked((int)sidLength)];
            Marshal.Copy(tokenUser.User.Sid, bytes, 0, bytes.Length);
            Marshal.Copy(bytes, 0, sid, bytes.Length);
            return sid;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static byte[] BuildFrame(InstalledGenerationSelection selection, CurrentUserRootLayout layout, string bootstrapId)
    {
        using var bytes = new MemoryStream();
        using (var writer = new Utf8JsonWriter(bytes))
        {
            writer.WriteStartObject();
            writer.WriteString("schema", "gamebuddy-desktop-host-bootstrap/v1");
            writer.WriteNumber("protocolVersion", 1);
            writer.WriteString("bootstrapId", bootstrapId);
            writer.WriteString("generation", selection.Generation);
            writer.WriteString("inventoryDigest", selection.InventoryDigest);
            writer.WriteString("runtimeAdmissionSha256", selection.RuntimeAdmissionSha256);
            writer.WritePropertyName("rootLayout");
            writer.WriteStartObject();
            writer.WriteString("schema", "gamebuddy-windows-root-layout/v1");
            writer.WriteString("programRoot", layout.ProgramRoot);
            writer.WriteString("dataRoot", layout.DataRoot);
            writer.WriteString("operationalRoot", layout.OperationalRoot);
            writer.WriteString("presentationRoot", layout.PresentationRoot);
            writer.WriteEndObject();
            writer.WriteEndObject();
        }
        var document = bytes.ToArray().Append((byte)'\n').ToArray();
        if (document.Length > MaxWireBytes || document.Contains((byte)'\r') || document.Contains((byte)0)) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        return document;
    }

    private static async Task<HostBootstrapResult> ReadOneAcknowledgementAsync(SafeFileHandle reader, InstalledGenerationSelection selection, string bootstrapId, CancellationToken cancellationToken)
    {
        var bytes = await HostBootstrapPipeIo.ReadOneFrameAsync(reader, MaxWireBytes, cancellationToken).ConfigureAwait(false);
        ValidateOneWireDocument(bytes);
        using var document = JsonDocument.Parse(bytes[..^1]);
        var ack = document.RootElement;
        if (!ExactPropertiesInOrder(ack, "schema", "protocolVersion", "status", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "rootLayoutSchema") ||
            ack.GetProperty("schema").GetString() != "gamebuddy-desktop-host-bootstrap/v1" || ack.GetProperty("protocolVersion").GetInt32() != 1 || ack.GetProperty("status").GetString() != "accepted" ||
            ack.GetProperty("bootstrapId").GetString() != bootstrapId || ack.GetProperty("generation").GetString() != selection.Generation || ack.GetProperty("inventoryDigest").GetString() != selection.InventoryDigest ||
            ack.GetProperty("runtimeAdmissionSha256").GetString() != selection.RuntimeAdmissionSha256 || ack.GetProperty("rootLayoutSchema").GetString() != "gamebuddy-windows-root-layout/v1")
            throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        return new HostBootstrapResult();
    }

    private static void ValidateOneWireDocument(byte[] bytes)
    {
        if (bytes.Length == 0 || bytes.Length > MaxWireBytes || bytes[0] == 0xEF && bytes.Length >= 3 && bytes[1] == 0xBB && bytes[2] == 0xBF || bytes.Contains((byte)0) || bytes.Contains((byte)'\r') || bytes[^1] != (byte)'\n' || bytes[..^1].Contains((byte)'\n'))
            throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
    }

    private static bool ExactPropertiesInOrder(JsonElement value, params string[] names) =>
        value.ValueKind == JsonValueKind.Object && value.EnumerateObject().Select(property => property.Name).SequenceEqual(names, StringComparer.Ordinal);

    private static string Quote(string value) => $"\"{value.Replace("\"", "\\\"")}\"";
}

/// <summary>
/// Owns only the synchronous anonymous-pipe I/O used by the one-shot Host bootstrap.
/// Closing the local endpoint on cancellation unblocks the dedicated worker before its
/// task settles; callers do not receive an endpoint or a generic IPC abstraction.
/// </summary>
internal static class HostBootstrapPipeIo
{
    internal static Task WriteOneFrameAsync(SafeFileHandle writer, byte[] frame, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(writer);
        ArgumentNullException.ThrowIfNull(frame);
        return RunSynchronousIoAsync(writer, () =>
        {
            using var stream = new FileStream(writer, FileAccess.Write, bufferSize: 4096, isAsync: false);
            stream.Write(frame, 0, frame.Length);
            stream.Flush();
        }, cancellationToken);
    }

    internal static Task<byte[]> ReadOneFrameAsync(SafeFileHandle reader, int maximumBytes, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(reader);
        if (maximumBytes <= 0) throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        return RunSynchronousIoAsync(reader, () =>
        {
            using var stream = new FileStream(reader, FileAccess.Read, bufferSize: 4096, isAsync: false);
            using var output = new MemoryStream();
            var buffer = new byte[4096];
            while (true)
            {
                var count = stream.Read(buffer, 0, buffer.Length);
                if (count == 0) return output.ToArray();
                if (output.Length + count > maximumBytes) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
                output.Write(buffer, 0, count);
            }
        }, cancellationToken);
    }

    private static async Task RunSynchronousIoAsync(SafeFileHandle endpoint, Action operation, CancellationToken cancellationToken)
    {
        await RunSynchronousIoAsync<object?>(endpoint, () =>
        {
            operation();
            return null;
        }, cancellationToken).ConfigureAwait(false);
    }

    private static async Task<T> RunSynchronousIoAsync<T>(SafeFileHandle endpoint, Func<T> operation, CancellationToken cancellationToken)
    {
        using var cancellationState = new SynchronousIoCancellation(endpoint);
        using var cancellation = cancellationToken.Register(static state => ((SynchronousIoCancellation)state!).Cancel(), cancellationState);
        try
        {
            var result = await Task.Factory.StartNew(() =>
            {
                using var thread = DuplicateCurrentThread();
                cancellationState.Attach(thread);
                try
                {
                    cancellationState.ThrowIfCancelled();
                    return operation();
                }
                finally { cancellationState.Detach(thread); }
            }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return result;
        }
        catch (Exception exception) when (cancellationToken.IsCancellationRequested && exception is (IOException or ObjectDisposedException))
        {
            throw new OperationCanceledException(cancellationToken);
        }
    }

    private static WindowsNative.SafeThreadHandle DuplicateCurrentThread()
    {
        if (!WindowsNative.DuplicateHandle(WindowsNative.GetCurrentProcess(), WindowsNative.GetCurrentThread(), WindowsNative.GetCurrentProcess(), out var thread, 0, false, WindowsNative.DuplicateSameAccess))
            WindowsNative.ThrowLastError("host_runtime_unavailable");
        return thread;
    }

    private sealed class SynchronousIoCancellation : IDisposable
    {
        private readonly object gate = new();
        private SafeFileHandle? endpoint;
        private WindowsNative.SafeThreadHandle? worker;
        private bool cancelled;

        internal SynchronousIoCancellation(SafeFileHandle endpoint) => this.endpoint = endpoint;

        internal void Attach(WindowsNative.SafeThreadHandle thread)
        {
            lock (gate)
            {
                worker = thread;
                if (cancelled) _ = WindowsNative.CancelSynchronousIo(thread);
            }
        }

        internal void Detach(WindowsNative.SafeThreadHandle thread)
        {
            lock (gate)
            {
                if (ReferenceEquals(worker, thread)) worker = null;
            }
        }

        internal void ThrowIfCancelled()
        {
            lock (gate)
            {
                if (cancelled) throw new OperationCanceledException();
            }
        }

        internal void Cancel()
        {
            lock (gate)
            {
                cancelled = true;
                endpoint?.Dispose();
                endpoint = null;
                if (worker is not null) _ = WindowsNative.CancelSynchronousIo(worker);
            }
        }

        public void Dispose() => Cancel();
    }
}

/// <summary>Redacted evidence that the exact private bootstrap acknowledgement was accepted.</summary>
internal sealed class HostBootstrapResult { }

/// <summary>Owns the exact Host child and the two admitted file locks after bootstrap.</summary>
internal sealed class RuntimeSupervisorLease : IAsyncDisposable
{
    private WindowsNative.SafeProcessHandle? process;
    private AdmittedRuntimeFile? runtime;
    private AdmittedRuntimeFile? bootstrap;
    private int closed;

    private readonly DesktopHostBootstrapBroker broker;

    internal RuntimeSupervisorLease(WindowsNative.SafeProcessHandle process, AdmittedRuntimeFile runtime, AdmittedRuntimeFile bootstrap, HostBootstrapResult result, DesktopHostBootstrapBroker broker)
    {
        this.process = process;
        this.runtime = runtime;
        this.bootstrap = bootstrap;
        Result = result;
        this.broker = broker;
    }

    internal HostBootstrapResult Result { get; }

    internal Task AttachResidentGuardianAsync(GuardianSupervisorLease guardian, CancellationToken cancellationToken) => broker.AttachResidentGuardianAsync(guardian, cancellationToken);

    internal async Task CloseAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await broker.CloseAsync(cancellationToken).ConfigureAwait(false);
        var child = Interlocked.Exchange(ref process, null);
        if (child is not null)
        {
            if (Interlocked.Exchange(ref closed, 1) == 0) _ = WindowsNative.TerminateProcess(child, 1);
            await Task.Run(() => _ = WindowsNative.WaitForSingleObject(child, 30_000), CancellationToken.None).ConfigureAwait(false);
            child.Dispose();
        }
        Interlocked.Exchange(ref bootstrap, null)?.Dispose();
        Interlocked.Exchange(ref runtime, null)?.Dispose();
    }

    public ValueTask DisposeAsync() => new(CloseAsync(CancellationToken.None));
}
