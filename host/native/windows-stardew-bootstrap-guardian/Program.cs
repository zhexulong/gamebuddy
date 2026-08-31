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
        WindowsJobOwner? playerJob = null;
        WindowsJobOwner? aiJob = null;
        GuardianPrivateLaunchIngress? ingress = null;
        GuardianLease? lease = null;
        WindowsRoleLauncher.LaunchedRole? player = null;
        WindowsRoleLauncher.LaunchedRole? ai = null;
        try
        {
            var pipe = Environment.GetEnvironmentVariable("GAMEBUDDY_GUARDIAN_CONTROL_PIPE");
            var token = Environment.GetEnvironmentVariable("GAMEBUDDY_GUARDIAN_CONTROL_TOKEN");
            if (string.IsNullOrWhiteSpace(pipe) || string.IsNullOrWhiteSpace(token)) return Fail();
            WindowsJobOwner.ValidateAbi();
            WindowsRoleLauncher.ValidateAbi();
            GuardianPrivateLaunchIngress.ValidateAbi();
            using var input = Console.OpenStandardInput();
            using var output = Console.OpenStandardOutput();
            using var closing = new CancellationTokenSource();
            var publicFrames = Channel.CreateUnbounded<byte[]?>();
            var publicReader = ReadPublicFramesAsync(input, publicFrames.Writer, closing);
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
                    if (closing.IsCancellationRequested || plan is null || plan.Correlation != command.Correlation || plan.Role != role || plan.DeadlineUnixMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) return Fail();
                    var job = role == GuardianProtocol.Role.PlayerHost ? playerJob : aiJob;
                    var launched = WindowsRoleLauncher.LaunchSuspended(job, plan.Executable, plan.Arguments, plan.WorkingDirectory, plan.Environment, closing.Token);
                    try
                    {
                        if (closing.IsCancellationRequested || plan.DeadlineUnixMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) throw new TimeoutException();
                        WindowsRoleLauncher.Resume(launched);
                        if (role == GuardianProtocol.Role.PlayerHost) player = launched; else ai = launched;
                        await WriteAsync(output, GuardianProtocol.Response("role_active")).ConfigureAwait(false);
                    }
                    catch { launched.Dispose(); throw; }
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
            ingress?.Dispose(); player?.Dispose(); ai?.Dispose();
            playerJob?.Dispose(); aiJob?.Dispose(); lease?.Dispose();
        }
    }

    private static async Task ReadPublicFramesAsync(Stream stream, ChannelWriter<byte[]?> frames, CancellationTokenSource closing)
    {
        try
        {
            while (true)
            {
                var line = await ReadLineBoundedAsync(stream).ConfigureAwait(false);
                await frames.WriteAsync(line).ConfigureAwait(false);
                if (line is null) { closing.Cancel(); break; }
            }
        }
        catch (Exception error) { frames.TryComplete(error); closing.Cancel(); return; }
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
