using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// The Desktop-private, bootstrap-bound resident Guardian relay. It owns the pipe
/// and never projects its endpoint, native control credentials, or raw responses.
/// </summary>
internal sealed class DesktopHostBootstrapBroker : IAsyncDisposable
{
    private const int MaxWireBytes = 16_384;
    private static readonly TimeSpan MaximumDeadline = TimeSpan.FromMinutes(5);
    private readonly string bootstrapId;
    private readonly string generation;
    private readonly string inventoryDigest;
    private readonly string runtimeAdmissionSha256;
    // Retained only to bind this one-shot broker to the exact canonical layout
    // that Desktop places in the matching bootstrap frame.
    private readonly CurrentUserRootLayout layout;
    private readonly NamedPipeServerStream server;
    // Not readonly: the recovery launch belongs to the assembler that owns the
    // admitted Guardian image, and the broker exists before that assembler can
    // hand it over. Mounting after construction is safe because the command
    // loop that can ask for a recovery does not start until
    // AttachResidentGuardianFactory, and AttachRecoveryLaunch refuses late mounts.
    private Func<CancellationToken, Task<GuardianRecoverySupervisorLease>>? startRecovery;
    // The factory this broker creates its own resident Guardian from - one process per attempt, and the
    // attempt's Guardian is what the slot below holds. Mounted the same way, and once.
    private Func<CancellationToken, Task<GuardianSupervisorLease>>? startGuardian;
    // Borrowed, never owned: the runtime lease disposes this broker before it releases the child handle,
    // so the child this broker authenticated its first session against is still open for every later one.
    private WindowsNative.SafeProcessHandle? host;
    private bool accepted;
    private bool closed;
    private Task? commandLoop;
    private CancellationTokenSource? sessionClosing;
    private readonly SemaphoreSlim attemptGate = new(1, 1);
    // The one gate over the bytes this broker writes to the Host: acknowledgements come from the
    // session loop and a role's own ending comes from the Guardian's reader, and the pipe's
    // contract is one whole frame per write.
    private readonly SemaphoreSlim hostWriteGate = new(1, 1);

    // The one attempt at a time this broker serves, and everything that belongs to it. The Guardian is
    // the resource: it is created when the attempt arms, settled when the attempt ends, and the slot is
    // free again only after the settlement has proven its process gone.
    private GuardianSupervisorLease? guardian;
    private GuardianProcessIdentity? guardianIdentity;
    private string? attemptId;
    private bool armed;
    private readonly HashSet<string> launchedRoles = new(StringComparer.Ordinal);
    private readonly HashSet<string> containedRoles = new(StringComparer.Ordinal);
    private GuardianCorrelation? correlation;

    private DesktopHostBootstrapBroker(string bootstrapId, InstalledGenerationSelection selection, CurrentUserRootLayout layout, Func<CancellationToken, Task<GuardianRecoverySupervisorLease>>? startRecovery)
    {
        this.bootstrapId = bootstrapId;
        this.layout = layout;
        this.startRecovery = startRecovery;        generation = selection.Generation;
        inventoryDigest = selection.InventoryDigest;
        runtimeAdmissionSha256 = selection.RuntimeAdmissionSha256;
        server = new NamedPipeServerStream($"GameBuddy.HostGuardian.{bootstrapId}", PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | PipeOptions.FirstPipeInstance,
            MaxWireBytes, MaxWireBytes);
    }

    internal static DesktopHostBootstrapBroker Create(string bootstrapId, InstalledGenerationSelection selection, CurrentUserRootLayout layout, Func<CancellationToken, Task<GuardianRecoverySupervisorLease>>? startRecovery = null)
    {
        ArgumentNullException.ThrowIfNull(selection);
        ArgumentNullException.ThrowIfNull(layout);
        if (!IsHex(bootstrapId)) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        // Before anything of this launch exists: a Guardian an earlier Desktop left behind still holds its
        // lease mutex and the player Job, and it is the only artifact that can name that process.
        DesktopGuardianAttemptRecord.Recover(layout.OperationalRoot);
        return new DesktopHostBootstrapBroker(bootstrapId, selection, layout, startRecovery);
    }

    /// <summary>
    /// Authenticates the Host child this broker belongs to, and serves it. This first session is the
    /// bootstrap's own: the runtime lease awaits it before the acknowledged launch may continue. Every
    /// later session is the same child re-authenticating on the same one-instance pipe, which is how one
    /// attempt ends and the next one begins (ADR-0015 §3: attempt = session).
    /// </summary>
    internal async Task AuthenticateHostAsync(WindowsNative.SafeProcessHandle child, CancellationToken cancellationToken)
    {
        EnsureLayoutBinding();
        host = child;
        await AcceptSessionAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Waits for one authenticated session, and refuses every connection whose frame this broker cannot
    /// accept, one connection at a time, until the child this broker belongs to speaks the hello.
    ///
    /// A frame that is too long, is not JSON, is not this launch's hello, or arrives from anything but
    /// that child refuses THE CONNECTION IT ARRIVED ON and nothing else. The pipe is bound to one child
    /// (`maxInstances: 1`, `FirstPipeInstance`) and only that child can authenticate on it, so a refused
    /// frame proves the writer of that connection is not serving this launch's hello - it says nothing
    /// about the launch, which the re-offered pipe is for (ADR-0015 §3: the session is the attempt, so
    /// ending one is not ending the launch). Measured 2026-11-22: the Host's own session frame grew past
    /// `MaxWireBytes`, and the launch that frame belonged to was ended by the refusal.
    ///
    /// The wait is bounded outside this method - the supervisor hands in the bootstrap watchdog's token,
    /// whose silence interval and ceiling are the launch's own numbers - so a child that never speaks a
    /// hello still fails this launch, by name, without a second bound declared here.
    /// </summary>
    private async Task AcceptSessionAsync(CancellationToken cancellationToken)
    {
        var child = host ?? throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        while (true)
        {
            accepted = false;
            await server.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                await AcceptConnectionAsync(child, cancellationToken).ConfigureAwait(false);
                return;
            }
            // `EndOfStreamException` is an `IOException`: a peer that closed control inside its hello is
            // refused by the same answer as one that wrote bytes this broker cannot read.
            catch (Exception exception) when (exception is GuardianLaunchUnavailableException or IOException or JsonException)
            {
                DropRefusedConnection();
            }
        }
    }

