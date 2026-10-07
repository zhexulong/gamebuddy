using Microsoft.Win32.SafeHandles;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>Starts the admitted bundled Host and completes its one-shot private bootstrap.</summary>
internal sealed class RuntimeSupervisor : IAsyncDisposable
{
    private const int MaxWireBytes = 32_768;
    private const string DeploymentManifestFileName = "deployment-manifest.json";
    // The acknowledgement means READY FOR SERVICE: by the time the child writes it, it has opened
    // its databases, provisioned the semantic authority, Magic Context and the Pi agent stores, and
    // is listening on its private channel - and everything the supervisor does next (transferring the
    // generation locks, starting the resident guardian, opening the tray and the browser) depends on
    // that. So this budget must cover a cold first launch, where several SQLite authorities and a Node
    // runtime are created while antivirus and the indexer scan the freshly written files. Thirty
    // seconds killed a healthy child mid-provisioning on this machine, and the generic
    // `host_runtime_unavailable` it produced was indistinguishable from a broken installation. A real
    // failure does not need a small budget to be noticed: the child's exit closes its stdout pipe, so
    // the acknowledgement read fails at once and the diagnostic comes from the child itself.
    private static readonly TimeSpan BootstrapTimeout = TimeSpan.FromSeconds(180);

    /// <summary>
    /// Names the budget's expiry as its own reason, so "the child is hung or extremely slow" can never
    /// again be reported as the generic runtime failure a genuinely broken start produces.
    /// </summary>
    internal const string BootstrapTimeoutCategory = "host_bootstrap_timeout";

    // Test-only hooks. Production composition neither sets nor exposes them.
    internal Func<Task>? BeforeFrameWriteForTesting { get; set; }

