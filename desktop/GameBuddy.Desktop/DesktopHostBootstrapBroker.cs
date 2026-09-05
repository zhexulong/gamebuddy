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
    private readonly NamedPipeServerStream server;
    private readonly Func<CancellationToken, Task<GuardianRecoverySupervisorLease>>? startRecovery;
    private GuardianSupervisorLease? guardian;
    private bool accepted;
    private bool closed;
    private bool armed;
    private readonly HashSet<string> launchedRoles = new(StringComparer.Ordinal);
    private readonly HashSet<string> containedRoles = new(StringComparer.Ordinal);
    private GuardianCorrelation? correlation;
    private Task? commandLoop;

    private DesktopHostBootstrapBroker(string bootstrapId, InstalledGenerationSelection selection, Func<CancellationToken, Task<GuardianRecoverySupervisorLease>>? startRecovery)
    {
        this.bootstrapId = bootstrapId;
        this.startRecovery = startRecovery;
        generation = selection.Generation;
        inventoryDigest = selection.InventoryDigest;
        runtimeAdmissionSha256 = selection.RuntimeAdmissionSha256;
        server = new NamedPipeServerStream($"GameBuddy.HostGuardian.{bootstrapId}", PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | PipeOptions.FirstPipeInstance,
            MaxWireBytes, MaxWireBytes);
    }

    internal static DesktopHostBootstrapBroker Create(string bootstrapId, InstalledGenerationSelection selection, Func<CancellationToken, Task<GuardianRecoverySupervisorLease>>? startRecovery = null)
    {
        if (!IsHex(bootstrapId)) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        return new DesktopHostBootstrapBroker(bootstrapId, selection, startRecovery);
    }

    internal async Task AuthenticateHostAsync(WindowsNative.SafeProcessHandle child, CancellationToken cancellationToken)
    {
        await server.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
        if (!WindowsNative.GetNamedPipeClientProcessId(server.SafePipeHandle, out var clientPid) || clientPid != WindowsNative.GetProcessId(child) ||
            !WindowsNative.ProcessIdToSessionId(clientPid, out var clientSession) || !WindowsNative.ProcessIdToSessionId(WindowsNative.GetCurrentProcessId(), out var currentSession) || clientSession != currentSession)
            throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        VerifySameCurrentUserSid(clientPid);
        var hello = await ReadFrameAsync(cancellationToken).ConfigureAwait(false);
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

    internal Task AttachResidentGuardianAsync(GuardianSupervisorLease lease, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!accepted || closed || guardian is not null) throw new GuardianLaunchUnavailableException();
        guardian = lease;
        commandLoop = Task.Run(() => ServeCommandsAsync(cancellationToken), CancellationToken.None);
        return Task.CompletedTask;
    }

    private async Task ServeCommandsAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (!closed)
            {
                var command = await ReadFrameAsync(cancellationToken).ConfigureAwait(false);
                if (!TryParseCommand(command, out var parsed)) throw new GuardianLaunchUnavailableException();
                using var deadline = BindCommandDeadline(parsed, cancellationToken);
                var commandCancellation = deadline.Token;
                if (parsed.Operation == "recover_attempt")
                {
                    await RelayRecoveryAsync(parsed, commandCancellation).ConfigureAwait(false);
                    continue;
                }
                ValidateTransition(parsed);
                var native = new GuardianRelayCommand(parsed.Operation, parsed.GuardianInstanceId, parsed.GuardianEpoch, parsed.AttemptId, parsed.Role, parsed.PrivateFrame, parsed.DeadlineUnixMs);
                var result = await guardian!.RelayResidentAsync(native, commandCancellation).ConfigureAwait(false);
                parsed.ThrowIfExpired(commandCancellation);
                AdvanceTransition(parsed);
                parsed.ThrowIfExpired(commandCancellation);
                await WriteAcknowledgementAsync(parsed, result.Status, commandCancellation).ConfigureAwait(false);
            }
        }
        catch
        {
            await CloseAsync(CancellationToken.None).ConfigureAwait(false);
        }
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
        if (!ExactObject(release, "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "deadlineUnixMs", "guardianInstanceId", "guardianEpoch", "attemptId", "recoveryInstanceId") ||
            release.GetProperty("schema").GetString() != "gamebuddy-desktop-guardian-session/v1" || release.GetProperty("protocolVersion").GetInt32() != 1 || release.GetProperty("operation").GetString() != "release" ||
            !release.GetProperty("deadlineUnixMs").TryGetInt64(out var releaseDeadline) || releaseDeadline != command.DeadlineUnixMs || !MatchesRecoveryCorrelation(release, command)) throw new GuardianLaunchUnavailableException();
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
            "arm_attempt" => new[] { "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "deadlineUnixMs", "guardianInstanceId", "guardianEpoch", "attemptId", "privateFrame" },
            "launch_role" => new[] { "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "deadlineUnixMs", "guardianInstanceId", "guardianEpoch", "attemptId", "role", "privateFrame" },
            "contain_role" => new[] { "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "deadlineUnixMs", "guardianInstanceId", "guardianEpoch", "attemptId", "role" },
            "recover_attempt" => new[] { "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "deadlineUnixMs", "guardianInstanceId", "guardianEpoch", "attemptId", "recoveryInstanceId", "privateFrame" },
            _ => null,
        };
        if (names is null || !ExactObject(value, names) || value.GetProperty("schema").GetString() != "gamebuddy-desktop-guardian-session/v1" || value.GetProperty("protocolVersion").GetInt32() != 1 ||
            value.GetProperty("bootstrapId").GetString() != bootstrapId || value.GetProperty("generation").GetString() != generation || value.GetProperty("inventoryDigest").GetString() != inventoryDigest || value.GetProperty("runtimeAdmissionSha256").GetString() != runtimeAdmissionSha256 ||
            !value.GetProperty("deadlineUnixMs").TryGetInt64(out var deadline) || deadline <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() || deadline > DateTimeOffset.UtcNow.Add(MaximumDeadline).ToUnixTimeMilliseconds() ||
            !ValidOpaque(value.GetProperty("guardianInstanceId")) || !value.GetProperty("guardianEpoch").TryGetInt32(out var epoch) || epoch < 1 || !ValidOpaque(value.GetProperty("attemptId")) ||
            (operation == "recover_attempt" && !ValidOpaque(value.GetProperty("recoveryInstanceId")))) return false;
        var role = names.Contains("role", StringComparer.Ordinal) ? value.GetProperty("role").GetString() : null;
        if (role is not null && role is not ("player_host" or "ai_client")) return false;
        byte[]? privateFrame = null;
        if (names.Contains("privateFrame", StringComparer.Ordinal) && (!TryDecodeFrame(value.GetProperty("privateFrame"), out privateFrame) || (operation == "arm_attempt" && !ValidTokenlessArmBody(privateFrame)) || (operation == "recover_attempt" && !ValidTokenlessRecoveryPreCasBody(privateFrame)))) return false;
        var recoveryInstanceId = operation == "recover_attempt" && ValidOpaque(value.GetProperty("recoveryInstanceId")) ? value.GetProperty("recoveryInstanceId").GetString() : null;
        if (operation == "recover_attempt" && recoveryInstanceId is null) return false;
        command = new BrokerCommand(operation!, value.GetProperty("guardianInstanceId").GetString()!, epoch, value.GetProperty("attemptId").GetString()!, recoveryInstanceId, role, privateFrame, deadline);
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
        if (!ExactObject(value, "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "deadlineUnixMs", "guardianInstanceId", "guardianEpoch", "attemptId", "recoveryInstanceId", "privateFrame") ||
            value.GetProperty("schema").GetString() != "gamebuddy-desktop-guardian-session/v1" || value.GetProperty("protocolVersion").GetInt32() != 1 || value.GetProperty("operation").GetString() != "recovery_post_cas" ||
            !MatchesRecoveryCorrelation(value, command) || !value.GetProperty("deadlineUnixMs").TryGetInt64(out var deadline) || deadline != command.DeadlineUnixMs || !TryDecodeFrame(value.GetProperty("privateFrame"), out frame)) return false;
        return true;
    }

    private bool TryParseRecoveryCommand(JsonElement value, BrokerCommand command, out byte[] frame)
    {
        frame = Array.Empty<byte>();
        if (!ExactObject(value, "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "deadlineUnixMs", "guardianInstanceId", "guardianEpoch", "attemptId", "recoveryInstanceId") ||
            value.GetProperty("schema").GetString() != "gamebuddy-desktop-guardian-session/v1" || value.GetProperty("protocolVersion").GetInt32() != 1 || value.GetProperty("operation").GetString() != "recover_attempt" ||
            !MatchesRecoveryCorrelation(value, command) || !value.GetProperty("deadlineUnixMs").TryGetInt64(out var deadline) || deadline != command.DeadlineUnixMs) return false;
        frame = Encoding.UTF8.GetBytes($"{{\"schemaVersion\":1,\"operation\":\"recover_attempt\",\"guardianInstanceId\":\"{command.GuardianInstanceId}\",\"guardianEpoch\":{command.GuardianEpoch},\"attemptId\":\"{command.AttemptId}\",\"recoveryInstanceId\":\"{command.RecoveryInstanceId}\"}}\n");
        return true;
    }

    private bool TryParseRecoveryCasAcknowledgement(JsonElement value, BrokerCommand command, string role) =>
        ExactObject(value, "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "deadlineUnixMs", "guardianInstanceId", "guardianEpoch", "attemptId", "recoveryInstanceId", "role") &&
        value.GetProperty("schema").GetString() == "gamebuddy-desktop-guardian-session/v1" && value.GetProperty("protocolVersion").GetInt32() == 1 && value.GetProperty("operation").GetString() == "recovery_role_cas_ack" &&
        value.GetProperty("role").GetString() == role && value.GetProperty("deadlineUnixMs").TryGetInt64(out var deadline) && deadline == command.DeadlineUnixMs && MatchesRecoveryCorrelation(value, command);

    private bool TryParseRecoveryFinalizeAcknowledgement(JsonElement value, BrokerCommand command) =>
        ExactObject(value, "schema", "protocolVersion", "operation", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "deadlineUnixMs", "guardianInstanceId", "guardianEpoch", "attemptId", "recoveryInstanceId") &&
        value.GetProperty("schema").GetString() == "gamebuddy-desktop-guardian-session/v1" && value.GetProperty("protocolVersion").GetInt32() == 1 && value.GetProperty("operation").GetString() == "recovery_finalize_ack" &&
        value.GetProperty("deadlineUnixMs").TryGetInt64(out var deadline) && deadline == command.DeadlineUnixMs && MatchesRecoveryCorrelation(value, command);

    private bool MatchesRecoveryCorrelation(JsonElement value, BrokerCommand command) =>
        value.GetProperty("bootstrapId").GetString() == bootstrapId && value.GetProperty("generation").GetString() == generation && value.GetProperty("inventoryDigest").GetString() == inventoryDigest && value.GetProperty("runtimeAdmissionSha256").GetString() == runtimeAdmissionSha256 &&
        value.GetProperty("guardianInstanceId").GetString() == command.GuardianInstanceId && value.GetProperty("guardianEpoch").TryGetInt32(out var epoch) && epoch == command.GuardianEpoch && value.GetProperty("attemptId").GetString() == command.AttemptId && value.GetProperty("recoveryInstanceId").GetString() == command.RecoveryInstanceId;

    private async Task<JsonElement> ReadFrameAsync(CancellationToken cancellationToken)
    {
        using var bytes = new MemoryStream();
        var one = new byte[1];
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
        await server.WriteAsync(bytes, cancellationToken).ConfigureAwait(false);
        await server.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    private static void VerifySameCurrentUserSid(uint clientPid)
    {
        if (!WindowsNative.OpenProcess(WindowsNative.ProcessQueryLimitedInformation, false, clientPid, out var client)) throw new GuardianLaunchUnavailableException();
        using (client)
        {
            if (!WindowsNative.OpenProcessToken(WindowsNative.GetCurrentProcess(), WindowsNative.TokenQuery, out var currentToken) || !WindowsNative.OpenProcessToken(client, WindowsNative.TokenQuery, out var clientToken)) throw new GuardianLaunchUnavailableException();
            using (currentToken)
            using (clientToken)
            {
                var currentSid = ReadTokenSid(currentToken);
                var childSid = ReadTokenSid(clientToken);
                try { if (!WindowsNative.EqualSid(currentSid, childSid)) throw new GuardianLaunchUnavailableException(); }
                finally { Marshal.FreeHGlobal(currentSid); Marshal.FreeHGlobal(childSid); }
            }
        }
    }

    private static IntPtr ReadTokenSid(Microsoft.Win32.SafeHandles.SafeAccessTokenHandle token)
    {
        _ = WindowsNative.GetTokenInformation(token, WindowsNative.TokenUser, IntPtr.Zero, 0, out var size);
        if (size == 0) throw new GuardianLaunchUnavailableException();
        var data = Marshal.AllocHGlobal(checked((int)size));
        try
        {
            if (!WindowsNative.GetTokenInformation(token, WindowsNative.TokenUser, data, size, out var written) || written != size) throw new GuardianLaunchUnavailableException();
            var user = Marshal.PtrToStructure<WindowsNative.TokenUserInformation>(data);
            var length = user.User.Sid == IntPtr.Zero ? 0 : WindowsNative.GetLengthSid(user.User.Sid);
            if (length == 0) throw new GuardianLaunchUnavailableException();
            var copy = Marshal.AllocHGlobal(checked((int)length));
            var bytes = new byte[checked((int)length)];
            Marshal.Copy(user.User.Sid, bytes, 0, bytes.Length); Marshal.Copy(bytes, 0, copy, bytes.Length);
            return copy;
        }
        finally { Marshal.FreeHGlobal(data); }
    }

    internal async Task CloseAsync(CancellationToken cancellationToken)
    {
        if (closed) return;
        closed = true;
        try { if (guardian is not null) await guardian.CloseControlAsync(cancellationToken).ConfigureAwait(false); } catch { }
        server.Dispose();
    }

    public async ValueTask DisposeAsync() => await CloseAsync(CancellationToken.None).ConfigureAwait(false);

    private static bool ExactObject(JsonElement value, params string[] expected) => value.ValueKind == JsonValueKind.Object && value.EnumerateObject().Select(property => property.Name).SequenceEqual(expected, StringComparer.Ordinal);
    private static bool IsHex(string value) => value.Length == 64 && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static bool ValidOpaque(JsonElement value) => value.ValueKind == JsonValueKind.String && Guid.TryParseExact(value.GetString(), "D", out _);
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
        var remaining = TimeSpan.FromMilliseconds(command.DeadlineUnixMs - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        if (remaining <= TimeSpan.Zero)
        {
            deadline.Dispose();
            throw new OperationCanceledException(cancellationToken);
        }
        deadline.CancelAfter(remaining);
        return deadline;
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

    private sealed record BrokerCommand(string Operation, string GuardianInstanceId, int GuardianEpoch, string AttemptId, string? RecoveryInstanceId, string? Role, byte[]? PrivateFrame, long DeadlineUnixMs)
    {
        internal void ThrowIfExpired(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (DeadlineUnixMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) throw new OperationCanceledException(cancellationToken);
        }
    }

    private readonly record struct GuardianCorrelation(string InstanceId, int Epoch, string AttemptId);
}