    /// <summary>
    /// Authenticates the one connection this broker accepted. Everything here is decided from that
    /// connection alone, so anything refused here is refused with the connection (see the caller).
    /// </summary>
    private async Task AcceptConnectionAsync(WindowsNative.SafeProcessHandle child, CancellationToken cancellationToken)
    {
        if (!WindowsNative.GetNamedPipeClientProcessId(server.SafePipeHandle, out var clientPid) || clientPid != WindowsNative.GetProcessId(child) ||
            !WindowsNative.ProcessIdToSessionId(clientPid, out var clientSession) || !WindowsNative.ProcessIdToSessionId(WindowsNative.GetCurrentProcessId(), out var currentSession) || clientSession != currentSession)
            throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        VerifySameCurrentUserSid(child);
        var hello = await ReadFrameAsync(cancellationToken).ConfigureAwait(false);
        // The hello request's key sequence is declared beside the Host client that writes it
        // (host/src/bootstrap/wire/desktop-guardian-session-hello.keys.json). This broker cannot read that declaration at
        // runtime - it serves a launch on the player's machine - so the list below is a copy on purpose, and
        // tools/desktop-composition-launch.test.mjs compares it with the declaration; do not "fix" the copy.
        if (!ExactObject(hello, "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256") ||
            hello.GetProperty("schema").GetString() != "gamebuddy-desktop-guardian-session/v1" || hello.GetProperty("protocolVersion").GetInt32() != 1 || hello.GetProperty("operation").GetString() != "hello" ||
            hello.GetProperty("bootstrapId").GetString() != bootstrapId || hello.GetProperty("generation").GetString() != generation || hello.GetProperty("inventoryDigest").GetString() != inventoryDigest || hello.GetProperty("runtimeAdmissionSha256").GetString() != runtimeAdmissionSha256)
            throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        await WriteAsync(new
        {
            schema = "gamebuddy-desktop-guardian-session/v1", protocolVersion = 1, operation = "hello", status = "accepted", bootstrapId,
            generation, inventoryDigest, runtimeAdmissionSha256,
        }, cancellationToken).ConfigureAwait(false);
        accepted = true;
    }

    /// <summary>
    /// Gives the one pipe instance back after a connection was refused, so the next connection is
    /// accepted. A client that left before this ran has already produced the state this asks for, and
    /// the instance reporting either way is not a second failure.
    /// </summary>
    private void DropRefusedConnection()
    {
        try { server.Disconnect(); }
        catch (IOException) { }
        catch (InvalidOperationException) { }
    }

    /// <summary>
    /// Mounts the recovery launch the authenticated Host may ask this session to
    /// perform. The assembler that holds the admitted Guardian image supplies it
    /// after the Host is authenticated and before the command loop starts; a late
    /// mount would leave a window where a recovery request fails closed, so it is
    /// refused once the loop is serving.
    /// </summary>
    internal void AttachRecoveryLaunch(Func<CancellationToken, Task<GuardianRecoverySupervisorLease>> startRecovery)
    {
        ArgumentNullException.ThrowIfNull(startRecovery);
        if (closed || commandLoop is not null || this.startRecovery is not null) throw new GuardianLaunchUnavailableException();
        this.startRecovery = startRecovery;
    }

    /// <summary>
    /// Mounts the factory this broker creates its own resident Guardian from, and starts serving. This is
    /// the mount, not an attach: the launcher hands over HOW to create a Guardian and keeps no lease, so a
    /// Guardian exists exactly while an attempt is armed and is settled by this broker when that attempt
    /// ends. Mounting twice is refused, because the command loop it starts is the one thing here that runs
    /// for the broker's whole life.
    /// </summary>
    internal Task AttachResidentGuardianFactory(Func<CancellationToken, Task<GuardianSupervisorLease>> startGuardian, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(startGuardian);
        cancellationToken.ThrowIfCancellationRequested();
        if (!accepted || closed || this.startGuardian is not null || host is null) throw new GuardianLaunchUnavailableException();
        this.startGuardian = startGuardian;
        commandLoop = Task.Run(() => ServeSessionsAsync(host, cancellationToken), CancellationToken.None);
        return Task.CompletedTask;
    }