    internal async Task<RuntimeSupervisorLease> StartHostAsync(InstalledGenerationSelection selection, AdmittedHostRuntime runtime, CurrentUserRootLayout layout, CancellationToken cancellationToken, HostBootstrapEnvironmentOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(selection);
        ArgumentNullException.ThrowIfNull(runtime);
        ArgumentNullException.ThrowIfNull(layout);
        cancellationToken.ThrowIfCancellationRequested();

        SafeFileHandle? childStdinReader = null;
        SafeFileHandle? parentStdinWriter = null;
        SafeFileHandle? parentStdoutReader = null;
        SafeFileHandle? childStdoutWriter = null;
        SafeFileHandle? parentStderrReader = null;
        SafeFileHandle? childStderrWriter = null;
        WindowsNative.SafeProcessHandle? process = null;
        ChildStderrCapture? childStderr = null;
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
            CreateBootstrapPipes(out childStdinReader, out parentStdinWriter, out parentStdoutReader, out childStdoutWriter, out parentStderrReader, out childStderrWriter);
            var environmentBlock = BuildBootstrapEnvironment(layout, options);
            environment = Marshal.StringToHGlobalUni(environmentBlock);

            _ = WindowsNative.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            attributeList = Marshal.AllocHGlobal(attributeSize);
            if (!WindowsNative.InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize)) WindowsNative.ThrowLastError("host_runtime_unavailable");
            attributeListInitialized = true;
            // The child inherits exactly the three pipe endpoints it needs: the two
            // handshake directions and its own stderr, which is where a refusal before
            // the acknowledgement is written and which is therefore the launcher's only
            // diagnostic when the handshake never completes.
            handleList = Marshal.AllocHGlobal(checked(IntPtr.Size * 3));
            Marshal.WriteIntPtr(handleList, 0, childStdinReader.DangerousGetHandle());
            Marshal.WriteIntPtr(handleList, IntPtr.Size, childStdoutWriter.DangerousGetHandle());
            Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, childStderrWriter.DangerousGetHandle());
            if (!WindowsNative.UpdateProcThreadAttribute(attributeList, 0, (IntPtr)WindowsNative.ProcThreadAttributeHandleList, handleList, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) WindowsNative.ThrowLastError("host_runtime_unavailable");

            runtime.VerifyStillLocked();
            var bootstrapId = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
            broker = DesktopHostBootstrapBroker.Create(bootstrapId, selection, layout);
            var startup = new WindowsNative.StartupInfoEx
            {
                StartupInfo = new WindowsNative.StartupInfo
                {
                    cb = (uint)Marshal.SizeOf<WindowsNative.StartupInfoEx>(),
                    dwFlags = WindowsNative.StartfUseStdHandles,
                    hStdInput = childStdinReader.DangerousGetHandle(),
                    hStdOutput = childStdoutWriter.DangerousGetHandle(),
                    hStdError = childStderrWriter.DangerousGetHandle(),
                },
                AttributeList = attributeList,
            };
            var runtimePath = WindowsNative.ToExtendedLengthPath(runtime.RuntimePath);
            var commandLine = BuildHostCommandLine(runtimePath, runtime.BootstrapPath);
            if (!WindowsNative.CreateProcess(runtimePath, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                WindowsNative.ExtendedStartupInfoPresent | WindowsNative.CreateUnicodeEnvironment, environment, null, ref startup, out var processInformation)) WindowsNative.ThrowLastError("host_runtime_unavailable");
            launched = true;
            using var thread = new WindowsNative.SafeProcessHandle(processInformation.Thread);
            process = new WindowsNative.SafeProcessHandle(processInformation.Process);
            childStdinReader.Dispose();
            childStdinReader = null;
            childStdoutWriter.Dispose();
            childStdoutWriter = null;
            childStderrWriter.Dispose();
            childStderrWriter = null;
            // From the child's first moment its stderr is drained, so the capture can
            // never become the reason the child blocks.
            childStderr = ChildStderrCapture.Begin(parentStderrReader);
            parentStderrReader = null;

            VerifyCreatedProcessBeforeFrame(process, processInformation.ProcessId, runtime.RuntimePath);
            if (BeforeFrameWriteForTesting is not null) await BeforeFrameWriteForTesting().ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            runtime.VerifyStillLocked();

            var frame = BuildFrame(selection, layout, bootstrapId);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(BootstrapTimeout);
            await HostBootstrapPipeIo.WriteOneFrameAsync(parentStdinWriter, frame, timeout.Token).ConfigureAwait(false);
            parentStdinWriter.Dispose();
            parentStdinWriter = null;
            await broker.AuthenticateHostAsync(process, timeout.Token).ConfigureAwait(false);
            var ack = await ReadOneAcknowledgementAsync(parentStdoutReader, selection, bootstrapId, timeout.Token).ConfigureAwait(false);
            if (!WindowsNative.GetExitCodeProcess(process, out _) ||
                WindowsNative.WaitForSingleObject(process, 0) != WindowsNative.WaitTimeout) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
            parentStdoutReader.Dispose();
            parentStdoutReader = null;

            var locks = runtime.TransferLocks();
            var lease = new RuntimeSupervisorLease(process, locks.Runtime, locks.Bootstrap, ack, broker);
            brokerTransferred = true;
            process = null;
            return lease;
        }
        catch (GuardianLaunchUnavailableException exception)
        {
            await AttachChildStderrAsync(exception, childStderr).ConfigureAwait(false);
            throw;
        }
        catch (OperationCanceledException exception)
        {
            // Distinguish this launcher's own bootstrap budget from the caller cancelling the launch:
            // the first means the child is hung or extremely slow, the second means the launch was
            // abandoned. Reporting both as the generic runtime failure is what hid the budget's expiry.
            var unavailable = new GuardianLaunchUnavailableException(
                cancellationToken.IsCancellationRequested ? "host_runtime_unavailable" : BootstrapTimeoutCategory,
                exception);
            await AttachChildStderrAsync(unavailable, childStderr).ConfigureAwait(false);
            throw unavailable;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException or OutOfMemoryException or JsonException)
        {
            var unavailable = new GuardianLaunchUnavailableException("host_runtime_unavailable", exception);
            await AttachChildStderrAsync(unavailable, childStderr).ConfigureAwait(false);
            throw unavailable;
        }
        finally
        {
            if (process is not null)
            {
                if (launched)
                {
                    _ = WindowsNative.TerminateProcess(process, 1);
                    _ = await Task.Run(() => WindowsNative.WaitForSingleObject(process, 30_000), CancellationToken.None).ConfigureAwait(false);
                }
                process.Dispose();
            }
            if (!brokerTransferred && broker is not null) await broker.DisposeAsync().ConfigureAwait(false);
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
            parentStderrReader?.Dispose();
            childStderrWriter?.Dispose();
        }
    }

    /// <summary>
    /// Binds the launched child's own stderr to the failure the launch is about to
    /// report. The category is untouched: the excerpt is what the child said about the
    /// same blocker, appended where an operator can read it. A failure that happened
    /// before any child existed carries no excerpt at all, and a capture that retained
    /// nothing says so instead of pretending the child was silent. It runs at most once
    /// per exception.
    /// </summary>
    private static async Task AttachChildStderrAsync(GuardianLaunchUnavailableException exception, ChildStderrCapture? capture)
    {
        if (capture is null || exception.Diagnostic is not null) return;
        exception.Diagnostic = ChildStderrExcerpt.Format(await capture.ExcerptAsync().ConfigureAwait(false));
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private static void CreateBootstrapPipes(out SafeFileHandle childStdinReader, out SafeFileHandle parentStdinWriter, out SafeFileHandle parentStdoutReader, out SafeFileHandle childStdoutWriter, out SafeFileHandle parentStderrReader, out SafeFileHandle childStderrWriter)
    {
        parentStdoutReader = null!;
        childStdoutWriter = null!;
        parentStderrReader = null!;
        childStderrWriter = null!;
        if (!WindowsNative.CreatePipe(out childStdinReader, out parentStdinWriter, IntPtr.Zero, 0)) WindowsNative.ThrowLastError("host_runtime_unavailable");
        try
        {
            if (!WindowsNative.CreatePipe(out parentStdoutReader, out childStdoutWriter, IntPtr.Zero, 0)) WindowsNative.ThrowLastError("host_runtime_unavailable");
            if (!WindowsNative.CreatePipe(out parentStderrReader, out childStderrWriter, IntPtr.Zero, 0)) WindowsNative.ThrowLastError("host_runtime_unavailable");
            if (!WindowsNative.SetHandleInformation(childStdinReader, WindowsNative.HandleFlagInherit, WindowsNative.HandleFlagInherit) ||
                !WindowsNative.SetHandleInformation(childStdoutWriter, WindowsNative.HandleFlagInherit, WindowsNative.HandleFlagInherit) ||
                !WindowsNative.SetHandleInformation(childStderrWriter, WindowsNative.HandleFlagInherit, WindowsNative.HandleFlagInherit) ||
                !WindowsNative.SetHandleInformation(parentStdinWriter, WindowsNative.HandleFlagInherit, 0) ||
                !WindowsNative.SetHandleInformation(parentStdoutReader, WindowsNative.HandleFlagInherit, 0) ||
                !WindowsNative.SetHandleInformation(parentStderrReader, WindowsNative.HandleFlagInherit, 0))
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
            parentStderrReader?.Dispose();
            parentStderrReader = null!;
            childStderrWriter?.Dispose();
            childStderrWriter = null!;
            throw;
        }
    }

    internal static string BuildBootstrapEnvironment(CurrentUserRootLayout layout, HostBootstrapEnvironmentOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(layout);
        options ??= new HostBootstrapEnvironmentOptions();

        // The manifest content authority stays with the Host (loadHostDeploymentManifest);
        // the Desktop only fails closed when the provisioning-written file is provably absent,
        // so a launch that can never enter composition fails before the handshake starts.
        var manifestPath = Path.Combine(layout.OperationalRoot, DeploymentManifestFileName);
        if (!File.Exists(manifestPath)) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        if (options.GameSessionMode is not (HostBootstrapEnvironmentOptions.FreshGameSessionMode or HostBootstrapEnvironmentOptions.KnownGameSessionMode))
            throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        if (options.Surface is not (HostBootstrapEnvironmentOptions.ComposedReferenceGameSurface or HostBootstrapEnvironmentOptions.ChatOnlySurface or HostBootstrapEnvironmentOptions.ManagementSurface))
            throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        var nonce = options.TavernNarrativeGateNonceSha256;
        if (nonce is not null && !ValidTavernNarrativeGateNonceSha256(nonce))
            throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        // Voice is an optional capability delivered to the Host wire
        // (connectOptionalVoiceSurface) as a strictly paired port/token pair:
        // both absent means pure text, one absent is a composition bug and
        // fails closed rather than silently dropping the Voice surface.
        var voicePort = options.VoicePort;
        var voiceToken = options.VoiceToken;
        if (voicePort is null != voiceToken is null)
            throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        if (voicePort is not null && (voicePort < 1 || voicePort > 65_535))
            throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        if (voiceToken is not null && !ValidVoiceToken(voiceToken))
            throw new GuardianLaunchUnavailableException("host_runtime_unavailable");

        // The child environment is a DECLARED block, not the launcher's environment:
        // the admitted bundled Host receives exactly the frozen wire environment plus
        // the names it cannot do its own job without, each listed here with the reason
        // it is carried. A starved block was the real bug: the Host composes the GAME's
        // child environment itself and fails closed without PATH, WINDIR and
        // USERPROFILE, so the game could never start in the Desktop topology.
        var values = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            // Windows session facts the Host forwards to the game process (the guardian
            // admits this same set at the game boundary).
            ["PATH"] = RequiredEnvironment("PATH"),
            ["WINDIR"] = RequiredEnvironment("WINDIR"),
            ["USERPROFILE"] = RequiredEnvironment("USERPROFILE"),
            ["SystemRoot"] = RequiredEnvironment("SystemRoot"),
            ["TEMP"] = RequiredEnvironment("TEMP"),
            ["TMP"] = RequiredEnvironment("TMP"),
            ["LOCALAPPDATA"] = RequiredEnvironment("LOCALAPPDATA"),
            // Windows marks itself in the environment as well as in the filesystem, and
            // the PowerShell sidecars the Host starts read that mark: the named-mutex
            // broker's own script refuses to run unless $env:OS is Windows_NT. Because
            // this block is DECLARED rather than inherited, omitting the mark made the
            // sidecar inherit an environment that did not identify Windows, and every
            // launch failed closed with windows_named_mutex_required.
            ["OS"] = "Windows_NT",
            // The Host reaches the player's provider itself, so a player behind a proxy
            // keeps working; absent is normal and simply not carried.
            ["HTTP_PROXY"] = OptionalEnvironment("HTTP_PROXY"),
            ["HTTPS_PROXY"] = OptionalEnvironment("HTTPS_PROXY"),
            ["NO_PROXY"] = OptionalEnvironment("NO_PROXY"),
            ["GAMEBUDDY_HOST_DEPLOYMENT_MANIFEST"] = manifestPath,
            ["GAMEBUDDY_HOST_GAME_SESSION_MODE"] = options.GameSessionMode,
            ["GAMEBUDDY_HOST_SURFACE"] = options.Surface,
        };
        foreach (var optional in new[] { "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY" })
            if (values[optional].Length == 0) values.Remove(optional);
        if (nonce is not null) values["GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256"] = nonce;
        if (voicePort is not null && voiceToken is not null)
        {
            values["GAMEBUDDY_VOICE_PORT"] = voicePort.Value.ToString(CultureInfo.InvariantCulture);
            values["GAMEBUDDY_VOICE_TOKEN"] = voiceToken;
        }
        return string.Concat(values.OrderBy(item => item.Key, StringComparer.Ordinal).Select(item => $"{item.Key}={item.Value}\0")) + "\0";
    }

    private static bool ValidVoiceToken(string value) =>
        value.Length is >= 16 and <= 256 && value.All(static character =>
            character is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '-' or '_');

    private static bool ValidTavernNarrativeGateNonceSha256(string value) =>
        value.Length == 64 && value.All(static character => (character >= 'a' && character <= 'f') || (character >= '0' && character <= '9'));

    private static string RequiredEnvironment(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(value) || value.Contains('\0')) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        return value;
    }

    /// <summary>
    /// A declared name the Host benefits from but does not require: a player behind a
    /// proxy, or without one. Absent or blank means "not carried", never a failure.
    /// </summary>
    private static string OptionalEnvironment(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(value) || value.Contains('\0') ? string.Empty : value;
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

    /// <summary>
    /// The two arguments the Host child is launched with.
    ///
    /// The command line begins with the image itself, in the same extended-length
    /// form CreateProcessW is given as <c>lpApplicationName</c>. It is not an echo:
    /// the image token is argument zero, and node's first <em>positional</em>
    /// argument is the module it runs. A command line that carries only the script - 
    /// as a one-token command line does, with the image supplied separately - leaves
    /// node with no positional argument at all, and it then compiles its standard
    /// input as the program (<c>node:internal/main/eval_stdin</c>, reported as a
    /// syntax error at <c>[stdin]:1</c>). That is exactly what the one-shot bootstrap
    /// frame arrives on, so the frame was being evaluated as JavaScript instead of
    /// read as JSON.
    ///
    /// The script argument stays in its ordinary absolute form. The extended-length
    /// spelling is required for the Win32 transport that starts the image, but node
    /// realpaths its first positional argument, and <c>\?\E:\...</c> realpaths to the
    /// bare drive (<c>EISDIR: illegal operation on a directory, lstat 'E:'</c>).
    /// Windows applies MAX_PATH to the command line's own text rather than to the
    /// child's file access, so a long installed script path needs no extended
    /// spelling here - only the admitted image token keeps it.
    /// </summary>
    internal static StringBuilder BuildHostCommandLine(string imagePath, string bootstrapPath) =>
        new(Quote(imagePath) + " " + Quote(bootstrapPath));

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

    /// <summary>
    /// Reads one endpoint to its end, handing each block to the sink, on the same
    /// cancellable synchronous worker the handshake uses. It is how the child's stderr
    /// is drained for as long as the child lives, and it never blocks the launch: the
    /// caller abandons it when the endpoint reaches its end.
    /// </summary>
    internal static Task DrainUntilEndAsync(SafeFileHandle reader, Action<byte[], int> sink, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(reader);
        ArgumentNullException.ThrowIfNull(sink);
        return RunSynchronousIoAsync(reader, () =>
        {
            using var stream = new FileStream(reader, FileAccess.Read, bufferSize: 4096, isAsync: false);
            var buffer = new byte[4096];
            while (true)
            {
                var count = stream.Read(buffer, 0, buffer.Length);
                if (count == 0) return;
                sink(buffer, count);
            }
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
    private DesktopHostBootstrapBroker? broker;
    private GuardianSupervisorLease? residentGuardian;
    private readonly SemaphoreSlim guardianGate = new(1, 1);
    private int closed;

    internal RuntimeSupervisorLease(WindowsNative.SafeProcessHandle process, AdmittedRuntimeFile runtime, AdmittedRuntimeFile bootstrap, HostBootstrapResult result, DesktopHostBootstrapBroker broker)
    {
        this.process = process;
        this.runtime = runtime;
        this.bootstrap = bootstrap;
        this.broker = broker;
        Result = result;
    }

    internal HostBootstrapResult Result { get; }

    /// <summary>Attaches the Desktop-owned resident Guardian to the authenticated Host broker.</summary>
    internal async Task AttachResidentGuardianAsync(GuardianSupervisorLease lease, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(lease);
        cancellationToken.ThrowIfCancellationRequested();
        await guardianGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var child = process;
            if (Volatile.Read(ref closed) != 0 || residentGuardian is not null || child is null ||
                !WindowsNative.GetExitCodeProcess(child, out _) || WindowsNative.WaitForSingleObject(child, 0) != WindowsNative.WaitTimeout)
                throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
            var currentBroker = broker ?? throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
            await currentBroker.AttachResidentGuardianAsync(lease, cancellationToken).ConfigureAwait(false);
            residentGuardian = lease;
        }
        finally { guardianGate.Release(); }
    }

    /// <summary>
    /// Mounts the assembler-owned recovery launch on the authenticated Host
    /// broker. It must arrive before the resident Guardian starts the broker's
    /// command loop, because that loop is what may ask for a recovery; a late
    /// mount is refused by the broker instead of silently leaving a request
    /// unservable.
    /// </summary>
    internal void AttachRecoveryLaunch(RecoveryLaunchTrigger trigger)
    {
        ArgumentNullException.ThrowIfNull(trigger);
        guardianGate.Wait();
        try
        {
            var child = process;
            if (Volatile.Read(ref closed) != 0 || child is null ||
                !WindowsNative.GetExitCodeProcess(child, out _) || WindowsNative.WaitForSingleObject(child, 0) != WindowsNative.WaitTimeout)
                throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
            var currentBroker = broker ?? throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
            currentBroker.AttachRecoveryLaunch(trigger.Start);
        }
        finally { guardianGate.Release(); }
    }

    /// <summary>Waits for the exact admitted Host child to exit.</summary>
    internal async Task<bool> WaitForExitAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var child = process;
        if (child is null) return false;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var result = await Task.Run(() => WindowsNative.WaitForSingleObject(child, 100), CancellationToken.None).ConfigureAwait(false);
            if (result == WindowsNative.WaitTimeout) continue;
            var exited = result == WindowsNative.WaitObject0 && WindowsNative.GetExitCodeProcess(child, out _);
            if (exited) await CloseAsync(CancellationToken.None).ConfigureAwait(false);
            return exited;
        }
    }

    internal async Task CloseAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var shouldTerminate = Interlocked.Exchange(ref closed, 1) == 0;
        var child = Interlocked.Exchange(ref process, null);
        if (child is not null)
        {
            if (shouldTerminate) _ = WindowsNative.TerminateProcess(child, 1);
            await Task.Run(() => _ = WindowsNative.WaitForSingleObject(child, 30_000), CancellationToken.None).ConfigureAwait(false);
            child.Dispose();
        }
        await guardianGate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
        try
        {
            // The authenticated broker closure is the only guardian signal we own:
            // closing it drives the guardian's control EOF so the native guardian
            // exits by itself. The resident guardian lease belongs to its caller
            // (the composition/test scope that created and attached it); the host
            // lease must not dispose it, or the caller observes a nulled handle.
            await (Interlocked.Exchange(ref broker, null)?.DisposeAsync() ?? ValueTask.CompletedTask).ConfigureAwait(false);
        }
        finally { guardianGate.Release(); }
        Interlocked.Exchange(ref bootstrap, null)?.Dispose();
        Interlocked.Exchange(ref runtime, null)?.Dispose();
    }

    public ValueTask DisposeAsync() => new(CloseAsync(CancellationToken.None));
}
