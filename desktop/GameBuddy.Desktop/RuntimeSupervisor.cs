using System.Diagnostics;
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
    // The one informational frame the child may write before its acknowledgement, on the
    // SAME pipe and the SAME framing as the acknowledgement. It names the step the child is
    // entering, and optionally the player decision it is waiting for, so the launcher can
    // measure the child's SILENCE instead of guessing the whole startup from one timer.
    private const string StatusSchema = "gamebuddy-desktop-host-bootstrap-status/v1";
    // The acknowledgement means READY FOR SERVICE: by the time the child writes it, it has opened
    // its databases, provisioned the semantic authority, Magic Context and the Pi agent stores, and
    // is listening on its private channel - and everything the supervisor does next (transferring the
    // generation locks, starting the resident guardian, opening the tray and the browser) depends on
    // that.
    //
    // The wait is therefore bounded by silence, not by the whole startup: this interval is the
    // longest the child may be quiet without announcing anything, re-armed by every frame it
    // writes and suspended while it says it is waiting for its player. It is sized against the
    // same observation the old whole-startup budget was raised for - a cold first launch creates
    // several SQLite authorities and a Node runtime while antivirus and the indexer scan the
    // freshly written files - and the child's longest silent stretch by construction is the one
    // composition construction it announces as `provisioning`.
    private static readonly TimeSpan BootstrapSilenceTimeout = TimeSpan.FromMinutes(5);

    // Last resort. A child that keeps announcing progress is still not allowed to make the
    // launcher wait forever, so this ceiling stays armed throughout and is deliberately larger
    // than the silence interval.
    private static readonly TimeSpan BootstrapCeiling = TimeSpan.FromMinutes(10);

    // How long this launcher waits for the child's one-shot presentation entry AFTER the
    // acknowledgement is accepted. The child publishes it while it constructs the composition, so
    // in every real launch it is already on the pipe by this point; the bound exists for the child
    // that never publishes at all, because a launcher waiting for a presentation it will never
    // receive would be a launcher hanging on an optional fact.
    private static readonly TimeSpan PresentationHandoffWait = TimeSpan.FromSeconds(30);

    /// <summary>
    /// The player's presentation, as this launch owns it: the entry the child published and the
    /// single automatic open it gets. The shell (tray, secondary invocation) reads it to answer an
    /// explicit Open; nothing else may open it on the player's behalf.
    /// </summary>
    internal DesktopBrowserPresenter Presentation { get; init; } = new();

    /// <summary>Test-only bound override, so a focused test observes "no presentation" in milliseconds.</summary>
    internal TimeSpan? PresentationHandoffWaitForTesting { get; set; }

    /// <summary>
    /// The bounded reason this launch has (or has not) a presentation entry. It is evidence for the
    /// shell's own status, never a category the launch failure path may reuse: a missing
    /// presentation is not a failed launch.
    /// </summary>
    internal string PresentationCategory { get; private set; } = DesktopPresentationHandoffOutcome.Absent;

    /// <summary>
    /// Names the silent wait's expiry as its own reason, so "the child stopped progressing" can
    /// never again be reported as the generic runtime failure a genuinely broken start produces.
    /// </summary>
    internal const string BootstrapTimeoutCategory = "host_bootstrap_timeout";

    /// <summary>
    /// Labels the last bootstrap stage the child announced; a failed launch carries it in its
    /// diagnostic beside the child's own stderr excerpt. This is why the status channel exists:
    /// the operator reads where the child stopped, not only that it went quiet.
    /// </summary>
    internal const string BootstrapStageLabel = "host_bootstrap_last_stage";

    // Test-only hooks. Production composition neither sets nor exposes them.
    internal Func<Task>? BeforeFrameWriteForTesting { get; set; }

    /// <summary>
    /// Test-only override of the silence interval, so a focused test observes the watch expire in
    /// milliseconds instead of minutes. Production selects the constant above.
    /// </summary>
    internal TimeSpan? BootstrapSilenceTimeoutForTesting { get; set; }

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
        DesktopPresentationHandoff? handoff = null;
        // The last bootstrap stage the child announced, kept for the failure diagnostic.
        // Declared out here because the frame dispatch that records it runs behind the
        // cancellable read and the catches below report what it saw.
        string? lastStage = null;
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
            // Created BEFORE the child exists, for the same reason the broker is: the child connects
            // the moment it has this fact, and a pipe that appears later would make it retry or drop
            // the publication. The child derives the name from the bootstrap id it already receives.
            handoff = DesktopPresentationHandoff.Create(bootstrapId);
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
            // The two bounds of the pre-acknowledgement wait. Both cancel this one linked source,
            // and the classification below separates the caller's own cancellation from them.
            using var watchdog = new HostBootstrapWatchdog(timeout, BootstrapSilenceTimeoutForTesting ?? BootstrapSilenceTimeout, BootstrapCeiling);
            await HostBootstrapPipeIo.WriteOneFrameAsync(parentStdinWriter, frame, timeout.Token).ConfigureAwait(false);
            parentStdinWriter.Dispose();
            parentStdinWriter = null;
            await broker.AuthenticateHostAsync(process, timeout.Token).ConfigureAwait(false);
            var ack = await ReadAcknowledgementAsync(parentStdoutReader, selection, bootstrapId, timeout.Token, watchdog, (stage) => lastStage = stage).ConfigureAwait(false);
            if (!WindowsNative.GetExitCodeProcess(process, out _) ||
                WindowsNative.WaitForSingleObject(process, 0) != WindowsNative.WaitTimeout) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
            parentStdoutReader.Dispose();
            parentStdoutReader = null;

            // The acknowledgement is accepted, so the Host is serving and the composed surface it
            // announced is the one the player asked for. Only now is the entry read and opened: the
            // handoff is the second half of the same readiness fact, and opening a browser for a
            // launch that never reached readiness would present a surface that is not there.
            var presentation = await handoff.ReadEntryAsync(process, PresentationHandoffWaitForTesting ?? PresentationHandoffWait, cancellationToken).ConfigureAwait(false);
            PresentationCategory = presentation.Category;
            await handoff.DisposeAsync().ConfigureAwait(false);
            handoff = null;
            if (presentation.LaunchUrl is not null)
            {
                Presentation.Adopt(presentation.LaunchUrl);
                // Best-effort by construction: this returns false rather than throwing when the
                // player's shell cannot open a browser, and the Host session above keeps running.
                _ = Presentation.OpenOnce();
            }

            var locks = runtime.TransferLocks();
            var lease = new RuntimeSupervisorLease(process, locks.Runtime, locks.Bootstrap, ack, broker);
            brokerTransferred = true;
            process = null;
            return lease;
        }
        catch (GuardianLaunchUnavailableException exception)
        {
            await AttachBootstrapDiagnosticsAsync(exception, childStderr, lastStage).ConfigureAwait(false);
            throw;
        }
        catch (OperationCanceledException exception)
        {
            // Distinguish the caller cancelling the launch from this launcher's own bounds: the
            // first means the launch was abandoned, the second means the child stopped
            // progressing and the silence watch named it. Reporting both as the generic runtime
            // failure is what hid the old whole-startup budget's expiry.
            var unavailable = new GuardianLaunchUnavailableException(
                cancellationToken.IsCancellationRequested ? "host_runtime_unavailable" : BootstrapTimeoutCategory,
                exception);
            await AttachBootstrapDiagnosticsAsync(unavailable, childStderr, lastStage).ConfigureAwait(false);
            throw unavailable;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException or OutOfMemoryException or JsonException)
        {
            var unavailable = new GuardianLaunchUnavailableException("host_runtime_unavailable", exception);
            await AttachBootstrapDiagnosticsAsync(unavailable, childStderr, lastStage).ConfigureAwait(false);
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
            if (handoff is not null) await handoff.DisposeAsync().ConfigureAwait(false);
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
    /// Binds the two facts the launcher owns about a failed launch to the failure it is
    /// about to report: the last bootstrap stage the child announced, and the child's own
    /// stderr excerpt. The category is untouched. A stage is only reported when one was
    /// actually observed, and a capture that retained nothing says so instead of pretending
    /// the child was silent. It runs at most once per exception.
    /// </summary>
    private static async Task AttachBootstrapDiagnosticsAsync(GuardianLaunchUnavailableException exception, ChildStderrCapture? capture, string? lastStage)
    {
        if (exception.Diagnostic is not null || (capture is null && lastStage is null)) return;
        var parts = new List<string>(2);
        if (lastStage is not null) parts.Add($"{BootstrapStageLabel}: {lastStage}");
        if (capture is not null) parts.Add(ChildStderrExcerpt.Format(await capture.ExcerptAsync().ConfigureAwait(false)));
        exception.Diagnostic = string.Join(' ', parts);
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

    /// <summary>
    /// Reads the frames the child writes before its acknowledgement, dispatching every status frame
    /// and accepting the acknowledgement as the only success.
    ///
    /// Status frames are informational: any number of them may arrive, and each one re-arms the
    /// silence watch (or suspends it, when it names a player decision). A frame that is neither a
    /// valid status frame nor the acknowledgement fails the handshake closed, so a malformed or
    /// out-of-order status frame can never be mistaken for readiness, and neither can the
    /// acknowledgement be read as a mere status frame.
    /// </summary>
    private static async Task<HostBootstrapResult> ReadAcknowledgementAsync(SafeFileHandle reader, InstalledGenerationSelection selection, string bootstrapId, CancellationToken cancellationToken, HostBootstrapWatchdog watchdog, Action<string> observedStage)
    {
        HostBootstrapResult? acknowledgement = null;
        // The loop stops at the acknowledgement instead of at the end of the stream: the child keeps
        // its stdout open for as long as it serves, so waiting for the end of the stream would wait
        // for the whole product to stop.
        await HostBootstrapPipeIo.ReadFramesAsync(reader, MaxWireBytes, (frame) =>
        {
            var stage = DispatchBootstrapFrame(frame, selection, bootstrapId, watchdog);
            if (stage is null)
            {
                acknowledgement = new HostBootstrapResult();
                return false;
            }
            observedStage(stage);
            return true;
        }, cancellationToken).ConfigureAwait(false);
        // No acknowledgement before the end of the stream is the child closing its own handshake,
        // which is exactly the failure an empty read reported before.
        return acknowledgement ?? throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
    }

    /// <summary>
    /// Classifies one frame the child wrote. Returns the announced stage for a status frame; null
    /// means this frame is the acknowledgement. The two schemas are disjoint and each frame is
    /// validated against its own exact shape here, so a status frame that copies the
    /// acknowledgement's fields is refused rather than served, and the acknowledgement is never
    /// read as one more status frame.
    /// </summary>
    private static string? DispatchBootstrapFrame(byte[] frame, InstalledGenerationSelection selection, string bootstrapId, HostBootstrapWatchdog watchdog)
    {
        ValidateOneWireDocument(frame);
        using var document = JsonDocument.Parse(frame[..^1]);
        var value = document.RootElement;
        if (value.ValueKind != JsonValueKind.Object) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        var schema = value.TryGetProperty("schema", out var schemaValue) && schemaValue.ValueKind == JsonValueKind.String ? schemaValue.GetString() : null;
        if (schema == StatusSchema)
        {
            if (!TryReadStatus(value, out var stage, out var waitingForPlayerInput)) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
            // The child proved it is progressing. A frame that names the player decision it is
            // about to wait for suspends the silence watch; the next frame that does not arms it
            // again.
            watchdog.ObserveFrame(waitingForPlayerInput);
            return stage;
        }
        if (IsAcknowledgement(value, selection, bootstrapId)) return null;
        throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
    }

    private static bool IsAcknowledgement(JsonElement ack, InstalledGenerationSelection selection, string bootstrapId) =>
        ExactPropertiesInOrder(ack, "schema", "protocolVersion", "status", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "rootLayoutSchema") &&
        ack.GetProperty("schema").GetString() == "gamebuddy-desktop-host-bootstrap/v1" &&
        ack.GetProperty("protocolVersion").GetInt32() == 1 &&
        ack.GetProperty("status").GetString() == "accepted" &&
        ack.GetProperty("bootstrapId").GetString() == bootstrapId &&
        ack.GetProperty("generation").GetString() == selection.Generation &&
        ack.GetProperty("inventoryDigest").GetString() == selection.InventoryDigest &&
        ack.GetProperty("runtimeAdmissionSha256").GetString() == selection.RuntimeAdmissionSha256 &&
        ack.GetProperty("rootLayoutSchema").GetString() == "gamebuddy-windows-root-layout/v1";

    /// <summary>
    /// Reads one status frame: the exact ordinal key sequence the child writes, two bounded tokens
    /// and the optional wait statement. The stage order is protocol here for the same reason it is
    /// for every other frame on this wire - it keeps exactly one shape acceptable - and the
    /// wait statement is the only field that may follow the stage.
    /// </summary>
    private static bool TryReadStatus(JsonElement value, out string stage, out bool waitingForPlayerInput)
    {
        stage = string.Empty;
        waitingForPlayerInput = false;
        if (value.ValueKind != JsonValueKind.Object) return false;
        var names = value.EnumerateObject().Select(property => property.Name).ToArray();
        var announced = names.Length == 4 && names[3] == "waitingForPlayerInput";
        if ((names.Length != 3 && !announced) || names[0] != "schema" || names[1] != "protocolVersion" || names[2] != "stage") return false;
        if (value.GetProperty("schema").GetString() != StatusSchema || value.GetProperty("protocolVersion").GetInt32() != 1) return false;
        var announcedStage = value.GetProperty("stage").GetString();
        if (announcedStage is null || !ValidStatusToken(announcedStage)) return false;
        stage = announcedStage;
        if (!announced) return true;
        var waiting = value.GetProperty("waitingForPlayerInput").GetString();
        if (waiting is null || !ValidStatusToken(waiting)) return false;
        waitingForPlayerInput = true;
        return true;
    }

    private static bool ValidStatusToken(string value) =>
        value.Length is > 0 and <= 64 && value[0] is >= 'a' and <= 'z' && value.All(static character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '-');

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

    /// <summary>
    /// Reads the endpoint frame by frame - one LF-terminated document at a time - handing every
    /// complete frame to the sink until the sink asks to stop or the endpoint reaches its end.
    ///
    /// This is a LINE reader, not a read-to-end. The acknowledgement no longer closes the child's
    /// standard output, because the child writes informational status frames before it and then
    /// goes on serving, so a read that waited for the end of the stream would wait for the whole
    /// product to stop. A trailing partial document is handed over too, so a child that dies
    /// mid-frame is refused by the frame validation instead of looking like a silent child.
    ///
    /// Cancellation keeps the shape it always had: the endpoint is closed and the worker is
    /// released with CancelSynchronousIo, which is the only thing that unblocks a synchronous read.
    /// </summary>
    internal static Task ReadFramesAsync(SafeFileHandle reader, int maximumFrameBytes, Func<byte[], bool> onFrame, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(reader);
        ArgumentNullException.ThrowIfNull(onFrame);
        if (maximumFrameBytes <= 0) throw new ArgumentOutOfRangeException(nameof(maximumFrameBytes));
        return RunSynchronousIoAsync(reader, () =>
        {
            using var stream = new FileStream(reader, FileAccess.Read, bufferSize: 4096, isAsync: false);
            using var frame = new MemoryStream();
            var buffer = new byte[4096];
            while (true)
            {
                var count = stream.Read(buffer, 0, buffer.Length);
                if (count == 0)
                {
                    // The endpoint reached its end: nothing more can arrive on it.
                    if (frame.Length != 0) onFrame(frame.ToArray());
                    return;
                }
                for (var index = 0; index < count; index++)
                {
                    frame.WriteByte(buffer[index]);
                    if (frame.Length > maximumFrameBytes) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
                    if (buffer[index] != (byte)'\n') continue;
                    var complete = frame.ToArray();
                    frame.SetLength(0);
                    if (!onFrame(complete)) return;
                }
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

/// <summary>
/// Bounds the pre-acknowledgement wait on the child's own behaviour, over the same linked source
/// the handshake already carries.
///
/// Two independent bounds replace the single whole-startup timer:
/// <list type="bullet">
/// <item>the SILENCE watch expires when no frame of any kind arrived for the configured interval,
/// which is what "the child is not progressing" actually means. It is re-armed by every frame the
/// child writes and suspended while a frame says the child is waiting for its player, so a child
/// waiting for a human decision is never killed for being quiet; the next frame that does not say
/// so arms it again.</item>
/// <item>the CEILING stays armed throughout as the last resort, so a child that keeps announcing
/// progress still cannot make the launcher wait forever.</item>
/// </list>
///
/// Both cancel the same source, so neither mints a category of its own: the caller still tells its
/// own cancellation from these two by token identity, and both report the one bounded
/// <c>host_bootstrap_timeout</c> reason whose name now means exactly what it says.
/// </summary>
internal sealed class HostBootstrapWatchdog : IDisposable
{
    private readonly CancellationTokenSource cancellation;
    private readonly TimeSpan silence;
    private readonly Timer silenceTimer;
    private readonly Timer ceilingTimer;
    private readonly object gate = new();
    private long lastProgress = Stopwatch.GetTimestamp();
    private bool waitingForPlayerInput;

    internal HostBootstrapWatchdog(CancellationTokenSource cancellation, TimeSpan silenceTimeout, TimeSpan ceiling)
    {
        ArgumentNullException.ThrowIfNull(cancellation);
        if (silenceTimeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(silenceTimeout));
        if (ceiling <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(ceiling));
        this.cancellation = cancellation;
        silence = silenceTimeout;
        // Armed before the launcher writes its own frame: a child that never starts, never reads
        // the frame or never answers is silent in exactly the same way as one that wedges later.
        silenceTimer = new Timer(OnSilenceExpired, null, silenceTimeout, Timeout.InfiniteTimeSpan);
        ceilingTimer = new Timer(OnCeilingExpired, null, ceiling, Timeout.InfiniteTimeSpan);
    }

    /// <summary>
    /// One frame arrived from the child. The next silence is measured from here; a frame that says
    /// the child is waiting for its player disarms the watch entirely, and any later frame that
    /// does not say so arms it again.
    /// </summary>
    internal void ObserveFrame(bool waitingForPlayerInput)
    {
        lock (gate)
        {
            if (cancellation.IsCancellationRequested) return;
            lastProgress = Stopwatch.GetTimestamp();
            this.waitingForPlayerInput = waitingForPlayerInput;
            silenceTimer.Change(waitingForPlayerInput ? Timeout.InfiniteTimeSpan : silence, Timeout.InfiniteTimeSpan);
        }
    }

    private void OnSilenceExpired(object? state)
    {
        // The elapsed check decides in the child's favour: a frame that reached the launcher between
        // this timer's expiry and this callback moved the progress mark, so the child that just
        // spoke is not killed for a silence it already ended.
        var expired = false;
        lock (gate) expired = !waitingForPlayerInput && Stopwatch.GetElapsedTime(lastProgress) >= silence;
        if (expired) cancellation.Cancel();
    }

    private void OnCeilingExpired(object? state)
    {
        // Deliberately unconditional: the ceiling is the last resort, not a progress measurement.
        cancellation.Cancel();
    }

    public void Dispose()
    {
        silenceTimer.Dispose();
        ceilingTimer.Dispose();
    }
}
