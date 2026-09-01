using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace GameBuddy.WindowsStardewBootstrapGuardian;

internal static class Program
{
    private const int MaxInputBytes = 64 * 1024;
    private const int MaxGuardianEpoch = int.MaxValue;

    public static int Main() => MainAsync().GetAwaiter().GetResult();

    private static async Task<int> MainAsync()
    {
        var mode = Environment.GetEnvironmentVariable("GAMEBUDDY_GUARDIAN_MODE");
        var pipe = Environment.GetEnvironmentVariable("GAMEBUDDY_GUARDIAN_CONTROL_PIPE");
        var token = Environment.GetEnvironmentVariable("GAMEBUDDY_GUARDIAN_CONTROL_TOKEN");
        if ((mode is not ("resident" or "recovery")) || string.IsNullOrWhiteSpace(pipe) || string.IsNullOrWhiteSpace(token)) return Fail();
        return mode == "recovery"
            ? await RunRecoveryAsync(pipe, token).ConfigureAwait(false)
            : await RunResidentAsync(pipe, token).ConfigureAwait(false);
    }

    private static async Task<int> RunResidentAsync(string pipe, string token)
    {
        WindowsJobOwner? playerJob = null;
        WindowsJobOwner? aiJob = null;
        GuardianPrivateLaunchIngress? ingress = null;
        GuardianLease? lease = null;
        WindowsRoleLauncher.LaunchedRole? player = null;
        WindowsRoleLauncher.LaunchedRole? ai = null;
        try
        {
            WindowsJobOwner.ValidateAbi();
            WindowsRoleLauncher.ValidateAbi();
            GuardianPrivateLaunchIngress.ValidateAbi();
            using var input = Console.OpenStandardInput();
            using var output = Console.OpenStandardOutput();
            using var closing = new CancellationTokenSource();
            var stateGate = new ResidentGuardianStateGate();
            var publicFrames = Channel.CreateBounded<byte[]?>(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.Wait, SingleReader = true, SingleWriter = true });
            var publicReader = ReadPublicFramesAsync(input, publicFrames.Writer, closing, stateGate);
            var armed = false;
            GuardianPrivateLaunchIngress.ArmBinding? armBinding = null;
            GuardianProtocol.Correlation? activeCorrelation = null;
            var launchedRoles = new HashSet<GuardianProtocol.Role>();
            while (true)
            {
                var line = await publicFrames.Reader.ReadAsync().ConfigureAwait(false);
                if (line is null) { closing.Cancel(); break; }
                var command = ParsePublic(line);
                if (command.Operation == "arm_attempt")
                {
                    if (armed) return Fail();
                    ingress = new GuardianPrivateLaunchIngress(pipe, token, command.Correlation);
                    armBinding = await ingress.ReceiveArmAsync(closing.Token).ConfigureAwait(false);
                    if (armBinding is null) return Fail();
                    if (armBinding.LeaseName.Contains("/", StringComparison.Ordinal)) return Fail();
                    lease = GuardianLease.Create(armBinding.LeaseName);
                    playerJob = WindowsJobOwner.Create(armBinding.PlayerJobName);
                    try { aiJob = WindowsJobOwner.Create(armBinding.AiJobName); }
                    catch { playerJob.Dispose(); playerJob = null; throw; }
                    activeCorrelation = command.Correlation;
                    armed = true;
                    await WriteAsync(output, GuardianProtocol.Response("armed")).ConfigureAwait(false);
                    continue;
                }
                if (!armed || closing.IsCancellationRequested || ingress is null || playerJob is null || aiJob is null || command.Operation is not ("launch_role" or "contain_role") || command.Correlation != activeCorrelation!.Value) return Fail();
                if (command.Operation == "launch_role")
                {
                    var role = command.Role!.Value;
                    if (!launchedRoles.Add(role)) return Fail();
                    if (role == GuardianProtocol.Role.PlayerHost ? player is not null : ai is not null) return Fail();
                    var plan = await ingress.ReceiveLaunchPlanAsync(closing.Token).ConfigureAwait(false);
                    if (closing.IsCancellationRequested || stateGate.IsClosing() || plan is null || plan.Correlation != command.Correlation || plan.Role != role || plan.DeadlineUnixMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) return Fail();
                    var job = role == GuardianProtocol.Role.PlayerHost ? playerJob : aiJob;
#if GUARDIAN_TEST_HOOKS
                    ResidentGuardianTestHooks.Wait("before-create");
#endif
                    WindowsRoleLauncher.LaunchedRole? launched = null;
                    if (!stateGate.TryRunOpen(() => launched = WindowsRoleLauncher.CreateSuspendedRole(job, plan.Executable, plan.Arguments, plan.WorkingDirectory, plan.Environment))) return Fail();
                    try
                    {
#if GUARDIAN_TEST_HOOKS
                        ResidentGuardianTestHooks.Wait("after-create");
#endif
                        if (!stateGate.TryRunOpen(() => WindowsRoleLauncher.VerifyMembership(launched!, job))) throw new OperationCanceledException();
#if GUARDIAN_TEST_HOOKS
                        ResidentGuardianTestHooks.Wait("after-membership");
#endif
                        if (!stateGate.TryRunOpen(() => { })) throw new OperationCanceledException();
#if GUARDIAN_TEST_HOOKS
                        ResidentGuardianTestHooks.Wait("before-resume");
#endif
                        if (!stateGate.TryRunOpen(() =>
                        {
                            if (plan.DeadlineUnixMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) throw new TimeoutException();
                            WindowsRoleLauncher.Resume(launched!);
                        })) throw new OperationCanceledException();
                        if (role == GuardianProtocol.Role.PlayerHost) player = launched; else ai = launched;
                        await WriteAsync(output, GuardianProtocol.Response("role_active")).ConfigureAwait(false);
                    }
                    catch { launched?.Abort(); throw; }
                }
                else
                {
                    var role = command.Role!.Value;
                    if (role == GuardianProtocol.Role.PlayerHost ? player is null : ai is null) return Fail();
                    var job = role == GuardianProtocol.Role.PlayerHost ? playerJob : aiJob;
                    job.TerminateAndDrain();
                    if (role == GuardianProtocol.Role.PlayerHost) { player?.Dispose(); player = null; } else { ai?.Dispose(); ai = null; }
                    await WriteAsync(output, GuardianProtocol.Response("role_contained")).ConfigureAwait(false);
                }
            }
            if (armed) { playerJob?.TerminateAndDrain(); aiJob?.TerminateAndDrain(); }
            await publicReader.ConfigureAwait(false);
            return 0;
        }
        catch { return Fail(); }
        finally
        {
            ingress?.Dispose();
            try { playerJob?.TerminateAndDrain(); } catch { }
            try { aiJob?.TerminateAndDrain(); } catch { }
            player?.Dispose(); ai?.Dispose();
            playerJob?.Dispose(); aiJob?.Dispose();
            // The exact lease is always the last native ownership handle released.
            lease?.Dispose();
        }
    }

    /** C2 recovery is a separate private session; it opens only post-CAS exact named Jobs. */
    private static async Task<int> RunRecoveryAsync(string pipe, string token)
    {
        GuardianRecoveryIngress? ingress = null;
        GuardianLease? gate = null;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        try
        {
            WindowsJobRecoveryClassifier.ValidateAbi();
            ingress = new GuardianRecoveryIngress(pipe, token);
            var pre = await ingress.ReceivePreCasAsync(timeout.Token).ConfigureAwait(false);
            if (pre is null) return Fail();
            try { gate = GuardianLease.CreateRecoveryGate(pre.LeaseName); }
            catch (InvalidOperationException) { await ingress.ReplyAsync("held").ConfigureAwait(false); return 0; }
            await ingress.ReplyAsync("acquired").ConfigureAwait(false);
            var post = await ingress.ReceivePostCasAsync(pre, timeout.Token).ConfigureAwait(false);
            if (post is null) return Fail();
            using var input = Console.OpenStandardInput();
            var line = await ReadLineBoundedAsync(input).WaitAsync(timeout.Token).ConfigureAwait(false);
            if (line is null) return Fail();
            var command = GuardianProtocol.Parse(line);
            if (command.Operation != "recover_attempt" || command.Correlation != post.Correlation || command.RecoveryInstanceId != post.RecoveryInstanceId) return Fail();
            var expectedRoles = new HashSet<GuardianProtocol.Role> { GuardianProtocol.Role.PlayerHost, GuardianProtocol.Role.AiClient };
            while (expectedRoles.Count != 0)
            {
                var classification = await ingress.ReceiveClassificationAsync(post, timeout.Token).ConfigureAwait(false);
                if (classification is null || !expectedRoles.Remove(classification.Role)) return Fail();
                var jobName = classification.Role == GuardianProtocol.Role.PlayerHost ? post.PlayerJobName : post.AiJobName;
                var result = WindowsJobRecoveryClassifier.Classify(jobName, classification.State);
                await ingress.ReplyAsync(result).ConfigureAwait(false);
            }
            // Explicit authenticated private release is strictly last.
            if (!await ingress.ReceiveReleaseAsync(timeout.Token).ConfigureAwait(false)) return Fail();
            gate.Dispose(); gate = null;
            return 0;
        }
        catch { return Fail(); }
        finally { gate?.Dispose(); ingress?.Dispose(); }
    }

    private static async Task ReadPublicFramesAsync(Stream stream, ChannelWriter<byte[]?> frames, CancellationTokenSource closing, ResidentGuardianStateGate stateGate)
    {
        try
        {
            while (true)
            {
                var line = await ReadLineBoundedAsync(stream).ConfigureAwait(false);
                if (line is null) { stateGate.Close(); closing.Cancel(); break; }
                if (stateGate.IsClosing() || !frames.TryWrite(line)) { stateGate.Close(); closing.Cancel(); break; }
            }
        }
        catch (Exception error) { stateGate.Close(); frames.TryComplete(error); closing.Cancel(); return; }
        finally { frames.TryComplete(); }
    }

    private static async Task<byte[]?> ReadLineBoundedAsync(Stream stream)
    {
        using var data = new MemoryStream(); var one = new byte[1];
        while (data.Length < MaxInputBytes)
        {
            var read = await stream.ReadAsync(one).ConfigureAwait(false);
            if (read == 0) return data.Length == 0 ? null : throw GuardianProtocol.Invalid();
            if (one[0] == (byte)'\n') return data.ToArray();
            if (one[0] == (byte)'\r') throw GuardianProtocol.Invalid();
            data.WriteByte(one[0]);
        }
        throw GuardianProtocol.Invalid();
    }

    private static GuardianProtocol.Request ParsePublic(byte[] line)
    {
        using var document = JsonDocument.Parse(line, new JsonDocumentOptions { AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow, MaxDepth = 8 });
        var root = document.RootElement;
        var operation = root.TryGetProperty("operation", out var op) && op.ValueKind == JsonValueKind.String ? op.GetString() : null;
                var expected = operation switch { "arm_attempt" => new[] { "schemaVersion", "operation", "guardianInstanceId", "guardianEpoch", "attemptId" }, "launch_role" or "contain_role" => new[] { "schemaVersion", "operation", "guardianInstanceId", "guardianEpoch", "attemptId", "role" }, _ => throw GuardianProtocol.Invalid() };
        GuardianProtocol.RequireExactKeys(root, expected);
        if (!root.TryGetProperty("schemaVersion", out var schema) || schema.GetInt32() != GuardianProtocol.SchemaVersion) throw GuardianProtocol.Invalid();
        return GuardianProtocol.Parse(line);
    }

    private static async Task WriteAsync(Stream output, string response) { var bytes = Encoding.UTF8.GetBytes(response); await output.WriteAsync(bytes).ConfigureAwait(false); await output.FlushAsync().ConfigureAwait(false); }
    private static int Fail() { Console.Error.Write("windows_stardew_bootstrap_guardian_invalid_request\n"); return 1; }
}
