using System.Text;
using System.Threading.Channels;

namespace GameBuddy.WindowsBootstrapGuardian;

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
#if GUARDIAN_TEST_HOOKS
        if (ResidentGuardianTestHooks.TryObserveResidentEnvironmentAndWaitForEof()) return 0;
#endif
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
            var publicOutput = new PublicChannelWriter(output);
            while (true)
            {
                var line = await publicFrames.Reader.ReadAsync().ConfigureAwait(false);
                if (line is null) { closing.Cancel(); break; }
                var command = GuardianProtocol.Parse(line);
                if (command.Operation == "arm_attempt")
                {
                    if (armed) return Fail();
                    ingress = new GuardianPrivateLaunchIngress(pipe, token, command.Correlation);
                    armBinding = await ingress.ReceiveArmAsync(closing.Token).ConfigureAwait(false);
                    if (armBinding is null) return Fail();
                    if (armBinding.LeaseName.Contains("/", StringComparison.Ordinal)) return Fail();
                    lease = GuardianLease.Create(armBinding.LeaseName);
                    // Player world ownership survives guardian/controller closure. The role job is
                    // intentionally non-kill-on-close; explicit contain_role remains the
                    // separate authenticated endgame operation.
                    playerJob = WindowsJobOwner.Create(armBinding.PlayerJobName, killOnJobClose: false);
                    try { aiJob = WindowsJobOwner.Create(armBinding.AiJobName); }
                    catch { playerJob.Dispose(); playerJob = null; throw; }
                    activeCorrelation = command.Correlation;
                    armed = true;
                    await publicOutput.WriteAsync(GuardianProtocol.Response("armed")).ConfigureAwait(false);
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
#if GUARDIAN_TEST_HOOKS
                        ResidentGuardianTestHooks.Wait("before-resume");
#endif
                        if (!stateGate.TryRunOpen(() =>
                        {
                            if (plan.DeadlineUnixMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) throw new TimeoutException();
                            WindowsRoleLauncher.Resume(launched!);
                        })) throw new OperationCanceledException();
                        if (role == GuardianProtocol.Role.PlayerHost) player = launched; else ai = launched;
                        _ = WatchRoleExitAsync(role, launched!, publicOutput);
                        await publicOutput.WriteAsync(GuardianProtocol.Response("role_active")).ConfigureAwait(false);
                    }
                    catch { launched?.Abort(); throw; }
                }
                else
                {
                    var role = command.Role!.Value;
                    if (role == GuardianProtocol.Role.PlayerHost ? player is null : ai is null) return Fail();
                    var job = role == GuardianProtocol.Role.PlayerHost ? playerJob : aiJob;
                    // The Guardian ends this role itself, so its ending is the endgame's
                    // and never a death: the watcher must report nothing (#506).
                    if (role == GuardianProtocol.Role.PlayerHost) player?.MarkEndedByGuardian(); else ai?.MarkEndedByGuardian();
                    job.TerminateAndDrain();
                    if (role == GuardianProtocol.Role.PlayerHost) { player?.Dispose(); player = null; } else { ai?.Dispose(); ai = null; }
                    await publicOutput.WriteAsync(GuardianProtocol.Response("role_contained")).ConfigureAwait(false);
                }
            }
            // Ordinary controller EOF only drains AI authority. Player remains alive;
            // explicit contain_role is the deliberate endgame endpoint.
            ai?.MarkEndedByGuardian();
            if (armed) aiJob?.TerminateAndDrain();
            await publicReader.ConfigureAwait(false);
            return 0;
        }
        catch { return Fail(); }
        finally
        {
            ingress?.Dispose();
            // Never terminate Player during ordinary guardian cleanup. Its non-kill-on-
            // close job keeps the game world alive after the last guardian handle closes.
            ai?.MarkEndedByGuardian();
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
                 var result = classification.Role == GuardianProtocol.Role.PlayerHost
                     ? WindowsJobRecoveryClassifier.ClassifyPlayer(post.PlayerJobName, classification.State)
                     : WindowsJobRecoveryClassifier.Classify(post.AiJobName, classification.State);
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

    /**
     * Publishes a role's own ending the moment the OS reports it.
     *
     * The watcher exists because this channel is otherwise driven by the controller: the
     * dead role it watched for was only reported in front of the NEXT command, and a
     * controller that has finished its launch sends nothing - so the game could be gone
     * while the product still described it as running (measured 2026-11-21,
     * `.tmp/lane-deathpub.md`). It blocks on the role's own process handle instead, so the
     * ending needs no command in front of it.
     *
     * It reports NOTHING for a role this Guardian ended itself - an explicit endgame's
     * containment or an aborted launch - which is what keeps an endgame from being
     * published as the game having died (#506), and it claims the one report a role may
     * ever have, so a role that ended once is published once.
     */
    private static async Task WatchRoleExitAsync(GuardianProtocol.Role role, WindowsRoleLauncher.LaunchedRole launched, PublicChannelWriter output)
    {
        try
        {
            await Task.Run(() => WindowsRoleLauncher.WaitForExit(launched)).ConfigureAwait(false);
            if (launched.EndedByGuardian || !launched.TryClaimExitReport()) return;
            if (!WindowsRoleLauncher.TryReadExitCode(launched, out var exitCode)) return;
            await output.WriteAsync(GuardianProtocol.RoleExit(role, exitCode)).ConfigureAwait(false);
        }
        catch
        {
            // The channel is gone or the role's handle was released under this waiter. A
            // death that cannot be reported changes nothing this process still owns: the
            // controller's own commands answer `guardian_session_closed` from here on.
        }
    }

    /**
     * The one writer of the Guardian's public channel.
     *
     * Two producers write here - the command loop answering what it was asked, and a
     * death watcher reporting a process that ended on its own - and the channel's contract
     * is one frame per line. The gate is what makes a frame whole: a reply interleaved
     * into an event would fail the reader on both sides of this pipe.
     */
    private sealed class PublicChannelWriter
    {
        private readonly Stream output;
        private readonly SemaphoreSlim gate = new(1, 1);

        internal PublicChannelWriter(Stream output) => this.output = output;

        internal async Task WriteAsync(string frame)
        {
            var bytes = Encoding.UTF8.GetBytes(frame);
            await gate.WaitAsync().ConfigureAwait(false);
            try
            {
                await output.WriteAsync(bytes).ConfigureAwait(false);
                await output.FlushAsync().ConfigureAwait(false);
            }
            finally { gate.Release(); }
        }
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

    private static int Fail() { Console.Error.Write("windows_bootstrap_guardian_invalid_request\n"); return 1; }
}