    /// <summary>
    /// Serves the Host one session at a time, and settles the attempt each session was driving before it
    /// will read anything from the next one.
    ///
    /// A session that ends - the Host closed control - ends that session's attempt: its Guardian is settled
    /// here, its pid proven gone, its record retired. The instance is released from that session before the
    /// settlement begins, so the accept that follows is the next thing this broker does.
    ///
    /// Releasing it does not make the NAME connectable while the settlement runs: a client connecting in
    /// that window meets ERROR_PIPE_BUSY - the same code a session in flight produces, measured on this
    /// construction, and not ERROR_FILE_NOT_FOUND - which libuv waits out (measured: ~5,5 s) instead of
    /// reporting, so a Host that reconnects here waits rather than failing. The window is bounded from the
    /// other side too: a Host cannot arm a new attempt until its own settlement has seen this attempt's
    /// Guardian-owned objects gone, which is exactly the exit awaited here. What the ordering buys is
    /// therefore the accept, not the release; nothing is READ from a connection until the attempt above is
    /// settled, and that is where the exclusion lives. A settled attempt can therefore never be reachable from
    /// the next one, no command is served while two Guardians could be resident, and nothing of a session's
    /// correlation survives it: the next arm arrives on a connection that was authenticated again
    /// (ADR-0015 §3, §4.2).
    /// </summary>
    private async Task ServeSessionsAsync(WindowsNative.SafeProcessHandle host, CancellationToken cancellationToken)
    {
        try
        {
            while (!closed)
            {
                using (var attemptClosing = new CancellationTokenSource())
                {
                    sessionClosing = attemptClosing;
                    try { await ServeSessionAsync(attemptClosing, cancellationToken).ConfigureAwait(false); }
                    finally { sessionClosing = null; }
                }
                // Everything the finished attempt held is still being settled. Releasing the instance here
                // does not make the name connectable on its own (a disconnected instance still answers
                // ERROR_PIPE_BUSY); it means the accept below runs the instant the settlement finishes.
                server.Disconnect();
                await SettleAttemptAsync().ConfigureAwait(false);
                if (closed) return;
                await AcceptSessionAsync(cancellationToken).ConfigureAwait(false);
            }
        }
        catch
        {
            // The session failed before any child published an exit deadline, so there is no budget to
            // draw on: the one thing still being waited for is the guardian's containment of the roles
            // it created, and its own ceiling is the declared number for that.
            await CloseAsync(new ShutdownBudget(GuardianSupervisorLease.ContainmentCeilingMs), CancellationToken.None).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Serves one Host session until the Host closes control. A closed pipe is the normal end of a session,
    /// not a failure: the attempt it was driving is settled by the caller. Only a frame this broker cannot
    /// accept ends the broker itself (the catch above).
    /// </summary>
    private async Task ServeSessionAsync(CancellationTokenSource attemptClosing, CancellationToken cancellationToken)
    {
        var closing = attemptClosing.Token;
        byte? queuedCommandFirstByte = null;
        while (!closed)
        {
            JsonElement command;
            try { command = await ReadFrameAsync(cancellationToken, queuedCommandFirstByte).ConfigureAwait(false); }
            // The Host closed control with no frame in flight: that is how an attempt ENDS, and the session
            // ends with it. A pipe that closes while a frame is already half-read is the other thing - a
            // truncated frame - and is refused by the throw below.
            catch (EndOfStreamException) when (queuedCommandFirstByte is null) { return; }
            queuedCommandFirstByte = null;
            if (!TryParseCommand(command, out var parsed)) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
            using var deadline = BindCommandDeadline(parsed, cancellationToken);
            using var commandClosing = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, closing, deadline.Token);
            var commandCancellation = commandClosing.Token;
            if (parsed.Operation == "recover_attempt")
            {
                await RelayRecoveryAsync(parsed, commandCancellation).ConfigureAwait(false);
                continue;
            }
            ValidateTransition(parsed);
            if (parsed.Operation == "arm_attempt") await ArmAsync(parsed, commandCancellation).ConfigureAwait(false);
            var native = new GuardianRelayCommand(parsed.Operation, parsed.GuardianInstanceId, parsed.GuardianEpoch, parsed.AttemptId, parsed.Role, parsed.PrivateFrame, parsed.DeadlineUnixMs, parsed.OperationWaitBudgetMs);
            using var relayClosing = CancellationTokenSource.CreateLinkedTokenSource(commandCancellation);
            var relay = guardian!.RelayResidentAsync(native, commandCancellation);
            var pipeRead = WatchForHostPipeReadAsync(relayClosing.Token);
            if (await Task.WhenAny(relay, pipeRead).ConfigureAwait(false) == pipeRead)
            {
                var firstByte = await pipeRead.ConfigureAwait(false);
                if (firstByte is null)
                {
                    await AbandonSessionAsync(relay).ConfigureAwait(false);
                    return;
                }
                queuedCommandFirstByte = firstByte;
            }
            else
            {
                if (pipeRead.IsCompleted)
                {
                    var firstByte = await pipeRead.ConfigureAwait(false);
                    if (firstByte is null)
                    {
                        await AbandonSessionAsync(relay).ConfigureAwait(false);
                        return;
                    }
                    queuedCommandFirstByte = firstByte;
                }
                else
                {
                    relayClosing.Cancel();
                    try { _ = await pipeRead.ConfigureAwait(false); } catch (OperationCanceledException) { }
                }
            }
            var result = await relay.ConfigureAwait(false);
            if (closing.IsCancellationRequested) throw new GuardianLaunchUnavailableException();
            parsed.ThrowIfExpired(commandCancellation);
            AdvanceTransition(parsed);
            parsed.ThrowIfExpired(commandCancellation);
            // The acknowledgement is the answer to the command this session is relaying. A role
            // that ended on its own is not: it reaches the Host from the Guardian's continuous
            // reader (`GuardianSupervisorLease.RoleExitRelay`), whether or not a command was ever
            // in front of it.
            await WriteAcknowledgementAsync(parsed, result, commandCancellation).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// The Host closed control while this broker was relaying. The command is given up on, the Guardian's
    /// control channel is closed so the native leaves (and so the in-flight relay unblocks), and the session
    /// ends normally: the caller's settlement is what proves the process gone.
    /// </summary>
    private async Task AbandonSessionAsync(Task<string> relay)
    {
        sessionClosing?.Cancel();
        // Control EOF first: a relay waiting on the native can only finish once the native has left.
        if (guardian is not null) await guardian.CloseControlAsync(CancellationToken.None).ConfigureAwait(false);
        // A relay this launcher gave up on can fail in any way; the settlement is what answers for it.
        try { _ = await relay.ConfigureAwait(false); } catch { }
    }

    /// <summary>
    /// Gives this attempt its own resident Guardian, once.
    ///
    /// The Guardian is created here because the attempt is armed here - a session that never arms never
    /// creates one - and the record is written in the same breath, because from this instant until the
    /// settlement proves that process gone the record is the only artifact that can name it. Nothing is
    /// created for a second arm in the same attempt: `ValidateTransition` has already refused it, because the
    /// native Guardian is once-only per process and this slot holds that one process.
    /// </summary>
    private async Task ArmAsync(BrokerCommand command, CancellationToken cancellationToken)
    {
        await attemptGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        (GuardianSupervisorLease? Lease, GuardianProcessIdentity? Identity, string? AttemptId) unserved;
        try
        {
            if (guardian is not null || startGuardian is null) throw new GuardianLaunchUnavailableException();
            var created = await startGuardian(cancellationToken).ConfigureAwait(false);
            // Where a role that ends on its own is written. Set before any command is relayed,
            // because the correlation this needs is this broker's and the session's, and a
            // death that arrived with nowhere to go would fail closed rather than be dropped.
            created.RoleExitRelay = WriteRoleExitAsync;
            guardian = created;
            guardianIdentity = new GuardianProcessIdentity(created.Pid, created.StartedAtUnixMs, created.ExecutablePath);
            attemptId = command.AttemptId;
            DesktopGuardianAttemptRecord.Armed(layout.OperationalRoot, bootstrapId, command.AttemptId, guardianIdentity.Value);
            return;
        }
        catch
        {
            // A Guardian this broker created is this broker's to end, whatever went wrong after it.
            unserved = TakeAttempt();
        }
        finally { attemptGate.Release(); }
        await SettleTakenAsync(unserved).ConfigureAwait(false);
        throw new GuardianLaunchUnavailableException();
    }

    /// <summary>
    /// Empties the attempt slot and hands back what it held. Called with <see cref="attemptGate"/> held.
    /// The slot is emptied FIRST so that, from this instant, nothing can find an attempt here - which is the
    /// mutual exclusion: there is never a second live Guardian while the first is still being settled.
    /// </summary>
    private (GuardianSupervisorLease? Lease, GuardianProcessIdentity? Identity, string? AttemptId) TakeAttempt()
    {
        var taken = (guardian, guardianIdentity, attemptId);
        guardian = null;
        guardianIdentity = null;
        attemptId = null;
        armed = false;
        launchedRoles.Clear();
        containedRoles.Clear();
        correlation = null;
        return taken;
    }

    private async Task SettleAttemptAsync()
    {
        (GuardianSupervisorLease? Lease, GuardianProcessIdentity? Identity, string? AttemptId) taken;
        await attemptGate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
        try { taken = TakeAttempt(); }
        finally { attemptGate.Release(); }
        await SettleTakenAsync(taken).ConfigureAwait(false);
    }

    /// <summary>
    /// Settles the attempt that was in the slot: bounded wait, then the kill as the watchdog over it, then
    /// the process object read once more - and then the record follows that answer.
    ///
    /// The record is retired only when the process is PROVEN gone, because that answer is the one that says
    /// nothing was left behind. When it could not be proven, the record stays and says so, and the next
    /// launch is what ends that exact process (see <see cref="DesktopGuardianAttemptRecord"/>). No part of
    /// this is a player-world operation: a settlement that is not an explicit endgame never reaches the roles
    /// (ADR-0007), and closing control is what a Guardian is designed to survive.
    /// </summary>
    private async Task SettleTakenAsync((GuardianSupervisorLease? Lease, GuardianProcessIdentity? Identity, string? AttemptId) taken)
    {
        if (taken.Lease is null) return;
        var gone = await taken.Lease.SettleAsync().ConfigureAwait(false);
        await taken.Lease.DisposeAsync().ConfigureAwait(false);
        if (gone) DesktopGuardianAttemptRecord.Retire(layout.OperationalRoot);
        else if (taken.Identity is { } identity && taken.AttemptId is { } attempt)
            DesktopGuardianAttemptRecord.Unsettled(layout.OperationalRoot, bootstrapId, attempt, identity);
    }

    private async Task RelayRecoveryAsync(BrokerCommand command, CancellationToken cancellationToken)
    {
        if (startRecovery is null || armed || correlation is not null || command.RecoveryInstanceId is null || command.PrivateFrame is null)
            throw new GuardianLaunchUnavailableException();
        var state = new GuardianRecoverySessionState(command.GuardianInstanceId, command.GuardianEpoch, command.AttemptId, command.RecoveryInstanceId);
        await using var recovery = await startRecovery(cancellationToken).ConfigureAwait(false);
        command.ThrowIfExpired(cancellationToken);
        var gate = await recovery.SendPreCasAsync(command.PrivateFrame, cancellationToken).ConfigureAwait(false);
        if (gate == "held")
        {
            await WriteAcknowledgementAsync(command, "unavailable", cancellationToken).ConfigureAwait(false);
            return;
        }
        state.GateAcquired();
        await WriteAcknowledgementAsync(command, "recovery_accepted", cancellationToken).ConfigureAwait(false);
        // The Host must now make its durable beginRecovery CAS before this second one-shot command.
        var post = await ReadFrameAsync(cancellationToken).ConfigureAwait(false);
        if (!TryParseRecoveryPostCas(post, command, out var postBinding)) throw new GuardianLaunchUnavailableException();
        command.ThrowIfExpired(cancellationToken);
        await recovery.SendPostCasAsync(postBinding, cancellationToken).ConfigureAwait(false);
        state.PostCasBound();
        var recover = await ReadFrameAsync(cancellationToken).ConfigureAwait(false);
        if (!TryParseRecoveryCommand(recover, command, out var nativeRecover)) throw new GuardianLaunchUnavailableException();
        await recovery.RecoverAttemptAsync(nativeRecover, cancellationToken).ConfigureAwait(false);
        state.RecoverAuthorized();
        foreach (var role in new[] { "playerHost", "aiClient" })
        {
            command.ThrowIfExpired(cancellationToken);
            var result = await recovery.ClassifyAsync(role, cancellationToken).ConfigureAwait(false);
            if (result != "contained")
            {
                // Player recovery is intentionally unavailable: the Player Job is
                // never opened or drained. Still consume the AI classification so
                // its kill-on-close Job is cleaned up before reporting the terminal
                // Player result to the caller. No player CAS, contained ACK, or
                // release settlement is emitted for this path.
                if (role == "playerHost")
                {
                    command.ThrowIfExpired(cancellationToken);
                    _ = await recovery.ClassifyAsync("aiClient", cancellationToken).ConfigureAwait(false);
                }
                await WriteAcknowledgementAsync(command, result, cancellationToken).ConfigureAwait(false);
                return;
            }
            state.RoleContained(role);
            await WriteAcknowledgementAsync(command, role == "playerHost" ? "player_contained" : "ai_contained", cancellationToken).ConfigureAwait(false);
            var cas = await ReadFrameAsync(cancellationToken).ConfigureAwait(false);
            if (!TryParseRecoveryCasAcknowledgement(cas, command, role)) throw new GuardianLaunchUnavailableException();
        }
        var finalized = await ReadFrameAsync(cancellationToken).ConfigureAwait(false);
        if (!TryParseRecoveryFinalizeAcknowledgement(finalized, command)) throw new GuardianLaunchUnavailableException();
        state.FinalizeAcknowledged();
        var release = await ReadFrameAsync(cancellationToken).ConfigureAwait(false);
        if (!ExactObject(release, "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "operationWaitBudgetMs", "guardianInstanceId", "guardianEpoch", "attemptId", "recoveryInstanceId") ||
            release.GetProperty("schema").GetString() != "gamebuddy-desktop-guardian-session/v1" || release.GetProperty("protocolVersion").GetInt32() != 1 || release.GetProperty("operation").GetString() != "release" ||
            !release.GetProperty("operationWaitBudgetMs").TryGetInt64(out var operationWaitBudgetMs) || operationWaitBudgetMs != command.OperationWaitBudgetMs || !MatchesRecoveryCorrelation(release, command)) throw new GuardianLaunchUnavailableException();
        state.ReleaseRequested();
        await recovery.ReleaseAndVerifyExitAsync(cancellationToken).ConfigureAwait(false);
        state.TerminalVerified();
        await WriteAcknowledgementAsync(command, "contained", cancellationToken).ConfigureAwait(false);
    }

    private bool TryParseCommand(JsonElement value, out BrokerCommand command)
    {
        command = default!;
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("operation", out var operationValue) || operationValue.ValueKind != JsonValueKind.String) return false;
        var operation = operationValue.GetString();
        var names = operation switch
        {
            "arm_attempt" => new[] { "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "operationWaitBudgetMs", "guardianInstanceId", "guardianEpoch", "attemptId", "privateFrame" },
            "launch_role" => new[] { "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "deadlineUnixMs", "guardianInstanceId", "guardianEpoch", "attemptId", "role", "privateFrame" },
            "contain_role" => new[] { "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "operationWaitBudgetMs", "guardianInstanceId", "guardianEpoch", "attemptId", "role" },
            "recover_attempt" => new[] { "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "operationWaitBudgetMs", "guardianInstanceId", "guardianEpoch", "attemptId", "recoveryInstanceId", "privateFrame" },
            _ => null,
        };
        if (names is null || !ExactObject(value, names) || value.GetProperty("schema").GetString() != "gamebuddy-desktop-guardian-session/v1" || value.GetProperty("protocolVersion").GetInt32() != 1 ||
            value.GetProperty("bootstrapId").GetString() != bootstrapId || value.GetProperty("generation").GetString() != generation || value.GetProperty("inventoryDigest").GetString() != inventoryDigest || value.GetProperty("runtimeAdmissionSha256").GetString() != runtimeAdmissionSha256 ||
            (!TryGetOperationTiming(value, operation!, out var deadline, out var operationWaitBudgetMs)) ||
            !ValidOpaque(value.GetProperty("guardianInstanceId")) || !value.GetProperty("guardianEpoch").TryGetInt32(out var epoch) || epoch < 1 || !ValidOpaque(value.GetProperty("attemptId")) ||
            (operation == "recover_attempt" && !ValidOpaque(value.GetProperty("recoveryInstanceId")))) return false;
        var role = names.Contains("role", StringComparer.Ordinal) ? value.GetProperty("role").GetString() : null;
        if (role is not null && role is not ("player_host" or "ai_client")) return false;
        byte[]? privateFrame = null;
        if (names.Contains("privateFrame", StringComparer.Ordinal) && (!TryDecodeFrame(value.GetProperty("privateFrame"), out privateFrame) || (operation == "arm_attempt" && !ValidTokenlessArmBody(privateFrame)) || (operation == "recover_attempt" && !ValidTokenlessRecoveryPreCasBody(privateFrame)))) return false;
        var recoveryInstanceId = operation == "recover_attempt" && ValidOpaque(value.GetProperty("recoveryInstanceId")) ? value.GetProperty("recoveryInstanceId").GetString() : null;
        if (operation == "recover_attempt" && recoveryInstanceId is null) return false;
        command = new BrokerCommand(operation!, value.GetProperty("guardianInstanceId").GetString()!, epoch, value.GetProperty("attemptId").GetString()!, recoveryInstanceId, role, privateFrame, deadline, operationWaitBudgetMs);
        return true;
    }

    private void ValidateTransition(BrokerCommand command)
    {
        var next = new GuardianCorrelation(command.GuardianInstanceId, command.GuardianEpoch, command.AttemptId);
        if (command.Operation == "arm_attempt")
        {
            if (armed) throw new GuardianLaunchUnavailableException();
            correlation = next;
            return;
        }
        if (!armed || correlation != next || (command.Operation == "launch_role" && (command.Role is null || launchedRoles.Contains(command.Role))) ||
            (command.Operation == "contain_role" && (command.Role is null || !launchedRoles.Contains(command.Role) || containedRoles.Contains(command.Role)))) throw new GuardianLaunchUnavailableException();
    }

    private void AdvanceTransition(BrokerCommand command)
    {
        if (command.Operation == "arm_attempt") armed = true;
        else if (command.Operation == "launch_role") launchedRoles.Add(command.Role!);
        else containedRoles.Add(command.Role!);
    }

    /// <summary>
    /// Relays the one unsolicited frame this session carries: a role the native
    /// Guardian reported ended on its own, with its native exit code.
    ///
    /// It is bound to this session's own correlation and generation like every
    /// acknowledgement, so the Host can only read an exit that belongs to the
    /// attempt it is driving. A role cannot end before the attempt is armed, so an
    /// exit with no correlation is refused rather than sent unbound.
    /// </summary>
    private async Task WriteRoleExitAsync(GuardianRoleExit exit, CancellationToken cancellationToken)
    {
        var exact = correlation ?? throw new GuardianLaunchUnavailableException();
        await WriteAsync(new
        {
            schema = "gamebuddy-desktop-guardian-session/v1", protocolVersion = 1, operation = "role_exited", bootstrapId,
            generation, inventoryDigest, runtimeAdmissionSha256, guardianInstanceId = exact.InstanceId,
            guardianEpoch = exact.Epoch, attemptId = exact.AttemptId, role = exit.Role, exitCode = exit.ExitCode,
        }, cancellationToken).ConfigureAwait(false);
    }

    private async Task WriteAcknowledgementAsync(BrokerCommand command, string status, CancellationToken cancellationToken)
    {
        if (command.Operation == "recover_attempt")
            await WriteAsync(new { schema = "gamebuddy-desktop-guardian-session/v1", protocolVersion = 1, operation = command.Operation, status, bootstrapId, generation, inventoryDigest, runtimeAdmissionSha256, guardianInstanceId = command.GuardianInstanceId, guardianEpoch = command.GuardianEpoch, attemptId = command.AttemptId, recoveryInstanceId = command.RecoveryInstanceId }, cancellationToken).ConfigureAwait(false);
        else if (command.Role is null)
            await WriteAsync(new { schema = "gamebuddy-desktop-guardian-session/v1", protocolVersion = 1, operation = command.Operation, status, bootstrapId, generation, inventoryDigest, runtimeAdmissionSha256, guardianInstanceId = command.GuardianInstanceId, guardianEpoch = command.GuardianEpoch, attemptId = command.AttemptId }, cancellationToken).ConfigureAwait(false);
        else
            await WriteAsync(new { schema = "gamebuddy-desktop-guardian-session/v1", protocolVersion = 1, operation = command.Operation, status, bootstrapId, generation, inventoryDigest, runtimeAdmissionSha256, guardianInstanceId = command.GuardianInstanceId, guardianEpoch = command.GuardianEpoch, attemptId = command.AttemptId, role = command.Role }, cancellationToken).ConfigureAwait(false);
    }

    private bool TryParseRecoveryPostCas(JsonElement value, BrokerCommand command, out byte[] frame)
    {
        frame = Array.Empty<byte>();
        if (!ExactObject(value, "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "operationWaitBudgetMs", "guardianInstanceId", "guardianEpoch", "attemptId", "recoveryInstanceId", "privateFrame") ||
            value.GetProperty("schema").GetString() != "gamebuddy-desktop-guardian-session/v1" || value.GetProperty("protocolVersion").GetInt32() != 1 || value.GetProperty("operation").GetString() != "recovery_post_cas" ||
            !MatchesRecoveryCorrelation(value, command) || !value.GetProperty("operationWaitBudgetMs").TryGetInt64(out var operationWaitBudgetMs) || operationWaitBudgetMs != command.OperationWaitBudgetMs || !TryDecodeFrame(value.GetProperty("privateFrame"), out frame)) return false;
        return true;
    }

    private bool TryParseRecoveryCommand(JsonElement value, BrokerCommand command, out byte[] frame)
    {
        frame = Array.Empty<byte>();
        if (!ExactObject(value, "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "operationWaitBudgetMs", "guardianInstanceId", "guardianEpoch", "attemptId", "recoveryInstanceId") ||
            value.GetProperty("schema").GetString() != "gamebuddy-desktop-guardian-session/v1" || value.GetProperty("protocolVersion").GetInt32() != 1 || value.GetProperty("operation").GetString() != "recover_attempt" ||
            !MatchesRecoveryCorrelation(value, command) || !value.GetProperty("operationWaitBudgetMs").TryGetInt64(out var operationWaitBudgetMs) || operationWaitBudgetMs != command.OperationWaitBudgetMs) return false;
        frame = Encoding.UTF8.GetBytes($"{{\"schemaVersion\":1,\"operation\":\"recover_attempt\",\"guardianInstanceId\":\"{command.GuardianInstanceId}\",\"guardianEpoch\":{command.GuardianEpoch},\"attemptId\":\"{command.AttemptId}\",\"recoveryInstanceId\":\"{command.RecoveryInstanceId}\"}}\n");
        return true;
    }

    private bool TryParseRecoveryCasAcknowledgement(JsonElement value, BrokerCommand command, string role) =>
        ExactObject(value, "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "operationWaitBudgetMs", "guardianInstanceId", "guardianEpoch", "attemptId", "recoveryInstanceId", "role") &&
        value.GetProperty("schema").GetString() == "gamebuddy-desktop-guardian-session/v1" && value.GetProperty("protocolVersion").GetInt32() == 1 && value.GetProperty("operation").GetString() == "recovery_role_cas_ack" &&
        value.GetProperty("role").GetString() == role && value.GetProperty("operationWaitBudgetMs").TryGetInt64(out var operationWaitBudgetMs) && operationWaitBudgetMs == command.OperationWaitBudgetMs && MatchesRecoveryCorrelation(value, command);

    private bool TryParseRecoveryFinalizeAcknowledgement(JsonElement value, BrokerCommand command) =>
        ExactObject(value, "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "operationWaitBudgetMs", "guardianInstanceId", "guardianEpoch", "attemptId", "recoveryInstanceId") &&
        value.GetProperty("schema").GetString() == "gamebuddy-desktop-guardian-session/v1" && value.GetProperty("protocolVersion").GetInt32() == 1 && value.GetProperty("operation").GetString() == "recovery_finalize_ack" &&
        value.GetProperty("operationWaitBudgetMs").TryGetInt64(out var operationWaitBudgetMs) && operationWaitBudgetMs == command.OperationWaitBudgetMs && MatchesRecoveryCorrelation(value, command);

    private bool MatchesRecoveryCorrelation(JsonElement value, BrokerCommand command) =>
        value.GetProperty("bootstrapId").GetString() == bootstrapId && value.GetProperty("generation").GetString() == generation && value.GetProperty("inventoryDigest").GetString() == inventoryDigest && value.GetProperty("runtimeAdmissionSha256").GetString() == runtimeAdmissionSha256 &&
        value.GetProperty("guardianInstanceId").GetString() == command.GuardianInstanceId && value.GetProperty("guardianEpoch").TryGetInt32(out var epoch) && epoch == command.GuardianEpoch && value.GetProperty("attemptId").GetString() == command.AttemptId && value.GetProperty("recoveryInstanceId").GetString() == command.RecoveryInstanceId;

    private async Task<byte?> WatchForHostPipeReadAsync(CancellationToken cancellationToken)
    {
        var byteRead = new byte[1];
        return await server.ReadAsync(byteRead, cancellationToken).ConfigureAwait(false) == 1 ? byteRead[0] : null;
    }

    private async Task<JsonElement> ReadFrameAsync(CancellationToken cancellationToken, byte? firstByte = null)
    {
        using var bytes = new MemoryStream();
        var one = new byte[1];
        if (firstByte is { } initial)
        {
            if (initial is (byte)'\r' or 0 or (byte)'\n') throw new GuardianLaunchUnavailableException();
            bytes.WriteByte(initial);
        }
        while (bytes.Length < MaxWireBytes)
        {
            if (await server.ReadAsync(one, cancellationToken).ConfigureAwait(false) != 1) throw new EndOfStreamException();
            if (one[0] is (byte)'\r' or 0) throw new GuardianLaunchUnavailableException();
            if (one[0] == (byte)'\n')
            {
                if (bytes.Length == 0) throw new GuardianLaunchUnavailableException();
                using var document = JsonDocument.Parse(bytes.ToArray());
                return document.RootElement.Clone();
            }
            bytes.WriteByte(one[0]);
        }
        throw new GuardianLaunchUnavailableException();
    }

    private async Task WriteAsync(object value, CancellationToken cancellationToken)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value) + "\n");
        if (bytes.Length > MaxWireBytes) throw new GuardianLaunchUnavailableException();
        await hostWriteGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await server.WriteAsync(bytes, cancellationToken).ConfigureAwait(false);
            await server.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        finally { hostWriteGate.Release(); }
    }

    private static void VerifySameCurrentUserSid(WindowsNative.SafeProcessHandle child)
    {
        if (!WindowsNative.OpenProcessToken(WindowsNative.GetCurrentProcess(), WindowsNative.TokenQuery, out var currentToken))
            WindowsNative.ThrowLastError("host_runtime_unavailable");
        using (currentToken)
        {
            if (!WindowsNative.OpenProcessToken(child, WindowsNative.TokenQuery, out var childToken))
                WindowsNative.ThrowLastError("host_runtime_unavailable");
            using (childToken)
            {
                var currentSid = IntPtr.Zero;
                var childSid = IntPtr.Zero;
                try
                {
                    currentSid = ReadTokenSid(currentToken);
                    childSid = ReadTokenSid(childToken);
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

    private static IntPtr ReadTokenSid(Microsoft.Win32.SafeHandles.SafeAccessTokenHandle token)
    {
        _ = WindowsNative.GetTokenInformation(token, WindowsNative.TokenUser, IntPtr.Zero, 0, out var size);
        if (size == 0) WindowsNative.ThrowLastError("host_runtime_unavailable");
        var data = Marshal.AllocHGlobal(checked((int)size));
        try
        {
            if (!WindowsNative.GetTokenInformation(token, WindowsNative.TokenUser, data, size, out var written) || written != size)
                WindowsNative.ThrowLastError("host_runtime_unavailable");
            var user = Marshal.PtrToStructure<WindowsNative.TokenUserInformation>(data);
            var length = user.User.Sid == IntPtr.Zero ? 0 : WindowsNative.GetLengthSid(user.User.Sid);
            if (length == 0) WindowsNative.ThrowLastError("host_runtime_unavailable");
            var copy = Marshal.AllocHGlobal(checked((int)length));
            var bytes = new byte[checked((int)length)];
            Marshal.Copy(user.User.Sid, bytes, 0, bytes.Length);
            Marshal.Copy(bytes, 0, copy, bytes.Length);
            return copy;
        }
        finally { Marshal.FreeHGlobal(data); }
    }

    private void EnsureLayoutBinding()
    {
        if (string.IsNullOrWhiteSpace(layout.ProgramRoot) || string.IsNullOrWhiteSpace(layout.DataRoot) ||
            string.IsNullOrWhiteSpace(layout.OperationalRoot) || string.IsNullOrWhiteSpace(layout.PresentationRoot))
            throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
    }

    /// <summary>
    /// Ends this brokered session under the quit's one budget.
    ///
    /// The Host-facing pipe goes FIRST. Closing it is the controller EOF the child's own exit
    /// reclamation waits for, so a child that is reclaiming must never be waiting behind this
    /// launcher's own containment. Disposing the server end closes the one instance the child is
    /// connected to; the child observes the loss on its own session and leaves by itself.
    /// </summary>
    internal async Task CloseAsync(ShutdownBudget budget, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(budget);
        if (closed) return;
        closed = true;
        sessionClosing?.Cancel();
        server.Dispose();
        try
        {
            // Only then does the launcher give up the guardian it relays to. The native guardian exits
            // on the control EOF this closes, which is how the roles it created are contained on this
            // side even when the child never got to ask for it.
            //
            // This is the wait that draws on the quit's one budget: the guardian may need its
            // containment ceiling and may never spend more than the quit has left, so what it costs
            // is inside both the number the player waits and the number the record carries.
            if (guardian is not null)
            {
                // The settlement below re-reads the same number: what is left of the quit after this
                // wait is spent, so the attempt's own settlement can no longer wait past the quit.
                guardian.BindContainmentCeiling(budget.Take(GuardianSupervisorLease.ContainmentCeilingMs));
                try
                {
                    await guardian.CloseControlAndWaitForExitAsync(budget.Take(GuardianSupervisorLease.ContainmentCeilingMs), cancellationToken).ConfigureAwait(false);
                }
                catch (GuardianLaunchUnavailableException)
                {
                    // A guardian that outlived what the budget had left is what the settlement below
                    // kills; the quit has already spent its declared number and adds no second one.
                }
            }
            // Then the attempt itself, through the same settlement every other attempt end uses:
            // control EOF, a bounded wait, the kill as the watchdog over it, and the record that
            // follows that answer.
            await SettleAttemptAsync().ConfigureAwait(false);
        }
        catch
        {
            // Teardown must never mask the original failure with a close error;
            // the settlement's own kill already went as far as it could.
        }
    }

    public async ValueTask DisposeAsync() => await CloseAsync(new ShutdownBudget(GuardianSupervisorLease.ContainmentCeilingMs), CancellationToken.None).ConfigureAwait(false);

    private static bool ExactObject(JsonElement value, params string[] expected) => value.ValueKind == JsonValueKind.Object && value.EnumerateObject().Select(property => property.Name).SequenceEqual(expected, StringComparer.Ordinal);
    private static bool IsHex(string value) => value.Length == 64 && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static bool ValidOpaque(JsonElement value) => value.ValueKind == JsonValueKind.String && Guid.TryParseExact(value.GetString(), "D", out _);
    private static bool IsPositiveSafeInteger(long value) => value is > 0 and <= 9_007_199_254_740_991;
    private static bool TryDecodeFrame(JsonElement value, out byte[] frame)
    {
        frame = Array.Empty<byte>();
        if (value.ValueKind != JsonValueKind.String || value.GetString() is not { } encoded || encoded.Length == 0 || encoded.Length > 87_382 || encoded.Contains('=') || !encoded.All(character => char.IsLetterOrDigit(character) || character is '-' or '_')) return false;
        try { frame = Convert.FromBase64String(encoded.Replace('-', '+').Replace('_', '/') + new string('=', (4 - encoded.Length % 4) % 4)); }
        catch (FormatException) { return false; }
        return frame.Length is > 0 and <= 65_536 && !frame.Contains((byte)'\n') && !frame.Contains((byte)'\r') && !frame.Contains((byte)0);
    }
    private static bool ValidTokenlessArmBody(byte[] frame) => frame.Length > 2 && frame[0] == (byte)'{' && frame[^1] == (byte)'}' && !Encoding.UTF8.GetString(frame).Contains("\"token\"", StringComparison.Ordinal);
    private static bool ValidTokenlessRecoveryPreCasBody(byte[] frame)
    {
        try
        {
            using var document = JsonDocument.Parse(frame);
            return ExactObject(document.RootElement, "guardianInstanceId", "guardianEpoch", "attemptId", "bindingRevision", "leaseName");
        }
        catch (JsonException) { return false; }
    }

    private static CancellationTokenSource BindCommandDeadline(BrokerCommand command, CancellationToken cancellationToken)
    {
        command.ThrowIfExpired(cancellationToken);
        var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (command.Operation == "launch_role")
            deadline.CancelAfter(TimeSpan.FromMilliseconds(command.DeadlineUnixMs - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
        else
            deadline.CancelAfter(TimeSpan.FromMilliseconds(command.OperationWaitBudgetMs));
        return deadline;
    }

    private static bool TryGetOperationTiming(JsonElement value, string operation, out long deadline, out long operationWaitBudgetMs)
    {
        deadline = 0;
        operationWaitBudgetMs = 0;
        if (operation == "launch_role")
            return value.GetProperty("deadlineUnixMs").TryGetInt64(out deadline) && IsPositiveSafeInteger(deadline) && deadline > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() && deadline <= DateTimeOffset.UtcNow.Add(MaximumDeadline).ToUnixTimeMilliseconds();
        return value.GetProperty("operationWaitBudgetMs").TryGetInt64(out operationWaitBudgetMs) && IsPositiveSafeInteger(operationWaitBudgetMs) && operationWaitBudgetMs <= (long)MaximumDeadline.TotalMilliseconds;
    }

    internal sealed class GuardianRecoverySessionState
    {
        private readonly GuardianCorrelation correlation;
        private readonly string recoveryInstanceId;
        private int phase;
        internal GuardianRecoverySessionState(string guardianInstanceId, int guardianEpoch, string attemptId, string? recoveryInstanceId)
        {
            if (recoveryInstanceId is null) throw new GuardianLaunchUnavailableException();
            correlation = new GuardianCorrelation(guardianInstanceId, guardianEpoch, attemptId);
            this.recoveryInstanceId = recoveryInstanceId;
        }
        internal void GateAcquired() => RequirePhase(0, 1);
        internal void PostCasBound() => RequirePhase(1, 2);
        internal void RecoverAuthorized() => RequirePhase(2, 3);
        internal void RoleContained(string role)
        {
            if (role == "playerHost") RequirePhase(3, 4);
            else if (role == "aiClient") RequirePhase(4, 5);
            else throw new GuardianLaunchUnavailableException();
        }
        internal void FinalizeAcknowledged() => RequirePhase(5, 6);
        internal void ReleaseRequested() => RequirePhase(6, 7);
        internal void TerminalVerified() => RequirePhase(7, 8);
        internal bool Matches(string guardianInstanceId, int guardianEpoch, string attemptId, string candidateRecoveryInstanceId) =>
            correlation == new GuardianCorrelation(guardianInstanceId, guardianEpoch, attemptId) && recoveryInstanceId == candidateRecoveryInstanceId;
        private void RequirePhase(int expected, int next)
        {
            if (phase != expected) throw new GuardianLaunchUnavailableException();
            phase = next;
        }
    }

    private sealed record BrokerCommand(string Operation, string GuardianInstanceId, int GuardianEpoch, string AttemptId, string? RecoveryInstanceId, string? Role, byte[]? PrivateFrame, long DeadlineUnixMs, long OperationWaitBudgetMs)
    {
        internal void ThrowIfExpired(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (Operation == "launch_role" && DeadlineUnixMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) throw new OperationCanceledException(cancellationToken);
        }
    }

    private readonly record struct GuardianCorrelation(string InstanceId, int Epoch, string AttemptId);
}
